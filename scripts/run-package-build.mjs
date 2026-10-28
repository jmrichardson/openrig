// `npm run build:package:windows`: scripts/build-package.sh under Git for Windows' bash. npm runs a
// script's bare `bash` through cmd.exe there, which can resolve to System32\bash.exe (the WSL launcher)
// and assemble the package in Linux. Both package build commands select the platform shell here.
// The entry has no main-module check, which a junctioned
// checkout path would fail silently.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { packageBuildShell } from './package-build-shell.mjs';

let shell;
try {
  shell = packageBuildShell(process.platform, process.env);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
const script = path.relative(process.cwd(), path.join(import.meta.dirname, 'build-package.sh')).split(path.sep).join('/');
const result = spawnSync(shell, [script], { stdio: 'inherit', windowsHide: true });
if (result.error) {
  console.error(`Package build shell ${shell} could not be started: ${result.error.message}`);
  process.exit(127);
}
process.exit(result.status ?? 1);
