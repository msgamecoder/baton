#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const amaro = require('internal/deps/amaro/dist/index');

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(rootDir, 'src');
const distDir = path.join(rootDir, 'dist');

function walk(dir) {
  let files = [];
  for (const f of fs.readdirSync(dir)) {
    const full = path.join(dir, f);
    if (fs.statSync(full).isDirectory()) files.push(...walk(full));
    else if (full.endsWith('.ts')) files.push(full);
  }
  return files;
}

fs.mkdirSync(distDir, { recursive: true });
const files = walk(srcDir);

for (const f of files) {
  const rel = path.relative(srcDir, f);
  const outPath = path.join(distDir, rel.replace(/\.ts$/, '.js'));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  let code = fs.readFileSync(f, 'utf8');
  code = code.replace(/from\s+([\"\'])(\..+?)\.ts\1/g, 'from $1$2.js$1');
  code = code.replace(/import\s+([\"\'])(\..+?)\.ts\1/g, 'import $1$2.js$1');
  code = code.replace(/import\(([\"\'])(\..+?)\.ts\1\)/g, 'import($1$2.js$1)');

  const res = amaro.transformSync(code, { mode: 'strip-only' });
  fs.writeFileSync(outPath, res.code, 'utf8');
}
console.log(`Successfully built ${files.length} files to dist/`);
