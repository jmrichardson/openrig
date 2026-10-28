// Live: OpenRig's herdr adapter and socket transport against a real native Windows herdr, viewing
// real psmux sessions. Runs only when OPENRIG_TEST_HERDR names herdr.exe and OPENRIG_TEST_PSMUX names
// psmux's tmux.exe (give it a private PSMUX_DATA_DIR). The herdr server is a named session under a
// private APPDATA, so the person's own herdr sessions and config are never touched.
import { execFile, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { HerdrAdapter, HERDR_PANES_PER_PAGE } from "../src/domain/terminal/herdr-adapter.js";
import { createHerdrSocketRpc, createHerdrSocketTransport, resolveHerdrSocketPath } from "../src/domain/terminal/herdr-transport.js";
import { composeView } from "../src/domain/terminal/view-composer.js";

const execFileAsync = promisify(execFile);
const herdrExe = process.env.OPENRIG_TEST_HERDR;
const psmux = process.env.OPENRIG_TEST_PSMUX;
const enabled = process.platform === "win32" && !!herdrExe && !!psmux;

describe.skipIf(!enabled)("native herdr view of psmux sessions", () => {
  it("opens two psmux sessions in one herdr tab, each pane attached to its own session", async () => {
    const id = `${process.pid}-${Date.now()}`;
    const herdrSession = `openrig-test-${id}`;
    const appData = mkdtempSync(path.join(os.tmpdir(), "openrig-herdr-"));
    // The server lacks the daemon's psmux namespace and carries a psmux pane's nesting marker, so
    // the panes attach only because each pane node pins PSMUX_DATA_DIR and blanks PSMUX_SESSION.
    const herdrEnv: NodeJS.ProcessEnv = { ...process.env, APPDATA: appData, PSMUX_SESSION: "openrig-decoy", PSMUX_TARGET_SESSION: "openrig-decoy" };
    for (const name of ["PSMUX_DATA_DIR", "XDG_CONFIG_HOME", "HERDR_SOCKET_PATH", "HERDR_SESSION", "HERDR_CONFIG_PATH"]) delete herdrEnv[name];
    const herdr = (args: string[]) => execFileAsync(herdrExe!, ["--session", herdrSession, ...args], { env: herdrEnv, windowsHide: true, timeout: 15_000 });
    const invoke = async (argv: string[]) => (await execFileAsync(psmux!, argv.slice(1), { windowsHide: true })).stdout;
    const tmux = new TmuxAdapter(async () => { throw new Error("No POSIX transport"); }, undefined, invoke, "psmux");
    const seats = ["a", "b"].map((name) => ({ session: `openrig-herdr-${name}-${id}`, marker: `OPENRIG-HERDR-MARKER-${name.toUpperCase()}-${id}` }));
    const server = spawn(herdrExe!, ["--session", herdrSession, "server"], { env: herdrEnv, stdio: "ignore", windowsHide: true });
    try {
      for (const seat of seats) {
        expect(await tmux.createSession(seat.session, os.tmpdir())).toEqual({ ok: true });
        expect(await tmux.sendShellCommand(seat.session, `while ($true) { '${seat.marker}'; Start-Sleep -Seconds 1 }`)).toEqual({ ok: true });
      }
      const socketPath = resolveHerdrSocketPath({ APPDATA: appData, HERDR_SESSION: herdrSession }, "win32");
      const transport = createHerdrSocketTransport(createHerdrSocketRpc(socketPath, 5000, "win32"))();
      await expect.poll(async () => (await transport.probe()).alive, { timeout: 15_000, interval: 250 }).toBe(true);
      const view = composeView("rig:herdr-native", seats.map((seat) => ({
        seat: seat.session, label: seat.session, tmuxSession: seat.session, host: null, readOnly: true, alive: true,
      })), { resolveHost: () => null, localTmux: psmux, panesPerPage: HERDR_PANES_PER_PAGE });
      const adapter = new HerdrAdapter({ transportFactory: () => transport, platform: "win32" });
      expect(await adapter.liveness()).toEqual({ alive: true });
      const result = await adapter.openView(view);
      expect(result).toMatchObject({ ok: true, opened: seats.map((seat) => seat.session), degraded: [], pages: 1 });

      const workspaces = (await transport.request("workspace.list", {}))["workspaces"] as Array<{ workspace_id: string; label?: string }>;
      const workspace = workspaces.find((ws) => ws.label === "herdr-native");
      expect(workspace).toBeDefined();
      const panes = (await transport.request("pane.list", { workspace_id: workspace!.workspace_id }))["panes"] as Array<{ pane_id: string; label?: string }>;
      for (const seat of seats) {
        const pane = panes.find((p) => p.label === seat.session);
        expect(pane, seat.session).toBeDefined();
        const read = async () => ((await transport.request("pane.read", { pane_id: pane!.pane_id, source: "visible", lines: 60 }))["read"] as { text?: string })?.text ?? "";
        await expect.poll(read, { timeout: 20_000, interval: 500 }).toContain(seat.marker);
        for (const other of seats.filter((s) => s !== seat)) expect(await read()).not.toContain(other.marker);
        // herdr starts the pane's argv itself: the psmux client is the pane's own process, read-only.
        const info = (await transport.request("pane.process_info", { pane_id: pane!.pane_id }))["process_info"] as { foreground_processes?: Array<{ argv?: string[] }> };
        expect(info.foreground_processes?.[0]?.argv).toEqual([psmux, "attach", "-r", "-t", seat.session]);
      }
      const clients = await invoke(["tmux", "list-clients", "-F", "#{session_name}\t#{client_readonly}"]);
      for (const seat of seats) expect(clients).toContain(`${seat.session}\t1`);
    } finally {
      await herdr(["server", "stop"]).catch(() => {});
      await new Promise<void>((resolve) => { if (server.exitCode !== null) resolve(); else { server.once("exit", () => resolve()); setTimeout(() => { server.kill(); resolve(); }, 5000); } });
      await execFileAsync(herdrExe!, ["session", "delete", herdrSession], { env: herdrEnv, windowsHide: true }).catch(() => {});
      for (const seat of seats) await tmux.killSession(seat.session).catch(() => {});
      rmSync(appData, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }, 90_000);
});
