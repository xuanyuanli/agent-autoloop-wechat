// Cursor CLI print mode, with the session id kept so the next turn can --resume.
type Turn = {
  prompt: string;
  resume: string | null;
  cwd: string;
  model?: string;
  effort?: string;
  command?: string[];
  contextFile: string;
};

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
  const extra: string[] = [];
  if (turn.resume && !args.includes("--resume")) extra.push("--resume", turn.resume);
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
  if (!parsed) return { text: stdout };
  if (parsed.is_error) return { error: parsed.result || "Cursor 返回错误", ...(parsed.session_id ? { session: parsed.session_id } : {}) };
  return { text: parsed.result ?? stdout, ...(parsed.session_id ? { session: parsed.session_id } : {}) };
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
