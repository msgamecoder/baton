import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'baton-feat-'));
process.env.BATON_HOME = HOME;

const memory = await import('../src/core/memory.ts');
const media = await import('../src/core/media.ts');
const cost = await import('../src/core/cost.ts');
const session = await import('../src/core/session.ts');
const audit = await import('../src/core/audit.ts');
const probe = await import('../src/core/probe.ts');
const history = await import('../src/agent/history.ts');
const { checkLoop, BatonError } = await import('../src/core/schema.ts');

test('memory: remember, recall, forget', () => {
  memory.remember('user prefers tabs');
  memory.remember('always run tests');
  assert.equal(memory.allMemory().length, 2);

  assert.equal(memory.recall('tabs').length, 1);
  assert.equal(memory.recall('nope').length, 0);

  const removed = memory.forget('tabs');
  assert.equal(removed, 1);
  assert.equal(memory.allMemory().length, 1);

  const block = memory.memoryBlock();
  assert.match(block, /always run tests/);
});

test('media: storeFile records hash, size, mime', () => {
  const src = join(HOME, 'shot.png');
  writeFileSync(src, 'not really a png');
  const attachment = media.storeFile(src);

  assert.equal(attachment.hash?.length, 12);
  assert.equal(attachment.size, 16);
  assert.equal(attachment.mime, 'image/png');
  assert.equal(media.resolveMedia(attachment.path), attachment.path);
  assert.equal(media.listMedia().length, 1);
});

test('cost: cheapest capable model wins; task maps to a tier', () => {
  const tiny = cost.cheapestFor('tiny');
  assert.equal(tiny.model.tier, 'tiny');

  const large = cost.cheapestFor('large', 1000, 1000);
  assert.equal(large.model.tier, 'large');
  assert.ok(large.usd > 0);

  assert.equal(cost.tierForTask('rename a variable'), 'tiny');
  assert.equal(cost.tierForTask('implement a new feature module'), 'medium');
});

test('session: save, list, show', () => {
  session.saveSessionRaw('acct1', '{"cookies":[]}');
  assert.deepEqual(session.listSessions(), ['acct1']);
  assert.ok(session.sessionPath('acct1'));
  assert.equal(session.sessionPath('missing'), null);
});

test('audit: append and read back', () => {
  audit.audit('send', 'cc', 'oc:handoff');
  audit.audit('kill', 'cc', 'halted');
  const entries = audit.readAudit(10);
  assert.equal(entries.length, 2);
  assert.equal(entries[1].event, 'kill');
});

test('probe: project hints come from .env and package.json', () => {
  const project = mkdtempSync(join(tmpdir(), 'baton-proj-'));
  writeFileSync(join(project, '.env'), 'PORT=4321\n');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));
  const hints = probe.projectHints(project);
  const ports = hints.map((h) => h.port);
  assert.ok(ports.includes(4321));
  assert.ok(ports.includes(5173));
});

test('sessions are listed per project', () => {
  const base = {
    agent: 'a',
    provider: 'p',
    model: 'm',
    createdAt: 1,
    updatedAt: 1,
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0, requests: 0 },
  };
  history.saveSessionRecord({ ...base, id: 'proj-a-1', cwd: '/tmp/proj-a' });
  history.saveSessionRecord({ ...base, id: 'proj-b-1', cwd: '/tmp/proj-b' });
  history.saveSessionRecord({ ...base, id: 'legacy-no-cwd' });

  assert.deepEqual(
    history.listSessionRecords('/tmp/proj-a').map((record) => record.id),
    ['proj-a-1'],
  );
  assert.deepEqual(
    history.listSessionRecords('/tmp/proj-b').map((record) => record.id),
    ['proj-b-1'],
  );
  assert.ok(history.listSessionRecords().some((record) => record.id === 'legacy-no-cwd'));
});

test('guard: hop limit rejects a runaway handoff', () => {
  const message = {
    id: '1',
    ts: 1,
    from: 'cc',
    to: 'oc',
    type: 'handoff' as const,
    priority: 'normal' as const,
    summary: 'x',
    hop: 9,
  };
  assert.throws(() => checkLoop(message, 8), BatonError);
});
