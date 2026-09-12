import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type { ToolSpec, ToolResult } from '../providers/types.ts';
import { createTask, tasksSummary, updateTask, type TaskStatus } from './tasks.ts';

export interface ToolContext {
  cwd: string;
  sessionId?: string;
  confirm?: (name: string, args: Record<string, unknown>) => Promise<boolean>;
  ask?: (question: string, options: string[]) => Promise<string>;
}

const MAX_OUTPUT = 20000;
const MAX_WALK = 20000;

export const TOOLS: ToolSpec[] = [
  {
    name: 'read_file',
    description: 'Read a text file. Returns numbered lines.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'file path, absolute or relative to the project' },
        offset: { type: 'number', description: 'first line to read (1-indexed)' },
        limit: { type: 'number', description: 'how many lines' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a file with new content.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description: 'Replace an exact string in a file. Fails if the string is missing or ambiguous.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
        replace_all: { type: 'boolean' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'list_dir',
    description: 'List the entries of a directory.',
    parameters: { type: 'object', properties: { path: { type: 'string' } } },
  },
  {
    name: 'glob',
    description: 'Find files by glob pattern, e.g. "src/**/*.ts".',
    parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] },
  },
  {
    name: 'grep',
    description: 'Search file contents with a regular expression.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string', description: 'directory or file to search, default the project' },
        ignore_case: { type: 'boolean' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'task_create',
    description:
      'Create a task to track work on a bigger job, then keep it updated as you go. Create them before starting, mark one in_progress at a time, and complete each as you finish.',
    parameters: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'short imperative title, e.g. "Add the health endpoint"' },
        description: { type: 'string', description: 'what done looks like' },
        activeForm: { type: 'string', description: 'present continuous label, e.g. "Adding the health endpoint"' },
      },
      required: ['subject', 'description'],
    },
  },
  {
    name: 'task_update',
    description: 'Update a task: set status pending/in_progress/completed, or edit its text. Exactly one task should be in_progress at a time.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'task id, e.g. t1' },
        status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
        subject: { type: 'string' },
        description: { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'task_list',
    description: 'List the current tasks with their status.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'ask_user',
    description:
      'Ask the user to choose between options when you are unsure, instead of guessing. Give 2-4 short options; the first is presented as the recommendation. The user can also type their own answer.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'the question to ask' },
        options: { type: 'array', items: { type: 'string' }, description: '2-4 choices' },
      },
      required: ['question', 'options'],
    },
  },
  {
    name: 'shell',
    description: 'Run a shell command in the project directory and return its output.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' }, timeout_ms: { type: 'number' } },
      required: ['command'],
    },
  },
];

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT) return text;
  return `${text.slice(0, MAX_OUTPUT)}\n... [truncated ${text.length - MAX_OUTPUT} chars]`;
}

function resolvePath(cwd: string, path: string): string {
  return path.startsWith('/') ? path : join(cwd, path);
}

function globToRegExp(pattern: string): RegExp {
  let out = '^';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*';
        i++;
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') out += '[^/]';
    else if ('\\^$.|+()[]{}'.includes(ch)) out += `\\${ch}`;
    else out += ch;
  }
  return new RegExp(out + '$');
}

function walk(root: string, limit = MAX_WALK): string[] {
  const found: string[] = [];
  const stack = [root];
  while (stack.length > 0 && found.length < limit) {
    const dir = stack.pop() as string;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry === 'node_modules' || entry === '.git') continue;
      const full = join(dir, entry);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) stack.push(full);
      else found.push(full);
    }
  }
  return found;
}

const WRITE_TOOLS = ['write_file', 'edit_file', 'shell'];
export const READ_ONLY_TOOLS: ToolSpec[] = TOOLS.filter((tool) => !WRITE_TOOLS.includes(tool.name));

export async function runTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  try {
    switch (name) {
      case 'read_file': {
        const path = resolvePath(ctx.cwd, String(args.path ?? ''));
        if (!existsSync(path)) return { output: `no such file: ${path}`, isError: true };
        const lines = readFileSync(path, 'utf8').split('\n');
        const offset = typeof args.offset === 'number' ? Math.max(1, args.offset) : 1;
        const limit = typeof args.limit === 'number' ? args.limit : 400;
        const slice = lines.slice(offset - 1, offset - 1 + limit);
        return {
          output: truncate(slice.map((line, i) => `${offset + i}: ${line}`).join('\n')),
        };
      }
      case 'write_file': {
        if (ctx.confirm && !(await ctx.confirm(name, args))) return { output: 'denied by user', isError: true };
        const path = resolvePath(ctx.cwd, String(args.path ?? ''));
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, String(args.content ?? ''));
        return { output: `wrote ${path} (${String(args.content ?? '').length} bytes)` };
      }
      case 'edit_file': {
        const path = resolvePath(ctx.cwd, String(args.path ?? ''));
        if (!existsSync(path)) return { output: `no such file: ${path}`, isError: true };
        const original = readFileSync(path, 'utf8');
        const needle = String(args.old_string ?? '');
        const count = original.split(needle).length - 1;
        if (!needle) return { output: 'old_string is empty', isError: true };
        if (count === 0) return { output: 'old_string not found in the file', isError: true };
        if (count > 1 && !args.replace_all) {
          return { output: `old_string appears ${count} times — pass replace_all or add context`, isError: true };
        }
        if (ctx.confirm && !(await ctx.confirm(name, args))) return { output: 'denied by user', isError: true };
        const updated = args.replace_all
          ? original.split(needle).join(String(args.new_string ?? ''))
          : original.replace(needle, String(args.new_string ?? ''));
        writeFileSync(path, updated);
        return { output: `edited ${path} (${count} replacement${count === 1 ? '' : 's'})` };
      }
      case 'list_dir': {
        const path = resolvePath(ctx.cwd, String(args.path ?? '.'));
        if (!existsSync(path)) return { output: `no such directory: ${path}`, isError: true };
        const rows = readdirSync(path).map((entry) => {
          try {
            const stat = statSync(join(path, entry));
            return `${stat.isDirectory() ? 'dir ' : 'file'}  ${String(stat.size).padStart(9)}  ${entry}`;
          } catch {
            return `?     ${entry}`;
          }
        });
        return { output: truncate(rows.join('\n')) };
      }
      case 'glob': {
        const pattern = String(args.pattern ?? '');
        const regex = globToRegExp(pattern);
        const matches = walk(ctx.cwd)
          .map((file) => relative(ctx.cwd, file))
          .filter((file) => regex.test(file));
        return { output: matches.length ? truncate(matches.join('\n')) : 'no matches' };
      }
      case 'grep': {
        const pattern = String(args.pattern ?? '');
        let regex: RegExp;
        try {
          regex = new RegExp(pattern, args.ignore_case ? 'i' : '');
        } catch (error) {
          return { output: `bad pattern: ${String(error)}`, isError: true };
        }
        const root = args.path ? resolvePath(ctx.cwd, String(args.path)) : ctx.cwd;
        const base = statSync(root).isDirectory() ? root : ctx.cwd;
        const hits: string[] = [];
        for (const file of walk(base)) {
          let content: string;
          try {
            content = readFileSync(file, 'utf8');
          } catch {
            continue;
          }
          if (content.includes('\u0000')) continue;
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i])) {
              hits.push(`${relative(ctx.cwd, file)}:${i + 1}: ${lines[i].slice(0, 200)}`);
              if (hits.length >= 200) break;
            }
          }
          if (hits.length >= 200) break;
        }
        return { output: hits.length ? truncate(hits.join('\n')) : 'no matches' };
      }
      case 'task_create': {
        if (!ctx.sessionId) return { output: 'tasks are not available here', isError: true };
        const task = createTask(
          ctx.sessionId,
          String(args.subject ?? 'task'),
          String(args.description ?? ''),
          args.activeForm ? String(args.activeForm) : undefined,
        );
        return { output: `created ${task.id}: ${task.subject}` };
      }
      case 'task_update': {
        if (!ctx.sessionId) return { output: 'tasks are not available here', isError: true };
        const id = String(args.id ?? '');
        const status = ['pending', 'in_progress', 'completed'].includes(String(args.status))
          ? (String(args.status) as TaskStatus)
          : undefined;
        const task = updateTask(ctx.sessionId, id, {
          status,
          subject: args.subject ? String(args.subject) : undefined,
          description: args.description ? String(args.description) : undefined,
        });
        if (!task) return { output: `no task ${id}`, isError: true };
        return { output: `${task.id} → ${task.status}: ${task.subject}` };
      }
      case 'task_list':
        return { output: ctx.sessionId ? tasksSummary(ctx.sessionId) : 'tasks are not available here' };
      case 'ask_user': {
        const question = String(args.question ?? '');
        const options = Array.isArray(args.options) ? (args.options as string[]).slice(0, 4) : [];
        if (!ctx.ask) return { output: 'asking is not available in this mode', isError: true };
        const answer = await ctx.ask(question, options);
        return { output: `the user answered: ${answer}` };
      }
      case 'shell': {
        if (ctx.confirm && !(await ctx.confirm(name, args))) return { output: 'denied by user', isError: true };
        const command = String(args.command ?? '');
        const timeout = typeof args.timeout_ms === 'number' ? args.timeout_ms : 120000;
        const result = spawnSync(command, {
          shell: true,
          cwd: ctx.cwd,
          encoding: 'utf8',
          timeout,
          maxBuffer: 10 * 1024 * 1024,
        });
        const out = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
        const code = result.status ?? -1;
        return { output: truncate(`exit ${code}\n${out || '(no output)'}`), isError: code !== 0 };
      }
      default:
        return { output: `unknown tool: ${name}`, isError: true };
    }
  } catch (error) {
    return { output: error instanceof Error ? error.message : 'tool failed', isError: true };
  }
}
