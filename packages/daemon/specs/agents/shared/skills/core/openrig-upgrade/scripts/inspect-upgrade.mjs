#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const rig = process.env.OPENRIG_RIG_BIN || "rig";

// Native Windows cannot spawn the rig.cmd/rig.ps1 shims without a shell. A Windows
// seat names its CLI entry; elsewhere it is the entry of the @openrig/cli install
// whose npm rig.cmd shim is on PATH. This Node runs the entry directly.
function windowsCliEntry() {
  if (process.env.OPENRIG_CLI_ENTRY) return process.env.OPENRIG_CLI_ENTRY;
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir || !fs.existsSync(path.join(dir, "rig.cmd"))) continue;
    const pkg = path.join(dir, "node_modules", "@openrig", "cli");
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(pkg, "package.json"), "utf8"));
      if (manifest.name === "@openrig/cli" && typeof manifest.bin?.rig === "string") return path.join(pkg, manifest.bin.rig);
    } catch {
      // Not an npm global prefix; keep looking.
    }
  }
  return undefined;
}

function spawnRig(args, options) {
  const entry = !process.env.OPENRIG_RIG_BIN && process.platform === "win32" && windowsCliEntry();
  return entry ? spawnSync(process.execPath, [entry, ...args], options) : spawnSync(rig, args, options);
}

function probe(name, args, next) {
  const result = spawnRig(args, { encoding: "utf8" });
  const stdout = result.stdout?.trim() || "";
  const stderr = result.stderr?.trim() || "";
  if (result.status === 0) {
    let value = stdout;
    try {
      value = JSON.parse(stdout);
    } catch {
      // Versions and older surfaces may intentionally return plain text.
    }
    return { name, ok: true, command: [rig, ...args], value };
  }
  return {
    name,
    ok: false,
    command: [rig, ...args],
    exitCode: result.status,
    error: stderr || stdout || result.error?.message || "command produced no diagnostic",
    next,
  };
}

const report = {
  schema: "openrig-upgrade-inspection/v1",
  generatedAt: new Date().toISOString(),
  rigVersion: probe("rigVersion", ["--version"], `run ${rig} --version directly and verify the installed wrapper`),
  daemonStatus: probe("daemonStatus", ["daemon", "status"], `run ${rig} daemon status and inspect daemon state and logs`),
  nodes: probe("nodes", ["ps", "--nodes", "-A", "--json"], `run ${rig} ps --nodes -A --json and resolve control-plane reachability before mutation`),
  plugins: probe("plugins", ["plugin", "list", "--json"], `run ${rig} plugin list --json and derive the installed plugin roots before refresh`),
};

report.ready = [report.rigVersion, report.daemonStatus, report.nodes, report.plugins].every((item) => item.ok);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
