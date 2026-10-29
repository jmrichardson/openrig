import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderWindowsManagedLaunch } from "../src/adapters/windows-launch.js";
import { claudeSeatTokenWindowsStep } from "../src/domain/claude-seat-token.js";

describe.skipIf(process.platform !== "win32")("native seat credential selection", () => {
  it("reads the selected file at launch and removes credentials that outrank it", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "rig token ' "));
    try {
      const file = path.join(dir, "subscription.txt");
      const ref = { label: "fixture", tokenFile: file };
      const script = renderWindowsManagedLaunch(process.execPath,
        ["-e", "console.log(JSON.stringify({token:process.env.CLAUDE_CODE_OAUTH_TOKEN,key:process.env.ANTHROPIC_API_KEY}))"],
        dir, { SystemRoot: process.env.SystemRoot!, TEMP: tmpdir(), ANTHROPIC_API_KEY: "wrong-fixture-key" }, [], claudeSeatTokenWindowsStep(ref, "$openrigChildEnv"));
      // Construct the command before the file exists: only the child reads the credential.
      writeFileSync(file, "fixture-selected-subscription\r\n");
      expect(script).not.toContain("fixture-selected-subscription");
      const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8", windowsHide: true });
      expect(JSON.parse(output.trim())).toEqual({ token: "fixture-selected-subscription" });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
