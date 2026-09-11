import { spawnSync } from 'node:child_process';
import { platform } from 'node:os';

export type SplitterName = 'tmux' | 'wt' | 'wezterm' | 'pty' | 'none';

export interface Splitter {
  name: SplitterName;
  available: boolean;
  command?: string;
  note: string;
}

function onPath(cmd: string): boolean {
  const probe = platform() === 'win32' ? 'where' : 'which';
  const result = spawnSync(probe, [cmd], { stdio: 'ignore' });
  return !result.error && result.status === 0;
}

export function detectSplitters(): Splitter[] {
  const isWindows = platform() === 'win32';
  return [
    {
      name: 'tmux',
      available: onPath('tmux'),
      command: 'tmux',
      note: 'Linux/macOS/WSL panes',
    },
    {
      name: 'wt',
      available: isWindows && onPath('wt'),
      command: 'wt',
      note: 'Windows Terminal native split panes',
    },
    {
      name: 'wezterm',
      available: onPath('wezterm'),
      command: 'wezterm',
      note: 'Cross-platform multiplexer (Windows/Linux/macOS)',
    },
    {
      name: 'pty',
      available: true,
      note: 'Built-in PTY fallback (cross-platform)',
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
