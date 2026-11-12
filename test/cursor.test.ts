import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { commandLine, readOutput } from "../src/cursor.ts";

const turn = {
  prompt: "你好",
  resume: null,
  cwd: "D:\\workspace\\jinpai\\backend",
  contextFile: "C:\\context.json",
  command: ["powershell.exe", "-File", "cursor-agent.ps1", "-p", "--trust", "{prompt}"],
};

test("a new turn asks Cursor for json and keeps the prompt", () => {
  const args = commandLine(turn);
  assert.deepEqual(args.slice(-5), ["--output-format", "json", "-p", "--trust", "你好"]);
  assert.equal(args.includes("--resume"), false);
});

test("a later turn resumes the same Cursor chat", () => {
  const args = commandLine({ ...turn, resume: "chat-1" });
  const at = args.indexOf("--resume");
  assert.equal(args[at + 1], "chat-1");
  assert.ok(at < args.indexOf("-p"));
});

test("json output keeps the reply and the session id", () => {
  const stdout = JSON.stringify({ type: "result", result: "改好了", session_id: "chat-1", is_error: false });
  assert.deepEqual(readOutput(stdout, 0, ""), { text: "改好了", session: "chat-1" });
});

test("a pretty-printed result still yields the reply and the outer session id", () => {
  const stdout = `log line\n{\n  "meta": { "session_id": "inner" },\n  "result": "改好了",\n  "session_id": "outer"\n}\n`;
  assert.deepEqual(readOutput(stdout, 0, ""), { text: "改好了", session: "outer" });
});

test("sessionId is accepted as the session field", () => {
  const stdout = JSON.stringify({ result: "好", sessionId: "chat-2" });
  assert.deepEqual(readOutput(stdout, 0, ""), { text: "好", session: "chat-2" });
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
  assert.deepEqual(readOutput(stdout, 0, ""), { text: "在", session: "new-chat" });
  const saved = JSON.parse(readFileSync(path.join(home, "wechat-chat.json"), "utf8")) as { id: string; at: number };
  assert.equal(saved.id, "new-chat");
  assert.equal(saved.at, now);
  const again = commandLine(chatTurn(dir, "old"), { home, now: now + 1000 });
  assert.equal(again[again.indexOf("--resume") + 1], "new-chat");
  readOutput(stdout, 0, "");
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

test("an inspection result does not become the wechat session", () => {
  const home = mkdtempSync(path.join(tmpdir(), "wx-home-"));
  const dir = mkdtempSync(path.join(tmpdir(), "wx-run-"));
  const other = mkdtempSync(path.join(tmpdir(), "wx-other-"));
  const now = 1_700_000_000_000;
  commandLine(chatTurn(dir, null), { home, now });
  const inspection = JSON.stringify({ result: "巡检完了", session_id: "inspect" });
  writeFileSync(path.join(other, "stdout-1.log"), inspection);
  readOutput(inspection, 0, "");
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

test("an inspection launch keeps its own resume and does not rewrite the wechat stamp", () => {
  const home = mkdtempSync(path.join(tmpdir(), "wx-home-"));
  const now = 1_700_000_000_000;
  writeFileSync(path.join(home, "wechat-chat.json"), JSON.stringify({ id: "chat-1", at: now - 8 * 60 * 60 * 1000 - 1 }));
  const args = commandLine({
    prompt: "Agent 自动化中台按规则「工作日运维巡检」把这件活派给你。",
    resume: "inspect-1",
    cwd: "D:\\workspace\\jinpai\\backend",
    contextFile: "C:\\context.json",
    command: baseCommand,
  }, { home, now });
  assert.equal(args[args.indexOf("--resume") + 1], "inspect-1");
  const saved = JSON.parse(readFileSync(path.join(home, "wechat-chat.json"), "utf8")) as { id: string };
  assert.equal(saved.id, "chat-1");
  const spoken = args.at(-1) ?? "";
  assert.match(spoken, /第一行必须是「今天是非工作日（周末或法定假日），跳过今日巡检」/);
  assert.ok(spoken.endsWith("不附回执。"));
});

test("a wechat chat is not given the inspection off-day line", () => {
  const args = commandLine({
    ...turn,
    prompt: "Agent 自动化中台按规则「微信对话」把这件活派给你。\n看过了，没有要做的：写没事可做",
  });
  assert.equal(args.at(-1)?.includes("跳过今日巡检"), false);
});
