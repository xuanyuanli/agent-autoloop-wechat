// Scan a WeChat QR code and store the bot session outside the repository.
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { createClient } from "../src/api.ts";
import { sessionPath, writeSession } from "../src/session.ts";

const file = sessionPath();
const api = createClient();
const LOGIN_BASE = "https://ilinkai.weixin.qq.com";
let base = LOGIN_BASE;
let verifyCode: string | undefined;
let refreshes = 0;
const started = Date.now();

while (Date.now() - started < 10 * 60_000 && refreshes <= 3) {
  const qr = await api.fetchQr();
  console.log(`用手机微信扫描这个地址里的二维码：\n${qr.image}\n`);
  for (;;) {
    if (Date.now() - started >= 10 * 60_000) break;
    let status: Awaited<ReturnType<typeof api.pollQr>>;
    try {
      status = await api.pollQr(qr.qrcode, base, verifyCode);
    } catch {
      continue;
    }
    const name = status.status ?? "wait";
    if (name === "wait") continue;
    if (name.includes("need_verifycode")) {
      if (!input.isTTY) {
        console.error("这次登录要求手机上的数字。请在自己的终端里重新运行 node bin/login.ts，看到提示后输入数字。");
        process.exit(1);
      }
      const prompt = createInterface({ input, output });
      verifyCode = (await prompt.question("输入手机上的数字：")).trim();
      prompt.close();
      continue;
    }
    if (name === "scaned") {
      verifyCode = undefined;
      console.log("已扫码，等待确认。");
      continue;
    }
    if (name === "scaned_but_redirect" && status.redirect_host) {
      base = `https://${status.redirect_host}`;
      console.log("登录跳转到另一台接入点，继续等待确认。");
      continue;
    }
    if (name === "binded_redirect") {
      console.error("这个微信号已经绑过，这次没有新凭证。先在手机上解除旧的 ClawBot，再重新运行。");
      process.exit(1);
    }
    if (name === "confirmed" && status.bot_token && status.baseurl && status.ilink_bot_id && status.ilink_user_id) {
      writeSession(file, {
        token: status.bot_token,
        baseUrl: status.baseurl,
        botId: status.ilink_bot_id,
        userId: status.ilink_user_id,
        cursor: "",
      });
      console.log(`登录成功，会话已写入 ${file}`);
      process.exit(0);
    }
    if (name === "expired" || name === "verify_code_blocked") {
      refreshes += 1;
      verifyCode = undefined;
      base = LOGIN_BASE;
      break;
    }
  }
}
console.error("十分钟内没有确认登录。");
process.exit(1);
