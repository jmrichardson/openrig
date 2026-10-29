import { expect, it, vi } from "vitest";
import { Hono } from "hono";
import { kernelStatusRoutes } from "../src/routes/kernel-status.js";
it.each(["absent", "unknown", "present"])("reports %s session evidence instead of trusting stale boot readiness", async state => {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("kernelBootTracker" as never, { getStatus: () => ({ kernelState: "ready", agents: [{ sessionName: "operator-agent@kernel", runtime: "codex", startupStatus: "ready" }], firstUnreadySince: null, variant: null, detail: null, lastBootFailure: null }) } as never);
    c.set("tmuxAdapter" as never, { probeSession: vi.fn(async () => ({ state })) } as never);
    await next();
  });
  app.route("/api/kernel", kernelStatusRoutes);
  const data = await (await app.request("/api/kernel/status")).json();
  expect(data.kernel_state).toBe(state === "present" ? "ready" : "degraded");
  if (state === "absent") { expect(data.agents[0].down).toBe(true); expect(data.detail).toContain("rig start --last"); }
  if (state === "unknown") expect(data.detail).toContain("could not be verified");
});
