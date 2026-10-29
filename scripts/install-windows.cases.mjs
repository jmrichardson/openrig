// Native Windows cases, selected by install.test.mjs on Windows.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";

const script = path.join(import.meta.dirname, "install.ps1");
const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const repo = path.resolve(import.meta.dirname, "..");

// install.ps1 finds node.exe with Get-Command, so a fake Node has to be native: the test forwarder
// (test/native-node-forwarder.cs, compiled once and cached as test/stub-runtimes.ts caches it) runs
// node.js beside it, which reports `version` and hands every other call to this Node.
function installFakeNode(tools, version) {
  const source = fs.readFileSync(path.join(repo, "test", "native-node-forwarder.cs"), "utf8");
  const cache = path.join(repo, "node_modules", ".cache", `openrig-test-exe-${createHash("sha256").update(source).digest("hex")}`);
  const executable = path.join(cache, "program.exe");
  if (!fs.existsSync(executable)) {
    fs.mkdirSync(cache, { recursive: true });
    const staged = path.join(cache, `${randomUUID()}.exe`);
    const command = `$ErrorActionPreference='Stop'; Add-Type -TypeDefinition '${source.replaceAll("'", "''")}' -OutputAssembly '${staged.replaceAll("'", "''")}' -OutputType ConsoleApplication`;
    try {
      execFileSync(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")], { windowsHide: true, timeout: 60_000, stdio: "pipe" });
      try { fs.renameSync(staged, executable); } catch (error) { if (!fs.existsSync(executable)) throw error; }
    } finally { fs.rmSync(staged, { force: true }); }
  }
  fs.copyFileSync(executable, path.join(tools, "node.exe"));
  fs.writeFileSync(path.join(tools, "node.js"), `#!${process.execPath}
if (process.argv[2] === "--version") console.log(${JSON.stringify(version)});
else process.exitCode = require("node:child_process").spawnSync(process.execPath, process.argv.slice(2), { stdio: "inherit" }).status ?? 1;
`);
}

function fixture(t, overrides = {}, { nodeVersion } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "openrig native [install] "));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const tools = path.join(directory, "tools");
  const modules = path.join(directory, "global modules");
  const installed = path.join(modules, "@openrig", "cli");
  fs.mkdirSync(tools, { recursive: true });
  fs.mkdirSync(path.join(installed, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(installed, "dist"), { recursive: true });
  const calls = path.join(directory, "calls.log");
  if (nodeVersion) installFakeNode(tools, nodeVersion);
  fs.writeFileSync(path.join(tools, "npm.cmd"), `@echo off\r\necho npm:%*>>"%TEST_CALLS%"\r\nif "%1"=="--version" (echo 10.9.4& exit /b 0)\r\nif "%1"=="root" (echo %TEST_MODULES%& exit /b 0)\r\nif "%1"=="install" (echo native npm output& exit /b %INSTALL_EXIT%)\r\nexit /b 90\r\n`);
  fs.writeFileSync(path.join(installed, "scripts", "check-abi.mjs"), `import fs from 'node:fs'; fs.appendFileSync(process.env.TEST_CALLS, 'abi:check\\n'); process.exitCode = Number(process.env.ABI_EXIT);`);
  fs.writeFileSync(path.join(installed, "dist", "bin-wrapper.js"), `const fs = require('node:fs'); fs.appendFileSync(process.env.TEST_CALLS, 'rig:' + process.argv.slice(2).join(' ') + '\\n'); process.exitCode = process.argv.includes('--dry-run') ? 0 : Number(process.env.SETUP_EXIT);`);
  const env = { ...process.env, PATH: `${tools};${path.dirname(process.execPath)};${process.env.PATH}`, TEST_CALLS: calls, TEST_MODULES: modules, INSTALL_EXIT: "0", ABI_EXIT: "0", SETUP_EXIT: "0", ...overrides };
  return {
    installed,
    run: (...args) => spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, ...args], { env, encoding: "utf8", timeout: 30_000 }),
    // As typed at a PowerShell prompt, where arguments parse as PowerShell rather than as -File strings.
    runAtPrompt: (args) => spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", `& '${script.replaceAll("'", "''")}' ${args}; exit $LASTEXITCODE`], { env, encoding: "utf8", timeout: 30_000 }),
    calls: () => fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").trim().split(/\r?\n/) : [],
  };
}

test("native dry run executes nothing and describes Windows requirements", t => {
  const f = fixture(t);
  const result = f.run("-DryRun", "-Providers", "codex");
  assert.equal(result.status, 0, result.stderr);
  for (const text of ["Node.js 22 or 24", "npm.cmd", "Git for Windows", "portable", "No WSL", "--providers codex", "Dry run: no commands"]) assert.ok(result.stdout.includes(text), text);
  assert.deepEqual(f.calls(), []);
});

test("native npm.cmd and installed literal paths preserve provider/full selection", t => {
  const f = fixture(t);
  const result = f.run("-Providers", "codex", "-Full");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.calls(), ["npm:--version", "npm:install -g @openrig/cli", "npm:root -g", "abi:check", "rig:setup --providers codex --full --dry-run", "rig:setup --providers codex --full"]);
});

for (const [variable, code] of [["INSTALL_EXIT", 37], ["ABI_EXIT", 38], ["SETUP_EXIT", 39]]) {
  test(`native ${variable} failure preserves status and stops installation`, t => {
    const f = fixture(t, { [variable]: String(code) });
    const result = f.run("-Providers", "claude");
    assert.equal(result.status, code, result.stderr);
    assert.match(result.stderr, /FAILED/);
    assert.ok(!result.stdout.includes("Follow the next steps"));
    if (variable !== "SETUP_EXIT") assert.ok(!f.calls().some(call => call.startsWith("rig:")));
  });
}

test("a PowerShell prompt's comma list selects both providers", t => {
  const f = fixture(t);
  const result = f.runAtPrompt("-Providers claude,codex");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.calls().filter(call => call.startsWith("rig:")), ["rig:setup --providers claude,codex --dry-run", "rig:setup --providers claude,codex"]);
});

for (const version of ["v20.18.0", "v23.11.0"]) {
  test(`native Node ${version} is refused before npm runs`, t => {
    const f = fixture(t, {}, { nodeVersion: version });
    const result = f.run("-Providers", "claude");
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Node\.js 22 or 24 is required/);
    assert.deepEqual(f.calls(), []);
  });
}

test("a later even Node major warns as untested, as the installed checker does, and installs", t => {
  const f = fixture(t, {}, { nodeVersion: "v26.1.0" });
  const result = f.run("-Providers", "claude");
  assert.equal(result.status, 0, result.stderr);
  assert.match(`${result.stdout}${result.stderr}`, /Node 26 is untested/);
  assert.deepEqual(f.calls(), ["npm:--version", "npm:install -g @openrig/cli", "npm:root -g", "abi:check", "rig:setup --providers claude --dry-run", "rig:setup --providers claude"]);
});

test("a missing node.exe, or an installed package without its checker, stops the installation", t => {
  const f = fixture(t, { PATH: path.join(repo, "absent") });
  const missing = f.run("-Providers", "claude");
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /node\.exe/);
  assert.deepEqual(f.calls(), []);

  const g = fixture(t);
  fs.rmSync(path.join(g.installed, "scripts", "check-abi.mjs"));
  const unchecked = g.run("-Providers", "claude");
  assert.equal(unchecked.status, 1);
  assert.match(unchecked.stderr, /Installed Node\/SQLite checker not found/);
  assert.deepEqual(g.calls(), ["npm:--version", "npm:install -g @openrig/cli", "npm:root -g"]);
});
