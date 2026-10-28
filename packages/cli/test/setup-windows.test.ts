import { describe, expect, it, vi } from "vitest";
import { runSetup, type SetupDeps } from "../src/commands/setup.js";
import { runDoctorChecks, type DoctorDeps } from "../src/commands/doctor.js";
import { execSync } from "node:child_process";
import { WINDOWS_EXECUTION_POLICY_PROBE, WINDOWS_POWERSHELL_PROBE, powershellCommand, psmuxInstallCommand, psmuxUserPathCommand, wingetInstallCommand } from "../src/setup-platform.js";
import { powershellQuote } from "@openrig/daemon/windows-launch";

function dependencies(overrides: Partial<SetupDeps> = {}): SetupDeps {
  return {
    platform: "win32",
    env: { USERPROFILE: "C:\\Users\\A [test] O'Brien", LOCALAPPDATA: "C:\\Users\\A [test] O'Brien\\AppData\\Local" },
    exec: vi.fn((command: string) => command === "tmux -V" ? "tmux 3.4.0\npsmux 3.4.0" : "available"),
    readFile: () => null,
    writeFile: vi.fn(),
    exists: () => false,
    refreshPath: vi.fn(),
    ...overrides,
  };
}

function decode(command: string): string {
  return Buffer.from(command.split("-EncodedCommand ")[1]!, "base64").toString("utf16le");
}

describe("native Windows setup", () => {
  it("previews native requirements without executing or writing, preserving provider selection", async () => {
    const deps = dependencies();
    const result = await runSetup(deps, { dryRun: true, full: true, providers: ["codex"] });
    expect(deps.exec).not.toHaveBeenCalled();
    expect(deps.writeFile).not.toHaveBeenCalled();
    expect(result).toMatchObject({ platform: "win32", ready: false });
    expect(result.steps.map((step) => step.id).slice(0, 5)).toEqual(["node_version", "powershell", "git_install", "npm", "powershell_execution_policy"]);
    expect(result.steps.every((step) => step.status === "skipped")).toBe(true);
    const message = (id: string) => result.steps.find((step) => step.id === id)?.message;
    expect(message("tmux_install")).toContain("SHA256-verified portable psmux 3.4.0");
    expect(message("git_install")).toContain("winget Git.Git");
    expect(message("powershell_execution_policy")).toContain("never changed");
    expect(message("herdr_install")).toBe("Dry run: Check for native herdr (herdr --version) on PATH or in herdr's install folder; setup does not install herdr on Windows.");
    expect(message("claude_install")).toMatch(/^Not selected: the person chose Codex/);
    expect(message("claude_auth")).toMatch(/^Not selected/);
    expect(message("codex_install")).toBe("Dry run: codex_install would be attempted.");
  });

  it("previews the native Claude Code requirement when Claude is selected", async () => {
    const result = await runSetup(dependencies(), { dryRun: true, providers: ["claude"] });
    expect(result.steps.find((step) => step.id === "claude_install")?.message).toContain("claude.exe");
  });

  it("accepts Claude Code only as a claude.exe on PATH and never installs it with npm", async () => {
    const bin = "C:\\Users\\A [test] O'Brien\\.local\\bin";
    const deps = dependencies({
      env: { ...dependencies().env, Path: `C:\\Windows;${bin}` },
      exists: (file) => file === `${bin}\\claude.exe`,
    });
    const result = await runSetup(deps, { providers: ["claude"] });
    expect(result.steps.find((step) => step.id === "claude_install")).toMatchObject({ status: "pass", message: `Claude Code available (${bin}\\claude.exe).` });
    expect(result.steps.find((step) => step.id === "claude_auth")?.status).toBe("pass");
    const commands = vi.mocked(deps.exec).mock.calls.map(([command]) => command);
    expect(commands).toContain("claude auth status");
    expect(commands.some((command) => command.startsWith("npm install"))).toBe(false);
  });

  it("fails an npm claude.cmd launcher with the native installer hint, as the daemon would refuse it", async () => {
    const deps = dependencies({ env: { ...dependencies().env, PATH: "C:\\Users\\A\\AppData\\Roaming\\npm" } });
    const result = await runSetup(deps, { providers: ["claude"] });
    const install = result.steps.find((step) => step.id === "claude_install");
    expect(install).toMatchObject({ status: "fail", message: expect.stringContaining("npm's claude.cmd") });
    expect(install?.fixHint).toContain("irm https://claude.ai/install.ps1 | iex");
    expect(result.steps.find((step) => step.id === "claude_auth")?.status).toBe("skipped");
    expect(result.ready).toBe(false);
    expect(vi.mocked(deps.exec).mock.calls.some(([command]) => command.startsWith("npm install"))).toBe(false);
  });

  it("reports a missing claude.exe when no claude command exists at all", async () => {
    const deps = dependencies({ exec: vi.fn((command: string) => {
      if (command === "claude --version") throw new Error("not recognized");
      return command === "tmux -V" ? "tmux 3.4.0\npsmux 3.4.0" : "available";
    }) });
    const install = (await runSetup(deps, { providers: ["claude"] })).steps.find((step) => step.id === "claude_install");
    expect(install).toMatchObject({ status: "fail", message: "Native Claude Code (claude.exe) not found on PATH." });
  });

  it.each(["Restricted", "AllSigned"])("warns, without changing it, when the execution policy is %s", async (policy) => {
    const deps = dependencies({ exec: vi.fn((command: string) => command === WINDOWS_EXECUTION_POLICY_PROBE ? `${policy}\r\n`
      : command === "tmux -V" ? "tmux 3.4.0\npsmux 3.4.0" : "available") });
    const result = await runSetup(deps, { providers: ["codex"] });
    const step = result.steps.find((item) => item.id === "powershell_execution_policy");
    expect(step).toMatchObject({ status: "warn", message: expect.stringContaining(policy) });
    expect(step?.fixHint).toContain("Set-ExecutionPolicy -Scope CurrentUser RemoteSigned");
    expect(result.ready).toBe(true);
    expect(decode(WINDOWS_EXECUTION_POLICY_PROBE)).toContain("Remove-Item Env:PSExecutionPolicyPreference");
    expect(vi.mocked(deps.exec).mock.calls.some(([command]) => /Set-ExecutionPolicy/.test(command.includes("-EncodedCommand ") ? decode(command) : command))).toBe(false);
  });

  it("passes the RemoteSigned policy", async () => {
    const deps = dependencies({ exec: vi.fn((command: string) => command === WINDOWS_EXECUTION_POLICY_PROBE ? "RemoteSigned"
      : command === "tmux -V" ? "tmux 3.4.0\npsmux 3.4.0" : "available") });
    const result = await runSetup(deps, { providers: ["codex"] });
    expect(result.steps.find((item) => item.id === "powershell_execution_policy")?.status).toBe("pass");
  });

  it("reuses an earlier setup's psmux that this shell's PATH predates instead of refusing to overwrite it", async () => {
    let onPath = false;
    const managed = "C:\\Users\\A [test] O'Brien\\AppData\\Local\\OpenRig\\tools\\psmux-3.4.0";
    const deps = dependencies({
      exists: (file) => file === `${managed}\\tmux.exe`,
      refreshPath: vi.fn(() => { onPath = true; }),
      exec: vi.fn((command: string) => {
        if (command === "tmux -V" && !onPath) throw new Error("'tmux' is not recognized");
        return command === "tmux -V" ? "tmux 3.4.0\npsmux 3.4.0" : "available";
      }),
    });
    const result = await runSetup(deps, { providers: [] });
    expect(result.steps.find((step) => step.id === "tmux_install")).toMatchObject({ status: "applied", message: expect.stringContaining(managed) });
    const scripts = vi.mocked(deps.exec).mock.calls.map(([command]) => command).filter((command) => command.includes("-EncodedCommand ")).map(decode);
    expect(scripts.some((script) => script.includes("psmux.zip"))).toBe(false);
    const pathScript = scripts.find((script) => script.includes("SetValue('Path'"))!;
    expect(pathScript).toContain(`$destination = '${managed.replaceAll("'", "''")}'`);
    expect(pathScript).toContain("DoNotExpandEnvironmentNames");
    expect(pathScript).not.toContain("SetEnvironmentVariable('Path'");
    expect(deps.refreshPath).toHaveBeenCalledOnce();
    expect(result.ready).toBe(true);
  });

  it("keeps the user Path's registry type when installing psmux", () => {
    const script = decode(psmuxInstallCommand({ LOCALAPPDATA: "C:\\Users\\A\\AppData\\Local" }, "x64"));
    expect(script).toContain("GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)");
    expect(script).toContain("GetValueKind('Path')");
    expect(script).toContain("[Microsoft.Win32.RegistryValueKind]::ExpandString");
    expect(script).not.toContain("[Environment]::SetEnvironmentVariable('Path'");
    expect(script).not.toContain("[Environment]::GetEnvironmentVariable('Path', 'User')");
  });

  it("keeps existing psmux config and never runs POSIX or unsupported terminal commands", async () => {
    const config = "C:\\Users\\A [test] O'Brien\\.psmuxrc";
    const deps = dependencies({ readFile: (file) => file === config ? "set -g prefix C-a\n" : null });
    const result = await runSetup(deps, { providers: ["codex"] });
    expect(result.ready).toBe(true);
    expect(deps.writeFile).toHaveBeenCalledWith(config, expect.stringContaining("set -g prefix C-a\n"));
    expect(deps.writeFile).toHaveBeenCalledWith(config, expect.stringContaining("# OpenRig managed block"));
    const commands = vi.mocked(deps.exec).mock.calls.map(([command]) => command);
    expect(commands).toContain(WINDOWS_POWERSHELL_PROBE);
    expect(commands).toContain("npm --version");
    expect(commands.some((command) => /^(brew|curl|sh|bash|herdr|cmux|claude)\b/.test(command))).toBe(false);
  });

  it("installs a missing portable psmux and verifies control after refreshing PATH", async () => {
    let installed = false;
    const deps = dependencies({ exec: vi.fn((command: string) => {
      if (command === "tmux -V" && !installed) throw new Error("not found");
      if (command.startsWith("powershell.exe") && decode(command).includes("psmux.zip")) installed = true;
      return command === "tmux -V" ? "tmux 3.4.0\npsmux 3.4.0" : "available";
    }) });
    const result = await runSetup(deps, { providers: [] });
    expect(result.steps.find((s) => s.id === "tmux_install")?.status).toBe("applied");
    expect(deps.refreshPath).toHaveBeenCalledOnce();
    expect(vi.mocked(deps.exec).mock.calls.filter(([command]) => command === "tmux -V")).toHaveLength(2);
  });

  it("does not report installed when the installer cannot make tmux control available", async () => {
    const deps = dependencies({ exec: vi.fn((command: string) => {
      if (command === "tmux -V") throw new Error("tmux missing");
      return "available";
    }) });
    const result = await runSetup(deps, { providers: [] });
    expect(result.ready).toBe(false);
    expect(result.steps.find((s) => s.id === "tmux_install")?.status).toBe("fail");
  });

  it("provisions Git and full-profile tools with native winget and rechecks binaries", async () => {
    const installed = new Set<string>();
    const deps = dependencies({ exec: vi.fn((command: string) => {
      for (const [probe, id] of [["git --version", "Git.Git"], ["jq --version", "jqlang.jq"], ["gh --version", "GitHub.cli"]]) {
        if (command === wingetInstallCommand(id!)) installed.add(probe!);
        if (command === probe && !installed.has(probe)) throw new Error("missing");
      }
      return "available";
    }) });
    const result = await runSetup(deps, { full: true, providers: [] });
    expect(result.steps.filter((s) => ["git_install", "jq_install", "gh_install"].includes(s.id)).every((s) => s.status === "applied")).toBe(true);
    expect(deps.refreshPath).toHaveBeenCalledTimes(3);
  });

});

describe("Windows PowerShell literals", () => {
  // Windows PowerShell also ends a single-quoted literal at U+2018-U+201B.
  const quotes = ["'", "\u2018", "\u2019", "\u201a", "\u201b"];

  it("quotes a profile path with a typographic apostrophe in the psmux install and Path scripts", () => {
    const env = { LOCALAPPDATA: "C:\\Users\\O\u2019Brien\\AppData\\Local" };
    const destination = "$destination = 'C:\\Users\\O\u2019\u2019Brien\\AppData\\Local\\OpenRig\\tools\\psmux-3.4.0'";
    expect(decode(psmuxInstallCommand(env, "x64"))).toContain(destination);
    expect(decode(psmuxUserPathCommand(env))).toContain(destination);
  });

  it.runIf(process.platform === "win32")("round-trips every single quote through Windows PowerShell without running the text", () => {
    for (const value of [`C:\\Users\\O\u2019Brien ${quotes.join(" ")}`, "x\u2019; Write-Output INJECTED; \u2019"]) {
      const output = execSync(powershellCommand(`Write-Output ${powershellQuote(value)}`), { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      expect(output.replace(/\r?\n$/, "")).toBe(value);
    }
  });
});

describe("native Windows doctor", () => {
  it("reports native prerequisites and omits unsupported cmux probing", async () => {
    const exec = vi.fn((command: string) => {
      if (command === "tmux -V") throw new Error("missing");
      if (command === "git --version") throw new Error("missing");
      return "available";
    });
    const deps: DoctorDeps = {
      platform: "win32", exec, exists: () => true, readFile: () => null, baseDir: "C:\\rig\\dist",
      checkPort: async () => true, mkdirp: () => {}, checkWritable: () => {},
      configStore: { resolve: () => ({ daemon: { host: "127.0.0.1", port: 7433 }, db: { path: "C:\\rig\\state\\openrig.sqlite" }, transcripts: { enabled: true, path: "C:\\rig\\state\\transcripts" } }) },
    };
    const result = runDoctorChecks(deps, []);
    await Promise.all(result.asyncChecks);
    expect(result.checks.find((c) => c.name === "tmux")?.fix).toContain("portable psmux");
    expect(result.checks.find((c) => c.name === "git")?.fix).toContain("Git.Git");
    expect(result.checks.find((c) => c.name === "powershell")?.status).toBe("pass");
    expect(result.checks.find((c) => c.name === "cmux_shell")?.status).toBe("skipped");
    expect(exec.mock.calls.some(([command]) => command.startsWith("cmux"))).toBe(false);
    expect(result.checks.find((c) => c.name === "powershell_execution_policy")?.status).toBe("pass");
  });

  it("agrees with the daemon that only a claude.exe on PATH is Claude Code, and flags a Restricted policy", () => {
    const exec = vi.fn((command: string) => command === WINDOWS_EXECUTION_POLICY_PROBE ? "Restricted" : "available");
    const deps: DoctorDeps = {
      platform: "win32", env: { Path: "C:\\Users\\A\\AppData\\Roaming\\npm" }, exec, exists: (file) => !file.endsWith("claude.exe"),
      readFile: () => null, baseDir: "C:\\rig\\dist", checkPort: async () => true, mkdirp: () => {}, checkWritable: () => {},
      configStore: { resolve: () => ({ daemon: { host: "127.0.0.1", port: 7433 }, db: { path: "C:\\rig\\state\\openrig.sqlite" }, transcripts: { enabled: true, path: "C:\\rig\\state\\transcripts" } }) },
    };
    const { checks } = runDoctorChecks(deps);
    expect(checks.find((c) => c.name === "claude_install")).toMatchObject({ status: "fail", fix: expect.stringContaining("install.ps1") });
    expect(checks.find((c) => c.name === "claude_auth")?.status).toBe("skipped");
    expect(checks.find((c) => c.name === "codex_install")?.status).toBe("pass");
    expect(checks.find((c) => c.name === "powershell_execution_policy")).toMatchObject({ status: "warn", fix: expect.stringContaining("RemoteSigned") });
  });
});
