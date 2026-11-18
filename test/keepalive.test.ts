import assert from "node:assert/strict";
import test from "node:test";
import { isKeepaliveReply, nextKeepaliveTarget, readKeepaliveConfig, shouldSendKeepalive } from "../src/keepalive.ts";

const tz = "Asia/Shanghai";
const shanghai = (isoLocal: string) => Date.parse(`${isoLocal}+08:00`);

test("daytime idle hits the 20h mark when that time is outside quiet hours", () => {
  const noon = shanghai("2026-11-16T12:00:00");
  assert.equal(nextKeepaliveTarget(noon, { timeZone: tz }), shanghai("2026-11-17T08:00:00"));
  assert.equal(shouldSendKeepalive({ contextToken: "ctx", lastInboundAt: noon }, shanghai("2026-11-17T07:59:59"), { timeZone: tz }), false);
  assert.equal(shouldSendKeepalive({ contextToken: "ctx", lastInboundAt: noon }, shanghai("2026-11-17T08:00:00"), { timeZone: tz }), true);

  const evening = shanghai("2026-11-17T18:40:00");
  assert.equal(nextKeepaliveTarget(evening, { timeZone: tz }), shanghai("2026-11-18T14:40:00"));
  assert.equal(shouldSendKeepalive({ contextToken: "ctx", lastInboundAt: evening }, shanghai("2026-11-17T21:00:00"), { timeZone: tz }), false);
  assert.equal(shouldSendKeepalive({ contextToken: "ctx", lastInboundAt: evening }, shanghai("2026-11-18T14:40:00"), { timeZone: tz }), true);
});

test("quiet due waits until 07:30 when that morning is still 2h before the 24h expiry", () => {
  const lastInboundAt = shanghai("2026-11-16T10:00:00");
  assert.equal(nextKeepaliveTarget(lastInboundAt, { timeZone: tz }), shanghai("2026-11-17T07:30:00"));
  assert.equal(shouldSendKeepalive({ contextToken: "ctx", lastInboundAt }, shanghai("2026-11-16T21:00:00"), { timeZone: tz }), false);
  assert.equal(shouldSendKeepalive({ contextToken: "ctx", lastInboundAt }, shanghai("2026-11-17T07:29:59"), { timeZone: tz }), false);
  assert.equal(shouldSendKeepalive({ contextToken: "ctx", lastInboundAt }, shanghai("2026-11-17T07:30:00"), { timeZone: tz }), true);
});

test("quiet due pulls back to 21:00 when 07:30 would leave less than 2h", () => {
  const lastInboundAt = shanghai("2026-11-16T09:00:00");
  assert.equal(nextKeepaliveTarget(lastInboundAt, { timeZone: tz }), shanghai("2026-11-16T21:00:00"));
  assert.equal(shouldSendKeepalive({ contextToken: "ctx", lastInboundAt }, shanghai("2026-11-16T20:59:59"), { timeZone: tz }), false);
  assert.equal(shouldSendKeepalive({ contextToken: "ctx", lastInboundAt }, shanghai("2026-11-16T21:00:00"), { timeZone: tz }), true);
});

test("a short hours setting still defers to morning when the 24h window allows it", () => {
  const evening = shanghai("2026-11-17T18:40:00");
  assert.equal(nextKeepaliveTarget(evening, { hours: 10, timeZone: tz }), shanghai("2026-11-18T07:30:00"));
  assert.equal(shouldSendKeepalive({ contextToken: "ctx", lastInboundAt: evening }, shanghai("2026-11-17T21:00:00"), { hours: 10, timeZone: tz }), false);
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
  assert.equal(isKeepaliveReply("保活.", false), true);
  assert.equal(isKeepaliveReply(".", false), true);
  assert.equal(isKeepaliveReply("。", false), true);
  assert.equal(isKeepaliveReply(" 。 ", false), true);

  assert.equal(isKeepaliveReply("ok", false), false);
  assert.equal(isKeepaliveReply("收到", false), false);
  assert.equal(isKeepaliveReply("ok!", true), true);
  assert.equal(isKeepaliveReply("收到。", true), true);
  assert.equal(isKeepaliveReply("在", true), true);

  assert.equal(isKeepaliveReply("1", true), false);
  assert.equal(isKeepaliveReply("...", true), false);
  assert.equal(isKeepaliveReply("在吗", true), false);
  assert.equal(isKeepaliveReply("帮我看一下日志", true), false);
});

test("readKeepaliveConfig defaults to on and accepts a boolean or object", () => {
  assert.equal(readKeepaliveConfig({}).hours, 20);
  assert.equal(readKeepaliveConfig({ keepalive: true }).hours, 20);
  assert.equal(readKeepaliveConfig({ keepalive: false }).hours, 0);
  assert.equal(readKeepaliveConfig({ keepalive: false, keepaliveHours: 12 }).hours, 0);
  assert.equal(readKeepaliveConfig({ keepaliveHours: false }).hours, 0);
  assert.deepEqual(readKeepaliveConfig({ keepalive: { hours: 18, quietStart: "23:00", timeZone: "Asia/Shanghai" } }), {
    hours: 18,
    quietStart: "23:00",
    timeZone: "Asia/Shanghai",
  });
  assert.equal(readKeepaliveConfig({ keepalive: { enabled: false, hours: 18 } }).hours, 0);
  assert.deepEqual(readKeepaliveConfig({ keepaliveHours: 12, keepaliveTimeZone: "Asia/Shanghai" }), {
    hours: 12,
    timeZone: "Asia/Shanghai",
  });
});
