import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// The fixture drives the adapter in tmux mode against sessions created out of band; on Windows the daemon runs
// psmux mode, which acts only on panes it launched (scoped pane identities) and has no tmux `$id` session targets.
it.skipIf(process.platform === "win32")("shrinks a pod containing an already-exited native tmux session and preserves siblings", () => {
  const home = mkdtempSync(join(tmpdir(), "openrig-shrink-exited-"));
  try {
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL("./fixtures/shrink-exited-session.mjs", import.meta.url)), home,
    ], { env: { ...process.env, HOME: home, TMUX: "" }, encoding: "utf8", timeout: 20000 });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({ shrink: "ok", stoppedRemoved: true,
      sessionsKilled: 2, siblingPreserved: true, namespaceReusable: true });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 25000);
