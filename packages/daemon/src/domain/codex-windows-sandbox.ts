import { execFileSync } from "node:child_process";
import { constants, copyFileSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { parse as parseToml } from "smol-toml";

/**
 * Launch-local Codex override that prefers its MXC Windows sandbox. Native Windows launches add it only when
 * the user's Codex config selects no Windows sandbox: Codex then runs OpenRig's `-s workspace-write` floor
 * read-only and exits on its `--add-dir` roots (observed with Codex 0.163.0). Codex falls back to its own
 * legacy selection where MXC is unavailable, and managed requirements still govern.
 */
export const CODEX_WINDOWS_SANDBOX_OVERRIDE = "features.prefer_mxc=true";

/**
 * Launch-local Codex override that lets the seat's shell load the `rig.ps1` shim. Codex runs model commands
 * with `-NoProfile -Command` in `pwsh` when it is installed, otherwise in Windows PowerShell; both honour
 * the variable. In its elevated and MXC sandboxes no execution policy scope is set, so PowerShell refuses the
 * script and does not fall back to `rig.cmd`. One key is merged into the person's `set` table. The value is
 * bare: Codex takes a `-c` value that is not TOML as a literal string, and an unquoted word passes unchanged
 * through the POSIX quoting, the Windows command line and a restart's argv parse. Execution policy is not a
 * security boundary; RemoteSigned still refuses unsigned downloaded scripts.
 */
export const CODEX_WINDOWS_EXECUTION_POLICY_OVERRIDE = "shell_environment_policy.set.PSExecutionPolicyPreference=RemoteSigned";

/** The local group of the accounts Codex's elevated Windows sandbox runs commands as. */
const CODEX_SANDBOX_USERS = "CodexSandboxUsers";

/** The Codex config files a seat's choice can be in: `config.toml` and, for a selected profile, its profile-v2
 *  `<profile>.config.toml` beside it. (Codex refuses a legacy `[profiles.<name>]` table for a selected profile.) */
export function codexWindowsSandboxConfigFiles(codexHome: string, profile: string | undefined): string[] {
  return [path.join(codexHome, "config.toml"), ...(profile ? [path.join(codexHome, `${profile}.config.toml`)] : [])];
}

/** A config layer as Codex reads it, or undefined when it does not parse. */
function parseLayer(toml: string): Record<string, unknown> | undefined {
  // Codex reads past a UTF-8 BOM, which Windows PowerShell 5.1 and Notepad write; smol-toml does not.
  try { return parseToml(toml.replace(/^\uFEFF/, "")) as Record<string, unknown>; } catch { return undefined; }
}

/**
 * Whether any of the seat's Codex config layers already chooses a Windows sandbox (`[windows] sandbox` or
 * `features.prefer_mxc`, either value). A layer Codex cannot parse counts as chosen: OpenRig adds nothing and
 * Codex reports the config itself. An absent layer (null) chooses nothing.
 */
export function codexWindowsSandboxChosen(layers: ReadonlyArray<string | null>): boolean {
  return layers.some((toml) => {
    if (toml === null) return false;
    const config = parseLayer(toml);
    if (!config) return true;
    const windows = config["windows"] as Record<string, unknown> | undefined;
    const features = config["features"] as Record<string, unknown> | undefined;
    return windows?.["sandbox"] !== undefined || features?.["prefer_mxc"] !== undefined;
  });
}

/**
 * Whether any layer already sets `shell_environment_policy.set.PSExecutionPolicyPreference`, to any value and
 * in any case (Windows environment names ignore case). OpenRig then adds nothing. A layer Codex cannot parse
 * counts as set, as for the sandbox choice; an absent layer (null) sets nothing. The daemon's own environment
 * is not read: it is not the pane environment Codex's shells receive, and inside them OpenRig's value replaces
 * an inherited one.
 */
export function codexWindowsExecutionPolicyChosen(layers: ReadonlyArray<string | null>): boolean {
  const named = (name: string) => name.toLowerCase() === "psexecutionpolicypreference";
  return layers.some((toml) => {
    if (toml === null) return false;
    const config = parseLayer(toml);
    if (!config) return true;
    const policy = config["shell_environment_policy"] as Record<string, unknown> | undefined;
    const set = policy?.["set"] as Record<string, unknown> | undefined;
    return !!set && Object.keys(set).some(named);
  });
}

/**
 * Whether the layers select Codex's elevated Windows sandbox, as Codex 0.163 resolves its mode: the effective
 * `[windows] sandbox` (a selected profile's layer over `config.toml`) is "elevated", or, where no layer sets
 * `[windows] sandbox`, the effective legacy `features.elevated_windows_sandbox` is true. `features.prefer_mxc`
 * does not count against it: MXC wins only where it is available, and Codex runs elevated elsewhere. Any layer
 * that does not parse makes the result false, whatever the other layers say, so no Node is staged.
 */
export function codexWindowsSandboxElevated(layers: ReadonlyArray<string | null>): boolean {
  let sandbox: unknown;
  let legacyElevated: unknown;
  for (const toml of layers) {
    if (toml === null) continue;
    const config = parseLayer(toml);
    if (!config) return false;
    const windows = config["windows"] as Record<string, unknown> | undefined;
    const features = config["features"] as Record<string, unknown> | undefined;
    if (windows?.["sandbox"] !== undefined) sandbox = windows["sandbox"];
    if (features?.["elevated_windows_sandbox"] !== undefined) legacyElevated = features["elevated_windows_sandbox"];
  }
  return sandbox !== undefined ? sandbox === "elevated" : legacyElevated === true;
}

/** How a sandbox-readable Node is staged: icacls with fixed arguments and no shell (throwing when it fails),
 *  and a file copy. Injectable for tests. */
export interface CodexSandboxNodeOps {
  icacls(args: string[]): void;
  copyFile(from: string, to: string): void;
}

export const CODEX_SANDBOX_NODE_OPS: CodexSandboxNodeOps = {
  icacls: (args) => {
    // An empty SystemRoot is unset.
    execFileSync(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "icacls.exe"), args,
      { windowsHide: true, stdio: "ignore", timeout: 30_000 });
  },
  copyFile: (from, to) => copyFileSync(from, to, constants.COPYFILE_EXCL),
};

/** The icacls grant: read and execute, inherited by the folder's files and subfolders, for the local
 *  CodexSandboxUsers group, named with this machine where COMPUTERNAME is set, so that a domain group of the
 *  same name is never resolved instead. */
export function codexSandboxUsersGrant(env: NodeJS.ProcessEnv = process.env): string {
  const machine = env["COMPUTERNAME"];
  return `${machine ? `${machine}\\` : ""}${CODEX_SANDBOX_USERS}:(OI)(CI)(RX)`;
}

/**
 * Whether `dir`, a folder OpenRig made under `home`, is reached through no junction or symbolic link below
 * `home`: a grant through one would land on the folder it points at. The expected path starts from `home`'s
 * own real path, so a home written with short (8.3) names, as a temp folder can be, or one its owner keeps
 * behind a link, still matches.
 */
function reachedDirectly(home: string, dir: string): boolean {
  if (lstatSync(dir).isSymbolicLink()) return false;
  const expected = path.join(realpathSync.native(home), path.relative(home, dir));
  const real = realpathSync.native(dir);
  return process.platform === "win32" ? real.toLowerCase() === expected.toLowerCase() : real === expected;
}

/** Best effort: removes the temporary copies in `dir` left by launches whose process has ended. A live
 *  process's copy may still be in progress and is kept; a file in use cannot be deleted on Windows anyway. */
function removeStaleCopies(dir: string): void {
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { /* nothing to remove */ }
  for (const name of names) {
    const pid = /^node\.(\d+)\.[0-9a-f]{8}\.tmp$/.exec(name)?.[1];
    if (pid === undefined || processAlive(Number(pid))) continue;
    try { rmSync(path.join(dir, name), { force: true }); } catch { /* in use, or already gone */ }
  }
}

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/**
 * A copy of `node` that Codex's elevated sandbox can run, for a seat's rig shims: that sandbox runs commands as
 * a local account that reads a Node under the person's profile only once Codex's background grant has run, and
 * one in a folder local users cannot read never. The copy is
 * `<home>\run\seat-node\<key>\node.exe`, keyed by the source's path, size and mtime. Its folder is granted to
 * CodexSandboxUsers before the copy, so the file inherits the grant; parent folders need no access. A staged
 * copy of the same size is reused, and concurrent launches copy to their own names and rename. When the group
 * cannot be granted (Codex's elevated setup never ran), the folder is reached through a junction or symbolic
 * link, or staging fails, `node` itself is returned. Folders for earlier keys are kept: another daemon sharing
 * the home may still run them.
 */
export function stageCodexSandboxNode(home: string, daemonCwd: string, ops: CodexSandboxNodeOps = CODEX_SANDBOX_NODE_OPS,
  node: string = process.execPath): string {
  try {
    const source = statSync(node);
    const root = path.resolve(daemonCwd, home);
    const dir = path.join(root, "run", "seat-node",
      createHash("sha256").update(JSON.stringify([node, source.size, source.mtimeMs])).digest("hex"));
    const staged = path.join(dir, "node.exe");
    // The rig shims embed this path and refuse batch metacharacters in it.
    if (/[\r\n"%]/.test(staged)) throw new Error("Unsupported Windows executable path");
    mkdirSync(dir, { recursive: true });
    if (!reachedDirectly(root, dir)) throw new Error("Reparse point");
    ops.icacls([dir, "/grant", codexSandboxUsersGrant()]);
    if (statSync(staged, { throwIfNoEntry: false })?.size === source.size) return staged;
    removeStaleCopies(dir);
    const temp = path.join(dir, `node.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
    try {
      ops.copyFile(node, temp);
      renameSync(temp, staged);
    } catch (error) {
      // Another launch may have staged it first; a running node.exe cannot be renamed over.
      if (statSync(staged, { throwIfNoEntry: false })?.size !== source.size) throw error;
    } finally { rmSync(temp, { force: true }); }
    return staged;
  } catch {
    // No error detail: it can name the person's paths.
    console.warn("[seat launch] No Node readable by Codex's elevated sandbox could be staged; the seat's rig uses the daemon's Node.");
    return node;
  }
}

/**
 * Grants CodexSandboxUsers the same read and execute on `bin`, the seat's own `<home>\run\seat-bin\<key>`
 * folder of rig shims, so that PowerShell's PATH lookup and its loading of `rig.ps1` do not wait on Codex's
 * background grant of the person's profile. Only a seat whose shims run a staged Node calls it: their folder,
 * keyed by that Node's path, is theirs alone. A folder reached through a junction or symbolic link is not
 * granted. A failure is logged and the launch goes on with the access the folder already has.
 */
export function grantCodexSandboxSeatBin(home: string, daemonCwd: string, bin: string,
  ops: Pick<CodexSandboxNodeOps, "icacls"> = CODEX_SANDBOX_NODE_OPS): void {
  try {
    if (!reachedDirectly(path.resolve(daemonCwd, home), bin)) throw new Error("Reparse point");
    ops.icacls([bin, "/grant", codexSandboxUsersGrant()]);
  } catch {
    // No error detail: it can name the person's paths.
    console.warn("[seat launch] Codex's elevated sandbox could not be granted the seat's rig shims; the seat relies on Codex's own grant.");
  }
}
