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

export function memoryLines(): string[] {
  const entries = allMemory();
  if (entries.length === 0) return ['(no memory yet)'];
  return entries.map((entry) => entry.text);
}

export function isMemoryInstruction(text: string): boolean {
  return (
    /^\s*\/?(?:please\s+)?(?:save|remember|keep|note|store)\b/i.test(text) ||
    /^\s*don'?t forget\b/i.test(text)
  );
}

export function rememberFact(fact: string, source?: string): MemoryEntry | null {
  const trimmed = fact.trim();
  if (!trimmed) return null;
  const needle = trimmed.toLowerCase();
  const existing = allMemory().find((entry) => entry.text.trim().toLowerCase() === needle);
  if (existing) return null;
  return remember(trimmed, source);
}

export function extractFacts(text: string): string[] {
  const raw = text.trim();
  if (!raw) return [];
  const clean = raw.replace(/[.!]+$/, '');
  const facts: string[] = [];

  const stripTail = (value: string): string =>
    value
      .replace(/\s+(?:to|in|into)\s+(?:your\s+|the\s+)?(?:memory|mind)\b.*$/i, '')
      .replace(/\s+(?:please|thanks|ok)\b.*$/i, '')
      .replace(/[.,;!]+$/, '')
      .trim();

  const name = clean.match(/\b(?:my name is|call me|i am|i'm)\s+([^,.;\n]{1,40})/i);
  if (name) {
    const value = stripTail(name[1]);
    if (value) facts.push(`name: ${value}`);
  }

  for (const match of clean.matchAll(/\bmy ([\w ]{2,20}?) is\s+([^.,;\n]{1,60})/gi)) {
    const field = match[1].trim().toLowerCase();
    if (field === 'name') continue;
    const value = stripTail(match[2]);
    if (value) facts.push(`${field}: ${value}`);
  }

  const preference = clean.match(/\bi (?:prefer|like|love|use|always use|hate|dislike)\s+([^.,;\n]{1,60})/i);
  if (preference) {
    const value = stripTail(preference[1]);
    if (value) facts.push(`preference: ${value}`);
  }

  if (facts.length === 0 && isMemoryInstruction(raw)) {
    const stripped = clean
      .replace(/^(?:please\s+)?(?:save|remember|keep|note|store)\b/i, '')
      .replace(/\b(?:to|in)\s+(?:your\s+)?(?:memory|mind)\b/i, '')
      .replace(/^(?:that\s+)/i, '')
      .trim();
    if (stripped.length > 1) facts.push(stripped);
  }

  return [...new Set(facts)];
}
