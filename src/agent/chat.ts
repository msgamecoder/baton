import { createInterface, type Interface } from 'node:readline';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { BATON_HOME, CHAT_DIR } from '../core/paths.ts';
import { loadConfig } from '../core/config.ts';
import { memoryBlock, remember } from '../core/memory.ts';
import { protocolText } from '../core/instructions.ts';
import { getProvider, type Provider } from '../providers/registry.ts';
import { resolveKey } from '../core/keys.ts';
import { buildSystemPrompt, runTurn } from './loop.ts';
import type { ChatMessage, ToolCall } from '../providers/types.ts';
import { listModels } from '../providers/client.ts';

const DIM = '\u001b[2m';
const CYAN = '\u001b[36m';
const YELLOW = '\u001b[33m';
const RESET = '\u001b[0m';

export interface ChatOptions {
  agent: string;
  provider: Provider;
  model: string;
  apiKey?: string;
  cwd: string;
  autoApprove: boolean;
  session?: string;
}

function sessionFile(id: string): string {
  return join(CHAT_DIR, `${id}.json`);
}

function listSessions(): string[] {
  if (!existsSync(CHAT_DIR)) return [];
  return readdirSync(CHAT_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => file.replace(/\.json$/, ''))
    .sort()
    .reverse();
}

function saveSession(id: string, messages: ChatMessage[]): void {
  mkdirSync(CHAT_DIR, { recursive: true });
  writeFileSync(sessionFile(id), JSON.stringify(messages, null, 2));
}

function loadSession(id: string): ChatMessage[] | null {
  const path = sessionFile(id);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ChatMessage[];
  } catch {
    return null;
  }
}

function help(): string {
  return [
    'commands:',
    '  /help                 this list',
    '  /status               provider, model, session, tool policy',
    '  /model [name]         show or switch the model',
    '  /models               list models from this provider',
    '  /provider [id]        show or switch provider (then /key)',
    '  /key <provider> <key> save an API key for a provider',
    '  /yes                  toggle auto-approve for tools (currently: see /status)',
    '  /clear                forget the conversation',
    '  /resume [id]          list or load a saved conversation',
    '  /cost                 price the next request with the current model',
    '  /context              show the protocol + memory being injected',
    '  /remember <text>      keep a fact across sessions',
    '  /send <to> [type] <text>   relay a message to the other agent',
    '  /inbox                read your relay inbox',
    '  /update               update baton itself',
    '  /quit                 leave',
  ].join('\n');
}

export async function startChat(options: ChatOptions): Promise<void> {
  let provider = options.provider;
  let model = options.model;
  let apiKey = options.apiKey ?? resolveKey(provider);
  let autoApprove = options.autoApprove;
  let sessionId = options.session ?? `chat-${Date.now().toString(36)}`;

  const system = () => ({
    role: 'system' as const,
    content: buildSystemPrompt(options.cwd, `${protocolText()}\n${memoryBlock()}`),
  });

  let messages: ChatMessage[] = options.session ? loadSession(sessionId) ?? [system()] : [system()];

  const rl: Interface = createInterface({ input: process.stdin, output: process.stdout, prompt: '' });
  let pendingAsk: ((line: string) => void) | null = null;
  let busy = false;

  const askLine = (question: string): Promise<string> =>
    new Promise((resolve) => {
      pendingAsk = resolve;
      process.stdout.write(question);
    });

  const confirmTool = async (name: string, args: Record<string, unknown>): Promise<boolean> => {
    if (autoApprove) return true;
    const detail = (args.command as string) ?? (args.path as string) ?? '';
    const answer = await askLine(`${YELLOW}${name}${RESET} ${DIM}${String(detail).slice(0, 120)}${RESET}  run? [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  };

  const events = {
    onText: (chunk: string) => process.stdout.write(chunk),
    onToolStart: (call: ToolCall) => process.stdout.write(`\n${CYAN}→ ${call.name}${RESET} `),
    onToolEnd: (call: ToolCall, output: string, isError: boolean) => {
      const first = output.split('\n')[0].slice(0, 120);
      process.stdout.write(`${isError ? YELLOW : DIM}${first}${RESET}\n`);
    },
  };

  console.log(`${DIM}baton${RESET} · ${provider.name} · ${model} · ${options.cwd}`);
  console.log(`${DIM}session ${sessionId} — /help for commands, /quit to leave${RESET}\n`);

  const handle = async (line: string): Promise<'quit' | void> => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (trimmed.startsWith('/')) {
      const [command, ...rest] = trimmed.slice(1).split(/\s+/);
      const argsText = rest.join(' ');
      switch (command) {
        case 'help':
          console.log(help());
          return;
        case 'quit':
        case 'exit':
          return 'quit';
        case 'status':
          console.log(`agent     ${options.agent}`);
          console.log(`provider  ${provider.id} (${provider.format})`);
          console.log(`model     ${model}`);
          console.log(`key       ${apiKey ? 'set' : 'missing'}`);
          console.log(`session   ${sessionId}`);
          console.log(`tools     ${autoApprove ? 'auto-approve' : 'ask before write/shell'}`);
          console.log(`messages  ${messages.length - 1}`);
          return;
        case 'models': {
          try {
            const models = await listModels(provider, apiKey);
            console.log(models.length ? models.join('\n') : '(provider returned no models)');
          } catch (error) {
            console.log(`could not fetch models: ${error instanceof Error ? error.message : 'failed'}`);
          }
          return;
        }
        case 'model': {
          if (!argsText) {
            console.log(model);
            return;
          }
          model = argsText.trim();
          console.log(`model → ${model}`);
          return;
        }
        case 'provider': {
          if (!argsText) {
            console.log(provider.id);
            return;
          }
          const next = getProvider(argsText.trim(), loadConfig().customProviders);
          if (!next) {
            console.log(`unknown provider: ${argsText.trim()}`);
            return;
          }
          provider = next;
          apiKey = resolveKey(provider);
          console.log(`provider → ${provider.name}${apiKey ? '' : ' (no key yet — use /key ' + provider.id + ' <key>)'}`);
          return;
        }
        case 'key': {
          const [id, ...keyParts] = rest;
          const value = keyParts.join(' ');
          if (!id || !value) {
            console.log('usage: /key <provider> <api-key>');
            return;
          }
          const { saveKey } = await import('../core/keys.ts');
          saveKey(id, value);
          if (id === provider.id) apiKey = value;
          console.log(`saved key for ${id}`);
          return;
        }
        case 'yes':
          autoApprove = !autoApprove;
          console.log(`tool auto-approve → ${autoApprove ? 'on' : 'off'}`);
          return;
        case 'clear':
          messages = [system()];
          console.log('conversation cleared');
          return;
        case 'resume': {
          if (!argsText) {
            const sessions = listSessions();
            console.log(sessions.length ? sessions.join('\n') : '(no saved conversations)');
            return;
          }
          const loaded = loadSession(argsText.trim());
          if (!loaded) {
            console.log(`no conversation named ${argsText.trim()}`);
            return;
          }
          messages = loaded;
          sessionId = argsText.trim();
          console.log(`loaded ${sessionId} (${messages.length - 1} messages)`);
          return;
        }
        case 'context':
          console.log(protocolText());
          console.log(memoryBlock());
          return;
        case 'remember': {
          if (!argsText) {
            console.log('usage: /remember <text>');
            return;
          }
          remember(argsText, options.agent);
          console.log('remembered');
          return;
        }
        case 'cost': {
          const { cheapestFor, cost, loadPrices } = await import('../core/cost.ts');
          const prices = loadPrices();
          const match = prices.find((row) => row.id === model || model.includes(row.id));
          if (match) console.log(`${match.id}: $${cost(match, 2000, 800).toFixed(4)} for ~2k in + 800 out`);
          else console.log(`no price for ${model} in ~/.baton/prices.json (cheapest small pick: ${cheapestFor('small').model.id})`);
          return;
        }
        case 'send': {
          const [to, ...restText] = rest;
          if (!to || restText.length === 0) {
            console.log('usage: /send <to> [type] <text>');
            return;
          }
          const { sendRelay } = await import('./relay.ts');
          await sendRelay(options.agent, to, restText.join(' '));
          console.log(`sent to ${to}`);
          return;
        }
        case 'inbox': {
          const { readRelayInbox } = await import('./relay.ts');
          const rows = await readRelayInbox(options.agent);
          if (rows.length === 0) console.log('(nothing new)');
          for (const row of rows) console.log(`[${row.from} → ${row.to}] ${row.type}: ${row.summary}`);
          return;
        }
        case 'update': {
          console.log('updating baton ...');
          const result = spawnSync('npm', ['install', '-g', 'baton@latest'], { encoding: 'utf8' });
          const out = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
          console.log(out ? out.split('\n').slice(-4).join('\n') : 'no output');
          console.log(result.status === 0 ? 'updated — restart baton to use the new version' : 'update failed (is baton published to npm yet?)');
          return;
        }
        default:
          console.log(`unknown command: /${command} (try /help)`);
          return;
      }
    }

    if (busy) return;
    busy = true;
    messages.push({ role: 'user', content: trimmed });
    try {
      const result = await runTurn(messages, {
        provider,
        apiKey,
        model,
        cwd: options.cwd,
        confirm: confirmTool,
        events,
      });
      messages = result.messages;
      saveSession(sessionId, messages);
      process.stdout.write('\n');
    } catch (error) {
      console.log(`\n${YELLOW}error:${RESET} ${error instanceof Error ? error.message : 'request failed'}`);
    } finally {
      busy = false;
    }
  };

  await new Promise<void>((resolve) => {
    let chain: Promise<void> = Promise.resolve();
    rl.on('line', (line) => {
      if (pendingAsk) {
        const resolveAsk = pendingAsk;
        pendingAsk = null;
        resolveAsk(line);
        return;
      }
      chain = chain.then(async () => {
        const outcome = await handle(line);
        if (outcome === 'quit') {
          rl.close();
          return;
        }
        process.stdout.write(`${CYAN}you ›${RESET} `);
      });
    });
    rl.on('close', resolve);
    process.stdout.write(`${CYAN}you ›${RESET} `);
  });

  saveSession(sessionId, messages);
}

export function chatDirs(): string {
  return `${BATON_HOME}/chats`;
}

export { CHAT_DIR };
