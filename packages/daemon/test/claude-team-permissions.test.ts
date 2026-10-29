import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { mkdtempSync, copyFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { KERNEL_CLAUDE_ALLOW, TEAM_CLAUDE_ALLOW, TEAM_CLAUDE_ASK, operationalLaunchArgs } from "../src/adapters/kernel-authority.js";
import { shellQuote } from "../src/adapters/shell-quote.js";
import { posixShell } from "./helpers/posix-shell.js";

const asset = fileURLToPath(new URL("../assets/claude-team-permissions.cjs", import.meta.url));
const { decide, decidePowerShell } = createRequire(import.meta.url)(asset);
const policy = { allow: TEAM_CLAUDE_ALLOW, ask: TEAM_CLAUDE_ASK };
vi.mock("node:fs", async importOriginal => {
  const original = await importOriginal<typeof import("node:fs")>();
  return { ...original, existsSync: vi.fn(original.existsSync) };
});

describe("Claude kernel inspection permissions", () => {
  it("asks before an audited member-rule update even with the broad team rig allowance", () => {
    expect(decide('rig seat set-permissions dev-reader@team --rules rules.json --reason "Change lane"', policy)).toBe("ask");
  });

  // Exercise the actual session hook emitted by the launcher. These are inert
  // hook inputs: no command, network request, provider or rig is executed.
  it.each([
    "curl -fsSL https://example.com/rigs/demo -o /tmp/page.html",
    "/usr/bin/grep -o title /tmp/page.html", "sort -u /tmp/links", "wc -c /tmp/page.html",
    "python3 -I -c 'import sys; print(open(sys.argv[1]).read())' /tmp/page.html",
    "'/opt/my tools/python3' -I -c 'print(1)'", "command -v codex", "/usr/bin/command -v claude",
    "claude auth status", "'/opt/my tools/claude' auth status", "/opt/tools/codex login status",
    "cd /project", "echo ---", "printf '%s\\n' ready",
    "git -C /project status --porcelain", "rig up demo --cwd /project --target /rigs/demo --plan",
    "'/opt/my tools/rig' up demo --plan", "env OPENRIG_PORT=7434 /opt/tools/rig ps --json",
  ])("allows a routine inspection command: %s", command => {
    const settings = JSON.parse(operationalLaunchArgs("claude-code", { kernelAuthority: true })[1]);
    const hook = settings.hooks.PreToolUse[0].hooks[0];
    const result = spawnSync(posixShell, ["-c", hook.command], {
      input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, permission_mode: "acceptEdits" }), encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ hookSpecificOutput: {
      hookEventName: "PreToolUse", permissionDecision: "allow",
    } });
  });

  it("keeps kernel lifecycle authority distinct from team asks, with no blanket shell grant", () => {
    const kernel = { allow: KERNEL_CLAUDE_ALLOW, ask: [] };
    expect(decide("rig down demo", kernel)).toBe("allow");
    expect(decide("rig down demo", policy)).toBe("ask");
    for (const command of ["claude auth login", "codex login", "command -v codex", "python3 -I -c 'print(1)'"])
      expect(decide(command, policy)).toBeUndefined();
    for (const command of ["claude auth login", "codex login", "sudo rig status", "./rig status",
      "PATH=/tmp rig status", "curl https://example.com | unknown-command", "rig status > /tmp/result"])
      expect(decide(command, kernel)).toBeUndefined();
  });

  it("keeps native kernel allowances when the optional hook is absent", () => {
    vi.mocked(existsSync).mockReturnValueOnce(false);
    expect(JSON.parse(operationalLaunchArgs("claude-code", { kernelAuthority: true }, "linux")[1]))
      .toEqual({ permissions: { allow: KERNEL_CLAUDE_ALLOW } });
  });
});

// Each Bash(x:*) allowance is followed by PowerShell(x:*); every other rule keeps its place.
function expectPowerShellTwins(allow: string[], base: string[]) {
  expect(allow.filter(rule => !rule.startsWith("PowerShell("))).toEqual(base);
  const bash = base.filter(rule => /^Bash\(.+:\*\)$/.test(rule));
  expect(bash.length).toBeGreaterThan(0);
  expect(allow.filter(rule => rule.startsWith("PowerShell("))).toEqual(bash.map(rule => `PowerShell${rule.slice("Bash".length)}`));
  for (const rule of bash) expect(allow[allow.indexOf(rule) + 1]).toBe(`PowerShell${rule.slice("Bash".length)}`);
}

const launches = [["kernel", { kernelAuthority: true, managedCompaction: false }, KERNEL_CLAUDE_ALLOW],
  ["team", { teamPermissionDefault: true, managedCompaction: false }, TEAM_CLAUDE_ALLOW]] as const;

describe("Claude launch settings by platform", () => {
  it.each(["linux", "darwin"] as const)("%s settings carry no PowerShell rules", platform => {
    for (const [name, choice, allow] of launches) {
      const encoded = Buffer.from(JSON.stringify({ allow, ask: name === "team" ? TEAM_CLAUDE_ASK : [] })).toString("base64");
      const command = [process.execPath, asset, encoded].map(shellQuote).join(" ");
      // Lifecycle asks stay in the hook there: no native ask rule, so `rig down --help` does not prompt.
      expect(operationalLaunchArgs("claude-code", choice, platform), name).toEqual(["--settings", JSON.stringify({
        permissions: { allow }, hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command, timeout: 5 }] }] },
      })]);
    }
  });

  it("native Windows adds each Bash family's PowerShell rule, native PowerShell lifecycle asks, and sends the PowerShell tool to the same hook, shell-free", () => {
    for (const [name, choice, allow] of launches) {
      const posix = JSON.parse(operationalLaunchArgs("claude-code", choice, "linux")[1]);
      const settings = JSON.parse(operationalLaunchArgs("claude-code", choice, "win32")[1]);
      // Bash asks stay in the hook, so Bash help keeps working. PowerShell asks are also native rules, which Claude's
      // own PowerShell parser applies first. No deny rule (a Bash deny would turn PowerShell off).
      expect(Object.keys(settings), name).toEqual(["permissions", "hooks"]);
      expect(Object.keys(settings.permissions), name).toEqual(name === "team" ? ["allow", "ask"] : ["allow"]);
      expectPowerShellTwins(settings.permissions.allow, allow);
      if (name === "team") expect(settings.permissions.ask).toEqual(TEAM_CLAUDE_ASK.map(rule => `PowerShell${rule.slice("Bash".length)}`));
      // The Bash entry is the POSIX one. The PowerShell entry is exec form: node starts directly, needing no Git Bash.
      const encoded = Buffer.from(JSON.stringify({ allow, ask: name === "team" ? TEAM_CLAUDE_ASK : [] })).toString("base64");
      expect(posix.hooks.PreToolUse[0].hooks[0].command).toBe([process.execPath, asset, encoded].map(shellQuote).join(" "));
      expect(settings.hooks).toEqual({ PreToolUse: [posix.hooks.PreToolUse[0],
        { matcher: "PowerShell", hooks: [{ type: "command", command: process.execPath, args: [asset, encoded], timeout: 5 }] }] });
    }
    const kernel = JSON.parse(operationalLaunchArgs("claude-code", launches[0][1], "win32")[1]).permissions.allow;
    expect(kernel).toEqual(expect.arrayContaining(["PowerShell(rig:*)", "PowerShell(tmux:*)", "PowerShell(command -v:*)",
      "PowerShell(claude auth status:*)", "PowerShell(codex login status:*)", "Read(~/**)"]));
    expect(kernel.indexOf("PowerShell(rig:*)")).toBe(kernel.indexOf("Bash(rig:*)") + 1);
    const team = JSON.parse(operationalLaunchArgs("claude-code", launches[1][1], "win32")[1]).permissions;
    expect(team.allow).toEqual(expect.arrayContaining(["PowerShell(rig:*)", "PowerShell(npm test:*)", "PowerShell(python -m pytest:*)"]));
    expect(team.allow).not.toContain("PowerShell(tmux:*)");
    expect(team.ask).toHaveLength(TEAM_CLAUDE_ASK.length);
    expect(team.ask).toEqual(expect.arrayContaining(["PowerShell(rig up:*)", "PowerShell(rig down:*)", "PowerShell(rig env down:*)",
      "PowerShell(rig seat stop:*)", "PowerShell(rig seat set-permissions:*)"]));
    expect(team.ask.filter((rule: string) => !rule.startsWith("PowerShell(rig "))).toEqual([]);
  });

  it("without the hook, native Windows adds a PowerShell rule beside each native Bash allow and ask rule", () => {
    vi.mocked(existsSync).mockReturnValueOnce(false);
    const kernel = JSON.parse(operationalLaunchArgs("claude-code", { kernelAuthority: true, managedCompaction: false }, "win32")[1]);
    expect(Object.keys(kernel.permissions)).toEqual(["allow"]);
    expectPowerShellTwins(kernel.permissions.allow, KERNEL_CLAUDE_ALLOW);
    vi.mocked(existsSync).mockReturnValueOnce(false);
    const team = JSON.parse(operationalLaunchArgs("claude-code", { teamPermissionDefault: true, managedCompaction: false }, "win32")[1]);
    expect(Object.keys(team)).toEqual(["permissions"]);
    expect(Object.keys(team.permissions)).toEqual(["allow", "ask"]);
    expectPowerShellTwins(team.permissions.allow, TEAM_CLAUDE_ALLOW);
    expectPowerShellTwins(team.permissions.ask, TEAM_CLAUDE_ASK);
  });
});

describe("Claude team command permissions", () => {
  for (const rule of TEAM_CLAUDE_ASK) {
    const command = rule.slice(5, -3);
    it(`${command}: real action asks, help does not`, () => {
      expect(decide(`${command} example`, policy)).toBe("ask");
      for (const flag of ["--help", "-h"]) {
        expect(decide(`${command} ${flag}`, policy)).toBe("allow");
        expect(decide(`${command} example ${flag}`, policy)).toBe("allow");
        expect(decide(`${command} ${flag} example`, policy)).toBe("allow");
      }
    });
  }
  it.each([
    "rig whoami --json", "rig status # note", "rig queue claim example", "rig queue unclaim example",
    "rig queue handoff example --to worker@team", "rig help down",
    "/opt/tools/rig status", "'/opt/my tools/rig' queue list", '"/opt/my tools/rig" down --help',
    "r\\ig down -h", "env OPENRIG_PORT=7434 /opt/tools/rig status", "A=value rig status",
    "command -- /opt/tools/rig status", "/usr/bin/env -- command rig down --help",
    "exec /opt/tools/rig status", "rig --host remote down --help", "rig --host=remote down -h",
    "npm test", "/opt/tools/npm test", "'/project/node_modules/.bin/vitest' run test/unit.test.ts",
    "/private/tmp/project/node_modules/.bin/jest test/unit.test.ts", "python3 -m pytest",
    "rig send worker 'literal rig down text'", "rig send worker 'multiline\nrig down example'",
  ])("allows existing allowance spelling: %s", command => expect(decide(command, policy)).toBe("allow"));

  // Team agents run most rig commands without a prompt; the commands that start, stop or remove teams or agents still
  // ask, and so do four that change who decides an agent's permissions or context. These lists are written out, not
  // derived from TEAM_CLAUDE_ASK, so a change to that list is caught here.
  const STARTS_STOPS_OR_REMOVES = [
    "up", "down", "start", "launch", "restore", "fork", "bootstrap", "create", "add", "remove", "grow", "shrink", "expand",
    "destroy", "handover", "env down", "daemon start", "daemon stop", "bundle install", "seat launch", "seat stop", "seat handover",
    "seat restart",
  ];
  const KEPT_FOR_A_PERSON = [
    "import", // its --instantiate branch launches nodes, and the prefix rule can't tell its modes apart
    "seat set-permissions", "policy apply", "policy permissions apply", // an explicit permission choice stays with a person
    "setup", // its --policy option records a permission choice, and the prefix rule can't tell it from ordinary setup
    "compact", // it replaces a peer's working context
  ];
  const ORDINARY = [
    "archive", "unarchive", "adopt", "attach", "bind", "unclaim", "release", "reconcile-session",
    "config set", "config reset", "seat continue", "seat clean", "seat switch-client", "seat set-model", "seat set-effort",
  ];
  it.each([...STARTS_STOPS_OR_REMOVES, ...KEPT_FOR_A_PERSON])("rig %s asks", command =>
    expect(decide(`rig ${command} example`, policy)).toBe("ask"));
  it.each(ORDINARY)("rig %s doesn't start, stop or remove anything: no prompt", command =>
    expect(decide(`rig ${command} example`, policy)).toBe("allow"));
  it.each(["--plan", "--verify"])("rig seat restart %s asks too, under the prefix rule; --help does not", flag => {
    expect(decide(`rig seat restart example@demo ${flag}`, policy)).toBe("ask");
    expect(decide("rig seat restart --help", policy)).toBe("allow");
  });
  it("the ask list is exactly those 29", () => {
    expect([...TEAM_CLAUDE_ASK].sort()).toEqual([...STARTS_STOPS_OR_REMOVES, ...KEPT_FOR_A_PERSON].map(command => `Bash(rig ${command}:*)`).sort());
  });

  it.each([
    "/opt/tools/rig down example", "'/opt/my tools/rig' down example", "command rig down example",
    "env A=x rig up example", "rig --host remote down example", "rig --host=remote down example",
    "rig down -- --help", "rig down --cwd --help", 'rig down "$TEAM"', "rig down $(echo --help)",
    "rig down example && rig down --help", "rig status; /opt/tools/rig down example", "rig down example | cat",
    'echo "$(rig down example)"', "echo `rig up example`", "cat <<EOF\n$(rig down example)\nEOF",
    'git commit -m "multiline\nquoted" <<EOF\n$(rig down example)\nEOF',
    "timeout 30 rig down example", "time rig down example", "nice -n 5 rig down example",
    "nohup rig down example", "stdbuf -oL rig down example", "noglob rig down example",
    "xargs rig down", "if true; then rig down example; fi",
    "for s in example; do rig down $s; done", "{ rig down example; }", "! rig down example",
    "rig -- down example", "rig seat -- stop example@demo --reason maintenance",
    "rig -- down --help", "rig -- down -h", "rig -- down --help example", "rig seat -- stop --help example@demo",
    "ls # <<pwd\nrig down example\npwd", "ls # ' <<pwd\nrig down example\npwd",
    "echo $((1 <<value))\nrig down example\nvalue", "((1 <<value))\nrig down example\nvalue",
    "echo $((\n1 <<value))\nrig down example\nvalue",
    "PATH=/inert rig down example", "NODE_OPTIONS=--no-warnings rig down example", "./rig down example",
    "ls `pwd # x`; rig down example", "ls `pwd # x` && rig down example",
    "ls ${x:-a #b}; rig down example", "echo safe # $(rig down example)",
  ])("retains lifecycle confirmation: %s", command => expect(decide(command, policy)).toBe("ask"));

  it.each([
    "echo 'rig down example'", 'echo "rig down example"', "cat <<'EOF'\nrig down example\nEOF",
    'git commit -m "multi\nline" <<\'EOF\'\n$(rig down example)\nEOF',
    "rig status | python3 -c 'print(1)'", "rig status > result.txt", "rig status && npm test",
    "rig send worker $(cat message.txt)", 'rig send worker "$MESSAGE"',
    "sudo rig status", "env -i rig status", "command -v rig", "node arbitrary.js", "npm install",
    "'/opt/tools/rig down' example", "'A=value' rig status", "not-rig down example", "", "'unterminated",
    "PATH=/inert rig status", "LD_PRELOAD=/inert rig status", "DYLD_INSERT_LIBRARIES=/inert rig status",
    "env NODE_OPTIONS=--no-warnings rig status", "BASH_ENV=/inert rig status", "ENV=/inert rig status", "./rig status",
    "cat <<'EOF' # <<OTHER\nrig down example\nEOF\nOTHER",
  ])("leaves unrelated/data/complex forms to native checks: %s", command => expect(decide(command, policy)).toBeUndefined());

  it.each(["linux", "darwin"] as const)("%s falls back to native lifecycle asks when the launch asset is absent", platform => {
    vi.mocked(existsSync).mockReturnValueOnce(false);
    const args = operationalLaunchArgs("claude-code", { teamPermissionDefault: true, managedCompaction: false }, platform);
    expect(args).toEqual(["--settings", JSON.stringify({ permissions: { allow: TEAM_CLAUDE_ALLOW, ask: TEAM_CLAUDE_ASK } })]);
    expect(operationalLaunchArgs("claude-code", { teamPermissionDefault: true, permissionMode: "plan" }, platform)).toEqual([]);
  });

  it("executes the launch-provided hook via stdin without changing its input or settings", () => {
    const args = operationalLaunchArgs("claude-code", { teamPermissionDefault: true }, "linux");
    const settings = JSON.parse(args[1]);
    expect(settings.permissions).toEqual({ allow: TEAM_CLAUDE_ALLOW });
    const hook = settings.hooks.PreToolUse[0].hooks[0];
    expect(hook).toMatchObject({ type: "command", timeout: 5 });
    for (const [command, expected] of [["rig down --help", "allow"], ["/opt/tools/rig down example", "ask"]]) {
      const result = spawnSync(posixShell, ["-c", hook.command], {
        input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, permission_mode: "acceptEdits" }), encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ hookSpecificOutput: {
        hookEventName: "PreToolUse", permissionDecision: expected,
      } });
      expect(JSON.parse(result.stdout).hookSpecificOutput.updatedInput).toBeUndefined();
    }
    for (const input of ["invalid", JSON.stringify({ tool_name: "Read" }), JSON.stringify({ tool_name: "Bash", tool_input: { command: "npm install" } })]) {
      const result = spawnSync(posixShell, ["-c", hook.command], { input, encoding: "utf8" });
      expect(result.status).toBe(0); expect(result.stdout).toBe("");
    }
  });

  it("is self-contained under an install path with spaces and quotes", () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-hook 'path "));
    try {
      const copy = join(dir, "hook.cjs"); copyFileSync(asset, copy);
      const encoded = Buffer.from(JSON.stringify(policy)).toString("base64");
      const result = spawnSync(posixShell, ["-c", [process.execPath, copy, encoded].map(shellQuote).join(" ")], {
        input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "rig down --help" } }), encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe("allow");
      expect(readFileSync(copy)).toEqual(readFileSync(asset));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("Claude PowerShell command permissions (native Windows)", () => {
  // Claude's PowerShell tool on native Windows. Its own PowerShell(...) rules own allowances, and its native ask rules
  // see lifecycle commands first; the hook only asks, as a second check.
  for (const rule of TEAM_CLAUDE_ASK) {
    const command = rule.slice(5, -3);
    it(`${command}: real action asks, help gets no decision`, () => {
      expect(decidePowerShell(`${command} example`, policy)).toBe("ask");
      expect(decidePowerShell(`${command.toUpperCase()} example`, policy)).toBe("ask");
      expect(decidePowerShell(`${command.replace(/^rig/, "rig.cmd")} example`, policy)).toBe("ask");
      for (const flag of ["--help", "-h"]) {
        expect(decidePowerShell(`${command} ${flag}`, policy)).toBeUndefined();
        expect(decidePowerShell(`${command} example ${flag}`, policy)).toBeUndefined();
        expect(decidePowerShell(`${command} ${flag} example`, policy)).toBeUndefined();
      }
    });
  }

  it.each([
    "rig down x", "rig.cmd down x", "Get-Date; rig down x", "& rig down x", "RIG DOWN x", "RIG Down x", "rig.exe down x",
    ".\\rig.ps1 down x", ". .\\rig.ps1 down x", "C:\\Users\\me\\AppData\\Roaming\\npm\\rig.cmd down x",
    "& 'C:\\Program Files\\nodejs\\rig.cmd' down x", "& \"C:\\Program Files\\nodejs\\RIG.CMD\" Down x",
    "Get-Date && rig down x", "Get-Date || rig down x", "Get-Date | rig down x", "Get-Date\nrig down x", "Get-Date\r\nrig down x",
    "rig down x 2>&1 | Out-Null", "$null = rig down x", "(rig down x)", "@(rig down x)", "$(rig down x)",
    "Write-Output \"$(rig down x)\"", "& {rig down x}", "if ($true) {rig down x}", "foreach ($s in 'x') { rig down $s }",
    "rig --% down x", "rig.cmd --% down x", "r`ig down x", "rig d`own x", "rig `\n  down x", "rig `\r\n  down x",
    "rig --host remote down x", "rig -- down x", "rig -- down --help", "rig down -- --help", "rig down x --HELP", "rig down x -H",
    "rig Seat Stop x@demo", "cmd /c rig down x", "Write-Output 'it''s'; rig down x", "<# note #> rig down x",
    "$m = @'\nit's\n'@\nrig down x", "$m = @\"\n$(rig down x)\n\"@", "Write-Output 'a @'\nrig down x\n'@'",
    "$null = 'it’; rig down x; $null = ‘x'", "$null = \"say”; rig down x; $null = “x\"",
    // PowerShell drops a block comment between words and passes the rest on: `rig <# c #> down x` runs `rig down x`.
    "rig <# c #> down x", "rig <#c#>down x", "rig<#c#> down x", "rig <##> down x", "rig <#\n#> down x", "rig <#a#><#b#>down x",
    "rig seat <# c #> stop x", "rig <# c #> seat <# d #> stop x", "rig `\n<# c #> down x", "rig <# '\" #> down x",
    "$x =<#'#>1; rig down x", "$null = \"a\"#'\nrig down x", "rig -- <# c #> down x",
    // A redirection between words, with or without its target.
    "rig 2>$null down x", "rig *>$null down x", "rig 3>$null down x", "rig seat 2>&1 stop x", "rig 2> $null down x",
    "rig 2>'out file.txt' down x", "rig >out.txt down x", "rig 2>>\"$env:TEMP\\log\" down x",
    // cmd.exe reads a batch file's command line again: an & in an argument runs another command, ^ escapes.
    "rig.cmd ps 'a b\"&rig.cmd down x'", "rig ps 'x&rig' down y", "rig.cmd d^own x", "C:\\tools\\rig.bat ps 'x|rig' down y",
    "npm.cmd test 'x&rig' down y", "cmd /c 'rig down x'", "cmd.exe /c \"rig seat stop x\"", "$env:X = 'down'; rig.cmd %X% x",
    // A word built from an expression, a variable or a splat, or an empty argument Windows PowerShell drops.
    "rig $(\"down\") x", "rig (Write-Output down) x", "rig (\"do\"+\"wn\") x", "rig @('down','x')", "$a=@(\"down\",\"x\"); rig @a",
    "rig \"$('do')wn\" x", "rig $sub x", "rig ${env:SUB} x", "rig seat $action x", "rig \"do`u{77}n\" x", "$env:X='down'; rig --% %X% x",
    "rig '' down x", "rig \"\" down x", "rig $null down x", "rig @() down x", "rig '' seat \"\" stop x",
    // PowerShell's own quoting: braced variable names, --% lines, strings that end a word.
    "${x'} = 1; rig down x; ${'} = 2", "rig --% it's fine\nrig down x", "rig 'seat'\"stop\" x", "rig 'down' x",
    // In a double-quoted string a backtick escapes the next character, so "d`own" is down. `0 `n `u{...} and the like
    // stand for other characters and ask; `0 (or a NUL) also ends the native command line, so a later --help never arrives.
    "rig \"d`own\" x", "rig \"do`wn\" x", "rig \"seat\" \"st`op\" x", "rig.cmd \"d`own\" x", "& rig \"D`OWN\" x", "rig @\"\nd`own\n\"@ x",
    "rig down`0 x", "rig \"down`0x\" y", "rig down x`0 --help", "rig down x \"`0\" --help",
    "rig d`u{6f}wn x", "rig \"d`u{6f}wn\" x", "r`u{69}g down x",
    // An assignment runs its right-hand side, as does each value in a hashtable literal.
    "$x=rig down x", "$x =rig down x", "$x+=rig down x", "$x-=rig down x", "$x*=rig down x", "$x/=rig down x", "$x%=rig down x",
    "$x??=rig down x", "[string]$x=rig down x", "$global:x=rig down x", "$env:X=rig down x", "$a=$b=rig down x", "$x=rig seat stop x",
    "@{a=rig down x}", "@{a=1;b=rig down x}", "$h = @{ a = 1; b=rig down x }",
    // A call or dot-source operator before a command name PowerShell computes asks, whatever follows (help, or not rig).
    "& ('rig') down x", "&('rig') down x", "& $r down x", ". $r down x", ".$r down x", "& \"$r\" down x", "& r$r down x",
    "& ${r} down x", "& $r.Source down x", "& (Get-Command rig) down x", "& $(Get-Command rig) down x", "& @('rig') down x",
    "& [string]'rig' down x", "$y = & $r down x", "1 | & $r down x", ".('rig') down x", "& \"r`u{69}g\" down x",
    "& $r down --help", "& $tool --version",
    // The dot-source operator needs no space before a quoted name.
    ".'rig' down x", ".\"rig\" down x",
  ])("retains lifecycle confirmation: %s", command => expect(decidePowerShell(command, policy)).toBe("ask"));

  it.each([
    "rig ps", "rig whoami --json", "rig status # note", "rig queue claim example", "rig help down", "rig down --help",
    "rig.cmd down --help", "RIG DOWN -h", "& rig down x --help", ".\\rig.ps1 down --help", "rig `\n  down --help",
    "C:\\tools\\rig.cmd ps", "Write-Output 'rig down x'", "Write-Output \"rig down x\"", "rig send w 'rig down x'",
    "$m = @'\nrig down x\n'@", "$m = @\"\nrig down x\n\"@", "Write-Output ‘rig down x’", "Write-Output “rig down x”",
    "npm test", "Get-ChildItem", "not-rig down x", "", "'unterminated",
    "rig <# c #> down --help", "rig <# note #> ps", "Write-Output 'a <# b #> rig down x'", "Write-Output \"<# rig down x #>\"",
    "git commit -m 'fix rig <# down #> docs'", "rig ps 2>$null", "rig whoami --json 2>&1 | Out-Null", "rig ps > ps.txt",
    "rig send w 'say \"rig down\" & go'", "rig.cmd send w 'rig down & up'", "rig send $seat 'hello'", "rig queue claim $id",
    "rig.cmd ps --json", "rig seat stop --help x@demo", "rig 'down' --help", "$sub = 'ps'; Write-Output $sub",
    "npm.cmd test 'a & rig down b'", "cmd /c 'rig ps'",
    // Escapes that leave help or data as they are, assignments of data or of other rig commands, literal call targets.
    "rig \"d`own\" --help", "rig \"do`wn\" -h x", "rig send w \"line`nbreak\"", "Write-Output \"rig d`own x\"", "rig send w \"cost: `$5\"",
    "$x = 'rig down x'", "$x='rig down x'", "$h = @{a='rig down x'}", "$x=rig ps", "$x = rig whoami --json", "@{a=rig ps}",
    "[string]$x=rig ps", "$x=rig down --help", "$global:x=rig queue list",
    "& 'rig' down --help", "& rig ps", "& 'C:\\tools\\rig.cmd' ps", "& \"C:\\Program Files\\nodejs\\rig.cmd\" down -h",
    ". .\\setup.ps1", ". ./tools/env.ps1 x", "& { rig ps }", ". { rig ps }", "Write-Output . x", "Get-ChildItem . -Filter $f",
    "rig ps 2>&1", "rig ps && rig whoami", "rig ps *>&1 | Out-Null",
  ])("leaves the decision to Claude's PowerShell rules: %s", command => expect(decidePowerShell(command, policy)).toBeUndefined());

  it("never allows, and kernel seats (no asks) get no decision", () => {
    const kernel = { allow: KERNEL_CLAUDE_ALLOW, ask: [] };
    for (const command of ["rig down demo", "rig ps", "npm test", "git status", "rig whoami --json"]) {
      expect(decidePowerShell(command, kernel)).toBeUndefined();
      expect(decidePowerShell(command, policy)).not.toBe("allow");
    }
  });

  it("kernel seats get no decision even where a team seat's reading would ask", () => {
    const kernel = { allow: KERNEL_CLAUDE_ALLOW, ask: [] };
    for (const command of ["rig <# c #> down x", "rig 2>$null down x", "rig.cmd ps 'x&rig' down y", "rig $sub x", "rig '' down x",
      `Write-Output ${"\"$(".repeat(3000)}x${")\"".repeat(3000)}`, "rig \"d`own\" x", "rig down x`0 --help", "rig down x\0 --help",
      "$x=rig down x", "& $r down x", "r`u{69}g down x", `rig ps ${"x".repeat(20000)}`]) expect(decidePowerShell(command, kernel)).toBeUndefined();
  });

  it("asks when strings and subexpressions nest too deeply to read", () => {
    expect(decidePowerShell(`Write-Output ${"\"$(".repeat(3000)}rig ps${")\"".repeat(3000)}`, policy)).toBe("ask");
  });

  it("asks for a command holding a NUL, which ends the native command line before a later --help", () => {
    expect(decidePowerShell("rig down x\u0000 --help", policy)).toBe("ask");
    expect(decidePowerShell("rig ps\u0000", policy)).toBe("ask");
  });

  it("asks unread past 16 KiB, where a scan could near the hook's timeout; the Bash tool has no limit", () => {
    const sized = (length: number) => `rig ps ${"x".repeat(length - "rig ps ".length)}`;
    expect(decidePowerShell(sized(16 * 1024), policy)).toBeUndefined();
    expect(decidePowerShell(sized(16 * 1024 + 1), policy)).toBe("ask");
    expect(decide(sized(16 * 1024 + 1), policy)).toBe("allow");
  });

  it("decides the slowest known shapes at the limit well inside the hook's 5 s timeout", () => {
    for (const unit of ["rig.cmd ^& rig ", "cmd /c rig ", "rig ", "$(", "rig <# c #> ", "$x=rig ", "rig 2>$null ", "rig.cmd ps 'x&rig' "]) {
      const command = unit.repeat(Math.ceil(16 * 1024 / unit.length)).slice(0, 16 * 1024);
      const started = performance.now();
      decidePowerShell(command, policy);
      expect(performance.now() - started, unit).toBeLessThan(2000);
    }
  });

  // The Bash tool's decisions for PowerShell-shaped input are unchanged.
  it.each([
    ["rig.cmd down example", undefined], ["RIG DOWN example", undefined], ["Get-Date; rig down example", "ask"],
    ["& rig down example", "ask"], ["rig down --help", "allow"], ["rig whoami --json", "allow"], ["rig ps", "allow"],
    ["rig <# c #> down x", undefined], ["rig 2>$null down x", undefined], ["rig '' down x", "allow"], ["rig $sub x", undefined],
    ["rig 'seat'\"stop\" x", "allow"], ["rig ps 'x&rig' down y", "allow"], ["cmd /c 'rig down x'", undefined],
    ["rig.cmd d^own x", undefined], ["rig 'down' x", "ask"], ["rig \"d`own\" x", undefined], ["rig down x`0 --help", "ask"],
    ["$x=rig down x", undefined], ["@{a=rig down x}", undefined], ["& $r down x", undefined], ["r`u{69}g down x", undefined],
  ])("the Bash tool's decision is unchanged: %s", (command, expected) => expect(decide(command, policy)).toBe(expected));

  it("the native Windows PowerShell hook answers through the launched exec-form command, with no shell", () => {
    for (const [name, choice] of launches) {
      const [bash, powershell] = JSON.parse(operationalLaunchArgs("claude-code", choice, "win32")[1]).hooks.PreToolUse;
      expect([bash.matcher, powershell.matcher]).toEqual(["Bash", "PowerShell"]);
      const hook = powershell.hooks[0];
      const team = name === "team" ? "ask" : undefined;
      for (const [command, expected] of [["rig down example", team], ["rig <# c #> down example", team], ["$x=rig down example", team],
        ["rig.cmd down --help", undefined], ["rig whoami --json", undefined], ["npm test", undefined]]) {
        // Claude spawns `command` with `args` directly; an empty environment shows nothing else (no Git Bash, no PATH) is needed.
        const result = spawnSync(hook.command, hook.args, { env: {}, shell: false, encoding: "utf8",
          input: JSON.stringify({ tool_name: "PowerShell", tool_input: { command }, permission_mode: "acceptEdits" }) });
        expect(result.status, result.stderr).toBe(0);
        if (!expected) { expect(result.stdout, `${name}: ${command}`).toBe(""); continue; }
        expect(JSON.parse(result.stdout)).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask",
          permissionDecisionReason: "This rig lifecycle command needs confirmation. Use --help or -h to read its help." } });
      }
      // The Bash entry is unchanged and still answers the Bash tool through Git Bash.
      const result = spawnSync(posixShell, ["-c", bash.hooks[0].command], { encoding: "utf8",
        input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "rig down --help" }, permission_mode: "acceptEdits" }) });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe("allow");
    }
  });
});
