# agent-autoloop-wechat

把 [agent-autoloop](https://github.com/KKKKhazix/agent-autoloop) 的卡片发到微信 ClawBot（腾讯 iLink），并用聊天里的回复拍板。

这不是 DeepSeek Harness 插件。DSH 的 `dsh-channel-wechat` 只活在 Harness 会话里，也不能主动推送。这个通道自己持有一把 bot 登录，中台有卡片就发给扫码的那个微信号。

协议字段依据腾讯 [openclaw-weixin](https://github.com/Tencent/openclaw-weixin) 的公开说明（MIT）。登录凭证写在本机 `~/.agent-autoloop/wechat-session.json`，不进仓库。

## 安装

需要 Node.js 24 或更新，以及已经装好的 agent-autoloop。

```bash
agent-autoloop add https://github.com/xuanyuanli/agent-autoloop-wechat.git
node ~/.agent-autoloop/plugins/agent-autoloop-wechat/bin/login.ts
```

终端会打印二维码地址。用手机微信扫码并确认。

`rules.json`：

```json
"channels": { "wechat": { "name": "微信" } }
```

`config.json` 的 `channels`（`key` 用 `agent-autoloop key new channel wechat` 生成）：

```json
"wechat": { "use": "agent-autoloop-wechat", "key": "通道密钥" }
```

改完 `config.json` 后运行 `agent-autoloop service install`，让中台重新加载插件。

## 日常对话

文字消息会交给中台来源 `local` 的事件 `wechat.message`。配一条 `resume: true` 的规则，派给默认 Agent，就能接着上一轮 Cursor 会话。

图片、语音、文件、视频不会单独开工。通道先回复「等待后续文字指令」，把这些说明攒着；下一条文字到来时，说明和文字合成一条任务。

回复序号仍然只用于回答已经打开的卡片。普通句子不会被当成卡片答案。

## 怎么回复

一张未决卡片长这样：

```text
#12 巡检待决策
要不要改这段超时。
1. 保持现状（推荐）
2. 按方案 B 改
回复序号即可，例如 2。要指定卡片写 #编号 序号。
```

只有一张卡时，直接回 `2`。多张卡同时开着时，回 `#12 2`。序号之外的文字会当成自由回答。

别人发给这个 bot 的消息会被丢掉，只认扫码登录的那个微信号。

## 开发

```bash
npm test
```
