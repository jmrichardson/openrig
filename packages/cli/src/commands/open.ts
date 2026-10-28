import { Command } from "commander";
import { spawnSync } from "node:child_process";
import { parseLiteralLaunchWords } from "@openrig/daemon/windows-launch";
import { DaemonClient } from "../client.js";
import { daemonStatusGuard, getDaemonStatus, getDaemonUrl } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";

export interface OpenHereDeps {
  terminal?: () => boolean;
  preview?: () => Promise<{ opened: { label: string; seat: string; paneCommand: string }[] }>;
  attach?: (argv: string[]) => number;
}

/** Connect a console to an existing kernel seat, without creating a desktop window. */
export function openHereCommand(deps: OpenHereDeps = {}): Command {
  return new Command("open")
    .description("Talk to the existing operator in this terminal (including Zed)")
    .argument("[role]", "operator, advisor or dashboard", "operator")
    .action(async (role: string) => {
      if (!["operator", "advisor", "dashboard"].includes(role)) throw new Error("Choose operator, advisor or dashboard.");
      if (!(deps.terminal ?? (() => Boolean(process.stdin.isTTY && process.stdout.isTTY)))()) {
        throw new Error("Run rig open in an interactive terminal, such as Zed's integrated terminal.");
      }
      const preview = deps.preview ?? (async () => {
        const status = await getDaemonStatus(realDeps());
        if (!daemonStatusGuard(status)) throw new Error("OpenRig is stopped. Run rig start first.");
        const result = await new DaemonClient(getDaemonUrl(status)).get<{ composed?: { opened: { label: string; seat: string; paneCommand: string }[] }; error?: string }>("/api/terminal/preview?view=saved%3Akernel&provider=herdr");
        if (result.status !== 200 || !result.data.composed) throw new Error(result.data.error ?? "Could not resolve the kernel conversations.");
        return result.data.composed;
      });
      const seat = (await preview()).opened.find(pane => pane.label === role);
      if (!seat) throw new Error(`The ${role} conversation is unavailable. Check rig ps --nodes --rig kernel.`);
      const argv = parseLiteralLaunchWords(seat.paneCommand);
      const attach = deps.attach ?? ((words: string[]) => {
        const env = { ...process.env };
        for (const key of ["TMUX", "PSMUX_SESSION", "PSMUX_TARGET_SESSION", "PSModulePath"]) delete env[key];
        const result = spawnSync(words[0]!, words.slice(1), { stdio: "inherit", env, shell: false });
        if (result.error) throw result.error;
        return result.status ?? 1;
      });
      console.log(`Connecting to ${role}. Detach with Ctrl+B, then D to return to your shell.`);
      process.exitCode = attach(argv);
    });
}
