import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHAT_DIR, PROJECTS_DIR, projectChatDir } from '../core/paths.ts';
import type { ChatMessage } from '../providers/types.ts';

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  requests: number;
}

export interface SessionRecord {
  id: string;
  title?: string;
  agent: string;
  provider: string;
  model: string;
  /** the project this session belongs to — sessions are listed per working directory */
  cwd?: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  usage: Usage;
}

export function titleFromMessage(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return 'untitled';
  return clean.length > 48 ? `${clean.slice(0, 47)}…` : clean;
}

export function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, requests: 0 };
}

export function newSessionId(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const base = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  let id = base;
  let suffix = 2;
  while (existsSync(sessionPath(id))) {
    id = `${base}-${suffix}`;
    suffix += 1;
  }
  return id;
}

export function sessionPath(id: string, cwd?: string): string {
  const dir = cwd ? projectChatDir(cwd) : CHAT_DIR;
  return join(dir, `${id}.json`);
}

export function saveSessionRecord(record: SessionRecord): void {
  const dir = record.cwd ? projectChatDir(record.cwd) : CHAT_DIR;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${record.id}.json`), JSON.stringify(record));
}

export function readSessionRecord(id: string, cwd?: string): SessionRecord | null {
  const candidates: string[] = [];
  if (cwd) candidates.push(join(projectChatDir(cwd), `${id}.json`));
  candidates.push(join(CHAT_DIR, `${id}.json`));
  if (existsSync(PROJECTS_DIR)) {
    for (const p of readdirSync(PROJECTS_DIR)) {
      candidates.push(join(PROJECTS_DIR, p, "chats", `${id}.json`));
    }
  }
  for (const path of candidates) {
    if (existsSync(path)) {
      try {
        return JSON.parse(readFileSync(path, "utf8")) as SessionRecord;
      } catch {}
    }
  }
  return null;
}

/**
 * Sessions recorded for a project. Pass the working directory to see only that
 * project's sessions; omit it for everything (used by tooling/tests).
 */
export function listSessionRecords(cwd?: string): SessionRecord[] {
  const out: SessionRecord[] = [];
  const seen = new Set<string>();

  const scanDir = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const record = JSON.parse(readFileSync(join(dir, file), "utf8")) as SessionRecord;
        if (cwd && record.cwd && record.cwd !== cwd) continue;
        if (cwd && !record.cwd && dir === CHAT_DIR) continue;
        if (!seen.has(record.id)) {
          seen.add(record.id);
          out.push(record);
        }
      } catch {}
    }
  };

  if (cwd) {
    scanDir(projectChatDir(cwd));
    scanDir(CHAT_DIR);
  } else {
    scanDir(CHAT_DIR);
    if (existsSync(PROJECTS_DIR)) {
      for (const p of readdirSync(PROJECTS_DIR)) {
        scanDir(join(PROJECTS_DIR, p, "chats"));
      }
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function deleteSessionRecord(id: string, cwd?: string): boolean {
  let deleted = false;
  const candidates: string[] = [];
  if (cwd) candidates.push(join(projectChatDir(cwd), `${id}.json`));
  candidates.push(join(CHAT_DIR, `${id}.json`));
  if (existsSync(PROJECTS_DIR)) {
    for (const p of readdirSync(PROJECTS_DIR)) {
      candidates.push(join(PROJECTS_DIR, p, "chats", `${id}.json`));
    }
  }
  for (const path of candidates) {
    if (existsSync(path)) {
      try {
        unlinkSync(path);
        deleted = true;
      } catch {}
    }
  }
  return deleted;
}

export function totalTokens(usage: Usage): number {
  return usage.inputTokens + usage.outputTokens;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function formatAge(ts: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
