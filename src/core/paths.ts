import { homedir } from 'node:os';
import { join } from 'node:path';

export const BATON_HOME = process.env.BATON_HOME || join(homedir(), '.baton');
export const LOG_PATH = join(BATON_HOME, 'log.jsonl');
export const CONFIG_PATH = join(BATON_HOME, 'config.json');
export const CURSOR_DIR = join(BATON_HOME, 'cursors');
export const MEDIA_DIR = join(BATON_HOME, 'media');
export const MEMORY_DIR = join(BATON_HOME, 'memory');
export const MEMORY_PATH = join(MEMORY_DIR, 'memory.json');
export const AUDIT_PATH = join(BATON_HOME, 'audit.jsonl');
export const SESSIONS_DIR = join(BATON_HOME, 'sessions');
export const CHAT_DIR = join(BATON_HOME, 'chats');
export const TASKS_DIR = join(BATON_HOME, 'tasks');
export const AGENTS_DIR = join(BATON_HOME, 'agents');
export const PRICES_PATH = join(BATON_HOME, 'prices.json');
export const DEFAULT_PORT = 7331;
export const DAEMON_PORT = Number(process.env.BATON_PORT || DEFAULT_PORT);

import { createHash } from 'node:crypto';
import { basename, resolve } from 'node:path';

export const PROJECTS_DIR = join(BATON_HOME, 'projects');

export function projectKey(cwd: string = process.cwd()): string {
  const resolved = resolve(cwd);
  const name = (basename(resolved) || 'root').replace(/[^a-zA-Z0-9._-]/g, '_');
  const hash = createHash('sha1').update(resolved).digest('hex').slice(0, 8);
  return `${name}-${hash}`;
}

export function projectDir(cwd: string = process.cwd()): string {
  return join(PROJECTS_DIR, projectKey(cwd));
}

export function projectChatDir(cwd: string = process.cwd()): string {
  return join(projectDir(cwd), 'chats');
}

export function projectMemoryPath(cwd: string = process.cwd()): string {
  return join(projectDir(cwd), 'memory.json');
}
