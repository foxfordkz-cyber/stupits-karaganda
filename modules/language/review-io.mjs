// Private, strict JSON and atomic publication for review artifacts. No ARB parser here.
import { existsSync, realpathSync, statSync, readFileSync, openSync, writeFileSync,
  fsyncSync, closeSync, linkSync, unlinkSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseTree, getNodeValue } from 'jsonc-parser';

export function privatePath(path) {
  const result = resolve(path);
  let ancestor = result;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  const physical = resolve(realpathSync(ancestor), relative(ancestor, result));
  ancestor = realpathSync(ancestor);
  if (statSync(ancestor).isFile()) ancestor = dirname(ancestor);
  for (;;) {
    if (existsSync(join(ancestor, '.git'))) throw new Error('runtime_path_inside_git');
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  return physical;
}

export function readText(path, limit = 64 * 1024 * 1024) {
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > limit) throw new Error('input_size_or_type');
  const bytes = readFileSync(path);
  if (bytes.length > limit) throw new Error('input_size_or_type');
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}

export function parseJson(text) {
  const errors = [];
  const root = parseTree(text, errors, { disallowComments: true, allowTrailingComma: false });
  if (!root || errors.length) throw new Error('invalid_json');
  const stack = [[root, 0]];
  while (stack.length) {
    const [node, depth] = stack.pop();
    if (depth > 128) throw new Error('json_depth');
    if (node.type === 'string' && !node.value.isWellFormed()) throw new Error('invalid_unicode');
    if (node.type === 'number' && !Number.isFinite(node.value)) throw new Error('invalid_number');
    if (node.type === 'object') {
      const seen = new Set();
      for (const property of node.children ?? []) {
        const [key, value] = property.children;
        if (seen.has(key.value)) throw new Error('duplicate_json_field');
        seen.add(key.value);
        stack.push([key, depth], [value, depth + 1]);
      }
    } else if (node.type === 'array') {
      for (const child of node.children ?? []) stack.push([child, depth + 1]);
    }
  }
  return getNodeValue(root);
}
export const readJson = path => parseJson(readText(path));

export function writeAtomicNew(path, value) {
  path = privatePath(path);
  if (existsSync(path)) throw new Error('output_exists');
  mkdirSync(dirname(path), { recursive: true });
  const temporary = path + '.' + randomUUID() + '.tmp';
  let fd;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify(value, null, 2) + '\n', 'utf8');
    fsyncSync(fd); closeSync(fd); fd = undefined;
    // A hard link publishes the fsynced file atomically and cannot replace a
    // concurrent writer's destination (rename can replace it on POSIX).
    linkSync(temporary, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export function withStateLock(state, run) {
  state = privatePath(state);
  mkdirSync(state, { recursive: true });
  const lock = join(state, 'review-gate.lock');
  let fd;
  try { fd = openSync(lock, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('state_locked'); throw error; }
  try {
    writeFileSync(fd, String(process.pid)); fsyncSync(fd); closeSync(fd); fd = undefined;
    return run();
  } finally {
    if (fd !== undefined) closeSync(fd);
    unlinkSync(lock);
  }
}
