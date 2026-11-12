export type OpenCard = { id: number; options: string[] };

export type CardView = {
  id: number;
  kind: "ask" | "notice";
  state: "open" | "decided" | "done" | "closed";
  title: string;
  text: string;
  options: string[];
  recommend: number | null;
  choice: number | null;
  answer: string | null;
  result: string | null;
};

const LIMIT = 1800;

export function renderCard(card: CardView) {
  const lines = [`#${card.id} ${card.title}`];
  if (card.text) lines.push(card.text);
  if (card.state === "open" && card.options.length) {
    card.options.forEach((option, index) => {
      lines.push(`${index + 1}. ${option}${index === card.recommend ? "（推荐）" : ""}`);
    });
    lines.push(replyRules(card));
  } else {
    const outcome = outcomeOf(card);
    if (outcome) lines.push(outcome);
  }
  return lines.join("\n");
}

function outcomeOf(card: CardView) {
  const chosen = card.choice === null ? card.answer : card.options[card.choice];
  if (card.state === "decided") return chosen ? `已记录：你选了「${chosen}」。` : "已记录。";
  if (card.state === "done") return `已执行${card.result ? `：${card.result}` : "。"}`;
  if (card.state === "closed" && card.result) return card.result;
  return "";
}

/** Split on paragraph boundaries so one WeChat bubble stays under the transport limit. */
export function splitText(text: string, limit = LIMIT) {
  if (text.length <= limit) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const paragraph = window.lastIndexOf("\n\n");
    const line = window.lastIndexOf("\n");
    const cut = paragraph > limit / 4 ? paragraph : line > limit / 4 ? line : limit;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

export type ParsedAnswer = { card: number; choice?: number; text?: string };

const ANSWER_TEXT = 4000;

/** Printed on every open choice so the reply rules travel with the card. */
function replyRules(card: CardView) {
  const n = (card.recommend ?? 0) + 1;
  const id = card.id;
  return [
    "回复规则：",
    `只拍板：只开着这一张卡时，整句回 ${n}。`,
    `拍板并补充：#${id} ${n} 后面写你的话。例如 #${id} ${n} 超时只改测试环境。编号就是本卡开头的 #${id}。`,
    `多张卡同时开着时，只拍板要整句写 #${id} ${n}，不能只回一个数字。`,
    "日常聊天：2 超时只改测试环境，以及其他句子。这张卡继续等你。",
    "整句刚好是某个选项的原文，也会拍板。",
  ].join("\n");
}

/**
 * A bare number, the option's own words, or `#id n` plus optional words answers a card.
 * A number followed by words, and any other sentence, is a new instruction.
 */
export function parseAnswer(text: string, open: OpenCard[]): ParsedAnswer | null {
  const words = text.trim();
  if (!words || !open.length) return null;
  const pointed = /^#(\d+)\s+(\d+)(?:\s+([\s\S]+))?$/.exec(words);
  if (pointed) {
    const card = Number(pointed[1]);
    const found = open.find((item) => item.id === card);
    const choice = Number(pointed[2]) - 1;
    const note = pointed[3]?.trim();
    if (!found || choice < 0 || choice >= found.options.length) return null;
    return { card, choice, ...(note ? { text: [...note].slice(0, ANSWER_TEXT).join("") } : {}) };
  }
  if (open.length !== 1) return null;
  const only = open[0];
  if (/^\d+$/.test(words)) {
    const choice = Number(words) - 1;
    if (choice < 0 || choice >= only.options.length) return null;
    return { card: only.id, choice };
  }
  const matched = only.options.findIndex((option) => option === words);
  if (matched >= 0) return { card: only.id, choice: matched };
  return null;
}
