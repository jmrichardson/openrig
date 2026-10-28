import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resolveAttachContext } from "../src/commands/attach.js";

// The default execs, not injected ones: POSIX keeps its /bin/sh command string, Windows passes argv.
const childProcess = vi.hoisted(() => ({ execSync: vi.fn(), execFileSync: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  execSync: childProcess.execSync,
  execFileSync: childProcess.execFileSync,
}));

const ATTACHED = { attachmentType: "tmux", tmuxSession: "dev1-impl2@rigged-buildout", tmuxWindow: "@12", tmuxPane: "%42" };
let savedPane: string | undefined;

beforeEach(() => {
  vi.resetAllMocks();
  savedPane = process.env["TMUX_PANE"];
  process.env["TMUX_PANE"] = "%42";
});

afterEach(() => {
  if (savedPane === undefined) delete process.env["TMUX_PANE"];
  else process.env["TMUX_PANE"] = savedPane;
});

it("runs the tmux command string through the shell off Windows", () => {
  childProcess.execSync.mockReturnValue("%42 @12 dev1-impl2@rigged-buildout\n");

  expect(resolveAttachContext(undefined, "linux")).toEqual(ATTACHED);
  expect(childProcess.execSync).toHaveBeenCalledTimes(1);
  expect(childProcess.execSync).toHaveBeenCalledWith("tmux display-message -p -t '%42' '#{pane_id} #{window_id} #{session_name}'", { encoding: "utf-8" });
  expect(childProcess.execFileSync).not.toHaveBeenCalled();
});

it("falls back to external_cli off Windows when the shell cannot run tmux", () => {
  childProcess.execSync.mockImplementation(() => { throw new Error("Command failed: /bin/sh: 1: tmux: not found"); });

  expect(resolveAttachContext(undefined, "darwin")).toEqual({ attachmentType: "external_cli" });
  expect(childProcess.execFileSync).not.toHaveBeenCalled();
});

it("runs psmux's tmux with argv and no shell on Windows", () => {
  childProcess.execFileSync.mockReturnValue("%42 @12 dev1-impl2@rigged-buildout\n");

  expect(resolveAttachContext(undefined, "win32")).toEqual(ATTACHED);
  expect(childProcess.execFileSync).toHaveBeenCalledTimes(1);
  expect(childProcess.execFileSync).toHaveBeenCalledWith("tmux", ["display-message", "-p", "-t", "%42", "#{pane_id} #{window_id} #{session_name}"], { encoding: "utf-8" });
  expect(childProcess.execSync).not.toHaveBeenCalled();
});
