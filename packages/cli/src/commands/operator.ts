import { Command } from "commander";
import { execFileSync, spawnSync } from "node:child_process";
import { parseLiteralLaunchWords } from "@openrig/daemon/windows-launch";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl, daemonStatusGuard, waitForKernelReady } from "../daemon-lifecycle.js";
import { daemonCommand, realDeps } from "./daemon.js";
import { launchCommand } from "./launch.js";
import { windowsOperatorDaemonStartCommand } from "../setup-platform.js";

export async function ensureOperatorDaemon(deps: {
  running(): Promise<boolean>; start(): Promise<void>;
}): Promise<boolean> {
  if (await deps.running()) return false;
  await deps.start();
  if (!(await deps.running())) throw new Error("OpenRig daemon did not become available; the operator was not opened.");
  return true;
}

interface Pane { label: string; seat: string; paneCommand: string }
export interface OperatorDeps {
  terminal?: () => boolean;
  ensureDaemon?: () => Promise<boolean | void>;
  preview?: () => Promise<Pane[]>;
  waitForKernel?: () => Promise<void>;
  restoreOperator?: () => Promise<void>;
  attach?: (argv: string[]) => number;
}

export function operatorCommand(deps: OperatorDeps = {}): Command {
  const command = new Command("operator")
    .description("Start OpenRig if needed, resume its operator, and open only that conversation here")
    .action(async () => {
      if (!(deps.terminal ?? (() => Boolean(process.stdin.isTTY && process.stdout.isTTY)))()) {
        throw new Error("Run rig operator in an interactive terminal, such as Zed's integrated terminal.");
      }
      const client = async () => {
        const status = await getDaemonStatus(realDeps());
        if (!daemonStatusGuard(status)) throw new Error("The OpenRig daemon is unavailable.");
        return new DaemonClient(getDaemonUrl(status));
      };
      const wait = deps.waitForKernel ?? (async () => { await waitForKernelReady((await client()).baseUrl, 60_000); });
      const started = await (deps.ensureDaemon ?? (() => ensureOperatorDaemon({
        running: async () => { const status = await getDaemonStatus(realDeps()); return status.state === "running" && status.healthy !== false; },
        start: async () => {
          if (process.platform === "win32") {
            // A detached child can still belong to the terminal's Windows job.
            // Launch through the user's scheduler so closing a terminal cannot
            // terminate the daemon along with its client process tree.
            const encoded = windowsOperatorDaemonStartCommand().split("-EncodedCommand ")[1]!;
            execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { timeout: 150000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
          } else await daemonCommand().parseAsync(["node", "rig", "start"]);
          if (process.exitCode) throw new Error("Could not start OpenRig; the operator was not opened.");
        },
      })))();
      if (started === true) await wait();
      const preview = deps.preview ?? (async () => {
        const result = await (await client()).get<{ composed?: { opened: Pane[] }; error?: string }>("/api/terminal/preview?view=saved%3Akernel&provider=herdr");
        if (result.status !== 200 || !result.data.composed) throw new Error(result.data.error ?? "Could not resolve the operator conversation.");
        return result.data.composed.opened;
      });
      const find = (panes: Pane[]) => panes.find(pane => pane.label === "operator");
      let operator = find(await preview());
      if (!operator) {
        if (started !== true) await wait();
        operator = find(await preview());
      }
      if (!operator) {
        await (deps.restoreOperator ?? (async () => {
          console.log("Resuming the saved operator conversation...");
          await launchCommand().parseAsync(["node", "rig", "kernel", "operator.agent"]);
          if (process.exitCode) throw new Error("Operator recovery needs attention; no blank conversation was created. Inspect rig ps --nodes --rig kernel.");
        }))();
        operator = find(await preview());
      }
      if (!operator) throw new Error("The operator is still unavailable after recovery. Inspect rig ps --nodes --rig kernel.");
      const argv = parseLiteralLaunchWords(operator.paneCommand);
      const attach = deps.attach ?? ((words: string[]) => {
        const env = { ...process.env };
        for (const key of ["TMUX", "PSMUX_SESSION", "PSMUX_TARGET_SESSION", "PSModulePath"]) delete env[key];
        const result = spawnSync(words[0]!, words.slice(1), { stdio: "inherit", env, shell: false });
        if (result.error) throw result.error;
        return result.status ?? 1;
      });
      console.log("Opening operator here. Ctrl+B, then D returns to your shell; the operator keeps running.");
      process.exitCode = attach(argv);
    });
  return command;
}
