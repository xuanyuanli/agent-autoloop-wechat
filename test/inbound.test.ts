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

test("composeTask includes saved local file paths, sizes, and download errors", () => {
  const detail = composeTask(
    [
      { kind: "图片", path: "/tmp/a.png", size: 2048 },
      { kind: "语音", note: "转写内容", path: "/tmp/b.silk", size: 512 },
      { kind: "文件", name: "x.log", error: "CDN 404" },
    ],
    "请一起分析",
  );
  assert.match(detail, /已保存到本机，可直接读取文件/);
  assert.match(detail, /- 图片 -> \/tmp\/a\.png（2\.0 KB）/);
  assert.match(detail, /- 语音：转写内容 -> \/tmp\/b\.silk（512 B）/);
  assert.match(detail, /- 文件 x\.log（下载失败：CDN 404）/);
  assert.match(detail, /请一起分析/);
});

test("quoted text and quoted media from ref_msg are preserved", () => {
  const quotedPic = { type: 2 };
  const resolved = new Map([[quotedPic, { path: "/tmp/quoted.png", size: 1024 }]]);
  const msg = inboundMessage(
    {
      message_id: 10,
      message_type: 1,
      from_user_id: "user-1",
      item_list: [
        { type: 1, text_item: { text: "改好了吗" }, ref_msg: { title: "上次报错" } },
        { type: 1, text_item: { text: "看图" }, ref_msg: { message_item: quotedPic } },
      ],
    },
    resolved,
  );
  assert.equal(msg?.text, "[引用: 上次报错]\n改好了吗\n看图");
  assert.deepEqual(msg?.media, [{ kind: "图片", note: "引用消息", path: "/tmp/quoted.png", size: 1024 }]);
});
