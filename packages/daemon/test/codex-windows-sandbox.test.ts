import {
  closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync,
  symlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CODEX_SANDBOX_NODE_OPS, CODEX_WINDOWS_EXECUTION_POLICY_OVERRIDE, codexSandboxUsersGrant, codexWindowsExecutionPolicyChosen,
  codexWindowsSandboxChosen, codexWindowsSandboxConfigFiles, codexWindowsSandboxElevated, grantCodexSandboxSeatBin,
  stageCodexSandboxNode, type CodexSandboxNodeOps,
} from "../src/domain/codex-windows-sandbox.js";
import { shellQuote } from "../src/adapters/shell-quote.js";
import { parseLiteralLaunchWords } from "../src/adapters/windows-launch.js";
import { parseWindowsCommandLine, windowsArguments } from "../src/adapters/windows-argv.js";

describe("codexWindowsSandboxChosen", () => {
  it("treats absent or silent layers as no choice", () => {
    expect(codexWindowsSandboxChosen([])).toBe(false);
    expect(codexWindowsSandboxChosen([null, null])).toBe(false);
    expect(codexWindowsSandboxChosen(['model = "gpt-5.5"\n[features]\nhooks = true\n', null])).toBe(false);
  });

  it.each([
    ["a legacy sandbox", '[windows]\nsandbox = "unelevated"\n'],
    ["MXC turned off", "[features]\nprefer_mxc = false\n"],
    ["MXC turned on", "[features]\nprefer_mxc = true\n"],
  ])("never overrides %s chosen in config.toml or in the selected profile's file", (_label, toml) => {
    expect(codexWindowsSandboxChosen([toml])).toBe(true);
    expect(codexWindowsSandboxChosen(['model = "gpt-5.5"\n', toml])).toBe(true);
    expect(codexWindowsSandboxChosen([null, toml])).toBe(true);
  });

  it("reads a config written with a UTF-8 BOM, as Codex does", () => {
    expect(codexWindowsSandboxChosen(['\uFEFFmodel = "gpt-5.5"\n'])).toBe(false);
    expect(codexWindowsSandboxChosen(["\uFEFF[features]\nprefer_mxc = false\n"])).toBe(true);
  });

  it("adds nothing to a config Codex cannot parse", () => {
    expect(codexWindowsSandboxChosen(["[windows\nsandbox = "])).toBe(true);
    expect(codexWindowsSandboxChosen([null, "[windows\nsandbox = "])).toBe(true);
  });
});

describe("codexWindowsSandboxConfigFiles", () => {
  it("is config.toml, and the selected profile-v2 file beside it", () => {
    const home = path.join("codex-home");
    expect(codexWindowsSandboxConfigFiles(home, undefined)).toEqual([path.join(home, "config.toml")]);
    expect(codexWindowsSandboxConfigFiles(home, "locked")).toEqual([path.join(home, "config.toml"), path.join(home, "locked.config.toml")]);
  });
});

describe("codexWindowsExecutionPolicyChosen", () => {
  it("treats absent layers, and a shell policy without the variable, as unset", () => {
    expect(codexWindowsExecutionPolicyChosen([])).toBe(false);
    expect(codexWindowsExecutionPolicyChosen([null, null])).toBe(false);
    expect(codexWindowsExecutionPolicyChosen(['[windows]\nsandbox = "elevated"\n[shell_environment_policy]\ninherit = "core"\n'])).toBe(false);
    expect(codexWindowsExecutionPolicyChosen(['[shell_environment_policy.set]\nPSModulePath = "C:\\\\modules"\n', null])).toBe(false);
  });

  it.each([
    ["a table", '[shell_environment_policy.set]\nPSExecutionPolicyPreference = "AllSigned"\n'],
    ["an inline table, in another case", '[shell_environment_policy]\nset = { psexecutionpolicypreference = "Bypass" }\n'],
    ["a dotted key", 'shell_environment_policy.set.PSEXECUTIONPOLICYPREFERENCE = "Restricted"\n'],
  ])("never overrides the variable set in %s, in config.toml or the selected profile's file", (_label, toml) => {
    expect(codexWindowsExecutionPolicyChosen([toml])).toBe(true);
    expect(codexWindowsExecutionPolicyChosen(['model = "gpt-5.5"\n', toml])).toBe(true);
    expect(codexWindowsExecutionPolicyChosen([null, toml])).toBe(true);
  });

  it("reads past a UTF-8 BOM, and adds nothing to a config Codex cannot parse", () => {
    expect(codexWindowsExecutionPolicyChosen(['\uFEFFmodel = "gpt-5.5"\n'])).toBe(false);
    expect(codexWindowsExecutionPolicyChosen(['\uFEFF[shell_environment_policy.set]\nPSExecutionPolicyPreference = "AllSigned"\n'])).toBe(true);
    expect(codexWindowsExecutionPolicyChosen([null, "[shell_environment_policy\n"])).toBe(true);
  });

  it("ignores a PSExecutionPolicyPreference in the daemon's own environment, which is not the pane's", () => {
    // As `powershell -ExecutionPolicy Bypass` exports it to the processes it starts.
    vi.stubEnv("PSExecutionPolicyPreference", "Bypass");
    expect(codexWindowsExecutionPolicyChosen([])).toBe(false);
    expect(codexWindowsExecutionPolicyChosen(['model = "gpt-5.5"\n', null])).toBe(false);
  });
});

describe("CODEX_WINDOWS_EXECUTION_POLICY_OVERRIDE", () => {
  it("reaches Codex's argv unchanged, with a value Codex takes as the literal string RemoteSigned", () => {
    // The managed launch shell-quotes it, renders the literal words as a Windows command line, and a restart
    // reads that command line back.
    const words = parseLiteralLaunchWords(`codex -c ${shellQuote(CODEX_WINDOWS_EXECUTION_POLICY_OVERRIDE)}`);
    expect(words).toEqual(["codex", "-c", CODEX_WINDOWS_EXECUTION_POLICY_OVERRIDE]);
    expect(parseWindowsCommandLine(windowsArguments(words.slice(1)))).toEqual(["-c", CODEX_WINDOWS_EXECUTION_POLICY_OVERRIDE]);
    const [key, raw] = CODEX_WINDOWS_EXECUTION_POLICY_OVERRIDE.split("=");
    expect(key).toBe("shell_environment_policy.set.PSExecutionPolicyPreference");
    // Not a TOML value, so Codex keeps the raw word as a string.
    expect(() => parseToml(`x = ${raw}`)).toThrow();
    expect(raw).toBe("RemoteSigned");
  });
});

describe("codexWindowsSandboxElevated", () => {
  it("is false without an elevated choice", () => {
    expect(codexWindowsSandboxElevated([])).toBe(false);
    expect(codexWindowsSandboxElevated([null, null])).toBe(false);
    expect(codexWindowsSandboxElevated(['model = "gpt-5.5"\n'])).toBe(false);
    expect(codexWindowsSandboxElevated(['[windows]\nsandbox = "unelevated"\n'])).toBe(false);
    expect(codexWindowsSandboxElevated(['[windows]\nsandbox = "mxc"\n'])).toBe(false);
  });

  it("is true for elevated in config.toml or the selected profile's file, the profile's layer winning", () => {
    expect(codexWindowsSandboxElevated(['[windows]\nsandbox = "elevated"\n'])).toBe(true);
    expect(codexWindowsSandboxElevated(['\uFEFF[windows]\nsandbox = "elevated"\n', null])).toBe(true);
    expect(codexWindowsSandboxElevated([null, '[windows]\nsandbox = "elevated"\n'])).toBe(true);
    expect(codexWindowsSandboxElevated(['[windows]\nsandbox = "unelevated"\n', '[windows]\nsandbox = "elevated"\n'])).toBe(true);
    expect(codexWindowsSandboxElevated(['[windows]\nsandbox = "elevated"\n', '[windows]\nsandbox = "unelevated"\n'])).toBe(false);
  });

  it("stays true where MXC is preferred, since Codex runs elevated where MXC is unavailable", () => {
    const elevated = '[windows]\nsandbox = "elevated"\n';
    expect(codexWindowsSandboxElevated([`${elevated}[features]\nprefer_mxc = true\n`])).toBe(true);
    expect(codexWindowsSandboxElevated([elevated, "[features]\nprefer_mxc = true\n"])).toBe(true);
    expect(codexWindowsSandboxElevated([`${elevated}[features]\nprefer_mxc = false\n`])).toBe(true);
    expect(codexWindowsSandboxElevated(["[features]\nprefer_mxc = true\n"])).toBe(false);
  });

  it("reads the legacy features.elevated_windows_sandbox as Codex 0.163 does: only where no layer sets [windows] sandbox", () => {
    const legacy = "[features]\nelevated_windows_sandbox = true\n";
    expect(codexWindowsSandboxElevated([legacy])).toBe(true);
    expect(codexWindowsSandboxElevated([null, legacy])).toBe(true);
    expect(codexWindowsSandboxElevated([`${legacy}prefer_mxc = true\n`])).toBe(true);
    // The profile's layer wins for the key, as for any other.
    expect(codexWindowsSandboxElevated([legacy, "[features]\nelevated_windows_sandbox = false\n"])).toBe(false);
    expect(codexWindowsSandboxElevated(["[features]\nelevated_windows_sandbox = false\n", legacy])).toBe(true);
    // [windows] sandbox in any layer decides first.
    expect(codexWindowsSandboxElevated(['[windows]\nsandbox = "unelevated"\n', legacy])).toBe(false);
    expect(codexWindowsSandboxElevated([legacy, '[windows]\nsandbox = "mxc"\n'])).toBe(false);
    // The other legacy keys select the unelevated sandbox.
    expect(codexWindowsSandboxElevated(["[features]\nexperimental_windows_sandbox = true\nenable_experimental_windows_sandbox = true\n"])).toBe(false);
  });

  it("stages nothing for a config Codex cannot parse", () => {
    expect(codexWindowsSandboxElevated(['[windows]\nsandbox = "elevated"\n', "[windows\n"])).toBe(false);
    expect(codexWindowsSandboxElevated(["[windows\n", '[windows]\nsandbox = "elevated"\n'])).toBe(false);
  });
});

describe("codexSandboxUsersGrant", () => {
  it("names the local group with this machine where COMPUTERNAME is set, so no same-named domain group is resolved", () => {
    expect(codexSandboxUsersGrant({ COMPUTERNAME: "DESK-7F3A" })).toBe("DESK-7F3A\\CodexSandboxUsers:(OI)(CI)(RX)");
    expect(codexSandboxUsersGrant({})).toBe("CodexSandboxUsers:(OI)(CI)(RX)");
    expect(codexSandboxUsersGrant({ COMPUTERNAME: "" })).toBe("CodexSandboxUsers:(OI)(CI)(RX)");
  });
});

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("stageCodexSandboxNode", () => {
  /** A temporary instance home and a stand-in for the person's Node; `withNode: false` leaves the Node absent. */
  function fixture({ withNode = true } = {}) {
    const root = mkdtempSync(path.join(tmpdir(), "openrig-sandbox-node-")); roots.push(root);
    const node = path.join(root, "person node.exe");
    const home = path.join(root, "instance");
    if (withNode) writeFileSync(node, "node fixture bytes");
    const calls: string[] = [];
    const ops: CodexSandboxNodeOps = {
      icacls: vi.fn((args: string[]) => { calls.push(`icacls ${JSON.stringify(args)}`); }),
      copyFile: vi.fn((from: string, to: string) => { calls.push(`copy ${path.basename(to)}`); copyFileSync(from, to); }),
    };
    return { root, node, home, ops, calls };
  }
  const keyOf = (node: string) => {
    const source = statSync(node);
    return createHash("sha256").update(JSON.stringify([node, source.size, source.mtimeMs])).digest("hex");
  };
  const FALLBACK_WARNING = "[seat launch] No Node readable by Codex's elevated sandbox could be staged; the seat's rig uses the daemon's Node.";

  it("grants the sandbox group the folder before copying into it, then renames the copy into place", () => {
    const f = fixture();
    const staged = stageCodexSandboxNode(f.home, f.root, f.ops, f.node);
    const dir = path.join(f.home, "run", "seat-node", keyOf(f.node));
    expect(staged).toBe(path.join(dir, "node.exe"));
    expect(f.calls[0]).toBe(`icacls ${JSON.stringify([dir, "/grant", codexSandboxUsersGrant()])}`);
    expect(f.calls[1]).toMatch(/^copy node\.\d+\.[0-9a-f]{8}\.tmp$/);
    expect(f.calls).toHaveLength(2);
    expect(vi.mocked(f.ops.copyFile).mock.calls[0]![0]).toBe(f.node);
    expect(path.dirname(vi.mocked(f.ops.copyFile).mock.calls[0]![1])).toBe(dir);
    expect(readFileSync(staged, "utf8")).toBe("node fixture bytes");
    expect(readdirSync(dir)).toEqual(["node.exe"]);
  });

  it("grants the group qualified with this machine's name", () => {
    const f = fixture();
    vi.stubEnv("COMPUTERNAME", "DESK-7F3A");
    stageCodexSandboxNode(f.home, f.root, f.ops, f.node);
    expect(vi.mocked(f.ops.icacls).mock.calls[0]![0]).toEqual([path.join(f.home, "run", "seat-node", keyOf(f.node)), "/grant",
      "DESK-7F3A\\CodexSandboxUsers:(OI)(CI)(RX)"]);
  });

  it("reuses a staged copy of the same size, granting again, and stages a changed Node apart", () => {
    const f = fixture();
    const staged = stageCodexSandboxNode(f.home, f.root, f.ops, f.node);
    expect(stageCodexSandboxNode(f.home, f.root, f.ops, f.node)).toBe(staged);
    expect(f.ops.copyFile).toHaveBeenCalledTimes(1);
    expect(f.ops.icacls).toHaveBeenCalledTimes(2);
    // An updated Node at the same path: another size and mtime, so another folder.
    writeFileSync(f.node, "a newer node fixture");
    utimesSync(f.node, new Date(), new Date(Date.now() + 60_000));
    const updated = stageCodexSandboxNode(f.home, f.root, f.ops, f.node);
    expect(updated).not.toBe(staged);
    expect(readFileSync(updated, "utf8")).toBe("a newer node fixture");
    // The earlier key's folder is kept: another daemon sharing the home may still run it.
    expect(readFileSync(staged, "utf8")).toBe("node fixture bytes");
  });

  it("takes the copy another launch staged first when its own copy fails", () => {
    const f = fixture();
    const dir = path.join(f.home, "run", "seat-node", keyOf(f.node));
    const ops: CodexSandboxNodeOps = { icacls: () => {}, copyFile: (from) => {
      copyFileSync(from, path.join(dir, "node.exe"));
      throw new Error("EBUSY");
    } };
    expect(stageCodexSandboxNode(f.home, f.root, ops, f.node)).toBe(path.join(dir, "node.exe"));
    expect(readdirSync(dir)).toEqual(["node.exe"]);
  });

  // Windows refuses to rename over a file that is open, as a running node.exe is.
  it.runIf(process.platform === "win32")("takes the copy another launch staged first, in use, when its own cannot be renamed over it", () => {
    const f = fixture();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dir = path.join(f.home, "run", "seat-node", keyOf(f.node));
    const staged = path.join(dir, "node.exe");
    let inUse: number | undefined;
    // The other launch's copy: the same size, other bytes, so a rename over it would show.
    const ops: CodexSandboxNodeOps = { icacls: () => {}, copyFile: (from, to) => {
      copyFileSync(from, to);
      writeFileSync(staged, "NODE FIXTURE BYTES");
      inUse = openSync(staged, "r");
    } };
    try {
      expect(stageCodexSandboxNode(f.home, f.root, ops, f.node)).toBe(staged);
      expect(readFileSync(staged, "utf8")).toBe("NODE FIXTURE BYTES");
      expect(readdirSync(dir)).toEqual(["node.exe"]);
      expect(warn).not.toHaveBeenCalled();
    } finally { if (inUse !== undefined) closeSync(inUse); }
  });

  it.runIf(process.platform === "win32")("falls back, removing its copy, when it cannot be renamed over a staged node.exe of another size in use", () => {
    const f = fixture();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dir = path.join(f.home, "run", "seat-node", keyOf(f.node));
    const staged = path.join(dir, "node.exe");
    mkdirSync(dir, { recursive: true });
    writeFileSync(staged, "partial");
    const inUse = openSync(staged, "r");
    try {
      expect(stageCodexSandboxNode(f.home, f.root, f.ops, f.node)).toBe(f.node);
      expect(f.ops.copyFile).toHaveBeenCalledTimes(1);
      expect(readFileSync(staged, "utf8")).toBe("partial");
      expect(readdirSync(dir)).toEqual(["node.exe"]);
      expect(warn.mock.calls).toEqual([[FALLBACK_WARNING]]);
    } finally { closeSync(inUse); }
  });

  it("falls back, leaving no partial copy, when the copy fails", () => {
    const f = fixture();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const ops: CodexSandboxNodeOps = { icacls: () => {}, copyFile: (_from, to) => {
      writeFileSync(to, "partial");
      throw new Error("ENOSPC");
    } };
    expect(stageCodexSandboxNode(f.home, f.root, ops, f.node)).toBe(f.node);
    expect(readdirSync(path.join(f.home, "run", "seat-node", keyOf(f.node)))).toEqual([]);
  });

  it("removes the temporary copies ended launches left before copying, and keeps a live launch's", () => {
    const f = fixture();
    const dir = path.join(f.home, "run", "seat-node", keyOf(f.node));
    mkdirSync(dir, { recursive: true });
    const ended = "node.2147483646.deadbeef.tmp";
    const live = `node.${process.pid}.cafef00d.tmp`;
    // A name it cannot remove (here a folder; on Windows, also a file in use) is passed over.
    const stuck = "node.2147483645.0badc0de.tmp";
    for (const name of [ended, live, "notes.txt"]) writeFileSync(path.join(dir, name), "x");
    mkdirSync(path.join(dir, stuck));
    expect(stageCodexSandboxNode(f.home, f.root, f.ops, f.node)).toBe(path.join(dir, "node.exe"));
    expect(readdirSync(dir).sort()).toEqual([live, stuck, "node.exe", "notes.txt"].sort());
  });

  it("removes nothing when it reuses a staged copy", () => {
    const f = fixture();
    const staged = stageCodexSandboxNode(f.home, f.root, f.ops, f.node);
    const ended = path.join(path.dirname(staged), "node.2147483646.deadbeef.tmp");
    writeFileSync(ended, "x");
    expect(stageCodexSandboxNode(f.home, f.root, f.ops, f.node)).toBe(staged);
    expect(existsSync(ended)).toBe(true);
  });

  it("falls back to the Node it was given, copying nothing, when the group cannot be granted", () => {
    const f = fixture();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(f.ops.icacls).mockImplementation(() => { throw new Error(`icacls failed for ${f.home}`); });
    expect(stageCodexSandboxNode(f.home, f.root, f.ops, f.node)).toBe(f.node);
    expect(f.ops.copyFile).not.toHaveBeenCalled();
    expect(existsSync(path.join(f.home, "run", "seat-node", keyOf(f.node), "node.exe"))).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).not.toContain(f.root);
  });

  it.each([
    ["the key's folder", 3],
    ["seat-node", 2],
    ["run", 1],
  ])("grants nothing through a junction or symbolic link at %s, and falls back", (_label, depth) => {
    const f = fixture();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const elsewhere = path.join(f.root, "elsewhere");
    mkdirSync(elsewhere);
    const tail = ["run", "seat-node", keyOf(f.node)];
    const link = path.join(f.home, ...tail.slice(0, depth));
    mkdirSync(path.dirname(link), { recursive: true });
    symlinkSync(elsewhere, link, "junction");
    expect(stageCodexSandboxNode(f.home, f.root, f.ops, f.node)).toBe(f.node);
    expect(f.ops.icacls).not.toHaveBeenCalled();
    expect(f.ops.copyFile).not.toHaveBeenCalled();
    expect(warn.mock.calls).toEqual([[FALLBACK_WARNING]]);
  });

  it("stages in a home its owner keeps behind a junction or symbolic link", () => {
    const f = fixture();
    const real = path.join(f.root, "real-instance");
    mkdirSync(real);
    symlinkSync(real, f.home, "junction");
    const staged = stageCodexSandboxNode(f.home, f.root, f.ops, f.node);
    expect(staged).toBe(path.join(f.home, "run", "seat-node", keyOf(f.node), "node.exe"));
    expect(f.ops.icacls).toHaveBeenCalledTimes(1);
    expect(readFileSync(path.join(real, "run", "seat-node", keyOf(f.node), "node.exe"), "utf8")).toBe("node fixture bytes");
  });

  it("falls back, before touching anything, for a home the rig shims could not name", () => {
    const f = fixture();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(stageCodexSandboxNode(path.join(f.root, "100%home"), f.root, f.ops, f.node)).toBe(f.node);
    expect(f.calls).toEqual([]);
    expect(existsSync(path.join(f.root, "100%home"))).toBe(false);
  });

  it("falls back when the Node cannot be read", () => {
    const f = fixture({ withNode: false });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(stageCodexSandboxNode(f.home, f.root, f.ops, f.node)).toBe(f.node);
    expect(f.calls).toEqual([]);
  });

  it.runIf(process.platform === "win32")("icacls reports a group that does not exist as a failure", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "openrig-sandbox-icacls-")); roots.push(dir);
    expect(() => CODEX_SANDBOX_NODE_OPS.icacls([dir, "/grant", "OpenRigNoSuchGroup7f3a:(OI)(CI)(RX)"])).toThrow();
    expect(() => CODEX_SANDBOX_NODE_OPS.icacls([dir, "/grant", `${process.env.COMPUTERNAME}\\OpenRigNoSuchGroup7f3a:(OI)(CI)(RX)`])).toThrow();
  });

  it.runIf(process.platform === "win32")("runs icacls from C:\\Windows when SystemRoot is empty", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "openrig-sandbox-icacls-")); roots.push(dir);
    vi.stubEnv("SystemRoot", "");
    // Only displays the folder's ACL.
    expect(() => CODEX_SANDBOX_NODE_OPS.icacls([dir])).not.toThrow();
  });
});

describe("grantCodexSandboxSeatBin", () => {
  const WARNING = "[seat launch] Codex's elevated sandbox could not be granted the seat's rig shims; the seat relies on Codex's own grant.";
  function fixture() {
    const root = mkdtempSync(path.join(tmpdir(), "openrig-sandbox-seat-bin-")); roots.push(root);
    const home = path.join(root, "instance");
    const bin = path.join(home, "run", "seat-bin", "a".repeat(64));
    const ops = { icacls: vi.fn((_args: string[]) => {}) };
    return { root, home, bin, ops };
  }

  it("grants the sandbox group the seat's own shim folder", () => {
    const f = fixture();
    mkdirSync(f.bin, { recursive: true });
    grantCodexSandboxSeatBin("instance", f.root, f.bin, f.ops);
    expect(f.ops.icacls.mock.calls).toEqual([[[f.bin, "/grant", codexSandboxUsersGrant()]]]);
  });

  it.each([["the shim folder", false], ["seat-bin", true]])("grants nothing through a junction or symbolic link at %s, with a warning", (_label, atParent) => {
    const f = fixture();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const elsewhere = path.join(f.root, "elsewhere");
    mkdirSync(path.join(elsewhere, path.basename(f.bin)), { recursive: true });
    const link = atParent ? path.dirname(f.bin) : f.bin;
    mkdirSync(path.dirname(link), { recursive: true });
    symlinkSync(atParent ? elsewhere : path.join(elsewhere, path.basename(f.bin)), link, "junction");
    grantCodexSandboxSeatBin(f.home, f.root, f.bin, f.ops);
    expect(f.ops.icacls).not.toHaveBeenCalled();
    expect(warn.mock.calls).toEqual([[WARNING]]);
  });

  it("warns without naming the folder, and goes on, when the grant fails", () => {
    const f = fixture();
    mkdirSync(f.bin, { recursive: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    f.ops.icacls.mockImplementation(() => { throw new Error(`icacls failed for ${f.bin}`); });
    expect(() => grantCodexSandboxSeatBin(f.home, f.root, f.bin, f.ops)).not.toThrow();
    expect(warn.mock.calls).toEqual([[WARNING]]);
  });
});
