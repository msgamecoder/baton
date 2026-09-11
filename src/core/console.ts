export interface Slash {
  name: string;
  args: string[];
}

export const SLASH_COMMANDS = [
  'help',
  'status',
  'agents',
  'send',
  'inbox',
  'cmd',
  'model',
  'resume',
  'run',
  'context',
  'kill',
  'quit',
] as const;

export const DIRECTIVES = ['model', 'resume', 'effort', 'think', 'stop', 'remember'] as const;

export function parseSlash(line: string): Slash | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('/')) return null;
  const parts = trimmed.slice(1).split(/\s+/).filter(Boolean);
  const name = (parts.shift() ?? '').toLowerCase();
  if (!name) return null;
  return { name, args: parts };
}

export function slashHelp(): string {
  return [
    'console commands:',
    '  /help                       this list',
    '  /status                     agents, pending counts, daemon',
    '  /agents                     configured agents and their models',
    '  /send <to> [type] <text>    send a message (type defaults to fyi)',
    '  /inbox [agent]              read an inbox',
    '  /cmd <agent> <directive>    send a control directive',
    '  /model <agent> <model>      set that agent\'s launch model and notify it',
    '  /resume <agent>             tell an agent to resume its work',
    '  /run <agent> <prompt>       run that agent headlessly',
    '  /context                    print protocol + memory',
    '  /kill                       stop the daemon and every agent',
    '  /quit                       leave the console',
    '',
    directiveHelp(),
  ].join('\n');
}

export function directiveHelp(): string {
  return [
    'control directives (baton cmd <agent> <directive>):',
    '  model=<name>       switch the agent to a model',
    '  effort=<level>     low | medium | high',
    '  resume             resume / continue its work',
    '  think              allow deeper reasoning',
    '  stop               stop the current task',
    '  remember=<text>    tell the agent to remember something',
  ].join('\n');
}
