import { randomUUID } from 'node:crypto';
import type { Provider } from '../providers/registry.ts';
import type { ChatMessage, ToolCall, ToolSpec } from './types.ts';

const CLIENT_SESSION_ID = randomUUID();
let providerSessionId = CLIENT_SESSION_ID;

export function setProviderSession(id: string): void {
  providerSessionId = id || CLIENT_SESSION_ID;
}

export function providerHeaders(provider: Provider, apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = {};
  if (provider.format === 'anthropic') {
    if (apiKey) headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }
  if (provider.sessionHeader) headers[provider.sessionHeader] = providerSessionId;
  return headers;
}

export interface StreamResult {
  text: string;
  toolCalls: ToolCall[];
  stopReason?: string;
  usage: { inputTokens: number; outputTokens: number };
}

export interface StreamOptions {
  provider: Provider;
  apiKey?: string;
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  signal?: AbortSignal;
  onText?: (chunk: string) => void;
  onRetry?: (attempt: number, message: string) => void;
  maxTokens?: number;
}

export function splitSSE(buffer: string): { events: string[]; rest: string } {
  const parts = buffer.split('\n\n');
  const rest = parts.pop() ?? '';
  return { events: parts, rest };
}

export function parseSSEEvent(block: string): { event?: string; data?: string } {
  let event: string | undefined;
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trim());
  }
  return { event, data: data.join('\n') };
}

export function newStreamState(): StreamResult {
  return { text: '', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } };
}

export function applyOpenAIChunk(state: StreamResult, json: any, onText?: (t: string) => void): void {
  if (json?.usage) {
    if (typeof json.usage.prompt_tokens === 'number') state.usage.inputTokens = json.usage.prompt_tokens;
    if (typeof json.usage.completion_tokens === 'number') state.usage.outputTokens = json.usage.completion_tokens;
  }
  const choice = json?.choices?.[0];
  const delta = choice?.delta;
  if (typeof delta?.content === 'string' && delta.content) {
    state.text += delta.content;
    onText?.(delta.content);
  }
  if (Array.isArray(delta?.tool_calls)) {
    for (const call of delta.tool_calls) {
      const index = typeof call.index === 'number' ? call.index : 0;
      state.toolCalls[index] ??= { id: '', name: '', arguments: '' };
      const slot = state.toolCalls[index];
      if (call.id) slot.id = call.id;
      if (call.function?.name) slot.name = call.function.name;
      if (call.function?.arguments) slot.arguments += call.function.arguments;
    }
  }
  if (choice?.finish_reason) state.stopReason = choice.finish_reason;
}

export function applyAnthropicEvent(state: StreamResult, evt: any, onText?: (t: string) => void): void {
  if (evt?.type === 'message_start' && evt.message?.usage?.input_tokens) {
    state.usage.inputTokens = evt.message.usage.input_tokens;
  }
  if (evt?.type === 'message_delta' && evt.usage?.output_tokens) {
    state.usage.outputTokens = evt.usage.output_tokens;
  }
  if (evt?.type === 'content_block_start' && evt.content_block?.type === 'tool_use') {
    const index = typeof evt.index === 'number' ? evt.index : 0;
    state.toolCalls[index] = { id: evt.content_block.id, name: evt.content_block.name, arguments: '' };
  }
  if (evt?.type === 'content_block_delta') {
    if (evt.delta?.type === 'text_delta' && evt.delta.text) {
      state.text += evt.delta.text;
      onText?.(evt.delta.text);
    }
    if (evt.delta?.type === 'input_json_delta') {
      const index = typeof evt.index === 'number' ? evt.index : 0;
      state.toolCalls[index] ??= { id: '', name: '', arguments: '' };
      state.toolCalls[index].arguments += evt.delta.partial_json ?? '';
    }
  }
  if (evt?.type === 'message_delta' && evt.delta?.stop_reason) state.stopReason = evt.delta.stop_reason;
}

function toOpenAIMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((message) => {
    if (message.role === 'tool') {
      return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
    }
    if (message.role === 'assistant' && message.toolCalls?.length) {
      return {
        role: 'assistant',
        content: message.content || null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments || '{}' },
        })),
      };
    }
    return { role: message.role, content: message.content };
  });
}

function toAnthropicMessages(messages: ChatMessage[]): unknown[] {
  const out: unknown[] = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'tool') {
      out.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: message.toolCallId, content: message.content }],
      });
      continue;
    }
    if (message.role === 'assistant') {
      const content: unknown[] = [];
      if (message.content) content.push({ type: 'text', text: message.content });
      for (const call of message.toolCalls ?? []) {
        content.push({ type: 'tool_use', id: call.id, name: call.name, input: safeJson(call.arguments) });
      }
      out.push({ role: 'assistant', content: content.length ? content : [{ type: 'text', text: '' }] });
      continue;
    }
    out.push({ role: 'user', content: [{ type: 'text', text: message.content }] });
  }
  return out;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text || '{}');
  } catch {
    return {};
  }
}

function toOpenAITools(tools: ToolSpec[]): unknown[] {
  return tools.map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
}

function toAnthropicTools(tools: ToolSpec[]): unknown[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }));
}

export async function streamChat(options: StreamOptions): Promise<StreamResult> {
  const { provider, apiKey, model, messages, tools = [], signal, onText, onRetry, maxTokens } = options;
  const url = `${provider.baseUrl}${provider.chatPath}`;
  const state = newStreamState();

  const headers: Record<string, string> = {
    ...providerHeaders(provider, apiKey),
    'content-type': 'application/json',
    accept: 'text/event-stream',
  };
  let body: unknown;

  if (provider.format === 'anthropic') {
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    body = {
      model,
      max_tokens: maxTokens ?? 4096,
      stream: true,
      messages: toAnthropicMessages(messages),
      ...(system
        ? { system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] }
        : {}),
      ...(tools.length ? { tools: toAnthropicTools(tools) } : {}),
    };
  } else {
    body = {
      model,
      stream: true,
      stream_options: { include_usage: true },
      messages: toOpenAIMessages(messages),
      ...(tools.length ? { tools: toOpenAITools(tools) } : {}),
    };
  }

  const streamOnce = async (): Promise<void> => {
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => '');
      const error = new Error(
        `${provider.name} returned HTTP ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`,
      ) as Error & { status?: number };
      error.status = response.status;
      throw error;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const { events, rest } = splitSSE(buffer);
      buffer = rest;

      for (const block of events) {
        const { data } = parseSSEEvent(block);
        if (!data || data === '[DONE]') continue;
        let json: any;
        try {
          json = JSON.parse(data);
        } catch {
          continue;
        }
        if (provider.format === 'anthropic') applyAnthropicEvent(state, json, onText);
        else applyOpenAIChunk(state, json, onText);
      }
    }
  };

  const MAX_ATTEMPTS = 10;
  let failure: unknown = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await streamOnce();
      failure = null;
      break;
    } catch (error) {
      failure = error;
      const status = (error as { status?: number }).status;
      const retryable = status === undefined || status === 429 || status >= 500;
      const alreadyStreamed = state.text.length > 0 || state.toolCalls.length > 0;
      if (!retryable || alreadyStreamed || attempt === MAX_ATTEMPTS) break;
      onRetry?.(attempt, error instanceof Error ? error.message : 'request failed');
      await new Promise((resolve) => setTimeout(resolve, Math.min(400 * attempt, 4000)));
    }
  }

  if (failure && state.text.length === 0 && state.toolCalls.length === 0) throw failure;

  state.toolCalls = state.toolCalls.filter((call) => call && call.name);
  return state;
}

export async function listModels(provider: Provider, apiKey?: string): Promise<string[]> {
  const headers = providerHeaders(provider, apiKey);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`${provider.baseUrl}${provider.modelsPath}`, { headers, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const json = (await response.json()) as any;
    const rows: unknown[] = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : [];
    const ids = rows
      .map((row) => (typeof row === 'string' ? row : ((row as any)?.id ?? (row as any)?.name)))
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    return [...new Set(ids)].sort();
  } finally {
    clearTimeout(timer);
  }
}
