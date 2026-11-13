import type { RefMessage, WechatMessage, WechatMessageItem } from "./api.ts";
import type { MediaResult } from "./media.ts";
import type { Held } from "./session.ts";

export type Inbound = {
  id: string;
  from: string;
  text: string;
  media: Held[];
  contextToken?: string;
};

const KINDS: Record<number, string> = { 2: "图片", 3: "语音", 4: "文件", 5: "视频" };

function isMediaType(type: number | undefined): boolean {
  return type === 2 || type === 3 || type === 4 || type === 5;
}

function toHeld(item: WechatMessageItem, resolved?: ReadonlyMap<WechatMessageItem, MediaResult>, extraNote?: string): Held {
  const kind = KINDS[item.type ?? 0] ?? "其他";
  const name = item.file_item?.file_name?.trim();
  const transcript = item.voice_item?.text?.trim();
  const note = [extraNote, transcript].filter(Boolean).join("：") || undefined;
  const saved = resolved?.get(item);
  return {
    kind,
    ...(name ? { name } : {}),
    ...(note ? { note } : {}),
    ...(saved?.path ? { path: saved.path } : {}),
    ...(saved?.size !== undefined ? { size: saved.size } : {}),
    ...(saved?.error ? { error: saved.error } : {}),
  };
}

function quoteFromRef(
  ref: RefMessage | undefined,
  resolved?: ReadonlyMap<WechatMessageItem, MediaResult>,
): { text?: string; media?: Held } {
  if (!ref) return {};
  const quoted = ref.message_item;
  if (quoted && isMediaType(quoted.type)) {
    return { media: toHeld(quoted, resolved, "引用消息") };
  }
  const parts: string[] = [];
  const title = ref.title?.trim();
  if (title) parts.push(title);
  if (quoted) {
    const inner = quoted.text_item?.text?.trim() || quoted.voice_item?.text?.trim();
    if (inner && inner !== title) parts.push(inner);
  }
  return parts.length ? { text: parts.join(" | ") } : {};
}

/** User content, or null for the bot's own echo and half-written placeholders. */
export function inboundMessage(
  message: WechatMessage,
  resolved?: ReadonlyMap<WechatMessageItem, MediaResult>,
): Inbound | null {
  if (message.message_type === 2) return null;
  if (message.message_state === 1) return null;
  const from = message.from_user_id?.trim() ?? "";
  if (!from) return null;
  const text: string[] = [];
  const media: Held[] = [];
  for (const item of message.item_list ?? []) {
    const written = item.text_item?.text?.trim();
    if (item.type === 1 || (!item.type && written)) {
      const quoted = quoteFromRef(item.ref_msg, resolved);
      if (quoted.media) media.push(quoted.media);
      if (written) {
        text.push(quoted.text ? `[引用: ${quoted.text}]\n${written}` : written);
      } else if (quoted.text) {
        text.push(`[引用: ${quoted.text}]`);
      }
      continue;
    }
    media.push(toHeld(item, resolved));
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

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The words handed to the agent once a text instruction arrives. */
export function composeTask(held: Held[], text: string) {
  const lines = [];
  if (held.length) {
    const hasFile = held.some((item) => Boolean(item.path));
    lines.push(
      hasFile
        ? "一起发来的非文字（已保存到本机，可直接读取文件）："
        : "一起发来的非文字（没有文件本体，只有这些说明）：",
    );
    for (const item of held) {
      const name = item.name ? ` ${item.name}` : "";
      const note = item.note ? `：${item.note}` : "";
      const size = item.size !== undefined ? `（${formatSize(item.size)}）` : "";
      const location = item.path ? ` -> ${item.path}${size}` : item.error ? `（下载失败：${item.error}）` : "";
      lines.push(`- ${item.kind}${name}${note}${location}`);
    }
    lines.push("");
  }
  lines.push(text.trim());
  return [...lines.join("\n")].slice(0, 4000).join("");
}
