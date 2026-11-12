// Cursor CLI print mode. A WeChat chat resumes only while it is still inside the idle window.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { decideChat, isChatPrompt, type ChatStamp } from "./chat-session.ts";

type Turn = {
  prompt: string;
  resume: string | null;
  cwd: string;
  model?: string;
  effort?: string;
  command?: string[];
  contextFile: string;
};

type Clock = { home?: string; now?: number };

function homeDir() {
  return process.env.AGENT_AUTOLOOP_HOME || path.join(process.env.USERPROFILE || process.env.HOME || "", ".agent-autoloop");
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

/** The WeChat launch whose stdout may carry the new Cursor session id. */
let pendingChat: { dir: string; at: number; home: string } | null = null;

const PLACEHOLDER = /\{(prompt|model|effort|cwd|context)\}/g;

const INSPECTION_RULE = "工作日运维巡检";
const OFFDAY_LINE = "今天是非工作日（周末或法定假日），跳过今日巡检";

/** The framework ending tells every run to write 没事可做. That outcome is not pushed, so the inspection must say otherwise last. */
function spokenPrompt(prompt: string) {
  if (!prompt.includes(`规则「${INSPECTION_RULE}」`)) return prompt;
  return (
    `${prompt}\n\n` +
    "上面若写了「看过了，没有要做的：写没事可做」，本规则不采用。" +
    `非工作日跳过时，第一行必须是「${OFFDAY_LINE}」，不要以「没事可做」或「没跑成」开头，不附回执。`
  );
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
  const args = (turn.command ?? []).map((part) => part.replace(PLACEHOLDER, (_, name: string) => values[name] ?? ""));
  const decision = decideChat(turn.resume, turn.prompt, readStamp(home), now);
  if (decision.remember && decision.stamp) writeStamp(decision.stamp, home);
  if (isChatPrompt(turn.prompt)) pendingChat = { dir: path.dirname(turn.contextFile), at: now, home };
  const extra: string[] = [];
  if (decision.resume && !args.includes("--resume")) extra.push("--resume", decision.resume);
  if (!args.includes("--output-format")) extra.push("--output-format", "json");
  const at = args.lastIndexOf("-p");
  args.splice(at === -1 ? Math.max(args.length - 1, 0) : at, 0, ...extra);
  return args;
}

type CursorResult = { result?: string; session_id?: string; is_error?: boolean };

export function readOutput(stdout: string, code: number | null, stderr: string) {
  const parsed = cursorResult(stdout);
  if (pendingChat && stdoutBelongs(pendingChat.dir, stdout)) {
    if (code === 0 && parsed?.session_id) writeStamp({ id: parsed.session_id, at: pendingChat.at }, pendingChat.home);
    if (code !== null) pendingChat = null;
  }
  if (code === null) return {};
  const tail = (stderr || stdout).trim().slice(-500);
  if (code !== 0) return { error: `退出码 ${code}：${tail || "没留下原因"}` };
  if (!parsed) return { text: stdout };
  if (parsed.is_error) return { error: parsed.result || "Cursor 返回错误", ...(parsed.session_id ? { session: parsed.session_id } : {}) };
  return { text: parsed.result ?? stdout, ...(parsed.session_id ? { session: parsed.session_id } : {}) };
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
