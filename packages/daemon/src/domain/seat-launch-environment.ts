import { claudeSeatTokenWindowsStep, type ClaudeSeatTokenRef } from "./claude-seat-token.js";
import { accessSync, closeSync, constants, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, readSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import type { TmuxAdapter } from "../adapters/tmux.js";
import { shellQuote } from "../adapters/shell-quote.js";
import { parseLiteralLaunchWords, powershellQuote, renderWindowsLaunch, windowsPathEntries } from "../adapters/windows-launch.js";
import { CLAUDE_RESUME_LAUNCH_ENV } from "../adapters/claude-resume-launch.js";
import { resolveWindowsCodexCommand } from "../adapters/windows-codex-command.js";
import { grantCodexSandboxSeatBin, stageCodexSandboxNode } from "./codex-windows-sandbox.js";

// Explicit public launch metadata, not a prefix/denylist over credential names.
// Provider keys and OPENRIG_ACTIVITY_HOOK_TOKEN keep their non-typed channel.
export const SEAT_PUBLIC_ENV_KEYS = [
  "OPENRIG_HOME", "OPENRIG_DB", "TMUX_TMPDIR", "OPENRIG_URL", "OPENRIG_HOST", "OPENRIG_PORT",
  "OPENRIG_NODE_ID", "OPENRIG_SESSION_NAME", "OPENRIG_RUNTIME",
  "OPENRIG_OCCUPANT_GENERATION", "OPENRIG_TRANSCRIPTS_LINES",
  "OPENRIG_TRANSCRIPTS_POLL_INTERVAL_SECONDS",
] as const;

export function publicSeatEnvironment(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of SEAT_PUBLIC_ENV_KEYS) if (env[key] !== undefined) result[key] = env[key]!;
  if (result.OPENRIG_URL) {
    try {
      const url = new URL(result.OPENRIG_URL);
      if (url.username || url.password || url.search || url.hash) throw new Error("Not a public URL");
    } catch {
      delete result.OPENRIG_URL;
      // The existing tmux environment channel still carries it. Never log its value.
      console.warn("[seat launch] URL omitted from typed metadata; retaining the existing environment channel.");
    }
  }
  return result;
}

/** Locate the CLI paired with this daemon, never a PATH-first global install.
 * The first layout is the bundled CLI; the second is the workspace build.
 */
function pairedCli(): string {
  for (const relative of ["../../../package.json", "../../../cli/package.json"]) {
    const manifest = path.resolve(import.meta.dirname, relative);
    try {
      const pkg = JSON.parse(readFileSync(manifest, "utf8"));
      if (pkg.name === "@openrig/cli" && typeof pkg.bin?.rig === "string") {
        return path.resolve(path.dirname(manifest), pkg.bin.rig);
      }
    } catch { /* try the other supported layout */ }
  }
  throw new Error("Paired CLI unavailable");
}

/** Pin npm Codex's interpreter as well as its entry file to the probe PATH.
 * Child tools still inherit the pane PATH. Unrecognised env shebang syntax
 * falls back to the old literal-PATH command instead of guessing its meaning.
 */
function codexEntry(searchPath: string, cwd: string, windows = false): string {
  if (windows) {
    // As the Windows probe does, npm Codex runs with this daemon's Node: the launch runs what was
    // probed, and a native codex.exe needs no node on the launch PATH.
    const resolved = resolveWindowsCodexCommand(searchPath, process.execPath, cwd);
    return [resolved.command, ...resolved.args].map(shellQuote).join(" ");
  }
  const executable = launchExecutable("codex", searchPath, cwd);
  const fd = openSync(executable, "r");
  let firstLine: string;
  try {
    const bytes = Buffer.alloc(512);
    firstLine = bytes.subarray(0, readSync(fd, bytes, 0, bytes.length, 0)).toString("utf8").split("\n")[0]!;
  } finally { closeSync(fd); }
  if (/^#!\s*\/usr\/bin\/env(?:\s|$)/.test(firstLine)) {
    if (!/^#![ \t]*\/usr\/bin\/env[ \t]+node[ \t]*\r?$/.test(firstLine)) throw new Error("Unsupported env shebang");
    return `${shellQuote(launchExecutable("node", searchPath, cwd))} ${shellQuote(executable)}`;
  }
  return shellQuote(executable);
}

/** Resolve exactly on the daemon launch PATH, without consulting the pane rc. */
export function launchExecutable(name: string, searchPath: string, cwd: string, windows = false,
  suffixes: readonly string[] = windows ? [".exe", ".cmd", ".bat", ""] : [""]): string {
  for (const entry of windows ? windowsPathEntries(searchPath) : searchPath.split(path.delimiter)) {
    for (const suffix of suffixes) {
      const file = path.resolve(cwd, entry, name + suffix);
      try { accessSync(file, constants.X_OK); if (statSync(file).isFile()) return file; } catch { /* next entry */ }
    }
  }
  throw new Error(`Seat launch requires ${name} on the daemon launch PATH.`);
}

/** Windows PowerShell's `& node @args` drops '' and strips embedded quotes, so the
 * PowerShell entry builds the CRT command line itself, as renderWindowsLaunch does,
 * and forwards pipeline input without the console encoding's BOM. Like npm.ps1, it
 * runs only where the execution policy allows local scripts. */
function windowsRigScript(node: string, entry: string): string {
  return [
    `$line = ${powershellQuote(`"${entry}"`)}`,
    String.raw`foreach ($arg in $args) { $line += ' "' + (([string]$arg -replace '(\\*)"', '$1$1\"') -replace '(\\+)\z', '$1$1') + '"' }`,
    "$start = New-Object System.Diagnostics.ProcessStartInfo",
    "$start.UseShellExecute = $false",
    `$start.FileName = ${powershellQuote(node)}`,
    "$start.Arguments = $line",
    "$piped = $MyInvocation.ExpectingInput",
    "if ($piped) { $start.RedirectStandardInput = $true; $encoding = [Console]::InputEncoding; if ($encoding.GetPreamble().Length) { [Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false } }",
    "try { $child = [Diagnostics.Process]::Start($start) } finally { if ($piped) { [Console]::InputEncoding = $encoding } }",
    "try {",
    "  if ($piped) {",
    "    $bytes = (New-Object System.Text.UTF8Encoding $false).GetBytes((@($input | ForEach-Object { [string]$_ + [char]10 }) -join ''))",
    "    $child.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)",
    "    $child.StandardInput.BaseStream.Close()",
    "  }",
    "  $child.WaitForExit()",
    "  $code = $child.ExitCode",
    "} finally { $child.Dispose() }",
    "exit $code",
    "",
  ].join("\n");
}

/** The Windows seat's paired-CLI entries: `bin` holds a `rig` for PowerShell, native
 * cmd and Git Bash; seat hooks cannot spawn rig.cmd without a shell and run `entry`
 * with Node. `bin` is keyed by everything its files embed, so a moved Node, another
 * CLI or a changed entry gets its own directory and never meets stale content. The
 * shims run `node`: this daemon's Node, or a copy staged for Codex's elevated sandbox. */
export function windowsSeatCli(home: string | undefined, daemonCwd: string, cliPath?: string, node: string = process.execPath): { bin: string; entry: string } {
  const entry = realpathSync(cliPath ?? pairedCli());
  accessSync(entry, constants.X_OK);
  if (!statSync(entry).isFile() || !home) throw new Error("Paired CLI or instance home unavailable");
  // Reject batch metacharacters in fixed executable paths rather than interpreting them.
  if (/[\r\n"%]/.test(node + entry)) throw new Error("Unsupported Windows executable path");
  const shims: Record<string, string> = {
    "rig.ps1": windowsRigScript(node, entry),
    "rig.cmd": `@echo off\r\n"${node}" "${entry}" %*\r\n`,
    // MSYS rewrites arguments that look like POSIX paths ("/compact") for a native program.
    rig: `#!/bin/sh\nMSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' exec ${shellQuote(node.replace(/\\/g, "/"))} ${shellQuote(entry.replace(/\\/g, "/"))} "$@"\n`,
  };
  const bin = path.resolve(daemonCwd, home, "run", "seat-bin", createHash("sha256").update(JSON.stringify(shims)).digest("hex"));
  mkdirSync(bin, { recursive: true });
  for (const [name, content] of Object.entries(shims)) {
    const shim = path.join(bin, name);
    try { writeFileSync(shim, content, { flag: "wx", mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    if (readFileSync(shim, "utf8") !== content) throw new Error(`Seat bin content differs from the paired CLI: ${bin}`);
  }
  if (readdirSync(bin).some(name => !(name in shims))) throw new Error(`Seat bin is not rig-only: ${bin}`);
  return { bin, entry };
}

// This module's and the Windows renderer's own refusals. Other errors, such as a
// tmux transport failure, can carry environment values and are not repeated.
const WINDOWS_LAUNCH_REFUSAL = /^(?:Seat launch requires |Seat launch identity |Seat bin |Paired CLI |Unsupported Windows executable path|Launch PATH unavailable|Expected a |Windows Codex requires |Codex npm entry |Unrecognized Windows Codex shim|Expanded launch word|Nonliteral launch syntax|Unterminated launch word|Empty launch command|Invalid environment name)/;

/** Reassert only public seat metadata after shell startup. Session identity is
 * read from tmux's launch environment; a successor's reserved identity wins.
 * Credentials stay in the inherited channel. An explicitly selected Codex home
 * is reasserted for Codex only; an unset selection retains the pane's defaults.
 */
export class SeatLaunchEnvironment {
  constructor(private readonly tmux: TmuxAdapter,
    private readonly sessionEnv: Readonly<Record<string, string | undefined>>,
    private readonly daemonCwd: string,
    private readonly cliPath?: string,
    private readonly codexHome?: string,
    private readonly launchPlatform: "posix" | "win32" = "posix",
    private readonly stageSandboxNode: (home: string, daemonCwd: string) => string = stageCodexSandboxNode,
    private readonly grantSandboxSeatBin: (home: string, daemonCwd: string, bin: string) => void = grantCodexSandboxSeatBin) {}

  private rigBin(codexElevatedSandbox = false): string {
    if (this.launchPlatform === "win32") {
      const home = this.sessionEnv.OPENRIG_HOME;
      // Codex's elevated sandbox runs the seat's commands as an account that may not yet, or ever, read this daemon's Node.
      const node = codexElevatedSandbox && home ? this.stageSandboxNode(home, this.daemonCwd) : undefined;
      const { bin } = windowsSeatCli(home, this.daemonCwd, this.cliPath, node);
      // Shims on a staged Node have a folder of their own; the daemon's Node's folder is every other seat's too.
      if (home && node !== undefined && node !== process.execPath) this.grantSandboxSeatBin(home, this.daemonCwd, bin);
      return bin;
    }
    const cli = realpathSync(this.cliPath ?? pairedCli());
    accessSync(cli, constants.X_OK);
    if (!statSync(cli).isFile() || !this.sessionEnv.OPENRIG_HOME) throw new Error("Paired CLI or instance home unavailable");
    // Separate aliases for concurrent installed versions; never retarget another
    // daemon's link. Only rig is exposed, not the other tools in a shared bin.
    const bin = path.resolve(this.daemonCwd, this.sessionEnv.OPENRIG_HOME, "run", "seat-bin", createHash("sha256").update(cli).digest("hex"));
    mkdirSync(bin, { recursive: true });
    const link = path.join(bin, "rig");
    try { symlinkSync(cli, link); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    if (readlinkSync(link) !== cli || readdirSync(bin).some(name => name !== "rig")) throw new Error("Seat bin is not rig-only");
    return bin;
  }

  async command(session: string, command: string, target: { codexCwd?: string; nodeId?: string; generation?: string; runtime?: string; codexElevatedSandbox?: boolean;
    /** The seat's own CODEX_HOME when it declares one; it wins over the daemon's. */
    codexHome?: string;
    /** A Claude seat's own token step (claude-seat-token.ts), run before Claude in the staged subshell. A POSIX pane only:
     *  a caller whose command comes back without it knows the token wasn't applied. */
    claudeTokenRef?: ClaudeSeatTokenRef; claudeTokenStep?: string } = {}): Promise<string> {
    const codexHome = target.codexHome ?? this.codexHome;
    const searchPath = this.sessionEnv.PATH;
    const codexEnv = target.codexCwd !== undefined
      ? [searchPath ? `PATH=${shellQuote(searchPath)}` : "", codexHome ? `CODEX_HOME=${shellQuote(codexHome)}` : ""].filter(Boolean)
      : [];
    const fallback = codexEnv.length ? `env ${codexEnv.join(" ")} ${command}` : command;
    try {
      // Nushell does not expand "$PATH". Keep its pre-existing literal command.
      const shell = path.basename(await this.tmux.getPaneCommand(session) ?? "").replace(/^-/, "");
      if (shell === "nu" || shell === "nu.exe") throw new Error("Non-POSIX pane");
      // Pi keeps its existing command on shells where this PATH expression is not supported.
      if (this.launchPlatform !== "win32" && target.runtime === "pi" && !["bash", "zsh", "sh", "dash", "ksh"].includes(shell)) {
        throw new Error("Unsupported Pi pane shell");
      }
      const identity: Record<string, string | undefined> = {};
      for (const key of ["OPENRIG_NODE_ID", "OPENRIG_SESSION_NAME", "OPENRIG_RUNTIME", "OPENRIG_OCCUPANT_GENERATION"]) {
        identity[key] = await this.tmux.getSessionEnv(session, key);
      }
      if (!identity.OPENRIG_NODE_ID || !identity.OPENRIG_SESSION_NAME) {
        throw new Error("Seat launch requires the session's OpenRig identity.");
      }
      if (target.nodeId !== undefined && identity.OPENRIG_NODE_ID !== target.nodeId) {
        throw new Error("Seat launch identity differs from the intended node.");
      }
      // Handover respawns an existing pane with -e; tmux's session environment
      // still names the predecessor. The caller owns the reserved generation.
      if (target.runtime !== undefined) identity.OPENRIG_RUNTIME = target.runtime;
      if (target.generation !== undefined) identity.OPENRIG_OCCUPANT_GENERATION = target.generation;
      // Codex help/preflight uses the daemon PATH. Preserve its executable and
      // interpreter selection while child tools retain the user's PATH.
      if (target.codexCwd !== undefined) {
        if (!searchPath || !command.startsWith("codex ")) throw new Error("Expected a Codex launch command and PATH.");
        command = codexEntry(searchPath, target.codexCwd, this.launchPlatform === "win32") + command.slice(5);
      }
      const binDir = this.rigBin(target.codexCwd !== undefined && target.codexElevatedSandbox === true);
      const env = publicSeatEnvironment({ OPENRIG_TRANSCRIPTS_LINES: "", OPENRIG_TRANSCRIPTS_POLL_INTERVAL_SECONDS: "", ...this.sessionEnv, ...identity });
      if (target.codexCwd !== undefined && codexHome) env.CODEX_HOME = codexHome;
      if (this.launchPlatform === "win32") {
        if (!searchPath) throw new Error("Launch PATH unavailable");
        env.PATH = `${binDir}${path.delimiter}${searchPath}`;
        // Seat hooks cannot spawn the rig.cmd shim without a shell; they run this entry with Node.
        env.OPENRIG_CLI_ENTRY = realpathSync(this.cliPath ?? pairedCli());
        // Classic Claude emits only these command-scoped assignments. Decode
        // their literal words, without exporting the resume marker to the pane.
        if (target.runtime === "claude-code") {
          const words = parseLiteralLaunchWords(command);
          while (words[0] === "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1" || words[0]?.startsWith(`${CLAUDE_RESUME_LAUNCH_ENV}=`)) {
            const assignment = words.shift()!;
            const equals = assignment.indexOf("=");
            env[assignment.slice(0, equals)] = assignment.slice(equals + 1);
          }
          // Only native Claude is supported: an npm claude.cmd earlier on PATH is passed over.
          // The exact name, under the Windows PATH rules (trimmed, unquoted, no empty entry).
          if (words[0] === "claude") words[0] = launchExecutable("claude.exe", searchPath, this.daemonCwd, true, [""]);
          command = words.map(shellQuote).join(" ");
        }
        if (target.runtime === "pi" || target.runtime === "omp" || target.runtime === "stub") {
          const words = parseLiteralLaunchWords(command);
          if (words[0] !== "node") throw new Error("Expected a managed Node runner");
          words[0] = process.execPath;
          command = words.map(shellQuote).join(" ");
        }
        return renderWindowsLaunch(command, env, target.claudeTokenRef ? claudeSeatTokenWindowsStep(target.claudeTokenRef, "$openrigStart.EnvironmentVariables") : "");
      }
      // Classic Claude may be an rc alias or function, not a PATH executable.
      // Its caller sources the staged command in a pane-shell subshell. Leading
      // assignments preserve shell lookup; /usr/bin/env would bypass it.
      if (target.runtime === "claude-code") {
        const assignments = Object.entries(env).map(([key, value]) => `${key}=${shellQuote(value)}`);
        const launch = `${assignments.join(" ")} PATH=${shellQuote(binDir)}:"$PATH" ${command}`;
        // The token step is POSIX shell; another shell (fish, tcsh) gets the command without it.
        const token = target.claudeTokenStep && ["bash", "zsh", "sh", "dash", "ksh", "mksh"].includes(shell) ? [target.claudeTokenStep] : [];
        // ksh calls a function without exporting a leading assignment that isn't already
        // exported, so it keeps the form above, where every assignment reaches Claude.
        if (!["bash", "zsh", "sh", "dash"].includes(shell)) return [...token, launch].join("\n");
        // A file command must replace the staging subshell so tmux observes
        // Claude as the foreground process. Keep aliases/functions intact and
        // pass the original leading assignments through a subshell-local function.
        // The constant eval defers function-name parsing until alias lookup is ruled out.
        return [
          'if _openrig_claude_executable=$(command -v claude) && [ -f "$_openrig_claude_executable" ] && [ -x "$_openrig_claude_executable" ]; then',
          '  case "$_openrig_claude_executable" in',
          "    */*) eval 'claude() { exec \"$_openrig_claude_executable\" \"$@\"; }' ;;",
          '  esac',
          'fi',
          ...token,
          launch,
        ].join("\n");
      }
      const assignments = Object.entries(env).map(([key, value]) => shellQuote(`${key}=${value}`));
      return `/usr/bin/env ${assignments.join(" ")} PATH=${shellQuote(binDir)}:"$PATH" ${command}`;
    } catch (error) {
      if (this.launchPlatform === "win32") {
        const reason = error instanceof Error && WINDOWS_LAUNCH_REFUSAL.test(error.message) ? ` ${error.message}` : "";
        throw new Error(`Experimental Windows launch environment could not be prepared; no POSIX fallback was typed.${reason}`);
      }
      // This best-effort correction is not a new launch admission gate. Do not
      // include error details: transport errors may contain environment values.
      console.warn("[seat launch] Environment correction unavailable; using the previous launch command.");
      return fallback;
    }
  }
}
