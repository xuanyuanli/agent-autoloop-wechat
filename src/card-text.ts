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
    lines.push("回复序号即可，例如 2。要指定卡片写 #编号 序号。");
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

/**
 * A bare number answers the only open card. `#id n` picks one of several.
 * Anything else, when exactly one ask is open, is a free-text answer.
 */
export function parseAnswer(text: string, open: OpenCard[]): ParsedAnswer | null {
  const words = text.trim();
  if (!words || !open.length) return null;
  const pointed = /^#(\d+)\s+(\d+)$/.exec(words);
  if (pointed) {
    const card = Number(pointed[1]);
    const found = open.find((item) => item.id === card);
    const choice = Number(pointed[2]) - 1;
    if (!found || choice < 0 || choice >= found.options.length) return null;
    return { card, choice };
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
  return { card: only.id, text: words };
}
