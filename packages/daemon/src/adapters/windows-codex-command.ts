import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseLiteralLaunchWords, windowsPathEntries } from "./windows-launch.js";

const execFileAsync = promisify(execFile);

/** Resolve the selected native Codex or the standard npm entry without executing a batch shell. A codex.cmd
 *  that is not that layout (pnpm, yarn) does not stop the search: a later PATH entry may hold a usable Codex. */
export function resolveWindowsCodexCommand(searchPath: string, nodeExecutable: string, cwd = process.cwd()): { command: string; args: string[] } {
  let unrecognized: Error | undefined;
  for (const entry of windowsPathEntries(searchPath)) {
    const dir = path.resolve(cwd, entry);
    const executable = path.join(dir, "codex.exe");
    try {
      accessSync(executable, constants.X_OK);
      if (statSync(executable).isFile()) return { command: realpathSync(executable), args: [] };
    } catch { /* Try the npm launcher at this PATH entry. */ }
    const shim = path.join(dir, "codex.cmd");
    try { if (!statSync(shim).isFile()) continue; } catch { continue; }
    try { return { command: nodeExecutable, args: [npmCodexEntry(dir, shim)] }; }
    catch (error) { unrecognized ??= error as Error; }
  }
  if (unrecognized) throw unrecognized;
  // ENOENT, as a spawn of a missing executable reports it, so callers classify it the same way.
  throw Object.assign(new Error("Codex was not found on the Windows launch PATH"), { code: "ENOENT" });
}

function npmCodexEntry(dir: string, shim: string): string {
  const pkg = path.join(dir, "node_modules", "@openai", "codex");
  let manifest: { name?: unknown; bin?: unknown } | undefined;
  try { manifest = JSON.parse(readFileSync(path.join(pkg, "package.json"), "utf8")); } catch { /* not an npm install */ }
  const bin = typeof manifest?.bin === "string" ? manifest.bin : (manifest?.bin as { codex?: unknown } | undefined)?.codex;
  if (manifest?.name !== "@openai/codex" || typeof bin !== "string" || path.isAbsolute(bin)) {
    throw new Error("Windows Codex requires a native executable or a recognized npm installation");
  }
  const target = path.resolve(pkg, bin);
  const relative = path.relative(pkg, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Codex npm entry escapes its package");
  }
  const needle = `%dp0%\\node_modules\\@openai\\codex\\${bin.replace(/\//g, "\\")}`;
  if (!readFileSync(shim, "utf8").includes(needle)) throw new Error("Unrecognized Windows Codex shim");
  return realpathSync(target);
}

/** Execute an OpenRig-authored literal Codex probe, never a cmd.exe command string. */
export async function execWindowsCodexCommand(command: string, options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  const [name, ...args] = parseLiteralLaunchWords(command);
  if (name !== "codex") throw new Error("Expected a Codex probe command");
  const env = options.env ?? process.env;
  const selected = resolveWindowsCodexCommand(env.PATH ?? env.Path ?? "", process.execPath, options.cwd);
  const result = await execFileAsync(selected.command, [...selected.args, ...args], {
    ...options, encoding: "utf8", windowsHide: true, timeout: 10000,
  });
  return result.stdout;
}
