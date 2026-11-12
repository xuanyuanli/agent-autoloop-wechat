// The WeChat chat is one Cursor thread. An idle gap starts a new one so the
// context does not grow without a bound. Inspection replies are a different rule.
export const CHAT_RULE = "微信对话";
export const CHAT_TTL_MS = 8 * 60 * 60 * 1000;

export type ChatStamp = { at: number; break: boolean };

export function isChatPrompt(prompt: string) {
  return prompt.includes(`规则「${CHAT_RULE}」`);
}

/** Whether this launch should keep the hub's session, and the stamp to store. */
export function decideChat(resume: string | null, prompt: string, stamp: ChatStamp | null, now: number) {
  if (!isChatPrompt(prompt)) return { resume, stamp, fresh: false, remember: false };
  const alive = Boolean(resume) && Boolean(stamp) && !stamp!.break && now - stamp!.at < CHAT_TTL_MS;
  if (alive) return { resume, stamp: { at: now, break: false }, fresh: false, remember: true };
  return { resume: null, stamp: { at: stamp?.at ?? 0, break: true }, fresh: true, remember: true };
}
