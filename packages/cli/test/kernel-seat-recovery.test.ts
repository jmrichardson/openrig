import { expect, it, vi } from "vitest";
import { recoverMissingKernelSeats } from "../src/commands/start.js";
function fixture(overrides = {}) {
  const node = { logicalId: "operator.agent", runtime: "codex", sessionStatus: "detached", intentionallyStopped: false, identityVerdict: { verdict: "pane_missing", reason: "session_missing" }, ...overrides };
  const get = vi.fn(async (url: string) => ({ status: 200, data: url === "/api/rigs/summary" ? [{ id: "kernel-id", name: "kernel" }] : [node] }));
  const post = vi.fn(async () => ({ status: 200, data: { ok: true } }));
  return { get, post };
}
it("restores only the observed missing kernel seat using the existing single-seat resume route", async () => {
  const client = fixture(); await recoverMissingKernelSeats(client as any);
  expect(client.post).toHaveBeenCalledWith("/api/rigs/kernel-id/nodes/operator.agent/launch", {}, { timeoutMs: 120000 });
});
it.each([{ intentionallyStopped: true }, { intentionallyStopped: undefined }, { sessionStatus: "running" }, { sessionStatus: null }, { identityVerdict: { verdict: "unknown" } }])("does not restart stopped, live or unverified seats: %j", async override => {
  const client = fixture(override); await recoverMissingKernelSeats(client as any); expect(client.post).not.toHaveBeenCalled();
});
it("surfaces failed resume instead of falling back to a blank conversation", async () => {
  const client = fixture(); client.post.mockResolvedValue({ status: 200, data: { ok: false } });
  await expect(recoverMissingKernelSeats(client as any)).rejects.toThrow("needs attention");
  expect(client.post).toHaveBeenCalledOnce();
});
