import { spawnSync } from 'node:child_process';
import { parseSlash, slashHelp, directiveHelp } from '../core/console.ts';
import { memoryBlock, remember } from '../core/memory.ts';
import { protocolText } from '../core/instructions.ts';
import { getProvider, type Provider } from '../providers/registry.ts';
import { resolveKey, saveKey } from '../core/keys.ts';
import { listModels } from '../providers/client.ts';
import { cheapestFor, cost, loadPrices } from '../core/cost.ts';
import { loadConfig } from '../core/config.ts';
import { buildSystemPrompt, runTurn } from './loop.ts';
import type { ChatMessage } from '../providers/types.ts';

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
}

export interface SessionOptions {
  agent: string;
  provider: Provider;
  model: string;
  apiKey?: string;
  cwd: string;
  autoApprove: boolean;
}

export interface Session {
  handle(input: string, ui: SessionUi): Promise<void>;
  provider(): Provider;
  model(): string;
}

export function createSession(options: SessionOptions): Session {
  let provider = options.provider;
  let model = options.model;
  let apiKey = options.apiKey ?? resolveKey(provider);
  let autoApprove = options.autoApprove;

  const system = (): ChatMessage => ({
    role: 'system',
    content: buildSystemPrompt(options.cwd, `${protocolText()}\n${memoryBlock()}`),
  });
  let messages: ChatMessage[] = [system()];

  const promptForModels = async (): Promise<string[]> => {
    try {
      return await listModels(provider, apiKey);
    } catch {
      return [];
    }
  };

  const slash = async (name: string, args: string[], ui: SessionUi): Promise<'quit' | void> => {
    switch (name) {
      case 'help':
        ui.line(slashHelp());
        return;
      case 'quit':
      case 'exit':
        return 'quit';
      case 'status':
        ui.line(`agent     ${options.agent}`);
        ui.line(`provider  ${provider.id} (${provider.format})`);
        ui.line(`model     ${model}`);
        ui.line(`key       ${apiKey ? 'set' : 'missing'}`);
        ui.line(`tools     ${autoApprove ? 'auto-approve' : 'ask before write/shell'}`);
        ui.line(`messages  ${messages.length - 1}`);
        return;
      case 'models': {
        const models = await promptForModels();
        ui.line(models.length ? models.join('\n') : '(provider returned no models)');
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
        ui.line('conversation cleared');
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
        if (row) ui.line(`${row.id}: $${cost(row, 2000, 800).toFixed(4)} for ~2k in + 800 out`);
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
      case 'update': {
        ui.line('updating baton ...');
        const result = spawnSync('npm', ['install', '-g', 'baton@latest'], { encoding: 'utf8' });
        const out = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
        ui.line(out ? out.split('\n').slice(-3).join('\n') : 'no output');
        ui.line(result.status === 0 ? 'updated — restart baton' : 'update failed (published to npm?)');
        return;
      }
      default:
        ui.line(`unknown command: /${name} (try /help)`);
    }
  };

  const confirmTool = async (toolName: string, args: Record<string, unknown>): Promise<boolean> => {
    if (autoApprove) return true;
    const detail = (args.command as string) ?? (args.path as string) ?? '';
    const { confirm } = await import('../core/prompt.ts');
    return confirm(`run ${toolName} ${String(detail).slice(0, 80)}? [y/N] `);
  };

  return {
    provider: () => provider,
    model: () => model,
    async handle(input: string, ui: SessionUi): Promise<void> {
      const trimmed = input.trim();
      if (!trimmed) return;

      const parsed = parseSlash(trimmed);
      if (parsed) {
        const result = await slash(parsed.name, parsed.args, ui);
        void result;
        return;
      }

      ui.user(trimmed);
      messages.push({ role: 'user', content: trimmed });
      const stream = ui.assistant();
      try {
        const result = await runTurn(messages, {
          provider,
          apiKey,
          model,
          cwd: options.cwd,
          confirm: confirmTool,
          events: {
            onText: (chunk) => stream.append(chunk),
            onToolStart: (call) => ui.line(`-> ${call.name}`, '#e0b070'),
            onToolEnd: (_call, output, isError) => {
              const first = output.split('\n')[0].slice(0, 120);
              ui.line(`${isError ? '! ' : '  '}${first}`, isError ? '#e06c75' : '#6b6b8f');
            },
          },
        });
        messages = result.messages;
      } finally {
        stream.done();
      }
    },
  };
}
