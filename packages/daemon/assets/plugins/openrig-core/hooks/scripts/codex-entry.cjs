"use strict";
// Shell-neutral hook entry: Codex uses PowerShell on Windows, not a POSIX shell.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
if (!process.env.OPENRIG_SEAT_PROJECT_DIR) process.exit(0);
const node = process.env.OPENRIG_NODE;
if (!node || !fs.existsSync(node) || !fs.statSync(node).isFile()) {
  console.error("OpenRig hook: the managed Node executable is unavailable.");
  process.exit(1);
}
const action = process.argv[1];
if (!["activity", "refocus"].includes(action)) { console.error("OpenRig hook: unknown action"); process.exit(1); }
const args = action === "activity" ? ["activity-relay.cjs", "--from-plugin"] : ["refocus.cjs", "--runtime", "codex"];
const result = spawnSync(node, [path.join(__dirname, args[0]), ...args.slice(1)], { stdio: "inherit", shell: false, windowsHide: true });
if (result.error) console.error(`OpenRig hook: ${result.error.message}`);
process.exit(result.status ?? 1);
