// Cursor CLI print mode. A WeChat chat resumes only while it is still inside the idle window.
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { decideChat, type ChatStamp } from "./chat-session.ts";

type Turn = {
  prompt: string;
  resume: string | null;
  cwd: string;
  model?: string;
  effort?: string;
  command?: string[];
  contextFile: string;
};

function homeDir() {
  return process.env.AGENT_AUTOLOOP_HOME || path.join(process.env.USERPROFILE || process.env.HOME || "", ".agent-autoloop");
}

function stampPath() {
  return path.join(homeDir(), "wechat-chat.json");
}

function readStamp(): ChatStamp | null {
  try {
    const parsed = JSON.parse(readFileSync(stampPath(), "utf8")) as Partial<ChatStamp>;
    if (typeof parsed.at !== "number") return null;
    return { at: parsed.at, break: parsed.break === true };
  } catch {
    return null;
  }
}

function writeStamp(stamp: ChatStamp) {
  const file = stampPath();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(stamp)}\n`, { mode: 0o600 });
}

const PLACEHOLDER = /\{(prompt|model|effort|cwd|context)\}/g;

export function commandLine(turn: Turn) {
  const values: Record<string, string> = {
    prompt: turn.prompt,
    model: turn.model ?? "",
    effort: turn.effort ?? "",
    cwd: turn.cwd,
    context: turn.contextFile,
  };
  const args = (turn.command ?? []).map((part) => part.replace(PLACEHOLDER, (_, name: string) => values[name] ?? ""));
  const decision = decideChat(turn.resume, turn.prompt, readStamp(), Date.now());
  if (decision.remember) writeStamp(decision.stamp!);
  if (decision.fresh) writeFileSync(path.join(path.dirname(turn.contextFile), "wechat-fresh"), String(Date.now()));
  const extra: string[] = [];
  if (decision.resume && !args.includes("--resume")) extra.push("--resume", decision.resume);
  if (!args.includes("--output-format")) extra.push("--output-format", "json");
  const at = args.lastIndexOf("-p");
  args.splice(at === -1 ? Math.max(args.length - 1, 0) : at, 0, ...extra);
  return args;
}

type CursorResult = { result?: string; session_id?: string; is_error?: boolean };

export function readOutput(stdout: string, code: number | null, stderr: string) {
  if (code === null) return {};
  const tail = (stderr || stdout).trim().slice(-500);
  if (code !== 0) return { error: `退出码 ${code}：${tail || "没留下原因"}` };
  const parsed = cursorResult(stdout);
  if (parsed?.session_id) rememberFreshSession(parsed.session_id);
  if (!parsed) return { text: stdout };
  if (parsed.is_error) return { error: parsed.result || "Cursor 返回错误", ...(parsed.session_id ? { session: parsed.session_id } : {}) };
  return { text: parsed.result ?? stdout, ...(parsed.session_id ? { session: parsed.session_id } : {}) };
}

/** A fresh WeChat turn left a marker beside its stdout. Recording that session clears the break. */
function rememberFreshSession(sessionId: string) {
  let runs: string;
  try {
    runs = path.join(homeDir(), "worker", "runs");
    readdirSync(runs);
  } catch {
    return;
  }
  for (const id of readdirSync(runs)) {
    const dir = path.join(runs, id);
    const marker = path.join(dir, "wechat-fresh");
    let started = 0;
    try {
      started = Number(readFileSync(marker, "utf8"));
    } catch {
      continue;
    }
    let logs: string[] = [];
    try {
      logs = readdirSync(dir).filter((name) => name.startsWith("stdout-"));
    } catch {
      continue;
    }
    const matched = logs.some((name) => {
      try {
        return readFileSync(path.join(dir, name), "utf8").includes(sessionId);
      } catch {
        return false;
      }
    });
    if (!matched) continue;
    writeStamp({ at: Number.isFinite(started) && started > 0 ? started : Date.now(), break: false });
    rmSync(marker, { force: true });
  }
}

function cursorResult(stdout: string): CursorResult | null {
  const trimmed = stdout.trim();
  const direct = asResult(trimmed);
  if (direct) return direct;
  let found: CursorResult | null = null;
  for (const line of trimmed.split(/\r?\n/)) {
    const parsed = asResult(line.trim());
    if (parsed?.result !== undefined || parsed?.session_id) found = parsed;
  }
  return found;
}

function asResult(text: string): CursorResult | null {
  if (!text.startsWith("{")) return null;
  try {
    const value = JSON.parse(text) as CursorResult;
    if (!value || typeof value !== "object") return null;
    if (typeof value.result !== "string" && typeof value.session_id !== "string") return null;
    return value;
  } catch {
    return null;
  }
}
