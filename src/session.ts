import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Session } from "./api.ts";

export function sessionPath(home = process.env.AGENT_AUTOLOOP_HOME || path.join(process.env.USERPROFILE || process.env.HOME || ".", ".agent-autoloop")) {
  return path.join(home, "wechat-session.json");
}

export type StoredSession = Session & { open?: { id: number; options: string[] }[]; contextToken?: string };

export function readSession(file: string): StoredSession | null {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<StoredSession>;
    if (!parsed.token || !parsed.baseUrl || !parsed.userId || !parsed.botId) return null;
    return {
      token: parsed.token,
      baseUrl: parsed.baseUrl,
      botId: parsed.botId,
      userId: parsed.userId,
      cursor: parsed.cursor ?? "",
      ...(Array.isArray(parsed.open) ? { open: parsed.open } : {}),
      ...(parsed.contextToken ? { contextToken: parsed.contextToken } : {}),
    };
  } catch {
    return null;
  }
}

export function writeSession(file: string, session: StoredSession) {
  mkdirSync(path.dirname(file), { recursive: true });
  const next = `${file}.tmp`;
  writeFileSync(next, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(next, 0o600);
  } catch {
    // Windows may ignore the Unix mode. The file still stays under the user profile.
  }
  renameSync(next, file);
}
