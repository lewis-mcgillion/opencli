import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { userConfigDir } from "./config";
import type { Message, Mode } from "./types";

export interface SavedSession {
  version: 1;
  model: string;
  mode: Mode;
  cwd: string;
  savedAt: string;
  messages: Message[];
}

export const AUTO_PREFIX = "_last-";

export function sessionsDir(): string {
  return path.join(userConfigDir(), "sessions");
}

export function validateSessionName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("session name required");
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed) || trimmed.includes("..")) {
    throw new Error("session names may contain letters, digits, dot, dash and underscore");
  }
  return trimmed;
}

export function autoSessionName(cwd: string): string {
  const real = fs.existsSync(cwd) ? fs.realpathSync(cwd) : cwd;
  return `${AUTO_PREFIX}${crypto.createHash("sha1").update(real).digest("hex").slice(0, 12)}`;
}

export function saveSession(name: string, data: Omit<SavedSession, "version" | "savedAt">): void {
  fs.mkdirSync(sessionsDir(), { recursive: true });
  const body: SavedSession = { version: 1, savedAt: new Date().toISOString(), ...data };
  fs.writeFileSync(path.join(sessionsDir(), `${validateSessionName(name)}.json`), JSON.stringify(body, null, 2));
}

export function loadSession(name: string): SavedSession {
  const file = path.join(sessionsDir(), `${validateSessionName(name)}.json`);
  if (!fs.existsSync(file)) throw new Error(`session ${name} not found`);
  const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as SavedSession;
  if (parsed.version !== 1 || !Array.isArray(parsed.messages)) throw new Error(`session ${name} has an unknown format`);
  return parsed;
}

export function listSessions(): string[] {
  if (!fs.existsSync(sessionsDir())) return [];
  return fs
    .readdirSync(sessionsDir())
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -5))
    .sort();
}
