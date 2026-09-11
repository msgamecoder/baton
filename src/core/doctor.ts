import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { platform } from 'node:os';
import { detectSplitters, pickSplitter } from './splitter.ts';

const REQUIRED_NODE = '22.6.0';

export interface InstallHint {
  command: string;
  note: string;
}

export interface DoctorReport {
  node: { version: string; ok: boolean; required: string };
  platform: string;
  wsl: boolean;
  splitters: ReturnType<typeof detectSplitters>;
  chosen: string;
  install: InstallHint | null;
}

function nodeOk(): boolean {
  const [major, minor] = process.versions.node.split('.').map(Number);
  const [requiredMajor, requiredMinor] = REQUIRED_NODE.split('.').map(Number);
  return major > requiredMajor || (major === requiredMajor && minor >= requiredMinor);
}

function isWsl(): boolean {
  if (platform() !== 'linux' || !existsSync('/proc/version')) return false;
  try {
    return /microsoft|wsl/i.test(readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}

function has(bin: string): boolean {
  const probe = platform() === 'win32' ? 'where' : 'which';
  const result = spawnSync(probe, [bin], { stdio: 'ignore' });
  return !result.error && result.status === 0;
}

export function installHint(): InstallHint | null {
  const override = process.env.BATON_INSTALL_CMD;
  if (override) return { command: override, note: 'from BATON_INSTALL_CMD' };

  const os = platform();

  if (os === 'win32') {
    return {
      command: 'winget install --id Microsoft.WindowsTerminal -e',
      note: 'Windows Terminal (already present on Windows 11 — then use `wt` as the splitter)',
    };
  }

  if (os === 'darwin') {
    return { command: 'brew install tmux', note: 'tmux via Homebrew (or use WezTerm)' };
  }

  const managers: Array<[string, string]> = [
    ['apt-get', 'sudo apt-get update && sudo apt-get install -y tmux'],
    ['dnf', 'sudo dnf install -y tmux'],
    ['pacman', 'sudo pacman -S --noconfirm tmux'],
    ['zypper', 'sudo zypper install -y tmux'],
    ['apk', 'sudo apk add tmux'],
    ['brew', 'brew install tmux'],
  ];

  for (const [bin, command] of managers) {
    if (has(bin)) return { command, note: `tmux via ${bin}` };
  }

  return {
    command: 'sudo apt-get install -y tmux   # or your package manager',
    note: 'tmux (no package manager detected)',
  };
}

export function doctorReport(): DoctorReport {
  const custom = process.env.BATON_SPLITTER;
  return {
    node: { version: process.versions.node, ok: nodeOk(), required: REQUIRED_NODE },
    platform: `${platform()}${isWsl() ? ' (WSL)' : ''}`,
    wsl: isWsl(),
    splitters: detectSplitters(),
    chosen: pickSplitter(custom).name,
    install: installHint(),
  };
}

export function runInstall(hint: InstallHint): number {
  const result = spawnSync(hint.command, { shell: true, stdio: 'inherit' });
  return result.status ?? 1;
}
