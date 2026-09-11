import { randomBytes } from 'node:crypto';

export const MESSAGE_TYPES = [
  'handoff',
  'blocked',
  'error',
  'question',
  'answer',
  'ack',
  'done',
  'fyi',
] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

export const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type Priority = (typeof PRIORITIES)[number];

export interface Attachment {
  path: string;
  mime?: string;
  size?: number;
  hash?: string;
}

export interface Built {
  path: string;
  note?: string;
}

export interface Contract {
  name?: string;
  sig?: string;
  notes?: string;
}

export interface Failure {
  where?: string;
  message: string;
  log?: string;
}

export interface Tests {
  ran?: string[];
  passed?: boolean;
  command?: string;
}

export interface GitRef {
  branch?: string;
  worktree?: string;
  commit?: string;
  diffStat?: string;
}

export interface Cost {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  usd?: number;
}

export interface Message {
  id: string;
  ts: number;
  from: string;
  to: string;
  type: MessageType;
  priority: Priority;
  summary: string;
  body?: string;
  built?: Built[];
  contract?: Contract;
  next?: string[];
  errors?: Failure[];
  tests?: Tests;
  git?: GitRef;
  attachments?: Attachment[];
  replyRequired?: boolean;
  inReplyTo?: string;
  hop?: number;
  sessionRef?: string;
  autoContinue?: boolean;
  cost?: Cost;
  memory?: string[];
}

export class BatonError extends Error {}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new BatonError(msg);
}

export function newId(): string {
  return Date.now().toString(36) + '-' + randomBytes(4).toString('hex');
}

function optionalArray<T>(value: unknown): T[] | undefined {
  return Array.isArray(value) ? (value as T[]) : undefined;
}

export function validateMessage(input: unknown): Message {
  assert(input !== null && typeof input === 'object', 'message must be an object');
  const m = input as Record<string, unknown>;

  assert(typeof m.from === 'string' && m.from.length > 0, 'from is required');
  assert(typeof m.to === 'string' && m.to.length > 0, 'to is required');
  assert(typeof m.summary === 'string' && m.summary.length > 0, 'summary is required');

  const type = (m.type ?? 'fyi') as MessageType;
  assert(MESSAGE_TYPES.includes(type), `invalid type: ${String(m.type)}`);

  const priority = (m.priority ?? 'normal') as Priority;
  assert(PRIORITIES.includes(priority), `invalid priority: ${String(m.priority)}`);

  const msg: Message = {
    id: typeof m.id === 'string' && m.id.length > 0 ? m.id : newId(),
    ts: typeof m.ts === 'number' ? m.ts : Date.now(),
    from: m.from,
    to: m.to,
    type,
    priority,
    summary: m.summary,
    hop: typeof m.hop === 'number' ? m.hop : 0,
  };

  if (typeof m.body === 'string') msg.body = m.body;
  if (typeof m.inReplyTo === 'string') msg.inReplyTo = m.inReplyTo;
  if (typeof m.sessionRef === 'string') msg.sessionRef = m.sessionRef;
  if (typeof m.replyRequired === 'boolean') msg.replyRequired = m.replyRequired;
  if (typeof m.autoContinue === 'boolean') msg.autoContinue = m.autoContinue;

  const built = optionalArray<Built>(m.built);
  if (built) msg.built = built;
  const next = optionalArray<string>(m.next);
  if (next) msg.next = next;
  const errors = optionalArray<Failure>(m.errors);
  if (errors) msg.errors = errors;
  const attachments = optionalArray<Attachment>(m.attachments);
  if (attachments) msg.attachments = attachments;
  const memory = optionalArray<string>(m.memory);
  if (memory) msg.memory = memory;

  if (m.contract !== null && typeof m.contract === 'object') msg.contract = m.contract as Contract;
  if (m.tests !== null && typeof m.tests === 'object') msg.tests = m.tests as Tests;
  if (m.git !== null && typeof m.git === 'object') msg.git = m.git as GitRef;
  if (m.cost !== null && typeof m.cost === 'object') msg.cost = m.cost as Cost;

  return msg;
}

export function parseMessageLine(line: string): Message | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return validateMessage(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

export function checkLoop(msg: Message, maxHop: number): void {
  if (msg.hop !== undefined && msg.hop > maxHop) {
    throw new BatonError(`hop limit reached (${msg.hop} > ${maxHop}) — stopping to avoid an agent loop`);
  }
}

export function canAutoContinue(msg: Message, agent: string, maxHop: number): boolean {
  if (msg.type !== 'handoff') return false;
  if (msg.to !== agent) return false;
  if (msg.from === agent) return false;
  if (msg.autoContinue === false) return false;
  const hop = msg.hop ?? 0;
  if (hop >= maxHop) return false;
  return true;
}
