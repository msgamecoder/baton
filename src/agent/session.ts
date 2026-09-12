import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseSlash, slashHelp, directiveHelp } from '../core/console.ts';
import {
  extractFacts,
  isMemoryInstruction,
  memoryBlock,
  remember,
  rememberFact,
  type MemoryEntry,
} from '../core/memory.ts';
import { protocolText } from '../core/instructions.ts';
import { getProvider, type Provider } from '../providers/registry.ts';
import { resolveKey, saveKey } from '../core/keys.ts';
import { listModels } from '../providers/client.ts';
import { cheapestFor, cost, loadPrices } from '../core/cost.ts';
import { loadConfig } from '../core/config.ts';
import { setProviderSession } from '../providers/client.ts';
import { buildSystemPrompt, runTurn } from './loop.ts';
import type { ChatMessage, ToolCall } from '../providers/types.ts';
import {
  deleteSessionRecord,
  emptyUsage,
  escapeHtml,
  listSessionRecords,
  newSessionId,
  readSessionRecord,
  saveSessionRecord,
  titleFromMessage,
  totalTokens,
  type SessionRecord,
  type Usage,
} from './history.ts';

export interface StreamHandle {
  set(text: string): void;
  append(chunk: string): void;
  done(): void;
}

export interface SessionUi {
  user(text: string): void;
  assistant(): StreamHandle;
  line(text: string, color?: string): void;
  setModel?(model: string): void;
  ask?(question: string, options: string[]): Promise<string>;
}

export type AgentMode = 'build' | 'plan';

export interface SessionOptions {
  agent: string;
  provider: Provider;
  model: string;
  apiKey?: string;
  cwd: string;
  autoApprove: boolean;
  session?: string;
}

export type ExportFormat = 'md' | 'html' | 'json';

export interface SessionInfo {
  id: string;
  provider: string;
  model: string;
  messages: number;
  usage: Usage;
}

export interface Session {
  handle(input: string, ui: SessionUi): Promise<void>;
  provider(): Provider;
  model(): string;
  sessionId(): string;
  title(): string;
  history(): ChatMessage[];
  abort(): void;
  info(): SessionInfo;
  models(): Promise<string[]>;
  setModel(model: string): void;
  setProvider(id: string): boolean;
  mode(): AgentMode;
  setMode(mode: AgentMode): void;
  oneShot(prompt: string): Promise<string>;
  compact(): Promise<{ before: number; after: number; summary: string }>;
  listSessions(): SessionRecord[];
  resume(id: string): boolean;
  newSession(): void;
  deleteSession(id: string): boolean;
  exportSession(format: ExportFormat, name: string): string;
}

function toMarkdown(record: SessionRecord): string {
  const lines = [
    `# Baton session ${record.id}`,
    '',
    `- agent: ${record.agent}`,
    `- provider: ${record.provider}`,
    `- model: ${record.model}`,
    `- tokens: ${totalTokens(record.usage)} (${record.usage.inputTokens} in / ${record.usage.outputTokens} out)`,
    '',
  ];
  for (const message of record.messages) {
    if (message.role === 'system') continue;
    if (message.role === 'user') lines.push(`## you`, '', message.content, '');
    else if (message.role === 'assistant') lines.push(`## baton`, '', message.content || '_(tool call)_', '');
    else lines.push('```', message.content, '```', '');
  }
  return lines.join('\n');
}

function toHtml(record: SessionRecord): string {
  const body = record.messages
    .filter((message) => message.role !== 'system')
    .map((message) => {
      const who = message.role === 'user' ? 'you' : message.role === 'assistant' ? 'baton' : 'tool';
      return `<section class="${who}"><h2>${who}</h2><pre>${escapeHtml(message.content)}</pre></section>`;
    })
    .join('\n');
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Baton session ${record.id}</title>
<style>
body{background:#0f0f17;color:#dcdcec;font:14px/1.5 ui-monospace,monospace;margin:0;padding:24px}
h1{color:#8b7bd8} h2{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#8b7bd8;margin:0 0 6px}
section{margin:0 0 20px;padding:12px 16px;border-radius:8px;background:#16161f}
section.you{background:#16211d} section.tool{opacity:.7}
pre{white-space:pre-wrap;margin:0}
</style></head>
<body><h1>Baton · ${record.id}</h1>
<p>${record.agent} · ${record.provider} · ${record.model} · ${totalTokens(record.usage)} tokens</p>
${body}
</body></html>`;
}

function writeExport(record: SessionRecord, format: ExportFormat, name: string): string {
  const file = join(process.cwd(), `${name}.${format}`);
  const content =
    format === 'json' ? `${JSON.stringify(record, null, 2)}\n` : format === 'md' ? toMarkdown(record) : toHtml(record);
  writeFileSync(file, content);
  return file;
}

function trimHistory(messages: ChatMessage[], keep = 16): ChatMessage[] {
  if (messages.length <= keep + 8) return messages;
  const cutoff = messages.length - keep;
  return messages.map((message, index) => {
    if (index === 0 || index >= cutoff) return message;
    if (message.role !== 'tool' || message.content.length <= 400) return message;
    return { ...message, content: `${message.content.slice(0, 200)}\n[earlier tool output trimmed to save tokens]` };
  });
}

let confirmHandler: ((question: string) => Promise<boolean>) | null = null;

export function setConfirmHandler(fn: (question: string) => Promise<boolean>): void {
  confirmHandler = fn;
}

export function createSession(options: SessionOptions): Session {
  let provider = options.provider;
  let model = options.model;
  let apiKey = options.apiKey ?? resolveKey(provider);
  let autoApprove = options.autoApprove;
  let turnAbort: AbortController | null = null;
  let agentMode: AgentMode = 'build';

  const system = (): ChatMessage => ({
    role: 'system',
    content: buildSystemPrompt(
      options.cwd,
      `${
        agentMode === 'plan'
          ? 'You are in PLAN mode. Explore the project and produce a concrete, step-by-step plan. You cannot write, edit or run anything in this mode — do not try.'
          : 'You are in BUILD mode. You can read, write and run things (with the user\'s permission).'
      }\n${protocolText()}\n${memoryBlock()}`,
    ),
  });

  let sessionId = options.session ?? newSessionId();
  let title = '';
  let createdAt = Date.now();
  let usage: Usage = emptyUsage();
  let messages: ChatMessage[] = [system()];

  if (options.session) {
    const existing = readSessionRecord(options.session);
    if (existing) {
      sessionId = existing.id;
      createdAt = existing.createdAt;
      usage = existing.usage ?? emptyUsage();
      messages = existing.messages.length ? existing.messages : [system()];
      title = existing.title ?? '';
      if (existing.model) model = existing.model;
      const found = getProvider(existing.provider, loadConfig().customProviders);
      if (found) {
        provider = found;
        apiKey = resolveKey(found);
      }
    }
  }

  const persist = (): void => {
    saveSessionRecord({
      id: sessionId,
      title: title || undefined,
      agent: options.agent,
      provider: provider.id,
      model,
      createdAt,
      updatedAt: Date.now(),
      messages,
      usage,
    });
  };

  const fetchModels = async (): Promise<string[]> => {
    try {
      return await listModels(provider, apiKey);
    } catch {
      return [];
    }
  };

  const slash = async (name: string, args: string[], ui: SessionUi): Promise<void> => {
    switch (name) {
      case 'help':
        ui.line(slashHelp());
        return;
      case 'status':
        ui.line(`session   ${sessionId}`);
        ui.line(`provider  ${provider.id} (${provider.format})`);
        ui.line(`model     ${model}`);
        ui.line(`key       ${apiKey ? 'set' : 'missing'}`);
        ui.line(`messages  ${messages.length - 1}`);
        ui.line(`tokens    ${usage.inputTokens} in / ${usage.outputTokens} out (${totalTokens(usage)} total)`);
        ui.line(`tools     ${autoApprove ? 'auto-approve' : 'ask before write/shell'}`);
        return;
      case 'models': {
        const list = await fetchModels();
        ui.line(list.length ? list.join('\n') : '(provider returned no models)');
        return;
      }
      case 'model': {
        const next = args.join(' ').trim();
        if (!next) {
          ui.line(model);
          return;
        }
        model = next;
        ui.setModel?.(model);
        ui.line(`model -> ${model}`);
        return;
      }
      case 'provider': {
        const id = args[0];
        if (!id) {
          ui.line(provider.id);
          return;
        }
        const next = getProvider(id, loadConfig().customProviders);
        if (!next) {
          ui.line(`unknown provider: ${id}`);
          return;
        }
        provider = next;
        apiKey = resolveKey(provider);
        ui.line(`provider -> ${provider.name}${apiKey ? '' : ` (no key yet — /key ${provider.id} <key>)`}`);
        return;
      }
      case 'key': {
        const [id, ...rest] = args;
        const value = rest.join(' ');
        if (!id || !value) {
          ui.line('usage: /key <provider> <api-key>');
          return;
        }
        saveKey(id, value);
        if (id === provider.id) apiKey = value;
        ui.line(`saved key for ${id}`);
        return;
      }
      case 'yes':
        autoApprove = !autoApprove;
        ui.line(`tool auto-approve -> ${autoApprove ? 'on' : 'off'}`);
        return;
      case 'clear':
        messages = [system()];
        persist();
        ui.line('conversation cleared');
        return;
      case 'resume':
        ui.line('open the resume list: /resume');
        return;
      case 'context':
        ui.line(protocolText());
        ui.line(memoryBlock());
        return;
      case 'remember': {
        const text = args.join(' ').trim();
        if (!text) {
          ui.line('usage: /remember <text>');
          return;
        }
        remember(text, options.agent);
        ui.line('remembered');
        return;
      }
      case 'cost': {
        const row = loadPrices().find((entry) => entry.id === model || model.includes(entry.id));
        if (row) ui.line(`${row.id}: $${cost(row, usage.inputTokens + 2000, 800).toFixed(4)}`);
        else ui.line(`no price for ${model}; cheapest small pick is ${cheapestFor('small').model.id}`);
        return;
      }
      case 'commands':
        ui.line(directiveHelp());
        return;
      case 'send': {
        const [to, ...text] = args;
        if (!to || text.length === 0) {
          ui.line('usage: /send <to> [type] <text>');
          return;
        }
        const { sendRelay } = await import('./relay.ts');
        await sendRelay(options.agent, to, text.join(' '));
        ui.line(`sent to ${to}`);
        return;
      }
      case 'inbox': {
        const { readRelayInbox } = await import('./relay.ts');
        const rows = await readRelayInbox(options.agent);
        if (rows.length === 0) ui.line('(nothing new)');
        for (const row of rows) ui.line(`[${row.from} -> ${row.to}] ${row.type}: ${row.summary}`);
        return;
      }
      default:
        ui.line(`unknown command: /${name} (try /help)`);
    }
  };

  const confirmTool = async (toolName: string, args: Record<string, unknown>): Promise<boolean> => {
    if (autoApprove) return true;
    const detail = (args.command as string) ?? (args.path as string) ?? '';
    const question = `run ${toolName} ${String(detail).slice(0, 80)}?`;
    if (confirmHandler) return confirmHandler(question);
    const { confirm } = await import('../core/prompt.ts');
    return confirm(`${question} [y/N] `);
  };

  const compact = async (): Promise<{ before: number; after: number; summary: string }> => {
    const history = messages.filter((message) => message.role !== 'system');
    const before = history.length;
    if (before <= 6) return { before, after: before, summary: 'nothing to compact yet' };

    const keep = history.slice(-4);
    const older = history.slice(0, -4);
    const transcript = older
      .map((message) => `${message.role}: ${typeof message.content === 'string' ? message.content : ''}`)
      .join('\n')
      .slice(0, 60_000);

    const summary = await runTurn(
      [
        { role: 'system', content: 'You compress conversations. Reply with a dense factual summary only.' },
        {
          role: 'user',
          content: `Summarise this conversation so work can continue without it. Keep decisions, file paths, findings and open questions. Be terse.\n\n${transcript}`,
        },
      ],
      {
        provider,
        apiKey,
        model,
        cwd: options.cwd,
        tools: false,
        readOnly: true,
        maxTurns: 1,
        events: {},
      },
    );

    messages = [
      system(),
      { role: 'user', content: `[summary of the earlier conversation]\n${summary.finalText}` },
      { role: 'assistant', content: 'Understood — continuing from that summary.' },
      ...keep,
    ];
    usage.inputTokens += summary.usage.inputTokens;
    usage.outputTokens += summary.usage.outputTokens;
    persist();
    return { before, after: messages.length - 1, summary: summary.finalText };
  };

  const historySize = (): number =>
    messages.reduce((total, message) => total + (typeof message.content === 'string' ? message.content.length : 0), 0);

  const toolLabel = (call: ToolCall): { text: string; color: string } => {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(call.arguments || '{}') as Record<string, unknown>;
    } catch {
      args = {};
    }
    const lines = (value: unknown): number =>
      typeof value === 'string' && value.length > 0 ? value.split('\n').length : 0;
    const path = String(args.path ?? '');

    switch (call.name) {
      case 'edit_file':
        return { text: `EDIT   ${path}   +${lines(args.new_string)} −${lines(args.old_string)}`, color: '#7fd1b9' };
      case 'write_file':
        return { text: `WRITE  ${path}   (${lines(args.content)} lines)`, color: '#7fd1b9' };
      case 'read_file':
        return { text: `READ   ${path}`, color: '#6b6b8f' };
      case 'list_dir':
        return { text: `LIST   ${path || '.'}`, color: '#6b6b8f' };
      case 'glob':
        return { text: `GLOB   ${String(args.pattern ?? '')}`, color: '#6b6b8f' };
      case 'grep':
        return { text: `GREP   ${String(args.pattern ?? '')}`, color: '#6b6b8f' };
      case 'shell':
        return { text: `SHELL  ${String(args.command ?? '').slice(0, 110)}`, color: '#e0b070' };
      case 'web_search':
        return { text: `WEB    ${String(args.query ?? '')}`, color: '#c8a2ff' };
      case 'web_fetch':
        return { text: `FETCH  ${String(args.url ?? '').slice(0, 90)}`, color: '#c8a2ff' };
      case 'ask_user':
        return { text: `ASK    ${String(args.question ?? '').slice(0, 90)}`, color: '#c8c0ff' };
      case 'task_create':
        return { text: `TASK   + ${String(args.subject ?? '')}`, color: '#8b7bd8' };
      case 'task_update':
        return { text: `TASK   ${String(args.id ?? '')} → ${String(args.status ?? '')}`, color: '#8b7bd8' };
      case 'task_list':
        return { text: 'TASK   list', color: '#8b7bd8' };
      default:
        return { text: call.name.toUpperCase(), color: '#6b6b8f' };
    }
  };

  return {
    provider: () => provider,
    model: () => model,
    sessionId: () => sessionId,
    title: () => title || sessionId,
    history: () => messages.filter((message) => message.role !== 'system'),
    abort: () => {
      try {
        turnAbort?.abort();
      } catch {
        /* nothing in flight */
      }
    },
    info: () => ({ id: sessionId, provider: provider.id, model, messages: messages.length - 1, usage }),
    models: fetchModels,
    setModel: (next: string) => {
      model = next;
    },
    setProvider: (id: string): boolean => {
      const next = getProvider(id, loadConfig().customProviders);
      if (!next) return false;
      provider = next;
      apiKey = resolveKey(next);
      return true;
    },
    mode: () => agentMode,
    setMode: (next: AgentMode) => {
      agentMode = next;
      if (messages.length > 0 && messages[0].role === 'system') messages[0] = system();
    },
    oneShot: async (prompt: string): Promise<string> => {
      const result = await runTurn(
        [
          { role: 'system', content: system().content },
          { role: 'user', content: prompt },
        ],
        {
          provider,
          apiKey,
          model,
          cwd: options.cwd,
          sessionId,
          readOnly: true,
          tools: false,
          maxTurns: 1,
          events: {},
        },
      );
      usage.inputTokens += result.usage.inputTokens;
      usage.outputTokens += result.usage.outputTokens;
      usage.requests += 1;
      persist();
      return result.finalText;
    },
    compact,
    listSessions: () => listSessionRecords(),
    deleteSession: (id: string) => deleteSessionRecord(id),
    newSession: () => {
      sessionId = newSessionId();
      setProviderSession(sessionId);
      title = '';
      createdAt = Date.now();
      usage = emptyUsage();
      messages = [system()];
      persist();
    },
    resume: (id: string): boolean => {
      const record = readSessionRecord(id);
      if (!record) return false;
      sessionId = record.id;
      setProviderSession(sessionId);
      title = record.title ?? '';
      createdAt = record.createdAt;
      usage = record.usage ?? emptyUsage();
      messages = record.messages.length ? record.messages : [system()];
      if (record.model) model = record.model;
      const found = getProvider(record.provider, loadConfig().customProviders);
      if (found) {
        provider = found;
        apiKey = resolveKey(found);
      }
      return true;
    },
    exportSession: (format: ExportFormat, name: string): string => {
      persist();
      const record =
        readSessionRecord(sessionId) ??
        ({
          id: sessionId,
          agent: options.agent,
          provider: provider.id,
          model,
          createdAt,
          updatedAt: Date.now(),
          messages,
          usage,
        } satisfies SessionRecord);
      return writeExport(record, format, name);
    },
    async handle(input: string, ui: SessionUi): Promise<void> {
      const trimmed = input.trim();
      if (!trimmed) return;

      const parsed = parseSlash(trimmed);
      if (parsed) {
        await slash(parsed.name, parsed.args, ui);
        return;
      }

      const facts = extractFacts(trimmed);
      if (facts.length > 0) {
        const saved = facts
          .map((fact) => rememberFact(fact, options.agent))
          .filter((entry): entry is MemoryEntry => Boolean(entry));
        if (saved.length > 0) {
          ui.line(`remembered: ${saved.map((entry) => entry.text).join('   ·   ')}`, '#7fd1b9');
        }
        if (isMemoryInstruction(trimmed) && saved.length > 0) {
          persist();
          return;
        }
      }

      ui.user(trimmed);
      if (!title) title = titleFromMessage(trimmed);
      messages.push({ role: 'user', content: trimmed });
      messages = trimHistory(messages);
      if (historySize() > 60_000) {
        try {
          const result = await compact();
          ui.line(`auto-compacted ${result.before} → ${result.after} messages`, '#e0b070');
        } catch {
          /* keep going even if compaction fails */
        }
      }
      const stream = ui.assistant();
      turnAbort = new AbortController();
      try {
        const result = await runTurn(messages, {
          provider,
          apiKey,
          model,
          cwd: options.cwd,
          confirm: confirmTool,
          ask: ui.ask ? (question, choices) => ui.ask!(question, choices) : undefined,
          sessionId,
          signal: turnAbort.signal,
          readOnly: agentMode === 'plan',
          events: {
            onText: (chunk) => stream.append(chunk),
            onRetry: (attempt, message) =>
              ui.line(`connecting… retry ${attempt}/10  (${message.slice(0, 90)})`, '#e0b070'),
            onToolStart: (call) => {
              const label = toolLabel(call);
              ui.line(label.text, label.color);
            },
            onToolEnd: (_call, output, isError) => {
              const first = output.split('\n')[0].slice(0, 120);
              ui.line(`   └ ${first}`, isError ? '#e06c75' : '#565672');
            },
          },
        });
        messages = result.messages;
        usage.inputTokens += result.usage.inputTokens;
        usage.outputTokens += result.usage.outputTokens;
        usage.requests += 1;
      } finally {
        stream.done();
        persist();
      }
    },
  };
}

export function runUpdate(): { ok: boolean; output: string } {
  const sourceDir = (() => {
    try {
      return join(dirname(new URL(import.meta.url).pathname), '..', '..');
    } catch {
      return '';
    }
  })();

  const published = spawnSync('npm', ['install', '-g', 'baton@latest', '--no-fund', '--no-audit'], {
    encoding: 'utf8',
  });
  if (published.status === 0) {
    const check = spawnSync('which', ['baton'], { encoding: 'utf8' });
    if (check.status === 0) {
      return { ok: true, output: 'installed from npm' };
    }
  }

  if (sourceDir && existsSync(join(sourceDir, 'package.json'))) {
    const local = spawnSync('npm', ['install', '-g', sourceDir, '--no-fund', '--no-audit'], { encoding: 'utf8' });
    const output = `${local.stdout ?? ''}${local.stderr ?? ''}`.trim().split('\n').slice(-2).join('\n');
    const check = spawnSync('which', ['baton'], { encoding: 'utf8' });
    if (local.status === 0 && check.status === 0) {
      return { ok: true, output: `reinstalled from ${sourceDir}` };
    }
    return { ok: false, output: output || 'install failed' };
  }

  return { ok: false, output: 'baton is not published to npm yet and no local checkout was found' };
}
