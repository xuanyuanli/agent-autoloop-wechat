import assert from "node:assert/strict";
import test from "node:test";
import type { WechatMessage } from "../src/api.ts";
import { applyPage, planMessages, trackDelivery } from "../src/page.ts";

const user = "user-1";

function text(id: string, body: string, from = user): WechatMessage {
  return { message_id: id, from_user_id: from, message_type: 1, item_list: [{ type: 1, text_item: { text: body } }], context_token: "ctx" };
}

function picture(id: string): WechatMessage {
  return { message_id: id, from_user_id: user, message_type: 1, item_list: [{ type: 2 }] };
}

const session = {
  userId: user,
  open: [{ id: 7, options: ["保持", "改"], ref: "wechat-7" }],
  pending: [] as { kind: string; name?: string; note?: string }[],
};

test("an answer keeps the rule of the card it closes", () => {
  const plan = planMessages(
    { ...session, open: [{ id: 7, options: ["保持", "改"], ref: "wechat-7", rule: "运维巡检架构师" }] },
    [text("m1", "2")],
  );
  assert.equal(plan.answers[0]?.rule, "运维巡检架构师");
});

test("a number answers the card that is open after the poll", () => {
  const plan = planMessages(session, [text("m1", "2")]);
  assert.deepEqual(plan.answers, [{ card: 7, choice: 1, by: user, ref: "wechat-7" }]);
  assert.equal(plan.tasks.length, 0);
  assert.deepEqual(plan.closed, [7]);
});

test("applyPage classifies the reloaded session, not an earlier snapshot", async () => {
  const answers: number[] = [];
  const plan = await applyPage(async () => session, [text("m1", "2")], {
    answer: async (item) => {
      answers.push(item.card);
    },
    sendWait: async () => {
      throw new Error("should not wait");
    },
    emit: async () => {
      throw new Error("should not emit");
    },
  });
  assert.deepEqual(answers, [7]);
  assert.equal(plan.tasks.length, 0);
});

test("a bare number with two open cards is a new task", () => {
  const plan = planMessages(
    { ...session, open: [{ id: 7, options: ["保持", "改"] }, { id: 8, options: ["是", "否"] }] },
    [text("m1", "1")],
  );
  assert.equal(plan.answers.length, 0);
  assert.equal(plan.tasks[0]?.text, "1");
});

test("a pointed reply can carry a note and does not start a chat", () => {
  const plan = planMessages(session, [text("m1", "#7 2 超时只改测试环境")]);
  assert.deepEqual(plan.answers, [{ card: 7, choice: 1, by: user, ref: "wechat-7", text: "超时只改测试环境" }]);
  assert.equal(plan.tasks.length, 0);
});

test("a number plus words is a chat task while the card stays open", () => {
  const plan = planMessages(session, [text("m1", "2 超时只改测试环境")]);
  assert.equal(plan.answers.length, 0);
  assert.equal(plan.closed.length, 0);
  assert.equal(plan.tasks[0]?.text, "2 超时只改测试环境");
});

test("a pointed reply answers that card", () => {
  const plan = planMessages(
    { ...session, open: [{ id: 7, options: ["保持", "改"], ref: "ref-7" }, { id: 8, options: ["是", "否"], ref: "ref-8" }] },
    [text("m1", "#8 2")],
  );
  assert.deepEqual(plan.answers, [{ card: 8, choice: 1, by: user, ref: "ref-8" }]);
});

test("an out-of-range number is a task", () => {
  const plan = planMessages(session, [text("m1", "9")]);
  assert.equal(plan.answers.length, 0);
  assert.equal(plan.tasks[0]?.text, "9");
});

test("a picture waits, and the following text takes the description with it", () => {
  const plan = planMessages(session, [picture("p1"), text("m1", "看一下这张")]);
  assert.equal(plan.waiting, false);
  assert.equal(plan.pending.length, 0);
  assert.equal(plan.tasks.length, 1);
  assert.match(plan.tasks[0].detail, /图片/);
  assert.match(plan.tasks[0].detail, /看一下这张/);
});

test("a picture alone asks for a text instruction and keeps the note", () => {
  const plan = planMessages({ ...session, open: [] }, [picture("p1")]);
  assert.equal(plan.waiting, true);
  assert.deepEqual(plan.pending, [{ kind: "图片" }]);
  assert.equal(plan.tasks.length, 0);
});

test("voice transcript and file name travel with the text", () => {
  const voice: WechatMessage = {
    message_id: "v1",
    from_user_id: user,
    item_list: [{ type: 3, voice_item: { text: "帮我看日志" } }, { type: 4, file_item: { file_name: "a.log" } }],
  };
  const plan = planMessages({ ...session, open: [], pending: [] }, [voice, text("m1", "就这个")]);
  assert.match(plan.tasks[0].detail, /语音：帮我看日志/);
  assert.match(plan.tasks[0].detail, /文件 a.log/);
});

test("a task detail stops at 4000 characters", () => {
  const plan = planMessages({ ...session, open: [] }, [text("m1", "字".repeat(5000))]);
  assert.equal([...plan.tasks[0].detail].length, 4000);
});

test("someone else's message is ignored", () => {
  const plan = planMessages(session, [text("m1", "2", "other")]);
  assert.equal(plan.answers.length, 0);
  assert.equal(plan.tasks.length, 0);
});

test("a failed emit does not return a plan to commit", async () => {
  await assert.rejects(
    () => applyPage(async () => ({ userId: user, open: [] }), [text("m1", "你好")], {
      answer: async () => {},
      sendWait: async () => {},
      emit: async () => {
        throw new Error("事件没交出去");
      },
    }),
    /事件没交出去/,
  );
});

test("a picture alone tells wechat to wait and does not start a task", async () => {
  let waited = 0;
  const plan = await applyPage(async () => ({ userId: user, open: [] }), [picture("p1")], {
    answer: async () => {},
    sendWait: async () => {
      waited += 1;
    },
    emit: async () => {
      throw new Error("should not emit");
    },
  });
  assert.equal(waited, 1);
  assert.equal(plan.tasks.length, 0);
  assert.equal(plan.pending[0]?.kind, "图片");
});

test("delivery records the card before the bubble exists, and a closed card leaves the set", () => {
  const open = trackDelivery([], { id: 7, state: "open", options: ["保持", "改"], ref: null });
  assert.deepEqual(open, [{ id: 7, options: ["保持", "改"], ref: "wechat-7" }]);
  assert.deepEqual(trackDelivery(open, { id: 7, state: "done", options: [], ref: "wechat-7" }), []);
});
