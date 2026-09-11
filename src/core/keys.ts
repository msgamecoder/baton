import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { BATON_HOME } from './paths.ts';
import type { Provider } from '../providers/registry.ts';

export function keysFile(): string {
  return `${BATON_HOME}/keys.json`;
}

export function loadKeys(): Record<string, string> {
  if (!existsSync(keysFile())) return {};
  try {
    const parsed = JSON.parse(readFileSync(keysFile(), 'utf8')) as Record<string, string>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeKeys(keys: Record<string, string>): void {
  mkdirSync(dirname(keysFile()), { recursive: true });
  writeFileSync(keysFile(), JSON.stringify(keys, null, 2) + '\n', { mode: 0o600 });
}

export function saveKey(providerId: string, key: string): string {
  const keys = loadKeys();
  keys[providerId] = key;
  writeKeys(keys);
  return keysFile();
}

export function removeKey(providerId: string): void {
  const keys = loadKeys();
  delete keys[providerId];
  writeKeys(keys);
}

export function resolveKey(provider: Provider): string | undefined {
  const stored = loadKeys()[provider.id];
  if (stored) return stored;
  if (provider.keyEnv && process.env[provider.keyEnv]) return process.env[provider.keyEnv];
  return undefined;
}

export function hasKey(provider: Provider): boolean {
  return Boolean(resolveKey(provider));
}
