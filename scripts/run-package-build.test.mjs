import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { packageBuildShell } from './package-build-shell.mjs';

test('native packaging chooses Git Bash without selecting the WSL system launcher', () => {
  assert.equal(packageBuildShell('win32', { ProgramFiles: 'C:\\Program Files' }, file => file === 'C:\\Program Files\\Git\\bin\\bash.exe'), 'C:\\Program Files\\Git\\bin\\bash.exe');
  assert.throws(() => packageBuildShell('win32', {}, () => false), /requires Git for Windows/);
  assert.equal(packageBuildShell('linux', {}, () => false), 'bash');
});

test('native packaging finds per-user, PATH-selected and scoop Git installs, never System32', () => {
  const only = expected => file => file === expected || file.endsWith('\\git.exe');
  const user = 'C:\\Users\\me\\AppData\\Local\\Programs\\Git\\bin\\bash.exe';
  assert.equal(packageBuildShell('win32', { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }, only(user)), user);
  for (const dir of ['D:\\Tools\\Git\\cmd', 'D:\\Tools\\Git\\bin\\', 'D:\\Tools\\Git\\mingw64\\bin']) {
    const env = { PATH: `C:\\Windows\\System32;${dir};relative\\cmd` };
    assert.equal(packageBuildShell('win32', env, only('D:\\Tools\\Git\\bin\\bash.exe')), 'D:\\Tools\\Git\\bin\\bash.exe', dir);
  }
  const scoop = 'C:\\Users\\me\\scoop\\apps\\git\\current\\bin\\bash.exe';
  assert.equal(packageBuildShell('win32', { USERPROFILE: 'C:\\Users\\me', PATH: 'C:\\Users\\me\\scoop\\shims' }, only(scoop)), scoop);
  assert.equal(packageBuildShell('win32', { SCOOP: 'E:\\scoop' }, only('E:\\scoop\\apps\\git\\current\\bin\\bash.exe')), 'E:\\scoop\\apps\\git\\current\\bin\\bash.exe');
  assert.throws(() => packageBuildShell('win32', { PATH: 'C:\\Windows\\System32' }, file => file === 'C:\\Windows\\System32\\bash.exe'), /requires Git for Windows/);
});

// The runner and a stub build script in a scratch checkout, reached through a directory link.
function checkout(t, script) {
  const base = mkdtempSync(path.join(tmpdir(), 'run-package-build-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const real = path.join(base, 'real');
  mkdirSync(path.join(real, 'scripts'), { recursive: true });
  for (const name of ['run-package-build.mjs', 'package-build-shell.mjs']) copyFileSync(path.join(import.meta.dirname, name), path.join(real, 'scripts', name));
  writeFileSync(path.join(real, 'scripts', 'build-package.sh'), script);
  const link = path.join(base, 'link');
  symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir');
  return { real, link, run: (env = process.env) => spawnSync(process.execPath, ['scripts/run-package-build.mjs'], { cwd: link, env, encoding: 'utf8' }) };
}

test('the runner builds from a linked checkout path and returns the build status', t => {
  const f = checkout(t, `node -e "console.log('BUILD-RAN ' + process.cwd())"\nexit 7\n`);
  const result = f.run();
  assert.equal(result.status, 7, result.stderr);
  assert.match(result.stdout, /^BUILD-RAN /);
  assert.equal(realpathSync(result.stdout.trim().slice('BUILD-RAN '.length)), realpathSync(f.real));
});

test('a build shell that cannot start exits 127 and names the cause', { skip: process.platform === 'win32' && 'Windows finds Git Bash by its install folders, not PATH' }, t => {
  const empty = mkdtempSync(path.join(tmpdir(), 'run-package-build-path-'));
  t.after(() => rmSync(empty, { recursive: true, force: true }));
  const result = checkout(t, 'exit 0\n').run({ ...process.env, PATH: empty });
  assert.equal(result.status, 127);
  assert.match(result.stderr, /could not be started: .*ENOENT/);
});
