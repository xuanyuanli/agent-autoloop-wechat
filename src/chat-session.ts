// The WeChat chat is one Cursor thread. An idle gap starts a new one so the
// context does not grow without a bound. Inspection replies are a different rule.
export const CHAT_RULE = "微信对话";
export const CHAT_TTL_MS = 8 * 60 * 60 * 1000;

export type ChatStamp = { id: string | null; at: number; legacy?: boolean };

export function isChatPrompt(prompt: string) {
  return prompt.includes(`规则「${CHAT_RULE}」`);
}

/** Whether this launch should keep a Cursor session, and the stamp to store. */
export function decideChat(resume: string | null, prompt: string, stamp: ChatStamp | null, now: number) {
  if (!isChatPrompt(prompt)) return { resume, stamp, fresh: false, remember: false };
  // A stamp written before session ids were stored can still continue the hub's id.
  if (stamp?.legacy && resume && now - stamp.at < CHAT_TTL_MS) {
    return { resume, stamp: { id: resume, at: now }, fresh: false, remember: true };
  }
  const alive = Boolean(stamp?.id) && now - (stamp?.at ?? 0) < CHAT_TTL_MS;
  if (alive && stamp?.id) return { resume: stamp.id, stamp: { id: stamp.id, at: now }, fresh: false, remember: true };
  return { resume: null, stamp: { id: null, at: 0 }, fresh: true, remember: true };
}
