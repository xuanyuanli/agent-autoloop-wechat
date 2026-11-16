// What one page of WeChat updates means: card answers, a held attachment, or a task.
import type { WechatMessage, WechatMessageItem } from "./api.ts";
import { parseAnswer } from "./card-text.ts";
import { inboundMessage } from "./inbound.ts";
import { composeTask } from "./inbound.ts";
import { isKeepaliveReply } from "./keepalive.ts";
import type { MediaResult } from "./media.ts";
import type { Held, StoredSession } from "./session.ts";

export type OpenRef = { id: number; options: string[]; ref?: string; rule?: string };

export type PagePlan = {
  answers: { card: number; choice: number; by: string; ref: string; text?: string; rule?: string }[];
  waiting: boolean;
  keepaliveAck: boolean;
  inbound: boolean;
  tasks: { id: string; text: string; detail: string }[];
  pending: Held[];
  closed: number[];
  contextToken?: string;
};

type PageSession = Pick<
  StoredSession,
  "userId" | "open" | "pending" | "contextToken" | "lastInboundAt" | "keepaliveNudgedAt"
>;

/** Record a card before it is sent, so a reply in the same poll still matches it. */
export function trackDelivery(
  open: OpenRef[] | undefined,
  card: { id: number; state: string; options: string[]; ref: string | null; rule?: string | null },
): OpenRef[] {
  const list = open ?? [];
  if (card.state === "open") {
    const ref = card.ref ?? `wechat-${card.id}`;
    return [...list.filter((item) => item.id !== card.id), { id: card.id, options: card.options, ref, ...(card.rule ? { rule: card.rule } : {}) }];
  }
  return list.filter((item) => item.id !== card.id);
}

/** Classify messages against the session as it stands after the poll returned. */
export function planMessages(
  session: PageSession,
  messages: WechatMessage[],
  resolved?: ReadonlyMap<WechatMessageItem, MediaResult>,
): PagePlan {
  const open = new Map((session.open ?? []).map((item) => [item.id, item]));
  const held: Held[] = [...(session.pending ?? [])];
  const answers: PagePlan["answers"] = [];
  const tasks: PagePlan["tasks"] = [];
  const closed: number[] = [];
  let contextToken = session.contextToken;
  let waiting = false;
  let keepaliveAck = false;
  let inboundSeen = false;
  let nudgedActive = Boolean(
    session.keepaliveNudgedAt && (!session.lastInboundAt || session.keepaliveNudgedAt >= session.lastInboundAt),
  );
  for (const raw of messages) {
    const inbound = inboundMessage(raw, resolved);
    if (!inbound || inbound.from !== session.userId) continue;
    inboundSeen = true;
    if (inbound.contextToken) contextToken = inbound.contextToken;
    if (inbound.text) {
      const answer = parseAnswer(inbound.text, [...open.values()]);
      if (answer?.choice !== undefined) {
        const found = open.get(answer.card);
        const ref = found?.ref ?? `wechat-${answer.card}`;
        answers.push({
          card: answer.card,
          choice: answer.choice,
          by: inbound.from,
          ref,
          ...(answer.text ? { text: answer.text } : {}),
          ...(found?.rule ? { rule: found.rule } : {}),
        });
        open.delete(answer.card);
        closed.push(answer.card);
        keepaliveAck = false;
        nudgedActive = false;
        if (inbound.media.length) {
          held.push(...inbound.media);
          waiting = true;
        } else {
          waiting = false;
        }
        continue;
      }
      if (!held.length && !inbound.media.length && isKeepaliveReply(inbound.text, nudgedActive)) {
        waiting = false;
        keepaliveAck = true;
        nudgedActive = false;
        continue;
      }
      waiting = false;
      keepaliveAck = false;
      nudgedActive = false;
      held.push(...inbound.media);
      tasks.push({ id: inbound.id, text: inbound.text, detail: composeTask(held.splice(0), inbound.text) });
      continue;
    }
    held.push(...inbound.media);
    waiting = true;
    keepaliveAck = false;
    nudgedActive = false;
  }
  return {
    answers,
    waiting,
    keepaliveAck: keepaliveAck && !tasks.length && !answers.length && !waiting,
    inbound: inboundSeen,
    tasks,
    pending: held,
    closed,
    ...(contextToken ? { contextToken } : {}),
  };
}

export type PageIo = {
  answer: (item: PagePlan["answers"][number], contextToken?: string) => Promise<void>;
  sendWait: (contextToken?: string) => Promise<void>;
  sendKeepaliveAck?: (contextToken?: string) => Promise<void>;
  emit: (task: PagePlan["tasks"][number], contextToken?: string) => Promise<void>;
};

/**
 * Reload, then answer, wait, and emit. A throw leaves the cursor uncommitted
 * so the same page can be classified again.
 */
export async function applyPage(
  load: () => Promise<PageSession>,
  messages: WechatMessage[],
  io: PageIo,
  resolved?: ReadonlyMap<WechatMessageItem, MediaResult>,
): Promise<PagePlan> {
  const plan = planMessages(await load(), messages, resolved);
  for (const item of plan.answers) await io.answer(item, plan.contextToken);
  if (plan.waiting) await io.sendWait(plan.contextToken);
  if (plan.keepaliveAck) await io.sendKeepaliveAck?.(plan.contextToken);
  for (const task of plan.tasks) await io.emit(task, plan.contextToken);
  return plan;
}
