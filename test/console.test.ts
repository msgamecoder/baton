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
const { providerHeaders } = await import('../src/providers/client.ts');
const { sanitizeHistory } = await import('../src/agent/loop.ts');

test('sanitizeHistory never leaves a tool_calls without its result', () => {
  const call = { id: 'a', name: 'read_file', arguments: '{}' };
  const assistant = { role: 'assistant' as const, content: '', toolCalls: [call] };
  const tool = { role: 'tool' as const, toolCallId: 'a', content: 'ok' };
  const user = { role: 'user' as const, content: 'hi' };

  // healthy pairing survives
  assert.equal(sanitizeHistory([user, assistant, tool] as never).length, 3);

  // a user message landed between the call and its result: the tool_calls must go
  const split = sanitizeHistory([user, assistant, user, tool] as never);
  assert.equal(
    split.some((message) => message.toolCalls?.length),
    false,
  );

  // a result with no call at all is dropped
  assert.equal(sanitizeHistory([user, tool] as never).length, 1);

  // only the answered call is kept, and it stays directly answered
  const two = { role: 'assistant' as const, content: '', toolCalls: [call, { id: 'b', name: 'x', arguments: '{}' }] };
  const repaired = sanitizeHistory([user, two, tool] as never);
  const kept = repaired.find((message) => message.toolCalls?.length);
  assert.equal(kept?.toolCalls?.length, 1);
  assert.equal(kept?.toolCalls?.[0].id, 'a');
  assert.equal(repaired[repaired.length - 1].role, 'tool');
});

test('markdown tables become aligned text', async () => {
  const { formatTables } = await import('../src/core/tables.ts');
  const out = formatTables('| A | B |\n|---|----|\n| xx | y |\n| z | wwww |');
  assert.ok(out.includes('│'), out);
  assert.ok(out.includes('├'), 'has a header rule');
  assert.equal(out.includes('|---'), false, 'separator row is gone');
  const widths = out
    .split('\n')
    .filter((line) => line.startsWith('│'))
    .map((line) => line.length);
  assert.equal(new Set(widths).size, 1, 'every row lines up to the same width');
  assert.equal(formatTables('no table here'), 'no table here');
});

test('tool calls get stable, unique ids so the protocol pairing holds', async () => {
  const { withStableIds } = await import('../src/agent/loop.ts');

  const generated = withStableIds([
    { id: '', name: 'a', arguments: '{}' },
    { id: '', name: 'b', arguments: '{}' },
  ]);
  assert.ok(generated[0].id && generated[1].id, 'a call with no id gets one');
  assert.notEqual(generated[0].id, generated[1].id, 'ids are unique');

  const dupes = withStableIds([
    { id: 'same', name: 'a', arguments: '{}' },
    { id: 'same', name: 'b', arguments: '{}' },
  ]);
  assert.equal(dupes[0].id, 'same', 'an existing unique id is kept');
  assert.notEqual(dupes[0].id, dupes[1].id, 'a repeated id is replaced');

  assert.equal(withStableIds([{ id: 'call_1', name: 'x', arguments: '{}' }])[0].id, 'call_1');

  // an id the conversation already used is replaced (some gateways reuse ids)
  const reused = withStableIds([{ id: 'repeat', name: 'a', arguments: '{}' }], new Set(['repeat']));
  assert.notEqual(reused[0].id, 'repeat');
});

test('a selection reads its text from the renderables it covers', async () => {
  const { selectionText } = await import('../src/ui/selection.ts');
  assert.equal(
    selectionText({ selectedRenderables: [{ getSelectedText: () => 'hello' }, { getSelectedText: () => 'world' }] }),
    'hello\nworld',
  );
  assert.equal(selectionText({ selectedRenderables: [{}, { getSelectedText: () => '' }] }), '');
  assert.equal(
    selectionText({
      selectedRenderables: [
        {
          getSelectedText: () => {
            throw new Error('gone');
          },
        },
      ],
    }),
    '',
  );
  assert.equal(selectionText(null), '');
  assert.equal(selectionText(undefined), '');
  assert.equal(selectionText({}), '');
});

test('wide tables wrap inside their cells and fit the width', async () => {
  const { formatTables, wrapLines } = await import('../src/core/tables.ts');
  const wrapped = wrapLines('one two three four five six seven eight nine ten', 12).split('\n');
  assert.ok(wrapped.length > 1, 'long text is wrapped');
  assert.ok(wrapped.every((line) => line.length <= 12), 'no line exceeds the width');
  const markdown = [
    '| Criteria | HTML (+CSS/JS) | React |',
    '|---|---|---|',
    '| What it is | Markup language + DOM | JS library for building UIs |',
    '| Long-term maintenance at scale | Unmanageable past a few pages | Component + ecosystem (router, state, testing) carries it |',
  ].join('\n');

  const out = formatTables(markdown, 60);
  const rows = out
    .split('\n')
    .filter((line) => line.startsWith('│') || line.startsWith('├'));
  assert.ok(rows.length >= 4, 'the table rendered');
  for (const row of rows) assert.ok(row.length <= 60, `row is ${row.length} wide, expected <= 60`);
  assert.equal(new Set(rows.map((row) => row.length)).size, 1, 'every row lines up to one width');
  assert.ok(out.includes('Component +'), 'long cell content wrapped instead of being cut');

  // inline markdown is stripped so the visible width matches the alignment
  const inline = formatTables('| **Bold** | `code` |\n|---|---|\n| **x** | `y` |', 80);
  assert.equal(inline.includes('**'), false);
  assert.equal(inline.includes('`'), false);
});

test('write and edit report line counts like a diff', async () => {
  const { runTool } = await import('../src/agent/tools.ts');
  const { mkdtempSync } = await import('node:fs');
  const dir = mkdtempSync('/tmp/baton-tool-');
  const written = await runTool('write_file', { path: `${dir}/a.txt`, content: 'one\ntwo\nthree' }, { cwd: dir });
  assert.match(written.output, /\+3 lines/);
  const edited = await runTool(
    'edit_file',
    { path: `${dir}/a.txt`, old_string: 'two', new_string: 'TWO\n2' },
    { cwd: dir },
  );
  assert.match(edited.output, /\+2 −1/);
});

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
  assert.deepEqual(memory.extractFacts('save my name is msgamecoder to memory'), ['name: msgamecoder']);
  assert.deepEqual(memory.extractFacts('my editor is neovim'), ['editor: neovim']);
  assert.deepEqual(memory.extractFacts('remember I prefer tabs'), ['preference: tabs']);
  assert.doesNotMatch(memory.extractFacts('what does this file do')[0] ?? '', /preference|name:/);

  const first = memory.rememberFact('name: msgamecoder');
  const again = memory.rememberFact('name: msgamecoder');
  assert.ok(first);
  assert.equal(again, null, 'the same fact must not be stored twice');
});

test('memory instructions are recognised', () => {
  assert.equal(memory.isMemoryInstruction('save my name is bob to memory'), true);
  assert.equal(memory.isMemoryInstruction("don't forget I use pnpm"), true);
  assert.equal(memory.isMemoryInstruction('build the login page'), false);
});

test('opencode go gets the session header it requires', () => {
  const go = registry.getProvider('opencode-go');
  assert.ok(go?.sessionHeader === 'x-opencode-session');
  const headers = providerHeaders(go!, 'sk-x');
  assert.equal(headers.authorization, 'Bearer sk-x');
  assert.equal(typeof headers['x-opencode-session'], 'string');
  assert.ok(String(headers['x-opencode-session']).length > 10, 'a real session id must be sent');

  const anthropic = registry.getProvider('anthropic');
  const anthropicHeaders = providerHeaders(anthropic!, 'sk-y');
  assert.equal(anthropicHeaders['x-api-key'], 'sk-y');
  assert.equal(anthropicHeaders['anthropic-version'], '2023-06-01');
  assert.equal(anthropicHeaders['x-opencode-session'], undefined);
});

test('agents answer to their name and their role', async () => {
  const { resolveAgent, agentLabel, agentAliases, duplicateAgentNames, normalizeAgents } = await import(
    '../src/core/config.ts'
  );
  const agents = normalizeAgents([
    { name: 'Nova', role: 'left' },
    { name: 'Rex', role: 'right' },
  ]);

  assert.equal(resolveAgent(agents, 'Nova')?.role, 'left');
  assert.equal(resolveAgent(agents, 'nova')?.role, 'left', 'name matching is case-insensitive');
  assert.equal(resolveAgent(agents, 'left')?.name, 'Nova', 'a role resolves to its agent');
  assert.equal(resolveAgent(agents, 'right')?.name, 'Rex');
  assert.equal(resolveAgent(agents, 'nobody'), undefined);
  assert.equal(agentLabel(agents[0]), 'Nova · left');
  assert.equal(agentLabel({ name: 'left', role: 'left' }), 'left', 'a name equal to its role is not repeated');
  assert.deepEqual(agentAliases(agents, 'left').sort(), ['Nova', 'left'].sort());
  assert.deepEqual(duplicateAgentNames([{ name: 'Nova' }, { name: 'nova' }]), ['nova']);
  assert.deepEqual(duplicateAgentNames(agents), []);

  // a legacy config that only has the old left/right names still gets roles
  const legacy = normalizeAgents([{ name: 'left' }, { name: 'right' }]);
  assert.equal(legacy[0].role, 'left');
  assert.equal(legacy[1].role, 'right');
  assert.equal(resolveAgent(legacy, 'right')?.name, 'right');
});

test('panes are placed by role but addressed by name', () => {
  const config = defaultConfig();
  config.splitter = 'pty';
  config.agents = [
    { name: 'Rex', role: 'right' },
    { name: 'Nova', role: 'left' },
  ];
  const plan = buildUpPlan(config);
  assert.match(plan.commands[0], /BATON_AGENT=Nova/);
  assert.match(plan.commands[0], /--agent Nova/);
  assert.match(plan.commands[1], /BATON_AGENT=Rex/);
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
