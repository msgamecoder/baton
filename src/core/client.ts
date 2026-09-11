import { loadConfig } from './config.ts';
import { DEFAULT_PORT } from './paths.ts';
import type { Message } from './schema.ts';

export function daemonBase(): string {
  const port = process.env.BATON_PORT || String(loadConfig().port || DEFAULT_PORT);
  return `http://127.0.0.1:${port}`;
}

async function withTimeout(timeoutMs: number, run: (signal: AbortSignal) => Promise<Response>): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

export async function daemonUp(timeoutMs = 400): Promise<boolean> {
  try {
    const res = await withTimeout(timeoutMs, (signal) => fetch(`${daemonBase()}/health`, { signal }));
    return res.ok;
  } catch {
    return false;
  }
}

export async function remoteSend(message: Message): Promise<Message | null> {
  try {
    const res = await withTimeout(5000, (signal) =>
      fetch(`${daemonBase()}/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(message),
        signal,
      }),
    );
    if (!res.ok) return null;
    return (await res.json()) as Message;
  } catch {
    return null;
  }
}

export async function remoteInbox(
  agent: string,
  waitMs: number,
  peek: boolean,
): Promise<Message[] | null> {
  try {
    const params = new URLSearchParams({ agent, wait: String(waitMs), peek: peek ? '1' : '0' });
    const res = await withTimeout(waitMs + 4000, (signal) =>
      fetch(`${daemonBase()}/inbox?${params.toString()}`, { signal }),
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { messages: Message[] };
    return body.messages;
  } catch {
    return null;
  }
}

export async function remoteAck(agent: string, id?: string): Promise<boolean> {
  try {
    const res = await withTimeout(3000, (signal) =>
      fetch(`${daemonBase()}/ack`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agent, id }),
        signal,
      }),
    );
    return res.ok;
  } catch {
    return false;
  }
}

export async function remoteStatus(): Promise<unknown | null> {
  try {
    const res = await withTimeout(2000, (signal) => fetch(`${daemonBase()}/status`, { signal }));
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
