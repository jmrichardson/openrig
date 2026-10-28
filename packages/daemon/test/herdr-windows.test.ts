// Native Windows herdr: the socket path under %APPDATA%, the named-pipe endpoint, and layout
// panes that run the composer's literal words as argv. Platform is injected, so every OS runs these.
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildGridRoot, HerdrAdapter, planHerdrLayout, type HerdrLayoutNode, type HerdrPaneNode } from "../src/domain/terminal/herdr-adapter.js";
import { herdrSocketEndpoint, resolveHerdrSocketPath, type HerdrResult, type HerdrTransport } from "../src/domain/terminal/herdr-transport.js";
import { composeView } from "../src/domain/terminal/view-composer.js";
import { TerminalService, type TerminalServiceDeps } from "../src/domain/terminal/terminal-service.js";
import type { ComposedPane, ComposedView } from "../src/domain/terminal/terminal-provider.js";

const APPDATA = "C:\\Users\\Jürgen O'Brien\\AppData\\Roaming";
const TMUX = "C:\\Program Files\\psmux\\tmux.exe";
const q = (value: string) => "'" + value.replace(/'/g, "'\"'\"'") + "'";

function leaves(node: HerdrLayoutNode, out: HerdrPaneNode[] = []): HerdrPaneNode[] {
  if (node.type === "pane") out.push(node);
  else { leaves(node.first, out); leaves(node.second, out); }
  return out;
}

describe("herdr socket on Windows", () => {
  it("resolves the override, then the named session, then the default under %APPDATA%\\herdr", () => {
    expect(resolveHerdrSocketPath({ HERDR_SOCKET_PATH: "D:\\x\\h.sock", HERDR_SESSION: "s1", APPDATA }, "win32")).toBe("D:\\x\\h.sock");
    expect(resolveHerdrSocketPath({ HERDR_SESSION: "s1", APPDATA }, "win32")).toBe(`${APPDATA}\\herdr\\sessions\\s1\\herdr.sock`);
    expect(resolveHerdrSocketPath({ APPDATA }, "win32")).toBe(`${APPDATA}\\herdr\\herdr.sock`);
  });
  it("follows XDG_CONFIG_HOME as Windows herdr does, and falls back to the profile's roaming folder", () => {
    expect(resolveHerdrSocketPath({ XDG_CONFIG_HOME: "D:\\xdg", APPDATA }, "win32")).toBe("D:\\xdg\\herdr\\herdr.sock");
    expect(resolveHerdrSocketPath({ HERDR_SESSION: "s1" }, "win32")).toBe(path.win32.join(os.homedir(), "AppData", "Roaming", "herdr", "sessions", "s1", "herdr.sock"));
  });
  it("keeps the POSIX default, which never reads APPDATA or XDG_CONFIG_HOME", () => {
    expect(resolveHerdrSocketPath({ APPDATA, XDG_CONFIG_HOME: "/xdg" }, "linux")).toBe(path.join(os.homedir(), ".config", "herdr", "herdr.sock"));
    expect(resolveHerdrSocketPath({ APPDATA, HERDR_SESSION: "s1" }, "darwin")).toBe(path.join(os.homedir(), ".config", "herdr", "sessions", "s1", "herdr.sock"));
  });
  it("connects to the named pipe the socket path names on Windows, and to the socket itself elsewhere", () => {
    const sock = `${APPDATA}\\herdr\\sessions\\s1\\herdr.sock`;
    expect(herdrSocketEndpoint(sock, "win32")).toBe(`\\\\.\\pipe\\${sock}`);
    expect(herdrSocketEndpoint("/home/u/.config/herdr/herdr.sock", "linux")).toBe("/home/u/.config/herdr/herdr.sock");
  });
});

describe("herdr layout panes on Windows", () => {
  const view = composeView("rig:rig", [
    { seat: "claude@rig", runtime: "claude-code", label: "claude", tmuxSession: "claude@rig", host: null, readOnly: false, alive: true },
    { seat: "o'brien@rig", runtime: "codex", label: "codex", tmuxSession: "o'brien@rig", host: null, readOnly: true, alive: true },
    { seat: "far@rig", label: "far", tmuxSession: "far@rig", host: "lab", readOnly: true, alive: true },
  ], { resolveHost: () => ({ id: "lab", transport: "ssh", target: "lab.example", user: "me" }), localTmux: TMUX, panesPerPage: 16, platform: "win32" });

  it("runs each pane's literal words directly, pinning the daemon's psmux namespace and clearing psmux nesting", () => {
    const panes = leaves(buildGridRoot(view.opened, undefined, "win32", { PSMUX_DATA_DIR: "D:\\psmux data" }).root);
    const env = { PSMUX_DATA_DIR: "D:\\psmux data", TMUX: "", PSMUX_SESSION: "", PSMUX_TARGET_SESSION: "" };
    expect(panes.slice(0, 3).map(p => p.env)).toEqual([env, env, env]);
    for (const [index, session] of ["claude@rig", "o'brien@rig"].entries()) {
      const command = panes[index]!.command!;
      expect(command.slice(0, 4)).toEqual(["powershell.exe", "-NoLogo", "-NoProfile", "-EncodedCommand"]);
      const script = Buffer.from(command[4]!, "base64").toString("utf16le");
      expect(script).toContain("OPENRIG_NODE_ID");
      expect(script).toContain(session.replaceAll("'", "''"));
      expect(script).toContain(index === 1 ? "attach -r -t" : "attach -t");
      expect(script).not.toContain("/bin/sh");
    }
    expect(panes[2]!.command!.slice(0, 2)).toEqual(["ssh", "me@lab.example"]);
    // Herdr's HERDR_AGENT hint is Linux/macOS only; Windows has no `sh` or `env` to carry it.
    expect(JSON.stringify(panes)).not.toContain("HERDR_AGENT");
    expect(panes[3]).toEqual({ type: "pane", label: "", command: ["powershell.exe", "-NoLogo", "-NoProfile"] });
  });
  it("names no psmux namespace the daemon does not have", () => {
    const [first] = leaves(buildGridRoot(view.opened.slice(0, 1), undefined, "win32", {}).root);
    expect(first!.env).toEqual({ TMUX: "", PSMUX_SESSION: "", PSMUX_TARGET_SESSION: "" });
  });
  it("leaves the POSIX pane commands as they were", () => {
    const panes = leaves(buildGridRoot(view.opened, undefined, "linux", { PSMUX_DATA_DIR: "/x" }).root);
    expect(panes.slice(0, 3).every(pane => pane.command?.[0] === "sh" && pane.command[1] === "-c")).toBe(true);
    expect(panes[0]!.command![2]).toContain("HERDR_AGENT=claude");
    expect(panes[2]!.command![2]).toContain("ssh");
    expect(panes[3]!.command).toEqual(["sh"]);
    expect(panes.every((pane) => !("env" in pane))).toBe(true);
  });
});

describe("herdr adapter and preview on a Windows daemon", () => {
  const pane: ComposedPane = { seat: "a@r", label: "a", paneCommand: `${q(TMUX)} attach -t ${q("a@r")}`, readOnly: false };
  const view: ComposedView = { id: "rig:r", opened: [pane], absent: [], degraded: [], pages: [[pane]] };
  function transport(): { transport: HerdrTransport; applied: unknown[] } {
    const applied: unknown[] = [];
    return {
      applied,
      transport: {
        probe: async () => ({ alive: true, version: "0.9.3", protocol: 22 }),
        request: async (method, params): Promise<HerdrResult> => {
          if (method === "workspace.create") return { type: "workspace_created", workspace: { workspace_id: "w1" }, tab: { tab_id: "w1:t1" } };
          if (method === "layout.apply") { applied.push((params as { root: unknown }).root); return { type: "layout_apply", layout: { workspace_id: "w1", tab_id: "w1:t2" } }; }
          if (method === "pane.list") return { type: "pane_list", panes: [{ pane_id: "w1:p2", tab_id: "w1:t2", label: "a" }] };
          return { type: "ok" };
        },
      },
    };
  }

  it("applies the argv pane through the socket", async () => {
    const t = transport();
    const adapter = new HerdrAdapter({ transportFactory: () => t.transport, platform: "win32", env: { PSMUX_DATA_DIR: "D:\\p" } });
    expect(await adapter.openView(view)).toMatchObject({ ok: true, opened: ["a@r"] });
    expect(t.applied).toEqual([{ type: "pane", label: "a", command: [TMUX, "attach", "-t", "a@r"], env: { PSMUX_DATA_DIR: "D:\\p", TMUX: "", PSMUX_SESSION: "", PSMUX_TARGET_SESSION: "" } }]);
  });
  it("previews the same grid the adapter applies, so an expected plan still matches", async () => {
    const t = transport();
    const adapter = new HerdrAdapter({ transportFactory: () => t.transport, platform: "win32" });
    const service = new TerminalService({
      resolveProvider: (name) => (name === "herdr" ? adapter : null),
      viewsStore: { get: () => null, list: () => [] },
      listRigSeats: (rig) => (rig === "r" ? [{ canonicalSessionName: "a@r", attachmentType: "tmux", tmuxSession: "a@r", rigName: "r", logicalId: "a" }] : null),
      listPodSeats: () => null, listScopeSeats: () => null, listRigNames: () => ["r"],
      resolveHost: () => null, hasSession: () => true, platform: "win32",
    } as TerminalServiceDeps);
    const preview = await service.previewView({ view: "r" });
    if (!("composed" in preview)) throw new Error("expected a preview");
    const command = leaves(preview.grids[0]!.root)[0]!.command!;
    expect(command.slice(0, 4)).toEqual(["powershell.exe", "-NoLogo", "-NoProfile", "-EncodedCommand"]);
    expect(Buffer.from(command[4]!, "base64").toString("utf16le")).toContain("a@r");
    expect(await service.openView({ view: "r", expectedPlan: preview.planId })).toMatchObject({ ok: true, opened: ["a@r"] });
    expect(t.applied).toEqual(planHerdrLayout({ ...preview.composed, planId: preview.planId }, "x", undefined, "win32").pages.map((page) => page.root));
  });
});
