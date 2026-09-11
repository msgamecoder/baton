import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { platform } from 'node:os';
import { AGENTS_DIR } from './paths.ts';
import { ensureHome } from './store.ts';
import type { AgentConfig, BatonConfig } from './config.ts';
import { pickSplitter } from './splitter.ts';

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

function paneCommand(agent: AgentConfig): string {
  return `BATON_AGENT=${agent.name} ${agent.command}`;
}

export function buildUpPlan(config: BatonConfig): UpPlan {
  const splitter = pickSplitter(config.splitter);
  const agents = config.agents;

  if (splitter.name === 'tmux' && agents.length > 0) {
    const commands = [`tmux new-session -d -s baton -n ${agents[0].name} '${paneCommand(agents[0])}'`];
    for (const agent of agents.slice(1)) {
      commands.push(`tmux split-window -h -t baton '${paneCommand(agent)}'`);
    }
    commands.push('tmux attach -t baton');
    return { splitter: 'tmux', commands, note: 'one tmux session, one pane per agent', background: false };
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
    commands: agents.map((agent) => `BATON_AGENT=${agent.name} ${agent.command}  # logs -> ${join(AGENTS_DIR, agent.name + '.log')}`),
    note: `background agents (${platform()}) — logs in ~/.baton/agents`,
    background: true,
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
    const child = spawn(agent.command, [], {
      detached: true,
      stdio: ['ignore', fd, fd],
      shell: true,
      env: { ...process.env, BATON_AGENT: agent.name, ...(agent.env ?? {}) },
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
