import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  ASCIIFontRenderable,
  BoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  MarkdownRenderable,
  ScrollBoxRenderable,
  SyntaxStyle,
  TextRenderable,
  createCliRenderer,
  type CliRenderer,
  type Renderable,
} from '@opentui/core';
import { CONFIG_PATH, MEDIA_DIR } from '../core/paths.ts';
import { protocolText } from '../core/instructions.ts';
import { keysFile, resolveKey, saveKey } from '../core/keys.ts';
import { loadConfig, saveConfig } from '../core/config.ts';
import { allProviders } from '../providers/registry.ts';
import { cheapestFor, cost, loadPrices } from '../core/cost.ts';
import { memoryBlock, memoryLines, rememberFact, type MemoryEntry } from '../core/memory.ts';
import { formatTaskList } from '../agent/tasks.ts';
import { runUpdate, type Session } from '../agent/session.ts';
import { formatTokens, totalTokens } from '../agent/history.ts';

interface Theme {
  bg: string;
  panel: string;
  accent: string;
  text: string;
  dim: string;
  user: string;
  tool: string;
  error: string;
  pick: string;
}

const THEMES: Record<string, Theme> = {
  baton: {
    bg: '#0f0f17', panel: '#181822', accent: '#8b7bd8', text: '#dcdcec',
    dim: '#6b6b8f', user: '#7fd1b9', tool: '#e0b070', error: '#e06c75', pick: '#c8c0ff',
  },
  midnight: {
    bg: '#0b1020', panel: '#141c33', accent: '#5b9dff', text: '#dbe4f5',
    dim: '#66759b', user: '#6ee7b7', tool: '#f2c46d', error: '#f87171', pick: '#a9ccff',
  },
  forest: {
    bg: '#0c1512', panel: '#14231d', accent: '#5fbf8f', text: '#dcece4',
    dim: '#648074', user: '#8fd6a8', tool: '#d9c06a', error: '#e07a7a', pick: '#b6f0d0',
  },
  mono: {
    bg: '#111113', panel: '#1c1c1f', accent: '#b9b9c8', text: '#e6e6ea',
    dim: '#6e6e78', user: '#bfc6d8', tool: '#c8b28a', error: '#d98a8a', pick: '#ffffff',
  },
  daylight: {
    bg: '#f5f5f8', panel: '#ffffff', accent: '#5b4bd6', text: '#1c1c24',
    dim: '#6b6b80', user: '#0f766e', tool: '#b45309', error: '#b91c1c', pick: '#4338ca',
  },
};

export interface ChatUi {
  user(text: string): void;
  assistant(): { set(text: string): void; append(chunk: string): void; done(): void };
  line(text: string, color?: string): void;
  setModel(model: string): void;
  clear(): void;
  ask?(question: string, options: string[]): Promise<string>;
}

export interface ChatAppOptions {
  session: Session;
  agent: string;
  providerName: string;
  model: string;
  cwd: string;
}

type Command = { label: string; detail: string; group: string };

const COMMANDS: Command[] = [
  { group: 'session', label: 'help', detail: 'show this list' },
  { group: 'session', label: 'plan', detail: 'plan first — read-only, no changes' },
  { group: 'session', label: 'build', detail: 'go back to build mode' },
  { group: 'session', label: 'new', detail: 'start a new session' },
  { group: 'session', label: 'sessions', detail: 'switch session' },
  { group: 'session', label: 'export', detail: 'export this session (md, html, json)' },
  { group: 'session', label: 'clear', detail: 'forget this conversation' },
  { group: 'session', label: 'quit', detail: 'exit' },

  { group: 'model', label: 'model', detail: 'switch model' },
  { group: 'model', label: 'provider', detail: 'connect or switch provider' },
  { group: 'model', label: 'key', detail: 'save an api key' },
  { group: 'model', label: 'theme', detail: 'switch theme' },
  { group: 'model', label: 'cost', detail: 'price estimate' },

  { group: 'project', label: 'learn', detail: 'read a folder and remember what matters' },
  { group: 'project', label: 'init', detail: 'write AGENTS.md for handoffs' },
  { group: 'project', label: 'files', detail: 'attach a file' },
  { group: 'project', label: 'diff', detail: 'show uncommitted changes' },
  { group: 'project', label: 'review', detail: 'ask the agent to review the diff' },

  { group: 'baton', label: 'status', detail: 'provider, model, session, tokens' },
  { group: 'baton', label: 'debug', detail: 'paths, versions, config' },
  { group: 'baton', label: 'update', detail: 'update baton and restart' },
  { group: 'baton', label: 'yes', detail: 'toggle auto-approve for tools' },
  { group: 'baton', label: 'memory', detail: 'what baton remembers about you' },
  { group: 'baton', label: 'tasks', detail: 'the task list for this session' },
  { group: 'baton', label: 'copy', detail: 'copy the last reply' },
  { group: 'baton', label: 'context', detail: 'protocol and memory' },
  { group: 'baton', label: 'remember', detail: 'keep a fact across sessions' },

  { group: 'relay', label: 'send', detail: 'message the other agent' },
  { group: 'relay', label: 'inbox', detail: 'read the relay inbox' },
];

const BLURBS: Record<string, string> = {
  'command-code': 'Claude and DeepSeek via Command Code',
  opencode: 'OpenCode Zen',
  'opencode-go': 'Low cost subscription for everyone',
  anthropic: 'Claude (Anthropic) API key',
  openai: 'GPT models',
  google: 'Google Gemini',
  xai: 'Grok',
  mistral: 'Mistral models',
  perplexity: 'Search-grounded answers',
  deepseek: 'Cheapest frontier models',
  moonshot: 'Kimi K2',
  groq: 'Fastest inference',
  together: 'Open models, fine-tuning',
  fireworks: 'Production inference',
  cerebras: 'Wafer-scale speed',
  deepinfra: 'Open model hosting',
  siliconflow: 'China-friendly open models',
  zai: 'GLM models',
  dashscope: 'Qwen models',
  openrouter: '200+ models, one key',
  vercel: 'Vercel AI Gateway',
  litellm: 'Your own proxy',
  ollama: 'Runs on your machine',
  lmstudio: 'Runs on your machine',
  vllm: 'Your own server',
  custom: 'Any OpenAI-compatible URL',
};

interface Row {
  kind: 'header' | 'item' | 'blank';
  label: string;
  detail?: string;
  value?: string;
  checked?: boolean;
}

type Mode =
  | 'command'
  | 'provider'
  | 'theme'
  | 'model'
  | 'sessions'
  | 'export'
  | 'file'
  | 'info'
  | 'custom-format'
  | 'question';

function visibleLength(text: string): number {
  return text.replace(/\u001b\[[0-9;]*m/g, '').length;
}

function pad(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - visibleLength(text)));
}

function clip(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, width - 1)}…` : text;
}

function listFiles(root: string, limit = 400): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0 && out.length < limit) {
    const dir = stack.pop() as string;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry === 'node_modules' || entry === '.git' || entry.startsWith('.')) continue;
      const full = join(dir, entry);
      try {
        if (statSync(full).isDirectory()) stack.push(full);
        else out.push(relative(root, full));
      } catch {
        continue;
      }
    }
  }
  return out.sort();
}

function clipboardImage(): string | null {
  const attempts: Array<[string, string[]]> = [
    ['wl-paste', ['-t', 'image/png']],
    ['xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o']],
  ];
  for (const [cmd, args] of attempts) {
    const result = spawnSync(cmd, args, { maxBuffer: 64 * 1024 * 1024 });
    if (!result.error && result.status === 0 && result.stdout && result.stdout.length > 200) {
      mkdirSync(MEDIA_DIR, { recursive: true });
      const file = join(MEDIA_DIR, `paste-${Date.now()}.png`);
      writeFileSync(file, result.stdout);
      return file;
    }
  }
  return null;
}

function clipboardText(): string | null {
  const attempts: Array<[string, string[]]> = [
    ['wl-paste', ['--no-newline']],
    ['xclip', ['-selection', 'clipboard', '-o']],
  ];
  for (const [cmd, args] of attempts) {
    const result = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    if (!result.error && result.status === 0 && typeof result.stdout === 'string' && result.stdout.length > 0) {
      return result.stdout;
    }
  }
  return null;
}

export async function runChatApp(options: ChatAppOptions): Promise<void> {
  const { session } = options;
  let themeName = 'baton';
  let theme = THEMES[themeName];

  let syntax: SyntaxStyle | null = null;
  try {
    syntax = SyntaxStyle.create();
  } catch {
    syntax = null;
  }

  const renderer: CliRenderer = await createCliRenderer({
    exitOnCtrlC: true,
    backgroundColor: theme.bg,
    screenMode: 'alternate-screen',
    targetFps: 60,
  });

  const root = new BoxRenderable(renderer, {
    id: 'root',
    width: '100%',
    height: '100%',
    flexDirection: 'column',
    paddingLeft: 2,
    paddingRight: 2,
    paddingTop: 1,
    backgroundColor: theme.bg,
  });
  renderer.root.add(root);

  const header = new BoxRenderable(renderer, { id: 'header', flexDirection: 'column', alignItems: 'center', flexShrink: 0 });
  header.add(new ASCIIFontRenderable(renderer, { id: 'wordmark', text: 'BATON', font: 'tiny', color: theme.accent }));
  const subtitle = new TextRenderable(renderer, {
    id: 'subtitle',
    content: `${options.providerName}   ·   ${options.model}`,
    fg: theme.dim,
  });
  header.add(subtitle);
  root.add(header);

  const spacer = new TextRenderable(renderer, { id: 'spacer', content: '', fg: theme.dim, flexShrink: 0 });
  root.add(spacer);

  const scroll = new ScrollBoxRenderable(renderer, { id: 'scroll', flexGrow: 1, width: '100%' });
  scroll.stickyScroll = true;
  scroll.stickyStart = 'bottom';
  scroll.verticalScrollBar.visible = false;
  scroll.horizontalScrollBar.visible = false;
  root.add(scroll);

  const inputBox = new BoxRenderable(renderer, {
    id: 'inputbox',
    border: true,
    borderColor: theme.accent,
    height: 3,
    flexShrink: 0,
    marginTop: 1,
    paddingLeft: 1,
    paddingRight: 1,
    title: ' message ',
    titleAlignment: 'left',
  });
  const input = new InputRenderable(renderer, {
    id: 'input',
    flexGrow: 1,
    placeholder: 'Ask anything…    /  commands    @  files',
    backgroundColor: theme.bg,
    textColor: theme.text,
    placeholderColor: theme.dim,
  });
  inputBox.add(input);
  root.add(inputBox);

  const footer = new TextRenderable(renderer, { id: 'footer', content: '', fg: theme.dim, flexShrink: 0 });
  root.add(footer);

  const overlay = new BoxRenderable(renderer, {
    id: 'overlay',
    position: 'absolute',
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 100,
    visible: false,
  });
  const dialog = new BoxRenderable(renderer, {
    id: 'dialog',
    width: '76%',
    flexDirection: 'column',
    flexShrink: 0,
    border: true,
    borderColor: theme.accent,
    backgroundColor: theme.panel,
    titleAlignment: 'left',
    paddingLeft: 2,
    paddingRight: 2,
    paddingTop: 1,
    paddingBottom: 1,
  });
  overlay.add(dialog);
  renderer.root.add(overlay);

  const addNode = (node: Renderable): void => {
    scroll.content.add(node);
    scroll.scrollTo({ x: 0, y: scroll.scrollHeight });
  };

  const setFooter = (extra?: string): void => {
    const info = session.info();
    const price = loadPrices().find((entry) => entry.id === info.model || info.model.includes(entry.id));
    const money = price ? `  ·  $${cost(price, info.usage.inputTokens, info.usage.outputTokens).toFixed(4)}` : '';
    footer.content = `${session.mode().toUpperCase()}  ·  ${info.id}  ·  ${info.messages} msgs  ·  ${formatTokens(
      totalTokens(info.usage),
    )} tokens${money}${extra ? `  ·  ${extra}` : ''}`;
  };

  let lastReply = '';

  const ui: ChatUi = {
    user(text) {
      addNode(new TextRenderable(renderer, { content: `› ${text}`, fg: theme.user, wrapMode: 'word', selectable: true }));
    },
    assistant() {
      let node: Renderable;
      let markdown: MarkdownRenderable | null = null;
      if (syntax) {
        markdown = new MarkdownRenderable(renderer, {
          content: '',
          syntaxStyle: syntax,
          fg: theme.text,
          streaming: true,
        });
        node = markdown;
      } else {
        node = new TextRenderable(renderer, { content: '', fg: theme.text, wrapMode: 'word' });
      }
      addNode(node);
      let buffer = '';
      const paint = (): void => {
        if (markdown) markdown.content = buffer;
        else (node as TextRenderable).content = buffer;
        scroll.scrollTo({ x: 0, y: scroll.scrollHeight });
      };
      return {
        set(text) {
          buffer = text;
          paint();
        },
        append(chunk) {
          buffer += chunk;
          paint();
        },
        done() {
          lastReply = buffer;
          try {
            if (markdown) markdown.streaming = false;
          } catch {
            /* older versions have no streaming setter */
          }
          addNode(new TextRenderable(renderer, { content: '', fg: theme.dim }));
          setFooter();
        },
      };
    },
    line(text, color) {
      addNode(new TextRenderable(renderer, { content: text, fg: color ?? theme.dim, wrapMode: 'word', selectable: true }));
    },
    setModel(model) {
      subtitle.content = `${options.providerName}   ·   ${model}`;
    },
    clear() {
      for (const child of scroll.content.getChildren()) child.destroyRecursively();
    },
    ask: (question: string, options: string[]) => openQuestion(question, options),
  };

  const run = (command: string): string =>
    (
      spawnSync(command, { shell: true, cwd: options.cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).stdout ?? ''
    ).trim();

  let mode: Mode | null = null;
  let rows: Row[] = [];
  let index = 0;
  let offset = 0;
  let query = '';
  let title = '';
  let modalFooter = '';
  let pendingProvider = '';
  let pendingExport: 'md' | 'html' | 'json' | null = null;
  let paletteHandledAt = 0;
  const WINDOW = 12;

  type InputPurpose = 'key' | 'custom-name' | 'custom-url' | 'custom-key' | 'ask';
  let inputPurpose: InputPurpose | null = null;
  let askResolver: ((answer: string) => void) | null = null;
  let askQuestion = '';
  const draft = { id: '', name: '', baseUrl: '', format: 'openai' as 'openai' | 'anthropic' };

  const closeModal = (): void => {
    mode = null;
    rows = [];
    index = 0;
    offset = 0;
    query = '';
    overlay.visible = false;
  };

  const drawModal = (): void => {
    for (const child of dialog.getChildren()) child.destroyRecursively();
    dialog.title = ` ${title} `;

    const body = rows.slice(offset, offset + WINDOW);
    const labelWidth = Math.min(
      44,
      Math.max(12, ...body.filter((row) => row.kind === 'item').map((row) => visibleLength(row.label))),
    );

    const row = (content: string, fg: string): TextRenderable =>
      new TextRenderable(renderer, { content, fg, height: 1, flexShrink: 0, truncate: true });

    const searchable = mode !== 'info';
    dialog.add(row(searchable ? `Search   ${query}`.trimEnd() : ' ', theme.accent));

    if (body.length === 0) dialog.add(row('   nothing here', theme.dim));

    for (let i = 0; i < body.length; i++) {
      const entry = body[i];
      const realIndex = offset + i;
      if (entry.kind === 'blank') {
        dialog.add(row('', theme.dim));
        continue;
      }
      if (entry.kind === 'header') {
        dialog.add(row(`   ${entry.label}`, theme.accent));
        continue;
      }
      const selected = realIndex === index && mode !== 'info';
      const marker = selected ? '❯' : ' ';
      const check = entry.checked ? '✓' : ' ';
      const label = clip(entry.label, labelWidth);
      const detail = entry.detail ? `  ${clip(entry.detail, 60)}` : '';
      dialog.add(row(`${marker} ${check}  ${pad(label, labelWidth)}${detail}`, selected ? theme.pick : theme.text));
    }

    dialog.add(row('', theme.dim));
    dialog.add(row(modalFooter, theme.dim));
    overlay.visible = true;
  };

  const openInfo = (modalTitle: string, lines: string[]): void => {
    mode = 'info';
    title = modalTitle;
    modalFooter = 'esc close';
    rows = lines.map((line) => ({ kind: 'item' as const, label: line }));
    index = -1;
    offset = 0;
    drawModal();
  };

  const withHeaders = (list: Row[], keyOf: (row: Row) => string, labelOf: (key: string) => string): Row[] => {
    const out: Row[] = [];
    let last = '__';
    for (const row of list) {
      const key = keyOf(row);
      if (key !== last) {
        last = key;
        out.push({ kind: 'header', label: labelOf(key) });
      }
      out.push(row);
    }
    return out;
  };

  const firstItem = (list: Row[]): number => list.findIndex((row) => row.kind === 'item');

  const openCommands = (): void => {
    mode = 'command';
    title = 'Commands';
    modalFooter = '↑/↓ move   ·   enter select   ·   esc close';
    const needle = query.toLowerCase();
    const matches = COMMANDS.filter(
      (command) => !needle || command.label.includes(needle) || command.detail.toLowerCase().includes(needle),
    );
    rows = withHeaders(
      matches.map((command) => ({ kind: 'item' as const, label: command.label, detail: command.detail, value: command.label, group: command.group }) as Row & { group: string }),
      (row) => (row as Row & { group?: string }).group ?? '',
      (key) => key,
    );
    index = firstItem(rows);
    offset = Math.max(0, index - WINDOW + 1);
    drawModal();
  };

  const openProviders = (): void => {
    mode = 'provider';
    title = 'Connect a provider';
    modalFooter = '↑/↓ move   ·   enter connect   ·   esc close';
    const config = loadConfig();
    const list = allProviders(config.customProviders);
    const item = (id: string, name: string, detail: string, checked: boolean): Row => ({
      kind: 'item',
      label: name,
      detail,
      value: id,
      checked,
    });
    const connected = list.filter((provider) => resolveKey(provider));
    const popularIds = ['command-code', 'opencode', 'opencode-go', 'anthropic', 'openai', 'google'];
    const popular = popularIds
      .map((id) => list.find((provider) => provider.id === id))
      .filter((provider): provider is (typeof list)[number] => Boolean(provider) && !resolveKey(provider));
    const rest = list
      .filter((provider) => !resolveKey(provider) && !popularIds.includes(provider.id))
      .sort((a, b) => a.name.localeCompare(b.name));

    const out: Row[] = [];
    const needle = query.toLowerCase();
    const matches = (provider: (typeof list)[number]): boolean =>
      !needle || provider.name.toLowerCase().includes(needle) || provider.id.includes(needle);

    if (connected.filter(matches).length) {
      out.push({ kind: 'header', label: 'Connected' });
      for (const provider of connected) if (matches(provider)) out.push(item(provider.id, provider.name, '', true));
      out.push({ kind: 'blank', label: '' });
    }
    if (popular.filter(matches).length) {
      out.push({ kind: 'header', label: 'Popular' });
      for (const provider of popular) if (matches(provider)) out.push(item(provider.id, provider.name, '', false));
      out.push({ kind: 'blank', label: '' });
    }
    const restMatches = rest.filter(matches);
    if (restMatches.length) {
      out.push({ kind: 'header', label: 'Providers' });
      for (const provider of restMatches) out.push(item(provider.id, provider.name, '', false));
    }
    if (out.length === 0) out.push({ kind: 'item', label: 'no provider matches', value: '' });

    rows = out;
    index = firstItem(rows);
    offset = Math.max(0, index - WINDOW + 1);
    drawModal();
  };

  const openThemes = (): void => {
    mode = 'theme';
    title = 'Switch theme';
    modalFooter = '↑/↓ move   ·   enter select   ·   esc close';
    rows = Object.keys(THEMES).map((name) => ({
      kind: 'item' as const,
      label: name,
      detail: name === themeName ? 'current' : '',
      value: name,
      checked: name === themeName,
    }));
    index = Math.max(0, Object.keys(THEMES).indexOf(themeName));
    offset = 0;
    drawModal();
  };

  const openModels = async (): Promise<void> => {
    mode = 'model';
    title = 'Select model';
    modalFooter = '↑/↓ move   ·   enter select   ·   esc close';
    rows = [{ kind: 'item', label: 'loading models…', value: '' }];
    index = 0;
    offset = 0;
    drawModal();

    const models = await session.models();
    const needle = query.toLowerCase();
    const list: Row[] = models
      .filter((name) => !needle || name.toLowerCase().includes(needle))
      .map((name) => ({
        kind: 'item' as const,
        label: name,
        detail: name === session.model() ? 'current' : '',
        value: name,
      }));
    rows = list.length ? withHeaders(list, (row) => (row.label === session.model() ? 'Current' : 'Available'), (key) => key) : [];
    if (rows.length === 0) rows = [{ kind: 'item', label: 'no models returned — type: model <name>', value: '' }];
    index = firstItem(rows);
    offset = Math.max(0, index - WINDOW + 1);
    drawModal();
  };

  const openSessions = (): void => {
    mode = 'sessions';
    title = 'Sessions';
    modalFooter = '↑/↓ move   ·   enter switch   ·   ctrl+d delete   ·   esc close';
    const needle = query.toLowerCase();
    const records = session.listSessions().filter((record) => !needle || record.id.toLowerCase().includes(needle));
    const list: Row[] = records.map((record) => ({
      kind: 'item' as const,
      label: record.id,
      detail: `${record.messages.filter((m) => m.role !== 'system').length} msgs  ·  ${formatTokens(
        totalTokens(record.usage),
      )} tokens  ·  ${record.model}`,
      value: record.id,
    }));
    const today = new Date();
    const pad2 = (n: number) => String(n).padStart(2, '0');
    const todayKey = `${today.getFullYear()}${pad2(today.getMonth() + 1)}${pad2(today.getDate())}`;
    rows = list.length
      ? withHeaders(
          list,
          (row) => {
            const id = String(row.value);
            return `${id.slice(0, 4)}-${id.slice(4, 6)}-${id.slice(6, 8)}`;
          },
          (key) => (key === todayKey.slice(0, 4) + '-' + todayKey.slice(4, 6) + '-' + todayKey.slice(6, 8) ? 'Today' : key),
        )
      : [{ kind: 'item', label: 'no saved sessions yet', value: '' }];
    index = firstItem(rows);
    offset = Math.max(0, index - WINDOW + 1);
    drawModal();
  };

  const openExport = (): void => {
    mode = 'export';
    title = 'Export session';
    modalFooter = '↑/↓ move   ·   enter export   ·   esc close';
    rows = [
      { kind: 'item', label: 'markdown', detail: '<name>.md', value: 'md' },
      { kind: 'item', label: 'html', detail: '<name>.html', value: 'html' },
      { kind: 'item', label: 'json', detail: '<name>.json', value: 'json' },
    ];
    index = 0;
    offset = 0;
    drawModal();
  };

  const openFiles = (): void => {
    mode = 'file';
    title = 'Attach file';
    modalFooter = '↑/↓ move   ·   enter insert   ·   esc close';
    const needle = query.toLowerCase();
    const files = listFiles(options.cwd)
      .filter((file) => !needle || file.toLowerCase().includes(needle))
      .slice(0, 300);
    rows = files.length
      ? files.map((file) => ({ kind: 'item' as const, label: file, value: file }))
      : [{ kind: 'item', label: 'no matching files', value: '' }];
    index = 0;
    offset = 0;
    drawModal();
  };

  const move = (dir: 1 | -1): void => {
    let i = index + dir;
    while (i >= 0 && i < rows.length && rows[i].kind !== 'item') i += dir;
    if (i < 0 || i >= rows.length) return;
    index = i;
    if (index < offset) offset = index;
    if (index >= offset + WINDOW) offset = index - WINDOW + 1;
    drawModal();
  };

  const doExport = (format: 'md' | 'html' | 'json', name: string): void => {
    try {
      const file = session.exportSession(format, name || `session-${session.info().id}`);
      ui.line(`exported → ${file}`, theme.user);
    } catch (error) {
      ui.line(`export failed: ${error instanceof Error ? error.message : 'error'}`, theme.error);
    }
    setFooter();
  };

  const applyTheme = (name: string): void => {
    themeName = name;
    theme = THEMES[name] ?? THEMES.baton;
    root.backgroundColor = theme.bg;
    inputBox.borderColor = theme.accent;
    dialog.borderColor = theme.accent;
    dialog.backgroundColor = theme.panel;
    subtitle.fg = theme.dim;
    footer.fg = theme.dim;
    input.textColor = theme.text;
    ui.line(`theme → ${name}`, theme.dim);
  };

  const beginInput = (purpose: InputPurpose, boxTitle: string, placeholder: string): void => {
    inputPurpose = purpose;
    inputBox.title = ` ${boxTitle} `;
    input.placeholder = placeholder;
    input.value = '';
    input.focus();
  };

  const endInput = (): void => {
    inputPurpose = null;
    inputBox.title = ' message ';
    input.placeholder = 'Ask anything…    /  commands    @  files';
    input.value = '';
    input.focus();
  };

  const openQuestion = (question: string, options: string[]): Promise<string> => {
    askQuestion = question;
    mode = 'question';
    title = clip(question, 64);
    modalFooter = '↑/↓ move   ·   enter select   ·   esc skip';
    rows = [
      ...options.slice(0, 4).map((option, i) => ({
        kind: 'item' as const,
        label: option,
        detail: i === 0 ? 'Recommended' : '',
        value: option,
      })),
      { kind: 'blank', label: '' },
      { kind: 'item', label: 'Type something…', value: '__type' },
    ];
    index = 0;
    offset = 0;
    drawModal();
    return new Promise((resolve) => {
      askResolver = resolve;
    });
  };

  const openCustomFormat = (): void => {
    mode = 'custom-format';
    title = 'Custom provider — format';
    modalFooter = '↑/↓ move   ·   enter select   ·   esc close';
    rows = [
      { kind: 'item', label: 'openai', detail: 'chat completions', value: 'openai' },
      { kind: 'item', label: 'anthropic', detail: 'messages', value: 'anthropic' },
    ];
    index = 0;
    offset = 0;
    drawModal();
  };

  const finishCustom = (key: string): void => {
    const id =
      (draft.name || 'custom')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || `custom-${Date.now().toString(36)}`;
    const config = loadConfig();
    config.customProviders = [
      ...(config.customProviders ?? []).filter((entry) => entry.id !== id),
      { id, name: draft.name || 'Custom', format: draft.format, baseUrl: draft.baseUrl },
    ];
    saveConfig(config);
    if (key) saveKey(id, key);
    session.setProvider(id);
    ui.line(`connected ${draft.name || id} → ${draft.baseUrl}`, theme.user);
    endInput();
    void openModels();
  };

  const accept = (): void => {
    const row = rows[index];
    if (!row || row.kind !== 'item' || !row.value) return;

    if (mode === 'command') {
      const command = row.value;
      closeModal();
      input.value = '';
      if (command === 'provider') openProviders();
      else if (command === 'theme') openThemes();
      else if (command === 'model') void openModels();
      else if (command === 'sessions') openSessions();
      else if (command === 'export') openExport();
      else if (command === 'files') openFiles();
      else if (['key', 'remember', 'send'].includes(command)) input.value = `/${command} `;
      else void dispatch(`/${command}`);
      input.focus();
      return;
    }

    if (mode === 'provider') {
      const id = row.value;
      const provider = allProviders(loadConfig().customProviders).find((entry) => entry.id === id);
      if (!provider) return;
      if (provider.id === 'custom') {
        closeModal();
        draft.name = '';
        draft.baseUrl = '';
        draft.format = 'openai';
        beginInput('custom-name', 'custom provider — name', 'e.g. My Gateway');
        return;
      }
      if (provider.needsKey && !resolveKey(provider)) {
        closeModal();
        pendingProvider = id;
        beginInput('key', `api key — ${provider.name}`, 'enter confirm   ·   esc cancel');
        return;
      }
      session.setProvider(id);
      ui.line(`provider → ${provider.name}`, theme.user);
      closeModal();
      void openModels();
      return;
    }

    if (mode === 'question') {
      const resolve = askResolver;
      askResolver = null;
      if (row.value === '__type') {
        closeModal();
        beginInput('ask', clip(askQuestion, 44), 'type your answer');
        askResolver = resolve;
        return;
      }
      closeModal();
      resolve?.(String(row.value));
      input.focus();
      return;
    }

    if (mode === 'custom-format') {
      draft.format = row.value === 'anthropic' ? 'anthropic' : 'openai';
      closeModal();
      beginInput('custom-key', `api key — ${draft.name}`, 'enter confirm   ·   esc cancel');
      return;
    }

    if (mode === 'theme') {
      applyTheme(row.value);
      closeModal();
      input.focus();
      return;
    }

    if (mode === 'model') {
      session.setModel(row.value);
      ui.setModel(session.model());
      ui.line(`model → ${row.value}`, theme.dim);
      closeModal();
      input.focus();
      return;
    }

    if (mode === 'sessions') {
      if (session.resume(row.value)) {
        ui.clear();
        ui.line(`resumed ${row.value}`, theme.dim);
        ui.setModel(session.model());
        setFooter();
      }
      closeModal();
      input.focus();
      return;
    }

    if (mode === 'export') {
      const format = (row.value as 'md' | 'html' | 'json') ?? 'md';
      closeModal();
      doExport(format, `session-${session.info().id}`);
      input.focus();
      return;
    }

    if (mode === 'file') {
      const at = input.value.lastIndexOf('@');
      input.value = `${input.value.slice(0, at)}@${row.value} `;
      closeModal();
      input.focus();
    }
  };

  const infoStatus = (): string[] => {
    const info = session.info();
    return [
      `agent      ${options.agent}`,
      `session    ${info.id}`,
      `provider   ${session.provider().id}  (${session.provider().format})`,
      `model      ${info.model}`,
      `messages   ${info.messages}`,
      `tokens     ${info.usage.inputTokens} in  /  ${info.usage.outputTokens} out`,
      `requests   ${info.usage.requests}`,
      `cwd        ${options.cwd}`,
    ];
  };

  const infoCost = (): string[] => {
    const model = session.model();
    const row = loadPrices().find((entry) => entry.id === model || model.includes(entry.id));
    const info = session.info();
    if (!row) {
      return [
        `model      ${model}`,
        'no price entry — add one to ~/.baton/prices.json',
        `cheapest small pick   ${cheapestFor('small').model.id}`,
      ];
    }
    return [
      `model      ${row.id}  (${row.provider})`,
      `input      $${row.in} per 1M tokens`,
      `output     $${row.out} per 1M tokens`,
      `this session   ${totalTokens(info.usage)} tokens`,
      `estimate       $${cost(row, info.usage.inputTokens, info.usage.outputTokens).toFixed(4)} so far`,
    ];
  };

  const infoDebug = (): string[] => {
    const config = loadConfig();
    return [
      `node       ${process.version}`,
      `cli        ${process.argv[1] ?? ''}`,
      `config     ${CONFIG_PATH}`,
      `keys       ${keysFile()}`,
      `cwd        ${options.cwd}`,
      `agents     ${config.agents.map((agent) => agent.name).join(', ')}`,
      `provider   ${session.provider().id}  (${session.provider().format})`,
      `model      ${session.model()}`,
      `hooks      ctrl+v paste   ·   @ files   ·   / commands`,
    ];
  };

  const initAgents = (): void => {
    const file = join(options.cwd, 'AGENTS.md');
    writeFileSync(file, `${protocolText()}\n`);
    ui.line(`wrote ${file}`, theme.user);
  };

  const readCorpus = (target: string): { files: string[]; text: string } => {
    const root = target.startsWith('/') ? target : join(options.cwd, target);
    const files: string[] = [];
    const collect = (path: string): void => {
      let stat;
      try {
        stat = statSync(path);
      } catch {
        return;
      }
      if (stat.isDirectory()) {
        for (const entry of readdirSync(path)) {
          if (entry.startsWith('.') || entry === 'node_modules') continue;
          collect(join(path, entry));
        }
        return;
      }
      if (!/\.(md|txt|json|ts|tsx|js|jsx|html|css)$/i.test(path)) return;
      if (stat.size > 200_000) return;
      files.push(path);
    };
    collect(root);
    const text = files
      .map((file) => `### ${relative(options.cwd, file)}\n${readFileSync(file, 'utf8')}`)
      .join('\n\n')
      .slice(0, 80_000);
    return { files, text };
  };

  const parseFacts = (answer: string): string[] => {
    const start = answer.indexOf('[');
    const end = answer.lastIndexOf(']');
    if (start < 0 || end <= start) return [];
    try {
      const parsed = JSON.parse(answer.slice(start, end + 1)) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).slice(0, 30);
    } catch {
      return [];
    }
  };

  const copyToClipboard = (text: string): boolean => {
    for (const cmd of ['wl-copy', 'xclip -selection clipboard']) {
      const result = spawnSync(cmd, { shell: true, input: text });
      if (!result.error && result.status === 0) return true;
    }
    return false;
  };

  const dispatch = async (line: string): Promise<void> => {
    const raw = line.trim();
    if (!raw.startsWith('/')) {
      await session.handle(line, ui);
      return;
    }
    const trimmed = raw.slice(1);
    const [name, ...args] = trimmed.split(/\s+/);

    if (name === 'quit' || name === 'exit') {
      renderer.destroy();
      return;
    }
    if (name === 'help') {
      openInfo(
        'Commands',
        COMMANDS.map((command) => `/${command.label}   ${command.detail}`),
      );
      return;
    }
    if (name === 'status') return openInfo('Status', infoStatus());
    if (name === 'cost') return openInfo('Cost', infoCost());
    if (name === 'debug') return openInfo('Debug', infoDebug());
    if (name === 'context') {
      return openInfo('Context', [...protocolText().split('\n'), ...memoryBlock().split('\n')].slice(0, 30));
    }
    if (name === 'memory') return openInfo('Memory', memoryLines());
    if (name === 'tasks') return openInfo('Tasks', formatTaskList(session.info().id));
    if (name === 'copy') {
      if (!lastReply) {
        ui.line('nothing to copy yet', theme.dim);
        return;
      }
      const ok = copyToClipboard(lastReply);
      ui.line(ok ? 'copied' : 'no clipboard tool found (install wl-clipboard or xclip)', ok ? theme.user : theme.error);
      return;
    }
    if (name === 'learn') {
      const target = args[0] ?? 'doc';
      const { files, text } = readCorpus(target);
      if (files.length === 0) {
        ui.line(`nothing readable at ${target}`, theme.error);
        return;
      }
      ui.line(`learning from ${files.length} file(s) in ${target}…`, theme.dim);
      try {
        const answer = await session.oneShot(
          `Extract the durable facts from this project documentation that would help a future session work on this project. Reply with ONLY a JSON array of short standalone strings (max 20). Examples: ["project: Lumora is a PWA with an Express backend", "rule: never run plain npm run build for the android app"].\n\n${text}`,
        );
        const facts = parseFacts(answer);
        const saved = facts.map((fact) => rememberFact(fact, 'learn')).filter((entry): entry is MemoryEntry => Boolean(entry));
        if (saved.length === 0) {
          ui.line('nothing new to learn', theme.dim);
          return;
        }
        ui.line(`learned ${saved.length} fact(s)`, theme.user);
        for (const entry of saved.slice(0, 20)) ui.line(`  · ${entry.text}`, theme.dim);
      } catch (error) {
        ui.line(`learn failed: ${error instanceof Error ? error.message : 'error'}`, theme.error);
      }
      return;
    }
    if (name === 'plan') {
      session.setMode('plan');
      setFooter();
      ui.line('plan mode — read-only. Ask for a plan, then I will offer to build it.', theme.tool);
      return;
    }
    if (name === 'build') {
      session.setMode('build');
      setFooter();
      ui.line('build mode', theme.user);
      return;
    }
    if (name === 'init') return initAgents();
    if (name === 'theme') return openThemes();
    if (name === 'provider') return openProviders();
    if (name === 'new') {
      session.newSession();
      ui.clear();
      ui.line(`new session ${session.info().id}`, theme.dim);
      setFooter();
      return;
    }
    if (name === 'diff') {
      const diff = run('git diff --stat');
      return openInfo('Diff', (diff || '(no uncommitted changes)').split('\n'));
    }
    if (name === 'review') {
      const diff = run('git diff');
      if (!diff) {
        ui.line('(no uncommitted changes to review)', theme.dim);
        return;
      }
      await session.handle(`Review my uncommitted changes and point out problems. Here is the diff:\n\n${diff}`, ui);
      return;
    }
    if (name === 'update') {
      ui.line('updating baton…', theme.dim);
      const result = runUpdate();
      ui.line(result.output || '(no output)', theme.dim);
      if (!result.ok) {
        ui.line('update failed — baton is still installed as it was', theme.error);
        return;
      }
      ui.line('updated — restarting…', theme.user);
      setTimeout(() => {
        const argv = process.argv.slice(1);
        try {
          renderer.destroy();
          const child = spawnSync(process.argv[0] as string, argv, { stdio: 'inherit' });
          process.exit(child.status ?? 0);
        } catch {
          console.log('updated. run `baton` to start the new version.');
          process.exit(0);
        }
      }, 400);
      return;
    }
    if (name === 'export') {
      const format = (['md', 'html', 'json'] as const).includes(args[0] as 'md') ? (args[0] as 'md') : null;
      if (!format) return openExport();
      return doExport(format, args[1] ?? '');
    }

    await session.handle(line, ui);
  };

  input.on(InputRenderableEvents.INPUT, () => {
    const value = input.value;
    if (inputPurpose) return;

    if (mode === 'model') {
      query = value.replace(/^\/?model\s*/, '');
      void openModels();
      return;
    }
    if (mode === 'sessions') {
      query = value.replace(/^\/?sessions\s*/, '').replace(/^\/?resume\s*/, '');
      openSessions();
      return;
    }
    if (mode === 'file') {
      query = value.slice(value.lastIndexOf('@') + 1);
      openFiles();
      return;
    }
    if (mode === 'provider') {
      query = value.startsWith('/') ? value.slice(1) : value;
      openProviders();
      return;
    }
    if (mode === 'command') {
      // a space means the user is typing arguments: let Enter dispatch it
      if (!value.startsWith('/') || value.includes(' ')) {
        closeModal();
        return;
      }
      query = value.slice(1);
      openCommands();
      return;
    }

    if (value.startsWith('/') && !value.includes(' ')) {
      query = value.slice(1);
      openCommands();
      return;
    }
    const at = value.lastIndexOf('@');
    if (at >= 0) {
      query = value.slice(at + 1);
      openFiles();
    }
  });

  renderer.keyInput.on('keypress', (key: any) => {
    try {
      handleKey(key);
    } catch (error) {
      ui.line(`key handling failed: ${error instanceof Error ? error.message : 'error'}`, theme.error);
    }
  });

  const handleKey = (key: any): void => {
    if (key?.ctrl && key?.name === 'v') {
      const image = clipboardImage();
      if (image) {
        input.value = `${input.value}@${image} `;
        ui.line(`pasted image → ${image}`, theme.dim);
        closeModal();
        return;
      }
      const text = clipboardText();
      if (text) input.value = `${input.value}${text}`;
      closeModal();
      return;
    }

    if (!mode) {
      if (inputPurpose) {
        if (key?.name === 'escape') {
          pendingProvider = '';
          endInput();
          ui.line('cancelled', theme.dim);
        }
        return;
      }
      if (key?.name === 'escape' && input.value) {
        input.value = '';
      }
      return;
    }

    if (mode === 'info') {
      if (key?.name === 'escape' || key?.name === 'return' || key?.name === 'enter') closeModal();
      return;
    }

    if (inputPurpose) return;

    if (key?.name === 'up') move(-1);
    else if (key?.name === 'down') move(1);
    else if (key?.name === 'tab' || key?.name === 'return' || key?.name === 'enter') {
      paletteHandledAt = Date.now();
      accept();
    } else if (key?.name === 'escape') closeModal();
    else if (mode === 'sessions' && key?.ctrl && key?.name === 'd') {
      const row = rows[index];
      if (row?.value) {
        session.deleteSession(row.value);
        ui.line(`deleted ${row.value}`, theme.dim);
        openSessions();
      }
    }
  };

  input.on(InputRenderableEvents.ENTER, () => {
    if (Date.now() - paletteHandledAt < 120) return;
    const value = input.value;
    input.value = '';

    if (inputPurpose) {
      const answer = value.trim();
      const purpose = inputPurpose;
      if (purpose === 'key' && pendingProvider) {
        if (answer) {
          saveKey(pendingProvider, answer);
          session.setProvider(pendingProvider);
          const provider = allProviders(loadConfig().customProviders).find((entry) => entry.id === pendingProvider);
          ui.line(`connected ${provider?.name ?? pendingProvider}`, theme.user);
        }
        pendingProvider = '';
        endInput();
        if (answer) void openModels();
        return;
      }
      if (purpose === 'custom-name') {
        draft.name = answer || 'Custom';
        beginInput('custom-url', `custom provider — ${draft.name} base url`, 'e.g. https://api.example.com/v1');
        return;
      }
      if (purpose === 'custom-url') {
        if (!answer) {
          ui.line('a base URL is required', theme.error);
          return;
        }
        draft.baseUrl = answer;
        endInput();
        openCustomFormat();
        return;
      }
      if (purpose === 'custom-key') {
        finishCustom(answer);
        return;
      }
      if (purpose === 'ask') {
        const resolve = askResolver;
        askResolver = null;
        endInput();
        resolve?.(answer || '(no answer)');
        return;
      }
      endInput();
      return;
    }

    if (!value.trim()) return;
    closeModal();
    void dispatch(value)
      .then(async () => {
        if (session.mode() === 'plan' && !inputPurpose) {
          const answer = await openQuestion('Ready to build this plan?', [
            'Yes — switch to build mode (Recommended)',
            'Keep planning',
          ]);
          if (/^yes/i.test(answer)) {
            session.setMode('build');
            ui.line('→ build mode', theme.user);
          }
          setFooter();
          input.focus();
        }
      })
      .catch((error: unknown) => {
        ui.line(`error: ${error instanceof Error ? error.message : 'request failed'}`, theme.error);
      })
      .finally(() => {
        setFooter();
        input.focus();
      });
  });

  const TIPS = [
    'you can switch models any time with  /model',
    'connect another provider with  /provider',
    'say  "save my name is … to memory"  and it is kept forever',
    'type  /  to see every command',
    'attach a file with  @ , paste an image with  ctrl+v',
    'plan first with  /plan , then let it build',
    'when it is unsure it asks you instead of guessing',
    '/learn doc   reads a folder and remembers what matters',
    '/resume   brings back an old session with its token count',
  ];
  ui.line(`Welcome to Baton  ·  did you know:  ${TIPS[Math.floor(Math.random() * TIPS.length)]}`, theme.dim);
  ui.line('', theme.dim);
  setFooter();
  input.focus();
}
