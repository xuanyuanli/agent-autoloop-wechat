import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { WechatMessage } from "../src/api.ts";
import {
  buildCdnDownloadUrl,
  decryptAesEcb,
  detectExtension,
  downloadPageMedia,
  parseAesKey,
  pruneOldMedia,
  sanitizeFileName,
} from "../src/media.ts";

function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

test("parseAesKey supports hex, base64(raw16), and base64(hex32)", () => {
  const raw = randomBytes(16);
  const hex = raw.toString("hex");
  const b64Raw = raw.toString("base64");
  const b64Hex = Buffer.from(hex, "ascii").toString("base64");

  assert.deepEqual(parseAesKey(hex), raw);
  assert.deepEqual(parseAesKey(b64Raw), raw);
  assert.deepEqual(parseAesKey(b64Hex), raw);
  assert.throws(() => parseAesKey("dG9vLXNob3J0"), /AES 密钥格式无效/);
});

test("decryptAesEcb round-trips plaintext encrypted with AES-128-ECB", () => {
  const key = randomBytes(16);
  const plain = Buffer.from("hello wechat media payload");
  const cipher = encryptAesEcb(plain, key);
  assert.deepEqual(decryptAesEcb(cipher, key), plain);
});

test("detectExtension identifies common image, voice, and video magic headers", () => {
  assert.equal(detectExtension(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "image"), ".png");
  assert.equal(detectExtension(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), "image"), ".jpg");
  assert.equal(detectExtension(Buffer.from("GIF89a"), "image"), ".gif");
  assert.equal(detectExtension(Buffer.from("RIFF1234WEBP"), "image"), ".webp");
  assert.equal(detectExtension(Buffer.from("\x02#!SILK_V3abc"), "voice"), ".silk");
  assert.equal(detectExtension(Buffer.from("#!AMR\nabc"), "voice"), ".amr");
  assert.equal(detectExtension(Buffer.from("RIFF1234WAVE"), "voice"), ".wav");
  assert.equal(detectExtension(Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]), "video"), ".mp4");
  assert.equal(detectExtension(Buffer.from("plain"), "file", undefined, "report.PDF"), ".pdf");
});

test("sanitizeFileName strips directory traversal and illegal path characters", () => {
  assert.equal(sanitizeFileName("../../etc/passwd"), "passwd");
  assert.equal(sanitizeFileName('bad:name*with?"<>|.txt'), "bad_name_with_.txt");
});

test("downloadPageMedia downloads and decrypts image, voice, file, video, and quoted media", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wx-media-"));
  const imgKey = randomBytes(16);
  const voiceKey = randomBytes(16);
  const fileKey = randomBytes(16);
  const videoKey = randomBytes(16);
  const quotedKey = randomBytes(16);

  const imgPlain = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const voicePlain = Buffer.from("\x02#!SILK_V3_VOICE_DATA");
  const filePlain = Buffer.from("line1\nline2\n");
  const videoPlain = Buffer.from([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  const quotedPlain = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 8, 7]);

  const payloads = new Map<string, Buffer>([
    [buildCdnDownloadUrl("img-q", "https://cdn.example"), encryptAesEcb(imgPlain, imgKey)],
    ["https://full.example/voice", encryptAesEcb(voicePlain, voiceKey)],
    [buildCdnDownloadUrl("file-q", "https://cdn.example"), encryptAesEcb(filePlain, fileKey)],
    [buildCdnDownloadUrl("video-q", "https://cdn.example"), encryptAesEcb(videoPlain, videoKey)],
    [buildCdnDownloadUrl("quote-q", "https://cdn.example"), quotedPlain],
  ]);

  const fetchImpl: typeof fetch = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const body = payloads.get(url);
    if (!body) return new Response("not found", { status: 404 });
    return new Response(new Uint8Array(body), { status: 200 });
  };

  const imgItem = {
    type: 2,
    image_item: {
      aeskey: imgKey.toString("hex"),
      media: { encrypt_query_param: "img-q", aes_key: randomBytes(16).toString("base64") },
    },
  };
  const voiceItem = {
    type: 3,
    voice_item: {
      text: "语音转文字内容",
      media: {
        full_url: "https://full.example/voice",
        aes_key: Buffer.from(voiceKey.toString("hex"), "ascii").toString("base64"),
      },
    },
  };
  const fileItem = {
    type: 4,
    file_item: {
      file_name: "../dir/err.log",
      media: { encrypt_query_param: "file-q", aes_key: fileKey.toString("base64") },
    },
  };
  const videoItem = {
    type: 5,
    video_item: {
      media: { encrypt_query_param: "video-q", aes_key: Buffer.from(videoKey.toString("hex"), "ascii").toString("base64") },
    },
  };
  const quotedImage = {
    type: 2,
    image_item: {
      media: { encrypt_query_param: "quote-q" },
    },
  };
  const textWithQuote = {
    type: 1,
    text_item: { text: "看一下引用的图" },
    ref_msg: { message_item: quotedImage },
  };
  const ignoredOtherUser = {
    type: 2,
    image_item: { aeskey: quotedKey.toString("hex"), media: { encrypt_query_param: "missing" } },
  };

  const messages: WechatMessage[] = [
    {
      message_id: "m1",
      message_type: 1,
      from_user_id: "owner",
      item_list: [imgItem, voiceItem, fileItem, videoItem, textWithQuote],
    },
    {
      message_id: "m2",
      message_type: 1,
      from_user_id: "stranger",
      item_list: [ignoredOtherUser],
    },
  ];

  const resolved = await downloadPageMedia(messages, "owner", {
    dir,
    cdnBaseUrl: "https://cdn.example",
    fetchImpl,
  });

  assert.equal(resolved.has(ignoredOtherUser), false);

  const imgRes = resolved.get(imgItem);
  assert.ok(imgRes?.path?.endsWith(".png"));
  assert.deepEqual(readFileSync(imgRes!.path!), imgPlain);

  const voiceRes = resolved.get(voiceItem);
  assert.ok(voiceRes?.path?.endsWith(".silk"));
  assert.deepEqual(readFileSync(voiceRes!.path!), voicePlain);

  const fileRes = resolved.get(fileItem);
  assert.ok(fileRes?.path?.endsWith("-err.log"));
  assert.deepEqual(readFileSync(fileRes!.path!), filePlain);

  const videoRes = resolved.get(videoItem);
  assert.ok(videoRes?.path?.endsWith(".mp4"));
  assert.deepEqual(readFileSync(videoRes!.path!), videoPlain);

  const quotedRes = resolved.get(quotedImage);
  assert.ok(quotedRes?.path?.endsWith(".jpg"));
  assert.deepEqual(readFileSync(quotedRes!.path!), quotedPlain);
});

test("downloadPageMedia records per-item error without throwing", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wx-media-err-"));
  const logs: string[] = [];
  const item = {
    type: 2,
    image_item: { media: { encrypt_query_param: "bad" }, aeskey: randomBytes(16).toString("hex") },
  };
  const resolved = await downloadPageMedia(
    [{ message_id: "m1", message_type: 1, from_user_id: "owner", item_list: [item] }],
    "owner",
    {
      dir,
      fetchImpl: async () => new Response("expired", { status: 403 }),
      log: (line) => logs.push(line),
    },
  );
  assert.match(resolved.get(item)?.error ?? "", /CDN 403/);
  assert.equal(logs.length, 1);
});

test("pruneOldMedia deletes expired files and preserves recent ones", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wx-prune-"));
  const oldFile = path.join(dir, "old.png");
  const newFile = path.join(dir, "new.png");
  writeFileSync(oldFile, "old");
  writeFileSync(newFile, "new");
  const now = Date.now();
  const tenDaysAgo = new Date(now - 10 * 24 * 60 * 60 * 1000);
  utimesSync(oldFile, tenDaysAgo, tenDaysAgo);

  await pruneOldMedia(dir, 7 * 24 * 60 * 60 * 1000, now);
  assert.equal(existsSync(oldFile), false);
  assert.equal(existsSync(newFile), true);
});
