import type { WechatMessage } from "./api.ts";

/** User text, or null for the bot's own echo and half-written placeholders. */
export function inboundText(message: WechatMessage): { from: string; text: string; contextToken?: string } | null {
  if (message.message_type === 2) return null;
  if (message.message_state === 1) return null;
  const from = message.from_user_id?.trim() ?? "";
  if (!from) return null;
  const text = (message.item_list ?? [])
    .map((item) => item.text_item?.text ?? "")
    .filter(Boolean)
    .join("\n")
    .trim();
  if (!text) return null;
  return { from, text, ...(message.context_token ? { contextToken: message.context_token } : {}) };
}
