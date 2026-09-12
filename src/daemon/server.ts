import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { agentAliases, loadConfig } from '../core/config.ts';
import { appendMessage, getCursor, inbox, pendingCount, readMessages, setCursor } from '../core/store.ts';
import { BatonError, validateMessage, type Message } from '../core/schema.ts';
import { audit } from '../core/audit.ts';
import { DAEMON_PORT } from '../core/paths.ts';

interface Waiter {
  agent: string;
  resolve: (messages: Message[]) => void;
  timer: NodeJS.Timeout;
}

const waiters = new Set<Waiter>();
const presence = new Map<string, number>();
let lastCount = -1;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

function aliasesFor(agent: string): string[] {
  return agentAliases(loadConfig().agents, agent).filter((ref) => ref !== agent);
}

function wakeWaiters(): void {
  for (const waiter of [...waiters]) {
    const messages = inbox(waiter.agent, getCursor(waiter.agent), aliasesFor(waiter.agent));
    if (messages.length === 0) continue;
    clearTimeout(waiter.timer);
    waiters.delete(waiter);
    waiter.resolve(messages);
  }
}

function watchLog(): void {
  setInterval(() => {
    const count = readMessages().length;
    if (count !== lastCount) {
      lastCount = count;
      wakeWaiters();
    }
  }, 250).unref();
}

export function startDaemon(port = DAEMON_PORT): ReturnType<typeof createServer> {
  lastCount = readMessages().length;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');

    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { ok: true, uptime: Math.floor(process.uptime()), messages: lastCount });
    }

    if (req.method === 'GET' && url.pathname === '/status') {
      const config = loadConfig();
      return json(res, 200, {
        ok: true,
        messages: readMessages().length,
        agents: config.agents.map((a) => ({
          name: a.name,
          role: a.role,
          pending: pendingCount(a.name, aliasesFor(a.name)),
        })),
        presence: [...presence.entries()].map(([agent, ts]) => ({ agent, lastSeen: ts })),
      });
    }

    if (req.method === 'POST' && url.pathname === '/presence') {
      const body = JSON.parse((await readBody(req)) || '{}') as { agent?: string };
      if (body.agent) presence.set(body.agent, Date.now());
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/send') {
      try {
        const raw = JSON.parse((await readBody(req)) || '{}');
        const message = validateMessage(raw);
        appendMessage(message);
        audit('send', message.from, `${message.to}:${message.type}`);
        return json(res, 200, message);
      } catch (error) {
        const detail = error instanceof BatonError ? error.message : 'invalid message';
        return json(res, 400, { error: detail });
      }
    }

    if (req.method === 'POST' && url.pathname === '/ack') {
      const body = JSON.parse((await readBody(req)) || '{}') as { agent?: string; id?: string };
      if (!body.agent) return json(res, 400, { error: 'agent required' });
      const current = getCursor(body.agent);
      if (body.id) {
        const found = readMessages().find((m) => m.id === body.id);
        if (!found) return json(res, 404, { error: 'no such message' });
        setCursor(body.agent, { ts: found.ts, id: found.id });
      } else {
        const messages = inbox(body.agent, current, aliasesFor(body.agent));
        const last = messages[messages.length - 1];
        if (last) setCursor(body.agent, { ts: last.ts, id: last.id });
      }
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET' && url.pathname === '/inbox') {
      const agent = url.searchParams.get('agent');
      if (!agent) return json(res, 400, { error: 'agent required' });
      const waitMs = Number(url.searchParams.get('wait') ?? '0');
      const peek = url.searchParams.get('peek') === '1';
      const aliases = aliasesFor(agent);

      const deliver = (messages: Message[]) => {
        if (!peek && messages.length > 0) {
          const last = messages[messages.length - 1];
          setCursor(agent, { ts: last.ts, id: last.id });
        }
        json(res, 200, { messages });
      };

      const current = inbox(agent, getCursor(agent), aliases);
      if (current.length > 0 || waitMs <= 0) return deliver(current);

      const waiter: Waiter = {
        agent,
        resolve: deliver,
        timer: setTimeout(() => {
          waiters.delete(waiter);
          deliver(inbox(agent, getCursor(agent), aliases));
        }, Math.min(waitMs, 120000)),
      };
      waiters.add(waiter);
      return;
    }

    return json(res, 404, { error: 'not found' });
  });

  server.listen(port, '127.0.0.1');
  watchLog();
  return server;
}

export function daemonMain(): void {
  const config = loadConfig();
  const port = Number(process.env.BATON_PORT || config.port || DAEMON_PORT);
  const server = startDaemon(port);
  server.on('listening', () => {
    console.log(`batond listening on http://127.0.0.1:${port}`);
    console.log(`log: ~/.baton/log.jsonl`);
  });
}
