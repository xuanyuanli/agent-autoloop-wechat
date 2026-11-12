import assert from "node:assert/strict";
import test from "node:test";
import { parseAnswer, renderCard, splitText, waitingForChoice } from "../src/card-text.ts";

test("an open ask lists options and marks the recommendation", () => {
  const text = renderCard({
    id: 3,
    kind: "ask",
    state: "open",
    title: "选一个颜色",
    text: "选哪个都行。",
    options: ["蓝色", "绿色"],
    recommend: 1,
    choice: null,
    answer: null,
    result: null,
  });
  assert.equal(text.startsWith("**选一个颜色**\n\n选哪个都行。"), true);
  assert.equal(text.startsWith("#"), false);
  assert.match(text, /2\. 绿色（推荐）/);
  assert.match(text, /---\n\n\*\*怎么回复\*\*/);
  assert.match(text, /纯数字：`1`/);
  assert.match(text, /`#3 2`/);
  assert.match(text, /`#3 2 超时只改测试环境`/);
});

test("a recorded choice says the background task is still running", () => {
  const card = {
    id: 8,
    kind: "ask" as const,
    state: "decided" as const,
    title: "选一个颜色",
    text: "选一个就行。",
    options: ["蓝色", "绿色"],
    recommend: 0,
    choice: 1,
    answer: null,
    result: null,
  };
  assert.equal(waitingForChoice(card), "你选了「绿色」，后台任务执行中，请等待");
  assert.match(renderCard(card), /你选了「绿色」，后台任务执行中，请等待/);
});

test("a plain reply has no card number and no label", () => {
  const notice = {
    id: 5,
    kind: "notice" as const,
    state: "closed" as const,
    title: "微信对话",
    text: "我是这边的助手。",
    options: [],
    recommend: null,
    choice: null,
    answer: null,
    result: null,
    rule: "微信对话",
  };
  assert.equal(renderCard(notice), "我是这边的助手。");
  assert.equal(renderCard({ ...notice, id: 4, title: "回复", rule: undefined }), "");
});

test("a report notice keeps its headline and drops the number", () => {
  const text = renderCard({
    id: 8,
    kind: "notice",
    state: "closed",
    title: "今天没有新的严重错误",
    text: "结果表在下面。",
    options: [],
    recommend: null,
    choice: null,
    answer: null,
    result: null,
    rule: "定时日报",
  });
  assert.equal(text, "**今天没有新的严重错误**\n\n结果表在下面。");
  assert.equal(text.includes("#"), false);
});

test("a bare number answers the only open card", () => {
  assert.deepEqual(parseAnswer("2", [{ id: 3, options: ["蓝色", "绿色"] }]), { card: 3, choice: 1 });
});

test("several open cards need an explicit id", () => {
  const open = [
    { id: 3, options: ["蓝色", "绿色"] },
    { id: 4, options: ["已处理"] },
  ];
  assert.equal(parseAnswer("1", open), null);
  assert.deepEqual(parseAnswer("#4 1", open), { card: 4, choice: 0 });
});

test("a sentence is not a card answer", () => {
  assert.equal(parseAnswer("先不改代码", [{ id: 8, options: ["改", "不改"] }]), null);
});

test("words after a bare number stay a chat message", () => {
  assert.equal(parseAnswer("2 超时只改测试环境", [{ id: 1, options: ["保持", "改"] }]), null);
});

test("a card id can carry the choice and a note", () => {
  const open = [{ id: 1, options: ["保持", "改"] }];
  assert.deepEqual(parseAnswer("#1 2 超时只改测试环境", open), { card: 1, choice: 1, text: "超时只改测试环境" });
  assert.deepEqual(parseAnswer("#1 2", open), { card: 1, choice: 1 });
});

test("a note is kept to 4000 characters", () => {
  const note = "字".repeat(4001);
  const parsed = parseAnswer(`#1 2 ${note}`, [{ id: 1, options: ["保持", "改"] }]);
  assert.equal([...(parsed?.text ?? "")].length, 4000);
});

test("long text breaks on a paragraph", () => {
  const parts = splitText(`${"甲".repeat(100)}\n\n${"乙".repeat(1800)}`, 200);
  assert.equal(parts[0], "甲".repeat(100));
  assert.ok(parts[1].startsWith("乙"));
});
