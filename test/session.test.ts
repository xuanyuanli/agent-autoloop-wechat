import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readSession, readSessionAsync, sessionFromLogin, writeSession, writeSessionAsync, type StoredSession } from "../src/session.ts";

const existing: StoredSession = {
  token: "old",
  baseUrl: "https://ilink.example/",
  botId: "bot",
  userId: "user-1",
  cursor: "cur-9",
  contextToken: "ctx",
  open: [{ id: 4, options: ["保持", "改"], ref: "wechat-4" }],
  pending: [{ kind: "图片" }],
};

test("logging in again as the same account keeps unanswered cards", () => {
  const next = sessionFromLogin(existing, { token: "new", baseUrl: "https://ilink.example/v2", botId: "bot", userId: "user-1" });
  assert.equal(next.token, "new");
  assert.equal(next.cursor, "cur-9");
  assert.equal(next.open?.[0]?.id, 4);
  assert.equal(next.pending?.[0]?.kind, "图片");
  assert.equal(next.contextToken, "ctx");
});

test("logging in as a different account drops the previous cards", () => {
  const next = sessionFromLogin(existing, { token: "new", baseUrl: "https://ilink.example/", botId: "bot", userId: "user-2" });
  assert.equal(next.cursor, "");
  assert.equal(next.open, undefined);
  assert.equal(next.pending, undefined);
});

test("async and sync session persistence round-trip atomically", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wx-sess-"));
  const file = path.join(dir, "wechat-session.json");
  await writeSessionAsync(file, existing);
  const loadedAsync = await readSessionAsync(file);
  assert.deepEqual(loadedAsync, existing);

  writeSession(file, { ...existing, cursor: "cur-10" });
  assert.equal(readSession(file)?.cursor, "cur-10");
});
