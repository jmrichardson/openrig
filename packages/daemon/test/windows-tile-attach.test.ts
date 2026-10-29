import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tileAttachArgv } from "../src/domain/terminal/tile-attach.js";

afterEach(() => vi.unstubAllEnvs());

describe.skipIf(process.platform !== "win32")("native viewer namespace", () => {
  it.each(["D:\\daemon namespace", undefined])("uses the daemon namespace even when the terminal inherits another one: %s", namespace => {
    const dir = mkdtempSync(path.join(tmpdir(), "viewer O'Brien "));
    try {
      const mux = path.join(dir, "fake mux.ps1");
      writeFileSync(mux, `if ($args -contains 'attach') {
        @{ namespace=$env:PSMUX_DATA_DIR; tmux=$env:TMUX; session=$env:PSMUX_SESSION; target=$env:PSMUX_TARGET_SESSION } | ConvertTo-Json -Compress
      }
      exit 0
      `);
      vi.stubEnv("PSMUX_DATA_DIR", namespace);
      const [executable, ...args] = tileAttachArgv(mux, [], "worker@rig", false, 1, "win32");
      const output = execFileSync(executable!, args, { encoding: "utf8", windowsHide: true, timeout: 10_000,
        env: { ...process.env, PSMUX_DATA_DIR: "D:\\foreign", TMUX: "foreign", PSMUX_SESSION: "foreign", PSMUX_TARGET_SESSION: "foreign" } });
      expect(JSON.parse(output.trim())).toEqual({ namespace: namespace ?? null, tmux: null, session: null, target: null });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
