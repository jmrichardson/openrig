import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWindowsPiCommand } from "../src/adapters/windows-pi-command.js";
import { buildPiChildEnv, piSeatPaths } from "../src/adapters/pi-runner-protocol.js";

/** A standard npm Pi install (package plus `pi.cmd`) in `dir`; returns the package entry. */
function installNpmPi(dir: string): string {
  const pkg = path.join(dir, "node_modules", "@earendil-works", "pi-coding-agent");
  mkdirSync(path.join(pkg, "dist"), { recursive: true });
  writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", bin: { pi: "dist/cli.js" } }));
  writeFileSync(path.join(pkg, "dist", "cli.js"), "");
  writeFileSync(path.join(dir, "pi.cmd"), '"%dp0%\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js" %*');
  return path.join(pkg, "dist", "cli.js");
}

describe("Windows Pi executable resolution", () => {
  it("resolves a standard npm shim without evaluating cmd.exe", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "pi-resolve-"));
    const pkg = path.join(dir, "node_modules", "@earendil-works", "pi-coding-agent");
    try {
      const entry = installNpmPi(dir);
      expect(resolveWindowsPiCommand(dir, process.execPath)).toEqual({ command: process.execPath, prefix: [entry] });
      writeFileSync(path.join(dir, "pi.cmd"), "unknown custom launcher");
      expect(() => resolveWindowsPiCommand(dir, process.execPath)).toThrow("Unrecognized");
      writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", bin: { pi: "../outside.js" } }));
      expect(() => resolveWindowsPiCommand(dir, process.execPath)).toThrow("escapes");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("passes over a pi.cmd that is not the npm layout to a later PATH entry, and reports it when nothing resolves", () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "pi-resolve-order-")));
    const shimOnly = path.join(root, "pnpm"), custom = path.join(root, "custom"), npm = path.join(root, "npm"), native = path.join(root, "native");
    try {
      for (const dir of [shimOnly, custom, npm, native]) mkdirSync(dir);
      writeFileSync(path.join(shimOnly, "pi.cmd"), "@\"%~dp0\\global\\5\\node_modules\\pi\" %*");
      installNpmPi(custom);
      writeFileSync(path.join(custom, "pi.cmd"), "unknown custom launcher");
      const entry = installNpmPi(npm);
      writeFileSync(path.join(native, "pi.exe"), "native fixture");
      const search = (...dirs: string[]) => dirs.join(path.delimiter);
      expect(resolveWindowsPiCommand(search(shimOnly, custom, npm), process.execPath)).toEqual({ command: process.execPath, prefix: [entry] });
      expect(resolveWindowsPiCommand(search(shimOnly, native, npm), process.execPath)).toEqual({ command: path.join(native, "pi.exe"), prefix: [] });
      // The first unrecognized install is the reason given, not a bare "not found".
      expect(() => resolveWindowsPiCommand(search(shimOnly, custom), process.execPath)).toThrow(`${path.join(shimOnly, "pi.cmd")} is not a recognized npm installation`);
      expect(() => resolveWindowsPiCommand(search(custom, shimOnly), process.execPath)).toThrow("Unrecognized Windows Pi shim");
      expect(() => resolveWindowsPiCommand(search(path.join(root, "empty")), process.execPath)).toThrow("not found");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("reads a quoted or space-padded PATH entry as its directory, as libuv does", () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "pi-resolve-quoted-")));
    const npm = path.join(root, "npm space"), native = path.join(root, "native"), empty = path.join(root, "empty");
    try {
      for (const dir of [npm, native, empty]) mkdirSync(dir);
      const entry = installNpmPi(npm);
      writeFileSync(path.join(native, "pi.exe"), "native fixture");
      const search = (...dirs: string[]) => dirs.join(path.delimiter);
      expect(resolveWindowsPiCommand(search(empty, `"${npm}"`), process.execPath)).toEqual({ command: process.execPath, prefix: [entry] });
      expect(resolveWindowsPiCommand(search("", ` ${npm} `, ""), process.execPath)).toEqual({ command: process.execPath, prefix: [entry] });
      expect(resolveWindowsPiCommand(search(" ", `"${native}"`, npm), process.execPath)).toEqual({ command: path.join(native, "pi.exe"), prefix: [] });
      // An entry that is still relative once unquoted is not searched.
      expect(() => resolveWindowsPiCommand(search("", '"npm space"'), process.execPath)).toThrow("not found");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("forwards Windows runtime locations while retaining provider denial", () => {
    const source = { SystemRoot: "C:\\Windows", USERPROFILE: "C:\\Users\\probe", TEMP: "C:\\Temp", ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)", ProgramW6432: "C:\\Program Files",
      APPDATA: "C:\\Users\\probe\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\probe\\AppData\\Local", ProgramData: "C:\\ProgramData", ANTHROPIC_API_KEY: "private", UNRELATED_SECRET: "private" };
    const env = buildPiChildEnv(source, { agentDir: "seat-agent", sessionsDir: "sessions", platform: "win32", model: "openai-codex/gpt-6-luna" });
    expect(env.SystemRoot).toBe(source.SystemRoot);
    expect(env.USERPROFILE).toBe(source.USERPROFILE);
    expect(env.ProgramFiles).toBe(source.ProgramFiles);
    expect(env["ProgramFiles(x86)"]).toBe(source["ProgramFiles(x86)"]);
    expect(env.ProgramW6432).toBe(source.ProgramW6432);
    expect(env.APPDATA).toBe(source.APPDATA);
    expect(env.LOCALAPPDATA).toBe(source.LOCALAPPDATA);
    expect(env.ProgramData).toBe(source.ProgramData);
    expect(env.PI_CODING_AGENT_DIR).toBe("seat-agent");
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(env).not.toHaveProperty("UNRELATED_SECRET");
    const posix = buildPiChildEnv(source, { agentDir: "a", sessionsDir: "s", platform: "linux" });
    for (const name of ["SystemRoot", "APPDATA", "LOCALAPPDATA", "ProgramData"]) expect(posix).not.toHaveProperty(name);
  });
  it("keeps the app-data folders for an OMP seat whose home is isolated", () => {
    const source = { USERPROFILE: "C:\\Users\\probe", APPDATA: "C:\\Users\\probe\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\probe\\AppData\\Local" };
    const env = buildPiChildEnv(source, { agentDir: "C:\\seat\\agent", sessionsDir: "C:\\seat\\sessions", runtime: "omp", platform: "win32" });
    expect(env.USERPROFILE).toBe(env.HOME);
    expect(env).toMatchObject({ APPDATA: source.APPDATA, LOCALAPPDATA: source.LOCALAPPDATA });
  });
  it.runIf(process.platform === "win32")("ends the runner with 127 and an exited sidecar when no Pi on PATH is recognized", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "pi-runner-unresolved-"));
    try {
      const bin = path.join(root, "bin");
      mkdirSync(bin);
      installNpmPi(bin);
      writeFileSync(path.join(bin, "pi.cmd"), "unknown custom launcher");
      const stateRoot = path.join(root, "state");
      const seat = piSeatPaths(stateRoot, "fixture");
      mkdirSync(seat.seatRoot, { recursive: true });
      writeFileSync(seat.runnerStatePath, JSON.stringify({ ready: false, launchId: "owned-attempt", lastEntryId: "entry-7", updatedAt: "t" }));
      const result = spawnSync(process.execPath, ["--import", "tsx", path.join(__dirname, "..", "src", "adapters", "pi-runner.ts"),
        "--session-name", "fixture", "--state-root", stateRoot, "--cwd", root, "--launch-id", "owned-attempt", "--no-approve"], {
        env: { PATH: bin, SystemRoot: process.env.SystemRoot, HOME: root, USERPROFILE: root, TEMP: os.tmpdir(), TMP: os.tmpdir() },
        input: "", encoding: "utf8", timeout: 30_000,
      });
      const output = `${result.stdout}${result.stderr}`;
      expect(result.status, output).toBe(127);
      expect(output).toContain("[pi-runner] ERROR Windows Pi requires a native executable or a recognized @earendil-works npm installation on the runner PATH (Unrecognized Windows Pi shim).");
      expect(JSON.parse(readFileSync(seat.runnerStatePath, "utf8"))).toMatchObject({ ready: false, launchId: "owned-attempt", lastEntryId: "entry-7", exited: { code: 127 } });
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 40_000);
});
