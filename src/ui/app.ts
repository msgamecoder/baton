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
import { CONFIG_PATH } from '../core/paths.ts';
import { protocolText } from '../core/instructions.ts';
import { keysFile } from '../core/keys.ts';
import { loadConfig } from '../core/config.ts';
import { runUpdate, type Session } from '../agent/session.ts';

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
    bg: '#0f0f17',
    panel: '#181822',
    accent: '#8b7bd8',
    text: '#dcdcec',
    dim: '#6b6b8f',
    user: '#7fd1b9',
    tool: '#e0b070',
    error: '#e06c75',
    pick: '#c8c0ff',
  },
  mono: {
    bg: '#111113',
    panel: '#1c1c1f',
    accent: '#b9b9c8',
    text: '#e6e6ea',
    dim: '#6e6e78',
    user: '#bfc6d8',
    tool: '#c8b28a',
    error: '#d98a8a',
    pick: '#ffffff',
  },
};

export interface ChatUi {
  user(text: string): void;
  assistant(): { set(text: string): void; append(chunk: string): void; done(): void };
  line(text: string, color?: string): void;
  setModel(model: string): void;
  clear(): void;
}

export interface ChatAppOptions {
  session: Session;
  agent: string;
  providerName: string;
  model: string;
  cwd: string;
}

export interface PaletteItem {
  label: string;
  detail?: string;
  value?: string;
  header?: boolean;
}

interface Command extends PaletteItem {
  label: string;
  detail: string;
  group: string;
}

const COMMANDS: Command[] = [
  { group: 'session', label: '/help', detail: 'show the command list' },
  { group: 'session', label: '/new', detail: 'start a new session' },
  { group: 'session', label: '/sessions', detail: 'switch session' },
  { group: 'session', label: '/resume', detail: 'same as /sessions' },
  { group: 'session', label: '/export', detail: 'export this session (md, html, json)' },
  { group: 'session', label: '/clear', detail: 'forget this conversation' },
  { group: 'session', label: '/quit', detail: 'exit' },

  { group: 'model', label: '/model', detail: 'switch model' },
  { group: 'model', label: '/provider', detail: 'connect or switch provider' },
  { group: 'model', label: '/key', detail: 'save an api key' },
  { group: 'model', label: '/cost', detail: 'price estimate for this model' },

  { group: 'project', label: '/init', detail: 'write AGENTS.md so agents use baton' },
  { group: 'project', label: '/diff', detail: 'show uncommitted changes' },
  { group: 'project', label: '/review', detail: 'ask the agent to review uncommitted changes' },
  { group: 'project', label: '/files', detail: 'attach a file (@ does this too)' },

  { group: 'baton', label: '/status', detail: 'provider, model, session, tokens' },
  { group: 'baton', label: '/debug', detail: 'paths, versions, config' },
  { group: 'baton', label: '/update', detail: 'update baton and restart' },
  { group: 'baton', label: '/yes', detail: 'toggle auto-approve for tools' },
  { group: 'baton', label: '/theme', detail: 'switch theme' },
  { group: 'baton', label: '/context', detail: 'protocol + memory' },
  { group: 'baton', label: '/remember', detail: 'keep a fact across sessions' },

  { group: 'relay', label: '/send', detail: 'message the other agent' },
  { group: 'relay', label: '/inbox', detail: 'read the relay inbox' },
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
  let theme = THEMES.baton;
  let themeName = 'baton';

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
    padding: 1,
    backgroundColor: theme.bg,
  });
  renderer.root.add(root);

  const header = new BoxRenderable(renderer, { id: 'header', flexDirection: 'column', alignItems: 'center', flexShrink: 0 });
  header.add(new ASCIIFontRenderable(renderer, { id: 'wordmark', text: 'BATON', font: 'tiny', color: theme.accent }));
  const subtitle = new TextRenderable(renderer, {
    id: 'subtitle',
    content: `${options.providerName}  ·  ${options.model}`,
    fg: theme.dim,
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

  const inputBox = new BoxRenderable(renderer, {
    id: 'inputbox',
    title: ' ask anything ',
    border: true,
    borderColor: theme.accent,
    height: 3,
    flexShrink: 0,
    paddingX: 1,
  });
  const input = new InputRenderable(renderer, {
    id: 'input',
    flexGrow: 1,
    placeholder: 'Ask anything…   / commands   @ files',
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
    width: '74%',
    flexDirection: 'column',
    border: true,
    borderColor: theme.accent,
    backgroundColor: theme.panel,
    titleAlignment: 'left',
    paddingX: 1,
  });
  overlay.add(dialog);
  renderer.root.add(overlay);

  const addNode = (node: TextRenderable): void => {
    scroll.content.add(node);
    scroll.scrollTo({ x: 0, y: scroll.scrollHeight });
  };

  const setFooter = (extra?: string): void => {
    const info = session.info();
    const tokens = info.usage.inputTokens + info.usage.outputTokens;
    footer.content = `${info.id} · ${info.messages} msgs · ${tokens} tokens · ${options.agent}${extra ? ` · ${extra}` : ''}`;
  };

  const ui: ChatUi = {
    user(text) {
      addNode(new TextRenderable(renderer, { content: `› ${text}`, fg: theme.user }));
    },
    assistant() {
      const node = new TextRenderable(renderer, { content: '', fg: theme.text });
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
          addNode(new TextRenderable(renderer, { content: '', fg: theme.dim }));
          setFooter();
        },
      };
    },
    line(text, color) {
      addNode(new TextRenderable(renderer, { content: text, fg: color ?? theme.dim }));
    },
    setModel(model) {
      subtitle.content = `${options.providerName}  ·  ${model}`;
    },
    clear() {
      for (const child of scroll.content.getChildren()) child.destroyRecursively();
    },
  };

  const run = (command: string): string =>
    (spawnSync(command, { shell: true, cwd: options.cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).stdout ?? '').trim();

  type Mode = 'command' | 'model' | 'sessions' | 'export' | 'file';
  let mode: Mode | null = null;
  let items: PaletteItem[] = [];
  let index = 0;
  let offset = 0;
  let query = '';
  let paletteHandledAt = 0;
  const WINDOW = 10;

  const closeModal = (): void => {
    mode = null;
    items = [];
    index = 0;
    offset = 0;
    query = '';
    overlay.visible = false;
  };

  const drawModal = (title: string, footerHint: string): void => {
    for (const child of dialog.getChildren()) child.destroyRecursively();
    dialog.title = ` ${title} `;
    const rows = items.slice(offset, offset + WINDOW);
    dialog.height = Math.max(rows.length, 1) + 4;

    dialog.add(new TextRenderable(renderer, { content: `Search  ${query}`, fg: theme.dim }));
    if (rows.length === 0) dialog.add(new TextRenderable(renderer, { content: '(nothing here)', fg: theme.dim }));
    rows.forEach((item, i) => {
      const realIndex = offset + i;
      if (item.header) {
        dialog.add(new TextRenderable(renderer, { content: item.label, fg: theme.accent }));
        return;
      }
      const selected = realIndex === index;
      const marker = selected ? '❯ ' : '  ';
      const detail = item.detail ? `   ${item.detail}` : '';
      dialog.add(
        new TextRenderable(renderer, {
          content: `${marker}${item.label}${detail}`,
          fg: selected ? theme.pick : theme.text,
        }),
      );
    });
    dialog.add(new TextRenderable(renderer, { content: footerHint, fg: theme.dim }));
    overlay.visible = true;
  };

  const grouped = (rows: PaletteItem[], keyOf: (item: PaletteItem) => string, headerLabel: (key: string) => string): PaletteItem[] => {
    const out: PaletteItem[] = [];
    let last = '';
    for (const row of rows) {
      const key = keyOf(row);
      if (key !== last) {
        last = key;
        out.push({ label: headerLabel(key), value: `__h:${key}`, header: true });
      }
      out.push(row);
    }
    return out;
  };

  const openCommands = (): void => {
    mode = 'command';
    const needle = query.toLowerCase();
    const matches = COMMANDS.filter(
      (command) => !needle || command.label.toLowerCase().includes(needle) || command.detail.toLowerCase().includes(needle),
    );
    items = grouped(matches as PaletteItem[], (item) => (item as Command).group ?? '', (key) => key);
    index = items.findIndex((item) => !item.header);
    offset = Math.max(0, index - WINDOW + 1);
    drawModal('Commands', '↑/↓ move · tab select · esc close');
  };

  const openModels = async (): Promise<void> => {
    mode = 'model';
    items = [{ label: '(loading models…)', value: '__loading' }];
    index = 0;
    offset = 0;
    drawModal('Select model', '↑/↓ move · tab select · esc close');
    const models = await session.models();
    const needle = query.toLowerCase();
    const rows: PaletteItem[] = models
      .filter((name) => !needle || name.toLowerCase().includes(needle))
      .map((name) => ({ label: name, detail: name === session.model() ? 'current' : '', value: name }));
    items = rows.length
      ? grouped(rows, (item) => (item.label === session.model() ? 'current' : 'available'), (key) => (key === 'current' ? 'Current' : 'Available'))
      : [{ label: '(no models returned — use /model <name>)', value: '__none' }];
    index = items.findIndex((item) => !item.header);
    offset = Math.max(0, index - WINDOW + 1);
    drawModal('Select model', '↑/↓ move · tab select · esc close');
  };

  const openSessions = (): void => {
    mode = 'sessions';
    const needle = query.toLowerCase();
    const records = session.listSessions().filter((record) => !needle || record.id.toLowerCase().includes(needle));
    const rows: PaletteItem[] = records.map((record) => {
      const tokens = record.usage.inputTokens + record.usage.outputTokens;
      const messages = record.messages.filter((m) => m.role !== 'system').length;
      return { label: `${record.id}  ${record.model}`, detail: `${messages} msgs · ${tokens} tokens`, value: record.id };
    });
    const dayOf = (id: string): string => `${id.slice(0, 4)}-${id.slice(4, 6)}-${id.slice(6, 8)}`;
    const today = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const todayId = `${today.getFullYear()}${pad(today.getMonth() + 1)}${pad(today.getDate())}`;
    items = rows.length
      ? grouped(rows, (item) => dayOf(String(item.value)), (key) => (key === todayId ? 'Today' : key))
      : [{ label: '(no saved sessions yet)', value: '__none' }];
    index = items.findIndex((item) => !item.header);
    offset = Math.max(0, index - WINDOW + 1);
    drawModal('Sessions', '↑/↓ move · tab switch · ctrl+d delete · esc close');
  };

  const openExport = (): void => {
    mode = 'export';
    items = [
      { label: 'markdown', detail: `${options.cwd}/<name>.md`, value: 'md' },
      { label: 'html', detail: `${options.cwd}/<name>.html`, value: 'html' },
      { label: 'json', detail: `${options.cwd}/<name>.json`, value: 'json' },
    ];
    index = 0;
    offset = 0;
    drawModal('Export session', '↑/↓ move · tab export · esc close');
  };

  const openFiles = (): void => {
    mode = 'file';
    const needle = query.toLowerCase();
    items = listFiles(options.cwd)
      .filter((file) => !needle || file.toLowerCase().includes(needle))
      .slice(0, 300)
      .map((file) => ({ label: file, value: file }));
    if (items.length === 0) items = [{ label: '(no matching files)', value: '__none' }];
    index = 0;
    offset = 0;
    drawModal('Attach file', '↑/↓ move · tab insert · esc close');
  };

  const move = (dir: 1 | -1): void => {
    let i = index + dir;
    while (i >= 0 && i < items.length && items[i].header) i += dir;
    if (i < 0 || i >= items.length) return;
    index = i;
    if (index < offset) offset = index;
    if (index >= offset + WINDOW) offset = index - WINDOW + 1;
    mode === 'model'
      ? drawModal('Select model', '↑/↓ move · tab select · esc close')
      : mode === 'sessions'
        ? drawModal('Sessions', '↑/↓ move · tab switch · ctrl+d delete · esc close')
        : mode === 'export'
          ? drawModal('Export session', '↑/↓ move · tab export · esc close')
          : mode === 'file'
            ? drawModal('Attach file', '↑/↓ move · tab insert · esc close')
            : drawModal('Commands', '↑/↓ move · tab select · esc close');
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

  const accept = (): void => {
    const item = items[index];
    if (!item || item.header) return;
    if (item.value === '__none' || item.value === '__loading') return;

    if (mode === 'command') {
      const command = item.label;
      closeModal();
      input.value = '';
      const needsArgs = ['/model', '/provider', '/key', '/remember', '/send'];
      if (command === '/model') void openModels();
      else if (command === '/sessions' || command === '/resume') openSessions();
      else if (command === '/export') openExport();
      else if (command === '/files') openFiles();
      else if (needsArgs.includes(command)) input.value = `${command} `;
      else void dispatch(command);
      input.focus();
      return;
    }

    if (mode === 'model') {
      session.setModel(item.value ?? item.label);
      ui.setModel(session.model());
      ui.line(`model → ${item.value ?? item.label}`, theme.dim);
      closeModal();
      input.value = '';
      input.focus();
      return;
    }

    if (mode === 'sessions') {
      if (session.resume(String(item.value))) {
        ui.clear();
        addNode(new TextRenderable(renderer, { content: `resumed ${item.value}`, fg: theme.dim }));
        addNode(new TextRenderable(renderer, { content: '', fg: theme.dim }));
        ui.setModel(session.model());
        setFooter();
      }
      closeModal();
      input.value = '';
      input.focus();
      return;
    }

    if (mode === 'export') {
      const format = (item.value as 'md' | 'html' | 'json') ?? 'md';
      closeModal();
      doExport(format, `session-${session.info().id}`);
      input.value = '';
      input.focus();
      return;
    }

    if (mode === 'file') {
      const at = input.value.lastIndexOf('@');
      input.value = `${input.value.slice(0, at)}@${item.value} `;
      closeModal();
      input.focus();
    }
  };

  const initAgents = (): void => {
    const file = join(options.cwd, 'AGENTS.md');
    const body = `${protocolText()}\n`;
    writeFileSync(file, body);
    ui.line(`wrote ${file}`, theme.user);
  };

  const debugInfo = (): void => {
    const config = loadConfig();
    ui.line(`baton      v${process.env.npm_package_version ?? '0.1.0'}`);
    ui.line(`node       ${process.version}`, theme.dim);
    ui.line(`agent      ${options.agent}`, theme.dim);
    ui.line(`provider   ${session.provider().id} (${session.provider().format})`, theme.dim);
    ui.line(`model      ${session.model()}`, theme.dim);
    ui.line(`session    ${session.info().id}`, theme.dim);
    ui.line(`cwd        ${options.cwd}`, theme.dim);
    ui.line(`config     ${CONFIG_PATH}`, theme.dim);
    ui.line(`keys       ${keysFile()}`, theme.dim);
    ui.line(`agents     ${config.agents.map((a) => a.name).join(', ')}`, theme.dim);
  };

  const dispatch = async (line: string): Promise<void> => {
    const trimmed = line.trim();
    if (trimmed === '/quit' || trimmed === '/exit') {
      renderer.destroy();
      return;
    }
    if (trimmed === '/help') {
      ui.line('commands', theme.accent);
      for (const command of COMMANDS) ui.line(`  ${command.label.padEnd(11)} ${command.detail}`, theme.dim);
      return;
    }
    if (trimmed === '/debug') {
      debugInfo();
      return;
    }
    if (trimmed === '/init') {
      initAgents();
      return;
    }
    if (trimmed === '/new') {
      session.newSession();
      ui.clear();
      addNode(new TextRenderable(renderer, { content: `new session ${session.info().id}`, fg: theme.dim }));
      addNode(new TextRenderable(renderer, { content: '', fg: theme.dim }));
      setFooter();
      return;
    }
    if (trimmed === '/diff') {
      const stat = run('git diff --stat');
      const diff = run('git diff');
      ui.line(stat || '(no uncommitted changes)', theme.dim);
      if (diff) {
        for (const row of diff.split('\n').slice(0, 200)) ui.line(row, theme.dim);
      }
      return;
    }
    if (trimmed === '/review') {
      const diff = run('git diff');
      if (!diff) {
        ui.line('(no uncommitted changes to review)', theme.dim);
        return;
      }
      await session.handle(`Review my uncommitted changes and point out problems. Here is the diff:\n\n${diff}`, ui);
      return;
    }
    if (trimmed === '/theme') {
      themeName = themeName === 'baton' ? 'mono' : 'baton';
      theme = THEMES[themeName];
      renderer.setBackgroundColor?.(theme.bg);
      root.backgroundColor = theme.bg;
      inputBox.borderColor = theme.accent;
      dialog.borderColor = theme.accent;
      dialog.backgroundColor = theme.panel;
      ui.line(`theme → ${themeName} (new lines use it)`, theme.dim);
      return;
    }
    if (trimmed === '/export' || trimmed.startsWith('/export ')) {
      const parts = trimmed.split(/\s+/).slice(1);
      const format = (['md', 'html', 'json'] as const).includes(parts[0] as 'md') ? (parts[0] as 'md') : null;
      if (!format && parts.length === 0) {
        openExport();
        return;
      }
      doExport(format ?? 'md', parts[1] ?? '');
      return;
    }
    if (trimmed === '/update') {
      ui.line('updating baton…', theme.dim);
      const result = runUpdate();
      ui.line(result.output || '(no output)', theme.dim);
      if (result.ok) {
        ui.line('updated — restarting…', theme.user);
        setTimeout(() => {
          renderer.destroy();
          const child = spawnSync(process.execPath, process.argv.slice(1), { stdio: 'inherit' });
          process.exit(child.status ?? 0);
        }, 400);
      } else {
        ui.line('update failed (is baton published to npm?)', theme.error);
      }
      return;
    }
    await session.handle(line, ui);
  };

  input.on(InputRenderableEvents.INPUT, () => {
    const value = input.value;
    if (mode === 'model' || mode === 'sessions' || mode === 'file') {
      query = value.replace(/^\/[a-z]*\s*/, '').replace(/^.*@/, '');
      if (mode === 'model') void openModels();
      else if (mode === 'sessions') openSessions();
      else openFiles();
      return;
    }
    if (value.startsWith('/') && !value.includes(' ')) {
      query = value;
      openCommands();
      return;
    }
    const at = value.lastIndexOf('@');
    if (at >= 0) {
      query = value.slice(at + 1);
      openFiles();
      return;
    }
    if (mode === 'command' && !value.startsWith('/')) closeModal();
  });

  renderer.keyInput.on('keypress', (key: any) => {
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
      if (key?.name === 'escape' && input.value) {
        input.value = '';
        closeModal();
      }
      return;
    }

    if (key?.name === 'up') move(-1);
    else if (key?.name === 'down') move(1);
    else if (key?.name === 'tab' || key?.name === 'return' || key?.name === 'enter') {
      paletteHandledAt = Date.now();
      accept();
    } else if (key?.name === 'escape') closeModal();
    else if (mode === 'sessions' && key?.ctrl && key?.name === 'd') {
      const item = items[index];
      if (item && !item.header && item.value && !String(item.value).startsWith('__')) {
        session.deleteSession(String(item.value));
        ui.line(`deleted ${item.value}`, theme.dim);
        openSessions();
      }
    }
  });

  input.on(InputRenderableEvents.ENTER, () => {
    if (Date.now() - paletteHandledAt < 100) return;
    const value = input.value;
    input.value = '';
    if (!value.trim()) return;
    closeModal();

    if (mode === null && value.trim() === '/model') {
      void openModels();
      return;
    }
    if (value.trim() === '/sessions' || value.trim() === '/resume') {
      openSessions();
      return;
    }
    if (value.trim() === '/files' || value.trim() === '@') {
      openFiles();
      return;
    }

    void dispatch(value)
      .catch((error: unknown) => {
        ui.line(`error: ${error instanceof Error ? error.message : 'request failed'}`, theme.error);
      })
      .finally(() => {
        setFooter();
        input.focus();
      });
  });

  ui.line('Welcome to Baton. Type a request, / for commands, @ to attach a file.', theme.dim);
  ui.line('', theme.dim);
  setFooter();
  input.focus();
  addNode(new TextRenderable(renderer, { content: '', fg: theme.dim }));
}
