import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';

export interface PortHint {
  port: number;
  source: string;
}

export interface PortResult {
  port: number;
  reachable: boolean;
  status?: number;
  contentType?: string;
  looksLikeApp: boolean;
  hinted: boolean;
  project: boolean;
}

const COMMON_PORTS = [3000, 3001, 4173, 4200, 4321, 5000, 5173, 5174, 8000, 8080, 8888];

export function projectHints(cwd: string): PortHint[] {
  const hints: PortHint[] = [];

  const envPath = join(cwd, '.env');
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
      const match = line.match(/^\s*(?:PORT|VITE_PORT|APP_PORT)\s*=\s*"?(\d{2,5})"?/);
      if (match) hints.push({ port: Number(match[1]), source: '.env' });
    }
  }

  const pkgPath = join(cwd, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string> };
      for (const [name, script] of Object.entries(pkg.scripts ?? {})) {
        const match = script.match(/(?:--port|-p)\s+(\d{2,5})/);
        if (match) hints.push({ port: Number(match[1]), source: `package.json:${name}` });
        if (/\bvite\b/.test(script)) hints.push({ port: 5173, source: `package.json:${name} (vite default)` });
        if (/\bnext\b/.test(script)) hints.push({ port: 3000, source: `package.json:${name} (next default)` });
      }
    } catch {
      return hints;
    }
  }

  return hints;
}

export function projectListeningPorts(cwd: string): PortHint[] {
  const result = spawnSync('ss', ['-tlnp'], { encoding: 'utf8' });
  if (result.error || !result.stdout) return [];
  const found: PortHint[] = [];
  for (const line of result.stdout.split('\n')) {
    const portMatch = line.match(/:(\d{2,5})\s/);
    const pidMatch = line.match(/pid=(\d+)/);
    if (!portMatch || !pidMatch) continue;
    let procCwd: string;
    try {
      procCwd = readlinkSync(`/proc/${pidMatch[1]}/cwd`);
    } catch {
      continue;
    }
    if (procCwd === cwd || procCwd.startsWith(cwd + '/')) {
      found.push({ port: Number(portMatch[1]), source: `pid ${pidMatch[1]} running inside this project` });
    }
  }
  return found;
}

async function probe(port: number, hinted: boolean, project: boolean): Promise<PortResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 700);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { redirect: 'manual', signal: controller.signal });
    const contentType = res.headers.get('content-type') ?? '';
    const looksLikeApp =
      /text\/html|application\/json|javascript/i.test(contentType) || [200, 201, 204, 401, 403].includes(res.status);
    return { port, reachable: true, status: res.status, contentType, looksLikeApp, hinted, project };
  } catch {
    return { port, reachable: false, looksLikeApp: false, hinted, project };
  } finally {
    clearTimeout(timer);
  }
}

export async function detectPorts(
  cwd: string,
): Promise<{ hints: PortHint[]; results: PortResult[] }> {
  const hints = projectHints(cwd);
  const projectPorts = projectListeningPorts(cwd);
  const hintedPorts = new Set(hints.map((h) => h.port));
  const projectSet = new Set(projectPorts.map((h) => h.port));
  const candidates = [...new Set([...projectSet, ...hintedPorts, ...COMMON_PORTS])];
  const results = await Promise.all(
    candidates.map((port) => probe(port, hintedPorts.has(port), projectSet.has(port))),
  );
  results.sort((a, b) => {
    const score = (r: PortResult) =>
      Number(r.project) * 8 + Number(r.hinted) * 4 + Number(r.looksLikeApp) * 2 + Number(r.reachable);
    return score(b) - score(a) || a.port - b.port;
  });
  return { hints: [...projectPorts, ...hints], results };
}
