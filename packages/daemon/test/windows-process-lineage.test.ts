import { describe, expect, it } from "vitest";
import {
  parseWindowsProcesses, verifyCodexPaneProcess, verifyClaudePaneProcess, observeClaudeDelivery, listNativeProcesses,
  findExactNativeResumeProcess, verifyPaneIdleShell, isWindowsRuntimeProcess, claudeCommandSessionToken, codexCommandResumeToken,
  observeCodexForkProcess, explainNativeRejection, subtreeNamesClaudeExecutable,
  type NativeProcessRow,
} from "../src/domain/native-process-lineage.js";

const born = "2026-10-08T01:00:00Z";
function rows(): NativeProcessRow[] {
  return parseWindowsProcesses(JSON.stringify([
    { ProcessId: 100, ParentProcessId: 1, Name: "pwsh.exe", ExecutablePath: "C:\\pwsh.exe", CommandLine: '"C:\\pwsh.exe"', StartedAt: born },
    { ProcessId: 101, ParentProcessId: 100, Name: "codex.exe", ExecutablePath: "C:\\program space\\codex.exe", CommandLine: '"C:\\program space\\codex.exe" resume exact-id', StartedAt: "2026-10-08T01:00:01Z" },
  ]));
}
const verify = (values: NativeProcessRow[], token = "exact-id", foreground = "codex") => verifyCodexPaneProcess({ target: "pane", tmux: { getPanePid: async () => 100, getPaneCommand: async () => foreground }, listProcesses: () => values, expectedToken: token, requireResume: true });
describe("Windows process ancestry without fabricated foreground groups", () => {
  it("accepts a Codex launcher chain with Windows-quoted resume argv", async () => {
    const values = rows();
    values[1]!.command = '"C:\\program space\\codex.exe" resume "exact-id"';
    values.push({ ...values[1]!, pid: 102, ppid: 101, startedAt: "2026-10-08T01:00:02Z" });
    expect((await verify(values))?.process.pid).toBe(102);
    values[2]!.command = '"C:\\program space\\codex.exe" resume "other-id"';
    expect(await verify(values)).toBeNull();
  });
  it("keeps a Claude rotation bound to the same Windows process birth time", async () => {
    const values = rows();
    Object.assign(values[1]!, { executableName: "claude.exe", executablePath: "C:\\program space\\claude.exe", command: '"C:\\program space\\claude.exe" --resume "exact-id"' });
    const input = { target: "pane", tmux: { getPanePid: async () => 100, getPaneCommand: async () => "claude" }, listProcesses: () => values, expectedToken: "rotated-id",
      rotation: { token: "exact-id", process: { pid: 101, startedAt: values[1]!.startedAt! } } };
    expect((await verifyClaudePaneProcess(input))?.process.pid).toBe(101);
    expect(await verifyClaudePaneProcess({ ...input, rotation: { ...input.rotation, process: { pid: 101, startedAt: born } } })).toBeNull();
    expect((await observeClaudeDelivery(input)).state).toBe("verified");
  });
  it("verifies native Claude against the selected executable and exact session identity", async () => {
    const values = rows();
    Object.assign(values[1]!, { executableName: "claude.exe", executablePath: "C:\\program space\\claude.exe", command: '"C:\\program space\\claude.exe" --session-id exact-id' });
    const input = { target: "pane", tmux: { getPanePid: async () => 100, getPaneCommand: async () => "claude" }, listProcesses: () => values, expectedToken: "exact-id", selectedExecutable: "C:\\program space\\claude.exe" };
    expect((await verifyClaudePaneProcess(input))?.process.pid).toBe(101);
    expect(await verifyClaudePaneProcess({ ...input, selectedExecutable: "C:\\other\\claude.exe" })).toBeNull();
    expect(await verifyClaudePaneProcess({ ...input, expectedToken: "wrong" })).toBeNull();
    expect(await verifyClaudePaneProcess({ ...input, tmux: { ...input.tmux, getPaneCommand: async () => "pwsh" } })).toBeNull();
  });
  it("requires the OS executable, unique lineage and exact resume identity", async () => {
    expect((await verify(rows()))?.process.pid).toBe(101);
    expect(await verify(rows(), "wrong-id")).toBeNull();
    expect(await verify(rows(), "exact-id", "pwsh")).toBeNull();
  });
  it("proves a fork child from its Windows argv, only while the pane's foreground names Codex", async () => {
    const values = rows();
    values[1]!.command = '"C:\\program space\\codex.exe" fork "parent-id"';
    const observe = (foreground: string, parentToken = "parent-id") => observeCodexForkProcess({ target: "pane",
      tmux: { getPanePid: async () => 100, getPaneCommand: async () => foreground }, listProcesses: () => values, parentToken });
    expect((await observe("codex"))?.process.pid).toBe(101);
    expect(await observe("codex", "other-id")).toBeNull();
    expect(await observe("pwsh")).toBeNull();
    values[1]!.command = '"C:\\program space\\codex.exe" resume "parent-id"';
    expect(await observe("codex")).toBeNull();
  });
  it("explains a rejected Windows row by the argv the check itself reads", () => {
    const values = rows();
    expect(explainNativeRejection(values, 100, "codex", "exact-id", true)).toEqual({ kind: "passes" });
    values[1]!.command = '"C:\\program space\\codex.exe" resume "other-id"';
    expect(explainNativeRejection(values, 100, "codex", "exact-id", true)).toEqual({ kind: "other_conversation", conversation: "other-id" });
    expect(subtreeNamesClaudeExecutable(values, 100)).toBe(false);
    Object.assign(values[1]!, { executableName: "claude.exe", executablePath: "C:\\program space\\claude.exe", command: '"C:\\program space\\claude.exe" --resume "exact-id"' });
    expect(explainNativeRejection(values, 100, "claude-code", "exact-id", false)).toEqual({ kind: "passes" });
    expect(subtreeNamesClaudeExecutable(values, 100)).toBe(true);
  });
  it.each(["outside", "recycled", "spoof", "ambiguous", "cycle", "duplicate"])("refuses %s identity evidence", async defect => {
    const values = rows();
    if (defect === "outside") values[1]!.ppid = 999;
    if (defect === "recycled") values[0]!.startedAt = "2026-10-08T02:00:00Z";
    if (defect === "spoof") values[1]!.executablePath = "C:\\different.exe";
    if (defect === "ambiguous") values.push({ ...values[1]!, pid: 102 });
    if (defect === "cycle") values[1]!.ppid = 101;
    if (defect === "duplicate") values.push({ ...values[0]! });
    expect(await verify(values)).toBeNull();
  });
  it("does not promote malformed or unavailable CIM rows", () => {
    expect(parseWindowsProcesses(JSON.stringify([{ ProcessId: 1, ParentProcessId: 0, Name: "codex.exe" }]))).toEqual([]);
  });
  it("never treats a ps row as a Windows runtime, and keeps the ps argv offset", () => {
    expect(isWindowsRuntimeProcess({ pid: 1, ppid: 0, command: "codex resume exact-id", executableName: "codex" }, "codex")).toBe(false);
    expect(isWindowsRuntimeProcess({ pid: 1, ppid: 0, command: "/usr/bin/claude --resume exact-id", executableName: "claude", executablePath: "/usr/bin/claude" }, "claude-code")).toBe(false);
    const cli = "/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js";
    expect(claudeCommandSessionToken(`node ${cli} --session-id exact-id`)).toBeNull();
    expect(claudeCommandSessionToken(`"C:\\Program Files\\nodejs\\node.exe" "C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js" --session-id "exact-id"`, "win32")).toBe("exact-id");
    expect(codexCommandResumeToken("node /usr/lib/node_modules/@openai/codex/bin/codex.js resume exact-id")).toBeUndefined();
    expect(codexCommandResumeToken(`"C:\\Program Files\\nodejs\\node.exe" "C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js" resume "exact-id"`, "win32")).toBe("exact-id");
  });
  it.skipIf(process.platform !== "win32")("observes this actual Windows Node process using CIM", async () => {
    const current = (await listNativeProcesses()).find(row => row.pid === process.pid);
    expect(current?.platform).toBe("win32");
    expect(current?.executablePath?.toLowerCase()).toBe(process.execPath.toLowerCase());
    expect(current?.pgid).toBeUndefined();
  });
});

// psmux starts a pane as Windows PowerShell; a typed launch runs the runtime as its child.
const powershell = "C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const paneShell = { ProcessId: 100, ParentProcessId: 1, Name: "powershell.exe", ExecutablePath: powershell, CommandLine: `${powershell} -NoLogo -NoExit -Command "psmux init"`, StartedAt: born };
const paneInput = (values: () => NativeProcessRow[]) => ({ target: "pane", tmux: { getPanePid: async () => 100, getPaneCommand: async () => "powershell" }, listProcesses: values });

describe("Windows idle shell evidence without foreground process groups", () => {
  it.each([
    ["Windows PowerShell", paneShell],
    ["PowerShell 7 under a spaced path", { ...paneShell, Name: "pwsh.exe", ExecutablePath: "C:\\Program Files\\PowerShell\\7\\pwsh.exe", CommandLine: '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoLogo' }],
    ["cmd", { ...paneShell, Name: "cmd.exe", ExecutablePath: "C:\\WINDOWS\\system32\\cmd.exe", CommandLine: "C:\\WINDOWS\\system32\\cmd.exe" }],
  ])("reads a lone %s pane process as an idle shell", async (_shell, root) => {
    const values = () => parseWindowsProcesses(JSON.stringify([root]));
    expect((await observeClaudeDelivery(paneInput(values))).state).toBe("idle_shell");
    expect(await verifyPaneIdleShell(paneInput(values))).toBe(true);
  });

  it("does not read a shell that started a child as idle, a helper included", async () => {
    const values = () => parseWindowsProcesses(JSON.stringify([paneShell,
      { ProcessId: 101, ParentProcessId: 100, Name: "PING.EXE", ExecutablePath: "C:\\WINDOWS\\system32\\PING.EXE", CommandLine: '"C:\\WINDOWS\\system32\\PING.EXE" -n 30 127.0.0.1', StartedAt: "2026-10-08T01:00:05Z" }]));
    expect((await observeClaudeDelivery(paneInput(values))).state).toBe("unknown");
    expect(await verifyPaneIdleShell(paneInput(values))).toBe(false);
  });

  it("ignores a child of a recycled parent PID, born before the pane shell", async () => {
    const values = () => parseWindowsProcesses(JSON.stringify([paneShell,
      { ProcessId: 101, ParentProcessId: 100, Name: "node.exe", ExecutablePath: "C:\\node.exe", CommandLine: "C:\\node.exe", StartedAt: "2026-10-08T00:59:00Z" }]));
    expect((await observeClaudeDelivery(paneInput(values))).state).toBe("idle_shell");
  });

  it("refuses idle evidence from a non-shell pane, an unparsed birth, duplicate PIDs or a changing shell", async () => {
    const node = () => parseWindowsProcesses(JSON.stringify([{ ...paneShell, Name: "node.exe", ExecutablePath: "C:\\node.exe", CommandLine: "C:\\node.exe" }]));
    expect((await observeClaudeDelivery(paneInput(node))).state).toBe("unknown");
    const unborn = () => [{ ...parseWindowsProcesses(JSON.stringify([paneShell]))[0]!, startedAt: undefined }];
    expect(await verifyPaneIdleShell(paneInput(unborn))).toBe(false);
    const duplicate = () => parseWindowsProcesses(JSON.stringify([paneShell, paneShell]));
    expect(await verifyPaneIdleShell(paneInput(duplicate))).toBe(false);
    let sample = 0;
    const replaced = () => parseWindowsProcesses(JSON.stringify([{ ...paneShell, StartedAt: sample++ === 0 ? born : "2026-10-08T01:30:00Z" }]));
    expect(await verifyPaneIdleShell(paneInput(replaced))).toBe(false);
  });

  it("keeps a POSIX shell row on the foreground-group rule", async () => {
    const values = () => [{ pid: 100, ppid: 1, command: "-zsh", executableName: "zsh", startedAt: "Thu Oct  8 01:00:00 2026" }];
    expect(await verifyPaneIdleShell(paneInput(values))).toBe(false);
    expect(await verifyPaneIdleShell(paneInput(() => [{ ...values()[0]!, pgid: 100, tpgid: 100 }]))).toBe(true);
  });
});

describe("strict Claude resume proof from Windows command lines", () => {
  const claude = "C:\\Users\\First Last\\.local\\bin\\claude.exe";
  const node = "C:\\Program Files\\nodejs\\node.exe";
  const cli = "C:\\Users\\First Last\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js";
  const launched = "2026-10-08T01:00:01Z";
  const resumeRows = (runtime: Record<string, unknown>, ...more: Record<string, unknown>[]) => parseWindowsProcesses(JSON.stringify([
    paneShell, { ProcessId: 101, ParentProcessId: 100, StartedAt: launched, ...runtime }, ...more,
  ]));
  const nativeClaude = (args: string) => ({ Name: "claude.exe", ExecutablePath: claude, CommandLine: `"${claude}" ${args}` });

  it.each([
    ["native Claude under a spaced profile path", nativeClaude('"--resume" "exact-id"')],
    ["native Claude naming its session with =", nativeClaude('"--session-id=exact-id"')],
    ["npm Claude run by Node", { Name: "node.exe", ExecutablePath: node, CommandLine: `"${node}" "${cli}" --resume "exact-id"` }],
  ])("proves %s", (_shape, runtime) => {
    expect(findExactNativeResumeProcess(resumeRows(runtime), 100, "claude-code", "exact-id")?.pid).toBe(101);
    expect(findExactNativeResumeProcess(resumeRows(runtime), 100, "claude-code", "other-id")).toBeNull();
  });

  it.each([
    ["a helper whose argv mentions Claude", { Name: "node.exe", ExecutablePath: node, CommandLine: `"${node}" "C:\\tools\\report.js" "${claude}" --resume "exact-id"` }],
    ["an argv[0] that is not the OS image", { ...nativeClaude('--resume "exact-id"'), ExecutablePath: "C:\\other\\claude.exe" }],
    ["an OS image that is not Claude", { ...nativeClaude('--resume "exact-id"'), Name: "notclaude.exe", ExecutablePath: "C:\\Users\\First Last\\.local\\bin\\notclaude.exe", CommandLine: '"C:\\Users\\First Last\\.local\\bin\\notclaude.exe" --resume "exact-id"' }],
  ])("refuses %s", (_shape, runtime) => {
    expect(findExactNativeResumeProcess(resumeRows(runtime), 100, "claude-code", "exact-id")).toBeNull();
  });

  it("accepts a recorded rotation only for the launched process with no Claude beneath it", () => {
    const rotation = { token: "exact-id", process: { pid: 101, startedAt: launched } };
    const runtime = nativeClaude('--resume "exact-id"');
    expect(findExactNativeResumeProcess(resumeRows(runtime), 100, "claude-code", "rotated-id", rotation)?.pid).toBe(101);
    const child = { ProcessId: 102, ParentProcessId: 101, StartedAt: "2026-10-08T01:00:02Z", ...nativeClaude('-p "summarize"') };
    expect(findExactNativeResumeProcess(resumeRows(runtime, child), 100, "claude-code", "rotated-id", rotation)).toBeNull();
    expect(findExactNativeResumeProcess(resumeRows(runtime), 100, "claude-code", "rotated-id", { ...rotation, process: { pid: 101, startedAt: born } })).toBeNull();
  });
});
