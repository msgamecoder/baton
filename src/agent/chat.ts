import { createInterface } from 'node:readline';
import { createSession, type SessionUi } from './session.ts';
import type { Provider } from '../providers/registry.ts';

const CYAN = '\u001b[36m';
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

export async function startChat(options: ChatOptions): Promise<void> {
  const session = createSession(options);
  const ui: SessionUi = {
    user: (text) => process.stdout.write(`\n${CYAN}you \u203a${RESET} ${text}\n`),
    assistant: () => ({
      set: (text) => process.stdout.write(text),
      append: (chunk) => process.stdout.write(chunk),
      done: () => process.stdout.write('\n'),
    }),
    line: (text) => console.log(text),
  };

  console.log(`baton · ${options.provider.name} · ${options.model} · ${options.cwd}`);
  console.log("/help for commands, /quit to leave\n");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  process.stdout.write(`${CYAN}you ›${RESET} `);

  let chain: Promise<void> = Promise.resolve();
  rl.on('line', (line) => {
    chain = chain.then(async () => {
      if (line.trim() === '/quit' || line.trim() === '/exit') {
        rl.close();
        return;
      }
      await session.handle(line, ui);
      process.stdout.write(`${CYAN}you ›${RESET} `);
    });
  });

  await new Promise<void>((resolve) => rl.on('close', resolve));
}

export { createSession };
