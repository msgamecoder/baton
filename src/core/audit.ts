import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { AUDIT_PATH } from './paths.ts';
import { ensureHome } from './store.ts';

export interface AuditEntry {
  ts: number;
  event: string;
  agent?: string;
  detail?: string;
}

export function audit(event: string, agent?: string, detail?: string): void {
  ensureHome();
  const entry: AuditEntry = { ts: Date.now(), event, agent, detail };
  appendFileSync(AUDIT_PATH, JSON.stringify(entry) + '\n');
}

export function readAudit(limit = 50): AuditEntry[] {
  if (!existsSync(AUDIT_PATH)) return [];
  const entries: AuditEntry[] = [];
  for (const line of readFileSync(AUDIT_PATH, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as AuditEntry);
    } catch {
      return entries;
    }
  }
  return entries.slice(-limit);
}
