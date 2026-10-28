import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DaemonClient } from "../src/client.js";

// Lets a test interpose on the script's rename, as a concurrent open would.
const fsHooks = vi.hoisted(() => ({ beforeRename: undefined as ((from: string, to: string) => void) | undefined }));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, renameSync: (from: string, to: string) => { fsHooks.beforeRename?.(from, to); fs.renameSync(from, to); } };
});
const { openTerminalWindow, prepareWindowsTerminalScript } = await import("../src/terminal-window.js");
type WindowDeps = import("../src/terminal-window.js").WindowDeps;
// Exact literal quoting used by daemon domain/terminal/view-composer.ts.
const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
const SCRIPT = "C:\\Users\\Jürgen\\AppData\\Local\\Temp\\openrig-windows-terminal\\openrig-wt-0123.ps1";

function fixture(panes = [
  { seat: "local", label: "中文; unsafe-title", paneCommand: `${shellQuote("C:\\Program Files\\psmux\\tmux.exe")} attach -r -t ${shellQuote("seat'one")}` },
  { seat: "remote", label: "remote", paneCommand: `ssh ${shellQuote("user@host")} ${shellQuote("tmux attach -t 'remote'")}` },
], pages: typeof panes[] = panes.map(pane => [pane])) {
  const get = vi.fn(async () => ({ status: 200, data: { planId: "current", composed: { id: "saved", opened: panes, pages, absent: [], degraded: [] }, status: {} } }));
  const launch = vi.fn(async () => {});
  const scripts: string[] = [];
  const deps: WindowDeps = {
    platform: "win32", env: {}, exists: () => true,
    exec: vi.fn(async (file) => file === "where.exe" ? "C:\\Users\\user\\wt.exe\r\n" : "1\r\n"),
    launch, sleep: async () => {}, id: () => "owned", herdrConfig: () => { throw new Error("No Herdr config should be written"); },
    windowsScript: vi.fn((content: string) => { scripts.push(content); return SCRIPT; }),
  };
  const client = { baseUrl: "http://127.0.0.1:7433", get } as unknown as DaemonClient;
  return { panes, get, launch, deps, client, scripts };
}
function launched(f: ReturnType<typeof fixture>): { binary: string; args: string[]; stubs: string[] } {
  const [binary, args] = f.launch.mock.calls[0]! as unknown as [string, string[]];
  const stubs = args.flatMap((arg, i) => arg === "-EncodedCommand" ? [Buffer.from(args[i + 1]!, "base64").toString("utf16le")] : []);
  return { binary, args, stubs };
}
// CreateProcess limit, with the worst-case quoting of each argument.
const commandLineLength = (binary: string, args: string[]) => args.reduce((n, arg) => n + arg.length + 3 + (arg.match(/["\\]/g)?.length ?? 0), binary.length);

describe("Windows desktop terminal view", () => {
  it("opens the composed pages in a new Windows Terminal without a Unix shell or source mutations", async () => {
    const f = fixture();
    const result = await openTerminalWindow(f.client, "saved:中文", undefined, f.deps, "current");
    expect(result.error).toBeUndefined();
    expect(result).toMatchObject({ ok: true, provider: "tmux", pages: 2, opened: ["local", "remote"], window: { app: "Windows Terminal" } });
    expect(f.launch).toHaveBeenCalledOnce();
    const { binary, args, stubs } = launched(f);
    // Bare name: where.exe prints its path in the console code page, which mangles a non-ASCII profile.
    expect(binary).toBe("wt.exe");
    expect(args.slice(0, 2)).toEqual(["--window", "new"]);
    expect(args.filter(arg => arg === "new-tab")).toHaveLength(2);
    expect(args).toContain("中文  unsafe-title");
    const quotedScript = SCRIPT.replaceAll("'", "''");
    expect(stubs).toEqual([0, 1].map(index => `& ([scriptblock]::Create([IO.File]::ReadAllText('${quotedScript}'))) ${index}`));
    expect(f.scripts).toHaveLength(1);
    const [script] = f.scripts as [string];
    expect(script.startsWith("param([int]$openrigPane)\n")).toBe(true);
    // psmux refuses a nested attach while PSMUX_SESSION is set, so a tab started from a psmux pane drops its markers.
    expect(script).toContain("Remove-Item Env:TMUX, Env:PSMUX_SESSION, Env:PSMUX_TARGET_SESSION -ErrorAction SilentlyContinue");
    const [, first, second] = script.split(/\n(?=\d+ \{\n)/);
    expect(first).toMatch(/^0 \{\n/);
    expect(first).toContain("$openrigStart.FileName = 'C:\\Program Files\\psmux\\tmux.exe'");
    expect(first).toContain('$openrigStart.Arguments = \'"attach" "-r" "-t" "seat\'\'one"\'');
    expect(second).toMatch(/^1 \{\n/);
    expect(second).toContain("$openrigStart.FileName = 'ssh'");
    expect(f.deps.exec).not.toHaveBeenCalledWith("/bin/sh", expect.anything());
    expect(result.notes?.join(" ")).toContain("not visual confirmation");
  });
  it("still launches by the bare name when where.exe mangles a non-ASCII profile path", async () => {
    const f = fixture();
    f.deps.exec = vi.fn(async (file: string) => file === "where.exe" ? "C:\\Users\\J\uFFFDrgen-?\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe\r\n" : "1\r\n");
    expect(await openTerminalWindow(f.client, "saved", "tmux", f.deps)).toMatchObject({ ok: true });
    expect(launched(f).binary).toBe("wt.exe");
  });
  it("gives a cold Windows PowerShell the default time to confirm the desktop session", async () => {
    const f = fixture();
    await openTerminalWindow(f.client, "saved", "tmux", f.deps);
    const probe = vi.mocked(f.deps.exec).mock.calls.find(([file]) => file === "powershell.exe")!;
    expect(probe[2]).toBeUndefined();
  });
  it.each([["Path"], ["PATH"]])("pins the caller's PATH spelled %s, so panes find this psmux", async (name) => {
    const f = fixture();
    f.deps.env = { [name]: "C:\\psmux;C:\\Windows", USERPROFILE: "C:\\Users\\O'Brien", OPENRIG_URL: "http://127.0.0.1:7433" };
    await openTerminalWindow(f.client, "saved", "tmux", f.deps);
    const [script] = f.scripts as [string];
    expect(script).toContain("[Environment]::SetEnvironmentVariable('PATH', 'C:\\psmux;C:\\Windows', 'Process')");
    expect(script).toContain("[Environment]::SetEnvironmentVariable('USERPROFILE', 'C:\\Users\\O''Brien', 'Process')");
    expect(script).toContain("[Environment]::SetEnvironmentVariable('OPENRIG_URL', 'http://127.0.0.1:7433', 'Process')");
  });
  it("keeps a sixteen-pane view with a long PATH within one Windows command line, each pane naming its own entry", async () => {
    const panes = Array.from({ length: 16 }, (_, i) => ({ seat: `seat${i}`, label: `Seat ${i}`, paneCommand: `${shellQuote("C:\\Program Files\\psmux\\tmux.exe")} -L ${shellQuote("openrig-7433")} attach -t ${shellQuote(`seat-${i}@rig`)}` }));
    const f = fixture(panes, [panes]);
    f.deps.env = { Path: Array.from({ length: 60 }, (_, i) => `C:\\Program Files\\Vendor Tool ${i}\\bin`).join(";"), USERPROFILE: "C:\\Users\\user", APPDATA: "C:\\Users\\user\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\user\\AppData\\Local" };
    expect(f.deps.env["Path"]!.length).toBeGreaterThan(2_000);
    expect(await openTerminalWindow(f.client, "rig:big", "tmux", f.deps)).toMatchObject({ ok: true, opened: panes.map(pane => pane.seat) });
    const { binary, args, stubs } = launched(f);
    expect(commandLineLength(binary, args)).toBeLessThan(32_767);
    expect(stubs.map(stub => Number(stub.split(" ").at(-1)))).toEqual(Array.from({ length: 16 }, (_, i) => i));
    const [script] = f.scripts as [string];
    expect(script.match(/SetEnvironmentVariable\('PATH'/g)).toHaveLength(1);
    for (let i = 0; i < 16; i++) expect(script).toContain(`"seat-${i}@rig"`);
  });
  it("refuses, before launching anything, a view too large for one Windows command line", async () => {
    const panes = Array.from({ length: 160 }, (_, i) => ({ seat: `seat${i}`, label: `Seat ${i} ${"x".repeat(80)}`, paneCommand: `tmux attach -t ${shellQuote(`seat-${i}`)}` }));
    const f = fixture(panes, Array.from({ length: 10 }, (_, page) => panes.slice(page * 16, page * 16 + 16)));
    expect(await openTerminalWindow(f.client, "rig:huge", "tmux", f.deps)).toMatchObject({ ok: false, windowAttempted: false, error: expect.stringContaining("too large") });
    expect(f.launch).not.toHaveBeenCalled();
  });
  it.each([{ CI: "true" }, { SSH_TTY: "remote" }])("opens nothing in a background/remote caller %j", async (env) => {
    const f = fixture(); f.deps.env = env;
    expect(await openTerminalWindow(f.client, "saved", undefined, f.deps)).toMatchObject({ ok: false, windowAttempted: false });
    expect(f.launch).not.toHaveBeenCalled();
    expect(f.get).not.toHaveBeenCalled();
  });
  it("rejects a stale expected plan before launching", async () => {
    const f = fixture();
    expect(await openTerminalWindow(f.client, "saved", "tmux", f.deps, "old")).toMatchObject({ ok: false, windowAttempted: false });
    expect(f.launch).not.toHaveBeenCalled();
  });
  it("does not evaluate expanded pane commands", async () => {
    const f = fixture(); f.panes[0]!.paneCommand = "$(whoami)";
    expect(await openTerminalWindow(f.client, "saved", "tmux", f.deps)).toMatchObject({ ok: false, windowAttempted: false });
    expect(f.launch).not.toHaveBeenCalled();
    expect(f.deps.windowsScript).not.toHaveBeenCalled();
  });
  it("does not retry a launch whose outcome is unknown", async () => {
    const f = fixture(); f.launch.mockRejectedValue(new Error("uncertain"));
    expect(await openTerminalWindow(f.client, "saved", "tmux", f.deps)).toMatchObject({ ok: false, windowAttempted: true });
    expect(f.launch).toHaveBeenCalledOnce();
  });
});

/** A Windows Terminal pane tree: a pane, or a split whose second child is the pane split-pane created. */
type WtNode = { title?: string; direction?: string; size?: number; first?: WtNode; second?: WtNode };

/** The wt.exe subcommands after `--window new`, split at Windows Terminal's `;` separator. */
function wtCommands(args: string[]): string[][] {
  const commands: string[][] = [[]];
  for (const arg of args.slice(2)) {
    if (arg === ";") commands.push([]);
    else commands.at(-1)!.push(arg);
  }
  return commands;
}

/** The layout sequence: each tab's first pane, each focus as its count of nextInOrder steps from first, each split. */
function wtSteps(args: string[]): string[] {
  const steps: string[] = [];
  for (const command of wtCommands(args)) {
    const title = command[command.indexOf("--title") + 1];
    if (command[0] === "new-tab") steps.push(`new-tab ${title}`);
    else if (command[0] === "split-pane") steps.push(`${command[1]} ${title}`);
    else if (command.join(" ") === "move-focus first") steps.push("focus 0");
    else if (command.join(" ") === "move-focus nextInOrder" && /^focus \d+$/.test(steps.at(-1) ?? "")) steps.push(`focus ${Number(steps.pop()!.slice(6)) + 1}`);
    else steps.push(command.join(" "));
  }
  return steps;
}

/**
 * Replays Windows Terminal's rules: split-pane replaces the focused pane with a split of it (first)
 * and the new pane (second, given --size of the space) and focuses the new pane; move-focus first
 * and nextInOrder walk the tab's panes in tree order.
 */
function wtReplay(args: string[]): WtNode[] {
  const tabs: WtNode[] = [];
  let focused: WtNode | undefined;
  const leaves = (node: WtNode): WtNode[] => node.title !== undefined ? [node] : [...leaves(node.first!), ...leaves(node.second!)];
  for (const command of wtCommands(args)) {
    const title = command[command.indexOf("--title") + 1]!;
    const order = () => leaves(tabs.at(-1)!);
    if (command[0] === "new-tab") tabs.push(focused = { title });
    else if (command.join(" ") === "move-focus first") focused = order()[0];
    else if (command.join(" ") === "move-focus nextInOrder") focused = order()[(order().indexOf(focused!) + 1) % order().length];
    else if (command[0] === "split-pane") {
      const created: WtNode = { title };
      const existing: WtNode = { title: focused!.title! };
      delete focused!.title;
      Object.assign(focused!, { direction: command[1], size: Number(command[command.indexOf("--size") + 1]), first: existing, second: created });
      focused = created;
    }
  }
  return tabs;
}

const wtTree = (node: WtNode): string => node.title ?? `${node.direction === "-V" ? "V" : "H"}[${wtTree(node.first!)},${wtTree(node.second!)}]`;

/** Each pane's [x, y, width, height] in the unit window. -V puts the new pane to the right, -H below. */
function wtGeometry(node: WtNode, x = 0, y = 0, width = 1, height = 1, out: Record<string, number[]> = {}): Record<string, number[]> {
  if (node.title !== undefined) out[node.title] = [x, y, width, height];
  else if (node.direction === "-V") {
    const second = width * node.size!;
    wtGeometry(node.first!, x, y, width - second, height, out);
    wtGeometry(node.second!, x + width - second, y, second, height, out);
  } else {
    const second = height * node.size!;
    wtGeometry(node.first!, x, y, width, height - second, out);
    wtGeometry(node.second!, x, y + height - second, width, second, out);
  }
  return out;
}

describe("Windows Terminal grid layout", () => {
  const labels = "abcdefghijklmnop".split("");
  const view = (count: number, columns?: number) => {
    const panes = labels.slice(0, count).map(label => ({ seat: `seat-${label}`, label, paneCommand: `tmux attach -t ${shellQuote(`seat-${label}`)}` }));
    const f = fixture(panes, [panes]);
    if (columns !== undefined) {
      f.get.mockResolvedValue({ status: 200, data: { planId: "current", composed: { id: "saved", opened: panes, pages: [panes], columns, absent: [], degraded: [] }, status: {} } } as never);
    }
    return f;
  };
  // Rows of ceil(sqrt(n)) panes; panes of a row share its width, rows share the height.
  const expectGrid = (tab: WtNode, count: number, columns = Math.ceil(Math.sqrt(count))) => {
    const geometry = wtGeometry(tab);
    expect(Object.keys(geometry).sort()).toEqual(labels.slice(0, count));
    const rows = Math.ceil(count / columns);
    for (let index = 0; index < count; index++) {
      const row = Math.floor(index / columns);
      const inRow = Math.min(columns, count - row * columns);
      const expected = [(index % columns) / inRow, row / rows, 1 / inRow, 1 / rows];
      geometry[labels[index]!]!.forEach((value, axis) => expect(value, `${labels[index]} axis ${axis}`).toBeCloseTo(expected[axis]!, 10));
    }
  };

  it.each([
    [2, "V[a,b]", ["new-tab a", "focus 0", "-V b"]],
    [3, "H[V[a,b],c]", ["new-tab a", "focus 0", "-H c", "focus 0", "-V b"]],
    [4, "H[V[a,b],V[c,d]]", ["new-tab a", "focus 0", "-H c", "focus 1", "-V d", "focus 0", "-V b"]],
    [5, "H[V[V[a,b],c],V[d,e]]", ["new-tab a", "focus 0", "-H d", "focus 1", "-V e", "focus 0", "-V c", "focus 0", "-V b"]],
    [6, "H[V[V[a,b],c],V[V[d,e],f]]", ["new-tab a", "focus 0", "-H d", "focus 1", "-V f", "focus 1", "-V e", "focus 0", "-V c", "focus 0", "-V b"]],
    [7, "H[H[V[V[a,b],c],V[V[d,e],f]],g]", ["new-tab a", "focus 0", "-H g", "focus 0", "-H d", "focus 1", "-V f", "focus 1", "-V e", "focus 0", "-V c", "focus 0", "-V b"]],
    [8, "H[H[V[V[a,b],c],V[V[d,e],f]],V[g,h]]", ["new-tab a", "focus 0", "-H g", "focus 1", "-V h", "focus 0", "-H d", "focus 1", "-V f", "focus 1", "-V e", "focus 0", "-V c", "focus 0", "-V b"]],
    [9, "H[H[V[V[a,b],c],V[V[d,e],f]],V[V[g,h],i]]", ["new-tab a", "focus 0", "-H g", "focus 1", "-V i", "focus 1", "-V h", "focus 0", "-H d", "focus 1", "-V f", "focus 1", "-V e", "focus 0", "-V c", "focus 0", "-V b"]],
  ])("lays %i panes out as a grid, focusing each split's pane by its tree position", async (count, tree, steps) => {
    const f = view(count);
    expect(await openTerminalWindow(f.client, "rig:grid", "tmux", f.deps)).toMatchObject({ ok: true, pages: 1, opened: labels.slice(0, count).map(label => `seat-${label}`) });
    const { args } = launched(f);
    expect(wtSteps(args)).toEqual([...steps, "focus-tab --target 0"]);
    const [tab, ...others] = wtReplay(args);
    expect(others).toEqual([]);
    expect(wtTree(tab!)).toBe(tree);
    expectGrid(tab!, count);
  });

  it("lays a 16-pane page out as a 4x4 grid", async () => {
    const f = view(16);
    await openTerminalWindow(f.client, "rig:grid", "tmux", f.deps);
    const [tab] = wtReplay(launched(f).args);
    expect(wtTree(tab!)).toBe("H[H[V[V[a,b],V[c,d]],V[V[e,f],V[g,h]]],H[V[V[i,j],V[k,l]],V[V[m,n],V[o,p]]]]");
    expectGrid(tab!, 16);
  });

  it("keeps the daemon's column count, such as four panes in one row", async () => {
    const f = view(4, 4);
    await openTerminalWindow(f.client, "rig:row", "tmux", f.deps);
    const [tab] = wtReplay(launched(f).args);
    expect(wtTree(tab!)).toBe("V[V[a,b],V[c,d]]");
    expectGrid(tab!, 4, 4);
  });

  it("starts each pane's own launch entry", async () => {
    const f = view(9);
    await openTerminalWindow(f.client, "rig:grid", "tmux", f.deps);
    const { args } = launched(f);
    const [script] = f.scripts as [string];
    const blocks = script.split(/\n(?=\d+ \{\n)/).slice(1);
    for (const label of labels.slice(0, 9)) {
      const stub = args[args.indexOf("-EncodedCommand", args.indexOf(label)) + 1]!;
      const entry = Number(Buffer.from(stub, "base64").toString("utf16le").split(" ").at(-1));
      expect(blocks[entry]).toMatch(new RegExp(`^${entry} \\{\\n`));
      expect(blocks[entry]).toContain(`"seat-${label}"`);
    }
  });

  it("lays out each page in its own tab", async () => {
    const panes = labels.slice(0, 7).map(label => ({ seat: `seat-${label}`, label, paneCommand: `tmux attach -t ${shellQuote(`seat-${label}`)}` }));
    const f = fixture(panes, [panes.slice(0, 4), panes.slice(4)]);
    expect(await openTerminalWindow(f.client, "rig:pages", "tmux", f.deps)).toMatchObject({ ok: true, pages: 2 });
    const tabs = wtReplay(launched(f).args);
    expect(tabs.map(wtTree)).toEqual(["H[V[a,b],V[c,d]]", "H[V[e,f],g]"]);
  });
});

describe("Windows Terminal pane script", () => {
  const dirs: string[] = [];
  afterEach(() => {
    fsHooks.beforeRename = undefined;
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const scriptDir = () => {
    const dir = path.join(mkdtempSync(path.join(tmpdir(), "openrig-wt-")), "scripts");
    dirs.push(path.dirname(dir));
    return dir;
  };
  const eightDaysAgo = () => new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);

  it("stores each script once by content and leaves an identical one in place", () => {
    const dir = scriptDir();
    const first = prepareWindowsTerminalScript(dir, "param([int]$openrigPane)\n'one'\n");
    expect(path.dirname(first)).toBe(dir);
    expect(path.basename(first)).toMatch(/^openrig-wt-[0-9a-f]{20}\.ps1$/);
    expect(readFileSync(first, "utf8")).toBe("param([int]$openrigPane)\n'one'\n");
    expect(prepareWindowsTerminalScript(dir, "param([int]$openrigPane)\n'one'\n")).toBe(first);
    const second = prepareWindowsTerminalScript(dir, "param([int]$openrigPane)\n'two'\n");
    expect(second).not.toBe(first);
    expect(readdirSync(dir).sort()).toEqual([path.basename(first), path.basename(second)].sort());
  });
  it("uses the script a concurrent identical open stored while a pane holds it open", () => {
    const dir = scriptDir();
    const content = "param([int]$openrigPane)\n'race'\n";
    // The other open renamed first; its pane's ReadAllText then blocks the replacement.
    fsHooks.beforeRename = (_from, to) => {
      writeFileSync(to, content);
      throw Object.assign(new Error(`EPERM: operation not permitted, rename -> '${to}'`), { code: "EPERM" });
    };
    const target = prepareWindowsTerminalScript(dir, content);
    expect(readFileSync(target, "utf8")).toBe(content);
    expect(readdirSync(dir)).toEqual([path.basename(target)]);
  });
  it("still reports a failed rename when no identical script is in place", () => {
    const dir = scriptDir();
    fsHooks.beforeRename = () => { throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" }); };
    expect(() => prepareWindowsTerminalScript(dir, "param([int]$openrigPane)\n'lost'\n")).toThrow(/EPERM/);
    expect(readdirSync(dir)).toEqual([]);
  });
  it("prunes scripts and leftover staging files older than a week, keeping recent and unrelated files", () => {
    const dir = scriptDir();
    const old = prepareWindowsTerminalScript(dir, "param([int]$openrigPane)\n'old'\n");
    const recent = prepareWindowsTerminalScript(dir, "param([int]$openrigPane)\n'recent'\n");
    const staging = `${old}.0123abcd-0123-4567-89ab-0123456789ab.tmp`;
    const unrelated = path.join(dir, "notes.txt");
    writeFileSync(staging, "partial");
    writeFileSync(unrelated, "keep");
    for (const file of [old, staging, unrelated]) utimesSync(file, eightDaysAgo(), eightDaysAgo());
    const current = prepareWindowsTerminalScript(dir, "param([int]$openrigPane)\n'current'\n");
    expect(readdirSync(dir).sort()).toEqual([path.basename(current), path.basename(recent), "notes.txt"].sort());
  });
  it("refreshes a reused script so another open does not prune it", () => {
    const dir = scriptDir();
    const reused = prepareWindowsTerminalScript(dir, "param([int]$openrigPane)\n'reused'\n");
    utimesSync(reused, eightDaysAgo(), eightDaysAgo());
    expect(prepareWindowsTerminalScript(dir, "param([int]$openrigPane)\n'reused'\n")).toBe(reused);
    expect(Date.now() - statSync(reused).mtimeMs).toBeLessThan(60_000);
    prepareWindowsTerminalScript(dir, "param([int]$openrigPane)\n'other'\n");
    expect(readdirSync(dir)).toContain(path.basename(reused));
  });
});
