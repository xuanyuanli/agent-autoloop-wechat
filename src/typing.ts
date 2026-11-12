// The WeChat header shows「对方正在输入」only while we keep sending status 1.
// A lease is the set of replies the user is actually waiting on.
export const TYPING_MAX_MS = 30 * 60 * 1000;
export const TYPING_INTERVAL_MS = 5_000;
export const TICKET_TTL_MS = 60 * 60 * 1000;

export type TypingLease = { rules: string[]; until: number; contextToken?: string };

export function startLease(current: TypingLease | null, rule: string, now: number, contextToken?: string): TypingLease {
  const rules = [...new Set([...(current?.rules ?? []), rule])];
  const token = contextToken || current?.contextToken;
  return { rules, until: now + TYPING_MAX_MS, ...(token ? { contextToken: token } : {}) };
}

/** Remove one awaited reply. Null means the indicator should turn off. An unrelated rule leaves the lease as it was. */
export function finishLease(current: TypingLease | null, rule: string): TypingLease | null {
  if (!current?.rules.includes(rule)) return current;
  const rules = current.rules.filter((item) => item !== rule);
  if (!rules.length) return null;
  return { ...current, rules };
}

export function leaseExpired(current: TypingLease | null, now: number) {
  return Boolean(current && now >= current.until);
}
