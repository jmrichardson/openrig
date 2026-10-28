import { Command } from "commander";
import { dirname } from "node:path";
import { SystemPreflight, quietPreflightExec } from "../system-preflight.js";
import { ConfigStore } from "../config-store.js";
import { getDaemonStatus, type DaemonStatus } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";

interface PreflightCommandDeps {
  exec?: (cmd: string) => Promise<string>;
  configPath?: string;
  riggedHome?: string;
  getDaemonStatus?: () => Promise<DaemonStatus>;
}

export function preflightCommand(depsOverride?: PreflightCommandDeps): Command {
  const cmd = new Command("preflight").description("Check system readiness for OpenRig");

  cmd
    .option("--json", "JSON output for agents")
    .action(async (opts: { json?: boolean }) => {
      const configStore = new ConfigStore(depsOverride?.configPath);
      const config = configStore.resolve();

      const exec = depsOverride?.exec ?? quietPreflightExec;

      const preflight = new SystemPreflight({
        exec,
        configStore,
        getDaemonStatus: depsOverride?.getDaemonStatus ?? (() => getDaemonStatus(realDeps())),
        // A Windows database path ends in a backslash-separated file name.
        riggedHome: depsOverride?.riggedHome ?? (process.platform === "win32" ? dirname(config.db.path) : config.db.path.replace(/\/[^/]+$/, "")),
      });

      const result = await preflight.run();

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        if (!result.ready) process.exitCode = 1;
        return;
      }

      for (const check of result.checks) {
        if (check.ok) {
          console.log(`✓ ${check.name}`);
          if (check.warning) console.log(`  Note: ${check.warning}`);
        } else {
          console.log(`✗ ${check.name}: ${check.error}`);
          if (check.reason) console.log(`  Why: ${check.reason}`);
          if (check.fix) console.log(`  Fix: ${check.fix}`);
        }
      }

      if (result.ready) {
        console.log("\nAll checks passed. Ready to run.");
      } else {
        const failCount = result.checks.filter((c) => !c.ok).length;
        console.log(`\n${failCount} check(s) failed. Fix the issues above and run rig preflight again.`);
        process.exitCode = 1;
      }
    });

  return cmd;
}
