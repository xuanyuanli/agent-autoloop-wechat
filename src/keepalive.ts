export const DEFAULT_KEEPALIVE_HOURS = 20;
/** iLink context_token stays usable for about a day after the last inbound message. */
export const CONTEXT_TTL_HOURS = 24;
/** A deferred morning nudge must still leave this long before the token expires. */
export const MORNING_MARGIN_MS = 2 * 60 * 60 * 1000;
export const DEFAULT_QUIET_START = "22:00";
export const DEFAULT_QUIET_END = "07:30";
export const DEFAULT_ADVANCE_TIME = "21:00";
export const MIN_ADVANCE_IDLE_MS = 2 * 60 * 60 * 1000;

export const KEEPALIVE_NUDGE_TEXT =
  "微信推送窗口即将过期，回一句「保活」、「ok」或句号（。或 .）即可续期（请勿只回数字，避免误拍板；回复保活口令不会触发 AI 对话）。";
export const KEEPALIVE_ACK_TEXT = "微信会话已续期，本次未触发 AI 对话。";

const ALWAYS_KEEPALIVE = new Set(["保活", "续期", "续命", "keepalive", "ping"]);
const NUDGED_KEEPALIVE = new Set(["ok", "收到", "在", "在的"]);

export type KeepaliveConfig = {
  hours?: number;
  quietStart?: string;
  quietEnd?: string;
  advanceTime?: string;
  timeZone?: string;
};

export type KeepaliveState = {
  contextToken?: string;
  lastInboundAt?: number;
  keepaliveNudgedAt?: number;
};

type WallClock = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

export function parseClockMinutes(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const match = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!match) return fallback;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return fallback;
  return hour * 60 + minute;
}

function getWallClock(ts: number, timeZone?: string): WallClock {
  if (!timeZone) {
    const date = new Date(ts);
    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      hour: date.getHours(),
      minute: date.getMinutes(),
    };
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(ts));
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((item) => item.type === type)?.value ?? 0);
  const hour = value("hour") === 24 ? 0 : value("hour");
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour,
    minute: value("minute"),
  };
}

function wallToEpoch(wall: WallClock, dayOffset: number, timeZone?: string): number {
  const base = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + dayOffset, wall.hour, wall.minute, 0, 0));
  if (!timeZone) {
    return new Date(wall.year, wall.month - 1, wall.day + dayOffset, wall.hour, wall.minute, 0, 0).getTime();
  }
  const targetUtc = base.getTime();
  const actual = getWallClock(targetUtc, timeZone);
  const actualUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, 0, 0);
  let candidate = targetUtc + (targetUtc - actualUtc);
  const verify = getWallClock(candidate, timeZone);
  const verifyUtc = Date.UTC(verify.year, verify.month - 1, verify.day, verify.hour, verify.minute, 0, 0);
  if (verifyUtc !== targetUtc) {
    candidate += targetUtc - verifyUtc;
  }
  return candidate;
}

export function isInQuietHours(minuteOfDay: number, quietStart: number, quietEnd: number): boolean {
  if (quietStart === quietEnd) return false;
  if (quietStart < quietEnd) {
    return minuteOfDay >= quietStart && minuteOfDay < quietEnd;
  }
  return minuteOfDay >= quietStart || minuteOfDay < quietEnd;
}

export function nextKeepaliveTarget(lastInboundAt: number, config: KeepaliveConfig = {}): number | null {
  const hours = config.hours ?? DEFAULT_KEEPALIVE_HOURS;
  if (!Number.isFinite(hours) || hours <= 0) return null;

  const quietStart = parseClockMinutes(config.quietStart, parseClockMinutes(DEFAULT_QUIET_START, 22 * 60));
  const quietEnd = parseClockMinutes(config.quietEnd, parseClockMinutes(DEFAULT_QUIET_END, 7 * 60 + 30));
  const advance = parseClockMinutes(config.advanceTime, parseClockMinutes(DEFAULT_ADVANCE_TIME, 21 * 60));
  const latestSafe = lastInboundAt + CONTEXT_TTL_HOURS * 60 * 60 * 1000 - MORNING_MARGIN_MS;
  let dueAt = lastInboundAt + hours * 60 * 60 * 1000;
  if (dueAt > latestSafe) dueAt = latestSafe;
  if (dueAt <= lastInboundAt) return null;

  const dueWall = getWallClock(dueAt, config.timeZone);
  const dueMinute = dueWall.hour * 60 + dueWall.minute;

  if (!isInQuietHours(dueMinute, quietStart, quietEnd)) {
    return dueAt;
  }

  const advHour = Math.floor(advance / 60);
  const advMinute = advance % 60;
  const endHour = Math.floor(quietEnd / 60);
  const endMinute = quietEnd % 60;

  let preDayOffset = 0;
  let postDayOffset = 0;
  if (quietStart > quietEnd) {
    // Overnight quiet window, e.g. 22:00 -> 07:30.
    if (dueMinute >= quietStart) {
      preDayOffset = 0;
      postDayOffset = 1;
    } else {
      preDayOffset = -1;
      postDayOffset = 0;
    }
  } else if (advance > quietStart) {
    preDayOffset = -1;
  }

  const morning = wallToEpoch(
    { year: dueWall.year, month: dueWall.month, day: dueWall.day, hour: endHour, minute: endMinute },
    postDayOffset,
    config.timeZone,
  );
  if (morning <= latestSafe && morning > lastInboundAt) return morning;

  const evening = wallToEpoch(
    { year: dueWall.year, month: dueWall.month, day: dueWall.day, hour: advHour, minute: advMinute },
    preDayOffset,
    config.timeZone,
  );
  if (evening - lastInboundAt >= MIN_ADVANCE_IDLE_MS && evening <= latestSafe && evening > lastInboundAt) {
    return evening;
  }
  return null;
}

export function shouldSendKeepalive(state: KeepaliveState, now: number, config: KeepaliveConfig = {}): boolean {
  if (!state.contextToken || !state.lastInboundAt) return false;
  if (state.keepaliveNudgedAt && state.keepaliveNudgedAt >= state.lastInboundAt) return false;

  const target = nextKeepaliveTarget(state.lastInboundAt, config);
  if (target === null || now < target) return false;

  const quietStart = parseClockMinutes(config.quietStart, parseClockMinutes(DEFAULT_QUIET_START, 22 * 60));
  const quietEnd = parseClockMinutes(config.quietEnd, parseClockMinutes(DEFAULT_QUIET_END, 7 * 60 + 30));
  const nowWall = getWallClock(now, config.timeZone);
  if (isInQuietHours(nowWall.hour * 60 + nowWall.minute, quietStart, quietEnd)) {
    return false;
  }
  return true;
}

export function isKeepaliveReply(text: string, nudgedActive: boolean): boolean {
  const trimmed = text.trim();
  if (trimmed === "." || trimmed === "。") return true;
  const normalized = trimmed.replace(/[。！!.~～]+$/g, "").trim().toLowerCase();
  if (!normalized) return false;
  if (ALWAYS_KEEPALIVE.has(normalized)) return true;
  return nudgedActive && NUDGED_KEEPALIVE.has(normalized);
}

/** Channel options. `keepalive` defaults to on; `false` turns the nudge off. */
export function readKeepaliveConfig(options: Record<string, unknown>): KeepaliveConfig {
  const raw = options.keepalive;
  if (raw === false) return { hours: 0 };
  const nested = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
  if (nested?.enabled === false) return { hours: 0 };

  const picked = firstHours(nested?.hours, options.keepaliveHours);
  const hours = picked === undefined ? DEFAULT_KEEPALIVE_HOURS : picked;
  if (!Number.isFinite(hours) || hours <= 0) return { hours: 0 };

  const quietStart = firstString(nested?.quietStart, options.keepaliveQuietStart);
  const quietEnd = firstString(nested?.quietEnd, options.keepaliveQuietEnd);
  const advanceTime = firstString(nested?.advanceTime, options.keepaliveAdvanceTime);
  const timeZone = firstString(nested?.timeZone, options.keepaliveTimeZone);
  return {
    hours,
    ...(quietStart ? { quietStart } : {}),
    ...(quietEnd ? { quietEnd } : {}),
    ...(advanceTime ? { advanceTime } : {}),
    ...(timeZone ? { timeZone } : {}),
  };
}

function firstHours(primary: unknown, fallback: unknown): number | undefined {
  for (const value of [primary, fallback]) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (value === false) return 0;
  }
  return undefined;
}

function firstString(primary: unknown, fallback: unknown): string | undefined {
  if (typeof primary === "string" && primary.trim()) return primary;
  if (typeof fallback === "string" && fallback.trim()) return fallback;
  return undefined;
}
