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

type Spoken = CardView & { rule?: string | null };

/** A choice states the question first. The card number appears only where a reply needs it. */
export function renderCard(card: Spoken) {
  if (card.kind === "ask" && card.state === "open" && card.options.length) return renderAsk(card);
  if (card.kind === "notice" && card.title.trim() === "回复") return "";
  const spoken = spokenText(card);
  const outcome = outcomeOf(card);
  return [spoken, outcome].filter(Boolean).join("\n");
}

function spokenText(card: Spoken) {
  const title = card.title.trim();
  const text = card.text.trim();
  const hidden = !title || title === "回复" || (card.rule != null && title === card.rule);
  if (text && (hidden || text.startsWith(title))) return text;
  if (title && text) return `**${title.replace(/^\*\*|\*\*$/g, "")}**\n\n${text}`;
  return text || title;
}

function outcomeOf(card: CardView) {
  if (card.state === "decided") return waitingForChoice(card);
  if (card.state === "done") return `已执行${card.result ? `：${card.result}` : "。"}`;
  if (card.state === "closed" && card.result) return card.result;
  return "";
}

/** The line sent the moment a choice is recorded, while the follow-up run is still going. */
export function waitingForChoice(card: CardView) {
  const chosen = card.choice === null ? card.answer : card.options[card.choice];
  return chosen ? `你选了「${chosen}」，后台任务执行中，请等待` : "后台任务执行中，请等待";
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

/** Choice card in Markdown. The reply lines are the three forms the channel actually accepts. */
function renderAsk(card: CardView) {
  const example = Math.min(2, card.options.length);
  const options = card.options.map(
    (option, index) => `${index + 1}. ${option}${index === card.recommend ? "（推荐）" : ""}`,
  );
  const forms = [
    "- 纯数字：`1`",
    `- \`#${card.id} ${example}\``,
    `- \`#${card.id} ${example} 超时只改测试环境\``,
  ];
  return [
    `**${card.title.trim()}**`,
    card.text.trim(),
    options.join("\n"),
    "---",
    "**怎么回复**",
    forms.join("\n"),
    "纯数字只在只开着这一张时有效。整句刚好是某个选项的原文也可以。",
    "`2 超时只改测试环境` 这种没有 # 的，是聊天，这张卡还留着。",
  ]
    .filter(Boolean)
    .join("\n\n");
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
