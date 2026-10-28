import { afterEach, expect, it, vi } from "vitest";
import { openHereCommand } from "../src/commands/open.js";
afterEach(() => { process.exitCode = 0; vi.restoreAllMocks(); });
const opened = ["operator", "advisor", "dashboard"].map(label => ({ label, seat: `${label}@kernel`, paneCommand: `'C:\\Program Files\\psmux\\tmux.exe' attach -t '${label}@kernel'` }));
it.each(["operator", "advisor", "dashboard"])("attaches %s through inherited terminal without creating a window", async role => {
  const attach = vi.fn(() => 0), preview = vi.fn(async () => ({ opened }));
  vi.spyOn(console, "log").mockImplementation(() => {});
  await openHereCommand({ terminal: () => true, preview, attach }).parseAsync(["node", "rig", ...(role === "operator" ? [] : [role])]);
  expect(attach).toHaveBeenCalledWith(["C:\\Program Files\\psmux\\tmux.exe", "attach", "-t", `${role}@kernel`]);
});
it("refuses noninteractive execution before resolving or attaching seats", async () => {
  const preview = vi.fn(), attach = vi.fn();
  await expect(openHereCommand({ terminal: () => false, preview, attach }).parseAsync(["node", "rig"])).rejects.toThrow("interactive terminal");
  expect(preview).not.toHaveBeenCalled(); expect(attach).not.toHaveBeenCalled();
});
it("does not invent an unavailable role or launch another agent", async () => {
  const attach = vi.fn();
  await expect(openHereCommand({ terminal: () => true, preview: async () => ({ opened: [] }), attach }).parseAsync(["node", "rig"])).rejects.toThrow("unavailable");
  expect(attach).not.toHaveBeenCalled();
});
