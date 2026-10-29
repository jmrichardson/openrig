import fs from "node:fs";
import path from "node:path";

/**
 * Replace a file through exclusively created sibling staging and an atomic rename.
 * Preserve the source mode so read-only packaged assets can be provisioned repeatedly.
 * Never follow an existing temporary slot, and clean only this invocation's staging.
 * If staging creation fails, retain the prior in-place copy behavior and its error.
 */
export function replaceFile(src: string, dest: string): void {
  let staging: string;
  try {
    staging = fs.mkdtempSync(`${dest}.tmp-`);
  } catch {
    fs.copyFileSync(src, dest);
    return;
  }
  const tmp = path.join(staging, "asset");
  try {
    fs.copyFileSync(src, tmp, fs.constants.COPYFILE_EXCL);
    try {
      fs.renameSync(tmp, dest);
    } catch (error) {
      // Windows refuses to rename over a read-only file, which POSIX permits. Clear the
      // attribute on the prior read-only copy so packaged assets re-seat as they do on POSIX.
      // Every hard link shares that attribute, so a linked file keeps it and the error stands.
      const destStat = process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM"
        ? fs.statSync(dest, { throwIfNoEntry: false }) : undefined;
      if (destStat === undefined || (destStat.mode & 0o200) !== 0 || destStat.nlink !== 1) throw error;
      fs.chmodSync(dest, 0o666);
      try {
        fs.renameSync(tmp, dest);
      } catch (retryError) {
        // Still in place (held open by another process, say): the prior copy stays read-only.
        try { fs.chmodSync(dest, destStat.mode); } catch { /* the rename error is the one to report */ }
        throw retryError;
      }
    }
  } finally {
    try {
      fs.rmSync(staging, { recursive: true, force: true });
    } catch {
      // A cleanup error must not replace a copy/rename error or undo a successful replacement.
    }
  }
}
