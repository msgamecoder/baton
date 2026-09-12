import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  ASCIIFontRenderable,
  BoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  ScrollBoxRenderable,
  TextRenderable,
  createCliRenderer,
  type CliRenderer,
} from '@opentui/core';
import { MEDIA_DIR } from '../core/paths.ts';
import { runUpdate, type Session } from '../agent/session.ts';

const BG = '#0f0f17';
const ACCENT = '#8b7bd8';
const TEXT = '#dcdcec';
const DIM = '#6b6b8f';
const USER = '#7fd1b9';
const TOOL = '#e0b070';
const ERROR = '#e06c75';
const PICK = '#c8c0ff';

export interface ChatUi {
  user(text: string): void;
  assistant(): { set(text: string): void; append(chunk: string): void; done(): void };
  line(text: string, color?: string): void;
  status(text: string): void;
  setModel(model: string): void;
  clear(): void;
}

export interface ChatAppOptions {
  session: Session;
  providerName: string;
  model: string;
  cwd: string;
}

export interface PaletteItem {
  label: string;
  detail?: string;
  value?: string;
}

const COMMANDS: PaletteItem[] = [
  { label: '/help', detail: 'list commands' },
  { label: '/model', detail: 'choose or search a model' },
  { label: '/models', detail: 'list models from the provider' },
  { label: '/resume', detail: 'past sessions — tokens, messages, delete' },
  { label: '/export', detail: 'export this session (md, html, json)' },
  { label: '/update', detail: 'update baton and restart' },
  { label: '/status', detail: 'provider, model, session, tokens' },
  { label: '/provider', detail: 'show or switch provider' },
  { label: '/key', detail: 'save an api key' },
  { label: '/clear', detail: 'forget this conversation' },
  { label: '/yes', detail: 'toggle auto-approve for tools' },
  { label: '/context', detail: 'protocol + memory' },
  { label: '/remember', detail: 'keep a fact across sessions' },
  { label: '/cost', detail: 'price estimate' },
  { label: '/send', detail: 'relay a message to the other agent' },
  { label: '/inbox', detail: 'read the relay inbox' },
  { label: '/quit', detail: 'leave' },
];

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
        const stat = statSync(full);
        if (stat.isDirectory()) stack.push(full);
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
  const renderer: CliRenderer = await createCliRenderer({
    exitOnCtrlC: true,
    backgroundColor: BG,
    screenMode: 'alternate-screen',
    targetFps: 60,
  });

  const root = new BoxRenderable(renderer, {
    id: 'root',
    width: '100%',
    height: '100%',
    flexDirection: 'column',
    padding: 1,
    gap: 0,
    backgroundColor: BG,
  });
  renderer.root.add(root);

  const header = new BoxRenderable(renderer, { id: 'header', flexDirection: 'column', alignItems: 'center', flexShrink: 0 });
  header.add(new ASCIIFontRenderable(renderer, { id: 'wordmark', text: 'BATON', font: 'tiny', color: ACCENT }));
  const subtitle = new TextRenderable(renderer, {
    id: 'subtitle',
    content: `${options.providerName}  ·  ${options.model}`,
    fg: DIM,
  });
  header.add(subtitle);
  root.add(header);

  const chatBox = new BoxRenderable(renderer, { id: 'chat', flexGrow: 1, flexDirection: 'column', paddingX: 1 });
  const scroll = new ScrollBoxRenderable(renderer, { id: 'scroll', flexGrow: 1, width: '100%' });
  scroll.stickyScroll = true;
  scroll.stickyStart = 'bottom';
  scroll.verticalScrollBar.visible = false;
  scroll.horizontalScrollBar.visible = false;
  chatBox.add(scroll);
  root.add(chatBox);

  const paletteBox = new BoxRenderable(renderer, { id: 'palette', flexShrink: 0, flexDirection: 'column', paddingX: 1, visible: false });
  root.add(paletteBox);

  const inputBox = new BoxRenderable(renderer, {
    id: 'inputbox',
    title: ' ask anything ',
    border: true,
    borderColor: ACCENT,
    height: 3,
    flexShrink: 0,
    paddingX: 1,
  });
  const input = new InputRenderable(renderer, {
    id: 'input',
    flexGrow: 1,
    placeholder: 'Ask anything…   / commands   @ files',
    backgroundColor: BG,
    textColor: TEXT,
    placeholderColor: DIM,
  });
  inputBox.add(input);
  root.add(inputBox);

  const footer = new TextRenderable(renderer, { id: 'footer', content: '', fg: DIM, flexShrink: 0 });
  root.add(footer);

  const addNode = (node: TextRenderable): void => {
    scroll.content.add(node);
    scroll.scrollTo({ x: 0, y: scroll.scrollHeight });
  };

  const setFooter = (extra?: string): void => {
    const info = session.info();
    const tokens = info.usage.inputTokens + info.usage.outputTokens;
    footer.content = `${info.id} · ${info.messages} msgs · ${tokens} tokens${extra ? ` · ${extra}` : ''}`;
  };

  const ui: ChatUi = {
    user(text) {
      addNode(new TextRenderable(renderer, { content: `› ${text}`, fg: USER }));
    },
    assistant() {
      const node = new TextRenderable(renderer, { content: '', fg: TEXT });
      addNode(node);
      let buffer = '';
      return {
        set(text) {
          buffer = text;
          node.content = buffer;
          scroll.scrollTo({ x: 0, y: scroll.scrollHeight });
        },
        append(chunk) {
          buffer += chunk;
          node.content = buffer;
          scroll.scrollTo({ x: 0, y: scroll.scrollHeight });
        },
        done() {
          addNode(new TextRenderable(renderer, { content: '', fg: DIM }));
          setFooter();
        },
      };
    },
    line(text, color) {
      addNode(new TextRenderable(renderer, { content: text, fg: color ?? DIM }));
    },
    status(text) {
      footer.content = text;
    },
    setModel(model) {
      subtitle.content = `${options.providerName}  ·  ${model}`;
    },
    clear() {
      for (const child of scroll.content.getChildren()) child.destroyRecursively();
    },
  };

  const doExport = (format: 'md' | 'html' | 'json', name: string): void => {
    try {
      const file = session.exportSession(format, name || `session-${session.info().id}`);
      ui.line(`exported → ${file}`, USER);
    } catch (error) {
      ui.line(`export failed: ${error instanceof Error ? error.message : 'error'}`, ERROR);
    }
    setFooter();
  };

  type Mode = 'command' | 'model' | 'sessions' | 'export' | 'file';
  let mode: Mode | null = null;
  let items: PaletteItem[] = [];
  let index = 0;
  let paletteHandledAt = 0;

  const closePalette = (): void => {
    mode = null;
    items = [];
    index = 0;
    paletteBox.visible = false;
    for (const child of paletteBox.getChildren()) child.destroyRecursively();
  };

  const drawPalette = (): void => {
    for (const child of paletteBox.getChildren()) child.destroyRecursively();
    if (!mode || items.length === 0) {
      paletteBox.visible = false;
      return;
    }
    paletteBox.visible = true;
    const window = items.slice(0, 8);
    window.forEach((item, i) => {
      const selected = i === index;
      const marker = selected ? '❯ ' : '  ';
      const detail = item.detail ? `   ${item.detail}` : '';
      paletteBox.add(
        new TextRenderable(renderer, {
          content: `${marker}${item.label}${detail}`,
          fg: selected ? PICK : DIM,
        }),
      );
    });
    const hint =
      mode === 'sessions'
        ? '↑/↓ move · tab select · d delete · esc close'
        : '↑/↓ move · tab select · esc close';
    paletteBox.add(new TextRenderable(renderer, { content: hint, fg: '#4a4a63' }));
  };

  const openCommandPalette = (query: string): void => {
    mode = 'command';
    items = COMMANDS.filter((command) => command.label.startsWith(query));
    if (items.length === 0) items = COMMANDS.slice();
    index = 0;
    drawPalette();
  };

  const openModelPalette = async (query: string): Promise<void> => {
    mode = 'model';
    items = [{ label: '(loading models…)', detail: '' }];
    index = 0;
    drawPalette();
    const models = await session.models();
    items = models
      .filter((name) => name.toLowerCase().includes(query.toLowerCase()))
      .map((name) => ({ label: name, detail: name === session.model() ? 'current' : '' }));
    if (items.length === 0) items = [{ label: '(no models returned)', detail: 'try /model <name>' }];
    index = 0;
    drawPalette();
  };

  const openSessionPalette = (query: string): void => {
    mode = 'sessions';
    const needle = query.toLowerCase();
    items = session
      .listSessions()
      .filter((record) => !needle || record.id.toLowerCase().includes(needle))
      .slice(0, 40)
      .map((record) => {
        const tokens = record.usage.inputTokens + record.usage.outputTokens;
        const age = Math.max(0, Math.floor((Date.now() - record.updatedAt) / 60000));
        return {
          label: record.id,
          detail: `${record.messages.filter((m) => m.role !== 'system').length} msgs · ${tokens} tokens · ${age}m ago · ${record.model}`,
        };
      });
    if (items.length === 0) items = [{ label: '(no saved sessions yet)', detail: '' }];
    index = 0;
    drawPalette();
  };

  const openExportPalette = (): void => {
    mode = 'export';
    items = [
      { label: 'markdown', detail: `→ ${options.cwd}/<name>.md`, value: 'md' },
      { label: 'html', detail: `→ ${options.cwd}/<name>.html`, value: 'html' },
      { label: 'json', detail: `→ ${options.cwd}/<name>.json`, value: 'json' },
    ];
    index = 0;
    drawPalette();
  };

  const openFilePalette = (query: string): void => {
    mode = 'file';
    const needle = query.toLowerCase();
    items = listFiles(options.cwd)
      .filter((file) => !needle || file.toLowerCase().includes(needle))
      .slice(0, 200)
      .map((file) => ({ label: file, value: file }));
    if (items.length === 0) items = [{ label: '(no matching files)', detail: '' }];
    index = 0;
    drawPalette();
  };

  const refreshFromInput = (value: string): void => {
    if (mode === 'name') return;
    if (value.startsWith('/') && !value.includes(' ')) {
      openCommandPalette(value);
      return;
    }
    if (value.startsWith('/model ')) {
      void openModelPalette(value.slice(7));
      return;
    }
    if (value.startsWith('/resume')) {
      openSessionPalette(value.slice(7).trim());
      return;
    }
    const at = value.lastIndexOf('@');
    if (at >= 0) {
      openFilePalette(value.slice(at + 1));
      return;
    }
    closePalette();
  };

  const accept = (): void => {
    const item = items[index];
    if (!item) return;
    if (mode === 'command') {
      input.value = `${item.label} `;
      closePalette();
      refreshFromInput(input.value);
      input.focus();
      return;
    }
    if (mode === 'model') {
      if (item.label.startsWith('(')) return;
      session.setModel(item.label);
      ui.setModel(item.label);
      ui.line(`model -> ${item.label}`, DIM);
      input.value = '';
    } else if (mode === 'sessions') {
      if (item.label.startsWith('(')) return;
      if (session.resume(item.label)) {
        ui.clear();
        addNode(new TextRenderable(renderer, { content: `resumed ${item.label}`, fg: DIM }));
        addNode(new TextRenderable(renderer, { content: '', fg: DIM }));
        ui.setModel(session.model());
        setFooter();
      }
      input.value = '';
    } else if (mode === 'export') {
      const format = (item.value as 'md' | 'html' | 'json') ?? 'md';
      closePalette();
      doExport(format, `session-${session.info().id}`);
      input.value = '';
      input.focus();
      return;
    } else if (mode === 'file') {
      if (item.label.startsWith('(')) return;
      const value = input.value;
      const at = value.lastIndexOf('@');
      input.value = `${value.slice(0, at)}@${item.value ?? item.label} `;
    }
    closePalette();
    input.focus();
  };

  input.on(InputRenderableEvents.INPUT, () => {
    refreshFromInput(input.value);
  });

  renderer.keyInput.on('keypress', (key: any) => {
    if (key?.ctrl && key?.name === 'v') {
      const image = clipboardImage();
      if (image) {
        input.value = `${input.value}@${image} `;
        ui.line(`pasted image → ${image}`, DIM);
        closePalette();
        return;
      }
      const text = clipboardText();
      if (text) input.value = `${input.value}${text}`;
      closePalette();
      return;
    }

    if (!mode) {
      if (key?.name === 'escape' && input.value) {
        input.value = '';
        closePalette();
      }
      return;
    }

    if (key?.name === 'up') {
      index = Math.max(0, index - 1);
      drawPalette();
    } else if (key?.name === 'down') {
      index = Math.min(Math.min(items.length, 8) - 1, index + 1);
      drawPalette();
    } else if (key?.name === 'tab' || key?.name === 'return' || key?.name === 'enter') {
      paletteHandledAt = Date.now();
      accept();
    } else if (key?.name === 'escape') {
      closePalette();
    } else if (mode === 'sessions' && key?.name === 'd' && !key?.ctrl && !key?.meta) {
      const item = items[index];
      if (item && !item.label.startsWith('(')) {
        session.deleteSession(item.label);
        ui.line(`deleted ${item.label}`, DIM);
        openSessionPalette('');
      }
    }
  });

  input.on(InputRenderableEvents.ENTER, () => {
    if (Date.now() - paletteHandledAt < 100) return;
    const value = input.value;
    input.value = '';
    if (!value.trim()) return;
    closePalette();

    if (value.trim() === '/quit' || value.trim() === '/exit') {
      renderer.destroy();
      return;
    }
    if (value.trim() === '/export' || value.trim().startsWith('/export ')) {
      const parts = value.trim().split(/\s+/).slice(1);
      const format = (['md', 'html', 'json'] as const).includes(parts[0] as 'md') ? (parts[0] as 'md') : null;
      if (!format && parts.length === 0) {
        openExportPalette();
        return;
      }
      doExport(format ?? 'md', parts[1] ?? '');
      return;
    }
    if (value.trim() === '/update') {
      addNode(new TextRenderable(renderer, { content: 'updating baton…', fg: DIM }));
      const result = runUpdate();
      addNode(new TextRenderable(renderer, { content: result.output || '(no output)', fg: DIM }));
      addNode(
        new TextRenderable(renderer, {
          content: result.ok ? 'updated — restarting…' : 'update failed (is baton published to npm?)',
          fg: result.ok ? USER : ERROR,
        }),
      );
      if (result.ok) {
        setTimeout(() => {
          renderer.destroy();
          const child = spawnSync(process.execPath, process.argv.slice(1), { stdio: 'inherit' });
          process.exit(child.status ?? 0);
        }, 400);
      }
      return;
    }

    if (value.startsWith('/resume') && value.trim() === '/resume') {
      openSessionPalette('');
      return;
    }
    if (value.trim() === '/export') {
      openExportPalette();
      return;
    }
    if (value.trim() === '/model') {
      void openModelPalette('');
      return;
    }

    void session
      .handle(value, ui)
      .catch((error: unknown) => {
        ui.line(`error: ${error instanceof Error ? error.message : 'request failed'}`, ERROR);
      })
      .finally(() => {
        setFooter();
        input.focus();
      });
  });

  ui.line('Welcome to Baton. Type a request, / for commands, @ to attach a file.', DIM);
  ui.line('', DIM);
  setFooter();
  input.focus();
  addNode(new TextRenderable(renderer, { content: '', fg: DIM }));
}
