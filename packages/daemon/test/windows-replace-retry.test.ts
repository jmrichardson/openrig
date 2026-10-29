// Windows refuses to rename over a file another process holds open (an editor, an indexer, the daemon
// reading a sidecar). The two atomic writers below retry such a refusal briefly on Windows only; every
// other platform fails at once. The refusals are injected, so this runs on any host.

import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { renameSync } = vi.hoisted(() => ({ renameSync: vi.fn() }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, renameSync };
});

import { FileWriteError, FileWriteService } from "../src/domain/files/file-write-service.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const setPlatform = (value: NodeJS.Platform) => Object.defineProperty(process, "platform", { ...platform, value });
const refusal = (code: string) => Object.assign(new Error(`${code}: operation not permitted, rename`), { code });

let root: string;
beforeEach(async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  renameSync.mockReset();
  renameSync.mockImplementation(actual.renameSync);
  root = nodeFs.realpathSync(nodeFs.mkdtempSync(path.join(os.tmpdir(), "openrig-replace-retry-")));
});
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  nodeFs.rmSync(root, { recursive: true, force: true });
});

describe("FileWriteService.writeAtomic rename", () => {
  const write = () => {
    const file = path.join(root, "note.md");
    nodeFs.writeFileSync(file, "old");
    const service = new FileWriteService({ allowlist: [{ name: "work", canonicalPath: root }], auditFilePath: path.join(root, "audit.jsonl") });
    return () => service.writeAtomic({
      rootName: "work", path: "note.md", content: "new", actor: "editor@rig",
      expectedMtime: nodeFs.statSync(file).mtime.toISOString(), expectedContentHash: createHash("sha256").update("old").digest("hex"),
    });
  };

  it.each(["EPERM", "EACCES", "EBUSY"])("retries a transient %s on Windows until the reader lets go", (code) => {
    setPlatform("win32");
    renameSync.mockImplementationOnce(() => { throw refusal(code); }).mockImplementationOnce(() => { throw refusal(code); });
    write()();
    expect(renameSync).toHaveBeenCalledTimes(3);
    expect(nodeFs.readFileSync(path.join(root, "note.md"), "utf8")).toBe("new");
  });

  it("gives up on Windows after a bounded number of attempts, leaving no temp file", () => {
    setPlatform("win32");
    renameSync.mockImplementation(() => { throw refusal("EPERM"); });
    expect(write()).toThrow(FileWriteError);
    expect(renameSync).toHaveBeenCalledTimes(100);
    expect(nodeFs.readdirSync(root).filter((name) => name.startsWith(".openrig-write-"))).toEqual([]);
  });

  it.each(["linux", "darwin"] as const)("fails at once on %s", (host) => {
    setPlatform(host);
    renameSync.mockImplementationOnce(() => { throw refusal("EPERM"); });
    expect(write()).toThrow(/failed to atomically rename/);
    expect(renameSync).toHaveBeenCalledTimes(1);
    expect(nodeFs.readFileSync(path.join(root, "note.md"), "utf8")).toBe("old");
  });

  it("does not retry another rename error on Windows", () => {
    setPlatform("win32");
    renameSync.mockImplementationOnce(() => { throw refusal("ENOENT"); });
    expect(write()).toThrow(FileWriteError);
    expect(renameSync).toHaveBeenCalledTimes(1);
  });
});

describe("the Claude status line collector's sidecar rename", () => {
  const collector = path.join(import.meta.dirname, "../assets/claude-statusline-context.cjs");
  // Preloaded into the collector: refuse the first renames, and report the platform under test.
  const PRELOAD = `const fs = require("fs");
const real = fs.renameSync;
let refusals = Number(process.env.FAKE_RENAME_REFUSALS);
fs.renameSync = (...args) => { if (refusals-- > 0) throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" }); return real(...args); };
Object.defineProperty(process, "platform", { value: process.env.FAKE_PLATFORM });
`;
  const run = (host: NodeJS.Platform, refusals: number) => {
    const preload = path.join(root, "preload.cjs");
    nodeFs.writeFileSync(preload, PRELOAD);
    const output = path.join(root, "context", "seat.json");
    const result = spawnSync(process.execPath, ["--require", preload, collector, output], {
      input: JSON.stringify({ context_window: { used_percentage: 12 }, session_name: "seat@rig" }),
      encoding: "utf8", env: { ...process.env, FAKE_PLATFORM: host, FAKE_RENAME_REFUSALS: String(refusals) }, timeout: 15_000,
    });
    return { result, written: nodeFs.existsSync(output) };
  };

  it("retries a held sidecar on Windows", () => {
    const { result, written } = run("win32", 2);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(written).toBe(true);
  });

  it.each(["linux", "darwin"] as const)("reports the refusal at once on %s", (host) => {
    const { result, written } = run(host, 1);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("[openrig][collector] failed to collect Claude context status line: EPERM");
    expect(written).toBe(false);
  });
});
