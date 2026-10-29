import * as nodePath from "node:path";

/**
 * KI-14 r2-B1 — the ONE shared answer to "does this pane foreground read as a
 * bare shell?". Before this module the repo carried three divergent hard-coded
 * shell sets (session-fingerprinter SHELL_NAMES, seat-identity-reconciler
 * SHELL_COMMANDS, codex-resume SHELL_COMMANDS) and the blank-slate verifier
 * grew a fourth that omitted tcsh/csh — which turned a box whose tmux
 * default-shell is /bin/tcsh into a false successor_pane_not_blank AFTER the
 * destructive cutover. Consumers should classify here; the legacy sets are a
 * tracked consolidation follow-on, not silently rewritten in a defect fix.
 */
export const SHELL_FOREGROUND_BASENAMES: ReadonlySet<string> = new Set([
  "bash", "zsh", "sh", "fish", "nu", "dash", "ksh", "tcsh", "csh",
]);

/** psmux reports a native Windows shell in any case, with or without `.exe`, or as a full path. */
const WINDOWS_SHELL_FOREGROUND_BASENAMES: ReadonlySet<string> = new Set([
  ...SHELL_FOREGROUND_BASENAMES, "powershell", "pwsh", "cmd",
]);

function windowsShellName(command: string): string {
  return nodePath.win32.basename(command.trim()).replace(/^-/, "").replace(/\.exe$/i, "").toLowerCase();
}

/**
 * Does `paneCommand` (tmux `pane_current_command`) read as a bare shell?
 *
 * - Strips a login-shell "-" prefix ("-zsh" → "zsh").
 * - Accepts the common-shell set above.
 * - Accepts the basename of `expectedShellPath` when given — the caller that
 *   CHOSE the respawn command is the authority on what blank looks like, so an
 *   arbitrary configured default shell (r2's generalization) never false-fails
 *   simply for being unlisted.
 * - On Windows, also accepts PowerShell and cmd, comparing case-insensitive
 *   basenames without `.exe`.
 */
export function isShellForeground(paneCommand: string, expectedShellPath?: string | null, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === "win32") {
    const observed = windowsShellName(paneCommand);
    if (WINDOWS_SHELL_FOREGROUND_BASENAMES.has(observed)) return true;
    const expected = expectedShellPath ? windowsShellName(expectedShellPath) : "";
    return !!expected && observed === expected;
  }
  const observed = paneCommand.startsWith("-") ? paneCommand.slice(1) : paneCommand;
  if (SHELL_FOREGROUND_BASENAMES.has(observed)) return true;
  if (expectedShellPath) {
    const expected = nodePath.basename(expectedShellPath.trim());
    if (expected && observed === expected) return true;
  }
  return false;
}

/** The launch, resume and readiness checks' own legacy set: a pane that fell back to one of
 *  these (or to a tmux client) no longer runs the runtime. */
const RUNTIME_SHELL_COMMANDS: ReadonlySet<string> = new Set(["bash", "fish", "nu", "sh", "tmux", "zsh"]);

/** Has the runtime's pane returned to a shell? POSIX keeps the exact legacy set above (part of the
 *  consolidation follow-on); a Windows pane falls back to its native shell. */
export function isRuntimeShell(paneCommand: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32"
    ? isShellForeground(paneCommand, null, "win32") || paneCommand === "tmux"
    : RUNTIME_SHELL_COMMANDS.has(paneCommand);
}
