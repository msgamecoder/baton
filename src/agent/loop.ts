import { randomUUID } from 'node:crypto';
import { streamChat } from '../providers/client.ts';
import { TOOLS, READ_ONLY_TOOLS, runTool } from './tools.ts';
import type { ToolContext } from './tools.ts';
import type { ChatMessage, ToolCall } from '../providers/types.ts';
import type { Provider } from '../providers/registry.ts';

/**
 * Some gateways (OpenCode Go, Azure) reject a tool call with no id, and OpenAI
 * requires every `tool_calls` entry to be answered by a tool message with a
 * matching, unique `tool_call_id`. Give every call a stable id up front.
 */
export function withStableIds(calls: ToolCall[], used: Set<string> = new Set()): ToolCall[] {
  return calls.map((call) => {
    let id = call.id;
    // a missing id, or one the conversation already used (some gateways reuse ids),
    // is replaced — the strict rule wants a unique id per tool call
    if (!id || used.has(id)) id = `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    used.add(id);
    return { ...call, id };
  });
}

/** Every tool-call id already present in the conversation. */
function usedToolIds(messages: ChatMessage[]): Set<string> {
  const used = new Set<string>();
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const call of message.toolCalls ?? []) if (call.id) used.add(call.id);
    } else if (message.role === 'tool' && message.toolCallId) {
      used.add(message.toolCallId);
    }
  }
  return used;
}

export interface TurnEvents {
  onText?: (chunk: string) => void;
  onReasoning?: (chunk: string) => void;
  onRetry?: (attempt: number, message: string) => void;
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
  sessionId?: string;
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
    'Be economical with tokens — they cost the user money. Never paste a whole file when a targeted edit will do, do not re-read a file you have already read, do not repeat the plan back, and keep answers short.',
    'For multi-step work, create tasks with task_create and keep them updated as you go.',
    'If you are unsure between options, use ask_user instead of guessing.',
    'You can search the web with web_search and read a page with web_fetch when you need current information.',
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

export function sanitizeHistory(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (!message) continue;

    // tool messages are only ever emitted with their assistant message below
    if (message.role === 'tool') continue;

    if (message.role === 'assistant' && message.toolCalls?.length) {
      const run: ChatMessage[] = [];
      let next = i + 1;
      while (next < messages.length && messages[next]?.role === 'tool') {
        run.push(messages[next]);
        next += 1;
      }

      // keep each call together with its own result, in order — a call with no
      // id or a repeated id can never satisfy the pairing rule, so drop it
      const seen = new Set<string>();
      const kept: ToolCall[] = [];
      const results: ChatMessage[] = [];
      for (const call of message.toolCalls) {
        if (!call.id || seen.has(call.id)) continue;
        const result = run.find((entry) => entry.toolCallId === call.id);
        if (!result) continue;
        seen.add(call.id);
        kept.push(call);
        results.push(result);
      }

      if (!kept.length) {
        if (message.content) out.push({ role: 'assistant', content: message.content });
      } else {
        out.push({ ...message, toolCalls: kept });
        for (const result of results) out.push(result);
      }
      i = next - 1; // consume the tool run in one go
      continue;
    }

    out.push(message);
  }
  return out;
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
  const history = sanitizeHistory(messages);
  const usage = { inputTokens: 0, outputTokens: 0 };
  let finalText = '';
  let turn = 0;

  for (; turn < maxTurns; turn++) {
    events.onTurn?.(turn + 1);

    const result = await streamChat({
      provider: options.provider,
      apiKey: options.apiKey,
      model: options.model,
      messages: sanitizeHistory(history),
      tools,
      signal: options.signal,
      maxTokens: options.maxTokens,
      onText: events.onText,
      onReasoning: events.onReasoning,
      onRetry: events.onRetry,
    });

    usage.inputTokens += result.usage.inputTokens;
    usage.outputTokens += result.usage.outputTokens;

    const toolCalls = withStableIds(result.toolCalls, usedToolIds(history));
    history.push({
      role: 'assistant',
      content: result.text,
      ...(result.reasoning ? { reasoning: result.reasoning } : {}),
      ...(toolCalls.length ? { toolCalls } : {}),
    });
    finalText = result.text;

    if (toolCalls.length === 0) break;

    for (const call of toolCalls) {
      events.onToolStart?.(call);
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.arguments || '{}') as Record<string, unknown>;
      } catch {
        args = {};
      }
      // every call must get exactly one tool message back, even if it throws,
      // or the next request fails the tool_calls/tool_call_id pairing rule
      let output = '';
      let isError = false;
      try {
        const outcome = await runTool(call.name, args, {
          cwd: options.cwd,
          sessionId: options.sessionId,
          confirm: options.confirm,
          ask: options.ask,
        });
        output = outcome.output;
        isError = Boolean(outcome.isError);
      } catch (error) {
        output = `tool ${call.name} failed: ${error instanceof Error ? error.message : 'error'}`;
        isError = true;
      }
      events.onToolEnd?.(call, output, isError);
      history.push({
        role: 'tool',
        content: output || '(no output)',
        toolCallId: call.id,
        name: call.name,
      });
    }
  }

  return { messages: history, finalText, turns: turn, usage };
}
