import { afterEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const source = path.resolve(import.meta.dirname, "../assets/plugins/openrig-core");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
it.each(["activity", "refocus"])("delivers %s hook stdin through the native Windows shell without POSIX syntax", action => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rig hook ' " )); roots.push(root);
  const scripts = path.join(root, "hooks/scripts"); fs.mkdirSync(scripts, { recursive: true });
  fs.copyFileSync(path.join(source, "hooks/scripts/codex-entry.cjs"), path.join(scripts, "codex-entry.cjs"));
  const target = action === "activity" ? "activity-relay.cjs" : "refocus.cjs";
  fs.writeFileSync(path.join(scripts, target), "process.stdout.write(require('node:fs').readFileSync(0,'utf8'));process.stdout.write(JSON.stringify(process.argv.slice(2))); ");
  const command = `node -e "require(require('path').join(process.env.PLUGIN_ROOT,'hooks/scripts/codex-entry.cjs'))" ${action}`;
  const file = process.platform === "win32" ? "powershell.exe" : "/bin/sh";
  const args = process.platform === "win32" ? ["-NoProfile", "-Command", command] : ["-c", command];
  const env = { ...process.env, OPENRIG_NODE: process.execPath, OPENRIG_SEAT_PROJECT_DIR: root, PLUGIN_ROOT: root };
  const result = spawnSync(file, args, { env, input: '{"hook_event_name":"Stop"}', encoding: "utf8" });
  expect(result.stderr).toBe(""); expect(result.status).toBe(0);
  expect(result.stdout).toContain('{"hook_event_name":"Stop"}');
  expect(result.stdout).toContain(action === "activity" ? "--from-plugin" : "--runtime");
});
it("all shipped Codex hooks use the shell-neutral entry and skip unmanaged sessions", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(source, "hooks/codex.json"), "utf8"));
  for (const group of Object.values(manifest.hooks).flat() as any[]) for (const hook of group.hooks) {
    expect(hook.command).toContain("codex-entry.cjs");
    const result = spawnSync(process.platform === "win32" ? "powershell.exe" : "/bin/sh", process.platform === "win32" ? ["-NoProfile", "-Command", hook.command] : ["-c", hook.command], {
      env: { ...process.env, PLUGIN_ROOT: source, OPENRIG_SEAT_PROJECT_DIR: "" }, encoding: "utf8", input: "{}",
    });
    expect(result.status).toBe(0); expect(result.stderr).toBe(""); expect(result.stdout).toBe("");
  }
});
