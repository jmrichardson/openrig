// The native Windows workflow names the package test files it runs. A case that runs only on
// win32 runs nowhere else in CI, so a test file holding one must be named there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

const ROOT = path.join(import.meta.dirname, '..');
const WORKFLOW = '.github/workflows/windows-native.yml';
const PACKAGES = ['packages/daemon', 'packages/cli', 'packages/tui'];

// The test files the workflow's steps name, as repository paths: a package's own test/ path is
// relative to the step's working directory or to its `-w <package>` workspace.
function listedTests(workflow) {
  const listed = [];
  for (const step of Object.values(workflow.jobs).flatMap(job => job.steps ?? [])) {
    if (typeof step.run !== 'string') continue;
    const pkg = /(?:^|\s)-w\s+(packages\/[\w-]+)/.exec(step.run)?.[1] ?? step['working-directory'];
    for (const file of step.run.match(/\S+\.test\.m?[jt]s/g) ?? []) listed.push(pkg && file.startsWith('test/') ? `${pkg}/${file}` : file);
  }
  return listed;
}

const IS_WIN32 = String.raw`process\.platform\s*===\s*["']win32["']`;
const NOT_WIN32 = String.raw`process\.platform\s*!==\s*["']win32["']`;

// A vitest case gated to run only on win32: runIf(win32 [&& …]) or skipIf(not win32 [|| …]),
// written out or through a const that holds the platform test.
function hasWin32OnlyCase(source) {
  const gates = [String.raw`\.runIf\(\s*${IS_WIN32}\s*(?:\)|&&)`, String.raw`\.skipIf\(\s*${NOT_WIN32}\s*(?:\)|\|\|)`];
  for (const [, name] of source.matchAll(new RegExp(String.raw`\bconst\s+(\w+)\s*=\s*${IS_WIN32}\s*(?:&&[^;\n]*)?;`, 'g'))) {
    gates.push(String.raw`\.runIf\(\s*${name}\s*(?:\)|&&)`, String.raw`\.skipIf\(\s*!\s*${name}\s*(?:\)|\|\|)`);
  }
  for (const [, name] of source.matchAll(new RegExp(String.raw`\bconst\s+(\w+)\s*=\s*${NOT_WIN32}\s*(?:\|\|[^;\n]*)?;`, 'g'))) {
    gates.push(String.raw`\.skipIf\(\s*${name}\s*(?:\)|\|\|)`, String.raw`\.runIf\(\s*!\s*${name}\s*(?:\)|&&)`);
  }
  return new RegExp(gates.join('|')).test(source);
}

function win32OnlyTestFiles() {
  return PACKAGES.flatMap(pkg => readdirSync(path.join(ROOT, pkg, 'test'))
    .filter(name => name.endsWith('.test.ts'))
    .map(name => `${pkg}/test/${name}`)
    .filter(file => {
      const source = readFileSync(path.join(ROOT, file), 'utf8');
      return source.includes('win32') && hasWin32OnlyCase(source);
    }));
}

test('the Windows-only case detector reads each gate form', () => {
  const only = [
    'it.runIf(process.platform === "win32")("x", () => {});',
    "describe.skipIf(process.platform !== 'win32')('x', () => {});",
    'it.runIf(process.platform === "win32" && psmux)("x", () => {});',
    'it.skipIf(process.platform !== "win32" || !psmux)("x", () => {});',
    'const windows = process.platform === "win32";\ndescribe.runIf(windows)("x", () => {});',
    'const enabled = process.platform === "win32" && !!process.env.PSMUX;\nit.skipIf(!enabled)("x", () => {});',
    'const posix = process.platform !== "win32";\nit.skipIf(posix)("x", () => {});',
  ];
  const elsewhere = [
    'it.skipIf(process.platform === "win32")("x", () => {});',
    'it.runIf(process.platform !== "win32")("x", () => {});',
    'it.runIf(process.platform === "win32" || always)("x", () => {});',
    'it.skipIf(process.platform !== "win32" && rare)("x", () => {});',
    'const windows = process.platform === "win32";\nit.skipIf(windows)("x", () => {});',
    'let available = process.platform !== "win32";\nit.skipIf(!available)("x", () => {});',
    'const modeOnly = process.platform === "win32" && mode;\nit.skipIf(modeOnly)("x", () => {});',
  ];
  for (const source of only) assert.equal(hasWin32OnlyCase(source), true, source);
  for (const source of elsewhere) assert.equal(hasWin32OnlyCase(source), false, source);
});

test('every package test file with a Windows-only case runs in the native Windows workflow', () => {
  const listed = new Set(listedTests(parse(readFileSync(path.join(ROOT, WORKFLOW), 'utf8'))));
  const files = win32OnlyTestFiles();
  assert.ok(files.length > 0, 'no Windows-only cases found: the detector no longer matches the suites');
  assert.deepEqual(files.filter(file => !listed.has(file)), [], `add these to ${WORKFLOW}`);
});

test('every test file the native Windows workflow names exists, and only once', () => {
  const listed = listedTests(parse(readFileSync(path.join(ROOT, WORKFLOW), 'utf8')));
  assert.ok(listed.length > 0);
  assert.deepEqual(listed.filter(file => !file.includes('*') && !existsSync(path.join(ROOT, file))), []);
  assert.deepEqual(listed.filter((file, index) => listed.indexOf(file) !== index), []);
});
