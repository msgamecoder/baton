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
  agent: string;
  provider: string;
  model: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  usage: Usage;
}

export function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, requests: 0 };
}

export function newSessionId(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
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

export function listSessionRecords(): SessionRecord[] {
  if (!existsSync(CHAT_DIR)) return [];
  const out: SessionRecord[] = [];
  for (const file of readdirSync(CHAT_DIR)) {
    if (!file.endsWith('.json')) continue;
    try {
      out.push(JSON.parse(readFileSync(join(CHAT_DIR, file), 'utf8')) as SessionRecord);
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
