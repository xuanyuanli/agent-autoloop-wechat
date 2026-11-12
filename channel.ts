// WeChat ClawBot channel. A card goes out as text. Reply "2" or "#12 2" to answer.
// WeChat cannot edit a sent bubble, so a later version is a short follow-up.
import { createClient } from "./src/api.ts";
import { parseAnswer, renderCard, splitText, type CardView } from "./src/card-text.ts";
import { inboundText } from "./src/inbound.ts";
import { readSession, sessionPath, writeSession, type StoredSession } from "./src/session.ts";

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
        const pending: { card: number; choice?: number; text?: string; by: string }[] = [];
        await updateSession(file, (fresh) => {
          if (page.cursor) fresh.cursor = page.cursor;
          const open = new Map((fresh.open ?? []).map((item) => [item.id, item]));
          for (const message of page.messages) {
            const inbound = inboundText(message);
            if (!inbound || inbound.from !== fresh.userId) continue;
            if (inbound.contextToken) fresh.contextToken = inbound.contextToken;
            const parsed = parseAnswer(inbound.text, [...open.values()]);
            if (!parsed) {
              log(`微信消息不是在回答卡片：${inbound.text.slice(0, 80)}`);
              continue;
            }
            pending.push({ card: parsed.card, choice: parsed.choice, text: parsed.text, by: inbound.from });
            open.delete(parsed.card);
          }
          fresh.open = [...open.values()];
        });
        for (const parsed of pending) {
          await hub.answer(parsed.card, {
            ...(parsed.choice !== undefined ? { choice: parsed.choice } : { text: parsed.text }),
            by: parsed.by,
            ref: `wechat-${parsed.card}`,
          });
        }
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

function followUp(card: Card) {
  const chosen = card.choice === null ? card.answer : card.options[card.choice];
  if (card.state === "decided") return chosen ? `#${card.id} 已记录：你选了「${chosen}」。` : `#${card.id} 已记录。`;
  if (card.state === "done") return `#${card.id} 已执行${card.result ? `：${card.result}` : "。"}`;
  if (card.state === "closed" && card.result) return `#${card.id} ${card.result}`;
  return "";
}
