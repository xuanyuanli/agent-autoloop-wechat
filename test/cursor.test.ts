import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { checkCursor, commandLine, readOutput } from "../src/cursor.ts";

const turn = {
  prompt: "你好",
  resume: null,
  cwd: "D:\\workspace\\jinpai\\backend",
  contextFile: "C:\\context.json",
  command: ["powershell.exe", "-File", "cursor-agent.ps1", "-p", "--trust", "{prompt}"],
};

test("a new turn asks Cursor for stream-json and keeps the prompt", () => {
  const args = commandLine(turn);
  assert.deepEqual(args.slice(-5, -1), ["--output-format", "stream-json", "-p", "--trust"]);
  assert.match(args.at(-1) ?? "", /^你好\n\n上面关于中台怎么结束这一轮的说明/);
  assert.equal(args.includes("--resume"), false);
});

test("a later turn resumes the same Cursor chat", () => {
  const args = commandLine({ ...turn, resume: "chat-1" });
  const at = args.indexOf("--resume");
  assert.equal(args[at + 1], "chat-1");
  assert.ok(at < args.indexOf("-p"));
});

test("a turn without an explicit command array builds a default template from program", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wx-bin-"));
  const fakeBin = path.join(dir, "cursor-agent.exe");
  writeFileSync(fakeBin, "");
  const args = commandLine({
    prompt: "你好",
    resume: null,
    cwd: dir,
    contextFile: path.join(dir, "context.json"),
    program: fakeBin,
    model: "claude-sonnet-5-5-high",
  });
  assert.equal(args[0], fakeBin);
  assert.deepEqual(args.slice(1, 5), ["--model", "claude-sonnet-5-5-high", "--output-format", "stream-json"]);
  assert.equal(args[5], "-p");
  assert.equal(args[6], "--trust");
});

test("json output keeps the reply, session id, started and finished flags", () => {
  const stdout = JSON.stringify({ type: "result", result: "改好了", session_id: "chat-1", is_error: false });
  assert.deepEqual(readOutput(stdout, 0, ""), { text: "改好了", session: "chat-1", started: true, finished: true });
});

test("stream-json drops pre-tool narration and keeps only the final assistant answer plus token usage", () => {
  const finalReply =
    "今天下午主要改了买家回访和 App 下载页。\n\n" +
    '```agent-autoloop\n{"notice":[{"title":"今天下午主要改了买家回访和 App 下载页。","text":"- 买家回访改单选\\n- App 下载页切官网","fyi":true}]}\n```';
  const lines = [
    JSON.stringify({ type: "system", subtype: "init", session_id: "sess-15" }),
    JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "Agent 自动化中台按规则「微信对话」把这件活派给你。" }] },
      session_id: "sess-15",
    }),
    JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "用户要最新提交汇总，我先看仓库近期记录再写成能看懂的回复。" }] },
      session_id: "sess-15",
    }),
    JSON.stringify({ type: "tool_call", subtype: "started", call_id: "c1", session_id: "sess-15" }),
    JSON.stringify({ type: "tool_call", subtype: "completed", call_id: "c1", session_id: "sess-15" }),
    JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: finalReply }] },
      session_id: "sess-15",
    }),
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: `用户要最新提交汇总，我先看仓库近期记录再写成能看懂的回复。${finalReply}`,
      session_id: "sess-15",
      usage: { inputTokens: 300, outputTokens: 80, cacheReadTokens: 700, cacheWriteTokens: 0 },
    }),
  ].join("\n");

  const reading = readOutput(lines, 0, "");
  assert.equal(reading.text, finalReply);
  assert.equal(reading.text?.includes("用户要最新提交汇总"), false);
  assert.equal(reading.session, "sess-15");
  assert.equal(reading.started, true);
  assert.equal(reading.finished, true);
  assert.deepEqual(reading.usage, { input: 1000, output: 80, cached: 700 });
});

test("a multi-line plain wechat chat reply without a receipt block is wrapped into an fyi notice", () => {
  const plainMultiLine = "今天做了三件事：\n- 第一件\n- 第二件\n- 第三件";
  const lines = [
    JSON.stringify({ type: "system", subtype: "init", session_id: "sess-plain" }),
    JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "Agent 自动化中台按规则「微信对话」把这件活派给你。" }] },
      session_id: "sess-plain",
    }),
    JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: plainMultiLine }] },
      session_id: "sess-plain",
    }),
    JSON.stringify({ type: "result", subtype: "success", is_error: false, result: plainMultiLine, session_id: "sess-plain" }),
  ].join("\n");

  const reading = readOutput(lines, 0, "");
  assert.match(reading.text ?? "", /^今天做了三件事：\n\n```agent-autoloop\n/);
  assert.match(reading.text ?? "", /"fyi":true/);
  assert.match(reading.text ?? "", /- 第三件/);
});

test("while still running, readOutput reports started: true and waits for result event on stream-json", () => {
  const midStream = [
    JSON.stringify({ type: "system", subtype: "init", session_id: "chat-live" }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "先查一下日志" }] } }),
  ].join("\n");
  assert.deepEqual(readOutput(midStream, null, ""), { started: true, session: "chat-live" });

  assert.deepEqual(readOutput("", null, ""), { started: true });
  const done = JSON.stringify({ result: "已完成", session_id: "chat-5" });
  assert.deepEqual(readOutput(done, null, ""), { text: "已完成", session: "chat-5", started: true, finished: true });
});

test("a session-not-found failure returns started: false so worker can start fresh, while runtime crashes stay started: true", () => {
  const lost = readOutput("", 1, "Error: session not found: chat-old");
  assert.equal(lost.started, false);
  assert.match(String(lost.error), /session not found/);

  const crash = readOutput("", 1, "Error: network timeout");
  assert.equal(crash.started, true);
});

test("a pretty-printed result still yields the reply and the outer session id", () => {
  const stdout = `log line\n{\n  "meta": { "session_id": "inner" },\n  "result": "改好了",\n  "session_id": "outer"\n}\n`;
  assert.deepEqual(readOutput(stdout, 0, ""), { text: "改好了", session: "outer", started: true, finished: true });
});

test("sessionId is accepted as the session field", () => {
  const stdout = JSON.stringify({ result: "好", sessionId: "chat-2" });
  assert.deepEqual(readOutput(stdout, 0, ""), { text: "好", session: "chat-2", started: true, finished: true });
});

const chatPrompt = "Agent 自动化中台按规则「微信对话」把这件活派给你。";
const baseCommand = ["powershell.exe", "-File", "cursor-agent.ps1", "-p", "--trust", "{prompt}"];

function chatTurn(dir: string, resume: string | null) {
  return {
    prompt: chatPrompt,
    resume,
    cwd: "D:\\workspace\\jinpai\\backend",
    contextFile: path.join(dir, "context.json"),
    command: baseCommand,
  };
}

test("an expired wechat chat drops the old resume until this run records a new session", () => {
  const home = mkdtempSync(path.join(tmpdir(), "wx-home-"));
  const dir = mkdtempSync(path.join(tmpdir(), "wx-run-"));
  const now = 1_700_000_000_000;
  writeFileSync(path.join(home, "wechat-chat.json"), JSON.stringify({ id: "old", at: now - 8 * 60 * 60 * 1000 - 1 }));
  const args = commandLine(chatTurn(dir, "old"), { home, now });
  assert.equal(args.includes("--resume"), false);
  assert.ok(args.includes("--output-format"));
  const stdout = JSON.stringify({ result: "在", session_id: "new-chat" });
  writeFileSync(path.join(dir, "stdout-1.log"), stdout);
  assert.deepEqual(readOutput(stdout, 0, ""), { text: "在", session: "new-chat", started: true, finished: true });
  const saved = JSON.parse(readFileSync(path.join(home, "wechat-chat.json"), "utf8")) as { id: string; at: number };
  assert.equal(saved.id, "new-chat");
  assert.equal(saved.at, now);
  const again = commandLine(chatTurn(dir, "old"), { home, now: now + 1000 });
  assert.equal(again[again.indexOf("--resume") + 1], "new-chat");
  readOutput(stdout, 0, "");
});

test("overlapping wechat chat launches do not overwrite each other's pending session tracking", () => {
  const home1 = mkdtempSync(path.join(tmpdir(), "wx-home1-"));
  const home2 = mkdtempSync(path.join(tmpdir(), "wx-home2-"));
  const dir1 = mkdtempSync(path.join(tmpdir(), "wx-run1-"));
  const dir2 = mkdtempSync(path.join(tmpdir(), "wx-run2-"));
  const now = 1_700_000_000_000;

  commandLine(chatTurn(dir1, null), { home: home1, now });
  commandLine(chatTurn(dir2, null), { home: home2, now: now + 500 });

  const out1 = JSON.stringify({ result: "第一条", session_id: "chat-first" });
  writeFileSync(path.join(dir1, "stdout-1.log"), out1);
  readOutput(out1, 0, "");

  const out2 = JSON.stringify({ result: "第二条", session_id: "chat-second" });
  writeFileSync(path.join(dir2, "stdout-1.log"), out2);
  readOutput(out2, 0, "");

  assert.equal((JSON.parse(readFileSync(path.join(home1, "wechat-chat.json"), "utf8")) as { id: string }).id, "chat-first");
  assert.equal((JSON.parse(readFileSync(path.join(home2, "wechat-chat.json"), "utf8")) as { id: string }).id, "chat-second");
});

test("a failed wechat run does not keep a session id", () => {
  const home = mkdtempSync(path.join(tmpdir(), "wx-home-"));
  const dir = mkdtempSync(path.join(tmpdir(), "wx-run-"));
  const now = 1_700_000_000_000;
  commandLine(chatTurn(dir, "old"), { home, now });
  const stdout = JSON.stringify({ result: "失败", session_id: "bad" });
  writeFileSync(path.join(dir, "stdout-1.log"), stdout);
  const output = readOutput(stdout, 1, "boom");
  assert.match(String(output.error), /退出码 1/);
  const saved = JSON.parse(readFileSync(path.join(home, "wechat-chat.json"), "utf8")) as { id: string | null };
  assert.equal(saved.id, null);
});

test("another run's result does not become the wechat session", () => {
  const home = mkdtempSync(path.join(tmpdir(), "wx-home-"));
  const dir = mkdtempSync(path.join(tmpdir(), "wx-run-"));
  const other = mkdtempSync(path.join(tmpdir(), "wx-other-"));
  const now = 1_700_000_000_000;
  commandLine(chatTurn(dir, null), { home, now });
  const elsewhere = JSON.stringify({ result: "做完了", session_id: "other" });
  writeFileSync(path.join(other, "stdout-1.log"), elsewhere);
  readOutput(elsewhere, 0, "");
  const midway = JSON.parse(readFileSync(path.join(home, "wechat-chat.json"), "utf8")) as { id: string | null };
  assert.equal(midway.id, null);
  const stdout = JSON.stringify({ result: "聊天", session_id: "chat-9" });
  writeFileSync(path.join(dir, "stdout-1.log"), stdout);
  readOutput(stdout, 0, "");
  const saved = JSON.parse(readFileSync(path.join(home, "wechat-chat.json"), "utf8")) as { id: string };
  assert.equal(saved.id, "chat-9");
});

test("a legacy stamp still inside the window resumes the hub session", () => {
  const home = mkdtempSync(path.join(tmpdir(), "wx-home-"));
  const dir = mkdtempSync(path.join(tmpdir(), "wx-run-"));
  const now = 1_700_000_000_000;
  writeFileSync(path.join(home, "wechat-chat.json"), JSON.stringify({ at: now - 1000, break: false }));
  const args = commandLine(chatTurn(dir, "chat-1"), { home, now });
  assert.equal(args[args.indexOf("--resume") + 1], "chat-1");
  const saved = JSON.parse(readFileSync(path.join(home, "wechat-chat.json"), "utf8")) as { id: string };
  assert.equal(saved.id, "chat-1");
  const stdout = JSON.stringify({ result: "在", session_id: "chat-1" });
  writeFileSync(path.join(dir, "stdout-1.log"), stdout);
  readOutput(stdout, 0, "");
});

test("another rule keeps its resume and is told to send markdown", () => {
  const home = mkdtempSync(path.join(tmpdir(), "wx-home-"));
  const now = 1_700_000_000_000;
  writeFileSync(path.join(home, "wechat-chat.json"), JSON.stringify({ id: "chat-1", at: now - 8 * 60 * 60 * 1000 - 1 }));
  const args = commandLine(
    {
      prompt: "Agent 自动化中台按规则「定时日报」把这件活派给你。",
      resume: "report-1",
      cwd: "D:\\workspace\\example",
      contextFile: "C:\\context.json",
      command: baseCommand,
    },
    { home, now },
  );
  assert.equal(args[args.indexOf("--resume") + 1], "report-1");
  const saved = JSON.parse(readFileSync(path.join(home, "wechat-chat.json"), "utf8")) as { id: string };
  assert.equal(saved.id, "chat-1");
  const spoken = args.at(-1) ?? "";
  assert.match(spoken, /发给人的只有回执里的 notice 和 ask/);
  assert.match(spoken, /notice 的 text 用 Markdown/);
  assert.equal(spoken.includes("只写给用户看的回答"), false);
});

test("a wechat chat is not given the notice format", () => {
  const args = commandLine({
    ...turn,
    prompt: "Agent 自动化中台按规则「微信对话」把这件活派给你。\n看过了，没有要做的：写没事可做",
  });
  assert.equal(args.at(-1)?.includes("notice 的 text 用 Markdown"), false);
  assert.match(args.at(-1) ?? "", /第一行只写给用户看的回答/);
});

test("checkCursor validates explicit program and configured rules", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wx-check-"));
  const existing = path.join(dir, "runner.exe");
  writeFileSync(existing, "");
  assert.equal(checkCursor(existing, dir), null);
  assert.match(checkCursor(path.join(dir, "missing.exe"), dir) ?? "", /找不到指定程序/);

  writeFileSync(
    path.join(dir, "rules.json"),
    JSON.stringify({ agents: { cursor: { use: "agent-autoloop-wechat", command: [existing, "-p", "{prompt}"] } } }),
  );
  assert.equal(checkCursor(undefined, dir), null);
});
