import assert from "node:assert/strict";
import test from "node:test";
import { composeTask, inboundMessage } from "../src/inbound.ts";

test("a user text message is kept", () => {
  assert.deepEqual(
    inboundMessage({
      message_id: 9,
      message_type: 1,
      message_state: 2,
      from_user_id: "user-1",
      context_token: "ctx",
      item_list: [{ type: 1, text_item: { text: "看一下昨天的报错" } }],
    }),
    { id: "wx-9", from: "user-1", text: "看一下昨天的报错", media: [], contextToken: "ctx" },
  );
});

test("the bot's own message is ignored", () => {
  assert.equal(inboundMessage({ message_type: 2, from_user_id: "bot", item_list: [{ text_item: { text: "回声" } }] }), null);
});

test("a picture is held until a later text instruction", () => {
  const picture = inboundMessage({
    message_id: 3,
    message_type: 1,
    from_user_id: "user-1",
    item_list: [{ type: 2 }],
  });
  assert.equal(picture?.text, "");
  assert.deepEqual(picture?.media, [{ kind: "图片" }]);
  assert.match(composeTask(picture?.media ?? [], "按这张图改标题"), /图片/);
  assert.match(composeTask(picture?.media ?? [], "按这张图改标题"), /按这张图改标题/);
});

test("a placeholder still being generated is ignored", () => {
  assert.equal(
    inboundMessage({ message_type: 1, message_state: 1, from_user_id: "user-1", item_list: [{ text_item: { text: "2" } }] }),
    null,
  );
});
