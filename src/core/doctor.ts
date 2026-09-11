import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { detectSplitters, pickSplitter, userBinDir, userTmuxPath } from './splitter.ts';

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

export function userInstallAvailable(): boolean {
  return platform() === 'linux' && has('apt-get') && has('dpkg-deb');
}

export function installTmuxUser(): { ok: boolean; path?: string; error?: string } {
  if (!userInstallAvailable()) return { ok: false, error: 'no apt-get/dpkg-deb on this platform' };

  const tmp = mkdtempSync(join(tmpdir(), 'baton-tmux-'));
  try {
    const download = spawnSync('apt-get', ['download', 'tmux'], { cwd: tmp, encoding: 'utf8' });
    if (download.error || download.status !== 0) {
      return { ok: false, error: 'apt-get download tmux failed (offline?)' };
    }

    const deb = readdirSync(tmp).find((file) => file.endsWith('.deb'));
    if (!deb) return { ok: false, error: 'no .deb was downloaded' };

    const extractDir = join(tmp, 'extract');
    const extract = spawnSync('dpkg-deb', ['-x', join(tmp, deb), extractDir], { encoding: 'utf8' });
    if (extract.error || extract.status !== 0) return { ok: false, error: 'dpkg-deb -x failed' };

    const source = join(extractDir, 'usr', 'bin', 'tmux');
    if (!existsSync(source)) return { ok: false, error: 'tmux binary not found in the package' };

    mkdirSync(userBinDir(), { recursive: true });
    copyFileSync(source, userTmuxPath());
    chmodSync(userTmuxPath(), 0o755);

    const check = spawnSync(userTmuxPath(), ['-V'], { encoding: 'utf8' });
    if (check.error || check.status !== 0) return { ok: false, error: 'the unpacked tmux does not run' };

    return { ok: true, path: userTmuxPath() };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
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
    if (has(bin)) return { command, note: `tmux via ${bin} (needs sudo)` };
  }

  return {
    command: 'sudo apt-get install -y tmux   # or your package manager',
    note: 'tmux (no package manager detected)',
  };
}

export function doctorReport(): DoctorReport {
  return {
    node: { version: process.versions.node, ok: nodeOk(), required: REQUIRED_NODE },
    platform: `${platform()}${isWsl() ? ' (WSL)' : ''}`,
    wsl: isWsl(),
    splitters: detectSplitters(),
    chosen: pickSplitter(process.env.BATON_SPLITTER).name,
    install: installHint(),
  };
}

export function runInstall(hint: InstallHint): number {
  const result = spawnSync(hint.command, { shell: true, stdio: 'inherit' });
  return result.status ?? 1;
}
