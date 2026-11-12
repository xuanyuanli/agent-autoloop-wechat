// WeChat ClawBot channel. A card goes out as text. Reply "2" or "#12 2" to answer.
// WeChat cannot edit a sent bubble, so a later version is a short follow-up.
import { readFileSync } from "node:fs";
import path from "node:path";
import { createClient } from "./src/api.ts";
import { renderCard, splitText, type CardView } from "./src/card-text.ts";
import { CHAT_RULE } from "./src/chat-session.ts";
import { applyPage, trackDelivery } from "./src/page.ts";
import { readSession, sessionPath, writeSession, type StoredSession } from "./src/session.ts";
import { finishLease, leaseExpired, startLease, TICKET_TTL_MS, TYPING_INTERVAL_MS, type TypingLease } from "./src/typing.ts";

const WAITING = "等待后续文字指令";

let writing: Promise<void> = Promise.resolve();
function updateSession(file: string, change: (session: StoredSession) => void) {
  const run = writing.then(async () => {
    const session = readSession(file);
    if (!session) return;
    change(session);
    writeSession(file, session);
  });
  writing = run.then(() => undefined, () => undefined);
  return run;
}

type Card = CardView & { version: number; ref: string | null; rule?: string | null };
type Context = {
  hub: {
    nextCard(wait: number): Promise<{ card: Card | null }>;
    delivered(card: number, version: number, ref: string | null): Promise<unknown>;
    failed(card: number, version: number, error: string): Promise<unknown>;
    answer(card: number, body: { choice?: number; text?: string; by?: string; ref?: string }): Promise<unknown>;
  };
  options: Record<string, unknown>;
  log: (line: string) => void;
  signal: AbortSignal;
};

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    const stop = () => {
      clearTimeout(timer);
      resolve(undefined);
    };
    signal.addEventListener("abort", stop, { once: true });
  });

export default async function wechat({ hub, options, log, signal }: Context) {
  const file = typeof options.session === "string" ? options.session : sessionPath();
  const api = createClient();
  const typing = createTyping();
  signal.addEventListener("abort", () => void typing.hide(), { once: true });
  await Promise.all([deliver(), receive()]);

  /** 「对方正在输入」. Failures stay here and never fail the message itself. */
  function createTyping() {
    let lease: TypingLease | null = null;
    let ticket: { value: string; at: number } | null = null;
    let chain: Promise<void> = Promise.resolve();
    let timer: NodeJS.Timeout | null = null;
    let problem = "";
    let token: string | undefined;

    function remember(rule: string, contextToken?: string) {
      if (contextToken) token = contextToken;
      const starting = !lease;
      lease = startLease(lease, rule, Date.now(), contextToken);
      if (starting) void show(1);
      if (!timer) {
        timer = setInterval(() => void keepalive(), TYPING_INTERVAL_MS);
        timer.unref?.();
      }
    }

    function settle(rule: string | null | undefined) {
      if (!rule || !lease?.rules.includes(rule)) return;
      lease = finishLease(lease, rule);
      if (!lease) void hide();
    }

    async function keepalive() {
      if (!lease) return;
      if (leaseExpired(lease, Date.now())) {
        lease = null;
        await hide();
        return;
      }
      await show(1);
    }

    async function show(status: 1 | 2) {
      const run = chain.then(() => push(status));
      chain = run.then(() => undefined, () => undefined);
      await run;
    }

    async function hide() {
      if (timer) clearInterval(timer);
      timer = null;
      await show(2);
    }

    async function push(status: 1 | 2) {
      const session = await load();
      if (!session) return;
      try {
        const value = await currentTicket(session, false);
        if (!value) return;
        await api.sendTyping(session, value, status);
        problem = "";
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("-2")) return;
        try {
          const value = await currentTicket(session, true);
          if (!value) return;
          await api.sendTyping(session, value, status);
          problem = "";
        } catch (again) {
          const text = again instanceof Error ? again.message : String(again);
          if (text !== problem) {
            problem = text;
            log(`输入状态没亮起来：${text}`);
          }
        }
      }
    }

    async function currentTicket(session: StoredSession, force: boolean) {
      const hold = ticket?.value ? TICKET_TTL_MS : 60_000;
      if (!force && ticket && Date.now() - ticket.at < hold) return ticket.value;
      const value = await api.typingTicket(session, token ?? session.contextToken);
      ticket = { value, at: Date.now() };
      if (!value) note("没有拿到 typing_ticket");
      return value;
    }

    function note(text: string) {
      if (text === problem) return;
      problem = text;
      log(`输入状态没亮起来：${text}`);
    }

    return {
      remember,
      settle,
      hide,
      async flash(contextToken?: string) {
        if (lease) return;
        if (contextToken) token = contextToken;
        await show(1);
        return async () => {
          if (!lease) await hide();
        };
      },
      expects(rule: string) {
        return Boolean(lease?.rules.includes(rule));
      },
    };
  }

  async function load(): Promise<StoredSession | null> {
    return readSession(file);
  }

  async function deliver() {
    while (!signal.aborted) {
      let card: Card | null;
      try {
        ({ card } = await hub.nextCard(30));
      } catch (error) {
        if (signal.aborted) return;
        log(`领卡片失败：${error instanceof Error ? error.message : error}`);
        await sleep(10_000, signal);
        continue;
      }
      if (!card) continue;
      const session = await load();
      if (!session) {
        log(`微信还没登录。在插件目录运行 node bin/login.ts，会话写到 ${file}`);
        await hub.failed(card.id, card.version, "微信未登录").catch(() => {});
        await sleep(15_000, signal);
        continue;
      }
      const before = (await load())?.open ?? [];
      const added = card.state === "open" && !before.some((item) => item.id === card.id);
      let sent = false;
      try {
        await updateSession(file, (fresh) => {
          fresh.open = trackDelivery(fresh.open, card);
        });
        const body = card.ref && card.state !== "open" ? followUp(card) : renderCard(card);
        if (body) {
          try {
            for (const part of splitText(body)) {
              await api.sendText(session, session.userId, part, session.contextToken);
              await sleep(2_000, signal);
            }
            sent = true;
          } catch (error) {
            if (added) {
              await updateSession(file, (fresh) => {
                fresh.open = (fresh.open ?? []).filter((item) => item.id !== card.id);
              }).catch(() => {});
            }
            throw error;
          }
        }
        await hub.delivered(card.id, card.version, card.ref ?? `wechat-${card.id}`);
        if (sent) typing.settle(card.rule);
      } catch (error) {
        typing.settle(card.rule);
        const message = error instanceof Error ? error.message : String(error);
        log(`卡片 ${card.id} 没发出去：${message}`);
        await hub.failed(card.id, card.version, message).catch(() => {});
      }
    }
  }

  async function receive() {
    while (!signal.aborted) {
      const session = await load();
      if (!session) {
        await sleep(15_000, signal);
        continue;
      }
      try {
        const page = await api.getUpdates(session, signal);
        const plan = await applyPage(async () => (await load()) ?? session, page.messages, {
          answer: async (item, contextToken) => {
            await hub.answer(item.card, { choice: item.choice, by: item.by, ref: item.ref, ...(item.text ? { text: item.text } : {}) });
            if (item.rule) typing.remember(item.rule, contextToken);
          },
          sendWait: async (contextToken) => {
            const done = await typing.flash(contextToken);
            try {
              await api.sendText(session, session.userId, WAITING, contextToken);
            } finally {
              await done?.();
            }
          },
          emit: async (task, contextToken) => {
            const first = !typing.expects(CHAT_RULE);
            typing.remember(CHAT_RULE, contextToken);
            try {
              await emit(task, options);
            } catch (error) {
              if (first) typing.settle(CHAT_RULE);
              throw error;
            }
          },
        });
        await updateSession(file, (fresh) => {
          const stillOpen = new Map((fresh.open ?? []).map((item) => [item.id, item]));
          for (const id of plan.closed) stillOpen.delete(id);
          fresh.open = [...stillOpen.values()];
          if (plan.pending.length) fresh.pending = plan.pending;
          else delete fresh.pending;
          if (plan.contextToken) fresh.contextToken = plan.contextToken;
          if (page.cursor) fresh.cursor = page.cursor;
        });
      } catch (error) {
        if (signal.aborted) return;
        const message = error instanceof Error ? error.message : String(error);
        const pause = message.includes("-14") ? 60_000 : 5_000;
        log(message.includes("-14") ? "微信登录可能失效，请重新运行 node bin/login.ts" : `收消息中断：${message}`);
        await sleep(pause, signal);
      }
    }
  }
}

async function emit(task: { id: string; text: string; detail: string }, options: Record<string, unknown>) {
  const source = sourceCredentials(options);
  if (!source) throw new Error("本机 config.json 里没有来源密钥");
  const base = (process.env.AGENT_AUTOLOOP_PUBLIC_URL || "http://127.0.0.1:3350").replace(/\/$/, "");
  const response = await fetch(`${base}/v1/events`, {
    method: "POST",
    headers: { authorization: `Bearer ${source}`, "content-type": "application/json" },
    body: JSON.stringify({
      id: task.id,
      type: "wechat.message",
      summary: [...task.text].slice(0, 200).join(""),
      detail: task.detail,
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`事件没交出去：${response.status} ${text.slice(0, 200)}`);
  }
}

function sourceCredentials(options: Record<string, unknown>) {
  if (typeof options.sourceKey === "string" && options.sourceKey) return options.sourceKey;
  try {
    const home = process.env.AGENT_AUTOLOOP_HOME || path.join(process.env.USERPROFILE || process.env.HOME || "", ".agent-autoloop");
    const config = JSON.parse(readFileSync(path.join(home, "config.json"), "utf8")) as { source?: { key?: string } };
    return config.source?.key || "";
  } catch {
    return "";
  }
}

function followUp(card: Card) {
  const chosen = card.choice === null ? card.answer : card.options[card.choice];
  if (card.state === "decided") return chosen ? `#${card.id} 已记录：你选了「${chosen}」。` : `#${card.id} 已记录。`;
  if (card.state === "done") return `#${card.id} 已执行${card.result ? `：${card.result}` : "。"}`;
  if (card.state === "closed" && card.result) return `#${card.id} ${card.result}`;
  return "";
}
