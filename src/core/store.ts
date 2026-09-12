import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BATON_HOME, CURSOR_DIR, LOG_PATH, MEDIA_DIR, MEMORY_DIR } from './paths.ts';
import { parseMessageLine, type Message } from './schema.ts';

export interface Cursor {
  ts: number;
  id: string;
}

const EMPTY_CURSOR: Cursor = { ts: 0, id: '' };

export function ensureHome(): void {
  for (const dir of [BATON_HOME, CURSOR_DIR, MEDIA_DIR, MEMORY_DIR]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  if (!existsSync(LOG_PATH)) writeFileSync(LOG_PATH, '');
}

export function appendMessage(msg: Message): void {
  ensureHome();
  appendFileSync(LOG_PATH, JSON.stringify(msg) + '\n');
}

export function readMessages(): Message[] {
  if (!existsSync(LOG_PATH)) return [];
  const raw = readFileSync(LOG_PATH, 'utf8');
  const out: Message[] = [];
  for (const line of raw.split('\n')) {
    const msg = parseMessageLine(line);
    if (msg) out.push(msg);
  }
  return out;
}

function startIndex(all: Message[], cursor: Cursor): number {
  if (!cursor.id) return 0;
  const byId = all.findIndex((m) => m.id === cursor.id);
  if (byId >= 0) return byId + 1;
  const byTs = all.findIndex((m) => m.ts > cursor.ts);
  return byTs >= 0 ? byTs : 0;
}

export function inbox(agent: string, cursor: Cursor, aliases: string[] = []): Message[] {
  const self = new Set([agent, ...aliases]);
  const targets = new Set([...self, '*']);
  const all = readMessages();
  return all
    .slice(startIndex(all, cursor))
    .filter((m) => targets.has(m.to) && !self.has(m.from));
}

export function getCursor(agent: string): Cursor {
  const path = join(CURSOR_DIR, `${agent}.json`);
  if (!existsSync(path)) return { ...EMPTY_CURSOR };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<Cursor>;
    return { ts: parsed.ts ?? 0, id: parsed.id ?? '' };
  } catch {
    return { ...EMPTY_CURSOR };
  }
}

export function setCursor(agent: string, cursor: Cursor): void {
  ensureHome();
  writeFileSync(join(CURSOR_DIR, `${agent}.json`), JSON.stringify(cursor));
}

export function pendingCount(agent: string, aliases: string[] = []): number {
  return inbox(agent, getCursor(agent), aliases).length;
}

export function tail(n: number): Message[] {
  return readMessages().slice(-n);
}
