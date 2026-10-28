// Runs as a child of fixture-home-cleanup.test.ts: loads the shared vitest setup in a plain Node process,
// prints the homes it ended up with, and exits.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import "../../../../test/hermetic-env.setup.js";

// What a test does: make a temp dir the usual way, with os.tmpdir().
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "test-scratch-"));
fs.writeFileSync(path.join(scratch, "file"), "x");
console.log(JSON.stringify({
  openrigHome: process.env["OPENRIG_HOME"], home: process.env["HOME"], tmpdir: os.tmpdir(), scratch,
  osHome: os.homedir(), codexHome: process.env["CODEX_HOME"], claudeConfigDir: process.env["CLAUDE_CONFIG_DIR"],
  xdgConfig: process.env["XDG_CONFIG_HOME"],
  env: Object.fromEntries(["USERPROFILE", "APPDATA", "LOCALAPPDATA", "CLAUDE_CONFIG_DIR", "PI_CODING_AGENT_DIR"].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]])),
  credentialNames: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"].filter(key => process.env[key] !== undefined),
  codexVersion: execFileSync("codex", ["--version"], { encoding: "utf-8", timeout: 5000 }).trim(),
}));
// With "wait", stay alive for the test to signal: a vitest worker is ended with SIGTERM while it is running.
if (process.argv[2] === "wait") setInterval(() => {}, 1000);
