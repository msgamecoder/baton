import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { MEDIA_DIR } from './paths.ts';
import { ensureHome } from './store.ts';
import type { Attachment } from './schema.ts';

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.log': 'text/plain',
  '.zip': 'application/zip',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

export function mimeFor(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

export function storeFile(srcPath: string): Attachment {
  ensureHome();
  mkdirSync(MEDIA_DIR, { recursive: true });
  const hash = createHash('sha256').update(readFileSync(srcPath)).digest('hex').slice(0, 12);
  const name = `${hash}-${basename(srcPath)}`;
  const dest = join(MEDIA_DIR, name);
  if (!existsSync(dest)) copyFileSync(srcPath, dest);
  const stat = statSync(dest);
  return { path: dest, mime: mimeFor(dest), size: stat.size, hash };
}

export function resolveMedia(ref: string): string | null {
  if (existsSync(ref)) return ref;
  const candidate = join(MEDIA_DIR, ref);
  return existsSync(candidate) ? candidate : null;
}

export function listMedia(): Attachment[] {
  if (!existsSync(MEDIA_DIR)) return [];
  return readdirSync(MEDIA_DIR).map((name) => {
    const path = join(MEDIA_DIR, name);
    const stat = statSync(path);
    return { path, mime: mimeFor(path), size: stat.size };
  });
}

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
