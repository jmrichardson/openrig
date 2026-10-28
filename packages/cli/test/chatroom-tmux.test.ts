import { afterEach, expect, it, vi } from "vitest";
import { Command } from "commander";
import type { DaemonClient } from "../src/client.js";
import { STATE_FILE, type DaemonState, type LifecycleDeps } from "../src/daemon-lifecycle.js";
import type { StatusDeps } from "../src/commands/status.js";

const child = vi.hoisted(() => ({ execSync: vi.fn(), execFileSync: vi.fn() }));
vi.mock("node:child_process", async (original) => ({ ...await original<object>(), execSync: child.execSync, execFileSync: child.execFileSync }));
const { chatroomCommand, windowsChatroomWatchCommand } = await import("../src/commands/chatroom.js");

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  child.execSync.mockReset();
  child.execFileSync.mockReset();
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

function deps(): StatusDeps {
  const state: DaemonState = { pid: 123, port: 7433, db: "test.sqlite", startedAt: "2026-04-01T00:00:00Z" };
  const lifecycleDeps = {
    spawn: vi.fn(), kill: vi.fn(() => true), writeFile: vi.fn(), removeFile: vi.fn(), mkdirp: vi.fn(), openForAppend: vi.fn(() => 3),
    isProcessAlive: vi.fn(() => true), fetch: vi.fn(async () => ({ ok: true })),
    exists: vi.fn((p: string) => p === STATE_FILE),
    readFile: vi.fn((p: string) => p === STATE_FILE ? JSON.stringify(state) : null),
  } as unknown as LifecycleDeps;
  const client = { baseUrl: "http://127.0.0.1:7433", get: vi.fn(async () => ({ status: 200, data: [{ id: "rig-1", name: "my-rig", nodeCount: 1 }] })) };
  return { lifecycleDeps, clientFactory: () => client as unknown as DaemonClient };
}

async function watchInTmux(): Promise<string[]> {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => { lines.push(String(line)); });
  vi.spyOn(console, "error").mockImplementation((line: unknown) => { lines.push(String(line)); });
  await new Command().exitOverride().addCommand(chatroomCommand(deps())).parseAsync(["node", "rig", "chatroom", "watch", "my-rig", "--tmux"]);
  return lines;
}

it("starts the POSIX watcher as `rig chatroom watch` from the tmux server's PATH", async () => {
  Object.defineProperty(process, "platform", { ...platform, value: "linux" });
  expect(await watchInTmux()).toContain("Started watch in tmux session: chatroom@my-rig");
  expect(child.execSync).toHaveBeenCalledWith('tmux new-session -d -s "chatroom@my-rig" "rig chatroom watch "my-rig""', { stdio: "ignore" });
  expect(child.execFileSync).not.toHaveBeenCalled();
});

it("keeps the POSIX hint when the tmux session cannot be created", async () => {
  Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
  child.execSync.mockImplementation(() => { throw new Error("duplicate session: chatroom@my-rig"); });
  expect(await watchInTmux()).toContain("Failed to create tmux session 'chatroom@my-rig'. It may already exist.");
  expect(process.exitCode).toBe(1);
});

it("starts the Windows watcher without a shell string and reports the psmux error", async () => {
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  child.execFileSync.mockImplementation(() => { throw new Error("psmux refused"); });
  expect(await watchInTmux()).toContain("Failed to create tmux session 'chatroom@my-rig': psmux refused");
  expect(child.execSync).not.toHaveBeenCalled();
  const [file, args] = child.execFileSync.mock.calls[0]!;
  expect(file).toBe("tmux");
  expect(args.slice(0, 4)).toEqual(["new-session", "-d", "-s", "chatroom@my-rig"]);
  expect(args[4]).toMatch(/^powershell.exe -NoLogo -NoProfile -EncodedCommand /);
});

it("starts a Windows chatroom watcher through the current Node entry, not an npm shell shim", () => {
  const command = windowsChatroomWatchCommand("Team's $(literal)&chat");
  expect(command).toMatch(/^powershell.exe -NoLogo -NoProfile -EncodedCommand /);
  const script = Buffer.from(command.split(" ").at(-1)!, "base64").toString("utf16le");
  expect(script).toContain(`$openrigStart.FileName = '${process.execPath.replaceAll("'", "''")}'`);
  expect(script).toContain("bin-wrapper.js");
  expect(script).toContain('"chatroom" "watch" "Team\'\'s $(literal)&chat"');
  expect(script).not.toContain("rig.cmd");
});
