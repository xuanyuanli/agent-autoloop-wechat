import assert from "node:assert/strict";
import test from "node:test";
import { inboundText } from "../src/inbound.ts";

test("a user text message is kept", () => {
  assert.deepEqual(
    inboundText({
      message_type: 1,
      message_state: 2,
      from_user_id: "user-1",
      context_token: "ctx",
      item_list: [{ type: 1, text_item: { text: "2" } }],
    }),
    { from: "user-1", text: "2", contextToken: "ctx" },
  );
});

test("the bot's own message is ignored", () => {
  assert.equal(inboundText({ message_type: 2, from_user_id: "bot", item_list: [{ text_item: { text: "回声" } }] }), null);
});

test("a placeholder still being generated is ignored", () => {
  assert.equal(
    inboundText({ message_type: 1, message_state: 1, from_user_id: "user-1", item_list: [{ text_item: { text: "2" } }] }),
    null,
  );
});
