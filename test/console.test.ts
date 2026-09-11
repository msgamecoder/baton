import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'baton-console-'));
process.env.BATON_HOME = HOME;
writeFileSync(join(HOME, 'note.txt'), 'x');

const { parseSlash, slashHelp, directiveHelp } = await import('../src/core/console.ts');
const { buildUpPlan, buildHeadlessCommand, commandExists, runningAgents } = await import(
  '../src/core/launcher.ts'
);
const { validateMessage, MESSAGE_TYPES } = await import('../src/core/schema.ts');
const { defaultConfig } = await import('../src/core/config.ts');

test('parseSlash reads commands and args', () => {
  assert.deepEqual(parseSlash('/model oc deepseek-chat'), { name: 'model', args: ['oc', 'deepseek-chat'] });
  assert.deepEqual(parseSlash('  /send oc handoff build is ready  '), {
    name: 'send',
    args: ['oc', 'handoff', 'build', 'is', 'ready'],
  });
  assert.deepEqual(parseSlash('/STATUS'), { name: 'status', args: [] });
  assert.equal(parseSlash('hello'), null);
  assert.equal(parseSlash('/'), null);
  assert.equal(parseSlash('   '), null);
});

test('slash and directive help mention the key commands', () => {
  assert.match(slashHelp(), /\/model <agent> <model>/);
  assert.match(slashHelp(), /\/resume <agent>/);
  assert.match(directiveHelp(), /model=<name>/);
  assert.match(directiveHelp(), /resume/);
});

test('control messages are valid and keep their directive', () => {
  assert.ok((MESSAGE_TYPES as readonly string[]).includes('command'));
  const message = validateMessage({ from: 'coord', to: 'oc', type: 'command', summary: 'model=x', command: 'model=x' });
  assert.equal(message.type, 'command');
  assert.equal(message.command, 'model=x');
});

test('each agent can launch with its own model', () => {
  const config = defaultConfig();
  config.agents[0].model = 'deepseek/deepseek-chat';
  config.agents[1].model = 'claude-sonnet-4-6';
  config.splitter = 'pty';

  const plan = buildUpPlan(config);
  assert.match(plan.commands[0], /--model deepseek\/deepseek-chat/);
  assert.match(plan.commands[1], /--model claude-sonnet-4-6/);
});

test('buildHeadlessCommand substitutes prompt, model and resume', () => {
  const agent = {
    name: 'cc',
    command: 'cmd',
    headless: 'cmd -p "{prompt}" {model} {resume}',
    model: 'deepseek-chat',
    resumeFlag: '--continue',
  };
  assert.equal(
    buildHeadlessCommand(agent, 'fix the bug', { resume: true }),
    'cmd -p "fix the bug" deepseek-chat --continue',
  );
  assert.equal(buildHeadlessCommand(agent, 'hello'), 'cmd -p "hello" deepseek-chat');
});

test('buildHeadlessCommand explains a missing template', () => {
  assert.throws(() => buildHeadlessCommand({ name: 'x', command: 'x' }, 'hi'), /headless/);
});

test('commandExists detects real and missing binaries', () => {
  assert.equal(commandExists('node'), true);
  assert.equal(commandExists('node --version'), true);
  assert.equal(commandExists('definitely-not-a-real-binary-xyz'), false);
});

test('runningAgents is empty with no pid file', () => {
  assert.deepEqual(runningAgents(), []);
});
