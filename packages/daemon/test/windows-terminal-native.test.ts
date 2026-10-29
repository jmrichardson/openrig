import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { renderWindowsLaunch } from "../src/adapters/windows-launch.js";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const enabled = process.platform === "win32" && !!process.env.OPENRIG_TEST_PSMUX;

describe.skipIf(!enabled)("native psmux PowerShell staging", () => {
  /** Runs the test psmux with this process's environment plus env. */
  const psmux = (env: NodeJS.ProcessEnv = {}) => async (argv: string[]) =>
    (await execFileAsync(process.env.OPENRIG_TEST_PSMUX!, argv.slice(1), { windowsHide: true, env: { ...process.env, ...env } })).stdout;
  const q = (value: string) => "'" + value.replace(/'/g, "'\"'\"'") + "'";
  it("applies the launch policy before a runtime can inherit the server's environment", async () => {
    const session = `openrig-policy-${process.pid}-${Date.now()}`;
    const invoke = psmux({ OPENRIG_UNSELECTED_SECRET: "fixture-other-account" });
    const adapter = new TmuxAdapter(async () => { throw new Error("No POSIX transport"); }, undefined, invoke, "psmux");
    adapter.launchEnvironment = () => ({ inheritTmuxEnvironment: false, env: { PATH: process.env.PATH, HOME: os.homedir() } });
    try {
      expect(await adapter.createSession(session, os.tmpdir(), { OPENRIG_NODE_ID: "fixture-node", OPENRIG_TEST_SELECTED: "own-seat" })).toEqual({ ok: true });
      expect(await adapter.getSessionEnv(session, "OPENRIG_TEST_SELECTED")).toBe("own-seat");
      expect(await adapter.getSessionEnv(session, "OPENRIG_UNSELECTED_SECRET")).toBeUndefined();
      expect(await adapter.getPaneCommand(session)).toBe("powershell");
    } finally { await adapter.killSession(session); }
  }, 30_000);
  /** Resolves with file's content once it exists. On timeout the error names it, ending with the pane's screen when one is given. */
  const waitForFile = async (file: string, timeoutMs: number, pane?: { adapter: TmuxAdapter; session: string }) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) { try { return readFileSync(file, "utf8"); } catch { await new Promise(resolve => setTimeout(resolve, 50)); } }
    const screen = pane ? `; fixture screen: ${(await pane.adapter.capturePaneScreen(pane.session))?.slice(-1200) ?? "unavailable"}` : "";
    throw new Error(`fixture did not produce ${path.basename(file)}${screen}`);
  };
  it("delivers a multiline block as one runner submission", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "openrig-native-input-"));
    const session = `openrig-input-${process.pid}-${Date.now()}`;
    const output = path.join(dir, "result.json"), ready = path.join(dir, "ready");
    const script = path.join(dir, "receiver.mjs");
    const runner = pathToFileURL(path.resolve(import.meta.dirname, "../dist/adapters/pi-runner.js")).href;
    writeFileSync(script, `import fs from 'node:fs'; import {createRunnerInput} from ${JSON.stringify(runner)};
      createRunnerInput(process.stdin, process.stdout, block => { fs.writeFileSync(${JSON.stringify(output + ".tmp")}, JSON.stringify(block)); fs.renameSync(${JSON.stringify(output + ".tmp")}, ${JSON.stringify(output)}); process.exit(0); });
      fs.writeFileSync(${JSON.stringify(ready)}, 'ready');`);
    const invoke = psmux();
    const adapter = new TmuxAdapter(async () => { throw new Error("No POSIX transport"); }, undefined, invoke, "psmux");
    try {
      expect(await adapter.createSession(session, os.tmpdir())).toEqual({ ok: true });
      expect(await adapter.sendShellCommand(session, renderWindowsLaunch([process.execPath, script].map(q).join(" "), {}))).toEqual({ ok: true });
      await waitForFile(ready, 5000, { adapter, session });
      const pane = (await adapter.listPanes(session))[0]!;
      const message = "first line\nsecond line; 中文";
      expect(await adapter.sendText(pane.id, message)).toEqual({ ok: true });
      expect(await adapter.sendKeys(pane.id, ["Enter"])).toEqual({ ok: true });
      expect(JSON.parse(await waitForFile(output, 5000, { adapter, session }))).toBe(message);
    } finally {
      await invoke(["tmux", "kill-session", "-t", `=${session}`]).catch(() => {});
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 20_000);
  it("delivers exact native argv and environment through a real pane", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "openrig-native-"));
    const session = `openrig-test-${process.pid}-${Date.now()}`;
    const decoy = `${session}-other`;
    const output = path.join(dir, "result.json");
    const script = path.join(dir, "echo args.js");
    writeFileSync(script, `require('fs').writeFileSync(process.argv[2], JSON.stringify({args: process.argv.slice(3), marker: process.env.OPENRIG_TEST_MARKER, parentIdentity: process.env.CLAUDECODE ?? null}));`);
    const invoke = psmux({ CLAUDECODE: "native-test-parent" });
    const adapter = new TmuxAdapter(async () => { throw new Error("POSIX shell execution is forbidden in this probe"); }, undefined, invoke, "psmux");
    try {
      expect(await adapter.createSession(session, dir, { OPENRIG_TEST_SESSION_MARKER: "two words 中文 ' quote" })).toEqual({ ok: true });
      expect(await adapter.getSessionEnv(session, "OPENRIG_TEST_SESSION_MARKER")).toBe("two words 中文 ' quote");
      expect(await adapter.createSession(decoy, dir)).toEqual({ ok: true });
      const args = ["space word", "a'b", "中文;$HOME", "", 'embedded"quote', "space trailing\\", "trailing\\"];
      const command = [process.execPath, script, output, ...args].map(q).join(" ");
      const panes = await adapter.listPanes(session);
      expect(panes).toHaveLength(1);
      expect(panes[0]!.id).toMatch(/^psmux:.*:%\d+$/);
      const other = (await adapter.listPanes(decoy))[0]!;
      expect(other.id).not.toBe(panes[0]!.id);
      expect(await adapter.sendShellCommand(panes[0]!.id, renderWindowsLaunch(command, { OPENRIG_TEST_MARKER: "native-ok" }))).toEqual({ ok: true });
      let result: unknown;
      const deadline = Date.now() + 12_000;
      while (Date.now() < deadline) {
        try { result = JSON.parse(readFileSync(output, "utf8")); break; } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
      }
      expect(result).toEqual({ args, marker: "native-ok", parentIdentity: null });
      expect(await adapter.killSession(session)).toEqual({ ok: true });
      expect((await adapter.probeSession(session)).state).toBe("absent");
      expect((await adapter.probeSession(decoy)).state).toBe("present");
    } finally {
      await invoke(["tmux", "kill-session", "-t", `=${session}`]).catch(() => {});
      await invoke(["tmux", "kill-session", "-t", `=${decoy}`]).catch(() => {});
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 20_000);
  it("executes an in-place native restart and preserves the existing scrollback", async () => {
    const session = `openrig-respawn-${process.pid}-${Date.now()}`;
    const invoke = psmux({ SHELL: "C:\\Program Files\\Git\\bin\\bash.exe" });
    const adapter = new TmuxAdapter(async () => { throw new Error("No POSIX transport"); }, undefined, invoke, "psmux");
    try {
      expect(await adapter.createSession(session, os.tmpdir())).toEqual({ ok: true });
      const pane = (await adapter.listPanes(session))[0]!.id;
      expect(await adapter.sendShellCommand(pane, "Write-Output 'before-native-restart'; 1..50 | ForEach-Object { Write-Output ('old line ' + $_) }")).toEqual({ ok: true });
      // Integration: await real terminal consumption and process exit, not guessed sleeps.
      await expect.poll(() => adapter.capturePaneHistory(pane), { timeout: 5000 }).toContain("old line 50");
      expect(await adapter.setRemainOnExit(pane, true)).toEqual({ ok: true });
      expect(await adapter.signalPaneProcess(pane, "KILL")).toEqual({ ok: true });
      await expect.poll(() => adapter.isPaneDead(pane), { timeout: 5000 }).toBe(true);
      expect(await adapter.respawnPane(pane, "& { Write-Output 'after-native-restart'; Start-Sleep -Seconds 60 }")).toEqual({ ok: true });
      await expect.poll(() => adapter.capturePaneHistory(pane), { timeout: 5000 }).toContain("after-native-restart");
      expect(await adapter.capturePaneHistory(pane)).toContain("before-native-restart");
    } finally {
      await adapter.killSession(session);
    }
  }, 20_000);
  it("respawns a handover's blank pane into createSession's PowerShell, not psmux's default-shell", async () => {
    const session = `openrig-blank-${process.pid}-${Date.now()}`;
    // psmux seeds default-shell from SHELL: a Git Bash parent must not choose the successor's shell.
    const invoke = psmux({ SHELL: "C:\\Program Files\\Git\\bin\\bash.exe" });
    const adapter = new TmuxAdapter(async () => { throw new Error("No POSIX transport"); }, undefined, invoke, "psmux");
    try {
      expect(await adapter.createSession(session, os.tmpdir())).toEqual({ ok: true });
      const pane = (await adapter.listPanes(session))[0]!.id;
      expect(await adapter.setRemainOnExit(pane, true)).toEqual({ ok: true });
      // No graceful signal exists for a console process: TERM says so and leaves the pane running.
      expect(await adapter.signalPaneProcess(pane, "TERM")).toMatchObject({ ok: false, code: "graceful_unsupported" });
      expect(await adapter.isPaneDead(pane)).toBe(false);
      expect(await adapter.signalPaneProcess(pane, "KILL")).toEqual({ ok: true });
      await expect.poll(() => adapter.isPaneDead(pane), { timeout: 5000 }).toBe(true);
      expect(await adapter.respawnPane(pane, (await adapter.getDefaultShell())!, { env: { OPENRIG_TEST_MARKER: "blank" } })).toEqual({ ok: true });
      await expect.poll(() => adapter.getPaneCommand(pane), { timeout: 5000 }).toBe("powershell");
      // The pane's own process is that PowerShell: no wrapper shell sits between the pane and a launch.
      const pid = await adapter.getPanePid(pane);
      const { stdout } = await execFileAsync(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        ["-NoProfile", "-NonInteractive", "-Command", `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; $c = @(Get-CimInstance Win32_Process -Filter 'ParentProcessId=${pid}' | Where-Object Name -eq 'powershell.exe'); "$($p.Name)|$($c.Count)|$($p.CommandLine -match '-EncodedCommand')"`],
        { windowsHide: true });
      expect(stdout.trim()).toBe("powershell.exe|0|False");
    } finally {
      await adapter.killSession(session);
    }
  }, 30_000);
  it("types Codex-mode console input with each CRLF or lone CR as one newline", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "openrig-codex-input-"));
    const session = `openrig-codex-input-${process.pid}-${Date.now()}`;
    const output = path.join(dir, "result.json"), ready = path.join(dir, "ready"), payload = path.join(dir, "payload.txt");
    const script = path.join(dir, "reader.cjs");
    // A raw-mode console reader sees each key event's character, as Codex's crossterm reader does.
    writeFileSync(script, `const fs = require('fs'); let got = ''; process.stdin.setRawMode(true);
      process.stdin.on('data', d => { got += d; if (got.includes('END')) { fs.writeFileSync(${JSON.stringify(output)}, JSON.stringify(got)); process.exit(0); } });
      fs.writeFileSync(${JSON.stringify(ready)}, 'ready');`);
    writeFileSync(payload, "one\r\ntwo\rthree\nEND");
    const invoke = psmux();
    const adapter = new TmuxAdapter(async () => { throw new Error("No POSIX transport"); }, undefined, invoke, "psmux");
    try {
      expect(await adapter.createSession(session, dir)).toEqual({ ok: true });
      expect(await adapter.sendShellCommand(session, renderWindowsLaunch([process.execPath, script].map(q).join(" "), {}))).toEqual({ ok: true });
      await waitForFile(ready, 8000);
      const pid = await adapter.getPanePid(session);
      await execFileAsync(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.resolve(import.meta.dirname, "../assets/windows-console-input.ps1"),
          "-TargetPid", String(pid), "-PayloadFile", payload, "-Mode", "codex"], { windowsHide: true, timeout: 15000 });
      // Shift+Return carries CR as its character: one per line break, never a second stray CR.
      expect(JSON.parse(await waitForFile(output, 8000))).toBe("one\rtwo\rthree\rEND");
    } finally {
      await invoke(["tmux", "kill-session", "-t", `=${session}`]).catch(() => {});
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 30_000);
  it("creates a private probe session with native argv and removes it by identity on its own server", async () => {
    const invoke = psmux();
    const adapter = new TmuxAdapter(async () => { throw new Error("POSIX shell execution is forbidden in this probe"); }, undefined, invoke, "psmux");
    const dir = mkdtempSync(path.join(os.tmpdir(), "openrig probe "));
    const kept = `rigged-refresh-kept-${process.pid}-${Date.now()}`;
    const removed = `rigged-refresh-removed-${process.pid}-${Date.now()}`;
    try {
      expect(await adapter.createProbeSession(kept, dir)).toEqual({ ok: true });
      expect(await adapter.getPaneCommand(kept)).toBe("powershell");
      expect(await adapter.killSession(kept)).toEqual({ ok: true });
      expect((await adapter.probeSession(kept)).state).toBe("absent");
      // A managed record naming the new pane (a stale binding) makes the probe unusable: it is removed by name and creation time.
      adapter.deliveryGuard = { attachInputInspection: () => {}, maybeTarget: (target: string) => target.startsWith("psmux:") ? { nodeId: "n", session: "other", occupant: null, pane: target } : null } as never;
      expect(await adapter.createProbeSession(removed, dir)).toEqual({ ok: false, code: "guard_target_unknown", message: "New probe pane is named by a managed record; no input written." });
      expect((await adapter.probeSession(removed)).state).toBe("absent");
    } finally {
      await invoke(["tmux", "kill-session", "-t", `=${kept}`]).catch(() => {});
      await invoke(["tmux", "kill-session", "-t", `=${removed}`]).catch(() => {});
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 30_000);
});
