# agent-autoloop-wechat

把 [agent-autoloop](https://github.com/KKKKhazix/agent-autoloop) 的卡片发到微信 ClawBot（腾讯 iLink），在微信里回复序号拍板，或直接发消息交给 Agent 对话。

这不是 DeepSeek Harness 插件。DSH 的 `dsh-channel-wechat` 只活在 Harness 会话里，也不能主动推送。这个通道自己持有一把 bot 登录，中台有卡片就发给扫码的那个微信号。

同一个仓库包含两个零依赖插件入口：

- `channel.ts`：微信通道（收发文本卡片、按序号拍板、「对方正在输入」状态、媒体暂存合并、日常消息转 `wechat.message` 事件）。
- `agent.ts`：Cursor CLI Agent（自动按 8 小时闲置窗口续接或重开「微信对话」会话，并为其它规则注入适合微信阅读的 Markdown 回执提示）。如果你只用 Claude Code / Codex 等内置 Agent，也可以只启用 `channel.ts`。

协议字段依据腾讯 [openclaw-weixin](https://github.com/Tencent/openclaw-weixin) 的公开说明（MIT）。登录凭证写在本机 `~/.agent-autoloop/wechat-session.json`，不进仓库。

## 安装与登录

需要 **Node.js 24** 或更新版本，以及已经装好的 `agent-autoloop`。

```bash
agent-autoloop add https://github.com/xuanyuanli/agent-autoloop-wechat.git
```

接着运行扫码登录脚本（macOS / Linux）：

```bash
node ~/.agent-autoloop/plugins/agent-autoloop-wechat/bin/login.ts
```

Windows PowerShell：

```powershell
node "$HOME\.agent-autoloop\plugins\agent-autoloop-wechat\bin\login.ts"
```

终端会打印二维码链接。用手机微信打开扫码并确认，成功后终端会输出会话保存位置与你的微信标识（`ilink_user_id`，下面配 `answerers` 时用到）。

## 配置

### 1. 生成密钥并写入 `config.json`

生成通道密钥与本机来源密钥（如果在微信里发普通句子触发「微信对话」，通道会用 `source.key` 向中台投递 `wechat.message` 事件）：

```bash
agent-autoloop key new channel wechat
agent-autoloop key new source local
```

在 `~/.agent-autoloop/config.json` 中填入：

```json
{
  "source": {
    "key": "刚才生成的 local 来源密钥"
  },
  "channels": {
    "wechat": {
      "use": "agent-autoloop-wechat",
      "key": "刚才生成的 wechat 通道密钥"
    }
  }
}
```

可选通道参数（写在 `config.json` 的 `channels.wechat` 里）：

- `session`：自定义会话文件路径（默认 `~/.agent-autoloop/wechat-session.json`）。
- `sourceKey`：单独指定投递事件用的来源密钥（默认读取 `config.json` 顶层的 `source.key`）。
- `hubUrl`：中台地址（默认读取环境变量 `AGENT_AUTOLOOP_PUBLIC_URL` 或 `http://127.0.0.1:3350`）。

### 2. 配置 `rules.json`

在 `~/.agent-autoloop/rules.json` 中登记来源、微信通道、Agent 以及名为 **`微信对话`** 的规则（`agent.ts` 依据规则名 `微信对话` 识别日常聊天窗口）：

```json
{
  "sources": {
    "local": { "name": "本机" }
  },
  "agents": {
    "cursor": {
      "name": "Cursor CLI",
      "worker": "你的接单电脑名",
      "use": "agent-autoloop-wechat"
    }
  },
  "channels": {
    "wechat": {
      "name": "微信",
      "answerers": ["扫码登录打印的 ilink_user_id"]
    }
  },
  "rules": [
    {
      "name": "微信对话",
      "when": {
        "source": "local",
        "types": ["wechat.message"]
      },
      "to": "cursor",
      "cwd": "/你的工作目录",
      "resume": true,
      "tell": "always",
      "channels": ["wechat"],
      "prompt": "你在微信里和用户对话。用户这次说的话在资料文件的 events 里：detail 是原文。最后一条消息的第一行就是发给他的回复，只写他能看懂的回答。一行写得下就只写这一行，不要另发 notice；一行写不下时，第一行写摘要，全文放进一个 fyi 为 true 的 notice（title 用这句摘要，不要用「回复」）。只有需要他从方案里选一个时才发 ask。"
    }
  ]
}
```

> **Cursor CLI 路径说明**：`agents.cursor` 默认自动在 `PATH`、`~/.local/bin/cursor-agent` 或 Windows `%LOCALAPPDATA%\cursor-agent\` 下查找 `cursor-agent`。如果装在别处，可加 `"program": "/绝对路径/cursor-agent"`，或像内置 `command` 一样传 `"command": ["...", "-p", "--trust", "{prompt}"]`。

校验规则并重载服务：

```bash
agent-autoloop check
agent-autoloop service install
agent-autoloop doctor
```

## 同一个微信，三段会话

微信里始终是同一个聊天窗口。背后按事情分成三段 Cursor 会话，各记各的上下文。一句话进哪一段，只看这句话长什么样。

**日常。** 普通句子交给来源 `local` 的事件 `wechat.message`，由规则「微信对话」处理。回复就是一段话，不带 `#` 编号。你发出去之后，头部会显示「对方正在输入」，直到这条回复发出；其它规则主动推来的通知不会亮。从上一次开口算起 8 小时内的下一句接着同一个会话，你继续聊，这 8 小时就往后顺延；超过 8 小时，再开口就是新会话。新会话号要等这次成功跑完才算数。

**其它规则。** 定时或事件规则自己新开一轮。它不接收你后来在微信里打的字，也不受上面 8 小时的限制。规则自己决定发 notice 还是 ask。

**拍板。** 整句刚好是一个序号，或整句以 `#编号 序号` 开头时，这句话回到发出这张卡的那一轮，卡片结束。编号写在「怎么回复」里，不放在卡片第一行。序号后面可以写你的话，例如 `#12 2 超时只改测试环境`，选择和这句话一起送回那一轮。那一轮看不到日常闲聊。

拍板之后你再发的句子，回到日常。想就这件事多说几句，直接发句子即可，卡片继续开着。`2 超时只改测试环境` 这种平时也会说的句子一直是日常聊天，不会拍板。

图片、语音、文件、视频不单独开工。通道先回复「等待后续文字指令」，把种类、文件名、语音转写攒着；下一条文字到来时，说明和文字合成一条任务，交给日常会话。助手拿到的是这些说明。

别人发给这个 bot 的消息会被丢掉，只认扫码登录的那个微信号。

## 怎么回复

一张未决卡片长这样：

```markdown
**请选一个方案**

要不要改这段超时。

1. 保持现状（推荐）
2. 按方案 B 改

---

**怎么回复**

- 纯数字：`1`
- `#12 2`
- `#12 2 超时只改测试环境`

纯数字只在只开着这一张时有效。整句刚好是某个选项的原文也可以。

`2 超时只改测试环境` 这种没有 # 的，是聊天，这张卡还留着。
```

每张待选择的卡片都会带上这段规则，例子里的编号和序号换成这张卡自己的。卡片在发出前就记在本机，所以卡片刚发出去、你正好回了数字，也会算这张卡的答案。

## 开发与验证

运行时无任何第三方依赖（`agent-autoloop add` 克隆后可直接由 Node 24 执行）。本地开发测试与类型检查：

```bash
npm install
npm run typecheck
npm test
```
