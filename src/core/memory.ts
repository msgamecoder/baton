import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { MEMORY_PATH, projectMemoryPath } from "./paths.ts";
import { ensureHome } from "./store.ts";
import { newId } from "./schema.ts";

export interface MemoryEntry {
  id: string;
  ts: number;
  text: string;
  source?: string;
}

const MAX_ENTRIES = 1000;

function resolveMemoryPath(cwd?: string): string {
  if (cwd) return projectMemoryPath(cwd);
  if (process.env.BATON_CWD) return projectMemoryPath(process.env.BATON_CWD);
  return projectMemoryPath(process.cwd());
}

export function allMemory(cwd?: string): MemoryEntry[] {
  const path = resolveMemoryPath(cwd);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as MemoryEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeMemory(entries: MemoryEntry[], cwd?: string): void {
  ensureHome();
  const path = resolveMemoryPath(cwd);
  mkdirSync(path.replace(/\/[^/]+$/, ""), { recursive: true });
  writeFileSync(path, JSON.stringify(entries, null, 2) + "\n");
}

export function remember(text: string, source?: string, cwd?: string): MemoryEntry {
  const entry: MemoryEntry = { id: newId(), ts: Date.now(), text, source };
  const entries = allMemory(cwd);
  entries.push(entry);
  writeMemory(entries.slice(-MAX_ENTRIES), cwd);
  return entry;
}

export function recall(query?: string, cwd?: string): MemoryEntry[] {
  const entries = allMemory(cwd);
  if (!query) return entries;
  const needle = query.toLowerCase();
  return entries.filter((e) => e.text.toLowerCase().includes(needle));
}

export function forget(target?: string, cwd?: string): number {
  const entries = allMemory(cwd);
  if (!target) {
    writeMemory([], cwd);
    return entries.length;
  }
  const kept = entries.filter((e) => e.id !== target && !e.text.toLowerCase().includes(target.toLowerCase()));
  writeMemory(kept, cwd);
  return entries.length - kept.length;
}

export function memoryBlock(limit = 50, cwd?: string): string {
  const entries = allMemory(cwd).slice(-limit);
  if (entries.length === 0) return "";
  return ["", "## Baton memory (keep these — do not lose them)", ...entries.map((e) => `- ${e.text}`), ""].join("\n");
}

export function memoryLines(cwd?: string): string[] {
  const entries = allMemory(cwd);
  if (entries.length === 0) return ["(no memory yet)"];
  return entries.map((entry) => entry.text);
}

export function isMemoryInstruction(text: string): boolean {
  return (
    /^\s*\/?(?:please\s+)?(?:save|remember|keep|note|store)\b/i.test(text) ||
    /^\s*don'?t forget\b/i.test(text)
  );
}

export function rememberFact(fact: string, source?: string, cwd?: string): MemoryEntry | null {
  const trimmed = fact.trim();
  if (!trimmed) return null;
  const needle = trimmed.toLowerCase();
  const existing = allMemory(cwd).find((entry) => entry.text.trim().toLowerCase() === needle);
  if (existing) return null;
  return remember(trimmed, source, cwd);
}

export function extractFacts(text: string): string[] {
  const raw = text.trim();
  if (!raw) return [];
  const clean = raw.replace(/[.!]+$/, "");
  const facts: string[] = [];

  const stripTail = (value: string): string =>
    value
      .replace(/\s+(?:to|in|into)\s+(?:your\s+|the\s+)?(?:memory|mind)\b.*$/i, "")
      .replace(/\s+(?:please|thanks|ok)\b.*$/i, "")
      .replace(/[.,;!]+$/, "")
      .trim();

  const name = clean.match(/\b(?:my name is|call me|i am|i'm)\s+([^,.;\n]{1,40})/i);
  if (name) {
    const value = stripTail(name[1]);
    if (value) facts.push(`name: ${value}`);
  }

  for (const match of clean.matchAll(/\bmy ([\w ]{2,20}?) is\s+([^.,;\n]{1,60})/gi)) {
    const field = match[1].trim().toLowerCase();
    if (field === "name") continue;
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
      .replace(/^(?:please\s+)?(?:save|remember|keep|note|store)\b/i, "")
      .replace(/\b(?:to|in)\s+(?:your\s+)?(?:memory|mind)\b/i, "")
      .replace(/^(?:that\s+)/i, "")
      .trim();
    if (stripped.length > 1) facts.push(stripped);
  }

  return [...new Set(facts)];
}
