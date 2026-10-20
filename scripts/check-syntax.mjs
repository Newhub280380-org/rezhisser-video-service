#!/usr/bin/env node
// Dependency-free "lint": parses every JS file of the repo with `node --check`.
// Catches syntax errors in src/, test/, public/, desktop/ without pulling in ESLint.
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const targets = ['src', 'test', 'public', 'desktop', 'scripts'];
const skip = new Set(['node_modules', 'dist', 'data', '.git']);

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (skip.has(name)) continue;
    const full = join(dir, name);
    const info = statSync(full);
    if (info.isDirectory()) walk(full, out);
    else if (/\.(c|m)?js$/.test(name)) out.push(full);
  }
  return out;
}

const files = targets.flatMap((dir) => walk(join(root, dir)));
let failed = 0;

for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    failed += 1;
    const output = `${err.stderr || ''}${err.stdout || ''}`.trim();
    const tail = output.split('\n').slice(-6).join('\n');
    console.error(`FAIL ${relative(root, file)}\n${tail}`);
  }
}

console.log(`lint: ${files.length - failed}/${files.length} files parsed OK`);
process.exit(failed ? 1 : 0);
