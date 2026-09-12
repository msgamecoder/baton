import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TASKS_DIR } from '../core/paths.ts';

export type TaskStatus = 'pending' | 'in_progress' | 'completed';

export interface Task {
  id: string;
  subject: string;
  description: string;
  activeForm?: string;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
}

function taskFile(sessionId: string): string {
  return join(TASKS_DIR, `${sessionId}.json`);
}

export function listTasks(sessionId: string): Task[] {
  const path = taskFile(sessionId);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Task[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeTasks(sessionId: string, tasks: Task[]): void {
  mkdirSync(TASKS_DIR, { recursive: true });
  writeFileSync(taskFile(sessionId), JSON.stringify(tasks, null, 2) + '\n');
}

export function createTask(sessionId: string, subject: string, description: string, activeForm?: string): Task {
  const tasks = listTasks(sessionId);
  const now = Date.now();
  const task: Task = {
    id: `t${tasks.length + 1}`,
    subject,
    description,
    activeForm,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  };
  tasks.push(task);
  writeTasks(sessionId, tasks);
  return task;
}

export function updateTask(
  sessionId: string,
  id: string,
  patch: { status?: TaskStatus; subject?: string; description?: string; activeForm?: string },
): Task | null {
  const tasks = listTasks(sessionId);
  const task = tasks.find((entry) => entry.id === id);
  if (!task) return null;
  if (patch.status) task.status = patch.status;
  if (patch.subject) task.subject = patch.subject;
  if (patch.description) task.description = patch.description;
  if (patch.activeForm) task.activeForm = patch.activeForm;
  task.updatedAt = Date.now();
  writeTasks(sessionId, tasks);
  return task;
}

export function tasksSummary(sessionId: string): string {
  const tasks = listTasks(sessionId);
  if (tasks.length === 0) return 'no tasks';
  return tasks.map((task) => `${task.id} [${task.status}] ${task.subject}`).join('\n');
}

export function formatTaskList(sessionId: string): string[] {
  const tasks = listTasks(sessionId);
  if (tasks.length === 0) return ['(no tasks yet)'];
  return tasks.map((task) => {
    const mark = task.status === 'completed' ? '✓' : task.status === 'in_progress' ? '▸' : '·';
    return `${mark}  ${task.id}  ${task.subject}`;
  });
}
