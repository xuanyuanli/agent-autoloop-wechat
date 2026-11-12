import assert from "node:assert/strict";
import test from "node:test";
import { CHAT_TTL_MS, decideChat } from "../src/chat-session.ts";

const prompt = "Agent 自动化中台按规则「微信对话」把这件活派给你。";
const now = 1_000_000_000_000;

test("a chat inside eight hours keeps the session and slides the window", () => {
  const decision = decideChat("chat-1", prompt, { at: now - 60_000, break: false }, now);
  assert.equal(decision.resume, "chat-1");
  assert.equal(decision.fresh, false);
  assert.deepEqual(decision.stamp, { at: now, break: false });
});

test("a chat after eight hours starts over", () => {
  const decision = decideChat("chat-1", prompt, { at: now - CHAT_TTL_MS - 1, break: false }, now);
  assert.equal(decision.resume, null);
  assert.equal(decision.fresh, true);
  assert.equal(decision.stamp?.break, true);
});

test("a broken handoff stays a new session until a fresh one is recorded", () => {
  const decision = decideChat("chat-1", prompt, { at: now - 60_000, break: true }, now);
  assert.equal(decision.resume, null);
  assert.equal(decision.fresh, true);
});

test("an inspection reply is not cut by the chat clock", () => {
  const inspection = "Agent 自动化中台按规则「工作日运维巡检」把这件活派给你。";
  const decision = decideChat("inspect-1", inspection, { at: now - CHAT_TTL_MS - 1, break: false }, now);
  assert.equal(decision.resume, "inspect-1");
  assert.equal(decision.remember, false);
});
