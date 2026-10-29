// 0.5.0 — `rig tui` is a NAMED ALIAS of the bare-`rig` front-door mission-control
// path. Zero new behavior: it delegates to the SAME openMissionControl (probe →
// friendly degrade → resolveTuiPath + launch) that bare `rig` uses, with the same
// TTY-awareness on stdout and the same daemon-down degrade. These pins assert the
// shared code path (via injected FrontDoorIo spies), not a mirror.
import { describe, it, expect, vi } from "vitest";
import { Command } from "commander";
import { tuiCommand } from "../src/commands/tui.js";
import { USAGE_LINES } from "../src/front-door.js";

function run(io: Record<string, unknown>) {
  const prog = new Command();
  prog.exitOverride();
  prog.addCommand(tuiCommand(io));
  return prog.parseAsync(["node", "rig", "tui"]);
}

describe("rig tui — alias of the bare-rig front-door mission-control path (no new behavior)", () => {
  it("daemon UP + TTY stdout → delegates to the SAME launch path (launchTui called, exits its code)", async () => {
    const launchTui = vi.fn(async () => 0);
    const exit = vi.fn();
    await run({ stdoutIsTTY: true, stdinIsTTY: true, probeDaemon: async () => true, launchTui, exit, err: () => {} });
    expect(launchTui).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("BLOCKER 1: transport connect failure (daemon DOWN) LAUNCHES the crash-cart TUI (rig tui = bare rig)", async () => {
    const launchTui = vi.fn(async () => 0);
    const errs: string[] = [];
    const exit = vi.fn();
    await run({ stdoutIsTTY: true, stdinIsTTY: true, probeDaemon: async () => false, launchTui, exit, err: (l: string) => errs.push(l) });
    expect(launchTui).toHaveBeenCalledTimes(1); // daemon down must REACH the cockpit, not degrade-and-exit
    expect(errs.join("\n")).not.toMatch(/runtime posture/);
    expect(exit).toHaveBeenCalledWith(0); // exits with the TUI's code
  });

  it("stdout NOT a TTY → degrades (same TTY-awareness on stdout), never launches into a pipe", async () => {
    const launchTui = vi.fn(async () => 0);
    const exit = vi.fn();
    await run({ stdoutIsTTY: false, probeDaemon: async () => true, launchTui, exit, err: () => {} });
    expect(launchTui).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("on Windows, piped stdin never probes or launches an interactive TUI", async () => {
    const launchTui = vi.fn(async () => 0);
    const probeDaemon = vi.fn(async () => true);
    const exit = vi.fn();
    const errs: string[] = [];
    await run({ platform: "win32", stdoutIsTTY: true, stdinIsTTY: false, probeDaemon, launchTui, exit, err: (l: string) => errs.push(l) });
    expect(probeDaemon).not.toHaveBeenCalled();
    expect(launchTui).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
    expect(errs.at(-1)).toBe("mission control needs interactive TTY input and output");
  });

  it.each(["linux", "darwin"] as const)("on %s the standalone TUI needs only a TTY stdout", async (platform) => {
    const launchTui = vi.fn(async () => 0);
    const exit = vi.fn();
    await run({ platform, stdoutIsTTY: true, stdinIsTTY: false, probeDaemon: async () => true, launchTui, exit, err: () => {} });
    expect(launchTui).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it.each(["linux", "darwin"] as const)("on %s shared entry with piped stdin keeps its message", async (platform) => {
    const exit = vi.fn();
    const errs: string[] = [];
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(tuiCommand({ platform, stdoutIsTTY: true, stdinIsTTY: false, exit, err: (l: string) => errs.push(l) }));
    await prog.parseAsync(["node", "rig", "tui", "--shared"]);
    expect(exit).toHaveBeenCalledWith(1);
    expect(errs.at(-1)).toBe("mission control needs an interactive terminal (shared entry requires TTY input and output)");
  });

  it("the front-door usage lines register the `rig tui` help text", () => {
    expect(USAGE_LINES.join("\n")).toMatch(/rig tui/);
  });
});
