import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { platform } from 'node:os';
import { BATON_HOME } from './paths.ts';

export type SplitterName = 'tmux' | 'wt' | 'wezterm' | 'pty' | 'none';

export interface Splitter {
  name: SplitterName;
  available: boolean;
  command?: string;
  note: string;
}

export function userBinDir(): string {
  return join(BATON_HOME, 'bin');
}

export function userTmuxPath(): string {
  return join(userBinDir(), 'tmux');
}

function resolveBinary(name: string, userPath?: string): string | null {
  if (userPath && existsSync(userPath)) return userPath;
  const probe = platform() === 'win32' ? 'where' : 'which';
  const result = spawnSync(probe, [name], { encoding: 'utf8' });
  if (result.error || result.status !== 0 || !result.stdout) return null;
  const first = result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)[0];
  return first ?? null;
}

export function tmuxBin(): string {
  return resolveBinary('tmux', userTmuxPath()) ?? 'tmux';
}

export function detectSplitters(): Splitter[] {
  const isWindows = platform() === 'win32';
  const tmux = resolveBinary('tmux', userTmuxPath());
  const wezterm = resolveBinary('wezterm');
  const wt = isWindows ? resolveBinary('wt') : null;

  return [
    {
      name: 'tmux',
      available: Boolean(tmux),
      command: tmux ?? undefined,
      note: tmux === userTmuxPath() ? 'tmux (installed by baton, no sudo)' : 'Linux/macOS/WSL panes',
    },
    {
      name: 'wt',
      available: Boolean(wt),
      command: wt ?? undefined,
      note: 'Windows Terminal native split panes',
    },
    {
      name: 'wezterm',
      available: Boolean(wezterm),
      command: wezterm ?? undefined,
      note: 'Cross-platform multiplexer (Windows/Linux/macOS)',
    },
    {
      name: 'pty',
      available: true,
      note: 'Built-in PTY fallback (background, no interface)',
    },
  ];
}

export function pickSplitter(preferred?: string): Splitter {
  const all = detectSplitters();
  if (preferred) {
    const chosen = all.find((s) => s.name === preferred && s.available);
    if (chosen) return chosen;
  }
  const isWindows = platform() === 'win32';
  const order: SplitterName[] = isWindows ? ['wt', 'wezterm', 'pty'] : ['tmux', 'wezterm', 'pty'];
  for (const name of order) {
    const found = all.find((s) => s.name === name && s.available);
    if (found) return found;
  }
  return { name: 'none', available: false, note: 'No splitter available' };
}
