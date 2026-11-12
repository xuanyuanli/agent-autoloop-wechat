// iLink Bot HTTP client. Field names follow the public protocol document of
// @tencent-weixin/openclaw-weixin (MIT, Copyright (C) 2026 Tencent).
import { randomUUID } from "node:crypto";

const LOGIN_BASE = "https://ilinkai.weixin.qq.com";
export const CHANNEL_VERSION = "3.0.1/agent-autoloop-wechat-0.2.3";
const BOT_AGENT = "agent-autoloop-wechat/0.2.3";

function statusCode(parsed: { ret?: number; errcode?: number }) {
  if (typeof parsed.ret === "number" && parsed.ret !== 0) return parsed.ret;
  if (typeof parsed.errcode === "number" && parsed.errcode !== 0) return parsed.errcode;
  return 0;
}

export type WechatMessage = {
  message_type?: number;
  message_state?: number;
  from_user_id?: string;
  context_token?: string;
  message_id?: number | string;
  client_id?: string;
  create_time_ms?: number;
  item_list?: {
    type?: number;
    text_item?: { text?: string };
    voice_item?: { text?: string };
    file_item?: { file_name?: string };
  }[];
};

export type Session = {
  token: string;
  baseUrl: string;
  botId: string;
  userId: string;
  cursor: string;
};

type FetchLike = typeof fetch;

function clientVersion(version: string) {
  const parts = version.split(".").map((part) => Number.parseInt(part, 10));
  const major = Number.isNaN(parts[0]) ? 0 : parts[0];
  const minor = Number.isNaN(parts[1]) ? 0 : parts[1];
  const patch = Number.isNaN(parts[2]) ? 0 : parts[2];
  return String(((major & 255) << 16) | ((minor & 255) << 8) | (patch & 255));
}

function withSlash(url: string) {
  return url.endsWith("/") ? url : `${url}/`;
}

function randomUin() {
  return Buffer.from(String(Math.floor(Math.random() * 4294967296)), "utf8").toString("base64");
}

export function createClient(fetchImpl: FetchLike = globalThis.fetch, wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
  const headers = {
    "iLink-App-Id": "bot",
    "iLink-App-ClientVersion": clientVersion(CHANNEL_VERSION),
  };
  const baseInfo = { channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT };

  async function request(url: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    const forward = () => controller.abort();
    signal?.addEventListener("abort", forward, { once: true });
    try {
      const response = await fetchImpl(url, { ...init, signal: controller.signal });
      const text = await response.text();
      if (!response.ok) throw new Error(`${response.status} ${text.slice(0, 200)}`);
      return text;
    } catch (error) {
      if (signal?.aborted) throw error;
      if (controller.signal.aborted) return "";
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", forward);
    }
  }

  async function post(baseUrl: string, endpoint: string, body: string, token: string | undefined, timeoutMs: number, signal?: AbortSignal) {
    const head: Record<string, string> = {
      "Content-Type": "application/json",
      AuthorizationType: "ilink_bot_token",
      "X-WECHAT-UIN": randomUin(),
      ...headers,
    };
    if (token) head.Authorization = `Bearer ${token}`;
    return request(new URL(endpoint, withSlash(baseUrl)).toString(), { method: "POST", headers: head, body }, timeoutMs, signal);
  }

  return {
    async fetchQr() {
      const raw = await post(LOGIN_BASE, "ilink/bot/get_bot_qrcode?bot_type=3", JSON.stringify({ local_token_list: [] }), undefined, 20_000);
      const parsed = JSON.parse(raw) as { qrcode?: string; qrcode_img_content?: string };
      if (!parsed.qrcode || typeof parsed.qrcode_img_content !== "string") throw new Error("登录二维码响应不完整");
      return { qrcode: parsed.qrcode, image: parsed.qrcode_img_content };
    },
    async pollQr(qrcode: string, base = LOGIN_BASE, verifyCode?: string, signal?: AbortSignal) {
      const query = new URLSearchParams({ qrcode });
      if (verifyCode) query.set("verify_code", verifyCode);
      const raw = await request(
        new URL(`ilink/bot/get_qrcode_status?${query}`, withSlash(base)).toString(),
        { method: "GET", headers },
        40_000,
        signal,
      );
      if (!raw) return { status: "wait" };
      return JSON.parse(raw) as {
        status?: string;
        bot_token?: string;
        ilink_bot_id?: string;
        baseurl?: string;
        ilink_user_id?: string;
        redirect_host?: string;
      };
    },
    async getUpdates(session: Session, signal?: AbortSignal) {
      const raw = await post(
        session.baseUrl,
        "ilink/bot/getupdates",
        JSON.stringify({ get_updates_buf: session.cursor, base_info: baseInfo }),
        session.token,
        45_000,
        signal,
      );
      if (!raw) return { messages: [] as WechatMessage[], cursor: undefined as string | undefined };
      const parsed = JSON.parse(raw) as {
        ret?: number;
        errcode?: number;
        errmsg?: string;
        msgs?: WechatMessage[];
        get_updates_buf?: string;
      };
      const code = statusCode(parsed);
      if (code !== 0) throw new Error(`getupdates ${code} ${parsed.errmsg ?? ""}`.trim());
      return { messages: parsed.msgs ?? [], cursor: parsed.get_updates_buf };
    },
    async sendText(session: Session, to: string, text: string, contextToken?: string) {
      let token = contextToken;
      let stripped = false;
      for (let attempt = 0; attempt < 4; attempt++) {
        const message: Record<string, unknown> = {
          from_user_id: "",
          to_user_id: to,
          client_id: randomUUID(),
          message_type: 2,
          message_state: 2,
          item_list: [{ type: 1, text_item: { text } }],
        };
        if (token) message.context_token = token;
        const raw = await post(session.baseUrl, "ilink/bot/sendmessage", JSON.stringify({ msg: message, base_info: baseInfo }), session.token, 20_000);
        if (!raw) throw new Error("sendmessage 空响应");
        const parsed = JSON.parse(raw) as { ret?: number; errcode?: number; errmsg?: string };
        const code = statusCode(parsed);
        if (code === 0) return;
        if (code === -14 && token && !stripped) {
          token = undefined;
          stripped = true;
          continue;
        }
        if (code === -2 && attempt < 3) {
          await wait(2000 * 2 ** attempt);
          continue;
        }
        throw new Error(`sendmessage ${code} ${parsed.errmsg ?? ""}`.trim());
      }
      throw new Error("sendmessage 没有发出去");
    },
  };
}
