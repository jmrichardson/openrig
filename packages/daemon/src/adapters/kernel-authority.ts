import { validateClaudePermissionRules } from "../domain/claude-permission-rules.js";
import type { NodeBinding } from "../domain/runtime-adapter.js";
import { nonInterruptiveArgs } from "./non-interruptive.js";
import { isValidThresholdPercent } from "../domain/claude-compaction-enforcer.js";
import { SettingsStore } from "../domain/user-settings/settings-store.js";
import { shellQuote } from "./shell-quote.js";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

// Command families used for rig lifecycle, substrate inspection, remote operations and upgrades.
// These are tool allowances, not containment: node/npm/python/ssh can themselves run arbitrary code.
export const KERNEL_CLAUDE_ALLOW = [
  "Skill", "Read", "Edit", "Write", "Glob", "Grep", "WebFetch",
  ...["rig", "tmux", "node", "npm", "git", "ssh", "scp", "rsync", "curl",
    "uname", "ps", "pgrep", "lsof", "df", "du", "ls", "cat", "head", "tail", "rg", "grep",
    "find", "stat", "date", "sleep", "mkdir", "cp", "mv", "chmod", "tar", "shasum",
    "cd", "pwd", "echo", "printf", "wc", "sort", "python", "python3"]
    .map(command => `Bash(${command}:*)`),
  "Bash(command -v:*)",
  // Read-only provider login checks, so the operator can check a chosen team's provider without a prompt.
  "Bash(claude auth status:*)", "Bash(codex login status:*)",
  "Read(~/**)",
];

// Team defaults are command allowances, not containment. A project's test runner can run code.
// Native deny/ask rules remain in force. The session hook owns generated lifecycle
// asks so that a help invocation is not caught by an unconditional ask prefix.
// Team agents run most rig commands without a prompt. The commands that start, stop or remove teams or
// agents ask, and so do six kept for a person: import (its --instantiate mode launches nodes, and a
// prefix can't tell its modes apart), seat set-permissions and policy apply under both spellings (an
// explicit permission choice stays with a person), setup (its --policy option records one, and a prefix
// can't tell that from ordinary setup), and compact (it replaces a peer's working context). Other rig
// commands (archive, attach, config set, seat set-model and the like) fall under the Bash(rig:*) allowance.
export const TEAM_CLAUDE_ALLOW = [
  "Skill", "Read(./**)", "Glob", "Grep", "Bash(rig:*)",
  ...["pwd", "ls", "cat", "head", "tail", "rg", "grep", "find"].map(command => `Bash(${command}:*)`),
  ...["npm test", "npm run test", "pnpm test", "pnpm run test", "yarn test", "yarn run test",
    "bun test", "bun run test", "node --test", "npx vitest", "npx jest", "pytest", "python -m pytest",
    "python3 -m pytest", "go test", "cargo test", "make test"].map(command => `Bash(${command}:*)`),
];
export const TEAM_CLAUDE_ASK = [
  "up", "down", "start", "launch", "restore", "fork", "bootstrap", "create", "add", "remove",
  "grow", "shrink", "expand", "destroy", "handover", "env down",
  "daemon start", "daemon stop", "bundle install", "seat launch", "seat stop", "seat handover", "seat restart",
  "import", "seat set-permissions", "policy apply", "policy permissions apply", "setup", "compact",
].map(command => `Bash(rig ${command}:*)`);

type LaunchChoice = Pick<NodeBinding, "kernelAuthority" | "teamPermissionDefault" | "nonInterruptive" | "launchPosture" | "permissionMode" | "claudePermissions"> & {
  /** Whether OpenRig's managed compaction acts on this Claude launch; read from the policy when absent. */
  managedCompaction?: boolean;
};

/** OpenRig's managed compaction acts on Claude seats while its policy is on with a threshold the enforcer accepts (it
 *  treats any other threshold as off). Read fresh at each launch; an unreadable policy reads as off. */
export function managedCompactionActive(store: Pick<SettingsStore, "resolveClaudeCompactionPolicy"> = new SettingsStore()): boolean {
  try {
    const policy = store.resolveClaudeCompactionPolicy();
    return policy.enabled === true && isValidThresholdPercent(policy.thresholdPercent);
  } catch {
    return false;
  }
}

/** While managed compaction acts on a Claude session, Claude's own idle compaction is turned off in the session's one
 *  --settings value (merged into it, or as the only one), so the session compacts through OpenRig's sequence. Claude
 *  Code before 2.1.290 ignores the key. Higher-precedence managed settings still win. */
function withIdleCompactionOff(args: string[], on: boolean): string[] {
  if (!on) return args;
  const at = args.indexOf("--settings");
  if (at === -1) return [...args, "--settings", JSON.stringify({ idleCompaction: false })];
  const settings = JSON.parse(args[at + 1]!) as Record<string, unknown>;
  return [...args.slice(0, at + 1), JSON.stringify({ ...settings, idleCompaction: false }), ...args.slice(at + 2)];
}

/** The PowerShell(x:*) rule for each Bash(x:*) one, in the same order. */
function powerShellRules(rules: string[]): string[] {
  return rules.flatMap(rule => {
    const family = /^Bash\((.+:\*)\)$/.exec(rule)?.[1];
    return family ? [`PowerShell(${family})`] : [];
  });
}

/** On native Windows Claude Code runs commands through its PowerShell tool, which Bash rules neither allow nor
 *  restrict, so each Bash(x:*) rule is followed there by the same family's PowerShell(x:*) one. */
function withPowerShellRules(rules: string[], platform: NodeJS.Platform): string[] {
  if (platform !== "win32") return rules;
  return rules.flatMap(rule => [rule, ...powerShellRules([rule])]);
}

function claudeCommandSettings(allow: string[], ask: string[], platform: NodeJS.Platform): string[] {
  const hook = fileURLToPath(new URL("../../assets/claude-team-permissions.cjs", import.meta.url));
  if (!existsSync(hook)) {
    // Without the hook every ask is a native rule, for both tools on native Windows.
    const permissions = { allow: withPowerShellRules(allow, platform), ...(ask.length ? { ask: withPowerShellRules(ask, platform) } : {}) };
    return ["--settings", JSON.stringify({ permissions })];
  }
  // Native Windows: Claude's own PowerShell parser is the primary gate for lifecycle asks, through native PowerShell
  // ask rules. The hook also asks for spellings a prefix rule may miss (rig.cmd and other suffixes, odd case or
  // escapes). The cost is that `rig <lifecycle> --help` prompts under PowerShell there. Bash asks stay hook-only.
  const nativeAsk = platform === "win32" ? powerShellRules(ask) : [];
  const policy = Buffer.from(JSON.stringify({ allow, ask })).toString("base64");
  const command = [process.execPath, hook, policy].map(shellQuote).join(" ");
  const bash = { matcher: "Bash", hooks: [{ type: "command", command, timeout: 5 }] };
  // The PowerShell tool's hook is exec form (Claude Code 2.1.139 and later), which starts node with no shell. Claude runs a
  // shell-form command in Git Bash, or in PowerShell when Git Bash is missing, where this POSIX quoting fails: Claude
  // Code before 2.1.299 then runs the command unasked, and 2.1.299 and later block every PowerShell command.
  const powershell = { matcher: "PowerShell", hooks: [{ type: "command", command: process.execPath, args: [hook, policy], timeout: 5 }] };
  return ["--settings", JSON.stringify({
    permissions: { allow: withPowerShellRules(allow, platform), ...(nativeAsk.length ? { ask: nativeAsk } : {}) },
    hooks: { PreToolUse: platform === "win32" ? [bash, powershell] : [bash] },
  })];
}

/** Session flags only; never writes a personal/project permission file. `platform` is the launch host's (tests set it). */
export function operationalLaunchArgs(runtime: string, choice: LaunchChoice, platform: NodeJS.Platform = process.platform): string[] {
  if (runtime === "codex") {
    // Managed seats leave Codex upgrades to the operator. This is launch-local;
    // it does not write config or accept a rate-limit model switch.
    return ["-c", "check_for_update_on_startup=false", ...nonInterruptiveArgs(runtime,
      choice.kernelAuthority ? { launchPosture: "full_bypass", nonInterruptive: true } : choice)];
  }
  if (runtime === "claude-code") {
    const args = withIdleCompactionOff(claudeOperationalArgs(choice, platform), choice.managedCompaction ?? managedCompactionActive());
    if (choice.claudePermissions === undefined) return args;
    const rules = validateClaudePermissionRules(choice.claudePermissions);
    const at = args.indexOf("--settings");
    const settings = at < 0 ? {} : JSON.parse(args[at + 1]!) as Record<string, unknown>;
    const permissions = (settings.permissions ?? {}) as { allow?: string[]; deny?: string[] };
    const value = JSON.stringify({ ...settings, permissions: { ...permissions,
      allow: [...(permissions.allow ?? []), ...rules.allow], deny: [...(permissions.deny ?? []), ...rules.deny] } });
    return at < 0 ? [...args, "--settings", value] : [...args.slice(0, at + 1), value, ...args.slice(at + 2)];
  }
  return choice.kernelAuthority ? [] : nonInterruptiveArgs(runtime, choice);
}

function claudeOperationalArgs(choice: LaunchChoice, platform: NodeJS.Platform): string[] {
  if (choice.kernelAuthority) return claudeCommandSettings(KERNEL_CLAUDE_ALLOW, [], platform);
  if (choice.teamPermissionDefault && !choice.permissionMode && (!choice.launchPosture || choice.launchPosture === "floor")) {
    return claudeCommandSettings(TEAM_CLAUDE_ALLOW, TEAM_CLAUDE_ASK, platform);
  }
  return nonInterruptiveArgs("claude-code", choice);
}

export function operationalLaunchArg(runtime: string, choice: LaunchChoice): string {
  return operationalLaunchArgs(runtime, choice).map(arg => ` ${shellQuote(arg)}`).join("");
}
