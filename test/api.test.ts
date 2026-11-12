import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { BOT_AGENT, CHANNEL_VERSION, createClient, type Session } from "../src/api.ts";

const session: Session = {
  token: "token",
  baseUrl: "https://ilink.example/",
  botId: "bot",
  userId: "user-1",
  cursor: "cur",
};

function client(handler: (url: string, body: string) => string) {
  const calls: { url: string; body: string }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const body = typeof init?.body === "string" ? init.body : "";
    calls.push({ url, body });
    return new Response(handler(url, body), { status: 200 });
  };
  return { calls, api: createClient(fetchImpl, async () => {}) };
}

test("CHANNEL_VERSION and BOT_AGENT stay aligned with package.json version", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  assert.equal(CHANNEL_VERSION, `3.0.1/agent-autoloop-wechat-${pkg.version}`);
  assert.equal(BOT_AGENT, `agent-autoloop-wechat/${pkg.version}`);
});

test("getUpdates treats errcode as a failure even when ret is 0", async () => {
  const { api } = client(() => JSON.stringify({ ret: 0, errcode: -14, errmsg: "session" }));
  await assert.rejects(() => api.getUpdates(session), /getupdates -14/);
});

test("an empty updates body is an empty page", async () => {
  const { api } = client(() => "");
  assert.deepEqual(await api.getUpdates(session), { messages: [], cursor: undefined });
});

test("a rate limit is retried and then the text is sent", async () => {
  let attempts = 0;
  const { api } = client(() => {
    attempts += 1;
    return attempts === 1 ? JSON.stringify({ errcode: -2 }) : JSON.stringify({ ret: 0 });
  });
  await api.sendText(session, "user-1", "你好");
  assert.equal(attempts, 2);
});

test("typing uses the ticket from getconfig and does not retry a rate limit", async () => {
  const { api, calls } = client((url) => {
    if (url.includes("getconfig")) return JSON.stringify({ ret: 0, typing_ticket: "ticket-1" });
    return JSON.stringify({ errcode: -2 });
  });
  assert.equal(await api.typingTicket(session, "ctx"), "ticket-1");
  await assert.rejects(() => api.sendTyping(session, "ticket-1", 1), /sendtyping -2/);
  const typing = calls.find((call) => call.url.includes("sendtyping"));
  const body = JSON.parse(typing?.body ?? "{}") as { status?: number; typing_ticket?: string; ilink_user_id?: string };
  assert.equal(body.status, 1);
  assert.equal(body.typing_ticket, "ticket-1");
  assert.equal(body.ilink_user_id, "user-1");
  assert.equal(calls.filter((call) => call.url.includes("sendtyping")).length, 1);
});

test("a paused context token is sent once more without it", async () => {
  const { api, calls } = client((_url, body) => {
    const parsed = JSON.parse(body) as { msg?: { context_token?: string } };
    return parsed.msg?.context_token ? JSON.stringify({ ret: 0, errcode: -14 }) : JSON.stringify({ ret: 0 });
  });
  await api.sendText(session, "user-1", "你好", "ctx");
  assert.equal(calls.length, 2);
  assert.equal(JSON.parse(calls[1].body).msg.context_token, undefined);
});
