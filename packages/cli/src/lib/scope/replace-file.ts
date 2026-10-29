import fs from "node:fs";

/** Rename a staged file over `target`. Windows refuses to replace a file another process holds
 * open, as a concurrent scope creator does while it reads a manifest or claim, or a `rig` command
 * while it reads daemon.json; retry briefly so that reader can close it. Other platforms replace
 * at once, exactly as `fs.renameSync`. */
export function replaceFileSync(staged: string, target: string): void {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(staged, target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" || attempt === 100 || !(code === "EPERM" || code === "EACCES" || code === "EBUSY")) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}
