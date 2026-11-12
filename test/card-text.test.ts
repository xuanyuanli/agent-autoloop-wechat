import assert from "node:assert/strict";
import test from "node:test";
import { parseAnswer, renderCard, splitText } from "../src/card-text.ts";

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
  assert.match(text, /#3 选一个颜色/);
  assert.match(text, /2\. 绿色（推荐）/);
  assert.match(text, /回复规则/);
  assert.match(text, /#3 2 超时只改测试环境/);
  assert.match(text, /2 超时只改测试环境，以及其他句子/);
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
