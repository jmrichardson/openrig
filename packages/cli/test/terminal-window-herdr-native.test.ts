// Live: `rig terminal open --window` from inside a real native Windows herdr pane places the view in
// that herdr session, through the daemon's real terminal routes, and a second open reuses it after
// herdr's process info and psmux's client list confirm the attachments. Runs only when
// OPENRIG_TEST_HERDR names herdr.exe and OPENRIG_TEST_PSMUX names psmux's tmux.exe (give it a private
// PSMUX_DATA_DIR). The herdr server is a named session under a private APPDATA, and no window opens.
import { execFile, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { DaemonClient } from "../src/client.js";
import { defaultWindowDeps, openTerminalWindow } from "../src/terminal-window.js";
import { TmuxAdapter } from "../../daemon/src/adapters/tmux.js";
import { HerdrAdapter } from "../../daemon/src/domain/terminal/herdr-adapter.js";
import { createHerdrSocketRpc, createHerdrSocketTransport, resolveHerdrSocketPath } from "../../daemon/src/domain/terminal/herdr-transport.js";
import { TerminalService, type TerminalServiceDeps } from "../../daemon/src/domain/terminal/terminal-service.js";
import { terminalRoutes } from "../../daemon/src/routes/terminal.js";

const execFileAsync = promisify(execFile);
const herdrExe = process.env.OPENRIG_TEST_HERDR;
const psmux = process.env.OPENRIG_TEST_PSMUX;
const enabled = process.platform === "win32" && !!herdrExe && !!psmux;

describe.skipIf(!enabled)("native Windows herdr window flow", () => {
  it("places the view in the current herdr session, then reuses it once the attachments are confirmed", async () => {
    const id = `${process.pid}-${Date.now()}`;
    const rig = `herdr-cli-${id}`;
    const herdrSession = `openrig-cli-test-${id}`;
    const appData = mkdtempSync(path.join(os.tmpdir(), "openrig-herdr-cli-"));
    const herdrEnv: NodeJS.ProcessEnv = { ...process.env, APPDATA: appData };
    for (const name of ["PSMUX_DATA_DIR", "XDG_CONFIG_HOME", "HERDR_SOCKET_PATH", "HERDR_SESSION", "HERDR_CONFIG_PATH"]) delete herdrEnv[name];
    const invoke = async (argv: string[]) => (await execFileAsync(psmux!, argv.slice(1), { windowsHide: true })).stdout;
    const tmux = new TmuxAdapter(async () => { throw new Error("No POSIX transport"); }, undefined, invoke, "psmux");
    const seats = ["a", "b"].map((name) => ({ session: `openrig-cli-${name}-${id}`, marker: `OPENRIG-CLI-MARKER-${name.toUpperCase()}-${id}` }));
    const server = spawn(herdrExe!, ["--session", herdrSession, "server"], { env: herdrEnv, stdio: "ignore", windowsHide: true });
    const socketPath = resolveHerdrSocketPath({ APPDATA: appData, HERDR_SESSION: herdrSession }, "win32");
    const transport = createHerdrSocketTransport(createHerdrSocketRpc(socketPath, 5000, "win32"))();
    const service = new TerminalService({
      resolveProvider: (name) => (name === "herdr" ? new HerdrAdapter({ transportFactory: () => transport, launch: { socketPath }, platform: "win32" }) : null),
      viewsStore: { get: () => null, list: () => [] },
      listRigSeats: (name) => (name === rig ? seats.map((seat) => ({ canonicalSessionName: seat.session, attachmentType: "tmux" as const, tmuxSession: seat.session, rigName: rig, logicalId: seat.session })) : null),
      listPodSeats: () => null, listScopeSeats: () => null, listRigNames: () => [rig],
      resolveHost: () => null, hasSession: () => true, resolveLocalTmux: () => psmux!, platform: "win32",
    } as TerminalServiceDeps);
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("terminalService" as never, service as never); await next(); });
    app.route("/api/terminal", terminalRoutes());
    const http = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
    if (!http.listening) await new Promise<void>((resolve) => http.once("listening", resolve));
    const client = new DaemonClient(`http://127.0.0.1:${(http.address() as { port: number }).port}`);
    // As inside a pane of this herdr session: herdr's markers, and herdr.exe and psmux on PATH.
    const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !["PATH", "CI", "SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY", "TMUX"].includes(name.toUpperCase())));
    Object.assign(env, { Path: [path.dirname(herdrExe!), path.dirname(psmux!), process.env.PATH].join(";"), APPDATA: appData,
      TERM_PROGRAM: "herdr", HERDR_ENV: "1", HERDR_PANE_ID: "w9:p9", HERDR_SESSION: herdrSession, HERDR_SOCKET_PATH: socketPath });
    const deps = { ...defaultWindowDeps(), platform: "win32" as const, env, launch: async () => { throw new Error("No window may open in this test"); } };
    try {
      for (const seat of seats) {
        expect(await tmux.createSession(seat.session, os.tmpdir())).toEqual({ ok: true });
        expect(await tmux.sendShellCommand(seat.session, `while ($true) { '${seat.marker}'; Start-Sleep -Seconds 1 }`)).toEqual({ ok: true });
      }
      const ready = async () => (await transport.probe()).alive;
      for (const deadline = Date.now() + 15_000; !(await ready()) && Date.now() < deadline;) await new Promise((resolve) => setTimeout(resolve, 250));

      const first = await openTerminalWindow(client, rig, undefined, deps);
      expect(first.error).toBeUndefined();
      expect(first).toMatchObject({ provider: "herdr", ok: true, opened: seats.map((seat) => seat.session) });
      expect(first.window).toBeUndefined();
      expect(first.notes).toContain("Using the current Herdr session; no terminal window or personal config was changed.");
      const workspaces = async () => (await transport.request("workspace.list", {}))["workspaces"] as Array<{ workspace_id: string; label?: string }>;
      const created = (await workspaces()).filter((ws) => ws.label === rig);
      expect(created).toHaveLength(1);
      const panes = (await transport.request("pane.list", { workspace_id: created[0]!.workspace_id }))["panes"] as Array<{ pane_id: string; label?: string }>;
      for (const seat of seats) {
        const pane = panes.find((p) => p.label === seat.session)!;
        const read = async () => ((await transport.request("pane.read", { pane_id: pane.pane_id, source: "visible", lines: 60 }))["read"] as { text?: string })?.text ?? "";
        for (const deadline = Date.now() + 20_000; !(await read()).includes(seat.marker) && Date.now() < deadline;) await new Promise((resolve) => setTimeout(resolve, 500));
        expect(await read()).toContain(seat.marker);
      }

      const second = await openTerminalWindow(client, rig, undefined, deps);
      expect(second).toMatchObject({ provider: "herdr", ok: true, opened: [], reusedWorkspace: { id: created[0]!.workspace_id, view: `rig:${rig}` } });
      expect((await workspaces()).filter((ws) => ws.label?.startsWith(rig))).toHaveLength(1);
    } finally {
      http.close();
      await execFileAsync(herdrExe!, ["--session", herdrSession, "server", "stop"], { env: herdrEnv, windowsHide: true, timeout: 15_000 }).catch(() => {});
      await new Promise<void>((resolve) => { if (server.exitCode !== null) resolve(); else { server.once("exit", () => resolve()); setTimeout(() => { server.kill(); resolve(); }, 5000); } });
      await execFileAsync(herdrExe!, ["session", "delete", herdrSession], { env: herdrEnv, windowsHide: true }).catch(() => {});
      for (const seat of seats) await tmux.killSession(seat.session).catch(() => {});
      rmSync(appData, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }, 120_000);
});
