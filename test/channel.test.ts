import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import wechat, { type Card } from "../channel.ts";
import type { WechatClient, WechatMessage } from "../src/api.ts";
import { readSessionAsync, writeSessionAsync, type StoredSession } from "../src/session.ts";

const baseSession: StoredSession = {
  token: "bot-token",
  baseUrl: "https://ilink.example/",
  botId: "bot-1",
  userId: "owner-wx",
  cursor: "cur-0",
};

function makeOpenAsk(id: number, rule = "运维巡检"): Card {
  return {
    id,
    version: 1,
    ref: null,
    kind: "ask",
    state: "open",
    title: "要扩容吗",
    text: "队列积压了。",
    options: ["暂不扩容", "立即扩容"],
    recommend: 1,
    choice: null,
    answer: null,
    result: null,
    rule,
  };
}

test("channel delivers open ask, answers from WeChat reply, lights typing, and settles on done follow-up", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "wx-chan-"));
  const sessionFile = path.join(home, "wechat-session.json");
  await writeSessionAsync(sessionFile, baseSession);

  const controller = new AbortController();
  const sentTexts: string[] = [];
  const typingStates: Array<{ ticket: string; status: 1 | 2 }> = [];
  const delivered: Array<{ id: number; version: number; ref: string | null }> = [];
  const answered: Array<{ card: number; body: Record<string, unknown> }> = [];

  let cardPhase = 0;
  let pollPhase = 0;
  let ticketCalls = 0;

  const api: WechatClient = {
    fetchQr: async () => ({ qrcode: "q", image: "img" }),
    pollQr: async () => ({ status: "wait" }),
    getUpdates: async () => {
      pollPhase += 1;
      if (pollPhase === 1) {
        while (delivered.length < 1 && !controller.signal.aborted) {
          await new Promise((r) => setTimeout(r, 5));
        }
        const reply: WechatMessage = {
          message_id: "m-1",
          message_type: 1,
          from_user_id: "owner-wx",
          context_token: "ctx-live",
          item_list: [{ type: 1, text_item: { text: "#11 2 只扩一台" } }],
        };
        return { messages: [reply], cursor: "cur-1" };
      }
      await new Promise((r) => controller.signal.addEventListener("abort", r, { once: true }));
      return { messages: [], cursor: undefined };
    },
    sendText: async (_s, _to, text) => {
      sentTexts.push(text);
    },
    typingTicket: async () => {
      ticketCalls += 1;
      return `ticket-${ticketCalls}`;
    },
    sendTyping: async (_s, ticket, status) => {
      if (ticket === "ticket-1" && status === 1 && typingStates.length === 0) {
        throw new Error("sendtyping -100 expired");
      }
      typingStates.push({ ticket, status });
    },
  };

  const run = wechat(
    {
      hub: {
        nextCard: async () => {
          cardPhase += 1;
          if (cardPhase === 1) return { card: makeOpenAsk(11) };
          if (cardPhase === 2) {
            while (answered.length < 1 && !controller.signal.aborted) {
              await new Promise((r) => setTimeout(r, 5));
            }
            return {
              card: {
                ...makeOpenAsk(11),
                version: 2,
                ref: "wechat-11",
                state: "done",
                choice: 1,
                result: "已扩容 1 台",
              },
            };
          }
          controller.abort();
          return { card: null };
        },
        delivered: async (id, version, ref) => {
          delivered.push({ id, version, ref });
        },
        failed: async () => {},
        answer: async (card, body) => {
          answered.push({ card, body });
        },
      },
      options: { session: sessionFile },
      log: () => {},
      signal: controller.signal,
    },
    { api, wait: async () => {}, home },
  );

  await run;

  assert.equal(delivered.length, 2);
  assert.equal(delivered[0]?.ref, "wechat-11");
  assert.deepEqual(answered, [
    {
      card: 11,
      body: { choice: 1, by: "owner-wx", ref: "wechat-11", text: "只扩一台" },
    },
  ]);
  assert.match(sentTexts[0] ?? "", /\*\*要扩容吗\*\*/);
  assert.equal(sentTexts[1], "已执行：已扩容 1 台");
  assert.equal(typingStates[0]?.ticket, "ticket-2");
  assert.equal(typingStates[0]?.status, 1);
  assert.equal(typingStates.some((item) => item.status === 2), true);

  const saved = await readSessionAsync(sessionFile);
  assert.equal(saved?.cursor, "cur-1");
  assert.equal(saved?.contextToken, "ctx-live");
  assert.deepEqual(saved?.open, []);
});

test("channel suppresses duplicate tell:always summary card when the same run already sent a receipt notice", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "wx-dedup-"));
  const sessionFile = path.join(home, "wechat-session.json");
  await writeSessionAsync(sessionFile, baseSession);

  const controller = new AbortController();
  const sentTexts: string[] = [];
  const deliveredIds: number[] = [];
  const createdAt = "2026-11-12T08:21:15.975Z";
  let step = 0;

  const api: WechatClient = {
    fetchQr: async () => ({ qrcode: "q", image: "img" }),
    pollQr: async () => ({ status: "wait" }),
    getUpdates: async () => {
      await new Promise((r) => controller.signal.addEventListener("abort", r, { once: true }));
      return { messages: [], cursor: undefined };
    },
    sendText: async (_s, _to, text) => {
      sentTexts.push(text);
    },
    typingTicket: async () => "tk",
    sendTyping: async () => {},
  };

  await wechat(
    {
      hub: {
        nextCard: async () => {
          step += 1;
          if (step === 1) {
            // Card #16: multi-line receipt notice from WeChat chat run
            return {
              card: {
                id: 16,
                version: 1,
                ref: null,
                kind: "notice",
                state: "closed",
                title: "今天下午主要改了买家回访和 App 下载页。",
                text: "今天这几件：\n- 买家回访改单选\n- App 下载页切官网",
                options: [],
                recommend: null,
                choice: null,
                answer: null,
                result: null,
                rule: "微信对话",
                createdAt,
              },
            };
          }
          if (step === 2) {
            // Card #17: automatic `run:15:done` summary card created by `tell: "always"` in the same decision
            return {
              card: {
                id: 17,
                version: 1,
                ref: null,
                kind: "notice",
                state: "closed",
                title: "微信对话",
                text: "今天下午主要改了买家回访和 App 下载页。",
                options: [],
                recommend: null,
                choice: null,
                answer: null,
                result: null,
                rule: "微信对话",
                createdAt,
              },
            };
          }
          controller.abort();
          return { card: null };
        },
        delivered: async (id) => {
          deliveredIds.push(id);
        },
        failed: async () => {},
        answer: async () => {},
      },
      options: { session: sessionFile },
      log: () => {},
      signal: controller.signal,
    },
    { api, wait: async () => {}, home },
  );

  // Both cards are acknowledged to the hub, so neither retries, while WeChat receives ONLY ONE bubble
  assert.deepEqual(deliveredIds, [16, 17]);
  assert.equal(sentTexts.length, 1);
  assert.match(sentTexts[0] ?? "", /\*\*今天下午主要改了买家回访和 App 下载页。\*\*/);
  assert.match(sentTexts[0] ?? "", /买家回访改单选/);
});

test("channel rolls back pre-tracked open card when sendText fails", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "wx-fail-"));
  const sessionFile = path.join(home, "wechat-session.json");
  await writeSessionAsync(sessionFile, baseSession);

  const controller = new AbortController();
  const failures: Array<{ id: number; error: string }> = [];
  let pulls = 0;

  const api: WechatClient = {
    fetchQr: async () => ({ qrcode: "q", image: "img" }),
    pollQr: async () => ({ status: "wait" }),
    getUpdates: async () => {
      await new Promise((r) => controller.signal.addEventListener("abort", r, { once: true }));
      return { messages: [], cursor: undefined };
    },
    sendText: async () => {
      throw new Error("sendmessage 500 boom");
    },
    typingTicket: async () => "t1",
    sendTyping: async () => {},
  };

  await wechat(
    {
      hub: {
        nextCard: async () => {
          pulls += 1;
          if (pulls === 1) return { card: makeOpenAsk(22) };
          controller.abort();
          return { card: null };
        },
        delivered: async () => {},
        failed: async (id, _version, error) => {
          failures.push({ id, error });
        },
        answer: async () => {},
      },
      options: { session: sessionFile },
      log: () => {},
      signal: controller.signal,
    },
    { api, wait: async () => {}, home },
  );

  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.id, 22);
  assert.match(failures[0]?.error ?? "", /500 boom/);
  const saved = await readSessionAsync(sessionFile);
  assert.deepEqual(saved?.open ?? [], []);
});

test("channel holds media with wait prompt, then emits wechat.message event with combined detail", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "wx-emit-"));
  const sessionFile = path.join(home, "wechat-session.json");
  await writeSessionAsync(sessionFile, baseSession);

  const controller = new AbortController();
  const sentTexts: string[] = [];
  const emittedEvents: Array<{ url: string; auth: string; body: Record<string, unknown> }> = [];
  let pageCount = 0;

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(init?.headers);
    emittedEvents.push({
      url,
      auth: headers.get("authorization") ?? "",
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    return new Response("{}", { status: 202 });
  };

  const api: WechatClient = {
    fetchQr: async () => ({ qrcode: "q", image: "img" }),
    pollQr: async () => ({ status: "wait" }),
    getUpdates: async () => {
      pageCount += 1;
      if (pageCount === 1) {
        return {
          messages: [{ message_id: "p-1", message_type: 1, from_user_id: "owner-wx", item_list: [{ type: 2 }] }],
          cursor: "cur-a",
        };
      }
      if (pageCount === 2) {
        return {
          messages: [
            {
              message_id: "t-2",
              message_type: 1,
              from_user_id: "owner-wx",
              item_list: [{ type: 1, text_item: { text: "帮我看这张截图" } }],
            },
          ],
          cursor: "cur-b",
        };
      }
      controller.abort();
      return { messages: [], cursor: undefined };
    },
    sendText: async (_s, _to, text) => {
      sentTexts.push(text);
    },
    typingTicket: async () => "tk",
    sendTyping: async () => {},
  };

  await wechat(
    {
      hub: {
        nextCard: async () => {
          await new Promise((r) => controller.signal.addEventListener("abort", r, { once: true }));
          return { card: null };
        },
        delivered: async () => {},
        failed: async () => {},
        answer: async () => {},
      },
      options: { session: sessionFile, sourceKey: "src-secret", hubUrl: "http://127.0.0.1:4350/" },
      log: () => {},
      signal: controller.signal,
    },
    { api, fetchImpl, wait: async () => {}, home },
  );

  assert.deepEqual(sentTexts, ["等待后续文字指令"]);
  assert.equal(emittedEvents.length, 1);
  assert.equal(emittedEvents[0]?.url, "http://127.0.0.1:4350/v1/events");
  assert.equal(emittedEvents[0]?.auth, "Bearer src-secret");
  assert.equal(emittedEvents[0]?.body.type, "wechat.message");
  assert.match(String(emittedEvents[0]?.body.detail), /图片/);
  assert.match(String(emittedEvents[0]?.body.detail), /帮我看这张截图/);
});
