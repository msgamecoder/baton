import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHAT_DIR } from '../core/paths.ts';
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

export function sessionPath(id: string): string {
  return join(CHAT_DIR, `${id}.json`);
}

export function saveSessionRecord(record: SessionRecord): void {
  mkdirSync(CHAT_DIR, { recursive: true });
  writeFileSync(sessionPath(record.id), JSON.stringify(record));
}

export function readSessionRecord(id: string): SessionRecord | null {
  const path = sessionPath(id);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as SessionRecord;
  } catch {
    return null;
  }
}

/**
 * Sessions recorded for a project. Pass the working directory to see only that
 * project's sessions; omit it for everything (used by tooling/tests).
 */
export function listSessionRecords(cwd?: string): SessionRecord[] {
  if (!existsSync(CHAT_DIR)) return [];
  const out: SessionRecord[] = [];
  for (const file of readdirSync(CHAT_DIR)) {
    if (!file.endsWith('.json')) continue;
    try {
      const record = JSON.parse(readFileSync(join(CHAT_DIR, file), 'utf8')) as SessionRecord;
      if (cwd && record.cwd !== cwd) continue;
      out.push(record);
    } catch {
      continue;
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function deleteSessionRecord(id: string): boolean {
  const path = sessionPath(id);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
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
