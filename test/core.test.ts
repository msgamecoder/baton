import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.BATON_HOME = mkdtempSync(join(tmpdir(), 'baton-test-'));

const { validateMessage, canAutoContinue, parseMessageLine, BatonError } = await import(
  '../src/core/schema.ts'
);
const { appendMessage, inbox, getCursor, setCursor, readMessages } = await import(
  '../src/core/store.ts'
);

test('validateMessage fills defaults', () => {
  const m = validateMessage({ from: 'cc', to: 'oc', summary: 'hi' });
  assert.equal(m.type, 'fyi');
  assert.equal(m.priority, 'normal');
  assert.equal(m.hop, 0);
  assert.ok(m.id.length > 0);
});

test('validateMessage rejects bad input', () => {
  assert.throws(() => validateMessage({ to: 'oc', summary: 'x' }), BatonError);
  assert.throws(() => validateMessage({ from: 'cc', to: 'oc' }), BatonError);
  assert.throws(() => validateMessage(null), BatonError);
  assert.throws(
    () => validateMessage({ from: 'cc', to: 'oc', summary: 'x', type: 'nope' }),
    BatonError,
  );
});

test('canAutoContinue only for handoffs addressed to me, within the hop cap', () => {
  const base = {
    id: '1',
    ts: 1,
    from: 'cc',
    to: 'oc',
    type: 'handoff' as const,
    priority: 'normal' as const,
    summary: 'x',
    hop: 1,
  };
  assert.equal(canAutoContinue(base, 'oc', 8), true);
  assert.equal(canAutoContinue({ ...base, hop: 8 }, 'oc', 8), false);
  assert.equal(canAutoContinue({ ...base, hop: 9 }, 'oc', 8), false);
  assert.equal(canAutoContinue({ ...base, type: 'fyi' }, 'oc', 8), false);
  assert.equal(canAutoContinue(base, 'someone-else', 8), false);
  assert.equal(canAutoContinue({ ...base, from: 'oc' }, 'oc', 8), false);
  assert.equal(canAutoContinue({ ...base, autoContinue: false }, 'oc', 8), false);
});

test('parseMessageLine skips torn or empty lines', () => {
  assert.equal(parseMessageLine('not json'), null);
  assert.equal(parseMessageLine('   '), null);
  assert.equal(parseMessageLine('{"from":"a"}'), null);
  const ok = parseMessageLine(JSON.stringify({ from: 'a', to: 'b', summary: 's' }));
  assert.equal(ok?.summary, 's');
});

test('log: append, inbox, cursor advance, broadcast, no self-delivery', () => {
  appendMessage(validateMessage({ from: 'cc', to: 'oc', summary: 'one' }));
  appendMessage(validateMessage({ from: 'cc', to: '*', summary: 'two' }));
  appendMessage(validateMessage({ from: 'oc', to: '*', summary: 'mine' }));

  const received = inbox('oc', getCursor('oc'));
  assert.deepEqual(
    received.map((m) => m.summary),
    ['one', 'two'],
  );

  const last = received[received.length - 1];
  setCursor('oc', { ts: last.ts, id: last.id });
  assert.deepEqual(inbox('oc', getCursor('oc')), []);

  assert.equal(readMessages().length, 3);
});

test('provider session header follows the baton session, not the process', async () => {
  const { providerHeaders, setProviderSession } = await import('../src/providers/client.ts');
  const provider = {
    id: 'opencode-go',
    format: 'openai',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    chatPath: '/chat/completions',
    sessionHeader: 'x-opencode-session',
  };
  setProviderSession('20260912-120000');
  assert.equal(providerHeaders(provider, 'k')['x-opencode-session'], '20260912-120000');
  setProviderSession('20260912-121500');
  assert.equal(providerHeaders(provider, 'k')['x-opencode-session'], '20260912-121500');
});

test('history sanitizer drops an orphan tool result', async () => {
  const { sanitizeHistory } = await import('../src/agent/loop.ts');
  const cleaned = sanitizeHistory([
    { role: 'user', content: 'hi' },
    { role: 'tool', content: 'stray', toolCallId: 'gone', name: 'shell' },
    { role: 'assistant', content: 'hello' },
  ]);
  assert.equal(cleaned.length, 2);
  assert.equal(cleaned[0].content, 'hi');
  assert.equal(cleaned[1].content, 'hello');
});

test('history sanitizer keeps only tool calls that were answered', async () => {
  const { sanitizeHistory } = await import('../src/agent/loop.ts');
  const cleaned = sanitizeHistory([
    { role: 'user', content: 'do it' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 'a', name: 'shell', arguments: '{}' },
        { id: 'b', name: 'read_file', arguments: '{}' },
      ],
    },
    { role: 'tool', content: 'ran', toolCallId: 'a', name: 'shell' },
  ]);
  assert.equal(cleaned.length, 3);
  assert.deepEqual(
    cleaned[1].toolCalls?.map((call) => call.id),
    ['a'],
  );
  assert.equal(cleaned[2].toolCallId, 'a');
});

test('history sanitizer leaves a complete exchange untouched', async () => {
  const { sanitizeHistory } = await import('../src/agent/loop.ts');
  const input = [
    { role: 'user', content: 'q' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'x', name: 'shell', arguments: '{}' }] },
    { role: 'tool', content: 'ok', toolCallId: 'x', name: 'shell' },
    { role: 'assistant', content: 'done' },
  ];
  assert.deepEqual(sanitizeHistory(input), input);
});

test('history sanitizer drops an unanswered call with no text', async () => {
  const { sanitizeHistory } = await import('../src/agent/loop.ts');
  const cleaned = sanitizeHistory([
    { role: 'user', content: 'q' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'z', name: 'shell', arguments: '{}' }] },
  ]);
  assert.equal(cleaned.length, 1);
});
