import assert from "node:assert/strict";
import test from "node:test";
import { finishLease, leaseExpired, startLease, TYPING_MAX_MS } from "../src/typing.ts";

const now = 1_700_000_000_000;

test("a new message starts the indicator and a later one keeps it going", () => {
  const first = startLease(null, "微信对话", now, "ctx");
  const again = startLease(first, "定时日报", now + 1000);
  assert.deepEqual(again.rules, ["微信对话", "定时日报"]);
  assert.equal(again.until, now + 1000 + TYPING_MAX_MS);
  assert.equal(again.contextToken, "ctx");
});

test("another rule's notice does not turn the chat indicator off", () => {
  const lease = startLease(null, "微信对话", now);
  assert.equal(finishLease(lease, "定时日报"), lease);
});

test("one reply turns off only its own wait", () => {
  const lease = startLease(startLease(null, "微信对话", now), "定时日报", now);
  const left = finishLease(lease, "微信对话");
  assert.deepEqual(left?.rules, ["定时日报"]);
  assert.equal(finishLease(left, "定时日报"), null);
});

test("the indicator expires when no reply arrives", () => {
  const lease = startLease(null, "微信对话", now);
  assert.equal(leaseExpired(lease, now + TYPING_MAX_MS - 1), false);
  assert.equal(leaseExpired(lease, now + TYPING_MAX_MS), true);
});
