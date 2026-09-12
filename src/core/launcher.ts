import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { platform } from 'node:os';
import { AGENTS_DIR } from './paths.ts';
import { ensureHome } from './store.ts';
import { AGENT_ROLES, type AgentConfig, type BatonConfig } from './config.ts';
import { pickSplitter, tmuxBin } from './splitter.ts';

/** Place panes by role: the left agent always opens on the left. */
function panesInRoleOrder(agents: AgentConfig[]): AgentConfig[] {
  const rank = (agent: AgentConfig): number => {
    const index = AGENT_ROLES.indexOf((agent.role ?? '') as (typeof AGENT_ROLES)[number]);
    return index === -1 ? AGENT_ROLES.length : index;
  };
  return [...agents].sort((a, b) => rank(a) - rank(b));
}

export interface UpPlan {
  splitter: string;
  commands: string[];
  note: string;
  background: boolean;
}

export interface StartedAgent {
  name: string;
  pid: number | undefined;
  log: string;
}

const PIDS_PATH = join(AGENTS_DIR, 'pids.json');

function batonAgentArgs(agent: AgentConfig, autoApprove = false): string[] {
  const args = ['chat', '--agent', agent.name];
  if (agent.provider) args.push('--provider', agent.provider);
  if (agent.model) args.push('--model', agent.model);
  if (autoApprove) args.push('--yes');
  return args;
}

function batonAgentCommand(agent: AgentConfig, autoApprove = false): string {
  return `${process.execPath} ${process.argv[1]} ${batonAgentArgs(agent, autoApprove).join(' ')}`;
}

function externalAgentCommand(agent: AgentConfig): string {
  const model = agent.model ? ` ${agent.modelFlag ?? '--model'} ${agent.model}` : '';
  return `${agent.command}${model}`;
}

function paneCommand(agent: AgentConfig, autoApprove = false): string {
  if (!agent.command) return `BATON_AGENT=${agent.name} ${batonAgentCommand(agent, autoApprove)}`;
  return `BATON_AGENT=${agent.name} ${externalAgentCommand(agent)}`;
}

export function buildHeadlessCommand(
  agent: AgentConfig,
  prompt: string,
  options: { model?: string; resume?: boolean } = {},
): string {
  if (!agent.headless) {
    throw new Error(
      `agent "${agent.name}" has no "headless" template in ~/.baton/config.json ` +
        '(e.g. "cmd -p {prompt}" or "opencode run {prompt}")',
    );
  }
  const model = options.model ?? agent.model ?? '';
  const resume = options.resume ? (agent.resumeFlag ?? '--continue') : '';
  return agent.headless
    .replaceAll('{prompt}', prompt.replace(/"/g, '\\"'))
    .replaceAll('{model}', model)
    .replaceAll('{resume}', resume)
    .replace(/\s+/g, ' ')
    .trim();
}

export function buildUpPlan(config: BatonConfig): UpPlan {
  const splitter = pickSplitter(config.splitter);
  const agents = panesInRoleOrder(config.agents);

  if (splitter.name === 'tmux' && agents.length > 0) {
    const tmux = tmuxBin();
    const commands = [
      `${tmux} new-session -d -s baton -n ${agents[0].role ?? agents[0].name} '${paneCommand(agents[0], config.autoApprove)}'`,
    ];
    for (const agent of agents.slice(1)) {
      commands.push(`${tmux} split-window -h -t baton '${paneCommand(agent, config.autoApprove)}'`);
    }
    commands.push(`${tmux} set-option -t baton status off`);
    commands.push(`${tmux} set-option -t baton mouse on`);
    commands.push(`${tmux} set-window-option -t baton pane-border-status off`);
    commands.push(`${tmux} set-option -t baton pane-border-style 'fg=colour235,bg=colour235'`);
    commands.push(`${tmux} set-option -t baton pane-active-border-style 'fg=colour235,bg=colour235'`);
    commands.push(`${tmux} set-option -t baton set-titles on`);
    commands.push(`${tmux} set-option -t baton set-titles-string baton`);
    commands.push(`${tmux} select-pane -t baton:0.0`);
    commands.push(`${tmux} attach -t baton`);
    return {
      splitter: 'tmux',
      commands,
      note: 'one tmux session, one pane per agent (status bar off, mouse on)',
      background: false,
    };
  }

  if (splitter.name === 'wt' && agents.length > 0) {
    const parts = [
      `wt.exe -w 0 new-tab --title ${agents[0].name} cmd /k "set BATON_AGENT=${agents[0].name}&& ${agents[0].command}"`,
    ];
    for (const agent of agents.slice(1)) {
      parts.push(`split-pane --title ${agent.name} cmd /k "set BATON_AGENT=${agent.name}&& ${agent.command}"`);
    }
    return { splitter: 'wt', commands: [parts.join(' ; ')], note: 'Windows Terminal, one pane per agent', background: false };
  }

  if (splitter.name === 'wezterm' && agents.length > 0) {
    const commands = agents.map(
      (agent) => `wezterm cli split-pane --cwd . -- BATON_AGENT=${agent.name} ${agent.command}`,
    );
    return {
      splitter: 'wezterm',
      commands,
      note: 'run the first agent in this pane, the rest open as splits',
      background: false,
    };
  }

  return {
    splitter: 'pty',
    commands: agents.map(
      (agent) => `${paneCommand(agent, config.autoApprove)}  # logs -> ${join(AGENTS_DIR, agent.name + '.log')}`,
    ),
    note: `background agents (${platform()}) — logs in ~/.baton/agents`,
    background: true,
  };
}

export function commandExists(command?: string): boolean {
  if (!command) return false;
  const bin = command.trim().split(/\s+/)[0];
  if (!bin) return false;
  const probe = platform() === 'win32' ? 'where' : 'which';
  const result = spawnSync(probe, [bin], { stdio: 'ignore' });
  return !result.error && result.status === 0;
}

export function missingAgentCommands(agents: AgentConfig[]): AgentConfig[] {
  return agents.filter((agent) => Boolean(agent.command) && !commandExists(agent.command));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function runningAgents(): StartedAgent[] {
  if (!existsSync(PIDS_PATH)) return [];
  try {
    const started = JSON.parse(readFileSync(PIDS_PATH, 'utf8')) as StartedAgent[];
    return started.filter((a) => typeof a.pid === 'number' && isAlive(a.pid));
  } catch {
    return [];
  }
}

export function tmuxSessionExists(name = 'baton'): boolean {
  return spawnSync(tmuxBin(), ['has-session', '-t', name], { stdio: 'ignore' }).status === 0;
}

const SHELL_COMMANDS = /^(bash|zsh|sh|fish|dash|ksh|mksh|nu|pwsh|powershell|cmd|cmd\.exe)$/i;

export function tmuxSessionAlive(name = 'baton'): boolean {
  const listed = spawnSync(tmuxBin(), ['list-panes', '-t', name, '-F', '#{pane_current_command}'], {
    encoding: 'utf8',
  });
  if (listed.status !== 0) return false;
  const commands = String(listed.stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (commands.length === 0) return false;
  return commands.some((command) => !SHELL_COMMANDS.test(command.split('/').pop() ?? command));
}

export function tmuxAttach(name = 'baton'): void {
  spawnSync(tmuxBin(), ['attach', '-t', name], { stdio: 'inherit' });
}

export function tmuxPaneCount(name = 'baton'): number {
  const result = spawnSync(tmuxBin(), ['list-panes', '-t', name], { encoding: 'utf8' });
  if (result.error || result.status !== 0 || !result.stdout) return 0;
  return result.stdout.split('\n').filter((line) => line.trim().length > 0).length;
}

export function ensurePanes(config: BatonConfig): { added: number; panes: number; message: string } {
  if (!tmuxSessionExists()) {
    return { added: 0, panes: 0, message: 'no running baton session — start one with `baton`' };
  }
  const agents = panesInRoleOrder(config.agents);
  const wanted = agents.length;
  let panes = tmuxPaneCount();
  let added = 0;
  while (panes < wanted) {
    const agent = agents[panes];
    const command = paneCommand(agent, config.autoApprove);
    const split = spawnSync(tmuxBin(), ['split-window', '-h', '-t', 'baton', command], { encoding: 'utf8' });
    if (split.error || split.status !== 0) break;
    added++;
    panes++;
  }
  spawnSync(tmuxBin(), ['select-pane', '-t', 'baton:0.0'], { stdio: 'ignore' });
  return {
    added,
    panes,
    message: added > 0 ? `added ${added} pane(s) — now ${panes}` : `already ${panes} pane(s)`,
  };
}

export function spawnBackground(config: BatonConfig): StartedAgent[] {
  ensureHome();
  mkdirSync(AGENTS_DIR, { recursive: true });
  const started: StartedAgent[] = [];

  for (const agent of config.agents) {
    const log = join(AGENTS_DIR, `${agent.name}.log`);
    writeFileSync(log, '');
    const fd = openSync(log, 'a');
    const env = { ...process.env, BATON_AGENT: agent.name, ...(agent.env ?? {}) };
    const child = agent.command
      ? spawn(externalAgentCommand(agent), [], {
          detached: true,
          stdio: ['ignore', fd, fd],
          shell: true,
          env,
        })
      : spawn(process.execPath, [process.argv[1] as string, ...batonAgentArgs(agent, config.autoApprove)], {
          detached: true,
          stdio: ['ignore', fd, fd],
          env,
        });
    child.unref();
    closeSync(fd);
    started.push({ name: agent.name, pid: child.pid, log });
  }

  writeFileSync(PIDS_PATH, JSON.stringify(started, null, 2) + '\n');
  return started;
}

export function stopAgents(): number {
  if (!existsSync(PIDS_PATH)) return 0;
  let stopped = 0;
  try {
    const started = JSON.parse(readFileSync(PIDS_PATH, 'utf8')) as StartedAgent[];
    for (const agent of started) {
      if (typeof agent.pid !== 'number') continue;
      try {
        process.kill(-agent.pid, 'SIGTERM');
        stopped++;
      } catch {
        try {
          process.kill(agent.pid, 'SIGTERM');
          stopped++;
        } catch {
          continue;
        }
      }
    }
  } catch {
    return 0;
  }
  return stopped;
}
