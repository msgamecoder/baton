import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { SESSIONS_DIR } from './paths.ts';
import { ensureHome } from './store.ts';

export function saveSession(name: string, filePath: string): string {
  ensureHome();
  mkdirSync(SESSIONS_DIR, { recursive: true });
  const dest = join(SESSIONS_DIR, `${name}.json`);
  copyFileSync(filePath, dest);
  return dest;
}

export function saveSessionRaw(name: string, json: string): string {
  ensureHome();
  mkdirSync(SESSIONS_DIR, { recursive: true });
  JSON.parse(json);
  const dest = join(SESSIONS_DIR, `${name}.json`);
  writeFileSync(dest, json);
  return dest;
}

export function sessionPath(name: string): string | null {
  const path = join(SESSIONS_DIR, `${name}.json`);
  return existsSync(path) ? path : null;
}

export function listSessions(): string[] {
  if (!existsSync(SESSIONS_DIR)) return [];
  return readdirSync(SESSIONS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => basename(f, '.json'));
}

export function sessionPreview(name: string): string | null {
  const path = sessionPath(name);
  if (!path) return null;
  const raw = readFileSync(path, 'utf8');
  return raw.length > 200 ? raw.slice(0, 200) + '...' : raw;
}
