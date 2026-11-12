// What one page of WeChat updates means: card answers, a held attachment, or a task.
import type { WechatMessage } from "./api.ts";
import { parseAnswer } from "./card-text.ts";
import { composeTask, inboundMessage } from "./inbound.ts";
import type { Held, StoredSession } from "./session.ts";

export type OpenRef = { id: number; options: string[]; ref?: string };

export type PagePlan = {
  answers: { card: number; choice: number; by: string; ref: string; text?: string }[];
  waiting: boolean;
  tasks: { id: string; text: string; detail: string }[];
  pending: Held[];
  closed: number[];
  contextToken?: string;
};

type PageSession = Pick<StoredSession, "userId" | "open" | "pending" | "contextToken">;

/** Record a card before it is sent, so a reply in the same poll still matches it. */
export function trackDelivery(open: OpenRef[] | undefined, card: { id: number; state: string; options: string[]; ref: string | null }): OpenRef[] {
  const list = open ?? [];
  if (card.state === "open") {
    const ref = card.ref ?? `wechat-${card.id}`;
    return [...list.filter((item) => item.id !== card.id), { id: card.id, options: card.options, ref }];
  }
  return list.filter((item) => item.id !== card.id);
}

/** Classify messages against the session as it stands after the poll returned. */
export function planMessages(session: PageSession, messages: WechatMessage[]): PagePlan {
  const open = new Map((session.open ?? []).map((item) => [item.id, item]));
  const held: Held[] = [...(session.pending ?? [])];
  const answers: PagePlan["answers"] = [];
  const tasks: PagePlan["tasks"] = [];
  const closed: number[] = [];
  let contextToken = session.contextToken;
  let waiting = false;
  for (const raw of messages) {
    const inbound = inboundMessage(raw);
    if (!inbound || inbound.from !== session.userId) continue;
    if (inbound.contextToken) contextToken = inbound.contextToken;
    if (inbound.text) {
      const answer = parseAnswer(inbound.text, [...open.values()]);
      if (answer?.choice !== undefined) {
        const ref = open.get(answer.card)?.ref ?? `wechat-${answer.card}`;
        answers.push({ card: answer.card, choice: answer.choice, by: inbound.from, ref, ...(answer.text ? { text: answer.text } : {}) });
        open.delete(answer.card);
        closed.push(answer.card);
        if (inbound.media.length) {
          held.push(...inbound.media);
          waiting = true;
        } else {
          waiting = false;
        }
        continue;
      }
      waiting = false;
      held.push(...inbound.media);
      tasks.push({ id: inbound.id, text: inbound.text, detail: composeTask(held.splice(0), inbound.text) });
      continue;
    }
    held.push(...inbound.media);
    waiting = true;
  }
  return { answers, waiting, tasks, pending: held, closed, ...(contextToken ? { contextToken } : {}) };
}

export type PageIo = {
  answer: (item: PagePlan["answers"][number]) => Promise<void>;
  sendWait: (contextToken?: string) => Promise<void>;
  emit: (task: PagePlan["tasks"][number]) => Promise<void>;
};

/**
 * Reload, then answer, wait, and emit. A throw leaves the cursor uncommitted
 * so the same page can be classified again.
 */
export async function applyPage(load: () => Promise<PageSession>, messages: WechatMessage[], io: PageIo): Promise<PagePlan> {
  const plan = planMessages(await load(), messages);
  for (const item of plan.answers) await io.answer(item);
  if (plan.waiting) await io.sendWait(plan.contextToken);
  for (const task of plan.tasks) await io.emit(task);
  return plan;
}
