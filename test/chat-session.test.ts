import assert from "node:assert/strict";
import test from "node:test";
import { CHAT_TTL_MS, decideChat } from "../src/chat-session.ts";

const prompt = "Agent 自动化中台按规则「微信对话」把这件活派给你。";
const now = 1_000_000_000_000;

test("a chat inside eight hours keeps the recorded session and slides the window", () => {
  const decision = decideChat("hub-other", prompt, { id: "chat-1", at: now - 60_000 }, now);
  assert.equal(decision.resume, "chat-1");
  assert.equal(decision.fresh, false);
  assert.deepEqual(decision.stamp, { id: "chat-1", at: now });
});

test("a chat after eight hours starts over", () => {
  const decision = decideChat("chat-1", prompt, { id: "chat-1", at: now - CHAT_TTL_MS - 1 }, now);
  assert.equal(decision.resume, null);
  assert.equal(decision.fresh, true);
  assert.deepEqual(decision.stamp, { id: null, at: 0 });
});

test("a session id that was never recorded stays a new session", () => {
  const decision = decideChat("chat-1", prompt, { id: null, at: now - 60_000 }, now);
  assert.equal(decision.resume, null);
  assert.equal(decision.fresh, true);
});

test("a legacy stamp still inside the window keeps the hub session", () => {
  const decision = decideChat("chat-1", prompt, { id: null, at: now - 60_000, legacy: true }, now);
  assert.equal(decision.resume, "chat-1");
  assert.equal(decision.fresh, false);
  assert.deepEqual(decision.stamp, { id: "chat-1", at: now });
});

test("an inspection reply is not cut by the chat clock", () => {
  const inspection = "Agent 自动化中台按规则「工作日运维巡检」把这件活派给你。";
  const decision = decideChat("inspect-1", inspection, { id: "chat-1", at: now - CHAT_TTL_MS - 1 }, now);
  assert.equal(decision.resume, "inspect-1");
  assert.equal(decision.remember, false);
});
