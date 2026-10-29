import { describe, expect, it, vi } from "vitest";
import { runSetup, type SetupDeps } from "../src/commands/setup.js";

function fixture(installed = false) {
  let present = installed;
  const exec = vi.fn((cmd: string, _opts?: { timeoutMs?: number }) => {
    if (cmd.endsWith("herdr --version") || cmd.endsWith("herdr' --version")) {
      if (!present) throw new Error("missing herdr");
      return "herdr 0.9.3";
    }
    if (cmd === "curl -fsSL https://herdr.dev/install.sh | sh") { present = true; return "installed"; }
    if (cmd === "tmux -V") return "tmux 3.4";
    return "available";
  });
  const deps: SetupDeps = { platform: "darwin", env: { HOME: "/fixture" }, exec, exists: () => false, readFile: () => null, writeFile: vi.fn(), mkdirp: vi.fn() };
  return { deps, exec };
}

describe("setup Herdr default", () => {
  it.each(["darwin", "linux"] as const)("installs and verifies missing Herdr on %s without opening a view", async platform => {
    const f = fixture(); f.deps.platform = platform;
    const result = await runSetup(f.deps, {});
    expect(result.steps).toContainEqual(expect.objectContaining({ id: "herdr_install", status: "applied" }));
    expect(f.exec).toHaveBeenCalledWith("curl -fsSL https://herdr.dev/install.sh | sh", { timeoutMs: 300_000 });
    expect(f.exec.mock.calls.some(([cmd]) => /osascript|open -a|cmux|terminal open/.test(cmd))).toBe(false);
    expect(vi.mocked(f.deps.writeFile).mock.calls.some(([file]) => file.includes("cmux"))).toBe(false);
  });
  it("reuses an installed binary without installing again", async () => {
    const f = fixture(true);
    const result = await runSetup(f.deps, {});
    expect(result.steps).toContainEqual(expect.objectContaining({ id: "herdr_install", status: "pass" }));
    expect(f.exec.mock.calls.some(([cmd]) => cmd.includes("herdr.dev/install"))).toBe(false);
  });
  it("honors decline in both real and dry-run modes without any Herdr probe", async () => {
    for (const dryRun of [false, true]) {
      const f = fixture();
      const result = await runSetup(f.deps, { herdr: false, dryRun });
      expect(result.steps).toContainEqual(expect.objectContaining({ id: "herdr_install", status: "skipped", message: expect.stringContaining("declined") }));
      expect(f.exec.mock.calls.some(([cmd]) => cmd.includes("herdr"))).toBe(false);
    }
  });
  it.each([
    ["darwin", "install"], ["linux", "install"],
    ["darwin", "verification"], ["linux", "verification"],
  ] as const)("keeps setup ready after optional Herdr failure on %s during %s", async (platform, failure) => {
    const f = fixture();
    f.deps.platform = platform;
    const original = f.deps.exec;
    f.deps.exec = (cmd, opts) => {
      if (cmd.includes("herdr.dev/install")) {
        if (failure === "install") throw new Error("install timeout");
        return "installer returned without a usable binary";
      }
      return original(cmd, opts);
    };
    const result = await runSetup(f.deps, {});
    expect(result.ready).toBe(true);
    expect(result.steps).toContainEqual(expect.objectContaining({
      id: "herdr_install", status: "warn",
      message: expect.stringContaining(failure === "install" ? "install timeout" : "could not be verified"),
      reason: expect.stringContaining("plain tmux"), fixHint: expect.stringContaining("herdr.dev"),
    }));
    expect(result.steps).toContainEqual(expect.objectContaining({ id: "claude_auth", status: "pass" }));
  });
});

describe("setup Herdr on native Windows", () => {
  const profile = "C:\\Users\\A [test] O'Brien";
  const current = `${profile}\\.herdr\\packages\\standalone\\current\\herdr.exe`;
  function windows(installed: string[] = [], version = "herdr 0.9.3\r\n") {
    const decode = (cmd: string) => cmd.includes("-EncodedCommand ") ? Buffer.from(cmd.split("-EncodedCommand ")[1]!, "base64").toString("utf16le") : "";
    const exec = vi.fn((cmd: string, _opts?: { timeoutMs?: number }) => {
      if (cmd === "tmux -V") return "tmux 3.4.0\npsmux 3.4.0";
      if (decode(cmd).includes("--version") && installed.some(file => decode(cmd).includes(`& '${file.replaceAll("'", "''")}' --version`))) return version;
      return "available";
    });
    const deps: SetupDeps = {
      platform: "win32", env: { USERPROFILE: profile, LOCALAPPDATA: `${profile}\\AppData\\Local`, Path: "C:\\Windows;C:\\tools" },
      exec, exists: file => installed.includes(file), readFile: () => null, writeFile: vi.fn(), mkdirp: vi.fn(), refreshPath: vi.fn(),
    };
    return { deps, exec, decode };
  }
  const step = (result: Awaited<ReturnType<typeof runSetup>>) => result.steps.find(s => s.id === "herdr_install");

  it.each([["on PATH", "C:\\tools\\herdr.exe"], ["in herdr's current release", current]])("reports herdr %s with its version, without installing it", async (_where, file) => {
    const f = windows([file]);
    const result = await runSetup(f.deps, { providers: ["codex"] });
    expect(step(result)).toEqual({ id: "herdr_install", status: "pass", message: `Found herdr 0.9.3 (${file}). Setup does not install or update herdr on Windows. No terminal or view was opened.` });
    const herdrCommands = f.exec.mock.calls.map(([cmd]) => cmd).filter(cmd => f.decode(cmd).includes("herdr"));
    // Run by path through an encoded PowerShell command: cmd.exe never sees the profile path.
    expect(herdrCommands.every(cmd => cmd.startsWith("powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand "))).toBe(true);
    expect(f.exec.mock.calls.some(([cmd]) => /herdr\.dev\/install|^curl|^herdr\b|irm /.test(cmd))).toBe(false);
  });
  it("prints herdr's official Windows install command when it is absent, and stays ready", async () => {
    const f = windows();
    const result = await runSetup(f.deps, { providers: ["codex"] });
    expect(step(result)).toEqual({
      id: "herdr_install", status: "skipped",
      message: "herdr not found. Setup does not install herdr on Windows; the OpenRig view opens in Windows Terminal with psmux.",
      fixHint: "To use herdr for the view, install it with `powershell -ExecutionPolicy Bypass -c \"irm https://herdr.dev/install.ps1 | iex\"` (https://herdr.dev/docs/windows-beta/), then reopen your terminal.",
    });
    expect(result.ready).toBe(true);
    expect(f.exec.mock.calls.some(([cmd]) => f.decode(cmd).includes("herdr"))).toBe(false);
  });
  it("skips a copy whose --version prints no version and keeps looking", async () => {
    const f = windows(["C:\\tools\\herdr.exe", current]);
    f.deps.exec = vi.fn((cmd: string) => f.decode(cmd).includes("C:\\tools\\herdr.exe") ? "not herdr" : f.exec(cmd));
    expect(step(await runSetup(f.deps, { providers: ["codex"] }))).toMatchObject({ status: "pass", message: expect.stringContaining(current) });
  });
  it("honors --no-herdr without probing for herdr", async () => {
    for (const dryRun of [false, true]) {
      const f = windows([current]);
      expect(step(await runSetup(f.deps, { herdr: false, dryRun, providers: ["codex"] }))).toMatchObject({ status: "skipped", message: expect.stringContaining("declined") });
      expect(f.exec.mock.calls.some(([cmd]) => f.decode(cmd).includes("herdr"))).toBe(false);
    }
  });
});


describe("setup Ghostty offer", () => {
  it("offers once without installing, and installs only after the accepted choice", async () => {
    const f = fixture(true);
    let installed = false;
    f.deps.exists = file => installed && file === "/Applications/Ghostty.app";
    const original = f.deps.exec;
    f.deps.exec = vi.fn((cmd, opts) => {
      if (cmd === "brew install --cask ghostty") installed = true;
      return original(cmd, opts);
    });
    const offered = await runSetup(f.deps, {});
    expect(offered.steps).toContainEqual(expect.objectContaining({ id: "ghostty_install", status: "skipped", message: expect.stringContaining("ask once") }));
    expect(f.deps.exec).not.toHaveBeenCalledWith("brew install --cask ghostty", expect.anything());
    const accepted = await runSetup(f.deps, { ghostty: true });
    expect(accepted.steps).toContainEqual(expect.objectContaining({ id: "ghostty_install", status: "applied" }));
    expect(f.deps.exec).toHaveBeenCalledWith("brew install --cask ghostty", { timeoutMs: 300_000 });
    const existing = await runSetup(f.deps, {});
    expect(existing.steps).toContainEqual(expect.objectContaining({ id: "ghostty_install", status: "pass" }));
    expect(vi.mocked(f.deps.exec).mock.calls.filter(([cmd]) => cmd.includes("--cask ghostty"))).toHaveLength(1);
  });

  it.each(["declined", "dry-run", "linux"])("does not install or launch Ghostty for %s", async mode => {
    const f = fixture(true);
    if (mode === "linux") f.deps.platform = "linux";
    const result = await runSetup(f.deps, { ghostty: mode !== "declined", dryRun: mode === "dry-run" });
    expect(result.steps).toContainEqual(expect.objectContaining({ id: "ghostty_install", status: "skipped" }));
    expect(f.exec.mock.calls.some(([cmd]) => /ghostty|osascript|open -a/.test(cmd))).toBe(false);
  });

  it("does not report an unverified installation as successful", async () => {
    const f = fixture(true);
    const result = await runSetup(f.deps, { ghostty: true });
    expect(result.ready).toBe(false);
    expect(result.steps).toContainEqual(expect.objectContaining({ id: "ghostty_install", status: "fail", message: expect.stringContaining("was not found") }));
  });
});
