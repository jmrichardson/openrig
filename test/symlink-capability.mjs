import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Whether this process may create file symlinks. Windows grants that only with
 * SeCreateSymbolicLinkPrivilege (Developer Mode or elevation); POSIX always can.
 * Tests whose subject is file-symlink handling gate on this; directory links on
 * Windows use junctions, which need no privilege.
 * @type {boolean}
 */
export const canCreateFileSymlinks = (() => {
  if (process.platform !== "win32") return true;
  const dir = mkdtempSync(join(tmpdir(), "openrig-symlink-probe-"));
  try {
    writeFileSync(join(dir, "target"), "");
    symlinkSync(join(dir, "target"), join(dir, "link"), "file");
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();
