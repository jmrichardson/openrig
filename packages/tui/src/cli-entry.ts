import { existsSync } from "node:fs";
import path from "node:path";

/** Reuse the launching CLI. Elsewhere an unset entry means `rig` from PATH. On Windows, locate
 * the JavaScript entry beside a standalone TUI, or the one behind npm's rig.cmd on PATH:
 * Node's execFile cannot run that shim without a shell. */
export function resolveCliEntry(
  baseDir: string = import.meta.dirname,
  env: NodeJS.ProcessEnv = process.env,
  exists: (file: string) => boolean = existsSync,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform !== "win32") return env["OPENRIG_TUI_CLI_ENTRY"];
  if (env["OPENRIG_TUI_CLI_ENTRY"]) return env["OPENRIG_TUI_CLI_ENTRY"];
  // cmd.exe finds rig.cmd under a quoted entry such as "C:\Program Files\nodejs"; no file name contains a quote.
  const onPath = (env["PATH"] ?? "").split(";").map((dir) => dir.replaceAll('"', ""))
    .filter((dir) => path.win32.isAbsolute(dir) && exists(path.win32.join(dir, "rig.cmd")))
    .map((dir) => path.win32.join(dir, "node_modules", "@openrig", "cli", "dist", "bin-wrapper.js"));
  return [
    path.resolve(baseDir, "../../cli/dist/bin-wrapper.js"),
    path.resolve(baseDir, "../../dist/bin-wrapper.js"),
    ...onPath,
  ].find(exists);
}
