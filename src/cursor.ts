// Cursor CLI print mode. A WeChat chat resumes only while it is still inside the idle window.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { splitText } from "./card-text.ts";
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

export type Usage = {
  input?: number;
  output?: number;
  cached?: number;
  cost?: number;
};

export type Reading = {
  text?: string;
  session?: string;
  usage?: Usage;
  error?: string;
  started?: boolean;
  finished?: boolean;
};

type Clock = { home?: string; now?: number };

const MAX_PENDING_CHATS = 64;
const LOST_SESSION = /\b(?:session|chat|conversation)\b[^\n]*(?:not found|does not exist|invalid|unknown|missing)|找不到.*会话|会话不存在/i;
const PLACEHOLDER = /\{(prompt|model|effort|cwd|context)\}/g;
const RECEIPT_BLOCK = /(?<=^|\n)[ \t]*```agent-autoloop[ \t]*\r?\n((?:[^\n]*\n)*?)[ \t]*```[ \t]*(?=\r?\n|$)/g;
const RECEIPT_FENCE = /(?<=^|\n)[ \t]*```(?:agent-autoloop|json)[ \t]*\r?\n/;
const SPECIAL_OUTCOME = /^(?:没跑成|FAILED|没事可做|NOTHING|待你处理)(?:$|[\s:：])/;

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
    "上面关于中台怎么结束这一轮的说明，不要写进发给人的正文。若本规则禁止发 notice 和 ask，严格只发 events；否则发给人的只有回执里的 notice 和 ask。" +
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
  // `stream-json` separates each assistant segment around tool calls; plain `json` concatenates pre-tool thoughts onto line 1.
  if (!args.includes("--output-format")) extra.push("--output-format", "stream-json");
  const at = args.lastIndexOf("-p");
  args.splice(at === -1 ? Math.max(args.length - 1, 0) : at, 0, ...extra);
  return args;
}

type CursorResult = { result?: string; session_id?: string; is_error?: boolean; usage?: Usage };

type StreamState = {
  sawStream: boolean;
  sessionId?: string;
  isChatFromStream: boolean;
  currentSegment: string;
  priorSegments: string[];
  carriedReceipts: string[];
  resultEvent?: CursorResult;
};

function messageText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const typed = part as { type?: unknown; text?: unknown };
      return (typed.type === "text" || typed.type === undefined) && typeof typed.text === "string" ? typed.text : "";
    })
    .join("");
}

function extractUsage(raw: unknown): Usage | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const item = raw as Record<string, unknown>;
  const cacheRead = typeof item.cacheReadTokens === "number" ? item.cacheReadTokens : 0;
  const cacheWrite = typeof item.cacheWriteTokens === "number" ? item.cacheWriteTokens : 0;
  const cached = cacheRead + cacheWrite;
  const usage: Usage = {};
  if (typeof item.inputTokens === "number") usage.input = item.inputTokens + cached;
  if (typeof item.outputTokens === "number") usage.output = item.outputTokens;
  if (typeof item.cacheReadTokens === "number" || typeof item.cacheWriteTokens === "number") usage.cached = cached;
  return Object.keys(usage).length ? usage : undefined;
}

function lastReceiptBlock(text: string): string | undefined {
  return [...text.matchAll(RECEIPT_BLOCK)].at(-1)?.[0];
}

function parseStream(stdout: string): StreamState {
  const state: StreamState = {
    sawStream: false,
    isChatFromStream: false,
    currentSegment: "",
    priorSegments: [],
    carriedReceipts: [],
  };
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("{") || !line.endsWith("}")) continue;
    let event: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      event = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    const sid =
      typeof event.session_id === "string" && event.session_id
        ? event.session_id
        : typeof event.sessionId === "string" && event.sessionId
          ? event.sessionId
          : undefined;
    if (sid) state.sessionId = sid;

    const kind = event.type;
    if (kind === "system") {
      state.sawStream = true;
      if (event.subtype === "task_notification") {
        const receipt = lastReceiptBlock(state.currentSegment);
        if (receipt) state.carriedReceipts.push(receipt);
        if (state.currentSegment.trim()) state.priorSegments.push(state.currentSegment);
        state.currentSegment = "";
      }
    } else if (kind === "user") {
      state.sawStream = true;
      const text = messageText(event.message);
      if (text && isChatPrompt(text)) state.isChatFromStream = true;
    } else if (kind === "assistant") {
      state.sawStream = true;
      const chunk = messageText(event.message) || (typeof event.text === "string" ? event.text : "");
      state.currentSegment += chunk;
    } else if (kind === "tool_call") {
      state.sawStream = true;
      if (event.subtype === "started" || event.subtype === undefined) {
        if (state.currentSegment.trim()) state.priorSegments.push(state.currentSegment);
        state.currentSegment = "";
      }
    } else if (kind === "retry") {
      state.sawStream = true;
      if (event.subtype === "starting" && event.is_resume !== true) {
        state.currentSegment = "";
      }
    } else if (kind === "thinking" || kind === "usage" || kind === "connection" || kind === "interaction_query") {
      state.sawStream = true;
    } else if (kind === "result") {
      const normalized = normalize(event);
      if (normalized) state.resultEvent = normalized;
    }
  }
  return state;
}

/**
 * If a multi-line WeChat chat reply has no explicit receipt block, wrap the full Markdown into an `fyi: true`
 * notice so `worker/contract.ts` does not drop everything after line 1.
 */
function maybeWrapChat(text: string, isChat: boolean): string {
  if (!isChat) return text;
  const trimmed = text.trim();
  if (!trimmed || !trimmed.includes("\n")) return text;
  if (RECEIPT_FENCE.test(trimmed)) return text;
  const lines = trimmed.split(/\r?\n/);
  const firstNonEmpty = lines.map((line) => line.trim()).find(Boolean) ?? "";
  const plainHead = firstNonEmpty.replace(/^[#>*\s]+/, "").replace(/\*\*/g, "").trim();
  if (!plainHead || SPECIAL_OUTCOME.test(plainHead)) return text;

  const chunks = splitText(trimmed, 3800).slice(0, 10);
  const notices = chunks.map((chunk) => {
    const chunkFirst = chunk.split(/\r?\n/)[0]?.trim() ?? "";
    let title = [...chunkFirst].slice(0, 150).join("").trim() || "微信回复";
    if (title === "回复") title = "微信回复";
    return { title, text: chunk, fyi: true };
  });
  const summaryLine = [...plainHead].slice(0, 200).join("");
  return `${summaryLine}\n\n\`\`\`agent-autoloop\n${JSON.stringify({ notice: notices })}\n\`\`\``;
}

export function readOutput(stdout: string, code: number | null, stderr: string): Reading {
  const stream = parseStream(stdout);
  const legacy = stream.sawStream ? null : cursorResult(stdout);
  const sessionId = stream.sessionId ?? stream.resultEvent?.session_id ?? legacy?.session_id;
  const resultObj = stream.sawStream ? stream.resultEvent : legacy;

  let isChat = stream.isChatFromStream;
  for (const [dir, entry] of pendingChats) {
    if (!stdoutBelongs(dir, stdout)) continue;
    isChat = true;
    if (code === 0 && sessionId && !resultObj?.is_error) writeStamp({ id: sessionId, at: entry.at }, entry.home);
    if (code !== null) pendingChats.delete(dir);
    break;
  }

  const session = sessionId ? { session: sessionId } : {};
  const usage = resultObj?.usage ? { usage: resultObj.usage } : {};

  if (stream.sawStream) {
    if (!stream.resultEvent) {
      if (code === null) return { started: true, ...session };
      const tail = (stderr || stdout).trim().slice(-500);
      if (code !== 0) {
        const lost = LOST_SESSION.test(tail);
        return { started: !lost, ...session, error: `退出码 ${code}：${tail || "没留下原因"}` };
      }
      const fallback = stream.currentSegment.trim() ? stream.currentSegment : (stream.priorSegments.at(-1) ?? "");
      if (!fallback.trim()) return { started: true, ...session, error: tail || "没留下结果" };
      return { text: maybeWrapChat(fallback, isChat), started: true, finished: true, ...session };
    }

    if (code !== null && code !== 0) {
      const tail = (stderr || stream.resultEvent.result || stdout).trim().slice(-500);
      const lost = LOST_SESSION.test(tail);
      return { started: !lost, ...session, ...usage, error: `退出码 ${code}：${tail || "没留下原因"}` };
    }
    if (stream.resultEvent.is_error) {
      const detail = stream.resultEvent.result || "Cursor 返回错误";
      return { started: !LOST_SESSION.test(detail), finished: true, error: detail, ...session, ...usage };
    }
    let answer = stream.currentSegment.trim()
      ? stream.currentSegment
      : (stream.priorSegments.at(-1) ?? stream.resultEvent.result ?? "");
    if (!RECEIPT_FENCE.test(answer) && stream.carriedReceipts.length > 0) {
      answer = `${answer.trimEnd()}\n\n${stream.carriedReceipts.at(-1)}`;
    }
    answer = maybeWrapChat(answer, isChat);
    if (!answer.trim()) return { started: true, finished: true, error: "没留下结果", ...session, ...usage };
    return { text: answer, started: true, finished: true, ...session, ...usage };
  }

  if (code === null) {
    if (legacy?.result !== undefined) {
      if (legacy.is_error) return { started: true, finished: true, error: legacy.result || "Cursor 返回错误", ...session, ...usage };
      return { text: maybeWrapChat(legacy.result, isChat), started: true, finished: true, ...session, ...usage };
    }
    return { started: true, ...session };
  }
  const tail = (stderr || stdout).trim().slice(-500);
  if (code !== 0) {
    const lost = LOST_SESSION.test(tail);
    return { started: !lost, ...session, ...usage, error: `退出码 ${code}：${tail || "没留下原因"}` };
  }
  if (!legacy) {
    if (!stdout.trim()) return { started: true, error: tail || "没留下结果" };
    return { text: maybeWrapChat(stdout, isChat), started: true, finished: true };
  }
  if (legacy.is_error) {
    const detail = legacy.result || "Cursor 返回错误";
    return { started: !LOST_SESSION.test(detail), finished: true, error: detail, ...session, ...usage };
  }
  return { text: maybeWrapChat(legacy.result ?? stdout, isChat), started: true, finished: true, ...session, ...usage };
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
  const head = stdout.slice(0, 4096);
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
      return body === stdout || body.startsWith(stdout) || (stdout.length > 4096 && body.startsWith(head));
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
  const isError =
    value.is_error === true ||
    value.isError === true ||
    (typeof value.subtype === "string" && value.subtype !== "success");
  const usage = extractUsage(value.usage);
  return {
    ...(typeof result === "string" ? { result } : {}),
    ...(typeof session === "string" ? { session_id: session } : {}),
    ...(isError ? { is_error: true } : {}),
    ...(usage ? { usage } : {}),
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
