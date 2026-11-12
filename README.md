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

## 同一个微信，三段会话

微信里始终是同一个聊天窗口。背后按事情分成三段 Cursor 会话，各记各的上下文。一句话进哪一段，只看这句话长什么样。

**日常。** 普通句子交给来源 `local` 的事件 `wechat.message`，由规则「微信对话」处理。从上一次开口算起 8 小时内的下一句接着同一个会话，你继续聊，这 8 小时就往后顺延；超过 8 小时，再开口就是新会话。新会话号要等这次成功跑完才算数。

**早上的巡检。** 定时规则自己新开一轮，只跑巡检。它不接收你后来在微信里打的字，也不受上面 8 小时的限制。

**拍板。** 整句刚好是一个序号，或整句以 `#编号 序号` 开头时，这句话回到发出这张卡的那一轮（例如架构师），卡片结束。`#` 后面是卡片上印出来的编号。序号后面可以写你的话，例如 `#12 2 超时只改测试环境`，选择和这句话一起送回那一轮。那一轮看不到日常闲聊。

拍板之后你再发的句子，回到日常。想就这件事多说几句，直接发句子即可，卡片继续开着。`2 超时只改测试环境` 这种平时也会说的句子一直是日常聊天，不会拍板。

图片、语音、文件、视频不单独开工。通道先回复「等待后续文字指令」，把种类、文件名、语音转写攒着；下一条文字到来时，说明和文字合成一条任务，交给日常会话。助手拿到的是这些说明。

别人发给这个 bot 的消息会被丢掉，只认扫码登录的那个微信号。

## 怎么回复

一张未决卡片长这样：

```text
#12 巡检待决策
要不要改这段超时。
1. 保持现状（推荐）
2. 按方案 B 改
回复规则：
只拍板：只开着这一张卡时，整句回 2。
拍板并补充：#12 2 后面写你的话。例如 #12 2 超时只改测试环境。编号就是本卡开头的 #12。
多张卡同时开着时，只拍板要整句写 #12 2，不能只回一个数字。
日常聊天：2 超时只改测试环境，以及其他句子。这张卡继续等你。
整句刚好是某个选项的原文，也会拍板。
```

每张待选择的卡片都会带上这段规则，例子里的编号和序号换成这张卡自己的。卡片在发出前就记在本机，所以卡片刚发出去、你正好回了数字，也会算这张卡的答案。

## 开发

```bash
npm test
```
