import { appendMessage, getCursor, inbox, setCursor } from '../core/store.ts';
import { validateMessage } from '../core/schema.ts';
import { daemonUp, remoteAck, remoteInbox, remoteSend } from '../core/client.ts';
import type { Message } from '../core/schema.ts';

export async function sendRelay(from: string, to: string, text: string, type = 'fyi'): Promise<Message> {
  const message = validateMessage({ from, to, type, summary: text });
  if (await daemonUp()) {
    const sent = await remoteSend(message);
    if (sent) return sent;
  }
  appendMessage(message);
  return message;
}

export async function readRelayInbox(agent: string): Promise<Message[]> {
  if (await daemonUp()) {
    const remote = await remoteInbox(agent, 0, false);
    if (remote) return remote;
  }
  const messages = inbox(agent, getCursor(agent));
  const last = messages[messages.length - 1];
  if (last) setCursor(agent, { ts: last.ts, id: last.id });
  return messages;
}

export async function ackRelay(agent: string, id?: string): Promise<boolean> {
  if (await daemonUp()) return remoteAck(agent, id);
  return false;
}
