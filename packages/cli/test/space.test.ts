import { afterEach, expect, it, vi } from "vitest";
import { ensureSpaceDaemon, spaceCommand } from "../src/commands/space.js";
const operator = { label: "operator", seat: "operator-agent@kernel", paneCommand: "'tmux' 'attach' '-t' 'operator-agent@kernel'" };
afterEach(() => { process.exitCode = 0; vi.restoreAllMocks(); });
function fixture() {
  vi.spyOn(console, "log").mockImplementation(() => {});
  return { terminal: () => true, ensureDaemon: vi.fn(async () => false), preview: vi.fn(async () => [operator, { ...operator, label: "advisor" }]), waitForKernel: vi.fn(async () => {}), restoreOperator: vi.fn(async () => {}), attach: vi.fn(() => 0) };
}
const run = (deps: ReturnType<typeof fixture>) => spaceCommand(deps).parseAsync(["node", "rig", "operator"]);
it("does not start a daemon that is already running", async () => {
  const deps = { running: vi.fn(async () => true), start: vi.fn(async () => {}) };
  expect(await ensureSpaceDaemon(deps)).toBe(false); expect(deps.start).not.toHaveBeenCalled();
});
it("starts a stopped daemon and verifies availability", async () => {
  const deps = { running: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true), start: vi.fn(async () => {}) };
  expect(await ensureSpaceDaemon(deps)).toBe(true); expect(deps.start).toHaveBeenCalledOnce();
});
it("fails if startup did not make the daemon available", async () => {
  await expect(ensureSpaceDaemon({ running: async () => false, start: async () => {} })).rejects.toThrow("did not become available");
});
it("opens only the existing operator without restarting it or opening other views", async () => {
  const deps = fixture(); await run(deps);
  expect(deps.attach).toHaveBeenCalledWith(["tmux", "attach", "-t", "operator-agent@kernel"]);
  expect(deps.restoreOperator).not.toHaveBeenCalled(); expect(deps.waitForKernel).not.toHaveBeenCalled();
});
it("waits for cold kernel boot before asking for its saved operator view", async () => {
  const deps = fixture(); deps.ensureDaemon.mockResolvedValue(true); await run(deps);
  expect(deps.waitForKernel.mock.invocationCallOrder[0]).toBeLessThan(deps.preview.mock.invocationCallOrder[0]!);
});
it("recovers only a missing operator and then attaches to its restored view", async () => {
  const deps = fixture(); deps.preview.mockResolvedValueOnce([]).mockResolvedValueOnce([]); await run(deps);
  expect(deps.restoreOperator).toHaveBeenCalledOnce(); expect(deps.attach).toHaveBeenCalledOnce();
});
it("never replaces failed recovery with a blank conversation or an attachment", async () => {
  const deps = fixture(); deps.preview.mockResolvedValue([]); deps.restoreOperator.mockRejectedValue(new Error("resume refused"));
  await expect(run(deps)).rejects.toThrow("resume refused"); expect(deps.attach).not.toHaveBeenCalled();
});
it("requires an interactive terminal before starting anything", async () => {
  const deps = fixture(); deps.terminal = () => false;
  await expect(run(deps)).rejects.toThrow("interactive terminal"); expect(deps.ensureDaemon).not.toHaveBeenCalled();
});
