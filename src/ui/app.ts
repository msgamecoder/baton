import {
  ASCIIFontRenderable,
  BoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  ScrollBoxRenderable,
  TextRenderable,
  createCliRenderer,
} from '@opentui/core';

const BG = '#0f0f17';
const ACCENT = '#8b7bd8';
const TEXT = '#dcdcec';
const DIM = '#6b6b8f';
const USER = '#7fd1b9';
const TOOL = '#e0b070';
const ERROR = '#e06c75';

export interface ChatUi {
  user(text: string): void;
  assistant(): { set(text: string): void; append(chunk: string): void; done(): void };
  line(text: string, color?: string): void;
  status(text: string): void;
  setModel(model: string): void;
  clear(): void;
}

export interface ChatAppOptions {
  agent: string;
  providerName: string;
  model: string;
  cwd: string;
  handle: (input: string, ui: ChatUi) => Promise<void>;
  onExit?: () => void;
}

export function availableFonts(): string[] {
  return ['tiny'];
}

export async function runChatApp(options: ChatAppOptions): Promise<void> {
  const renderer = await createCliRenderer({
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
    gap: 1,
    backgroundColor: BG,
  });
  renderer.root.add(root);

  const header = new BoxRenderable(renderer, {
    id: 'header',
    flexDirection: 'column',
    alignItems: 'center',
    flexShrink: 0,
  });
  header.add(new ASCIIFontRenderable(renderer, { id: 'wordmark', text: 'BATON', font: 'tiny', color: ACCENT }));
  const subtitle = new TextRenderable(renderer, {
    id: 'subtitle',
    content: `${options.agent}  ·  ${options.providerName}  ·  ${options.model}`,
    fg: DIM,
  });
  header.add(subtitle);
  root.add(header);

  const chatBox = new BoxRenderable(renderer, {
    id: 'chat',
    title: ' conversation ',
    border: true,
    borderColor: '#2e2e45',
    flexGrow: 1,
    flexDirection: 'column',
    paddingX: 1,
  });
  const scroll = new ScrollBoxRenderable(renderer, {
    id: 'scroll',
    flexGrow: 1,
    width: '100%',
  });
  scroll.stickyScroll = true;
  scroll.stickyStart = 'bottom';
  chatBox.add(scroll);
  root.add(chatBox);

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
    placeholder: 'Ask anything…  (/help for commands)',
    backgroundColor: BG,
    textColor: TEXT,
    placeholderColor: DIM,
  });
  inputBox.add(input);
  root.add(inputBox);

  const footer = new TextRenderable(renderer, {
    id: 'footer',
    content: `enter send · /help commands · ctrl+c quit · ${options.cwd}`,
    fg: DIM,
    flexShrink: 0,
  });
  root.add(footer);

  const addNode = (node: TextRenderable): void => {
    scroll.content.add(node);
    scroll.scrollTo({ x: 0, y: scroll.scrollHeight });
  };

  const ui: ChatUi = {
    user(text: string) {
      addNode(new TextRenderable(renderer, { content: `${'\u203a'} ${text}`, fg: USER }));
      addNode(new TextRenderable(renderer, { content: '', fg: DIM }));
    },
    assistant() {
      const node = new TextRenderable(renderer, { content: '', fg: TEXT });
      addNode(node);
      let buffer = '';
      return {
        set(text: string) {
          buffer = text;
          node.content = buffer;
          scroll.scrollTo({ x: 0, y: scroll.scrollHeight });
        },
        append(chunk: string) {
          buffer += chunk;
          node.content = buffer;
          scroll.scrollTo({ x: 0, y: scroll.scrollHeight });
        },
        done() {
          addNode(new TextRenderable(renderer, { content: '', fg: DIM }));
        },
      };
    },
    line(text: string, color?: string) {
      addNode(new TextRenderable(renderer, { content: text, fg: color ?? DIM }));
    },
    status(text: string) {
      footer.content = text;
    },
    setModel(model: string) {
      subtitle.content = `${options.agent}  ·  ${options.providerName}  ·  ${model}`;
    },
    clear() {
      for (const child of scroll.content.getChildren()) child.destroyRecursively();
    },
  };

  let busy = false;

  input.on(InputRenderableEvents.ENTER, () => {
    const value = input.value;
    input.value = '';
    if (!value.trim() || busy) return;
    busy = true;
    void options
      .handle(value, ui)
      .catch((error: unknown) => {
        ui.line(`error: ${error instanceof Error ? error.message : 'request failed'}`, ERROR);
      })
      .finally(() => {
        busy = false;
        ui.status(`enter send · /help commands · ctrl+c quit · ${options.cwd}`);
      });
  });

  ui.line('Welcome to Baton. Type a request, or /help for commands.', DIM);
  ui.line('', DIM);
  input.focus();
  options.onExit?.();

  renderer.on('destroy', () => {
    process.exit(0);
  });
}
