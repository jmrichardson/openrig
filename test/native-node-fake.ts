import fs from "node:fs";
import path from "node:path";
import { compileWindowsTestExecutable } from "./stub-runtimes.js";

/**
 * Windows only: install `<binDir>/<name>.exe`, a native forwarder that runs `script` (saved beside it as
 * `<name>.js`) with this Node, for code that starts a runtime only from a native executable. The script's own
 * `#!` line, if any, is replaced. Returns the executable's path.
 */
export function installNativeNodeFake(binDir: string, name: string, script: string): string {
  const executable = path.join(binDir, `${name}.exe`);
  fs.copyFileSync(compileWindowsTestExecutable("native-node-forwarder.cs"), executable);
  fs.writeFileSync(path.join(binDir, `${name}.js`), `#!${process.execPath}\n${script.replace(/^#!.*\r?\n/, "")}`);
  return executable;
}
