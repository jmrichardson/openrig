// Native Windows `rig terminal open --window` with herdr: a herdr client in a new Windows Terminal
// window, the current herdr session from inside a herdr pane, or (without herdr, or with --provider
// tmux) the Windows Terminal + psmux view. Platform is injected, so every OS runs these.
import { describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "../src/client.js";
import { openTerminalWindow, type WindowDeps } from "../src/terminal-window.js";

const q = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
const PROFILE = "C:\\Users\\Jürgen O'Brien";
const HERDR = `${PROFILE}\\.herdr\\packages\\standalone\\current\\herdr.exe`;
const TMUX = "C:\\psmux\\tmux.exe";
const SOCKET = `${PROFILE}\\AppData\\Roaming\\herdr\\herdr.sock`;
const SCRIPT = `${PROFILE}\\AppData\\Local\\Temp\\openrig-windows-terminal\\openrig-wt-0123.ps1`;
const planId = "0123456789abcdef".repeat(4);
const tabLabel = `openrig:rig:rig#${planId.slice(0, 16)}#l1`;

function fixture(opts: { herdr?: boolean; env?: NodeJS.ProcessEnv; tabs?: Array<{ workspace_id: string; tab_id: string; label: string }>; clients?: string } = {}) {
  const panes = [
    { seat: "a@rig", label: "a", paneCommand: `${q(TMUX)} attach -t ${q("a@rig")}` },
    { seat: "b@rig", label: "b", paneCommand: `${q(TMUX)} attach -r -t ${q("b@rig")}` },
  ];
  const composed = { id: "rig:rig", opened: panes, pages: [panes], absent: [], degraded: [] };
  const get = vi.fn(async (url: string) => ({ status: 200, data: url.includes("preview")
    ? { planId, composed, status: { launch: { socketPath: SOCKET } } }
    : { providers: [{ liveness: { alive: true } }] } }));
  const post = vi.fn(async () => ({ status: 200, data: { provider: "herdr", ok: true, opened: panes.map(p => p.seat), absent: [], degraded: [], pages: 1 } }));
  const tabs = opts.tabs ?? [];
  const herdrCalls: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = [];
  const reply = (args: string[]) => {
    const [noun, verb, , id] = args;
    if (noun === "workspace") return { result: { workspaces: [...new Set(tabs.map(tab => tab.workspace_id))].map(workspace_id => ({ workspace_id, label: "rig" })) } };
    if (noun === "tab" && verb === "list") return { result: { tabs: tabs.filter(tab => tab.workspace_id === id) } };
    if (noun === "tab" && verb === "focus") return { result: { tab: tabs.find(tab => tab.tab_id === args[2]) } };
    if (noun === "pane" && verb === "list") return { result: { panes: tabs.filter(tab => tab.workspace_id === id).flatMap(tab => panes.map((_, i) => ({ workspace_id: id, tab_id: tab.tab_id, pane_id: `${tab.tab_id}:p${i}` }))) } };
    if (noun === "pane" && verb === "process-info") return { result: { process_info: { pane_id: id, foreground_processes: [{ pid: 201 + Number(id!.at(-1)) }] } } };
    throw new Error(`Unexpected herdr call: ${args.join(" ")}`);
  };
  const exec = vi.fn(async (file: string, args: string[], _timeoutMs?: number, env?: NodeJS.ProcessEnv) => {
    if (file === "where.exe") return `${PROFILE}\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe\r\n`;
    if (file === "powershell.exe") return "1\r\n";
    if (file === HERDR && args[0] === "--version") return "herdr 0.9.3\r\n";
    if (file === HERDR) { herdrCalls.push({ args, env }); return JSON.stringify(reply(args)); }
    if (file === TMUX) return opts.clients ?? "";
    throw new Error(`Unexpected command: ${file} ${args.join(" ")}`);
  });
  const launch = vi.fn(async () => {});
  const scripts: string[] = [];
  const deps: WindowDeps = {
    platform: "win32",
    env: opts.env ?? { Path: "C:\\Windows\\System32;C:\\psmux", USERPROFILE: PROFILE, APPDATA: `${PROFILE}\\AppData\\Roaming`, PSMUX_DATA_DIR: "D:\\psmux data", OPENRIG_URL: "http://127.0.0.1:7433", HERDR_SESSION: "personal" },
    exists: file => (opts.herdr !== false && file === HERDR) || file === TMUX,
    exec, launch, sleep: async () => {}, id: () => "owned",
    herdrConfig: vi.fn((_socket: string, columns?: number) => `${PROFILE}\\AppData\\Roaming\\herdr\\.openrig-herdr-${columns ? "wide" : "narrow"}.toml`),
    windowsScript: vi.fn((content: string) => { scripts.push(content); return SCRIPT; }),
  };
  const client = { baseUrl: "http://127.0.0.1:7433", get, post } as unknown as DaemonClient;
  return { deps, client, exec, launch, post, scripts, herdrCalls };
}
const decode = (arg: string) => Buffer.from(arg, "base64").toString("utf16le");
const noPosixTools = (exec: ReturnType<typeof fixture>["exec"]) =>
  expect(exec.mock.calls.some(([file]) => file === "/bin/sh" || file === "/usr/bin/env" || file.startsWith("/"))).toBe(false);

describe("Windows herdr window", () => {
  it("opens a herdr client on the daemon's endpoint in a new Windows Terminal window, then places the view", async () => {
    const f = fixture();
    const result = await openTerminalWindow(f.client, "rig", undefined, f.deps, planId);
    expect(result.error).toBeUndefined();
    expect(result).toMatchObject({ provider: "herdr", ok: true, opened: ["a@rig", "b@rig"], window: { app: "Windows Terminal", surface: "window-requested" } });
    expect(f.launch).toHaveBeenCalledOnce();
    const [binary, args] = f.launch.mock.calls[0]! as unknown as [string, string[]];
    expect(binary).toBe("wt.exe");
    expect(args.slice(0, -1)).toEqual(["--window", "new", "new-tab", "--title", "Herdr", "powershell.exe", "-NoLogo", "-NoProfile", "-EncodedCommand"]);
    expect(decode(args.at(-1)!)).toBe(`& ([scriptblock]::Create([IO.File]::ReadAllText('${SCRIPT.replaceAll("'", "''")}')))`);
    expect(f.scripts).toHaveLength(1);
    expect(f.scripts[0]!.split("\n")).toEqual([
      "[Environment]::SetEnvironmentVariable('PATH', 'C:\\Windows\\System32;C:\\psmux', 'Process')",
      `[Environment]::SetEnvironmentVariable('USERPROFILE', '${PROFILE.replaceAll("'", "''")}', 'Process')`,
      `[Environment]::SetEnvironmentVariable('APPDATA', '${PROFILE.replaceAll("'", "''")}\\AppData\\Roaming', 'Process')`,
      "[Environment]::SetEnvironmentVariable('PSMUX_DATA_DIR', 'D:\\psmux data', 'Process')",
      "[Environment]::SetEnvironmentVariable('OPENRIG_URL', 'http://127.0.0.1:7433', 'Process')",
      "Remove-Item Env:TMUX, Env:PSMUX_SESSION, Env:PSMUX_TARGET_SESSION, Env:HERDR_SESSION -ErrorAction SilentlyContinue",
      `$env:HERDR_SOCKET_PATH = '${SOCKET.replaceAll("'", "''")}'`,
      // The private config follows the new window's width, as the POSIX launch reads stty.
      `$env:HERDR_CONFIG_PATH = if ($Host.UI.RawUI.WindowSize.Width -ge 160) { '${PROFILE.replaceAll("'", "''")}\\AppData\\Roaming\\herdr\\.openrig-herdr-wide.toml' } else { '${PROFILE.replaceAll("'", "''")}\\AppData\\Roaming\\herdr\\.openrig-herdr-narrow.toml' }`,
      `& '${HERDR.replaceAll("'", "''")}'`,
      "",
    ]);
    // Herdr's CLI runs directly, on the daemon's endpoint, without the caller's own session.
    expect(f.herdrCalls.map(call => call.args)).toEqual([["workspace", "list"]]);
    expect(f.herdrCalls[0]!.env).toMatchObject({ HERDR_SOCKET_PATH: SOCKET, PSMUX_DATA_DIR: "D:\\psmux data" });
    expect(f.herdrCalls[0]!.env).not.toHaveProperty("HERDR_SESSION");
    expect(f.post).toHaveBeenCalledExactlyOnceWith("/api/terminal/open", { view: "rig", provider: "herdr", expectedPlan: planId }, { timeoutMs: 45_000 });
    expect(result.notes).toEqual(expect.arrayContaining([expect.stringContaining("new Windows Terminal window running Herdr"), expect.stringContaining("not visual confirmation")]));
    noPosixTools(f.exec);
  });

  it("reuses a workspace whose panes psmux confirms are attached, after opening the client", async () => {
    const f = fixture({ tabs: [{ workspace_id: "w1", tab_id: "w1:t2", label: tabLabel }], clients: "201\ta@rig\t0\n202\tb@rig\t1\n" });
    const result = await openTerminalWindow(f.client, "rig", undefined, f.deps);
    expect(result).toMatchObject({ ok: true, reusedWorkspace: { id: "w1", tabId: "w1:t2", view: "rig:rig" } });
    expect(f.post).not.toHaveBeenCalled();
    expect(f.herdrCalls.map(call => call.args)).toEqual([
      ["workspace", "list"], ["tab", "list", "--workspace", "w1"], ["pane", "list", "--workspace", "w1"],
      ["pane", "process-info", "--pane", "w1:t2:p0"], ["pane", "process-info", "--pane", "w1:t2:p1"], ["tab", "focus", "w1:t2"],
    ]);
    expect(f.exec).toHaveBeenCalledWith(TMUX, ["list-clients", "-F", "#{client_pid}\t#{session_name}\t#{client_readonly}"]);
    noPosixTools(f.exec);
  });

  it("does not reuse a workspace whose read-only attachment differs; it opens a fresh one", async () => {
    const f = fixture({ tabs: [{ workspace_id: "w1", tab_id: "w1:t2", label: tabLabel }], clients: "201\ta@rig\t0\n202\tb@rig\t0\n" });
    const result = await openTerminalWindow(f.client, "rig", undefined, f.deps);
    expect(result.reusedWorkspace).toBeUndefined();
    expect(f.post).toHaveBeenCalledOnce();
    expect(result.notes?.join(" ")).toContain("Could not confirm live attachments in workspace w1");
  });

  it("inside a herdr pane on the daemon's session, places the view there without a new window", async () => {
    const env = { TERM_PROGRAM: "herdr", HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_SESSION: "s", HERDR_SOCKET_PATH: SOCKET.toUpperCase(), USERPROFILE: PROFILE, Path: "C:\\psmux" };
    const f = fixture({ env });
    const result = await openTerminalWindow(f.client, "rig", undefined, f.deps);
    expect(result).toMatchObject({ provider: "herdr", ok: true, opened: ["a@rig", "b@rig"] });
    expect(result.window).toBeUndefined();
    expect(f.launch).not.toHaveBeenCalled();
    expect(f.deps.herdrConfig).not.toHaveBeenCalled();
    expect(f.post).toHaveBeenCalledOnce();
    expect(result.notes).toEqual(expect.arrayContaining(["Using the current Herdr session; no terminal window or personal config was changed."]));
    expect(f.herdrCalls.length).toBeGreaterThan(0);
    for (const call of f.herdrCalls) {
      expect(call.env).toMatchObject({ HERDR_SOCKET_PATH: SOCKET });
      expect(call.env).not.toHaveProperty("HERDR_SESSION");
    }
    noPosixTools(f.exec);
  });

  it("inside a herdr pane of another session, opens nothing there", async () => {
    const env = { TERM_PROGRAM: "herdr", HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: `${PROFILE}\\AppData\\Roaming\\herdr\\sessions\\other\\herdr.sock`, USERPROFILE: PROFILE };
    const f = fixture({ env });
    const result = await openTerminalWindow(f.client, "rig", undefined, f.deps);
    expect(result).toMatchObject({ ok: false, windowAttempted: false, error: expect.stringContaining("differs from the selected endpoint") });
    expect(f.launch).not.toHaveBeenCalled();
    expect(f.post).not.toHaveBeenCalled();
  });

  it("without a desktop to open on, gives the PowerShell command that starts herdr on the daemon's endpoint", async () => {
    const f = fixture({ env: { CI: "true", USERPROFILE: PROFILE, Path: "C:\\psmux" } });
    const result = await openTerminalWindow(f.client, "rig", undefined, f.deps);
    expect(result).toMatchObject({ ok: false, windowAttempted: false });
    expect(result.error).toContain(`and run: Remove-Item Env:TMUX, Env:PSMUX_SESSION, Env:PSMUX_TARGET_SESSION, Env:HERDR_SESSION -ErrorAction SilentlyContinue; $env:HERDR_SOCKET_PATH = '${SOCKET.replaceAll("'", "''")}'; `);
    expect(result.error).toContain(`; & '${HERDR.replaceAll("'", "''")}'`);
    expect(result.error).not.toContain("env -u");
    expect(f.launch).not.toHaveBeenCalled();
  });
});

describe("Windows Terminal + psmux remains the view without herdr", () => {
  it("opens the psmux view when herdr is not installed", async () => {
    const f = fixture({ herdr: false });
    const result = await openTerminalWindow(f.client, "rig", undefined, f.deps);
    expect(result).toMatchObject({ provider: "tmux", ok: true, window: { app: "Windows Terminal" } });
    const [, args] = f.launch.mock.calls[0]! as unknown as [string, string[]];
    expect(args.filter(arg => arg === "split-pane")).toHaveLength(1);
    // A tab started from a psmux pane drops its markers; psmux refuses a nested attach otherwise.
    expect(f.scripts[0]).toContain("\nRemove-Item Env:TMUX, Env:PSMUX_SESSION, Env:PSMUX_TARGET_SESSION -ErrorAction SilentlyContinue\n");
    expect(f.herdrCalls).toEqual([]);
  });
  it("keeps --provider tmux on the psmux view and never runs herdr", async () => {
    const f = fixture();
    expect(await openTerminalWindow(f.client, "rig", "tmux", f.deps)).toMatchObject({ provider: "tmux", ok: true });
    expect(f.exec.mock.calls.some(([file]) => file === HERDR)).toBe(false);
  });
  it("refuses --provider herdr when herdr is not installed, without opening anything", async () => {
    const f = fixture({ herdr: false });
    const result = await openTerminalWindow(f.client, "rig", "herdr", f.deps);
    expect(result).toMatchObject({ provider: "herdr", ok: false, error: expect.stringContaining("Herdr is not installed") });
    expect(f.launch).not.toHaveBeenCalled();
  });
  it("does not accept a herdr whose --version prints no version", async () => {
    const f = fixture();
    f.exec.mockImplementation(async (file: string) => file === "where.exe" ? "C:\\wt.exe\r\n" : "1\r\n");
    expect(await openTerminalWindow(f.client, "rig", undefined, f.deps)).toMatchObject({ provider: "tmux", ok: true });
  });
});
