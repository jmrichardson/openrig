import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execWindowsCodexCommand, resolveWindowsCodexCommand } from "../src/adapters/windows-codex-command.js";
import { buildPiChildEnv } from "../src/adapters/pi-runner-protocol.js";
import { isShellForeground } from "../src/domain/shell-classifier.js";
import { assessNativeResumeProbe } from "../src/domain/native-resume-probe.js";
import { readWindowsProcessFacts } from "../src/domain/windows-process-facts.js";
import { verifyCodexProfileLoads } from "../src/domain/codex-profile-preflight.js";
import { PiRuntimeAdapter } from "../src/adapters/pi-runtime-adapter.js";
import { OmpRuntimeAdapter } from "../src/adapters/omp-runtime-adapter.js";
import { StubRuntimeAdapter } from "../src/adapters/stub-runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";
import { launchExecutable, type SeatLaunchEnvironment } from "../src/domain/seat-launch-environment.js";

const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** A standard npm Codex install (package plus `codex.cmd`) in `dir` whose bin is `bin`; returns bin/codex.js. */
function npmPkg(dir: string, bin: string, body = "// fixture only"): string {
  const pkg = path.join(dir, "node_modules", "@openai", "codex"); mkdirSync(path.join(pkg, "bin"), { recursive: true });
  writeFileSync(path.join(pkg, "bin", "codex.js"), body);
  writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "@openai/codex", bin: { codex: bin } }));
  writeFileSync(path.join(dir, "codex.cmd"), `@"%dp0%\\node_modules\\@openai\\codex\\${bin.replace(/\//g, "\\")}" %*`);
  return path.join(pkg, "bin", "codex.js");
}

describe("Windows runtime launch and recovery", () => {
  it.each(["powershell", "PowerShell.EXE", "pwsh.exe", "cmd.exe", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"])("rejects stale resume evidence at %s", paneCommand => {
    expect(isShellForeground(paneCommand, null, "win32")).toBe(true);
    expect(assessNativeResumeProbe({ runtime: "claude-code", paneCommand, paneContent: "PS C:\\work>" }, "win32")).toMatchObject({ code: "returned_to_shell", status: "failed" });
  });

  it("recognizes native Claude executable labels without changing its identity gate", () => {
    expect(assessNativeResumeProbe({ runtime: "claude-code", paneCommand: "claude.exe", paneContent: "", claudeResumeIdentityVerified: true }, "win32")).toMatchObject({ status: "resumed" });
    expect(assessNativeResumeProbe({ runtime: "claude-code", paneCommand: "claude.exe", paneContent: "", claudeResumeIdentityVerified: false }, "win32").status).not.toBe("resumed");
  });

  it("does not treat stale Pi, OMP or stub sidecars as live at a PowerShell prompt", async () => {
    const tmux = { hasSession: async () => true, getPaneCommand: async () => "powershell.exe", capturePaneContent: async () => "" } as unknown as TmuxAdapter;
    const fsOps = { exists: () => true, readFile: () => JSON.stringify({ ready: true, updatedAt: "t", sessionFile: "/session.jsonl" }), writeFile: () => {}, mkdirp: () => {} };
    const binding = { tmuxSession: "seat@rig", cwd: path.resolve("workspace") } as NodeBinding;
    // The adapters classify the pane's shell for the host platform.
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    try {
      for (const adapter of [
        new PiRuntimeAdapter({ tmux, fsOps, stateRoot: "/state", runnerEntryPath: "/runner" }),
        new OmpRuntimeAdapter({ tmux, fsOps, stateRoot: "/state", runnerEntryPath: "/runner" }),
        new StubRuntimeAdapter({ tmux, fsOps }),
      ]) expect(await adapter.checkReady(binding)).toMatchObject({ ready: false, code: "runner_exited" });
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });

  it.runIf(process.platform === "win32")("routes the stub runner through the native launch and seat environment channels", async () => {
    const command = vi.fn(async () => "native-stub-command");
    const sendShellCommand = vi.fn(async () => ({ ok: true as const }));
    const tmux = { sendShellCommand, sendText: vi.fn(), sendKeys: vi.fn() } as unknown as TmuxAdapter;
    const fsOps = { exists: () => true, readFile: () => JSON.stringify({ ready: true, launchId: "attempt" }), writeFile: () => {}, mkdirp: () => {} };
    const adapter = new StubRuntimeAdapter({ tmux, fsOps, runnerEntryPath: "C:\\runner.js", newLaunchId: () => "attempt",
      seatLaunchEnvironment: { command } as unknown as SeatLaunchEnvironment });
    expect((await adapter.launchHarness({ tmuxSession: "seat@rig", nodeId: "node", launchGeneration: "generation", cwd: "C:\\work" } as NodeBinding, { name: "seat" })).ok).toBe(true);
    expect(command).toHaveBeenCalledWith("seat@rig", expect.stringContaining("--launch-id"), { nodeId: "node", generation: "generation", runtime: "stub" });
    expect(sendShellCommand).toHaveBeenCalledWith("seat@rig", "native-stub-command");
    expect(tmux.sendText).not.toHaveBeenCalled();
    expect(tmux.sendKeys).not.toHaveBeenCalled();
  });

  it("pins both Windows home variables for OMP while forwarding only the selected provider", () => {
    const agentDir = path.resolve("isolated-seat", "agent");
    const env = buildPiChildEnv({ HOME: "operator-home", USERPROFILE: "operator-profile", SystemRoot: "C:\\Windows", OPENAI_API_KEY: "dummy-selected", ANTHROPIC_API_KEY: "dummy-unselected" },
      { agentDir, sessionsDir: path.resolve("isolated-seat", "sessions"), runtime: "omp", model: "openai/example", platform: "win32" });
    expect(env.HOME).toBe(path.dirname(agentDir));
    expect(env.USERPROFILE).toBe(env.HOME);
    expect(env.SystemRoot).toBe("C:\\Windows");
    expect(env.OPENAI_API_KEY).toBe("dummy-selected");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("resolves a standard Codex npm shim without executing cmd", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "openrig-codex-command-")); temporary.push(root);
    const target = npmPkg(root, "bin/codex.js");
    expect(resolveWindowsCodexCommand(root, process.execPath)).toEqual({ command: process.execPath, args: [realpathSync(target)] });
    writeFileSync(path.join(root, "codex.cmd"), "unrecognized launcher");
    expect(() => resolveWindowsCodexCommand(root, process.execPath)).toThrow("Unrecognized Windows Codex shim");
    writeFileSync(path.join(root, "codex.exe"), "native fixture", { mode: 0o755 });
    expect(resolveWindowsCodexCommand(root, process.execPath)).toEqual({ command: realpathSync(path.join(root, "codex.exe")), args: [] });
  });

  it("never resolves Codex from the working directory through an empty or quoted PATH element", () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "openrig-codex-path-"))); temporary.push(root);
    const repo = path.join(root, "repo"), other = path.join(root, "other"), real = path.join(root, "real");
    for (const dir of [repo, other, real]) mkdirSync(dir);
    writeFileSync(path.join(repo, "codex.exe"), "decoy committed in a repository", { mode: 0o755 });
    writeFileSync(path.join(real, "codex.exe"), "native fixture", { mode: 0o755 });
    const realCodex = { command: path.join(real, "codex.exe"), args: [] };
    expect(resolveWindowsCodexCommand([other, "", real].join(path.delimiter), process.execPath, repo)).toEqual(realCodex);
    expect(resolveWindowsCodexCommand(["", " ", other, real, ""].join(path.delimiter), process.execPath, repo)).toEqual(realCodex);
    expect(resolveWindowsCodexCommand([other, `"${real}"`].join(path.delimiter), process.execPath, repo)).toEqual(realCodex);
    expect(() => resolveWindowsCodexCommand(["", other].join(path.delimiter), process.execPath, repo)).toThrow(expect.objectContaining({ code: "ENOENT" }));
    // An explicit relative element is still honoured, as PowerShell honours it.
    expect(resolveWindowsCodexCommand(".", process.execPath, repo)).toEqual({ command: path.join(repo, "codex.exe"), args: [] });
  });

  it("never resolves the seat launch's Node from the working directory through an empty or quoted PATH element", () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "openrig-node-path-"))); temporary.push(root);
    const repo = path.join(root, "repo"), other = path.join(root, "other"), real = path.join(root, "real");
    for (const dir of [repo, other, real]) mkdirSync(dir);
    writeFileSync(path.join(repo, "node.exe"), "decoy committed in a repository", { mode: 0o755 });
    writeFileSync(path.join(real, "node.exe"), "native fixture", { mode: 0o755 });
    const realNode = path.join(real, "node.exe");
    expect(launchExecutable("node", [other, "", real].join(path.delimiter), repo, true)).toBe(realNode);
    expect(launchExecutable("node", ["", " ", other, `"${real}"`].join(path.delimiter), repo, true)).toBe(realNode);
    expect(() => launchExecutable("node", ["", other].join(path.delimiter), repo, true)).toThrow("Seat launch requires node on the daemon launch PATH.");
    // An explicit relative element is still honoured, as PowerShell honours it.
    expect(launchExecutable("node", ".", repo, true)).toBe(path.join(repo, "node.exe"));
  });

  it("passes over a codex.cmd that is not the standard npm layout to a later PATH element", () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "openrig-codex-shims-"))); temporary.push(root);
    const pnpm = path.join(root, "pnpm"), escaping = path.join(root, "escaping"), npm = path.join(root, "npm"), native = path.join(root, "native");
    for (const dir of [pnpm, escaping, npm, native]) mkdirSync(dir);
    writeFileSync(path.join(pnpm, "codex.cmd"), '@"%~dp0\\global\\5\\node_modules\\@openai\\codex\\bin\\codex.js" %*');
    npmPkg(escaping, "../../../outside.js");
    const entry = npmPkg(npm, "bin/codex.js");
    writeFileSync(path.join(native, "codex.exe"), "native fixture", { mode: 0o755 });
    const search = (...dirs: string[]) => dirs.join(path.delimiter);
    expect(resolveWindowsCodexCommand(search(pnpm, escaping, npm), process.execPath)).toEqual({ command: process.execPath, args: [entry] });
    expect(resolveWindowsCodexCommand(search(pnpm, native, npm), process.execPath)).toEqual({ command: path.join(native, "codex.exe"), args: [] });
    // The native executable wins within one PATH element, as PATHEXT orders it.
    writeFileSync(path.join(npm, "codex.exe"), "native beside npm", { mode: 0o755 });
    expect(resolveWindowsCodexCommand(npm, process.execPath)).toEqual({ command: path.join(npm, "codex.exe"), args: [] });
    // With nothing usable, the first reason is reported, and not as a missing executable.
    let failure: unknown;
    try { resolveWindowsCodexCommand(search(pnpm, escaping), process.execPath); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ message: "Windows Codex requires a native executable or a recognized npm installation" });
    expect((failure as NodeJS.ErrnoException).code).toBeUndefined();
    expect(() => resolveWindowsCodexCommand(search(escaping, pnpm), process.execPath)).toThrow("Codex npm entry escapes its package");
  });

  it.runIf(process.platform === "win32")("loads a named profile through native npm argv without cmd quoting", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "openrig-profile-probe-")); temporary.push(root);
    const capture = path.join(root, "argv.json");
    npmPkg(root, "bin/codex.js", 'require("node:fs").writeFileSync(process.env.CAPTURE,JSON.stringify(process.argv.slice(2)))');
    const result = await verifyCodexProfileLoads("team O'Brien", command => execWindowsCodexCommand(command, {
      cwd: root, env: { PATH: root, SystemRoot: process.env.SystemRoot, CAPTURE: capture },
    }));
    expect(result.ok).toBe(true);
    expect(JSON.parse(readFileSync(capture, "utf8"))).toEqual(["-p", "team O'Brien", "mcp", "list"]);
  });

  it.runIf(process.platform === "win32")("reads exact child process facts without returning provider credential values", async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "openrig-process-facts-")); temporary.push(cwd);
    const child = spawn(process.execPath, ["-e", 'process.stdin.resume();process.stdout.write("ready")'], { cwd,
      env: { SystemRoot: process.env.SystemRoot, HOME: path.join(cwd, "home space"), CODEX_HOME: path.join(cwd, "codex home"), USERPROFILE: path.join(cwd, "profile"), OPENAI_API_KEY: "dummy-do-not-output", CODEX_API_KEY: "", UNRELATED_SECRET: "dummy-never-output" },
      stdio: ["pipe", "pipe", "ignore"] });
    try {
      await once(child.stdout!, "data");
      const facts = await readWindowsProcessFacts(child.pid!);
      expect(facts).toMatchObject({ cwd, exe: process.execPath, env: { HOME: path.join(cwd, "home space"), CODEX_HOME: path.join(cwd, "codex home"), USERPROFILE: path.join(cwd, "profile") }, apiKeyEnvNames: ["OPENAI_API_KEY"] });
      expect(JSON.stringify(facts)).not.toContain("dummy-");
    } finally {
      const exited = once(child, "exit"); child.kill(); await exited;
    }
  }, 30000);
});
