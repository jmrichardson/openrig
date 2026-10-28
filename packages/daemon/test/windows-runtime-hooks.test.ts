import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexRuntimeAdapter, codexActivityHookCommand, computeCodexHookTrust } from "../src/adapters/codex-runtime-adapter.js";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import { shellQuote } from "../src/adapters/shell-quote.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";
import type { ProjectionPlan } from "../src/domain/projection-planner.js";

const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("native runtime hook commands", () => {
  it("keeps Windows paths out of cmd expansion and preserves literal Node argv", () => {
    const relay = "C:\\Users\\O'Brien %PATH%\\hooks\\relay.cjs";
    const command = codexActivityHookCommand(relay, "win32");
    expect(command).toMatch(/^powershell\.exe -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/=]+$/);
    const script = Buffer.from(command.split(" ").at(-1)!, "base64").toString("utf16le");
    expect(script).toContain("O''Brien %PATH%");
    expect(script).toContain("$openrigStart.UseShellExecute = $false");
    expect(command).not.toContain(relay);
  });

  it.each(["linux", "darwin"] as const)("keeps the %s hook command as it was", (platform) => {
    expect(codexActivityHookCommand("/daemon/assets/hooks/activity-relay.cjs", platform)).toBe('node "/daemon/assets/hooks/activity-relay.cjs"');
  });

  describe("Claude relay ownership", () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    afterEach(() => { Object.defineProperty(process, "platform", platform); });
    const disable = async (commands: string[]) => {
      const cwd = path.resolve("windows-hook-fixture");
      const settingsPath = path.join(cwd, ".claude", "settings.local.json");
      const files: Record<string, string> = { [settingsPath]: JSON.stringify({ hooks: { Stop: [{ hooks: commands.map(command => ({ type: "command", command })) }] } }) };
      const adapter = new ClaudeCodeAdapter({ tmux: {} as TmuxAdapter, fsOps: {
        readFile: file => files[file]!, writeFile: (file, content) => { files[file] = content; },
        exists: file => file in files, mkdirp: () => {}, copyFile: (source, target) => { files[target] = files[source]!; },
      } });
      await adapter.project({ runtime: "claude-code", cwd, entries: [], startup: {}, conflicts: [], noOps: [], diagnostics: [] } as ProjectionPlan,
        { cwd, tmuxSession: null } as NodeBinding);
      return (JSON.parse(files[settingsPath]!).hooks?.Stop?.[0]?.hooks ?? []).map((hook: { command: string }) => hook.command);
    };
    const owned = `node ${shellQuote("C:\\Old Instance\\state\\claude-activity-hooks\\activity-relay.cjs")}`;
    const legacy = `node ${shellQuote("C:\\Old Project\\.openrig\\hooks\\scripts\\activity-relay.cjs")}`;
    const user = `echo ${shellQuote("C:\\Old Instance\\state\\claude-activity-hooks\\activity-relay.cjs")}`;

    it("removes only owned Windows Claude relay hooks when disabled", async () => {
      Object.defineProperty(process, "platform", { ...platform, value: "win32" });
      expect(await disable([owned, legacy, user])).toEqual([user]);
    });

    it.each(["linux", "darwin"] as const)("never owns a backslash path on %s, where a backslash is a filename character", async (host) => {
      Object.defineProperty(process, "platform", { ...platform, value: host });
      const posixOwned = `node ${shellQuote("/old/instance/state/claude-activity-hooks/activity-relay.cjs")}`;
      expect(await disable([owned, legacy, user, posixOwned])).toEqual([owned, legacy, user]);
    });
  });

  it.runIf(process.platform === "win32")("pre-trusts the native Git project key for a nested workspace without replacing user state", () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "openrig-native-trust-"))); temporary.push(root);
    const repo = path.join(root, "repository"), cwd = path.join(repo, "nested space"), home = path.join(root, "home");
    mkdirSync(cwd, { recursive: true }); mkdirSync(home);
    execFileSync("git", ["init", "--quiet", repo], { windowsHide: true });
    const statePath = path.join(home, ".claude.json");
    writeFileSync(statePath, JSON.stringify({ theme: "user-selected", projects: { elsewhere: { userValue: 7 } } }));
    const adapter = new ClaudeCodeAdapter({ tmux: {} as TmuxAdapter, fsOps: {
      homedir: home, exists: existsSync, readFile: file => readFileSync(file, "utf8"),
      writeFile: (file, content) => writeFileSync(file, content),
      mkdirp: directory => { mkdirSync(directory, { recursive: true }); },
      copyFile: () => { throw new Error("No resource projection in trust bootstrap"); },
    } });
    adapter.ensureManagedBootstrap({ cwd });
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    expect(state.projects[repo.replace(/\\/g, "/")].hasTrustDialogAccepted).toBe(true);
    expect(state.projects[cwd.replace(/\\/g, "/")].hasTrustDialogAccepted).toBe(true);
    expect(state.theme).toBe("user-selected");
    expect(state.projects.elsewhere).toEqual({ userValue: 7 });
    expect(state.projects[path.dirname(repo).replace(/\\/g, "/")]).toBeUndefined();
  });

  it.runIf(process.platform === "win32")("executes a projected Codex hook through cmd with stdin and metacharacter paths", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "openrig-native-hook-")); temporary.push(root);
    const dir = path.join(root, "O'Brien %OPENRIG_NOT_A_VARIABLE% $ & spaces"); mkdirSync(dir);
    const relay = path.join(dir, "relay.cjs");
    writeFileSync(relay, 'process.stdin.setEncoding("utf8"); let data=""; process.stdin.on("data",s=>data+=s); process.stdin.on("end",()=>process.stdout.write(JSON.stringify({file:__filename,input:JSON.parse(data)})));');
    const home = path.join(root, "codex-home");
    const adapter = new CodexRuntimeAdapter({ tmux: {} as TmuxAdapter, codexHome: home, activityRelayPath: relay, fsOps: {
      readFile: file => readFileSync(file, "utf8"), writeFile: (file, content) => writeFileSync(file, content),
      exists: file => { try { readFileSync(file); return true; } catch { return false; } },
      mkdirp: dir => { mkdirSync(dir, { recursive: true }); },
    } });
    adapter.ensureCodexActivityHooks();
    const config = readFileSync(path.join(home, "config.toml"), "utf8");
    const command = /^command = '([^']+)'$/m.exec(config)![1]!;
    const output = execFileSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", command], { input: '{"hook_event_name":"Stop"}', encoding: "utf8", timeout: 20000 });
    expect(JSON.parse(output)).toEqual({ file: relay, input: { hook_event_name: "Stop" } });
    const { key, hash } = computeCodexHookTrust("Stop", { keySource: path.join(home, "config.toml"), command, timeoutSec: 5 });
    expect(config).toContain(`[hooks.state.${JSON.stringify(key)}]`);
    expect(config).toContain(`trusted_hash = ${JSON.stringify(hash)}`);
    writeFileSync(relay, "process.exit(7)");
    expect(spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", command], { encoding: "utf8", timeout: 20000 }).status).toBe(7);
  });
});
