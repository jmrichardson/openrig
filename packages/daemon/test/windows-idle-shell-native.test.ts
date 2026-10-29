import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import { describe, expect, it } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { observeClaudeDelivery, verifyPaneIdleShell } from "../src/domain/native-process-lineage.js";

const execFileAsync = promisify(execFile);
const enabled = process.platform === "win32" && !!process.env.OPENRIG_TEST_PSMUX;

describe.skipIf(!enabled)("native psmux idle shell evidence", () => {
  it("reads the pane's own PowerShell as idle only while it runs no child", async () => {
    const session = `openrig-idle-${process.pid}-${Date.now()}`;
    const invoke = async (argv: string[]) => (await execFileAsync(process.env.OPENRIG_TEST_PSMUX!, argv.slice(1), { windowsHide: true })).stdout;
    const adapter = new TmuxAdapter(async () => { throw new Error("No POSIX transport"); }, undefined, invoke, "psmux");
    try {
      expect(await adapter.createSession(session, os.tmpdir())).toEqual({ ok: true });
      const pane = (await adapter.listPanes(session))[0]!.id;
      const input = { target: pane, tmux: adapter };
      await expect.poll(() => verifyPaneIdleShell(input), { timeout: 10_000 }).toBe(true);
      expect((await observeClaudeDelivery(input)).state).toBe("idle_shell");

      expect(await adapter.sendShellCommand(pane, "ping.exe -n 30 127.0.0.1")).toEqual({ ok: true });
      await expect.poll(() => verifyPaneIdleShell(input), { timeout: 10_000 }).toBe(false);
      expect((await observeClaudeDelivery(input)).state).toBe("unknown");
    } finally {
      await adapter.killSession(session);
    }
  }, 30_000);
});
