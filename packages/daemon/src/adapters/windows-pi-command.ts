import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { windowsPathEntries } from "./windows-launch.js";

/** Run standard npm Pi through Node, without evaluating a cmd.exe shim. A pi.cmd that is not that layout
 *  (pnpm, volta, scoop) does not stop the search: a later PATH entry may hold a native or npm Pi. */
export function resolveWindowsPiCommand(searchPath: string, nodeExecutable: string): { command: string; prefix: string[] } {
  let unrecognized: Error | undefined;
  for (const dir of windowsPathEntries(searchPath)) {
    if (!path.isAbsolute(dir)) continue;
    const exe = path.join(dir, "pi.exe");
    if (existsSync(exe)) return { command: realpathSync(exe), prefix: [] };
    const shim = path.join(dir, "pi.cmd");
    if (!existsSync(shim)) continue;
    try { return { command: nodeExecutable, prefix: [npmPiEntry(dir, shim)] }; }
    catch (error) { unrecognized ??= error as Error; }
  }
  throw unrecognized ?? new Error("Pi was not found on the Windows runner PATH");
}

function npmPiEntry(dir: string, shim: string): string {
  const pkg = path.join(dir, "node_modules", "@earendil-works", "pi-coding-agent");
  let manifest: { name?: unknown; bin?: { pi?: unknown } } | undefined;
  try { manifest = JSON.parse(readFileSync(path.join(pkg, "package.json"), "utf8")); } catch { /* not an npm install */ }
  const bin = manifest?.bin?.pi;
  if (manifest?.name !== "@earendil-works/pi-coding-agent" || typeof bin !== "string" || path.isAbsolute(bin))
    throw new Error(`${shim} is not a recognized npm installation`);
  const entry = path.resolve(pkg, bin);
  const relative = path.relative(pkg, entry);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Pi npm entry escapes its package");
  const needle = `%dp0%\\node_modules\\@earendil-works\\pi-coding-agent\\${bin.replace(/\//g, "\\")}`;
  if (!readFileSync(shim, "utf8").includes(needle)) throw new Error("Unrecognized Windows Pi shim");
  return realpathSync(entry);
}
