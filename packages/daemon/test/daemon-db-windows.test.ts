import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const probe = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async original => ({
  ...await original<typeof import("node:child_process")>(),
  execFile: (...args: unknown[]) => {
    const callback = args.at(-1) as (error: unknown, output?: { stdout: string; stderr: string }) => void;
    try { callback(null, { stdout: probe(args[0], args[1]), stderr: "" }); }
    catch (error) { callback(error); }
  },
}));
import { daemonDatabaseWarnings } from "../src/daemon-db-path.js";

describe.skipIf(process.platform !== "win32")("Windows database ownership", () => {
  let home: string, db: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "rig-windows-owner-"));
    db = join(home, "openrig.sqlite");
    writeFileSync(db, "");
    probe.mockReset().mockReturnValue("");
  });
  afterEach(() => { vi.unstubAllGlobals(); rmSync(home, { recursive: true, force: true }); });
  it("uses Restart Manager and accepts no file owners without requiring lsof", async () => {
    expect(await daemonDatabaseWarnings(db, home)).toEqual([]);
    const [program, args] = probe.mock.calls[0]!;
    expect(program).toMatch(/powershell.exe$/i);
    expect(Buffer.from(args.at(-1), "base64").toString("utf16le")).toContain("rstrtmgr.dll");
  });
  it("stops only after file owner, daemon record and health PID agree", async () => {
    const pid = process.pid + 100000;
    probe.mockReturnValue(String(pid));
    writeFileSync(join(home, "daemon.json"), JSON.stringify({ pid, port: 17433, db }));
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ pid }) })));
    await expect(daemonDatabaseWarnings(db, home, undefined, { conflictPolicy: "stop", allowConflict: false })).rejects.toThrow("OPENRIG_DB_CONFLICT");
  });
  it("reports a failed native probe as unknown ownership rather than a clear database", async () => {
    probe.mockImplementation(() => { throw new Error("native query refused"); });
    const warnings = await daemonDatabaseWarnings(db, home);
    expect(warnings[0]).toContain("Windows Restart Manager file-owner query failed");
    expect(warnings[0]).toContain("ownership is unknown");
    expect(warnings[0]).not.toContain("lsof");
  });
});
