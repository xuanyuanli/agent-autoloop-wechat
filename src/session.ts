import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { Session } from "./api.ts";

export function defaultHome() {
  return process.env.AGENT_AUTOLOOP_HOME || path.join(process.env.USERPROFILE || process.env.HOME || homedir(), ".agent-autoloop");
}

export function sessionPath(home = defaultHome()) {
  return path.join(home, "wechat-session.json");
}

function expandHome(raw: string) {
  if (raw === "~") return homedir();
  if (raw.startsWith("~/") || raw.startsWith("~\\")) return path.join(homedir(), raw.slice(2));
  return raw;
}

/**
 * Resolve session file for CLI tools (`bin/login.ts`):
 * 1. `--session <path>` / `--session=<path>`
 * 2. `channels.wechat.session` (or any channel with `use` matching `agent-autoloop-wechat`) in `config.json`
 * 3. Default `sessionPath(home)`
 */
export function resolveSessionFile(opts: { args?: readonly string[]; home?: string; cwd?: string } = {}) {
  const args = opts.args ?? [];
  const cwd = opts.cwd ?? process.cwd();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--session" && args[i + 1]) {
      return path.resolve(cwd, expandHome(args[i + 1]));
    }
    if (arg.startsWith("--session=") && arg.length > "--session=".length) {
      return path.resolve(cwd, expandHome(arg.slice("--session=".length)));
    }
  }
  const home = opts.home ?? defaultHome();
  try {
    const raw = readFileSync(path.join(home, "config.json"), "utf8");
    const parsed = JSON.parse(raw) as {
      channels?: Record<string, { use?: unknown; session?: unknown }>;
    };
    const channels = parsed.channels;
    if (channels && typeof channels === "object") {
      const candidates = [
        channels.wechat,
        ...Object.values(channels).filter(
          (entry) =>
            typeof entry?.use === "string" &&
            (entry.use === "agent-autoloop-wechat" || entry.use.endsWith("/agent-autoloop-wechat") || entry.use.endsWith("\\agent-autoloop-wechat")),
        ),
      ];
      for (const entry of candidates) {
        if (typeof entry?.session === "string" && entry.session.trim()) {
          return path.resolve(home, expandHome(entry.session.trim()));
        }
      }
    }
  } catch {
    // Missing or unreadable config.json falls back to default sessionPath.
  }
  return sessionPath(home);
}

export type Held = { kind: string; name?: string; note?: string; path?: string; size?: number; error?: string };
export type SpokenRun = { id: number; rule: string; createdAt: string };
export type StoredSession = Session & {
  open?: { id: number; options: string[]; ref?: string; rule?: string }[];
  contextToken?: string;
  pending?: Held[];
  spoken?: SpokenRun[];
};

function parseSpoken(raw: unknown): SpokenRun[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const items = raw.filter(
    (item): item is SpokenRun =>
      Boolean(item) &&
      typeof item === "object" &&
      typeof (item as SpokenRun).id === "number" &&
      typeof (item as SpokenRun).rule === "string" &&
      typeof (item as SpokenRun).createdAt === "string",
  );
  return items.length ? items : undefined;
}

function parseSession(raw: string): StoredSession | null {
  try {
    const parsed = JSON.parse(raw) as Partial<StoredSession>;
    if (!parsed.token || !parsed.baseUrl || !parsed.userId || !parsed.botId) return null;
    const spoken = parseSpoken(parsed.spoken);
    return {
      token: parsed.token,
      baseUrl: parsed.baseUrl,
      botId: parsed.botId,
      userId: parsed.userId,
      cursor: parsed.cursor ?? "",
      ...(Array.isArray(parsed.open) ? { open: parsed.open } : {}),
      ...(parsed.contextToken ? { contextToken: parsed.contextToken } : {}),
      ...(Array.isArray(parsed.pending) ? { pending: parsed.pending } : {}),
      ...(spoken ? { spoken } : {}),
    };
  } catch {
    return null;
  }
}

export function readSession(file: string): StoredSession | null {
  try {
    return parseSession(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export async function readSessionAsync(file: string): Promise<StoredSession | null> {
  try {
    return parseSession(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

/** A new login keeps unanswered cards when it is the same WeChat account. */
export function sessionFromLogin(
  existing: StoredSession | null,
  next: { token: string; baseUrl: string; botId: string; userId: string },
): StoredSession {
  const same = existing?.userId === next.userId;
  return {
    token: next.token,
    baseUrl: next.baseUrl,
    botId: next.botId,
    userId: next.userId,
    cursor: existing && same ? existing.cursor : "",
    ...(existing && same && existing.contextToken ? { contextToken: existing.contextToken } : {}),
    ...(existing && same && existing.open?.length ? { open: existing.open } : {}),
    ...(existing && same && existing.pending?.length ? { pending: existing.pending } : {}),
    ...(existing && same && existing.spoken?.length ? { spoken: existing.spoken } : {}),
  };
}

export function writeSession(file: string, session: StoredSession) {
  mkdirSync(path.dirname(file), { recursive: true });
  const next = `${file}.${process.pid}.tmp`;
  writeFileSync(next, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(next, 0o600);
  } catch {
    // Windows may ignore the Unix mode. The file still stays under the user profile.
  }
  renameSync(next, file);
}

export async function writeSessionAsync(file: string, session: StoredSession) {
  await mkdir(path.dirname(file), { recursive: true });
  const next = `${file}.${process.pid}.tmp`;
  await writeFile(next, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
  try {
    await chmod(next, 0o600);
  } catch {
    // Windows may ignore the Unix mode. The file still stays under the user profile.
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await rename(next, file);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt < 2 && (code === "EPERM" || code === "EACCES" || code === "EBUSY")) {
        await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
        continue;
      }
      throw error;
    }
  }
}
