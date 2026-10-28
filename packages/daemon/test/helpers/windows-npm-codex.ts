import fs from "node:fs";
import path from "node:path";

/** Windows runs npm Codex from its package's Node entry, found through the codex.cmd shim on PATH
 *  (resolveWindowsCodexCommand), never through cmd.exe. Lays out that installation in `binDir` around a fake
 *  entry script and returns the directory the script runs from (its `__dirname`). */
export function installWindowsNpmCodex(binDir: string, entryScript: string): string {
  const pkg = path.join(binDir, "node_modules", "@openai", "codex");
  fs.mkdirSync(path.join(pkg, "bin"), { recursive: true });
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "@openai/codex", bin: { codex: "bin/codex.js" } }));
  fs.writeFileSync(path.join(pkg, "bin", "codex.js"), entryScript);
  fs.writeFileSync(path.join(binDir, "codex.cmd"), '@"%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n');
  return path.join(pkg, "bin");
}
