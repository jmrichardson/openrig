import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach } from "vitest";

/** On native Windows a printed Codex resume carries the sandbox and execution policy overrides unless the Codex
 *  config chooses a Windows sandbox and sets the policy. For a suite asserting the POSIX-shaped printed command,
 *  CODEX_HOME points at a temporary home whose config chooses both, so the commands match and the user's own
 *  ~/.codex is never read. Elsewhere it does nothing. Call inside the describe block that prints the commands. */
export function useChosenCodexWindowsSandbox(): void {
  if (process.platform !== "win32") return;
  let home = "";
  let previous: string | undefined;
  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "openrig-codex-sandbox-chosen-"));
    writeFileSync(path.join(home, "config.toml"), '[windows]\nsandbox = "unelevated"\n[shell_environment_policy.set]\nPSExecutionPolicyPreference = "RemoteSigned"\n');
    previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  });
}
