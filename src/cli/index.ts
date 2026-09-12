#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { BATON_HOME, CONFIG_PATH, DAEMON_PORT, LOG_PATH } from '../core/paths.ts';
import {
  agentAliases,
  agentLabel as formatAgent,
  configExists,
  defaultConfig,
  duplicateAgentNames,
  loadConfig,
  resolveAgent,
  saveConfig,
  type AgentConfig,
} from '../core/config.ts';
import {
  appendMessage,
  ensureHome,
  getCursor,
  inbox,
  pendingCount,
  readMessages,
  setCursor,
  tail,
} from '../core/store.ts';
import {
  MESSAGE_TYPES,
  BatonError,
  checkLoop,
  validateMessage,
  type Message,
  type MessageType,
  type Priority,
} from '../core/schema.ts';
import { daemonUp, remoteAck, remoteInbox, remoteSend } from '../core/client.ts';
import {
  buildHeadlessCommand,
  buildUpPlan,
  ensurePanes,
  missingAgentCommands,
  runningAgents,
  spawnBackground,
  stopAgents,
  tmuxAttach,
  tmuxSessionAlive,
  tmuxSessionExists,
} from '../core/launcher.ts';
import { detectSplitters, pickSplitter, tmuxBin } from '../core/splitter.ts';
import { allMemory, forget, memoryBlock, recall, remember } from '../core/memory.ts';
import { humanSize, listMedia, storeFile } from '../core/media.ts';
import { cheapestFor, cost, loadPrices, tierForTask, type Tier } from '../core/cost.ts';
import { detectPorts } from '../core/probe.ts';
import { listSessions, saveSession, sessionPath, sessionPreview } from '../core/session.ts';
import { audit, readAudit } from '../core/audit.ts';
import { protocolText } from '../core/instructions.ts';
import { doctorReport, installTmuxUser, runInstall, userInstallAvailable } from '../core/doctor.ts';
import { parseSlash, slashHelp, directiveHelp } from '../core/console.ts';
import { startChat } from '../agent/chat.ts';
import { buildSystemPrompt, runTurn } from '../agent/loop.ts';
import {
  allProviders,
  getProvider,
  GROUP_LABELS,
  orderedProviders,
  type CustomProviderDef,
  type Provider,
  type WireFormat,
} from '../providers/registry.ts';
import { keysFile, resolveKey, saveKey } from '../core/keys.ts';
import { listModels } from '../providers/client.ts';
import { closePrompts, confirm } from '../core/prompt.ts';
import { confirmBox, inputBox, isInteractive, note, printCard, selectBox, UiCancelled, type SelectItem } from '../ui/select.ts';

type FlagValue = string | boolean | string[];
type Flags = Record<string, FlagValue>;

const DAEMON_PID_PATH = join(BATON_HOME, 'daemon.pid');

function parseArgs(argv: string[]): { flags: Flags; positional: string[] } {
  const flags: Flags = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        const existing = flags[key];
        if (existing === undefined) flags[key] = next;
        else if (Array.isArray(existing)) existing.push(next);
        else flags[key] = [existing, next];
        i++;
      } else {
        const existing = flags[key];
        if (existing === undefined) flags[key] = true;
        else if (Array.isArray(existing)) existing.push(true);
        else flags[key] = [existing, true];
      }
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

function str(flags: Flags, key: string): string | undefined {
  const value = flags[key];
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    for (let i = value.length - 1; i >= 0; i--) {
      const item = value[i];
      if (typeof item === 'string') return item;
    }
  }
  return undefined;
}

function list(flags: Flags, key: string): string[] | undefined {
  const value = flags[key];
  if (value === undefined || typeof value === 'boolean') return undefined;
  return Array.isArray(value) ? value : [value];
}

function bool(flags: Flags, key: string): boolean {
  const value = flags[key];
  return value === true || value === 'true';
}

function version(): string {
  try {
    const pkg = new URL('../../package.json', import.meta.url);
    return (JSON.parse(readFileSync(pkg, 'utf8')) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Accept either an agent's name or its role, and return the canonical name. */
function canonicalAgent(ref: string | undefined): string | undefined {
  if (!ref) return undefined;
  return resolveAgent(loadConfig().agents, ref)?.name ?? ref;
}

function requireSender(flags: Flags): string {
  const from = canonicalAgent(str(flags, 'from') || process.env.BATON_AGENT || loadConfig().agents[0]?.name);
  if (!from) throw new BatonError('no sender (use --from, set BATON_AGENT, or run `baton init`)');
  return from;
}

function requireAgent(flags: Flags): string {
  const agent = canonicalAgent(str(flags, 'agent') || process.env.BATON_AGENT || loadConfig().agents[0]?.name);
  if (!agent) throw new BatonError('no agent (use --agent, set BATON_AGENT, or run `baton init`)');
  return agent;
}

function resolveSelf(flags: Flags): string {
  const self = canonicalAgent(
    str(flags, 'from') || str(flags, 'agent') || process.env.BATON_AGENT || loadConfig().agents[0]?.name,
  );
  if (!self) throw new BatonError('no identity (use --agent, set BATON_AGENT, or run `baton init`)');
  return self;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatMessage(m: Message): string {
  const time = new Date(m.ts).toISOString().slice(11, 19);
  const lines = [`[${time}] ${m.from} -> ${m.to}  ${m.type} (${m.priority})  ${m.id}`, `    ${m.summary}`];
  if (m.body) lines.push(m.body.split('\n').map((l) => '    ' + l).join('\n'));
  if (m.next?.length) lines.push(`    next: ${m.next.join(' | ')}`);
  if (m.built?.length) lines.push(`    built: ${m.built.map((b) => b.path).join(', ')}`);
  if (m.errors?.length) lines.push(`    errors: ${m.errors.map((e) => e.message).join(' | ')}`);
  if (m.attachments?.length) lines.push(`    attachments: ${m.attachments.map((a) => a.path).join(', ')}`);
  if (m.hop) lines.push(`    hop: ${m.hop}`);
  return lines.join('\n');
}

function printMessages(messages: Message[], asJson: boolean): void {
  if (asJson) {
    for (const m of messages) console.log(JSON.stringify(m));
    return;
  }
  for (const m of messages) console.log(formatMessage(m));
}

function prepare(partial: Record<string, unknown>): Message {
  const config = loadConfig();
  // from/to may be a name or a role — store the canonical name either way
  const from =
    typeof partial.from === 'string' ? resolveAgent(config.agents, partial.from)?.name ?? partial.from : partial.from;
  const to =
    typeof partial.to === 'string' && partial.to !== '*'
      ? resolveAgent(config.agents, partial.to)?.name ?? partial.to
      : partial.to;
  const message = validateMessage({ ...partial, from, to });
  if (message.attachments) {
    message.attachments = message.attachments.map((a) => (existsSync(a.path) ? storeFile(a.path) : a));
  }
  checkLoop(message, config.maxHop);
  return message;
}

function aliasesFor(agent: string): string[] {
  return agentAliases(loadConfig().agents, agent).filter((ref) => ref !== agent);
}

async function deliver(message: Message): Promise<Message> {
  let stored = message;
  if (await daemonUp()) {
    const sent = await remoteSend(message);
    if (sent) stored = sent;
    else appendMessage(message);
  } else {
    appendMessage(message);
  }
  audit('send', stored.from, `${stored.to}:${stored.type}`);
  return stored;
}

async function resolveInput(flags: Flags): Promise<Record<string, unknown> | undefined> {
  const inputArg = str(flags, 'input');
  if (inputArg === undefined) return undefined;
  let raw: string;
  if (inputArg === '-') raw = await readStdin();
  else if (inputArg.startsWith('@')) raw = readFileSync(inputArg.slice(1), 'utf8');
  else raw = inputArg;
  return JSON.parse(raw) as Record<string, unknown>;
}

async function collectInbox(agent: string, waitMs: number, peek: boolean): Promise<Message[]> {
  if (await daemonUp()) {
    const remote = await remoteInbox(agent, waitMs, peek);
    if (remote) return remote;
  }
  const aliases = aliasesFor(agent);
  const deadline = Date.now() + waitMs;
  for (;;) {
    const messages = inbox(agent, getCursor(agent), aliases);
    if (messages.length > 0 || Date.now() >= deadline) {
      if (messages.length > 0 && !peek) {
        const last = messages[messages.length - 1];
        setCursor(agent, { ts: last.ts, id: last.id });
      }
      return messages;
    }
    await sleep(400);
  }
}

async function cmdSend(flags: Flags): Promise<void> {
  const raw = await resolveInput(flags);
  let partial: Record<string, unknown>;

  if (raw !== undefined) {
    partial = raw;
  } else {
    const to = str(flags, 'to');
    const summary = str(flags, 'summary');
    if (!to) throw new BatonError('send needs --to');
    if (!summary) throw new BatonError('send needs --summary (or pass --input)');

    partial = {
      from: requireSender(flags),
      to,
      type: (str(flags, 'type') as MessageType) ?? 'fyi',
      priority: (str(flags, 'priority') as Priority) ?? 'normal',
      summary,
      body: str(flags, 'body'),
      next: list(flags, 'next'),
      built: list(flags, 'built')?.map((path) => ({ path })),
      replyRequired: bool(flags, 'reply-required') ? true : undefined,
      inReplyTo: str(flags, 'in-reply-to'),
      hop: str(flags, 'hop') ? Number(str(flags, 'hop')) : 0,
      autoContinue: str(flags, 'auto-continue') === 'false' ? false : undefined,
      sessionRef: str(flags, 'session'),
    };
  }

  const stored = await deliver(prepare(partial));
  if (bool(flags, 'json')) console.log(JSON.stringify(stored));
  else console.log(`${stored.id}  ${stored.from} -> ${stored.to}  ${stored.type}`);
}

async function cmdCmd(flags: Flags, positional: string[]): Promise<void> {
  const [agent, ...rest] = positional;
  if (!agent || rest.length === 0) throw new BatonError('usage: baton cmd <agent> <directive>');
  const directive = rest.join(' ');
  const stored = await deliver(
    prepare({ from: requireSender(flags), to: agent, type: 'command', summary: directive, command: directive }),
  );
  console.log(`${stored.id}  -> ${agent}  command: ${directive}`);
}

async function cmdInbox(flags: Flags): Promise<void> {
  const agent = requireAgent(flags);
  const waitMs = str(flags, 'wait') ? Number(str(flags, 'wait')) : 0;
  const messages = await collectInbox(agent, waitMs, bool(flags, 'peek'));
  printMessages(messages, bool(flags, 'json'));
}

async function cmdAck(flags: Flags, positional: string[]): Promise<void> {
  const agent = requireAgent(flags);
  const id = positional[0] ?? str(flags, 'id');

  if (await daemonUp()) {
    const ok = await remoteAck(agent, id);
    if (ok) {
      console.log(id ? `acked ${agent} up to ${id}` : `acked ${agent}`);
      return;
    }
  }

  if (id) {
    const found = readMessages().find((m) => m.id === id);
    if (!found) throw new BatonError(`no message with id ${id}`);
    setCursor(agent, { ts: found.ts, id: found.id });
    console.log(`acked ${agent} up to ${id}`);
    return;
  }
  const messages = inbox(agent, getCursor(agent), aliasesFor(agent));
  const last = messages[messages.length - 1];
  if (last) setCursor(agent, { ts: last.ts, id: last.id });
  console.log(`${agent}: ${messages.length ? `acked ${messages.length}` : 'nothing to ack'}`);
}

async function cmdStatus(flags: Flags): Promise<void> {
  const config = loadConfig();
  const messages = readMessages();
  const live = await daemonUp();
  const splitter = pickSplitter(config.splitter);

  if (bool(flags, 'json')) {
    console.log(
      JSON.stringify({
        home: BATON_HOME,
        daemon: live ? `up :${config.port}` : 'down',
        splitter: splitter.name,
        total: messages.length,
        agents: config.agents.map((a) => ({
          name: a.name,
          role: a.role ?? null,
          command: a.command,
          model: a.model ?? null,
          pending: pendingCount(a.name, aliasesFor(a.name)),
        })),
        memory: allMemory().length,
      }),
    );
    return;
  }

  console.log(`baton home : ${BATON_HOME}`);
  console.log(`daemon     : ${live ? `up on :${config.port}` : 'down (files-only mode)'}`);
  console.log(`splitter   : ${splitter.name} — ${splitter.note}`);
  console.log(`messages   : ${messages.length}`);
  console.log(`memory     : ${allMemory().length} entries`);
  console.log('agents:');
  for (const agent of config.agents) {
    const model = agent.model ? ` model=${agent.model}` : '';
    const command = agent.command ?? '';
    console.log(
      `  ${formatAgent(agent).padEnd(20)} ${command.padEnd(14)}${model}  pending: ${pendingCount(agent.name, aliasesFor(agent.name))}`,
    );
  }
  const last = messages[messages.length - 1];
  if (last) console.log(`last       : ${new Date(last.ts).toISOString()}  ${last.from} -> ${last.to}  ${last.summary}`);
}

async function cmdWatch(flags: Flags): Promise<void> {
  const agent = requireAgent(flags);
  console.log(`watching inbox for ${agent} (ctrl-c to stop)`);
  for (;;) {
    const messages = await collectInbox(agent, 5000, false);
    if (messages.length > 0) printMessages(messages, bool(flags, 'json'));
  }
}

function cmdSplitters(flags: Flags): void {
  const all = detectSplitters();
  const chosen = pickSplitter(str(flags, 'prefer') ?? loadConfig().splitter);
  if (bool(flags, 'json')) {
    console.log(JSON.stringify({ chosen: chosen.name, available: all }, null, 2));
    return;
  }
  console.log(`chosen: ${chosen.name} (${chosen.note})`);
  for (const s of all) console.log(`  ${s.available ? 'x' : ' '} ${s.name.padEnd(9)} ${s.note}`);
}

function cmdInit(flags: Flags): void {
  ensureHome();
  if (configExists() && !bool(flags, 'force')) {
    console.log(`config already exists: ${CONFIG_PATH} (use --force to overwrite)`);
  } else {
    saveConfig(defaultConfig());
    console.log(`wrote ${CONFIG_PATH}`);
  }
  console.log(`log  : ${LOG_PATH}`);
  console.log('next : baton doctor   # check the terminal setup');
}

function cmdLog(flags: Flags): void {
  const n = str(flags, 'n') ? Number(str(flags, 'n')) : 20;
  printMessages(tail(n), bool(flags, 'json'));
}

function cmdDoctor(flags: Flags): void {
  const report = doctorReport();
  console.log(`${report.node.ok ? 'ok  ' : 'MISS'} node       ${report.node.version} (need >= ${report.node.required})`);
  console.log(`ok   platform   ${report.platform}`);
  console.log(`     splitter   ${report.chosen}`);
  for (const s of report.splitters) console.log(`  ${s.available ? 'x' : ' '} ${s.name.padEnd(9)} ${s.note}`);

  if (report.install) {
    console.log(`\nfor real panes, install a multiplexer:`);
    if (userInstallAvailable()) console.log('  baton install          tmux into ~/.baton/bin (no sudo)');
    console.log(`  ${report.install.command}    # ${report.install.note}`);
  }

  if (bool(flags, 'install')) {
    if (!report.install) {
      console.log('\nnothing to install');
      return;
    }
    console.log(`\nrunning: ${report.install.command}`);
    const code = runInstall(report.install);
    console.log(code === 0 ? 'done — run `baton splitters` to confirm' : `installer exited ${code}`);
  } else {
    console.log('\nrun `baton install` to do it now');
  }
}

function cmdPanes(): void {
  const config = loadConfig();
  const result = ensurePanes(config);
  console.log(result.message);
  if (result.panes > 0 && !process.env.TMUX) tmuxAttach();
}

function cmdInstall(flags: Flags): void {
  if (!bool(flags, 'system') && userInstallAvailable()) {
    console.log('installing tmux into ~/.baton/bin (no sudo needed) ...');
    const result = installTmuxUser();
    if (result.ok) {
      console.log(`installed ${result.path}`);
      console.log('run `baton splitters` to confirm');
      return;
    }
    console.log(`user install failed: ${result.error}`);
    console.log('falling back to the system installer\n');
  }

  const report = doctorReport();
  if (!report.install) {
    console.log('no installer for this platform — Baton will use the PTY fallback');
    return;
  }
  console.log(`running: ${report.install.command}`);
  const code = runInstall(report.install);
  console.log(code === 0 ? 'done — run `baton splitters` to confirm' : `installer exited ${code}`);
}

function startDaemonDetached(): void {
  const script = process.argv[1];
  if (!script) throw new BatonError('cannot locate CLI entry to start the daemon');
  const child = spawn(process.execPath, [script, 'daemon'], { detached: true, stdio: 'ignore' });
  child.unref();
  if (child.pid) writeFileSync(DAEMON_PID_PATH, String(child.pid));
}

async function cmdUp(flags: Flags): Promise<void> {
  const config = loadConfig();
  const wantApprove = !bool(flags, 'ask');
  if (wantApprove && config.autoApprove !== true) {
    config.autoApprove = true;
    saveConfig(config);
    console.log('agents have full permission by default — they will not ask before writing or running things');
    console.log('(use `baton --ask` to make them ask again)');
  } else if (!wantApprove && config.autoApprove === true) {
    config.autoApprove = false;
    saveConfig(config);
    console.log('auto-approve off — agents will ask before writing or running things');
  }
  const plan = buildUpPlan(config);

  if (bool(flags, 'dry-run')) {
    console.log(`splitter: ${plan.splitter} — ${plan.note}`);
    for (const command of plan.commands) console.log(`  ${command}`);
    return;
  }

  if (!bool(flags, 'force')) {
    if (plan.splitter === 'tmux' && tmuxSessionExists()) {
      const stampPath = join(BATON_HOME, 'session-stamp');
      let stamp = '';
      try {
        stamp = String(statSync(process.argv[1] as string).mtimeMs);
      } catch {
        stamp = '';
      }
      const previous = existsSync(stampPath) ? readFileSync(stampPath, 'utf8').trim() : '';
      const changed = Boolean(stamp && (!previous || previous !== stamp));
      if (changed || !tmuxSessionAlive()) {
        spawnSync(tmuxBin(), ['kill-session', '-t', 'baton'], { stdio: 'ignore' });
        console.log(
          changed
            ? 'baton changed since that session started — starting fresh panes with the new code'
            : 'the last baton session had already exited — starting a fresh one',
        );
      } else {
        if (stamp) writeFileSync(stampPath, stamp);
        const ensured = ensurePanes(config);
        console.log(`baton is already running — ${ensured.message}`);
        if (!process.env.TMUX) tmuxAttach();
        return;
      }
      if (stamp) writeFileSync(stampPath, stamp);
    }
    const running = runningAgents();
    if (running.length > 0) {
      console.log(`already running: ${running.map((a) => a.name).join(', ')}`);
      console.log('tail: baton logs <agent>   restart: baton up --force   stop: baton kill');
      return;
    }
  }

  const missing = missingAgentCommands(config.agents);
  if (missing.length > 0) {
    console.log(`warning: not on PATH — ${missing.map((a) => `${a.name} (${a.command})`).join(', ')}`);
  }

  if (!(await daemonUp())) {
    startDaemonDetached();
    await sleep(600);
  }

  if (plan.background) {
    const started = spawnBackground(config);
    for (const agent of started) {
      console.log(`started ${agent.name} (pid ${agent.pid ?? '?'}) -> ${agent.log}`);
    }
    console.log(`daemon: ${(await daemonUp()) ? 'up' : 'down'} on :${config.port}`);
    console.log('watch logs: baton logs <agent>   stop: baton kill');
    return;
  }

  console.log(`splitter: ${plan.splitter} — ${plan.note}`);
  for (const command of plan.commands) {
    const result = spawnSync(command, { shell: true, stdio: 'inherit' });
    if (result.status !== 0 && result.status !== null) console.log(`(${plan.splitter} exited ${result.status})`);
  }
  afterPanes();
}

function afterPanes(): void {
  try {
    const dir = join(BATON_HOME, 'chats');
    if (!existsSync(dir)) return;
    const files = readdirSync(dir).filter((name) => name.endsWith('.json'));
    if (files.length === 0) return;
    let newest = files[0];
    for (const name of files) {
      if (statSync(join(dir, name)).mtimeMs > statSync(join(dir, newest)).mtimeMs) newest = name;
    }
    const record = JSON.parse(readFileSync(join(dir, newest), 'utf8')) as {
      id?: string;
      agent?: string;
      messages?: unknown[];
      usage?: { inputTokens?: number; outputTokens?: number };
    };
    const id = record.id ?? newest.replace(/\.json$/, '');
    const usage = record.usage ?? {};
    const tokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
    console.log('');
    console.log(`thanks — that was a good session with baton ${version()}`);
    console.log('');
    console.log(`  agent      ${record.agent ?? ''}`);
    console.log(`  session    ${id}`);
    console.log(`  messages   ${Array.isArray(record.messages) ? record.messages.length : 0}`);
    console.log(`  tokens     ${tokens.toLocaleString()}`);
    console.log('');
    console.log(`come back with:  baton ${id}`);
    console.log('');
  } catch {
    /* the summary is best effort */
  }
}

async function cmdDown(): Promise<void> {
  if (existsSync(DAEMON_PID_PATH)) {
    const pid = Number(readFileSync(DAEMON_PID_PATH, 'utf8').trim());
    if (pid) {
      try {
        process.kill(pid, 'SIGTERM');
        console.log(`stopped daemon (pid ${pid})`);
      } catch {
        console.log('daemon was not running');
      }
    }
    unlinkSync(DAEMON_PID_PATH);
  } else {
    console.log('no daemon pid recorded');
  }
}

async function cmdKill(): Promise<void> {
  if (tmuxSessionExists()) {
    spawnSync(tmuxBin(), ['kill-session', '-t', 'baton'], { stdio: 'ignore' });
    console.log('closed the baton tmux session');
  }
  const stopped = stopAgents();
  await cmdDown();
  console.log(`stopped ${stopped} agent(s) — baton is halted`);
}

function cmdLogs(positional: string[]): void {
  const names = positional[0] ? [positional[0]] : loadConfig().agents.map((a) => a.name);
  for (const name of names) {
    const path = join(BATON_HOME, 'agents', `${name}.log`);
    if (!existsSync(path)) {
      console.log(`${name}: no log (${path})`);
      continue;
    }
    console.log(`--- ${name} ---`);
    console.log(readFileSync(path, 'utf8').split('\n').slice(-40).join('\n'));
  }
}

function cmdRun(flags: Flags, positional: string[]): void {
  const [agentName, ...promptParts] = positional;
  if (!agentName) throw new BatonError('usage: baton run <agent> <prompt>');

  const agent = resolveAgent(loadConfig().agents, agentName);
  if (!agent) throw new BatonError(`unknown agent: ${agentName}`);

  const prompt = promptParts.join(' ') || str(flags, 'prompt') || '';
  let command: string;
  try {
    command = buildHeadlessCommand(agent, prompt, {
      model: str(flags, 'model'),
      resume: bool(flags, 'resume') || bool(flags, 'continue'),
    });
  } catch (error) {
    throw new BatonError(error instanceof Error ? error.message : 'cannot build command');
  }

  if (bool(flags, 'dry-run')) {
    console.log(command);
    return;
  }

  audit('run', agent.name, command.slice(0, 160));
  const result = spawnSync(command, {
    shell: true,
    stdio: 'inherit',
    env: { ...process.env, BATON_AGENT: agent.name, ...(agent.env ?? {}) },
  });
  if (typeof result.status === 'number' && result.status !== 0) process.exitCode = result.status;
}

function cmdMemory(action: string | undefined, flags: Flags, positional: string[]): void {
  const text = positional.join(' ').trim();

  if (action === 'remember' || action === 'add') {
    if (!text) throw new BatonError('remember needs text: baton remember "keep this"');
    console.log(`remembered ${remember(text, str(flags, 'source')).id}`);
    return;
  }
  if (action === 'forget') {
    const count = forget(text || undefined);
    console.log(text ? `forgot ${count} entr(ies) matching "${text}"` : `cleared ${count} entr(ies)`);
    return;
  }
  const entries = recall(text || undefined);
  if (bool(flags, 'json')) {
    console.log(JSON.stringify(entries, null, 2));
    return;
  }
  if (entries.length === 0) console.log('(no memory)');
  for (const entry of entries) console.log(`${entry.id}  ${entry.text}`);
}

function cmdAttach(positional: string[], flags: Flags): void {
  const path = positional[0];
  if (!path) throw new BatonError('attach needs a file path');
  if (!existsSync(path)) throw new BatonError(`no such file: ${path}`);
  const attachment = storeFile(path);
  if (bool(flags, 'json')) console.log(JSON.stringify(attachment));
  else console.log(`${attachment.path}  (${humanSize(attachment.size ?? 0)}, ${attachment.mime}, ${attachment.hash})`);
}

function cmdMedia(flags: Flags): void {
  const items = listMedia();
  if (bool(flags, 'json')) {
    console.log(JSON.stringify(items, null, 2));
    return;
  }
  if (items.length === 0) console.log('(no media)');
  for (const item of items) console.log(`${humanSize(item.size ?? 0).padStart(9)}  ${item.mime?.padEnd(24)}  ${item.path}`);
}

function cmdModel(flags: Flags): void {
  const hint = str(flags, 'for') ?? '';
  const tier = (str(flags, 'tier') as Tier) ?? tierForTask(hint);
  const inputTokens = Number(str(flags, 'in') ?? '2000');
  const outputTokens = Number(str(flags, 'out') ?? '800');
  const { model, usd } = cheapestFor(tier, inputTokens, outputTokens);

  if (bool(flags, 'json')) {
    console.log(JSON.stringify({ tier, hint, model, estimatedUsd: usd }, null, 2));
    return;
  }
  console.log(`task    : ${hint || '(none)'} -> tier ${tier}`);
  console.log(`model   : ${model.id}  (${model.provider}, tier ${model.tier})`);
  console.log(`price   : $${model.in}/M in, $${model.out}/M out`);
  console.log(`estimate: ~$${usd.toFixed(4)} for ${inputTokens} in + ${outputTokens} out tokens`);
  console.log('(edit ~/.baton/prices.json to match your providers)');
}

function cmdCost(flags: Flags): void {
  const models = loadPrices();
  const id = str(flags, 'model');
  const inputTokens = Number(str(flags, 'in') ?? '0');
  const outputTokens = Number(str(flags, 'out') ?? '0');

  if (id) {
    const model = models.find((m) => m.id === id);
    if (!model) throw new BatonError(`unknown model: ${id}`);
    console.log(`$${cost(model, inputTokens, outputTokens).toFixed(4)}`);
    return;
  }

  const rows = models.map((m) => ({ model: m, usd: cost(m, inputTokens, outputTokens) })).sort((a, b) => a.usd - b.usd);
  for (const row of rows) console.log(`${row.usd.toFixed(4)}  ${row.model.tier.padEnd(7)} ${row.model.id}`);
}

async function cmdPort(flags: Flags): Promise<void> {
  const cwd = str(flags, 'dir') ?? process.cwd();
  const { hints, results } = await detectPorts(cwd);

  if (bool(flags, 'json')) {
    console.log(JSON.stringify({ hints, results }, null, 2));
    return;
  }
  if (hints.length > 0) {
    console.log('hints from the project:');
    for (const hint of hints) console.log(`  ${hint.port}  (${hint.source})`);
  }
  const useful = results.filter((r) => r.project || r.hinted || (r.reachable && r.looksLikeApp));
  console.log('candidates that look like an app:');
  for (const result of useful.slice(0, 10)) {
    const tag = result.project ? '[this project] ' : result.hinted ? '[project hint] ' : '';
    console.log(`  ${String(result.port).padEnd(6)} ${tag}up (HTTP ${result.status}, ${result.contentType || 'unknown'})`);
  }
  const live = useful.find((r) => r.project) ?? useful.find((r) => r.hinted) ?? useful[0];
  if (live) console.log(`\nuse this one: http://127.0.0.1:${live.port}/`);
  else console.log('\nnothing that looks like your app is serving — start the project dev server first');
}

function cmdSession(action: string | undefined, positional: string[], flags: Flags): void {
  if (action === 'save') {
    const name = positional[0];
    const file = positional[1] ?? str(flags, 'from');
    if (!name || !file) throw new BatonError('session save <name> <file.json>');
    console.log(`saved ${name} -> ${saveSession(name, file)}`);
    return;
  }
  if (action === 'show' || action === 'get') {
    const name = positional[0];
    if (!name) throw new BatonError('session show <name>');
    const path = sessionPath(name);
    if (!path) throw new BatonError(`no session named ${name}`);
    console.log(path);
    return;
  }
  const names = listSessions();
  if (names.length === 0) {
    console.log('(no saved sessions)');
    return;
  }
  for (const name of names) {
    const preview = (sessionPreview(name) ?? '').replace(/\s+/g, ' ').slice(0, 80);
    console.log(`${name.padEnd(18)} ${preview}`);
  }
}

function cmdAudit(flags: Flags): void {
  const entries = readAudit(str(flags, 'n') ? Number(str(flags, 'n')) : 50);
  for (const entry of entries) {
    console.log(
      `${new Date(entry.ts).toISOString()}  ${entry.event.padEnd(10)} ${(entry.agent ?? '').padEnd(8)} ${entry.detail ?? ''}`,
    );
  }
}

function cmdContext(): void {
  console.log(protocolText());
  const block = memoryBlock();
  if (block) console.log(block);
}

function agentLabel(agent: AgentConfig): string {
  return `${formatAgent(agent).padEnd(20)} ${(agent.command ?? '').padEnd(16)} model: ${agent.model ?? '(default)'}`;
}

async function handleSlash(self: string, line: string): Promise<'quit' | void> {
  const slash = parseSlash(line);
  if (!slash) {
    if (line.trim()) console.log('commands start with / — try /help');
    return;
  }

  const [first, second, ...rest] = slash.args;
  switch (slash.name) {
    case 'help':
      console.log(slashHelp());
      break;
    case 'status':
      await cmdStatus({});
      break;
    case 'agents':
      for (const agent of loadConfig().agents) console.log(agentLabel(agent));
      break;
    case 'send': {
      if (!first || !second) {
        console.log('usage: /send <to> [type] <text>');
        break;
      }
      const isType = (MESSAGE_TYPES as readonly string[]).includes(second);
      const type = (isType ? second : 'fyi') as MessageType;
      const summary = isType ? rest.join(' ') : [second, ...rest].join(' ');
      if (!summary) {
        console.log('nothing to send');
        break;
      }
      const stored = await deliver(prepare({ from: self, to: first, type, summary }));
      console.log(`${stored.id}  ${self} -> ${first}  ${type}`);
      break;
    }
    case 'inbox': {
      const agent = canonicalAgent(first) ?? self;
      const messages = await collectInbox(agent, 0, false);
      printMessages(messages, false);
      if (messages.length === 0) console.log(`(no messages for ${agent})`);
      break;
    }
    case 'cmd': {
      if (!first || !second) {
        console.log('usage: /cmd <agent> <directive>');
        break;
      }
      await cmdCmd({ from: self } as Flags, [first, [second, ...rest].join(' ')]);
      break;
    }
    case 'model': {
      if (!first || !second) {
        console.log('usage: /model <agent> <model>');
        break;
      }
      const config = loadConfig();
      const target = resolveAgent(config.agents, first);
      if (!target) {
        console.log(`unknown agent: ${first}`);
        break;
      }
      target.model = second;
      saveConfig(config);
      await cmdCmd({ from: self } as Flags, [target.name, `model=${second}`]);
      console.log(`${formatAgent(target)} will launch with ${target.modelFlag ?? '--model'} ${second}`);
      break;
    }
    case 'resume':
      if (!first) {
        console.log('usage: /resume <agent>');
        break;
      }
      await cmdCmd({ from: self } as Flags, [first, 'resume']);
      break;
    case 'run': {
      if (!first) {
        console.log('usage: /run <agent> <prompt>');
        break;
      }
      cmdRun({} as Flags, [first, ...[second, ...rest].filter((v): v is string => Boolean(v))]);
      break;
    }
    case 'context':
      cmdContext();
      break;
    case 'kill':
      await cmdKill();
      break;
    case 'quit':
    case 'exit':
      return 'quit';
    default:
      console.log(`unknown command: /${slash.name} (try /help)`);
  }
}

async function cmdConsole(flags: Flags): Promise<void> {
  const self = resolveSelf(flags);
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: 'baton> ' });
  console.log(`baton console — you are "${self}". /help for commands, /quit to exit.`);
  rl.prompt();

  let done = false;
  await new Promise<void>((resolve) => {
    let chain: Promise<void> = Promise.resolve();
    rl.on('line', (line) => {
      chain = chain.then(async () => {
        if (done) return;
        const result = await handleSlash(self, line);
        if (result === 'quit') {
          done = true;
          rl.close();
          return;
        }
        if (!done) rl.prompt();
      });
    });
    rl.on('close', () => {
      done = true;
      resolve();
    });
  });
}

async function cmdWelcome(flags: Flags): Promise<void> {
  console.log(`baton v${version()} — pass the work between AI coding agents\n`);

  const fresh = !configExists();
  ensureHome();
  if (fresh) {
    saveConfig(defaultConfig());
    console.log(`created ${CONFIG_PATH}\n`);
  }

  const report = doctorReport();
  if (!report.node.ok) {
    console.log(`node ${report.node.version} is too old — Baton needs >= ${report.node.required}`);
    process.exitCode = 1;
    return;
  }

  console.log(`node      ${report.node.version} ok`);
  console.log(`platform  ${report.platform}`);

  const auto = bool(flags, 'yes') || process.env.BATON_YES === '1';
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  let chosen = report.chosen;
  let panesOk = chosen !== 'pty' && chosen !== 'none';

  if (panesOk) {
    console.log(`panes     ${chosen} ok`);
  } else {
    console.log('panes     none — agents would run in the BACKGROUND with no interface');
    if (userInstallAvailable()) {
      console.log('          baton can install tmux into ~/.baton/bin — no sudo needed');
      if (auto || (interactive && (await confirm('Install tmux now? [y/N] ')))) {
        const result = installTmuxUser();
        if (result.ok) {
          console.log(`          installed ${result.path}`);
          chosen = doctorReport().chosen;
          panesOk = chosen !== 'pty' && chosen !== 'none';
          if (panesOk) console.log(`panes     ${chosen} ok`);
        } else {
          console.log(`          install failed: ${result.error}`);
        }
      }
    } else if (report.install) {
      console.log(`          install it yourself: ${report.install.command}`);
    }
  }

  if (!loadConfig().defaultProvider) {
    if (!interactive && !auto) {
      console.log('\nno provider configured yet — run `baton` in a terminal to pick one');
      return;
    }
    console.log('\nno provider set up yet — let\'s do that now');
    try {
      await runWizard();
    } catch (error) {
      closePrompts();
      if (error instanceof UiCancelled) {
        console.log('\n  cancelled — nothing was changed');
        return;
      }
      throw error;
    }
    closePrompts();
    console.log('');
  }

  if (bool(flags, 'no-start')) {
    console.log('nothing was started.');
    return;
  }

  if (!panesOk && !bool(flags, 'force') && !bool(flags, 'dry-run')) {
    console.log('\nnot starting — without panes there is no interface to use.');
    console.log('  baton install     install tmux (no sudo), then run `baton` again');
    console.log('  baton --force     start them in the background anyway (baton logs <agent>)');
    console.log('  baton console     slash-command console in this terminal');
    return;
  }

  console.log('\nstarting baton...\n');
  await cmdUp(flags);
}

function resolveChat(flags: Flags): {
  agent: string;
  agentLabel: string;
  provider: Provider;
  model: string;
  apiKey?: string;
  autoApprove: boolean;
} {
  const config = loadConfig();
  const ref = str(flags, 'agent') || process.env.BATON_AGENT || config.agents[0]?.name || 'agent';
  const agent = resolveAgent(config.agents, ref) ?? { name: ref };
  const agentName = agent.name;
  const providerId = str(flags, 'provider') ?? agent.provider ?? config.defaultProvider;
  if (!providerId) throw new BatonError('no provider set up yet — run `baton` and pick one');
  const provider = getProvider(providerId, config.customProviders);
  if (!provider) throw new BatonError(`unknown provider: ${providerId}`);
  const model = str(flags, 'model') ?? agent.model ?? config.defaultModel;
  if (!model) throw new BatonError('no model selected — pass --model or run `baton` to choose one');
  const apiKey = resolveKey(provider);
  if (provider.needsKey && !apiKey) {
    throw new BatonError(`no API key for ${provider.name} — run \`baton key ${provider.id} <key>\``);
  }
  return {
    agent: agentName,
    agentLabel: formatAgent(agent),
    provider,
    model,
    apiKey,
    autoApprove: bool(flags, 'yes') || config.autoApprove === true,
  };
}

function ensureFfi(): void {
  if (process.execArgv.includes('--experimental-ffi')) return;
  const entry = process.argv[1];
  if (!entry) return;
  const result = spawnSync(process.execPath, ['--experimental-ffi', entry, ...process.argv.slice(2)], {
    stdio: 'inherit',
  });
  process.exit(result.status ?? 0);
}

async function cmdChat(flags: Flags): Promise<void> {
  const context = resolveChat(flags);
  const cwd = process.cwd();

  if (isInteractive()) {
    ensureFfi();
    try {
      const { runChatApp } = await import('../ui/app.ts');
      const { createSession } = await import('../agent/session.ts');
      const session = createSession({
        agent: context.agent,
        provider: context.provider,
        model: context.model,
        apiKey: context.apiKey,
        cwd,
        autoApprove: context.autoApprove,
      });
      await runChatApp({
        session,
        agent: context.agent,
        agentLabel: context.agentLabel,
        providerName: context.provider.name,
        version: version(),
        model: context.model,
        cwd,
        resume: str(flags, 'session'),
      });
      return;
    } catch (error) {
      console.error(
        `(full-screen UI unavailable: ${error instanceof Error ? error.message : 'failed'} — using text mode)`,
      );
    }
  }

  await startChat({
    agent: context.agent,
    provider: context.provider,
    model: context.model,
    apiKey: context.apiKey,
    cwd,
    autoApprove: context.autoApprove,
    session: str(flags, 'session'),
  });
}

async function cmdAsk(flags: Flags, positional: string[]): Promise<void> {
  const inline = positional.join(' ').trim();
  const prompt = inline || str(flags, 'prompt') || (process.stdin.isTTY ? '' : (await readStdin()).trim());
  if (!prompt) throw new BatonError('usage: baton ask "<prompt>"');

  const context = resolveChat(flags);
  const config = loadConfig();
  const confirmTool = async (): Promise<boolean> => bool(flags, 'yes') || config.autoApprove === true;

  const messages = [
    { role: 'system' as const, content: buildSystemPrompt(process.cwd(), `${protocolText()}\n${memoryBlock()}`) },
    { role: 'user' as const, content: prompt },
  ];

  await runTurn(messages, {
    provider: context.provider,
    apiKey: context.apiKey,
    model: context.model,
    cwd: process.cwd(),
    confirm: confirmTool,
    maxTurns: str(flags, 'max-turns') ? Number(str(flags, 'max-turns')) : 20,
    events: {
      onText: (chunk) => process.stdout.write(chunk),
      onToolStart: (call) => process.stderr.write(`→ ${call.name}\n`),
    },
  });
  process.stdout.write('\n');
}

function cmdProviders(flags: Flags): void {
  const config = loadConfig();
  const list = allProviders(config.customProviders);
  if (bool(flags, 'json')) {
    console.log(
      JSON.stringify(
        list.map((p) => ({
          id: p.id,
          name: p.name,
          format: p.format,
          needsKey: p.needsKey,
          hasKey: Boolean(resolveKey(p)),
        })),
        null,
        2,
      ),
    );
    return;
  }
  for (const provider of list) {
    const status = provider.needsKey ? (resolveKey(provider) ? 'key set' : '-') : 'none needed';
    console.log(`${provider.id.padEnd(13)} ${provider.name.padEnd(34)} ${provider.format.padEnd(10)} ${status}`);
  }
  console.log(`\nkeys: ${keysFile()}`);
}

function cmdKey(positional: string[], flags: Flags): void {
  const id = positional[0] ?? str(flags, 'provider');
  const key = positional.slice(1).join(' ') || str(flags, 'key');
  if (!id || !key) throw new BatonError('usage: baton key <provider> <api-key>');
  const config = loadConfig();
  const provider = getProvider(id, config.customProviders);
  if (!provider) throw new BatonError(`unknown provider: ${id}`);
  saveKey(provider.id, key);
  console.log(`saved key for ${provider.name} in ${keysFile()}`);
}

async function cmdModels(flags: Flags): Promise<void> {
  const config = loadConfig();
  const providerId = str(flags, 'provider') ?? config.defaultProvider;
  if (!providerId) throw new BatonError('no provider — pass --provider or run `baton`');
  const provider = getProvider(providerId, config.customProviders);
  if (!provider) throw new BatonError(`unknown provider: ${providerId}`);
  try {
    const models = await listModels(provider, resolveKey(provider));
    if (models.length === 0) console.log('(provider returned no models)');
    for (const model of models) console.log(model);
  } catch (error) {
    console.log(`could not fetch models: ${error instanceof Error ? error.message : 'failed'}`);
    for (const model of provider.defaultModels) console.log(`${model}   # built-in fallback`);
  }
}

async function defineCustomProvider(config: ReturnType<typeof loadConfig>): Promise<Provider> {
  const name = await inputBox({ title: 'custom provider — name', placeholder: 'e.g. My Gateway' });
  const baseUrl = await inputBox({
    title: 'custom provider — base url',
    placeholder: 'e.g. https://api.example.com/v1',
  });
  if (!baseUrl) throw new BatonError('a base URL is required');

  const format = (await selectBox({
    title: 'custom provider — wire format',
    items: [
      { label: 'openai', detail: 'chat completions', value: 'openai' },
      { label: 'anthropic', detail: 'messages', value: 'anthropic' },
    ],
    filterable: false,
    height: 2,
  })) as WireFormat;

  const id =
    (name || 'custom')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || `custom-${Date.now().toString(36)}`;

  const def: CustomProviderDef = { id, name: name || 'Custom', format, baseUrl };
  config.customProviders = [...(config.customProviders ?? []).filter((entry) => entry.id !== id), def];
  saveConfig(config);

  const created = getProvider(id, config.customProviders);
  if (!created) throw new BatonError('could not create the custom provider');
  note(`saved to ${CONFIG_PATH}`);
  return created;
}

function providerMenuItems(providers: Provider[]): SelectItem[] {
  const items: SelectItem[] = [];
  let lastGroup = '';
  for (const provider of providers) {
    if (provider.group !== lastGroup) {
      lastGroup = provider.group;
      items.push({ label: GROUP_LABELS[provider.group], value: `__group:${provider.group}`, header: true });
    }
    const keyState = provider.needsKey ? (resolveKey(provider) ? 'key ✓' : 'needs key') : 'no key needed';
    items.push({
      label: provider.name,
      detail: `${provider.format.padEnd(9)} ${keyState}`,
      value: provider.id,
    });
  }
  return items;
}

async function configureProvider(
  config: ReturnType<typeof loadConfig>,
): Promise<{ providerId: string; model: string }> {
  const providerId = await selectBox({
    title: 'choose a provider',
    items: providerMenuItems(orderedProviders(config.customProviders)),
    height: 14,
  });

  let provider = getProvider(providerId, config.customProviders);
  if (!provider) throw new BatonError(`no such provider: ${providerId}`);
  if (provider.id === 'custom') provider = await defineCustomProvider(config);

  const rows: Array<[string, string]> = [
    ['format', provider.format],
    ['base url', provider.group === 'custom' ? provider.baseUrl : `${provider.baseUrl}   (built in)`],
  ];
  if (!provider.needsKey) rows.push(['key', `not needed${provider.note ? ` — ${provider.note}` : ''}`]);
  else if (resolveKey(provider)) rows.push(['key', 'already set']);
  else rows.push(['key', `not set${provider.keyUrl ? ` — create one at ${provider.keyUrl}` : ''}`]);
  printCard(provider.name, rows);

  if (provider.needsKey && !resolveKey(provider)) {
    const key = await inputBox({
      title: `paste your ${provider.name} API key`,
      hidden: true,
      hint: 'enter confirm · esc cancel · empty to skip',
    });
    if (key) {
      saveKey(provider.id, key);
      note(`saved to ${keysFile()}`);
    } else {
      note('no key entered — you can add one later with `baton key`');
    }
  }

  process.stdout.write(`\n  fetching models from ${provider.name} ... `);
  let models: string[] = [];
  try {
    models = await listModels(provider, resolveKey(provider));
  } catch {
    models = [];
  }
  if (models.length === 0) {
    console.log('could not reach it');
    models = provider.defaultModels;
  } else {
    console.log(`${models.length} found`);
  }

  let model: string;
  if (models.length === 0) {
    model = await inputBox({ title: 'model name', placeholder: 'e.g. deepseek-chat' });
  } else {
    model = await selectBox({
      title: 'choose a model',
      items: models.map((name) => ({ label: name, value: name })),
      height: 12,
    });
  }
  if (!model) throw new BatonError('no model selected');

  return { providerId: provider.id, model };
}

async function askAgentName(
  title: string,
  placeholder: string,
  fallback: string,
  taken: string[],
): Promise<string> {
  for (;;) {
    let answer = '';
    try {
      answer = (await inputBox({ title, placeholder, hint: 'enter confirm · esc keeps the default' })).trim();
    } catch (error) {
      // esc keeps the default rather than cancelling the whole setup
      if (error instanceof UiCancelled) return fallback;
      throw error;
    }
    const name = answer || fallback;
    if (/\s/.test(name)) {
      note('a name cannot contain spaces — try a single word or handle');
      continue;
    }
    if (taken.some((used) => used.toLowerCase() === name.toLowerCase())) {
      note(`"${name}" is already taken — the two agent names must be unique`);
      continue;
    }
    return name;
  }
}

async function runWizard(): Promise<void> {
  const config = loadConfig();
  const interactive = isInteractive();

  let leftName = config.agents[0]?.name || 'left';
  let rightName = config.agents[1]?.name || 'right';
  if (interactive) {
    console.log('\n  name your two agents — you can address either the name or the pane (left/right)\n');
    leftName = await askAgentName('left agent — name', 'e.g. Nova', leftName, []);
    rightName = await askAgentName('right agent — name', 'e.g. Rex', rightName, [leftName]);
  }

  const first = await configureProvider(config);

  config.defaultProvider = first.providerId;
  config.defaultModel = first.model;
  config.agents[0] = { name: leftName, role: 'left', provider: first.providerId, model: first.model };
  config.agents[1] = { name: rightName, role: 'right' };
  saveConfig(config);
  note(`left: ${leftName} · left — ${first.providerId} · ${first.model}`);

  if (await confirmBox(`give ${rightName} (right) a different provider/model?`)) {
    const second = await configureProvider(config);
    config.agents[1] = { name: rightName, role: 'right', provider: second.providerId, model: second.model };
    saveConfig(config);
    note(`right: ${rightName} · right — ${second.providerId} · ${second.model}`);
  } else {
    config.agents[1] = { name: rightName, role: 'right', provider: first.providerId, model: first.model };
    saveConfig(config);
    note(`right: ${rightName} · right — same as left`);
  }

  const duplicates = duplicateAgentNames(config.agents);
  if (duplicates.length > 0) {
    note(`warning: duplicate agent name(s): ${duplicates.join(', ')} — names must be unique`);
  }

  console.log(`\n  saved ${CONFIG_PATH}`);
}

function usage(): void {
  console.log(`baton — pass the work between AI coding agents

usage: baton <command> [options]

run \`baton\` with no command: it sets up (config + terminal check), installs what is
missing, then launches the daemon and your agents with full permission (they do not ask
before writing or running things — pass --ask to turn that off). Re-running it attaches
instead of starting a second copy. Use --no-start to set up only.

setup
  doctor [--install]         check node/splitter setup, optionally install one
  install [--system]         install tmux (no sudo by default, into ~/.baton/bin)
  up / down / kill           launch agents + daemon / stop daemon / stop everything
  panes                      add back a pane you closed (also runs when you run baton up)
  splitters                  show available terminal splitters
  providers                  list model providers and whether a key is set
  key <provider> <api-key>   save a provider API key (~/.baton/keys.json, chmod 600)
  models [--provider id]     list the models a provider offers

your agent (baton's own CLI)
  chat [--agent name]        talk to Baton's own agent (--provider, --model, --session)
  ask "<prompt>"             one-shot, non-interactive (--yes to allow tools)
  console                    relay console with slash commands (/help)
  send                       send a message to another agent
  cmd <agent> <directive>    send a control directive (model=…, resume, stop, …)
  commands                   list control directives
  inbox                      read your inbox (marks read unless --peek)
  ack [id]                   acknowledge up to a message (or all)
  watch                      stream new messages
  run <agent> [prompt]       run an agent headlessly (--model, --resume, --dry-run)
  status / log / logs        observe
  daemon / mcp               run batond / the MCP server

agent quality
  context                    protocol + saved memory (inject at session start)
  instructions               print the handoff protocol
  remember "<text>"          keep a fact across sessions
  recall [query]             list memory
  forget [id|text]           remove memory (no arg clears all)
  attach <file>              store a file (screenshot) in the media store
  media                      list stored files
  model --for "<task>"       pick the cheapest model that can do the job
  cost [--model id --in N --out M]   price table / single estimate
  port                       find the port that is actually serving
  session [save <n> <f>|show <n>|list]   reuse a logged-in browser session
  audit                      show the guardrail/audit log

send options: --to --summary --type --priority --body --next --built --attach
              --in-reply-to --hop --input
common: --agent <name>  --json
`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let command = argv[0];
  let rest = argv.slice(1);

  if (command !== undefined && command.startsWith('-')) {
    const standalone = ['--help', '-h', '--version', '-v', '-V'];
    if (!standalone.includes(command)) {
      rest = argv;
      command = undefined;
    }
  }

  const { flags, positional } = parseArgs(rest);

  switch (command) {
    case 'init':
      cmdInit(flags);
      break;
    case 'doctor':
      cmdDoctor(flags);
      break;
    case 'install':
      cmdInstall(flags);
      break;
    case 'up':
      await cmdUp(flags);
      break;
    case 'panes':
    case 'split':
      cmdPanes();
      break;
    case 'down':
      await cmdDown();
      break;
    case 'kill':
      await cmdKill();
      break;
    case 'daemon': {
      const { daemonMain } = await import('../daemon/server.ts');
      daemonMain();
      break;
    }
    case 'mcp': {
      const { mcpMain } = await import('../mcp/server.ts');
      mcpMain();
      break;
    }
    case 'console':
      await cmdConsole(flags);
      break;
    case 'chat':
      await cmdChat(flags);
      break;
    case 'ask':
      await cmdAsk(flags, positional);
      break;
    case 'providers':
      cmdProviders(flags);
      break;
    case 'key':
      cmdKey(positional, flags);
      break;
    case 'models':
      await cmdModels(flags);
      break;
    case 'send':
      await cmdSend(flags);
      break;
    case 'cmd':
      await cmdCmd(flags, positional);
      break;
    case 'commands':
      console.log(directiveHelp());
      break;
    case 'run':
      cmdRun(flags, positional);
      break;
    case 'inbox':
      await cmdInbox(flags);
      break;
    case 'ack':
      await cmdAck(flags, positional);
      break;
    case 'watch':
      await cmdWatch(flags);
      break;
    case 'status':
      await cmdStatus(flags);
      break;
    case 'log':
      cmdLog(flags);
      break;
    case 'logs':
      cmdLogs(positional);
      break;
    case 'splitters':
      cmdSplitters(flags);
      break;
    case 'context':
      cmdContext();
      break;
    case 'instructions':
      console.log(protocolText());
      break;
    case 'remember':
    case 'recall':
    case 'forget':
    case 'memory':
      cmdMemory(command, flags, positional);
      break;
    case 'attach':
      cmdAttach(positional, flags);
      break;
    case 'media':
      cmdMedia(flags);
      break;
    case 'model':
      cmdModel(flags);
      break;
    case 'cost':
      cmdCost(flags);
      break;
    case 'port':
      await cmdPort(flags);
      break;
    case 'session':
      cmdSession(positional[0], positional.slice(1), flags);
      break;
    case 'audit':
      cmdAudit(flags);
      break;
    case undefined:
      await cmdWelcome(flags);
      break;
    case 'welcome':
    case 'setup':
      await cmdWelcome(flags);
      break;
    case 'help':
    case '--help':
    case '-h':
      usage();
      break;
    case 'version':
    case '--version':
    case '-v':
    case '-V':
      console.log(`baton v${version()}`);
      break;
    default:
      if (/^[a-z0-9][a-z0-9-]{3,}$/i.test(command) && existsSync(join(BATON_HOME, 'chats', `${command}.json`))) {
        await cmdChat({ session: command } as Flags);
        break;
      }
      console.error(`unknown command: ${command}`);
      usage();
      process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  if (error instanceof BatonError) console.error(`baton: ${error.message}`);
  else console.error(error);
  process.exitCode = 1;
});
