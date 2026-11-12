import type { WechatMessage } from "./api.ts";
import type { Held } from "./session.ts";

export type Inbound = {
  id: string;
  from: string;
  text: string;
  media: Held[];
  contextToken?: string;
};

const KINDS: Record<number, string> = { 2: "图片", 3: "语音", 4: "文件", 5: "视频" };

/** User content, or null for the bot's own echo and half-written placeholders. */
export function inboundMessage(message: WechatMessage): Inbound | null {
  if (message.message_type === 2) return null;
  if (message.message_state === 1) return null;
  const from = message.from_user_id?.trim() ?? "";
  if (!from) return null;
  const text: string[] = [];
  const media: Held[] = [];
  for (const item of message.item_list ?? []) {
    const written = item.text_item?.text?.trim();
    if (item.type === 1 || (!item.type && written)) {
      if (written) text.push(written);
      continue;
    }
    const kind = KINDS[item.type ?? 0] ?? "其他";
    const name = item.file_item?.file_name?.trim();
    const note = item.voice_item?.text?.trim();
    media.push({ kind, ...(name ? { name } : {}), ...(note ? { note } : {}) });
  }
  if (!text.length && !media.length) return null;
  const id = message.message_id ?? message.client_id ?? message.create_time_ms;
  if (id === undefined || id === "") return null;
  return {
    id: `wx-${id}`,
    from,
    text: text.join("\n").trim(),
    media,
    ...(message.context_token ? { contextToken: message.context_token } : {}),
  };
}

/** The words handed to the agent once a text instruction arrives. */
export function composeTask(held: Held[], text: string) {
  const lines = [];
  if (held.length) {
    lines.push("一起发来的非文字（没有文件本体，只有这些说明）：");
    for (const item of held) {
      const name = item.name ? ` ${item.name}` : "";
      const note = item.note ? `：${item.note}` : "";
      lines.push(`- ${item.kind}${name}${note}`);
    }
    lines.push("");
  }
  lines.push(text.trim());
  return [...lines.join("\n")].slice(0, 4000).join("");
}
