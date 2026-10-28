import { existsSync } from 'node:fs';
import path from 'node:path';

// The shell that runs scripts/build-package.sh. On Windows that is Git for Windows' bin\bash.exe:
// machine-wide, per-user (%LOCALAPPDATA%\Programs\Git), the install whose git.exe is on PATH
// (<root>\cmd, <root>\bin or <root>\mingw64\bin), or scoop's. A bare `bash` there can resolve to
// System32\bash.exe, the WSL launcher, which is never a native build shell.
export function packageBuildShell(platform, env, exists = existsSync) {
  if (platform !== 'win32') return 'bash';
  const { win32 } = path;
  const roots = [env.ProgramFiles, env.ProgramW6432, 'C:\\Program Files'].filter(Boolean).map(root => win32.join(root, 'Git'));
  if (env.LOCALAPPDATA) roots.push(win32.join(env.LOCALAPPDATA, 'Programs', 'Git'));
  for (const dir of (env.PATH ?? env.Path ?? '').split(';')) {
    if (!win32.isAbsolute(dir) || !exists(win32.join(dir, 'git.exe'))) continue;
    const parent = win32.dirname(win32.normalize(dir));
    const name = win32.basename(win32.normalize(dir)).toLowerCase();
    if (name === 'bin' && win32.basename(parent).toLowerCase() === 'mingw64') roots.push(win32.dirname(parent));
    else if (name === 'cmd' || name === 'bin') roots.push(parent);
  }
  const scoop = env.SCOOP || (env.USERPROFILE && win32.join(env.USERPROFILE, 'scoop'));
  if (scoop) roots.push(win32.join(scoop, 'apps', 'git', 'current'));
  for (const root of roots) {
    const candidate = win32.join(root, 'bin', 'bash.exe');
    if (exists(candidate)) return candidate;
  }
  throw new Error('Native Windows packaging requires Git for Windows (Git Bash); WSL bash is not a native build shell.');
}
