import { createInterface, type Interface } from 'node:readline';

let rl: Interface | null = null;
const pending: string[] = [];
let waiter: ((line: string) => void) | null = null;
let closed = false;

function iface(): Interface {
  if (!rl) {
    rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    });
    rl.on('line', (line) => {
      if (waiter) {
        const resolve = waiter;
        waiter = null;
        resolve(line);
      } else {
        pending.push(line);
      }
    });
    rl.on('close', () => {
      closed = true;
      if (waiter) {
        const resolve = waiter;
        waiter = null;
        resolve('');
      }
    });
  }
  return rl;
}

export function closePrompts(): void {
  rl?.close();
  rl = null;
}

export function askLine(question: string): Promise<string> {
  iface();
  process.stdout.write(question);
  const queued = pending.shift();
  if (queued !== undefined) return Promise.resolve(queued);
  if (closed) return Promise.resolve('');
  return new Promise((resolve) => {
    waiter = resolve;
  });
}

export function confirm(question: string): Promise<boolean> {
  return askLine(question).then((answer) => /^y(es)?$/i.test(answer.trim()));
}

export function askHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY) return askLine(question);
  return new Promise((resolve) => {
    rl?.pause();
    process.stdout.write(question);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    let value = '';
    const finish = () => {
      stdin.setRawMode(wasRaw ?? false);
      stdin.removeListener('data', onData);
      process.stdout.write('\n');
      rl?.resume();
      resolve(value);
    };
    const onData = (chunk: Buffer) => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          finish();
          return;
        }
        if (ch === '\u0003') process.exit(130);
        if (ch === '\u007f') {
          value = value.slice(0, -1);
          continue;
        }
        value += ch;
      }
    };
    stdin.on('data', onData);
  });
}
