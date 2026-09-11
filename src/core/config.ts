import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { CONFIG_PATH, DEFAULT_PORT } from './paths.ts';
import { ensureHome } from './store.ts';

export interface AgentConfig {
  name: string;
  command: string;
  provider?: string;
  model?: string;
  env?: Record<string, string>;
}

export interface BatonConfig {
  agents: AgentConfig[];
  splitter?: string;
  port: number;
  maxHop: number;
  autoContinue: boolean;
}

export const DEFAULT_MAX_HOP = 8;

export function defaultConfig(): BatonConfig {
  return {
    agents: [
      { name: 'oc', command: 'opencode', provider: 'opencode' },
      { name: 'cc', command: 'cmd', provider: 'command-code' },
    ],
    port: DEFAULT_PORT,
    maxHop: DEFAULT_MAX_HOP,
    autoContinue: true,
  };
}

export function loadConfig(): BatonConfig {
  const base = defaultConfig();
  if (!existsSync(CONFIG_PATH)) return base;
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as Partial<BatonConfig>;
    return {
      agents: Array.isArray(parsed.agents) && parsed.agents.length > 0 ? parsed.agents : base.agents,
      splitter: parsed.splitter,
      port: typeof parsed.port === 'number' ? parsed.port : base.port,
      maxHop: typeof parsed.maxHop === 'number' ? parsed.maxHop : base.maxHop,
      autoContinue: typeof parsed.autoContinue === 'boolean' ? parsed.autoContinue : base.autoContinue,
    };
  } catch {
    return base;
  }
}

export function saveConfig(config: BatonConfig): void {
  ensureHome();
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
}

export function configExists(): boolean {
  return existsSync(CONFIG_PATH);
}
