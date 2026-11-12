// WeChat ClawBot channel. A card goes out as text. Reply "2" or "#12 2" to answer.
// WeChat cannot edit a sent bubble, so a later version is a short follow-up.
import { readFileSync } from "node:fs";
import path from "node:path";
import { createClient } from "./src/api.ts";
import { parseAnswer, renderCard, splitText, type CardView } from "./src/card-text.ts";
import { composeTask, inboundMessage } from "./src/inbound.ts";
import { readSession, sessionPath, writeSession, type Held, type StoredSession } from "./src/session.ts";

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

type Card = CardView & { version: number; ref: string | null };
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
  await Promise.all([deliver(), receive()]);

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
      try {
        const body = card.ref && card.state !== "open" ? followUp(card) : renderCard(card);
        if (body) {
          for (const part of splitText(body)) {
            await api.sendText(session, session.userId, part, session.contextToken);
            await sleep(2_000, signal);
          }
        }
        await updateSession(file, (fresh) => {
          const open = new Map((fresh.open ?? []).map((item) => [item.id, item]));
          if (card.state === "open") open.set(card.id, { id: card.id, options: card.options });
          else open.delete(card.id);
          fresh.open = [...open.values()];
        });
        await hub.delivered(card.id, card.version, card.ref ?? `wechat-${card.id}`);
      } catch (error) {
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
        const open = new Map((session.open ?? []).map((item) => [item.id, item]));
        const held: Held[] = [...(session.pending ?? [])];
        const closed: number[] = [];
        const answers: { card: number; choice: number; by: string }[] = [];
        const tasks: { id: string; text: string; detail: string }[] = [];
        let waiting = false;
        let contextToken = session.contextToken;
        for (const message of page.messages) {
          const inbound = inboundMessage(message);
          if (!inbound || inbound.from !== session.userId) continue;
          if (inbound.contextToken) contextToken = inbound.contextToken;
          const parsed = inbound.text ? parseAnswer(inbound.text, [...open.values()]) : null;
          if (parsed?.choice !== undefined) {
            answers.push({ card: parsed.card, choice: parsed.choice, by: inbound.from });
            open.delete(parsed.card);
            closed.push(parsed.card);
            continue;
          }
          if (!inbound.text) {
            held.push(...inbound.media);
            waiting = true;
            continue;
          }
          waiting = false;
          tasks.push({ id: inbound.id, text: inbound.text, detail: composeTask(held.splice(0), inbound.text) });
        }
        for (const parsed of answers) {
          await hub.answer(parsed.card, { choice: parsed.choice, by: parsed.by, ref: `wechat-${parsed.card}` });
        }
        if (waiting) await api.sendText(session, session.userId, WAITING, contextToken);
        for (const task of tasks) await emit(task, options, log);
        await updateSession(file, (fresh) => {
          const stillOpen = new Map((fresh.open ?? []).map((item) => [item.id, item]));
          for (const id of closed) stillOpen.delete(id);
          fresh.open = [...stillOpen.values()];
          fresh.pending = held;
          if (contextToken) fresh.contextToken = contextToken;
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

async function emit(
  task: { id: string; text: string; detail: string },
  options: Record<string, unknown>,
  log: (line: string) => void,
) {
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
