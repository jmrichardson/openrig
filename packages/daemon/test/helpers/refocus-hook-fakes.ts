import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The shipped refocus trace is a Python script; Windows often has only the Store `python3` stub.
 * POSIX keeps python3 as a hard prerequisite, so those cases always run there.
 */
export const hasPython3 = process.platform !== "win32" || spawnSync("python3", ["-c", ""], { windowsHide: true }).status === 0;

/**
 * A fake `rig` CLI as a Node script. The refocus hooks run `rig` from PATH on POSIX and the
 * seat's OPENRIG_CLI_ENTRY with their own Node on Windows, so pass the returned path as both.
 */
export function writeFakeRig(bin: string, source: string): string {
  const rig = join(bin, "rig");
  writeFileSync(rig, `#!${process.execPath}\n${source}`, { mode: 0o755 });
  return rig;
}

/**
 * A fake trace interpreter. PYTHON must name an executable, and Windows spawns only PE files
 * without a shell, so this Node runs with a preload that answers in place of the `.py` script.
 * The preload is inherited by every Node child of the hook; it acts only for the trace.
 */
export function fakePythonEnv(dir: string, source: string): { PYTHON: string; NODE_OPTIONS: string } {
  const preload = join(dir, "fake-python.cjs");
  writeFileSync(preload, `if (/\\.py$/.test(process.argv[1] ?? "")) {\n${source}\n}\n`);
  return { PYTHON: process.execPath, NODE_OPTIONS: `--require ${JSON.stringify(preload)}` };
}
