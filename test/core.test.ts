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
