import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SeatLaunchEnvironment, windowsSeatCli } from "../src/domain/seat-launch-environment.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

const executeFile = promisify(execFile);
// The fixture CLI reads stdin when it is not a terminal: give it an empty one, as a non-interactive caller would.
function execute(file: string, args: string[], options: Parameters<typeof executeFile>[2]) {
  const run = executeFile(file, args, options);
  run.child.stdin?.end();
  return run as Promise<{ stdout: string; stderr: string }>;
}
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "win-seat-bin-")); roots.push(root);
  const home = path.join(root, "instance");
  // Stands in for the paired CLI: reports what it was started with.
  const cli = path.join(root, "rig entry.cjs");
  writeFileSync(cli, "let input = ''; try { if (!process.stdin.isTTY) input = require('fs').readFileSync(0, 'utf8'); } catch {}\n"
    + "process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), input })); process.exit(Number(process.env.RIG_FIXTURE_EXIT || 0));\n", { mode: 0o700 });
  return { root, home, cli };
}

function launchFixture(searchPath: string) {
  const f = fixture();
  const identity: Record<string, string> = { OPENRIG_NODE_ID: "node", OPENRIG_SESSION_NAME: "seat@rig", OPENRIG_RUNTIME: "claude-code", OPENRIG_OCCUPANT_GENERATION: "generation" };
  const tmux = { getPaneCommand: vi.fn(async () => "powershell.exe"), getSessionEnv: vi.fn(async (_session: string, key: string) => identity[key]) };
  const launch = new SeatLaunchEnvironment(tmux as unknown as TmuxAdapter, { OPENRIG_HOME: f.home, PATH: searchPath }, f.root, f.cli, undefined, "win32");
  return { ...f, tmux, identity, launch };
}

const fileNameOf = (rendered: string) => /\$openrigStart\.FileName = '((?:[^']|'')*)'/.exec(rendered)?.[1]?.replace(/''/g, "'");
/** The seat-bin folder a rendered Windows launch puts first on the seat's PATH, and its rig.cmd. */
const seatBinOf = (rendered: string) => /\$openrigStart\.EnvironmentVariables\['PATH'\]='((?:[^']|'')*)'/.exec(rendered)![1]!.replace(/''/g, "'")
  .split(path.delimiter)[0]!;
const rigCmd = (rendered: string) => readFileSync(path.join(seatBinOf(rendered), "rig.cmd"), "utf8");

describe("Windows seat bin", () => {
  it("keys the directory by everything its rig entries embed, never reusing stale content", () => {
    const f = fixture();
    const cli = realpathSync(f.cli);
    const { bin, entry } = windowsSeatCli(f.home, f.root, f.cli);

    expect(entry).toBe(cli);
    expect(path.dirname(bin)).toBe(path.join(f.home, "run", "seat-bin"));
    expect(readdirSync(bin).sort()).toEqual(["rig", "rig.cmd", "rig.ps1"]);
    const content = Object.fromEntries(readdirSync(bin).map(name => [name, readFileSync(path.join(bin, name), "utf8")]));
    expect(path.basename(bin)).toBe(createHash("sha256").update(JSON.stringify({ "rig.ps1": content["rig.ps1"], "rig.cmd": content["rig.cmd"], rig: content.rig })).digest("hex"));
    expect(content["rig.cmd"]).toBe(`@echo off\r\n"${process.execPath}" "${cli}" %*\r\n`);
    // Git Bash would otherwise rewrite "/compact" into a Windows path before node sees it.
    expect(content.rig).toMatch(/^#!\/bin\/sh\nMSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='\*' exec '/);
    // PowerShell's `& node @args` drops '' and strips embedded quotes; the entry builds the command line itself.
    expect(content["rig.ps1"]).not.toContain("@args");
    expect(content["rig.ps1"]).toContain("System.Diagnostics.ProcessStartInfo");

    expect(windowsSeatCli(f.home, f.root, f.cli).bin).toBe(bin);
  });

  it("refuses a directory whose content was changed, naming it, and one holding other tools", () => {
    const f = fixture();
    const { bin } = windowsSeatCli(f.home, f.root, f.cli);
    writeFileSync(path.join(bin, "rig.cmd"), "@echo off\r\nexit /b 1\r\n");
    expect(() => windowsSeatCli(f.home, f.root, f.cli)).toThrow(`Seat bin content differs from the paired CLI: ${bin}`);
    const g = fixture();
    const other = windowsSeatCli(g.home, g.root, g.cli).bin;
    writeFileSync(path.join(other, "node.exe"), "");
    expect(() => windowsSeatCli(g.home, g.root, g.cli)).toThrow(`Seat bin is not rig-only: ${other}`);
    expect(() => windowsSeatCli(undefined, g.root, g.cli)).toThrow("Paired CLI or instance home unavailable");
  });

  it.skipIf(process.platform === "win32")("leaves the POSIX seat bin a symlink named by the CLI path alone", async () => {
    const f = launchFixture("/usr/bin:/bin");
    const launch = new SeatLaunchEnvironment(f.tmux as unknown as TmuxAdapter, { OPENRIG_HOME: f.home, PATH: "/usr/bin:/bin" }, f.root, f.cli);
    f.tmux.getPaneCommand.mockResolvedValue("bash");
    await launch.command("seat@rig", "claude");
    const cli = realpathSync(f.cli);
    expect(readdirSync(path.join(f.home, "run", "seat-bin"))).toEqual([createHash("sha256").update(cli).digest("hex")]);
  });

  it.skipIf(process.platform === "win32")("never stages a Node for a POSIX Codex launch, whose command is unchanged", async () => {
    const f = launchFixture("/usr/bin:/bin");
    const bin = path.join(f.root, "bin");
    mkdirSync(bin);
    writeFileSync(path.join(bin, "codex"), "#!/bin/sh\n", { mode: 0o755 });
    const stage = vi.fn(() => "/staged/node.exe");
    const grant = vi.fn();
    const launch = new SeatLaunchEnvironment(f.tmux as unknown as TmuxAdapter, { OPENRIG_HOME: f.home, PATH: bin }, f.root, f.cli, undefined, "posix", stage, grant);
    f.tmux.getPaneCommand.mockResolvedValue("bash");
    const plain = await launch.command("seat@rig", "codex resume 'abc'", { codexCwd: f.root, runtime: "codex" });
    expect(await launch.command("seat@rig", "codex resume 'abc'", { codexCwd: f.root, runtime: "codex", codexElevatedSandbox: true })).toBe(plain);
    expect(stage).not.toHaveBeenCalled();
    expect(grant).not.toHaveBeenCalled();
  });

  it("starts native Claude from the first claude.exe on the launch PATH, past an npm claude.cmd", async () => {
    const f0 = fixture();
    const npm = path.join(f0.root, "npm"), native = path.join(f0.root, "native");
    for (const dir of [npm, native]) mkdirSync(dir);
    writeFileSync(path.join(npm, "claude.cmd"), "@echo off\r\n", { mode: 0o700 });
    writeFileSync(path.join(native, "claude.exe"), "", { mode: 0o700 });
    const f = launchFixture([npm, native].join(path.delimiter));
    const rendered = await f.launch.command("seat@rig", "claude --session-id 'abc'", { runtime: "claude-code" });
    expect(fileNameOf(rendered)).toBe(path.join(native, "claude.exe"));
    expect(rendered).toContain(`$openrigStart.EnvironmentVariables['OPENRIG_CLI_ENTRY']='${realpathSync(f.cli).replace(/'/g, "''")}'`);
  });

  it("finds claude.exe through a quoted or padded PATH entry, never the daemon cwd through an empty one", async () => {
    const f = launchFixture(tmpdir());
    const native = path.join(f.root, "native space"), npm = path.join(f.root, "npm");
    for (const dir of [native, npm]) mkdirSync(dir);
    writeFileSync(path.join(f.root, "claude.exe"), "decoy in the daemon cwd", { mode: 0o700 });
    writeFileSync(path.join(native, "claude.exe"), "", { mode: 0o700 });
    writeFileSync(path.join(npm, "claude.cmd"), "@echo off\r\n", { mode: 0o700 });
    const launchWith = (searchPath: string) => new SeatLaunchEnvironment(f.tmux as unknown as TmuxAdapter, { OPENRIG_HOME: f.home, PATH: searchPath }, f.root, f.cli, undefined, "win32")
      .command("seat@rig", "claude --session-id 'abc'", { runtime: "claude-code" });
    expect(fileNameOf(await launchWith(["", npm, `"${native}"`, ""].join(path.delimiter)))).toBe(path.join(native, "claude.exe"));
    expect(fileNameOf(await launchWith([" ", ` ${native} `].join(path.delimiter)))).toBe(path.join(native, "claude.exe"));
    await expect(launchWith(["", npm, ""].join(path.delimiter))).rejects.toThrow("Seat launch requires claude.exe on the daemon launch PATH.");
  });

  it("starts a native codex.exe without node on the launch PATH, and npm Codex with this daemon's Node, as the probe does", async () => {
    const f = launchFixture(tmpdir());
    const native = path.join(f.root, "native"), npm = path.join(f.root, "npm");
    for (const dir of [native, npm]) mkdirSync(dir);
    writeFileSync(path.join(native, "codex.exe"), "native fixture", { mode: 0o700 });
    const pkg = path.join(npm, "node_modules", "@openai", "codex");
    mkdirSync(path.join(pkg, "bin"), { recursive: true });
    writeFileSync(path.join(pkg, "bin", "codex.js"), "// fixture only");
    writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "@openai/codex", bin: { codex: "bin/codex.js" } }));
    writeFileSync(path.join(npm, "codex.cmd"), '@"%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*');
    const launchWith = (searchPath: string) => new SeatLaunchEnvironment(f.tmux as unknown as TmuxAdapter, { OPENRIG_HOME: f.home, PATH: searchPath }, f.root, f.cli, undefined, "win32")
      .command("seat@rig", "codex resume 'abc'", { codexCwd: f.root, runtime: "codex" });
    expect(fileNameOf(await launchWith(native))).toBe(realpathSync(path.join(native, "codex.exe")));
    const rendered = await launchWith(npm);
    expect(fileNameOf(rendered)).toBe(process.execPath);
    expect(rendered).toContain(`codex.js`);
  });

  it("keeps the seat's selected Codex home ahead of the daemon default", async () => {
    const f = launchFixture(tmpdir());
    const bin = path.join(f.root, "native");
    mkdirSync(bin);
    writeFileSync(path.join(bin, "codex.exe"), "native fixture", { mode: 0o700 });
    const daemonHome = path.join(f.root, "daemon-codex");
    const selectedHome = path.join(f.root, "seat-codex");
    const launch = new SeatLaunchEnvironment(f.tmux as unknown as TmuxAdapter,
      { OPENRIG_HOME: f.home, PATH: bin }, f.root, f.cli, daemonHome, "win32");
    const rendered = await launch.command("seat@rig", "codex resume 'abc'", { codexCwd: f.root, runtime: "codex", codexHome: selectedHome });
    expect(rendered).toContain(`$openrigStart.EnvironmentVariables['CODEX_HOME']='${selectedHome}'`);
    expect(rendered).not.toContain(daemonHome);
  });

  it("gives a Codex seat in Codex's elevated sandbox rig shims on a staged Node, and every other seat this daemon's Node", async () => {
    const f = launchFixture(tmpdir());
    const native = path.join(f.root, "native");
    mkdirSync(native);
    for (const name of ["codex.exe", "claude.exe"]) writeFileSync(path.join(native, name), "native fixture", { mode: 0o700 });
    const stagedNode = path.join(f.root, "seat-node", "node.exe");
    const stage = vi.fn(() => stagedNode);
    const grant = vi.fn();
    const launch = new SeatLaunchEnvironment(f.tmux as unknown as TmuxAdapter, { OPENRIG_HOME: f.home, PATH: native }, f.root, f.cli, undefined, "win32", stage, grant);
    const cli = realpathSync(f.cli);

    const elevated = await launch.command("seat@rig", "codex resume 'abc'", { codexCwd: f.root, runtime: "codex", codexElevatedSandbox: true });
    expect(stage).toHaveBeenCalledWith(f.home, f.root);
    expect(rigCmd(elevated)).toBe(`@echo off\r\n"${stagedNode}" "${cli}" %*\r\n`);
    // Its shims' own folder is granted to the sandbox too.
    expect(grant.mock.calls).toEqual([[f.home, f.root, seatBinOf(elevated)]]);
    stage.mockClear();
    grant.mockClear();
    const others = [
      await launch.command("seat@rig", "codex resume 'abc'", { codexCwd: f.root, runtime: "codex" }),
      // Only a Codex launch runs in Codex's sandbox.
      await launch.command("seat@rig", "claude --session-id 'abc'", { runtime: "claude-code", codexElevatedSandbox: true }),
    ];
    for (const rendered of others) expect(rigCmd(rendered)).toBe(`@echo off\r\n"${process.execPath}" "${cli}" %*\r\n`);
    expect(stage).not.toHaveBeenCalled();
    expect(grant).not.toHaveBeenCalled();
    // The staged Node's shims are their own directory; this daemon's Node keeps its own.
    expect(readdirSync(path.join(f.home, "run", "seat-bin"))).toHaveLength(2);
    expect(seatBinOf(others[0]!)).toBe(seatBinOf(others[1]!));
    expect(seatBinOf(others[0]!)).not.toBe(seatBinOf(elevated));
  });

  it("grants no seat-bin folder for an elevated Codex seat whose Node could not be staged: that folder is every seat's", async () => {
    const f = launchFixture(tmpdir());
    const native = path.join(f.root, "native");
    mkdirSync(native);
    writeFileSync(path.join(native, "codex.exe"), "native fixture", { mode: 0o700 });
    const grant = vi.fn();
    const launch = new SeatLaunchEnvironment(f.tmux as unknown as TmuxAdapter, { OPENRIG_HOME: f.home, PATH: native }, f.root, f.cli, undefined, "win32",
      () => process.execPath, grant);
    const elevated = await launch.command("seat@rig", "codex resume 'abc'", { codexCwd: f.root, runtime: "codex", codexElevatedSandbox: true });
    const plain = await launch.command("seat@rig", "codex resume 'abc'", { codexCwd: f.root, runtime: "codex" });
    expect(rigCmd(elevated)).toBe(`@echo off\r\n"${process.execPath}" "${realpathSync(f.cli)}" %*\r\n`);
    expect(seatBinOf(elevated)).toBe(seatBinOf(plain));
    expect(grant).not.toHaveBeenCalled();
  });

  it("refuses a staged Node path the rig shims could not name, as for this daemon's Node", async () => {
    const f = launchFixture(tmpdir());
    const native = path.join(f.root, "native");
    mkdirSync(native);
    writeFileSync(path.join(native, "codex.exe"), "native fixture", { mode: 0o700 });
    const launch = new SeatLaunchEnvironment(f.tmux as unknown as TmuxAdapter, { OPENRIG_HOME: f.home, PATH: native }, f.root, f.cli, undefined, "win32",
      () => path.join(f.root, "100%", "node.exe"));
    await expect(launch.command("seat@rig", "codex resume 'abc'", { codexCwd: f.root, runtime: "codex", codexElevatedSandbox: true }))
      .rejects.toThrow("no POSIX fallback was typed. Unsupported Windows executable path");
    expect(() => windowsSeatCli(f.home, f.root, f.cli, `${f.root}\\a"b\\node.exe`)).toThrow("Unsupported Windows executable path");
  });

  it.each(["pi", "omp", "stub"])("starts the %s runner with this daemon's Node", async runtime => {
    const f = launchFixture(tmpdir());
    const rendered = await f.launch.command("seat@rig", `node '/opt/runner.js' --runtime ${runtime}`, { runtime });
    expect(fileNameOf(rendered)).toBe(process.execPath);
  });

  it("names its own refusal in the Windows launch error, never another error's text", async () => {
    const f = launchFixture(tmpdir());
    await expect(f.launch.command("seat@rig", "claude", { runtime: "claude-code" }))
      .rejects.toThrow("no POSIX fallback was typed. Seat launch requires claude.exe on the daemon launch PATH.");
    await expect(f.launch.command("seat@rig", "python '/opt/runner.py'", { runtime: "pi" }))
      .rejects.toThrow("no POSIX fallback was typed. Expected a managed Node runner");
    delete f.identity.OPENRIG_NODE_ID;
    await expect(f.launch.command("seat@rig", "claude", { runtime: "claude-code" }))
      .rejects.toThrow("Seat launch requires the session's OpenRig identity.");
    f.tmux.getSessionEnv.mockRejectedValue(new Error("tmux: OPENRIG_SECRET=synthetic-value"));
    const error = await f.launch.command("seat@rig", "claude", { runtime: "claude-code" }).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Experimental Windows launch environment could not be prepared; no POSIX fallback was typed.");
  });
});

describe.runIf(process.platform === "win32")("Windows seat bin entries, run natively", () => {
  const awkward = ["send", "seat", "", 'say "hi" now', "trail\\", "a&b", "100%PATH%", "it's", "/compact", "back\\\"slash"];
  const powershell = (script: string, env: NodeJS.ProcessEnv) => execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8", timeout: 30000, windowsHide: true, env });

  it("rig.ps1, found first on PATH, passes every argument, piped input and the exit code through", async () => {
    const f = fixture();
    const { bin } = windowsSeatCli(f.home, f.root, f.cli);
    const env = { ...process.env, PATH: `${bin};${process.env.PATH}` };
    const words = awkward.map(word => `'${word.replace(/'/g, "''")}'`).join(" ");
    const resolved = await powershell("(Get-Command rig).Source", env);
    expect(resolved.stdout.trim()).toBe(path.join(bin, "rig.ps1"));
    const direct = await powershell(`rig ${words}`, env);
    expect(JSON.parse(direct.stdout)).toEqual({ argv: awkward, input: "" });
    const piped = await powershell(`'first line', "caf$([char]0xe9)" | rig seat token`, env);
    expect(JSON.parse(piped.stdout)).toEqual({ argv: ["seat", "token"], input: "first line\ncafé\n" });
    const exit = await powershell("rig status; Write-Output \"exit=$LASTEXITCODE\"", { ...env, RIG_FIXTURE_EXIT: "7" });
    expect(exit.stdout).toMatch(/exit=7\s*$/);
  }, 60000);

  it("rig.cmd runs the paired CLI with this daemon's Node", async () => {
    const f = fixture();
    const { bin } = windowsSeatCli(f.home, f.root, f.cli);
    const { stdout } = await execute(process.env.ComSpec ?? "cmd.exe", ["/d", "/c", "rig status --json"], { encoding: "utf8", timeout: 30000, windowsHide: true, env: { ...process.env, PATH: `${bin};${process.env.PATH}` } });
    expect(JSON.parse(stdout)).toEqual({ argv: ["status", "--json"], input: "" });
  }, 60000);

  const sh = [path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "sh.exe")].find(existsSync);
  it.runIf(sh)("the Git Bash rig passes arguments that look like POSIX paths without MSYS rewriting them", async () => {
    const f = fixture();
    const { bin } = windowsSeatCli(f.home, f.root, f.cli);
    const args = ["send", "peer", "/compact", "/review the diff", "--file=/tmp/x.md", "//double", "a:/b"];
    const { stdout } = await execute(sh!, [path.join(bin, "rig").replace(/\\/g, "/"), ...args], { encoding: "utf8", timeout: 30000, windowsHide: true });
    expect(JSON.parse(stdout)).toEqual({ argv: args, input: "" });
  }, 60000);
});
