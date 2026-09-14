import { createInterface } from 'node:readline';
import { agentAliases, loadConfig, resolveAgent } from '../core/config.ts';
import { appendMessage, getCursor, inbox, pendingCount, readMessages, setCursor } from '../core/store.ts';
import { validateMessage, BatonError } from '../core/schema.ts';
import { memoryBlock, remember } from '../core/memory.ts';
import { protocolText } from '../core/instructions.ts';
import { audit } from '../core/audit.ts';

const SERVER_INFO = { name: 'baton', version: '0.1.0' };
const PROTOCOL_VERSION = '2024-11-05';

function selfAgent(): string {
  const config = loadConfig();
  const ref = process.env.BATON_AGENT || config.agents[0]?.name || 'agent';
  return resolveAgent(config.agents, ref)?.name ?? ref;
}

function aliasesFor(agent: string): string[] {
  return agentAliases(loadConfig().agents, agent).filter((ref) => ref !== agent);
}

/** Accept a name or a role; fall back to the caller's own identity. */
function canonical(ref: unknown): string {
  const value = typeof ref === 'string' && ref.trim() ? ref.trim() : selfAgent();
  return resolveAgent(loadConfig().agents, value)?.name ?? value;
}

function text(value: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

const TOOLS = [
  {
    name: 'relay_send',
    description:
      'Send a handoff, question, error, or status to another agent. Use this instead of asking the user to relay. Include what you built and what the peer should do next.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'recipient agent name, or * to broadcast' },
        summary: { type: 'string', description: 'one-line summary' },
        type: { type: 'string', enum: ['handoff', 'blocked', 'error', 'question', 'answer', 'ack', 'done', 'fyi'] },
        priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
        body: { type: 'string' },
        next: { type: 'array', items: { type: 'string' }, description: 'actions the peer should take' },
        built: { type: 'array', items: { type: 'string' }, description: 'files/paths produced' },
        attach: { type: 'array', items: { type: 'string' }, description: 'file paths, e.g. screenshots' },
        replyRequired: { type: 'boolean' },
        inReplyTo: { type: 'string' },
        hop: { type: 'number', description: 'handoff depth; increment when passing work on' },
      },
      required: ['to', 'summary'],
    },
  },
  {
    name: 'relay_inbox',
    description: 'Read messages addressed to you. Check this at the end of every turn before finishing.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string' },
        peek: { type: 'boolean', description: 'read without marking as read' },
        wait: { type: 'number', description: 'milliseconds to wait for a message (0 = no wait)' },
      },
    },
  },
  {
    name: 'relay_ack',
    description: 'Acknowledge messages up to a given id (or all currently pending).',
    inputSchema: { type: 'object', properties: { agent: { type: 'string' }, id: { type: 'string' } } },
  },
  {
    name: 'relay_status',
    description: 'Show agents, pending message counts, and total messages on the relay.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'relay_remember',
    description: 'Persist a fact the user asked you to keep. It is re-injected every session.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'relay_context',
    description: 'Load the Baton protocol and saved memory. Call this at the start of a session.',
    inputSchema: { type: 'object', properties: {} },
  },
];

interface RpcRequest {
  jsonrpc: string;
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

function callTool(name: string, args: Record<string, unknown>): unknown {
  switch (name) {
    case 'relay_send': {
      const config = loadConfig();
      const toRef = String(args.to ?? '');
      const message = validateMessage({
        from: selfAgent(),
        to: toRef === '*' ? '*' : (resolveAgent(config.agents, toRef)?.name ?? toRef),
        project: process.cwd(),
        summary: args.summary,
        type: args.type,
        priority: args.priority,
        body: args.body,
        next: args.next,
        built: Array.isArray(args.built) ? (args.built as string[]).map((path) => ({ path })) : undefined,
        attachments: Array.isArray(args.attach) ? (args.attach as string[]).map((path) => ({ path })) : undefined,
        replyRequired: args.replyRequired,
        inReplyTo: args.inReplyTo,
        hop: args.hop,
      });
      appendMessage(message);
      audit('send', message.from, `${message.to}:${message.type}`);
      return { ok: true, id: message.id };
    }
    case 'relay_inbox': {
      const agent = canonical(args.agent);
      const project = process.cwd();
      const messages = inbox(agent, getCursor(agent, project), aliasesFor(agent), project);
      if (!args.peek && messages.length > 0) {
        const last = messages[messages.length - 1];
        setCursor(agent, { ts: last.ts, id: last.id }, project);
      }
      return messages;
    }
    case 'relay_ack': {
      const agent = canonical(args.agent);
      const project = process.cwd();
      if (args.id) {
        const found = readMessages().find((m) => m.id === args.id);
        if (!found) throw new BatonError(`no message with id ${String(args.id)}`);
        setCursor(agent, { ts: found.ts, id: found.id }, project);
      } else {
        const messages = inbox(agent, getCursor(agent, project), aliasesFor(agent), project);
        const last = messages[messages.length - 1];
        if (last) setCursor(agent, { ts: last.ts, id: last.id }, project);
      }
      return { ok: true };
    }
    case 'relay_status': {
      const config = loadConfig();
      return {
        messages: readMessages().length,
        agents: config.agents.map((a) => ({
          name: a.name,
          role: a.role,
          pending: pendingCount(a.name, aliasesFor(a.name), process.cwd()),
        })),
      };
    }
    case 'relay_remember':
      return remember(String(args.text ?? ''), selfAgent());
    case 'relay_context':
      return protocolText() + memoryBlock();
    default:
      throw new BatonError(`unknown tool: ${name}`);
  }
}

function respond(id: number | string | undefined, result: unknown): void {
  if (id === undefined) return;
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function respondError(id: number | string | undefined, message: string): void {
  if (id === undefined) return;
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message } }) + '\n');
}

export function mcpMain(): void {
  const rl = createInterface({ input: process.stdin });
  let chain: Promise<void> = Promise.resolve();

  rl.on('line', (line) => {
    chain = chain.then(async () => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let request: RpcRequest;
      try {
        request = JSON.parse(trimmed) as RpcRequest;
      } catch {
        return;
      }

      const { id, method, params } = request;
      try {
        if (method === 'initialize') {
          respond(id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
        } else if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
          return;
        } else if (method === 'tools/list') {
          respond(id, { tools: TOOLS });
        } else if (method === 'tools/call') {
          const name = String(params?.name ?? '');
          const args = (params?.arguments as Record<string, unknown>) ?? {};
          respond(id, text(callTool(name, args)));
        } else if (method === 'ping') {
          respond(id, {});
        } else {
          respondError(id, `method not found: ${method}`);
        }
      } catch (error) {
        respondError(id, error instanceof BatonError ? error.message : 'tool failed');
      }
    });
  });
}
