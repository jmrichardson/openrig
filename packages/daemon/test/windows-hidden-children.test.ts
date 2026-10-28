// Children the daemon starts from a console-less Windows service would each open a visible console window
// without windowsHide. libuv reads the flag only on Windows, so each call keeps every other option it had.
// The process launchers are fakes here: nothing runs.

import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { exec, execFile, execFileSync } = vi.hoisted(() => ({ exec: vi.fn(), execFile: vi.fn(), execFileSync: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({ ...(await importOriginal<typeof import("node:child_process")>()), exec, execFile, execFileSync }));

import { execCommand } from "../src/adapters/tmux-exec.js";
import { resolveCodexGitAddDirs } from "../src/domain/codex-git-add-dirs.js";
import { excludeNewGeneratedFiles } from "../src/domain/generated-file-hygiene.js";
import { readWorkflowGuidance } from "../src/domain/workflow-guidance.js";

let root: string;
beforeEach(() => {
  vi.resetAllMocks();
  root = fs.realpathSync(fs.mkdtempSync(nodePath.join(os.tmpdir(), "openrig-hidden-children-")));
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe("daemon children start hidden on Windows", () => {
  it("execCommand: the shell command, with only windowsHide added", async () => {
    exec.mockImplementation((_cmd, _options, callback) => callback(null, { stdout: "tmux 3.4\n", stderr: "" }));
    expect(await execCommand("tmux -V")).toBe("tmux 3.4\n");
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0]![0]).toBe("tmux -V");
    expect(exec.mock.calls[0]![1]).toEqual({ windowsHide: true });
  });

  it("resolveCodexGitAddDirs: the linked-worktree git query", async () => {
    fs.writeFileSync(nodePath.join(root, ".git"), "gitdir: /elsewhere/.git/worktrees/one\n");
    execFile.mockImplementation((_file, _args, _options, callback) => callback(new Error("git unavailable"), ""));
    expect(await resolveCodexGitAddDirs(root)).toEqual([]);
    expect(execFile.mock.calls[0]!.slice(0, 3)).toEqual(["git",
      ["-C", root, "rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"],
      { timeout: 5000, encoding: "utf8", windowsHide: true }]);
  });

  it("excludeNewGeneratedFiles: every git query", () => {
    const created = nodePath.join(root, "AGENTS.md");
    fs.writeFileSync(created, "generated");
    execFileSync.mockImplementation(() => { throw Object.assign(new Error("not a git repository"), { status: 128 }); });
    expect(excludeNewGeneratedFiles(root, [created])).toEqual([]);
    expect(execFileSync).toHaveBeenCalledTimes(1);
    const [file, args, options] = execFileSync.mock.calls[0]!;
    expect([file, args]).toEqual(["git", ["-C", root, "rev-parse", "--show-toplevel"]]);
    expect(options).toEqual({ encoding: "utf8", timeout: expect.any(Number), killSignal: "SIGKILL", maxBuffer: 2 * 1024 * 1024,
      input: undefined, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  });

  it("readWorkflowGuidance: the repository-root catalog lookup", () => {
    const project = nodePath.join(root, "project", "project.yaml");
    fs.mkdirSync(nodePath.dirname(project));
    fs.writeFileSync(project, "sdlc:\n  catalog:\n    root: repository\n    address: method.md#components\n  components:\n    - id: draft.choose\n");
    execFileSync.mockReturnValue(`${root}\n`);
    readWorkflowGuidance({ instanceId: "WF", contextRefs: [project] });
    expect(execFileSync).toHaveBeenCalledWith("git", ["-C", nodePath.dirname(project), "rev-parse", "--show-toplevel"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 2000, windowsHide: true });
  });

  // Both are built deep in startup, which no unit test constructs without injected execs.
  it("startup: the history query's exec and Windows Compose transport", () => {
    const src = fs.readFileSync(fileURLToPath(new URL("../src/startup.ts", import.meta.url)), "utf-8");
    expect(src).toContain("execFile(cmd, args, { maxBuffer: 10 * 1024 * 1024, windowsHide: true }, (err, stdout) => {");
    expect(src).toContain('new ComposeServicesAdapter(opts?.tmuxExec ?? execCommand, !opts?.tmuxExec && process.platform === "win32" ? "win32" : "posix")');
  });
});
