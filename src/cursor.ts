// Cursor CLI print mode. A WeChat chat resumes only while it is still inside the idle window.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { decideChat, isChatPrompt, type ChatStamp } from "./chat-session.ts";

export type Turn = {
  prompt: string;
  resume: string | null;
  cwd: string;
  model?: string;
  effort?: string;
  command?: string[];
  program?: string;
  contextFile: string;
};

export type Reading = {
  text?: string;
  session?: string;
  error?: string;
  started?: boolean;
  finished?: boolean;
};

type Clock = { home?: string; now?: number };

const MAX_PENDING_CHATS = 64;
const LOST_SESSION = /\b(?:session|chat|conversation)\b[^\n]*(?:not found|does not exist|invalid|unknown|missing)|找不到.*会话|会话不存在/i;
const PLACEHOLDER = /\{(prompt|model|effort|cwd|context)\}/g;

const POWERSHELL = path.join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);

function homeDir() {
  return process.env.AGENT_AUTOLOOP_HOME || path.join(process.env.USERPROFILE || process.env.HOME || homedir(), ".agent-autoloop");
}

function stampPath(home: string) {
  return path.join(home, "wechat-chat.json");
}

function readStamp(home: string): ChatStamp | null {
  try {
    const parsed = JSON.parse(readFileSync(stampPath(home), "utf8")) as { at?: number; id?: unknown; break?: boolean };
    if (typeof parsed.at !== "number") return null;
    if (parsed.break === true) return { id: null, at: 0 };
    if (typeof parsed.id === "string" && parsed.id) return { id: parsed.id, at: parsed.at };
    if (parsed.id === null) return { id: null, at: parsed.at };
    return { id: null, at: parsed.at, legacy: true };
  } catch {
    return null;
  }
}

function writeStamp(stamp: ChatStamp, home: string) {
  const file = stampPath(home);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ id: stamp.id, at: stamp.at })}\n`, { mode: 0o600 });
}

/** Active WeChat launches keyed by run folder so concurrent runs never overwrite one another. */
const pendingChats = new Map<string, { at: number; home: string }>();

function trackPendingChat(dir: string, entry: { at: number; home: string }) {
  pendingChats.delete(dir);
  pendingChats.set(dir, entry);
  while (pendingChats.size > MAX_PENDING_CHATS) {
    const oldest = pendingChats.keys().next().value;
    if (oldest === undefined) break;
    pendingChats.delete(oldest);
  }
}

/** The framework ending comes after the rule text. Say the user-facing rule last, or the model recites its own steps. */
function spokenPrompt(prompt: string) {
  if (isChatPrompt(prompt)) {
    return (
      `${prompt}\n\n` +
      "上面关于读资料、写结论、接着做的说明，都不要写进回复。" +
      "最后一条消息的第一行只写给用户看的回答。不要写处理步骤，不要提中台、手册、资料文件、事件或上一轮做到哪。"
    );
  }
  return (
    `${prompt}\n\n` +
    "上面关于中台怎么结束这一轮的说明，不要写进发给人的正文。发给人的只有回执里的 notice 和 ask。" +
    "notice 的 text 用 Markdown：小标题用 **，节与节之间空一行再写 ---，列表用 - 。微信会把单个换行收成空格。不要把排查过程写进 notice。"
  );
}

function findOnPath(name: string): string | null {
  if (/[\\/]/.test(name)) return existsSync(name) ? name : null;
  const separator = process.platform === "win32" ? ";" : ":";
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ".ps1", ""] : [""];
  for (const raw of (process.env.PATH ?? "").split(separator)) {
    const folder = raw.trim().replace(/^"(.*)"$/, "$1");
    if (!folder) continue;
    for (const ext of extensions) {
      const candidate = path.join(folder, name.toLowerCase().endsWith(ext) ? name : `${name}${ext}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export function findCursorProgram(explicit?: string): string | null {
  if (explicit) return /[\\/]/.test(explicit) ? (existsSync(explicit) ? explicit : null) : findOnPath(explicit);
  const fromPath = findOnPath("cursor-agent");
  if (fromPath) return fromPath;
  const localAppData = process.env.LOCALAPPDATA || path.join(homedir(), "AppData", "Local");
  const candidates =
    process.platform === "win32"
      ? [
          path.join(localAppData, "cursor-agent", "cursor-agent.cmd"),
          path.join(localAppData, "cursor-agent", "cursor-agent.ps1"),
          path.join(localAppData, "cursor-agent", "cursor-agent.exe"),
        ]
      : [
          path.join(homedir(), ".local", "bin", "cursor-agent"),
          "/opt/homebrew/bin/cursor-agent",
          "/usr/local/bin/cursor-agent",
        ];
  return candidates.find((file) => existsSync(file)) ?? null;
}

function launcherFor(program: string): string[] {
  if (process.platform === "win32" && /\.ps1$/i.test(program)) {
    return [POWERSHELL, "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", program];
  }
  return [program];
}

function defaultTemplate(turn: Turn): string[] {
  const program = findCursorProgram(turn.program);
  if (!program) {
    throw new Error(
      turn.program
        ? `找不到指定的 Cursor CLI 程序：${turn.program}`
        : "找不到 cursor-agent：请先安装 Cursor CLI，或在 rules.json 的 agent 中配置 command / program",
    );
  }
  return [...launcherFor(program), ...(turn.model ? ["--model", "{model}"] : []), "-p", "--trust", "{prompt}"];
}

export function commandLine(turn: Turn, clock: Clock = {}) {
  const home = clock.home ?? homeDir();
  const now = clock.now ?? Date.now();
  const values: Record<string, string> = {
    prompt: spokenPrompt(turn.prompt),
    model: turn.model ?? "",
    effort: turn.effort ?? "",
    cwd: turn.cwd,
    context: turn.contextFile,
  };
  const template = turn.command?.length ? turn.command : defaultTemplate(turn);
  const args = template.map((part) => part.replace(PLACEHOLDER, (_, name: string) => values[name] ?? ""));
  const decision = decideChat(turn.resume, turn.prompt, readStamp(home), now);
  if (decision.remember && decision.stamp) writeStamp(decision.stamp, home);
  if (isChatPrompt(turn.prompt)) trackPendingChat(path.dirname(turn.contextFile), { at: now, home });
  const extra: string[] = [];
  if (decision.resume && !args.includes("--resume")) extra.push("--resume", decision.resume);
  if (!args.includes("--output-format")) extra.push("--output-format", "json");
  const at = args.lastIndexOf("-p");
  args.splice(at === -1 ? Math.max(args.length - 1, 0) : at, 0, ...extra);
  return args;
}

type CursorResult = { result?: string; session_id?: string; is_error?: boolean };

export function readOutput(stdout: string, code: number | null, stderr: string): Reading {
  const parsed = cursorResult(stdout);
  for (const [dir, entry] of pendingChats) {
    if (!stdoutBelongs(dir, stdout)) continue;
    if (code === 0 && parsed?.session_id) writeStamp({ id: parsed.session_id, at: entry.at }, entry.home);
    if (code !== null) pendingChats.delete(dir);
    break;
  }
  const session = parsed?.session_id ? { session: parsed.session_id } : {};
  if (code === null) {
    if (parsed?.result !== undefined) {
      if (parsed.is_error) return { started: true, finished: true, error: parsed.result || "Cursor 返回错误", ...session };
      return { text: parsed.result, started: true, finished: true, ...session };
    }
    return { started: true, ...session };
  }
  const tail = (stderr || stdout).trim().slice(-500);
  if (code !== 0) {
    const lost = LOST_SESSION.test(tail);
    return { started: !lost, ...session, error: `退出码 ${code}：${tail || "没留下原因"}` };
  }
  if (!parsed) {
    if (!stdout.trim()) return { started: true, error: tail || "没留下结果" };
    return { text: stdout, started: true, finished: true };
  }
  if (parsed.is_error) {
    const detail = parsed.result || "Cursor 返回错误";
    return { started: !LOST_SESSION.test(detail), finished: true, error: detail, ...session };
  }
  return { text: parsed.result ?? stdout, started: true, finished: true, ...session };
}

export function checkCursor(program?: string, home = homeDir()): string | null {
  if (program) {
    return findCursorProgram(program) ? null : `Cursor CLI 找不到指定程序：${program}`;
  }
  try {
    const rules = JSON.parse(readFileSync(path.join(home, "rules.json"), "utf8")) as {
      agents?: Record<string, { use?: string; command?: string[]; program?: string }>;
    };
    const configured = Object.values(rules.agents ?? {}).filter((agent) => agent?.use === "agent-autoloop-wechat");
    for (const agent of configured) {
      if (agent.command?.length) {
        const head = agent.command[0];
        if (!findCursorProgram(head)) return `Cursor CLI 启动程序不存在：${head}`;
      } else if (!findCursorProgram(agent.program)) {
        return "找不到 cursor-agent：请先安装 Cursor CLI，或在 rules.json 的 agent 中配置 command / program";
      }
    }
    if (configured.length > 0) return null;
  } catch {
    // Fall back to checking default binary locations when rules.json is absent or unreadable.
  }
  return findCursorProgram()
    ? null
    : "找不到 cursor-agent：请先安装 Cursor CLI，或在 rules.json 的 agent 中配置 command / program";
}

function stdoutBelongs(dir: string, stdout: string) {
  if (!stdout) return false;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return false;
  }
  return names.some((name) => {
    if (!name.startsWith("stdout-")) return false;
    try {
      const body = readFileSync(path.join(dir, name), "utf8");
      return body === stdout || body.startsWith(stdout);
    } catch {
      return false;
    }
  });
}

function cursorResult(stdout: string): CursorResult | null {
  const trimmed = stdout.trim();
  return asResult(trimmed) ?? scanObjects(trimmed);
}

function asResult(text: string): CursorResult | null {
  if (!text.startsWith("{")) return null;
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    if (!value || typeof value !== "object") return null;
    return normalize(value);
  } catch {
    return null;
  }
}

function normalize(value: Record<string, unknown>): CursorResult | null {
  const result = value.result ?? value.text;
  const session = value.session_id ?? value.sessionId;
  if (typeof result !== "string" && typeof session !== "string") return null;
  return {
    ...(typeof result === "string" ? { result } : {}),
    ...(typeof session === "string" ? { session_id: session } : {}),
    ...(value.is_error === true || value.isError === true ? { is_error: true } : {}),
  };
}

function scanObjects(text: string): CursorResult | null {
  let best: { parsed: CursorResult; rank: number } | null = null;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    const end = matchBrace(text, i);
    if (end < 0) continue;
    const parsed = asResult(text.slice(i, end + 1));
    if (!parsed) continue;
    const rank = (parsed.result !== undefined ? 1_000_000_000 : 0) + (end - i);
    if (!best || rank > best.rank) best = { parsed, rank };
  }
  return best?.parsed ?? null;
}

function matchBrace(text: string, start: number) {
  let depth = 0;
  let quote = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') quote = false;
      continue;
    }
    if (ch === '"') {
      quote = true;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}
