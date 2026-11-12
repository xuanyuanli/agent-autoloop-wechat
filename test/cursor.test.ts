import assert from "node:assert/strict";
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
