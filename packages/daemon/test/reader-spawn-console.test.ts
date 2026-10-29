// How the Codex app-server readers and the Claude auth-status reader start their child, per platform. A
// detached Windows child gets no console, so a console program it starts (npm's codex.js starts codex.exe)
// would open a visible window; POSIX keeps the reader in its own process group. spawn and execFile
// are fakes here: no Codex or Claude runs.

import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawn, execFile } = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({ ...(await importOriginal<typeof import("node:child_process")>()), spawn, execFile }));

import { codexNetworkDefaultReader, stopGroup } from "../src/domain/codex-network-default.js";
import { codexUsageReader } from "../src/domain/provider/codex-usage-reader.js";
import { claudeAuthStatusReader } from "../src/domain/provider/claude-auth-status-reader.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const setPlatform = (value: NodeJS.Platform) => Object.defineProperty(process, "platform", { ...platform, value });

/** A child that exits at once without answering, with no pid (so no cleanup is attempted). */
function exitingChild(): ChildProcess {
  const child = Object.assign(new EventEmitter(), { pid: undefined, exitCode: null, signalCode: null, stdin: new PassThrough(), stdout: new PassThrough() });
  setImmediate(() => { child.exitCode = 1 as never; child.stdout.end(); child.emit("exit", 1, null); });
  return child as unknown as ChildProcess;
}

let bin: string;
beforeEach(() => {
  vi.resetAllMocks();
  spawn.mockImplementation(() => exitingChild());
  bin = fs.mkdtempSync(nodePath.join(os.tmpdir(), "openrig-reader-spawn-"));
  // The executables each platform's resolution looks for; never run.
  for (const name of ["codex.exe", "claude", "claude.exe"]) fs.writeFileSync(nodePath.join(bin, name), "", { mode: 0o755 });
});
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  fs.rmSync(bin, { recursive: true, force: true });
});

const readers = {
  "codex network default": () => codexNetworkDefaultReader({ launchPath: bin, deadlineMs: 1_000, graceMs: 10 })(bin),
  "codex usage": () => codexUsageReader({ launchPath: bin, home: bin, deadlineMs: 1_000, graceMs: 10 })(),
  "claude auth status": () => claudeAuthStatusReader({ launchPath: bin, timeoutMs: 1_000, graceMs: 10 })(),
};

describe("reader child start", () => {
  it.each(Object.keys(readers))("%s: its own process group on POSIX", async (name) => {
    for (const host of ["linux", "darwin"] as const) {
      setPlatform(host);
      spawn.mockClear();
      await readers[name as keyof typeof readers]();
      expect(spawn, host).toHaveBeenCalledTimes(1);
      expect(spawn.mock.calls[0]![2], host).toMatchObject({ detached: true });
    }
  });

  it.each(Object.keys(readers))("%s: not detached on Windows, and hidden", async (name) => {
    setPlatform("win32");
    await readers[name as keyof typeof readers]();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0]![2]).toMatchObject({ detached: false, windowsHide: true });
  });
});

describe("Windows reader cleanup", () => {
  it("returns, rather than throwing, when taskkill fails for a reader that has not exited", async () => {
    setPlatform("win32");
    execFile.mockImplementation((_file: string, _args: string[], _options: unknown, callback: (error: Error) => void) => {
      callback(Object.assign(new Error("taskkill failed"), { code: 1 }));
    });
    const child = Object.assign(new EventEmitter(), { pid: 4242, exitCode: null, signalCode: null, stdin: new PassThrough() }) as unknown as ChildProcess;
    await expect(stopGroup(child, 10)).resolves.toBeUndefined();
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile.mock.calls[0]![1]).toEqual(["/PID", "4242", "/T", "/F"]);
  });
});
