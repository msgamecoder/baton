import { streamChat } from '../providers/client.ts';
import { TOOLS, READ_ONLY_TOOLS, runTool } from './tools.ts';
import type { ToolContext } from './tools.ts';
import type { ChatMessage, ToolCall } from '../providers/types.ts';
import type { Provider } from '../providers/registry.ts';

export interface TurnEvents {
  onText?: (chunk: string) => void;
  onToolStart?: (call: ToolCall) => void;
  onToolEnd?: (call: ToolCall, output: string, isError: boolean) => void;
  onTurn?: (n: number) => void;
}

export interface TurnOptions {
  provider: Provider;
  apiKey?: string;
  model: string;
  cwd: string;
  tools?: boolean;
  confirm?: ToolContext['confirm'];
  ask?: ToolContext['ask'];
  readOnly?: boolean;
  maxTurns?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  events?: TurnEvents;
}

export function buildSystemPrompt(cwd: string, extra?: string): string {
  const parts = [
    'You are Baton, a coding agent working in the user\'s project.',
    `Project directory: ${cwd}`,
    'Use the tools to read and change files and to run commands. Prefer editing over rewriting whole files.',
    'Be concise. When you finish a piece of work, say what changed in one or two lines.',
    'If the user asks you to test something, actually run it and report the real output.',
  ];
  if (extra) parts.push('', extra);
  return parts.join('\n');
}

export function describeToolCall(call: ToolCall): string {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(call.arguments || '{}') as Record<string, unknown>;
  } catch {
    args = {};
  }
  const detail =
    (args.path as string) ??
    (args.pattern as string) ??
    (args.command as string) ??
    '';
  return detail ? `${call.name} ${String(detail).slice(0, 120)}` : call.name;
}

export async function runTurn(
  messages: ChatMessage[],
  options: TurnOptions,
): Promise<{
  messages: ChatMessage[];
  finalText: string;
  turns: number;
  usage: { inputTokens: number; outputTokens: number };
}> {
  const maxTurns = options.maxTurns ?? 40;
  const events = options.events ?? {};
  const tools = options.tools === false ? [] : options.readOnly ? READ_ONLY_TOOLS : TOOLS;
  const history = [...messages];
  const usage = { inputTokens: 0, outputTokens: 0 };
  let finalText = '';
  let turn = 0;

  for (; turn < maxTurns; turn++) {
    events.onTurn?.(turn + 1);

    const result = await streamChat({
      provider: options.provider,
      apiKey: options.apiKey,
      model: options.model,
      messages: history,
      tools,
      signal: options.signal,
      maxTokens: options.maxTokens,
      onText: events.onText,
    });

    usage.inputTokens += result.usage.inputTokens;
    usage.outputTokens += result.usage.outputTokens;

    history.push({
      role: 'assistant',
      content: result.text,
      ...(result.toolCalls.length ? { toolCalls: result.toolCalls } : {}),
    });
    finalText = result.text;

    if (result.toolCalls.length === 0) break;

    for (const call of result.toolCalls) {
      events.onToolStart?.(call);
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.arguments || '{}') as Record<string, unknown>;
      } catch {
        args = {};
      }
      const outcome = await runTool(call.name, args, {
        cwd: options.cwd,
        confirm: options.confirm,
        ask: options.ask,
      });
      events.onToolEnd?.(call, outcome.output, Boolean(outcome.isError));
      history.push({
        role: 'tool',
        content: outcome.output,
        toolCallId: call.id,
        name: call.name,
      });
    }
  }

  return { messages: history, finalText, turns: turn, usage };
}
