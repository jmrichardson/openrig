// Native Windows shells read as shells only on Windows. On Linux and macOS every call site keeps
// the shell set it had before the Windows port: the shared classifier's nine names, and the
// launch, resume and readiness checks' exact six (bash, fish, nu, sh, tmux, zsh).
import { describe, expect, it, vi } from "vitest";
import { isRuntimeShell, isShellForeground } from "../src/domain/shell-classifier.js";
import { assessNativeResumeProbe, isProbeShellReady } from "../src/domain/native-resume-probe.js";
import { ClaudeCodeAdapter, type ClaudeAdapterFsOps } from "../src/adapters/claude-code-adapter.js";
import { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import { PiRuntimeAdapter } from "../src/adapters/pi-runtime-adapter.js";
import { StubRuntimeAdapter } from "../src/adapters/stub-runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";
import { mockShellCommand } from "./helpers/shell-command-mock.js";

describe("shared shell classifier", () => {
  it.each(["bash", "-zsh", "sh", "fish", "nu", "dash", "ksh", "tcsh", "csh"])("keeps %s as a shell on every platform", (command) => {
    expect(isShellForeground(command, null, "linux")).toBe(true);
    expect(isShellForeground(command, null, "win32")).toBe(true);
  });

  it.each(["pwsh", "powershell", "cmd", "ZSH", "/bin/zsh", "zsh.exe"])("on POSIX, %s is not a listed shell", (command) => {
    expect(isShellForeground(command, null, "linux")).toBe(false);
    expect(isShellForeground(command, null, "darwin")).toBe(false);
  });

  it.each(["powershell", "PowerShell.EXE", "pwsh.exe", "cmd.exe", String.raw`C:\Program Files\PowerShell\7\pwsh.exe`, "-bash"])("on Windows, %s is a shell", (command) => {
    expect(isShellForeground(command, null, "win32")).toBe(true);
  });

  it("compares a configured shell by exact basename on POSIX, and without case or .exe on Windows", () => {
    expect(isShellForeground("elvish", "/usr/local/bin/elvish", "darwin")).toBe(true);
    expect(isShellForeground("Elvish", "/usr/local/bin/elvish", "darwin")).toBe(false);
    expect(isShellForeground("Elvish", String.raw`C:\Tools\elvish.exe`, "win32")).toBe(true);
    expect(isShellForeground("node", null, "win32")).toBe(false);
  });
});

describe("launch, resume and readiness shell checks", () => {
  it.each(["bash", "fish", "nu", "sh", "tmux", "zsh"])("treat %s as a return to the shell on every platform", (command) => {
    expect(isRuntimeShell(command, "linux")).toBe(true);
    expect(isRuntimeShell(command, "win32")).toBe(true);
  });

  it.each(["dash", "ksh", "tcsh", "csh", "pwsh", "-zsh", "/bin/zsh"])("on POSIX, keep %s outside the legacy set", (command) => {
    expect(isRuntimeShell(command, "linux")).toBe(false);
    expect(isRuntimeShell(command, "darwin")).toBe(false);
  });

  it.each(["powershell", "pwsh.exe", "cmd.exe", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"])("on Windows, treat %s as a return to the shell", (command) => {
    expect(isRuntimeShell(command, "win32")).toBe(true);
  });

  it.each(["claude-code", "codex"])("on POSIX, a %s probe at tcsh keeps waiting rather than failing as returned to shell", (runtime) => {
    expect(assessNativeResumeProbe({ runtime, paneCommand: "tcsh", paneContent: "% " }, "linux")).toMatchObject({ status: "inconclusive", code: "awaiting_runtime" });
    expect(assessNativeResumeProbe({ runtime, paneCommand: "zsh", paneContent: "% " }, "linux")).toMatchObject({ status: "failed", code: "returned_to_shell" });
    expect(assessNativeResumeProbe({ runtime, paneCommand: "pwsh.exe", paneContent: "PS C:\\> " }, "win32")).toMatchObject({ status: "failed", code: "returned_to_shell" });
  });

  it("on POSIX, a probe reads the pane command exactly", () => {
    expect(assessNativeResumeProbe({ runtime: "claude-code", paneCommand: "claude", paneContent: "" }, "linux")).toMatchObject({ status: "resumed" });
    expect(assessNativeResumeProbe({ runtime: "claude-code", paneCommand: "claude.exe", paneContent: "" }, "linux")).toMatchObject({ status: "inconclusive" });
    expect(assessNativeResumeProbe({ runtime: "claude-code", paneCommand: "Claude.EXE", paneContent: "" }, "win32")).toMatchObject({ status: "resumed" });
  });

  it("a probe pane is shell-ready only at a listed shell for its platform", () => {
    expect(isProbeShellReady({ paneCommand: "ksh", paneContent: "$ " }, "linux")).toBe(false);
    expect(isProbeShellReady({ paneCommand: "bash", paneContent: "$ " }, "linux")).toBe(true);
    expect(isProbeShellReady({ paneCommand: "powershell", paneContent: "PS C:\\> " }, "win32")).toBe(true);
    expect(isProbeShellReady({ paneCommand: "powershell", paneContent: "PS C:\\> " }, "linux")).toBe(false);
  });
});

// The adapters classify for the host they run on, so these pins hold on Linux and macOS.
describe.skipIf(process.platform === "win32")("POSIX adapters keep the legacy shell set", () => {
  const binding = { id: "b1", nodeId: "n1", tmuxSession: "r01-impl", tmuxWindow: null, tmuxPane: null,
    cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: "/project" } as NodeBinding;

  it("a Claude resume that ends at tcsh times out instead of asking for a fresh retry", async () => {
    const tmux = {
      sendText: vi.fn(async () => ({ ok: true as const })),
      sendKeys: vi.fn(async () => ({ ok: true as const })),
      hasSession: vi.fn(async () => true),
      getPaneCommand: vi.fn(async () => "tcsh"),
      capturePaneContent: vi.fn(async () => "Error: Claude exited\nuser@example.test %"),
      createSession: vi.fn(async () => ({ ok: true as const })),
      killSession: vi.fn(async () => ({ ok: true as const })),
      listSessions: vi.fn(async () => []),
      listWindows: vi.fn(async () => []),
      listPanes: vi.fn(async () => []),
    } as unknown as TmuxAdapter;
    const fsOps = { readFile: () => { throw new Error("absent"); }, writeFile: () => {}, exists: () => false, mkdirp: () => {}, copyFile: () => {}, listFiles: () => [] } as ClaudeAdapterFsOps;
    const adapter = new ClaudeCodeAdapter({ tmux, fsOps, sleep: async () => {} });

    const result = await adapter.launchHarness(binding, { name: "dev-impl@test-rig", resumeToken: "abc-123" });

    expect(result).toEqual({ ok: false, error: "Claude resume did not finish within 30s; Claude may still be starting, so the launch was kept",
      evidence: "Error: Claude exited\nuser@example.test %", recovery: "attention_required" });
  });

  it("a legacy Claude resume at an idle tcsh pane keeps the launch for attention", async () => {
    const tmux = {
      sendText: vi.fn(async () => ({ ok: true as const })),
      sendKeys: vi.fn(async () => ({ ok: true as const })),
      getPaneCommand: async () => "tcsh",
      capturePaneContent: async () => "% ",
      getPanePid: async () => 4321,
      createSession: async () => ({ ok: true as const }),
      killSession: async () => ({ ok: true as const }),
      listSessions: async () => [],
      listWindows: async () => [],
      listPanes: async () => [],
      hasSession: async () => false,
    } as unknown as TmuxAdapter;
    const adapter = new ClaudeResumeAdapter(tmux, { pollMs: 0, maxWaitMs: 0, listProcesses: async () => [
      { pid: 4321, ppid: 1, pgid: 4321, tpgid: 4321, command: "-tcsh", executableName: "tcsh", startedAt: "Sat Jan  1 12:00:00 2000" },
    ] });

    expect(await adapter.resume("worker", "claude_id", "retained-history", "/repo"))
      .toMatchObject({ ok: false, code: "attention_required", message: expect.stringContaining("launch retained") });
  });

  it("a legacy Codex resume that ends at ksh times out instead of checking for an idle shell", async () => {
    const tmux = mockShellCommand({
      sendText: vi.fn(async () => ({ ok: true as const })),
      sendKeys: vi.fn(async () => ({ ok: true as const })),
      getPaneCommand: vi.fn(async () => "ksh"),
      capturePaneContent: vi.fn(async () => ""),
      createSession: async () => ({ ok: true as const }),
      killSession: async () => ({ ok: true as const }),
      listSessions: async () => [],
      listWindows: async () => [],
      listPanes: async () => [],
      hasSession: async () => false,
    } as unknown as TmuxAdapter);
    const listProcesses = vi.fn(() => []);
    const adapter = new CodexResumeAdapter(tmux, { pollMs: 1, maxWaitMs: 5, sleep: async () => {}, listProcesses });

    const result = await adapter.resume("r99-demo1-impl", "codex_id", "uuid-123", "/repo");

    expect(result).toMatchObject({ ok: false, code: "resume_failed" });
    if (!result.ok) expect(result.message).toContain("timed out");
    expect(listProcesses).not.toHaveBeenCalled();
  });

  it("Pi and stub seats with a ready sidecar stay ready at ksh", async () => {
    const tmux = { hasSession: async () => true, getPaneCommand: async () => "ksh", capturePaneContent: async () => "" } as unknown as TmuxAdapter;
    const fsOps = { exists: () => true, readFile: () => JSON.stringify({ ready: true, updatedAt: "t", sessionFile: "/session.jsonl" }), writeFile: () => {}, mkdirp: () => {} };
    for (const adapter of [
      new PiRuntimeAdapter({ tmux, fsOps, stateRoot: "/state", runnerEntryPath: "/runner" }),
      new StubRuntimeAdapter({ tmux, fsOps }),
    ]) expect(await adapter.checkReady(binding)).toEqual({ ready: true });
  });
});

describe("Windows legacy resume at the pane's own PowerShell", () => {
  it("a Claude resume at a proven idle PowerShell asks for a fresh retry", async () => {
    const powershell = "C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    const tmux = {
      sendText: vi.fn(async () => ({ ok: true as const })),
      sendKeys: vi.fn(async () => ({ ok: true as const })),
      getPaneCommand: async () => "powershell",
      capturePaneContent: async () => "PS C:\\work> ",
      getPanePid: async () => 4321,
      createSession: async () => ({ ok: true as const }),
      killSession: async () => ({ ok: true as const }),
      listSessions: async () => [],
      listWindows: async () => [],
      listPanes: async () => [],
      hasSession: async () => false,
    } as unknown as TmuxAdapter;
    const adapter = new ClaudeResumeAdapter(tmux, { pollMs: 0, maxWaitMs: 0, listProcesses: async () => [
      { platform: "win32", pid: 4321, ppid: 1, executableName: "powershell.exe", executablePath: powershell, command: `${powershell} -NoLogo`, startedAt: "2026-10-17T10:00:00.000Z" },
    ] });
    // The adapter classifies the pane's shell for the host platform.
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    try {
      expect(await adapter.resume("worker", "claude_id", "retained-history", "C:\\repo"))
        .toMatchObject({ ok: false, code: "retry_fresh", message: expect.stringContaining("returned to shell") });
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });
});
