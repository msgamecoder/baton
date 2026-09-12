import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { CONFIG_PATH, DEFAULT_PORT } from './paths.ts';
import { ensureHome } from './store.ts';
import type { CustomProviderDef } from '../providers/registry.ts';

export interface AgentConfig {
  /** the agent's own name — the canonical identity and mailbox key (must be unique) */
  name: string;
  /** the pane it lives in: left or right (must be unique) */
  role?: string;
  command?: string;
  provider?: string;
  model?: string;
  modelFlag?: string;
  resumeFlag?: string;
  headless?: string;
  env?: Record<string, string>;
}

export const AGENT_ROLES = ['left', 'right'] as const;

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

/**
 * Every agent gets a role (the pane it owns). Older configs only carry `name`
 * (`left`/`right`), so fill roles in from the old name or the pane position.
 */
export function normalizeAgents(agents: AgentConfig[]): AgentConfig[] {
  return agents.map((agent, index) => {
    if (agent.role) return agent;
    const fallback = AGENT_ROLES[index] ?? `pane-${index + 1}`;
    const role = agent.name === 'left' || agent.name === 'right' ? agent.name : fallback;
    return { ...agent, role };
  });
}

/** Resolve an address that may be an agent's name OR its role to the agent. */
export function resolveAgent(agents: AgentConfig[], ref?: string): AgentConfig | undefined {
  if (!ref) return undefined;
  const needle = ref.trim().toLowerCase();
  if (!needle) return undefined;
  return (
    agents.find((agent) => agent.name.toLowerCase() === needle) ??
    agents.find((agent) => (agent.role ?? '').toLowerCase() === needle)
  );
}

/** How an agent is shown in the UI: "Nova · left". */
export function agentLabel(agent: AgentConfig): string {
  return agent.role ? `${agent.name} · ${agent.role}` : agent.name;
}

/** Every handle for an agent — its name and its role — for matching relay traffic. */
export function agentAliases(agents: AgentConfig[], ref?: string): string[] {
  const agent = resolveAgent(agents, ref);
  if (!agent) return ref ? [ref] : [];
  return [...new Set([agent.name, agent.role].filter((value): value is string => Boolean(value && value.length)))];
}

/** Names that appear more than once (case-insensitive); these must be fixed. */
export function duplicateAgentNames(agents: AgentConfig[]): string[] {
  const counts = new Map<string, number>();
  for (const agent of agents) {
    const key = agent.name.trim().toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, count]) => count > 1).map(([name]) => name);
}

export function defaultConfig(): BatonConfig {
  return {
    agents: [
      { name: 'left', role: 'left' },
      { name: 'right', role: 'right' },
    ],
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
      agents:
        Array.isArray(parsed.agents) && parsed.agents.length > 0
          ? normalizeAgents(parsed.agents)
          : base.agents,
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
