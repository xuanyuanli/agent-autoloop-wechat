import assert from "node:assert/strict";
import test from "node:test";
import { isKeepaliveReply, nextKeepaliveTarget, shouldSendKeepalive } from "../src/keepalive.ts";

const tz = "Asia/Shanghai";
const shanghai = (isoLocal: string) => Date.parse(`${isoLocal}+08:00`);

test("daytime idle hits exact 10h target outside quiet hours", () => {
  const lastInboundAt = shanghai("2026-11-16T09:00:00");
  assert.equal(nextKeepaliveTarget(lastInboundAt, { timeZone: tz }), shanghai("2026-11-16T19:00:00"));
  assert.equal(shouldSendKeepalive({ contextToken: "ctx", lastInboundAt }, shanghai("2026-11-16T18:59:59"), { timeZone: tz }), false);
  assert.equal(shouldSendKeepalive({ contextToken: "ctx", lastInboundAt }, shanghai("2026-11-16T19:00:00"), { timeZone: tz }), true);
});

test("idle due inside overnight quiet hours pulls forward to 21:00 when >= 2h since inbound", () => {
  const afternoon = shanghai("2026-11-16T12:30:00");
  assert.equal(nextKeepaliveTarget(afternoon, { timeZone: tz }), shanghai("2026-11-16T21:00:00"));

  const evening = shanghai("2026-11-16T17:00:00");
  assert.equal(nextKeepaliveTarget(evening, { timeZone: tz }), shanghai("2026-11-16T21:00:00"));
  assert.equal(shouldSendKeepalive({ contextToken: "ctx", lastInboundAt: evening }, shanghai("2026-11-16T20:59:59"), { timeZone: tz }), false);
  assert.equal(shouldSendKeepalive({ contextToken: "ctx", lastInboundAt: evening }, shanghai("2026-11-16T21:00:00"), { timeZone: tz }), true);
});

test("late-night inbound less than 2h before 21:00 waits until 07:30 after quiet hours", () => {
  const late = shanghai("2026-11-16T19:30:00");
  assert.equal(nextKeepaliveTarget(late, { timeZone: tz }), shanghai("2026-11-17T07:30:00"));
  assert.equal(shouldSendKeepalive({ contextToken: "ctx", lastInboundAt: late }, shanghai("2026-11-16T21:00:00"), { timeZone: tz }), false);
  assert.equal(shouldSendKeepalive({ contextToken: "ctx", lastInboundAt: late }, shanghai("2026-11-17T07:29:59"), { timeZone: tz }), false);
  assert.equal(shouldSendKeepalive({ contextToken: "ctx", lastInboundAt: late }, shanghai("2026-11-17T07:30:00"), { timeZone: tz }), true);
});

test("shouldSendKeepalive never fires inside quiet hours, when already nudged, or when disabled", () => {
  const lastInboundAt = shanghai("2026-11-16T10:00:00");
  assert.equal(shouldSendKeepalive({ contextToken: "ctx", lastInboundAt }, shanghai("2026-11-17T01:00:00"), { timeZone: tz }), false);
  assert.equal(
    shouldSendKeepalive(
      { contextToken: "ctx", lastInboundAt, keepaliveNudgedAt: shanghai("2026-11-16T20:00:00") },
      shanghai("2026-11-16T21:00:00"),
      { timeZone: tz },
    ),
    false,
  );
  assert.equal(shouldSendKeepalive({ contextToken: "ctx", lastInboundAt }, shanghai("2026-11-16T21:00:00"), { hours: 0, timeZone: tz }), false);
  assert.equal(shouldSendKeepalive({ lastInboundAt }, shanghai("2026-11-16T21:00:00"), { timeZone: tz }), false);
});

test("isKeepaliveReply matches dedicated keywords anytime and short acks only after nudge", () => {
  assert.equal(isKeepaliveReply("保活", false), true);
  assert.equal(isKeepaliveReply("  PING! ", false), true);
  assert.equal(isKeepaliveReply("续期。", false), true);

  assert.equal(isKeepaliveReply("ok", false), false);
  assert.equal(isKeepaliveReply("收到", false), false);
  assert.equal(isKeepaliveReply("ok!", true), true);
  assert.equal(isKeepaliveReply("收到。", true), true);
  assert.equal(isKeepaliveReply("在", true), true);

  assert.equal(isKeepaliveReply("1", true), false);
  assert.equal(isKeepaliveReply("在吗", true), false);
  assert.equal(isKeepaliveReply("帮我看一下日志", true), false);
});
