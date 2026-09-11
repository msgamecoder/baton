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
export const AGENTS_DIR = join(BATON_HOME, 'agents');
export const PRICES_PATH = join(BATON_HOME, 'prices.json');
export const DEFAULT_PORT = 7331;
export const DAEMON_PORT = Number(process.env.BATON_PORT || DEFAULT_PORT);
