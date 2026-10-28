// The TmuxAdapter's native psmux branches, driven through a fake argv executor so they run on every OS.
// psmux runs one server per session: the fake keeps one session per server, selected by the global
// `tmux -t =<session>` prefix the adapter adds for a scoped pane ref, or by the command's own `-t`.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { join } from "node:path";
import { createFullTestDb } from "./helpers/test-app.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { TmuxAdapter, psmuxPaneRef, type TmuxFileOps } from "../src/adapters/tmux.js";
import { windowsArguments } from "../src/adapters/windows-argv.js";

const POWERSHELL = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const NATIVE_SHELL = windowsArguments([POWERSHELL, "-NoLogo", "-NoProfile"]);

/** psmux's has-session for an absent session: exit 1 with no output at all. */
function silentExit(): Error {
  return Object.assign(new Error("Command failed: tmux has-session"), { code: 1, stdout: "", stderr: "" });
}

class FakePsmux {
  sessions = new Map<string, { id: string; pane: string; created: number }>();
  calls: string[][] = [];
  command = "pwsh";
  failing?: (argv: string[]) => Error | undefined;
  /** Leave a session in place after a matching if-shell kill. */
  survivesKill = false;
  private clock = 1_792_245_983;

  create(name: string): void {
    this.sessions.set(name, { id: "$0", pane: "%1", created: this.clock++ });
  }

  run = async (argv: string[]): Promise<string> => {
    this.calls.push(argv);
    const failure = this.failing?.(argv);
    if (failure) throw failure;
    let args = argv.slice(1);
    let server: string | undefined;
    if (args[0] === "-t") { server = args[1]!.replace(/^=/, ""); args = args.slice(2); }
    const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
    const named = (flag("-t") ?? "").replace(/^=/, "").replace(/:$/, "");
    const session = server ?? named;
    const found = this.sessions.get(session);
    switch (args[0]) {
      case "new-session": {
        const name = flag("-s")!;
        this.create(name);
        const made = this.sessions.get(name)!;
        return flag("-F") === "#{pane_id}" ? `${made.pane}\n` : `${made.id} ${made.created}\n`;
      }
      case "has-session":
        if (!found) throw silentExit();
        return "";
      case "list-panes":
        if (!found) throw new Error(`can't find session: ${session}`);
        return `${session}|${found.pane}|0|C:\\w|80|24|1\n`;
      case "display-message": {
        if (!found) throw new Error(`can't find session: ${session}`);
        const format = args.at(-1)!;
        if (format === "#{session_id}") return `${found.id}\n`;
        if (format === "#{pane_current_command}") return `${this.command}\n`;
        return "\n";
      }
      case "if-shell": {
        if (!found) throw new Error(`can't find session: ${session}`);
        const condition = args[2]!;
        const wantName = /#\{==:#\{session_name\},([^}]*)\}/.exec(condition)?.[1];
        const wantCreated = /#\{==:#\{session_created\},(\d+)\}/.exec(condition)?.[1];
        const wantId = /#\{==:#\{session_id\},(\$\d+)\}/.exec(condition)?.[1];
        const same = wantId !== undefined ? wantId === found.id : wantName === session && wantCreated === String(found.created);
        if (!same) return "kept\n";
        if (!this.survivesKill) this.sessions.delete(session);
        return "";
      }
      default:
        return "";
    }
  };
}

function adapterFor(psmux: FakePsmux, fileOps?: TmuxFileOps): TmuxAdapter {
  return new TmuxAdapter(async () => { throw new Error("No POSIX shell string on psmux"); }, fileOps, psmux.run, "psmux");
}

describe("psmux probe sessions", () => {
  let db: Database.Database;
  beforeEach(() => { db = createFullTestDb(); });
  afterEach(() => db.close());

  it("creates the private probe with argv and a PowerShell pane, then kills it on its own server", async () => {
    const psmux = new FakePsmux();
    const adapter = adapterFor(psmux);
    adapter.deliveryGuard = new SeatDeliveryGuard(db, (target) => resolveGuardTarget(db, target));
    const name = "rigged-refresh-dev-impl@my-rig-mabc123";

    expect(await adapter.createProbeSession(name, "C:\\My Projects\\x")).toEqual({ ok: true });
    expect(psmux.calls[0]).toEqual(["tmux", "new-session", "-d", "-P", "-F", "#{session_id} #{session_created}",
      "-s", name, "-c", "C:\\My Projects\\x", NATIVE_SHELL]);

    expect(await adapter.killSession(name)).toEqual({ ok: true });
    expect(psmux.sessions.has(name)).toBe(false);
    expect(psmux.calls).toContainEqual(["tmux", "-t", `=${name}`, "if-shell", "-F", "#{==:#{session_id},$0}", "kill-session", "display-message -p kept"]);
  });

  it("removes a probe whose pane it cannot prove by name and creation time, on that session's server", async () => {
    const psmux = new FakePsmux();
    psmux.failing = (argv) => argv.includes("list-panes") ? new Error("list-panes: transient failure") : undefined;
    const adapter = adapterFor(psmux);
    const name = "rigged-refresh-x";

    const result = await adapter.createProbeSession(name);
    expect(result).toMatchObject({ ok: false, code: "guard_target_unknown" });
    expect((result as { message: string }).message).not.toContain("was not removed");
    expect(psmux.calls).toContainEqual(["tmux", "-t", `=${name}`, "if-shell", "-F",
      `#{&&:#{==:#{session_name},${name}},#{==:#{session_created},1792245983}}`, "kill-session", "display-message -p kept"]);
    expect(psmux.sessions.has(name)).toBe(false);
  });

  it("keeps a session that no longer has the probe's creation time, and says so", async () => {
    const psmux = new FakePsmux();
    psmux.failing = (argv) => {
      if (!argv.includes("list-panes")) return undefined;
      // Another client replaced the probe under the same name.
      psmux.sessions.delete("rigged-refresh-x"); psmux.create("rigged-refresh-x");
      return new Error("list-panes: transient failure");
    };
    const result = await adapterFor(psmux).createProbeSession("rigged-refresh-x");
    expect((result as { message: string }).message).toContain("The helper session was not removed: its name no longer names the session created at 1792245983");
    expect(psmux.sessions.has("rigged-refresh-x")).toBe(true);
  });

  it("reports a probe kill it cannot verify", async () => {
    const psmux = new FakePsmux();
    psmux.survivesKill = true;
    psmux.failing = (argv) => argv.includes("list-panes") ? new Error("list-panes: transient failure") : undefined;
    const result = await adapterFor(psmux).createProbeSession("rigged-refresh-x");
    expect((result as { message: string }).message).toContain("The helper session was not removed: its disappearance could not be verified.");
  });
});

describe("psmux session presence and kill", () => {
  it("reads only psmux's silent exit 1 as absence, never a diagnostic failure", async () => {
    const psmux = new FakePsmux();
    const adapter = adapterFor(psmux);
    expect(await adapter.probeSession("missing")).toEqual({ state: "absent" });
    psmux.failing = () => Object.assign(new Error("Command failed"), { code: 1, stdout: "", stderr: "Access is denied." });
    await expect(adapter.probeSession("missing")).rejects.toThrow("Command failed");
  });

  it("refuses to report a kill when the server's session identity changed or the session is still there", async () => {
    const changed = new FakePsmux();
    changed.create("seat");
    const run = changed.run;
    changed.run = async (argv) => argv.includes("if-shell") ? "kept\n" : run(argv);
    expect(await adapterFor(changed).killSession("seat")).toMatchObject({ ok: false, code: "guard_target_changed" });
    expect(changed.sessions.has("seat")).toBe(true);

    const survivor = new FakePsmux();
    survivor.create("seat");
    survivor.survivesKill = true;
    expect(await adapterFor(survivor).killSession("seat")).toMatchObject({ ok: false, code: "kill_unverified" });
  });
});

describe("psmux blank-shell and script respawn", () => {
  it("respawns the blank shell as createSession's PowerShell, without reading psmux's default-shell", async () => {
    const psmux = new FakePsmux();
    psmux.create("seat");
    const adapter = adapterFor(psmux);
    const pane = psmuxPaneRef("seat", "%1");
    const shell = await adapter.getDefaultShell();
    expect(shell).toBe(POWERSHELL);
    expect(await adapter.respawnPane(pane, shell!, { cwd: "C:\\w", env: { OPENRIG_NODE_ID: "n1" } })).toEqual({ ok: true });
    expect(psmux.calls.some((argv) => argv.includes("default-shell"))).toBe(false);
    expect(psmux.calls.some(argv => argv.includes("source-file"))).toBe(true);
    expect(psmux.calls.at(-1)).toEqual(["tmux", "-t", "=seat", "respawn-pane", "-t", "%1", "-c", "C:\\w", "--", NATIVE_SHELL]);
    expect(JSON.stringify(psmux.calls)).not.toContain("OPENRIG_NODE_ID=n1");
  });

  it("still passes a script respawn to PowerShell encoded", async () => {
    const psmux = new FakePsmux();
    psmux.create("seat");
    const script = "& { Write-Output 'after' }";
    expect(await adapterFor(psmux).respawnPane(psmuxPaneRef("seat", "%1"), script)).toEqual({ ok: true });
    expect(psmux.calls.at(-1)).toEqual(["tmux", "-t", "=seat", "respawn-pane", "-t", "%1", "--",
      windowsArguments([POWERSHELL, "-NoLogo", "-NoProfile", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")])]);
  });

  it("tmux still reads the server's default-shell", async () => {
    const calls: string[][] = [];
    const adapter = new TmuxAdapter(async () => "", undefined, async (argv) => { calls.push(argv); return "/bin/zsh\n"; });
    expect(await adapter.getDefaultShell()).toBe("/bin/zsh");
    expect(calls).toEqual([["tmux", "show-options", "-gv", "default-shell"]]);
  });
});

describe("psmux termination", () => {
  it("reports TERM as unsupported and signals nothing", async () => {
    const psmux = new FakePsmux();
    psmux.create("seat");
    const adapter = adapterFor(psmux);
    const unsupported = { ok: false, code: "graceful_unsupported", message: expect.stringContaining("no graceful termination signal") };
    expect(await adapter.signalPid(4242, "TERM")).toEqual(unsupported);
    expect(await adapter.signalPaneProcess(psmuxPaneRef("seat", "%1"), "TERM")).toEqual(unsupported);
    expect(psmux.calls).toEqual([]);
  });

  it("tmux still sends kill -TERM", async () => {
    const exec = vi.fn(async () => "");
    expect(await new TmuxAdapter(exec).signalPid(4242, "TERM")).toEqual({ ok: true });
    expect(exec).toHaveBeenCalledWith("kill -TERM 4242");
  });
});

describe("psmux text routing", () => {
  const fileOps = (): TmuxFileOps & { unlink: ReturnType<typeof vi.fn> } => ({
    writeFile: vi.fn(async () => {}), unlink: vi.fn(async () => {}), tmpName: () => "C:\\temp\\payload.txt", bufferName: () => "buf",
  });

  it.each(["cmd", "python", "PowerShell.EXE"])("pastes into a %s foreground through psmux, not console input", async (command) => {
    const psmux = new FakePsmux();
    psmux.create("seat");
    psmux.command = command;
    const pane = psmuxPaneRef("seat", "%1");
    expect(await adapterFor(psmux, fileOps()).sendText(pane, "first\nsecond")).toEqual({ ok: true });
    expect(psmux.calls).toContainEqual(["tmux", "-t", "=seat", "load-buffer", "-b", "buf", "C:\\temp\\payload.txt"]);
    expect(psmux.calls.at(-1)).toEqual(["tmux", "-t", "=seat", "paste-buffer", "-t", "%1", "-b", "buf", "-d", "-r", "-p"]);
  });

  it("stages a launch into a PowerShell pane whose image name is upper case", async () => {
    const psmux = new FakePsmux();
    psmux.create("seat");
    psmux.command = "PowerShell.EXE";
    expect(await adapterFor(psmux, fileOps()).sendShellCommand(psmuxPaneRef("seat", "%1"), "Write-Output 1")).toEqual({ ok: true });
  });

  it("clears the typed invocation when Enter fails, as POSIX does, and removes the unconsumed script", async () => {
    const psmux = new FakePsmux();
    psmux.create("seat");
    psmux.failing = (argv) => argv.at(-1) === "Enter" ? new Error("send-keys: pane gone") : undefined;
    const ops = fileOps();
    const pane = psmuxPaneRef("seat", "%1");
    expect(await adapterFor(psmux, ops).sendShellCommand(pane, "Write-Output 1")).toMatchObject({ ok: false });
    expect(psmux.calls.at(-1)).toEqual(["tmux", "-t", "=seat", "send-keys", "-t", "%1", "C-c"]);
    expect(ops.unlink).toHaveBeenCalledWith("C:\\temp\\payload.txt");
    expect(ops.unlink.mock.calls.length).toBe(2); // the paste file and the never-consumed script
  });
});

// prepareWindowsCodexComposer acts only on native Windows.
describe.runIf(process.platform === "win32")("psmux launch-time composer repair", () => {
  const reply = "› ]10;rgb:cccc/cccc/cccc\\]11;rgb:0c0c/0c0c/0c0c\\\n\n";

  it("clears a terminal-reply draft once and confirms the redraw", async () => {
    const psmux = new FakePsmux();
    psmux.create("seat");
    let screen = reply;
    const run = psmux.run;
    psmux.run = async (argv) => {
      if (argv.includes("capture-pane")) return screen;
      if (argv.at(-1) === "C-u") screen = "› \n\n";
      return run(argv);
    };
    expect(await adapterFor(psmux).prepareWindowsCodexComposer(psmuxPaneRef("seat", "%1"))).toEqual({ ok: true });
    expect(psmux.calls.filter((argv) => argv.at(-1) === "C-u")).toEqual([["tmux", "-t", "=seat", "send-keys", "-t", "%1", "C-u"]]);
  });

  it("reports a draft that is still there after its one clearing key, without repeating it", async () => {
    const psmux = new FakePsmux();
    psmux.create("seat");
    const run = psmux.run;
    psmux.run = async (argv) => argv.includes("capture-pane") ? reply : run(argv);
    expect(await adapterFor(psmux).prepareWindowsCodexComposer(psmuxPaneRef("seat", "%1"))).toMatchObject({ ok: false, code: "native_composer_unverified" });
    expect(psmux.calls.filter((argv) => argv.at(-1) === "C-u")).toHaveLength(1);
  });
});

describe("pane ids", () => {
  it("scopes only a raw psmux pane id", () => {
    expect(psmuxPaneRef("s", "%3")).toBe("psmux:cw:%3");
    expect(psmuxPaneRef("s", "psmux:cw:%3")).toBe("psmux:cw:%3");
    expect(psmuxPaneRef("s", "@3")).toBe("@3");
  });

  it("tmux keeps the exact-match target for a session named psmux", async () => {
    const calls: string[][] = [];
    await new TmuxAdapter(async () => "", undefined, async (argv) => { calls.push(argv); return ""; }).listPanes("psmux:0");
    expect(calls[0]!.slice(0, 4)).toEqual(["tmux", "list-panes", "-t", "=psmux:0"]);
  });
});
