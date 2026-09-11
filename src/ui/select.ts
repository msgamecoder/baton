import { askLine, closePrompts, confirm } from '../core/prompt.ts';

const ESC = '\u001b';
export const RESET = `${ESC}[0m`;
export const BOLD = `${ESC}[1m`;
export const DIM = `${ESC}[2m`;
export const CYAN = `${ESC}[36m`;

export class UiCancelled extends Error {
  constructor() {
    super('cancelled');
    this.name = 'UiCancelled';
  }
}

export interface SelectItem {
  label: string;
  detail?: string;
  value: string;
  header?: boolean;
}

export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

interface Key {
  name: 'up' | 'down' | 'enter' | 'escape' | 'backspace' | 'ctrl-c' | 'char';
  char?: string;
}

export function parseKeys(text: string): Key[] {
  const keys: Key[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\u001b') {
      const rest = text.slice(i);
      const csi = rest.match(/^\u001b\[([0-9;]*)([A-Za-z~])/);
      const ss3 = rest.match(/^\u001bO([A-Za-z])/);
      const code = csi?.[2] ?? ss3?.[1];
      if (code) {
        if (code === 'A') keys.push({ name: 'up' });
        else if (code === 'B') keys.push({ name: 'down' });
        i += csi ? csi[0].length : (ss3?.[0].length ?? 1);
        continue;
      }
      keys.push({ name: 'escape' });
      i += 1;
      continue;
    }
    if (ch === '\u0003') keys.push({ name: 'ctrl-c' });
    else if (ch === '\r' || ch === '\n') keys.push({ name: 'enter' });
    else if (ch === '\u007f' || ch === '\b') keys.push({ name: 'backspace' });
    else keys.push({ name: 'char', char: ch });
    i += 1;
  }
  return keys;
}

function listen(onKey: (key: Key) => void): () => void {
  closePrompts();
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw;
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();

  const handler = (chunk: Buffer) => {
    for (const key of parseKeys(chunk.toString('utf8'))) onKey(key);
  };

  stdin.on('data', handler);
  return () => {
    stdin.removeListener('data', handler);
    if (stdin.isTTY) stdin.setRawMode(wasRaw ?? false);
  };
}

function visibleLength(text: string): number {
  return text.replace(/\u001b\[[0-9;]*m/g, '').length;
}

function pad(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - visibleLength(text)));
}

function rule(width: number): string {
  return `${DIM}${'─'.repeat(width)}${RESET}`;
}

class Live {
  private rendered = 0;

  draw(lines: string[]): void {
    if (this.rendered > 0) process.stdout.write(`${ESC}[${this.rendered}A`);
    for (const line of lines) process.stdout.write(`\r${ESC}[2K${line}\n`);
    this.rendered = lines.length;
  }

  clear(): void {
    if (this.rendered === 0) return;
    process.stdout.write(`${ESC}[${this.rendered}A`);
    for (let i = 0; i < this.rendered; i++) process.stdout.write(`\r${ESC}[2K\n`);
    process.stdout.write(`${ESC}[${this.rendered}A`);
    this.rendered = 0;
  }
}

export async function selectBox(options: {
  title: string;
  items: SelectItem[];
  hint?: string;
  height?: number;
  filterable?: boolean;
}): Promise<string> {
  const { title, items } = options;
  if (items.length === 0) throw new UiCancelled();

  if (!isInteractive()) {
    const selectable = items.filter((item) => item.header !== true);
    console.log(`\n${title}\n`);
    selectable.forEach((item, index) => {
      console.log(`  ${String(index + 1).padStart(2)}  ${item.label}${item.detail ? `  ${item.detail}` : ''}`);
    });
    const answer = (await askLine('\nnumber or id: ')).trim();
    if (/^\d+$/.test(answer)) {
      const picked = selectable[Number(answer) - 1];
      if (picked) return picked.value;
    }
    const byValue = selectable.find((item) => item.value === answer);
    if (byValue) return byValue.value;
    throw new UiCancelled();
  }

  const height = Math.max(1, Math.min(options.height ?? 12, items.length));
  const filterable = options.filterable ?? true;
  const labelWidth = Math.max(24, Math.min(60, Math.max(...items.map((i) => visibleLength(i.label) + (i.detail ? i.detail.length + 2 : 0)))));
  const width = labelWidth + 4;
  const hint = options.hint ?? (filterable ? '↑/↓ move · type to filter · enter select · esc cancel' : '↑/↓ move · enter select · esc cancel');

  const isHeader = (item: SelectItem): boolean => item.header === true;
  let query = '';
  let filtered: SelectItem[] = [...items];
  const findSelectable = (from: number, dir: 1 | -1): number => {
    let i = from;
    while (i >= 0 && i < filtered.length) {
      if (!isHeader(filtered[i])) return i;
      i += dir;
    }
    return -1;
  };
  let cursor = Math.max(0, findSelectable(0, 1));
  let offset = 0;
  const live = new Live();

  const render = (): void => {
    const lines: string[] = [`${BOLD}${title}${RESET}${query ? `  ${CYAN}/${query}${RESET}` : ''}`, rule(width)];
    for (let i = 0; i < height; i++) {
      const item = filtered[offset + i];
      if (!item) {
        lines.push('');
        continue;
      }
      if (isHeader(item)) {
        lines.push(`${DIM}${item.label}${RESET}`);
        continue;
      }
      const detail = item.detail ? `  ${DIM}${item.detail}${RESET}` : '';
      const body = pad(`${item.label}${detail}`, labelWidth);
      lines.push(offset + i === cursor ? `${CYAN}❯ ${body}${RESET}` : `  ${body}`);
    }
    lines.push(rule(width), `${DIM}${hint}${RESET}`);
    live.draw(lines);
  };

  const refilter = (): void => {
    const needle = query.toLowerCase();
    filtered = needle
      ? items.filter(
          (item) =>
            !isHeader(item) && `${item.label} ${item.detail ?? ''} ${item.value}`.toLowerCase().includes(needle),
        )
      : [...items];
    cursor = Math.max(0, findSelectable(0, 1));
    offset = 0;
  };

  return new Promise<string>((resolve, reject) => {
    let stop = (): void => {};
    const finish = (value?: string): void => {
      live.clear();
      stop();
      if (value === undefined) reject(new UiCancelled());
      else resolve(value);
    };

    stop = listen((key) => {
      if (key.name === 'ctrl-c') {
        live.clear();
        stop();
        process.exit(130);
      }
      if (key.name === 'escape') return finish(undefined);
      if (key.name === 'enter') {
        const picked = filtered[cursor];
        if (!picked || isHeader(picked)) return;
        return finish(picked.value);
      }
      if (key.name === 'up') {
        const next = findSelectable(cursor - 1, -1);
        if (next >= 0) cursor = next;
      } else if (key.name === 'down') {
        const next = findSelectable(cursor + 1, 1);
        if (next >= 0) cursor = next;
      } else if (key.name === 'backspace' && filterable) {
        query = query.slice(0, -1);
        refilter();
      } else if (key.name === 'char' && filterable) {
        query += key.char ?? '';
        refilter();
      }
      if (cursor < offset) offset = cursor;
      if (cursor >= offset + height) offset = cursor - height + 1;
      offset = Math.max(0, Math.min(offset, Math.max(0, filtered.length - height)));
      render();
    });

    render();
  });
}

export async function inputBox(options: {
  title: string;
  placeholder?: string;
  hidden?: boolean;
  hint?: string;
}): Promise<string> {
  const { title } = options;

  if (!isInteractive()) {
    return (await askLine(`${title}${options.placeholder ? ` (${options.placeholder})` : ''}: `)).trim();
  }

  const width = 60;
  let value = '';
  const live = new Live();

  const render = (): void => {
    const shown = options.hidden ? '*'.repeat(value.length) : value;
    const placeholder = !value && options.placeholder ? `${DIM}${options.placeholder}${RESET}` : '';
    live.draw([
      `${BOLD}${title}${RESET}`,
      rule(width),
      `${CYAN}❯${RESET} ${shown}${placeholder}`,
      rule(width),
      `${DIM}${options.hint ?? 'enter confirm · esc cancel'}${RESET}`,
    ]);
  };

  return new Promise<string>((resolve, reject) => {
    let stop = (): void => {};
    const finish = (result?: string): void => {
      live.clear();
      stop();
      if (result === undefined) reject(new UiCancelled());
      else resolve(result);
    };

    stop = listen((key) => {
      if (key.name === 'ctrl-c') {
        live.clear();
        stop();
        process.exit(130);
      }
      if (key.name === 'escape') return finish(undefined);
      if (key.name === 'enter') return finish(value.trim());
      if (key.name === 'backspace') value = value.slice(0, -1);
      else if (key.name === 'char') value += key.char ?? '';
      render();
    });

    render();
  });
}

export async function confirmBox(title: string, yes = 'yes', no = 'no'): Promise<boolean> {
  if (!isInteractive()) return confirm(`${title} [y/N] `);
  const value = await selectBox({
    title,
    items: [
      { label: yes, value: 'yes' },
      { label: no, value: 'no' },
    ],
    filterable: false,
    height: 2,
  });
  return value === 'yes';
}

export function printCard(title: string, rows: Array<[string, string]>): void {
  const width = Math.max(24, ...rows.map(([key, value]) => key.length + value.length + 6));
  console.log(`\n${BOLD}${title}${RESET}`);
  console.log(rule(Math.min(width, 78)));
  for (const [key, value] of rows) console.log(`  ${DIM}${key.padEnd(10)}${RESET} ${value}`);
  console.log(rule(Math.min(width, 78)));
}

export function note(text: string): void {
  console.log(`  ${DIM}${text}${RESET}`);
}
