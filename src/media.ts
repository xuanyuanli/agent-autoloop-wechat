// Download and AES-128-ECB decrypt inbound WeChat CDN media (image, voice, file, video).
import { createDecipheriv } from "node:crypto";
import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CdnMedia, WechatMessage, WechatMessageItem } from "./api.ts";

export const DEFAULT_CDN_BASE = "https://novac2c.cdn.weixin.qq.com/c2c";
export const MAX_MEDIA_BYTES = 100 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type MediaKind = "image" | "voice" | "file" | "video";

export type MediaResult = {
  path?: string;
  size?: number;
  error?: string;
};

export type DownloadMediaOptions = {
  dir: string;
  cdnBaseUrl?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  maxBytes?: number;
  now?: () => number;
  log?: (line: string) => void;
};

type MediaSpec = {
  kind: MediaKind;
  media: CdnMedia;
  aesKey?: string;
  allowPlaintext: boolean;
  fileName?: string;
  encodeType?: number;
};

const VOICE_ENCODE_EXT: Record<number, string> = {
  1: ".pcm",
  4: ".spx",
  5: ".amr",
  6: ".silk",
  7: ".mp3",
  8: ".ogg",
};

export function buildCdnDownloadUrl(encryptQueryParam: string, cdnBaseUrl = DEFAULT_CDN_BASE) {
  return `${cdnBaseUrl.replace(/\/$/, "")}/download?encrypted_query_param=${encodeURIComponent(encryptQueryParam)}`;
}

/**
 * Parse iLink AES-128 key from either:
 * - 32-char hex string (`image_item.aeskey`)
 * - base64(16 raw bytes)
 * - base64(32-char ASCII hex string)
 */
export function parseAesKey(raw: string): Buffer {
  const trimmed = raw.trim();
  if (/^[0-9a-fA-F]{32}$/.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }
  const normalized = trimmed.replace(/-/g, "+").replace(/_/g, "/");
  const decoded = Buffer.from(normalized, "base64");
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString("ascii"))) {
    return Buffer.from(decoded.toString("ascii"), "hex");
  }
  throw new Error(`AES 密钥格式无效（解码后 ${decoded.length} 字节）`);
}

export function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function sanitizeFileName(name: string): string {
  const base = path.basename(name.trim());
  const cleaned = base
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, "_")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+|[.\s]+$/g, "");
  if (!cleaned) return "file.bin";
  if ([...cleaned].length <= 120) return cleaned;
  const ext = path.extname(cleaned);
  const stem = cleaned.slice(0, Math.max(1, cleaned.length - ext.length));
  const shortExt = [...ext].slice(0, 20).join("");
  const shortStem = [...stem].slice(0, Math.max(1, 120 - [...shortExt].length)).join("");
  return `${shortStem}${shortExt}`;
}

export function detectExtension(buf: Buffer, kind: MediaKind, encodeType?: number, fileName?: string): string {
  if (kind === "file" && fileName) {
    const ext = path.extname(sanitizeFileName(fileName));
    if (ext) return ext.toLowerCase();
  }
  if (kind === "image" || kind === "file") {
    if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      return ".png";
    }
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
      return ".jpg";
    }
    if (buf.length >= 4 && buf.subarray(0, 4).toString("ascii") === "GIF8") {
      return ".gif";
    }
    if (
      buf.length >= 12 &&
      buf.subarray(0, 4).toString("ascii") === "RIFF" &&
      buf.subarray(8, 12).toString("ascii") === "WEBP"
    ) {
      return ".webp";
    }
    if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) {
      return ".bmp";
    }
    if (buf.length >= 12 && buf.subarray(4, 8).toString("ascii") === "ftyp") {
      const brand = buf.subarray(8, 12).toString("ascii");
      if (brand === "avif" || brand === "avis") return ".avif";
      if (brand === "heic" || brand === "heix" || brand === "mif1" || brand === "msf1") return ".heic";
    }
  }
  if (kind === "voice") {
    const head = buf.subarray(0, 12).toString("ascii");
    if (head.startsWith("#!SILK_V3") || head.startsWith("\x02#!SILK_V3")) return ".silk";
    if (head.startsWith("#!AMR")) return ".amr";
    if (head.startsWith("OggS")) return ".ogg";
    if (
      buf.length >= 12 &&
      buf.subarray(0, 4).toString("ascii") === "RIFF" &&
      buf.subarray(8, 12).toString("ascii") === "WAVE"
    ) {
      return ".wav";
    }
    if (head.startsWith("ID3") || (buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) {
      return ".mp3";
    }
    return (encodeType !== undefined ? VOICE_ENCODE_EXT[encodeType] : undefined) ?? ".silk";
  }
  if (kind === "video") {
    if (buf.length >= 8 && buf.subarray(4, 8).toString("ascii") === "ftyp") return ".mp4";
    if (buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return ".mkv";
    if (
      buf.length >= 12 &&
      buf.subarray(0, 4).toString("ascii") === "RIFF" &&
      buf.subarray(8, 12).toString("ascii") === "AVI "
    ) {
      return ".avi";
    }
    return ".mp4";
  }
  return ".bin";
}

function extractMediaSpec(item: WechatMessageItem): MediaSpec | null {
  if (item.type === 2) {
    const img = item.image_item;
    const media = img?.media?.full_url || img?.media?.encrypt_query_param ? img.media : img?.thumb_media;
    if (!media?.full_url && !media?.encrypt_query_param) return null;
    const aesKey = img?.aeskey?.trim() || media.aes_key?.trim() || undefined;
    return { kind: "image", media, aesKey, allowPlaintext: true };
  }
  if (item.type === 3) {
    const media = item.voice_item?.media;
    const aesKey = media?.aes_key?.trim();
    if ((!media?.full_url && !media?.encrypt_query_param) || !aesKey) return null;
    return { kind: "voice", media, aesKey, allowPlaintext: false, encodeType: item.voice_item?.encode_type };
  }
  if (item.type === 4) {
    const media = item.file_item?.media;
    const aesKey = media?.aes_key?.trim();
    if ((!media?.full_url && !media?.encrypt_query_param) || !aesKey) return null;
    return {
      kind: "file",
      media,
      aesKey,
      allowPlaintext: false,
      fileName: item.file_item?.file_name?.trim() || undefined,
    };
  }
  if (item.type === 5) {
    const media = item.video_item?.media;
    const aesKey = media?.aes_key?.trim();
    if ((!media?.full_url && !media?.encrypt_query_param) || !aesKey) return null;
    return { kind: "video", media, aesKey, allowPlaintext: false };
  }
  return null;
}

async function fetchBytes(
  url: string,
  fetchImpl: typeof fetch,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  timer.unref?.();
  const forward = () => controller.abort();
  signal?.addEventListener("abort", forward, { once: true });
  try {
    const response = await fetchImpl(url, { method: "GET", signal: controller.signal });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`CDN ${response.status}${detail ? ` ${detail.slice(0, 120)}` : ""}`);
    }
    const headerLen = Number(response.headers.get("content-length") ?? "0");
    if (headerLen > maxBytes) {
      throw new Error(`文件过大（${(headerLen / 1024 / 1024).toFixed(1)} MB）`);
    }
    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.byteLength > maxBytes) {
      throw new Error(`文件过大（${(buf.byteLength / 1024 / 1024).toFixed(1)} MB）`);
    }
    return buf;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", forward);
  }
}

function stampPrefix(ms: number, seq: number) {
  const d = new Date(ms);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${pad(d.getMilliseconds(), 3)}-${seq}`
  );
}

async function downloadItem(spec: MediaSpec, seq: number, opts: DownloadMediaOptions): Promise<MediaResult> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const maxBytes = opts.maxBytes ?? MAX_MEDIA_BYTES;
  const cdnBaseUrl = opts.cdnBaseUrl ?? DEFAULT_CDN_BASE;
  const url = spec.media.full_url?.trim() || buildCdnDownloadUrl(spec.media.encrypt_query_param ?? "", cdnBaseUrl);
  const raw = await fetchBytes(url, fetchImpl, maxBytes, opts.signal);

  let data: Buffer;
  if (spec.aesKey) {
    data = decryptAesEcb(raw, parseAesKey(spec.aesKey));
  } else if (spec.allowPlaintext) {
    data = raw;
  } else {
    throw new Error("缺少 AES 解密密钥");
  }

  await mkdir(opts.dir, { recursive: true });
  const prefix = stampPrefix(opts.now?.() ?? Date.now(), seq);
  const name =
    spec.kind === "file" && spec.fileName
      ? `${prefix}-${sanitizeFileName(spec.fileName)}`
      : `${prefix}-${spec.kind}${detectExtension(data, spec.kind, spec.encodeType, spec.fileName)}`;
  const target = path.join(opts.dir, name);
  await writeFile(target, data, { mode: 0o600 });
  return { path: target, size: data.byteLength };
}

/**
 * Download and decrypt all inbound media items (and quoted media items) from the owner's messages.
 * Individual item failures are recorded on that item instead of failing the whole page.
 */
export async function downloadPageMedia(
  messages: WechatMessage[],
  ownerUserId: string,
  opts: DownloadMediaOptions,
): Promise<Map<WechatMessageItem, MediaResult>> {
  const resolved = new Map<WechatMessageItem, MediaResult>();
  let seq = 0;

  const processItem = async (item: WechatMessageItem | undefined) => {
    if (!item || resolved.has(item)) return;
    const spec = extractMediaSpec(item);
    if (!spec) return;
    seq += 1;
    try {
      resolved.set(item, await downloadItem(spec, seq, opts));
    } catch (error) {
      if (opts.signal?.aborted) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      opts.log?.(`下载微信媒体（${spec.kind}）失败：${reason}`);
      resolved.set(item, { error: reason });
    }
  };

  for (const msg of messages) {
    if (msg.message_type === 2 || msg.message_state === 1) continue;
    if (msg.from_user_id?.trim() !== ownerUserId) continue;
    for (const item of msg.item_list ?? []) {
      await processItem(item);
      if (item.ref_msg?.message_item) {
        await processItem(item.ref_msg.message_item);
      }
    }
  }
  return resolved;
}

/** Best-effort cleanup for old cached WeChat media files. */
export async function pruneOldMedia(dir: string, maxAgeMs = DEFAULT_MAX_AGE_MS, now = Date.now()) {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  const cutoff = now - maxAgeMs;
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const info = await stat(file);
      if (info.isFile() && info.mtimeMs < cutoff) {
        await unlink(file);
      }
    } catch {
      // Ignore individual cleanup failures.
    }
  }
}
