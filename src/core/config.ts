import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { CONFIG_PATH, DEFAULT_PORT } from './paths.ts';
import { ensureHome } from './store.ts';
import type { CustomProviderDef } from '../providers/registry.ts';

export interface AgentConfig {
  name: string;
  command?: string;
  provider?: string;
  model?: string;
  modelFlag?: string;
  resumeFlag?: string;
  headless?: string;
  env?: Record<string, string>;
}

export interface BatonConfig {
  agents: AgentConfig[];
  splitter?: string;
  port: number;
  maxHop: number;
  autoContinue: boolean;
  defaultProvider?: string;
  defaultModel?: string;
  autoApprove?: boolean;
  customProviders?: CustomProviderDef[];
}

export const DEFAULT_MAX_HOP = 8;

export function defaultConfig(): BatonConfig {
  return {
    agents: [{ name: 'left' }, { name: 'right' }],
    port: DEFAULT_PORT,
    maxHop: DEFAULT_MAX_HOP,
    autoContinue: true,
    autoApprove: true,
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
      defaultProvider: parsed.defaultProvider,
      defaultModel: parsed.defaultModel,
      autoApprove: typeof parsed.autoApprove === 'boolean' ? parsed.autoApprove : base.autoApprove,
      customProviders: Array.isArray(parsed.customProviders) ? parsed.customProviders : undefined,
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
