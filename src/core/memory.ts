import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { MEMORY_PATH } from './paths.ts';
import { ensureHome } from './store.ts';
import { newId } from './schema.ts';

export interface MemoryEntry {
  id: string;
  ts: number;
  text: string;
  source?: string;
}

const MAX_ENTRIES = 1000;

export function allMemory(): MemoryEntry[] {
  if (!existsSync(MEMORY_PATH)) return [];
  try {
    const parsed = JSON.parse(readFileSync(MEMORY_PATH, 'utf8')) as MemoryEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeMemory(entries: MemoryEntry[]): void {
  ensureHome();
  mkdirSync(MEMORY_PATH.replace(/\/[^/]+$/, ''), { recursive: true });
  writeFileSync(MEMORY_PATH, JSON.stringify(entries, null, 2) + '\n');
}

export function remember(text: string, source?: string): MemoryEntry {
  const entry: MemoryEntry = { id: newId(), ts: Date.now(), text, source };
  const entries = allMemory();
  entries.push(entry);
  writeMemory(entries.slice(-MAX_ENTRIES));
  return entry;
}

export function recall(query?: string): MemoryEntry[] {
  const entries = allMemory();
  if (!query) return entries;
  const needle = query.toLowerCase();
  return entries.filter((e) => e.text.toLowerCase().includes(needle));
}

export function forget(target?: string): number {
  const entries = allMemory();
  if (!target) {
    writeMemory([]);
    return entries.length;
  }
  const kept = entries.filter((e) => e.id !== target && !e.text.toLowerCase().includes(target.toLowerCase()));
  writeMemory(kept);
  return entries.length - kept.length;
}

export function memoryBlock(limit = 50): string {
  const entries = allMemory().slice(-limit);
  if (entries.length === 0) return '';
  return ['', '## Baton memory (keep these — do not lose them)', ...entries.map((e) => `- ${e.text}`), ''].join('\n');
}
