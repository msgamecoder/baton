import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'baton-console-'));
process.env.BATON_HOME = HOME;
writeFileSync(join(HOME, 'note.txt'), 'x');

const { parseSlash, slashHelp, directiveHelp } = await import('../src/core/console.ts');
const { buildUpPlan, buildHeadlessCommand, commandExists, runningAgents, missingAgentCommands } = await import(
  '../src/core/launcher.ts'
);
const { validateMessage, MESSAGE_TYPES } = await import('../src/core/schema.ts');
const { defaultConfig } = await import('../src/core/config.ts');
const { tmuxBin, detectSplitters, userTmuxPath } = await import('../src/core/splitter.ts');
const registry = await import('../src/providers/registry.ts');
const { parseKeys } = await import('../src/ui/select.ts');
const { READ_ONLY_TOOLS, TOOLS } = await import('../src/agent/tools.ts');
const memory = await import('../src/core/memory.ts');

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
  assert.equal(commandExists(undefined), false);
  assert.equal(commandExists(''), false);
});

test('an agent with no command is Baton itself, not a missing binary', () => {
  assert.deepEqual(missingAgentCommands([{ name: 'left' }, { name: 'right' }]), []);
  assert.equal(missingAgentCommands([{ name: 'x', command: 'nope-xyz-123' }]).length, 1);
  assert.equal(missingAgentCommands([{ name: 'y', command: 'node' }]).length, 0);
});

test('runningAgents is empty with no pid file', () => {
  assert.deepEqual(runningAgents(), []);
});

test('splitter list always offers tmux and the pty fallback', () => {
  const names = detectSplitters().map((s) => s.name);
  assert.ok(names.includes('tmux'));
  assert.ok(names.includes('pty'));
  assert.equal(typeof tmuxBin(), 'string');
  assert.equal(userTmuxPath(), join(HOME, 'bin', 'tmux'));
});

test('parseKeys handles coalesced and single key sequences', () => {
  assert.deepEqual(parseKeys('\u001b[B\u001b[B\r'), [
    { name: 'down' },
    { name: 'down' },
    { name: 'enter' },
  ]);
  assert.deepEqual(parseKeys('\u001b[A'), [{ name: 'up' }]);
  assert.deepEqual(parseKeys('\u001bOA'), [{ name: 'up' }]);
  assert.deepEqual(parseKeys('\u001b[1;5B'), [{ name: 'down' }]);
  assert.deepEqual(parseKeys('\u001b'), [{ name: 'escape' }]);
  assert.deepEqual(parseKeys('\u0003'), [{ name: 'ctrl-c' }]);
  assert.deepEqual(parseKeys('ab\u007f'), [
    { name: 'char', char: 'a' },
    { name: 'char', char: 'b' },
    { name: 'backspace' },
  ]);
  assert.deepEqual(parseKeys('\u001b[C'), []);
});

test('plan mode exposes only read-only tools', () => {
  const readOnly = READ_ONLY_TOOLS.map((tool) => tool.name);
  for (const blocked of ['write_file', 'edit_file', 'shell']) {
    assert.ok(!readOnly.includes(blocked), `${blocked} must not be available in plan mode`);
  }
  for (const allowed of ['read_file', 'list_dir', 'glob', 'grep', 'ask_user']) {
    assert.ok(readOnly.includes(allowed), `${allowed} should be available in plan mode`);
  }
  assert.ok(TOOLS.length > READ_ONLY_TOOLS.length);
});

test('the agent gets task and ask tools, in both modes', () => {
  const names = TOOLS.map((tool) => tool.name);
  for (const tool of ['task_create', 'task_update', 'task_list', 'ask_user']) {
    assert.ok(names.includes(tool), `${tool} missing`);
  }
  const readOnly = READ_ONLY_TOOLS.map((tool) => tool.name);
  assert.ok(readOnly.includes('task_create'), 'planning should be able to make tasks');
  assert.ok(readOnly.includes('task_list'));
});

test('memory extracts and dedupes facts', () => {
  assert.deepEqual(memory.extractFacts('save my name is mxgamecoder to memory'), ['name: mxgamecoder']);
  assert.deepEqual(memory.extractFacts('my editor is neovim'), ['editor: neovim']);
  assert.deepEqual(memory.extractFacts('remember I prefer tabs'), ['preference: tabs']);
  assert.doesNotMatch(memory.extractFacts('what does this file do')[0] ?? '', /preference|name:/);

  const first = memory.rememberFact('name: mxgamecoder');
  const again = memory.rememberFact('name: mxgamecoder');
  assert.ok(first);
  assert.equal(again, null, 'the same fact must not be stored twice');
});

test('memory instructions are recognised', () => {
  assert.equal(memory.isMemoryInstruction('save my name is bob to memory'), true);
  assert.equal(memory.isMemoryInstruction("don't forget I use pnpm"), true);
  assert.equal(memory.isMemoryInstruction('build the login page'), false);
});

test('provider registry: grouped, ordered, complete', () => {
  const custom = [{ id: 'mine', name: 'Mine', format: 'openai' as const, baseUrl: 'https://x.example/v1' }];
  const list = registry.orderedProviders(custom);

  const groupIndices = list.map((p) => registry.GROUP_ORDER.indexOf(p.group));
  assert.deepEqual(groupIndices, [...groupIndices].sort((a, b) => a - b));

  for (const provider of list) {
    assert.ok(provider.chatPath.startsWith('/'), provider.id);
    assert.ok(provider.modelsPath.startsWith('/'), provider.id);
    assert.ok(['openai', 'anthropic'].includes(provider.format), provider.id);
    assert.ok(registry.GROUP_ORDER.includes(provider.group), provider.id);
    if (provider.id !== 'custom') assert.ok(provider.baseUrl.length > 0, provider.id);
  }

  assert.ok(list.some((p) => p.id === 'mine'), 'custom provider should be listed');
  assert.equal(registry.getProvider('mine', custom)?.baseUrl, 'https://x.example/v1');
  assert.equal(registry.getProvider('command-code')?.format, 'anthropic');
  assert.equal(registry.getProvider('command-code')?.chatPath, '/messages');
  assert.equal(registry.getProvider('deepseek')?.chatPath, '/chat/completions');
  assert.ok(registry.allProviders().length >= 25);
});
