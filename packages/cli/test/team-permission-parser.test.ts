import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import { createProgram } from "../src/index.js";
import { TEAM_CLAUDE_ALLOW, TEAM_CLAUDE_ASK } from "../../daemon/src/adapters/kernel-authority.js";
import { posixShell } from "../../daemon/test/helpers/posix-shell.js";

const { decide, decidePowerShell } = createRequire(import.meta.url)(fileURLToPath(new URL("../../daemon/assets/claude-team-permissions.cjs", import.meta.url)));
const policy = { allow: TEAM_CLAUDE_ALLOW, ask: TEAM_CLAUDE_ASK };
const windows = process.platform === "win32";
let home: string, shims: string;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "team-permission-parser-"));
  // The shell only records argv. The real CLI parser below has inert actions;
  // neither stage contacts a daemon or performs a lifecycle operation.
  writeFileSync(join(home, "rig"), `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o755 });
  if (!windows) return;
  // npm's Windows shims for `rig`: PowerShell prefers rig.ps1 and rig.cmd runs through cmd.exe. Both record argv.
  shims = mkdtempSync(join(tmpdir(), "team-permission-parser-ps-"));
  writeFileSync(join(shims, "argv.cjs"), "console.log(JSON.stringify(process.argv.slice(2)));\n");
  writeFileSync(join(shims, "rig.cmd"), `@"${process.execPath}" "%~dp0argv.cjs" %*\r\n`);
  writeFileSync(join(shims, "rig.ps1"), `& '${process.execPath.replace(/'/g, "''")}' "$PSScriptRoot\\argv.cjs" $args\r\nexit $LASTEXITCODE\r\n`);
});
afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  if (shims) rmSync(shims, { recursive: true, force: true });
});

async function parse(command: string) {
  // Claude Code runs Bash commands through Git Bash on Windows, so its parse is the ground truth there.
  const shell = spawnSync(windows ? posixShell : "/bin/bash", ["--noprofile", "--norc", "-c", command], {
    encoding: "utf8", timeout: 3000,
    env: { PATH: windows ? [home, dirname(process.execPath)].join(delimiter) : `${home}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home },
  });
  expect(shell.status, shell.stderr).toBe(0);
  return { ...await dispatch(shell.stdout), decision: decide(command, policy) };
}

// Claude's PowerShell tool on native Windows: Windows PowerShell's own parse is the ground truth. PATH holds only the
// shims and the system directories, so no installed rig can run. Each rig run prints one argv line, and each line is
// dispatched, so a command that runs rig twice (through cmd.exe, say) reports both.
async function parsePowerShell(command: string) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !["PATH", "PSMODULEPATH"].includes(key.toUpperCase())));
  const system = join(process.env["SystemRoot"] ?? "C:\\Windows", "System32");
  const shell = spawnSync(join(system, "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
    { cwd: shims, encoding: "utf8", timeout: 20000, env: { ...env, PATH: [shims, system].join(delimiter) } });
  expect(shell.status, shell.stderr).toBe(0);
  const runs: Awaited<ReturnType<typeof dispatch>>[] = [];
  for (const line of shell.stdout.split(/\r?\n/).filter(Boolean)) runs.push(await dispatch(line));
  return { calls: runs.flatMap(run => run.calls), output: runs.map(run => run.output).join(""),
    error: runs.find(run => run.error)?.error, decision: decidePowerShell(command, policy) };
}

async function dispatch(argv: string) {
  const program = createProgram(), calls: string[] = [];
  let output = "", error: string | undefined;
  const configure = (cmd: Command) => {
    cmd.exitOverride().configureOutput({ writeOut: text => { output += text; }, writeErr: text => { output += text; } });
    for (const child of cmd.commands) configure(child);
  };
  configure(program);
  program.commands.find(cmd => cmd.name() === "down")!.action(() => { calls.push("down"); });
  program.commands.find(cmd => cmd.name() === "seat")!.commands.find(cmd => cmd.name() === "stop")!
    .action(() => { calls.push("seat stop"); });
  try { await program.parseAsync(JSON.parse(argv), { from: "user" }); }
  catch (e) { error = (e as { code?: string }).code; }
  return { calls, output, error };
}

describe("team hook agrees with real CLI dispatch", () => {
  it.each([
    "rig down example", "rig -- down example",
    "rig -- down --help", "rig -- down -h",
    "command rig down example", "nice -n 5 rig down example",
    "if true; then rig down example; fi", "for s in example; do rig down $s; done",
    "{ rig down example; }", "rig down -- --help",
    "rig seat stop example@demo --reason --help",
  ])("asks when the action really dispatches: %s", async command => {
    const observed = await parse(command);
    expect(observed.error).toBeUndefined(); expect(observed.calls).toHaveLength(1);
    expect(observed.decision).toBe("ask");
  });
  it.each([
    ["rig seat -- stop example@demo --reason maintenance", "commander.missingMandatoryOptionValue"],
    ["rig -- down --help example", "commander.excessArguments"],
  ])("keeps invalid separator forms conservative: %s", async (command, error) => {
    const observed = await parse(command);
    expect(observed.error).toBe(error); expect(observed.calls).toEqual([]);
    expect(observed.decision).toBe("ask");
  });
  it.each([
    "rig down example --help", "rig down --help example", "rig down -h example",
    "rig seat stop --help example@demo",
  ])("allows help with no action: %s", async command => {
    const observed = await parse(command);
    expect(observed.error).toBe("commander.helpDisplayed"); expect(observed.calls).toEqual([]);
    expect(observed.output).toContain("Usage:"); expect(observed.decision).toBe("allow");
  });
});

describe.runIf(windows)("team hook agrees with real Windows PowerShell dispatch", () => {
  // One or two of each form; the hook's full PowerShell tables are in packages/daemon/test/claude-team-permissions.test.ts.
  it.each([
    "rig down example", "rig.cmd down example", ".\\rig.ps1 down example", "Get-Date | Out-Null; rig down example",
    "if ($true) { rig down example }", "rig.cmd --% down example", "rig seat stop example@demo --reason --help",
    // A block comment inside the lifecycle words is dropped and the rest passed on.
    "rig <# c #> down example", "rig.cmd <# c #> down example",
    // A redirection between the lifecycle words.
    "rig *>&1 down example", "rig.cmd 2>$null down example",
    // A lifecycle word from an expression or a splat, or after an empty argument.
    "rig $(\"down\") example", "$a=@(\"down\",\"example\"); rig @a", "rig '' down example",
    // A line continuation, a backtick escape in a double-quoted word, and `0, which ends the command line before a later --help.
    "rig `\n  down example", "rig \"d`own\" example", "rig down example`0 --help",
    // An assignment (or a hashtable value) runs its right-hand side; the rig output it captures is printed after.
    "$x=rig down example; $x", "$h=@{a=1;b=rig down example}; $h.b",
    // A call or dot-source operator before a computed or quoted command name.
    "& ('rig') down example", "$r='rig'; . $r down example", ".'rig' down example",
  ])("asks when the action really dispatches: %s", async command => {
    const observed = await parsePowerShell(command);
    expect(observed.error).toBeUndefined(); expect(observed.calls).toHaveLength(1);
    expect(observed.decision).toBe("ask");
  });
  it.each([
    // cmd.exe runs a second rig: Windows PowerShell quotes an argument only for whitespace, and a quote inside ends it.
    ["rig.cmd -h 'a b\"&rig.cmd down example'", "down"], ["rig.cmd -h 'x&rig.cmd' down example", "down"],
    ["rig.cmd -h 'x|rig.cmd' seat stop example@demo --reason maintenance", "seat stop"],
    // The rest of a --% line is not PowerShell, so its quote does not hide the next line.
    ["rig --% it's fine\nrig down example", "down"],
  ])("asks when a second rig run dispatches the action: %s", async (command, action) => {
    const observed = await parsePowerShell(command);
    expect(observed.calls).toEqual([action]);
    expect(observed.decision).toBe("ask");
  });
  it.each([
    ["RIG DOWN example", "commander.unknownCommand"],
    ["rig -- down --help", "commander.helpDisplayed"],
    ["rig --% down example", "commander.unknownOption"],
    // After & or ., a computed command name asks whatever follows.
    ["$r='rig'; & $r down --help", "commander.helpDisplayed"],
  ])("keeps forms the CLI rejects or reads as help conservative: %s", async (command, error) => {
    const observed = await parsePowerShell(command);
    expect(observed.error).toBe(error); expect(observed.calls).toEqual([]);
    expect(observed.decision).toBe("ask");
  });
  it.each([
    "rig down example --help", "rig.cmd down --help example", "& rig down -h example", ".\\rig.ps1 down -h",
    "rig seat stop --help example@demo", "rig <# c #> down --help", "rig 2>$null down -h example",
    "rig \"d`own\" --help", "rig \"do`wn\" -h example", "$x=rig down --help; $x", "& 'rig' down --help",
  ])("leaves help with no action to Claude's PowerShell rules: %s", async command => {
    const observed = await parsePowerShell(command);
    expect(observed.error).toBe("commander.helpDisplayed"); expect(observed.calls).toEqual([]);
    expect(observed.output).toContain("Usage:"); expect(observed.decision).toBeUndefined();
  });
});
