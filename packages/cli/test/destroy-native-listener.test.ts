import { afterEach, expect, it, vi } from "vitest";

const child = vi.hoisted(() => ({ execFileSync: vi.fn() }));
vi.mock("node:child_process", async (original) => ({ ...await original<object>(), execFileSync: child.execFileSync }));
import { findListeningPid, isWithinPath, killTmuxSessionWithCli, terminateListenerPid } from "../src/destroy-helpers.js";

afterEach(() => {
  child.execFileSync.mockReset();
  vi.restoreAllMocks();
});

it("finds a Windows listening PID without lsof or a shell", () => {
  const run = vi.fn(() => [
    "  TCP    127.0.0.1:7433    0.0.0.0:0    LISTENING    1200",
    "  TCP    [::1]:7433       [::]:0       LISTENING    1200",
    "  TCP    127.0.0.1:17433   0.0.0.0:0    LISTENING    9999",
    "  TCP    127.0.0.1:7433    127.0.0.1:1234 ESTABLISHED 8888",
    "  UDP    0.0.0.0:7433      *:*                       5555",
  ].join("\r\n"));
  expect(findListeningPid(7433, "win32", run)).toBe(1200);
  // "-p tcp" would list IPv4 sockets only.
  expect(run).toHaveBeenCalledWith("netstat.exe", ["-ano"]);
});

it("finds a Windows daemon that listens on IPv6 only, as localhost often resolves to ::1", () => {
  expect(findListeningPid(7433, "win32", () => [
    "  TCP    0.0.0.0:135       0.0.0.0:0    LISTENING    2264",
    "  TCP    [::1]:7433        [::]:0       LISTENING    1200",
    "  TCP    [::1]:7433        [::1]:50000  ESTABLISHED  1200",
    "  TCP    [::1]:50000       [::1]:7433   ESTABLISHED  7777",
  ].join("\r\n"))).toBe(1200);
});

it.each([
  ["German", "ABHÖREN", "HERGESTELLT"],
  ["Spanish", "ESCUCHANDO", "ESTABLECIDO"],
  ["French", "ÉCOUTE", "ÉTABLI"],
])("finds the Windows listener whatever language netstat prints its state in (%s)", (_language, listening, established) => {
  expect(findListeningPid(7433, "win32", () => [
    `  TCP    127.0.0.1:7433    0.0.0.0:0    ${listening}    1200`,
    `  TCP    127.0.0.1:7433    127.0.0.1:50000    ${established}    8888`,
    `  TCP    127.0.0.1:50000    127.0.0.1:7433    ${established}    7777`,
  ].join("\r\n"))).toBe(1200);
});

it("refuses ambiguous Windows port owners rather than selecting a sibling", () => {
  expect(findListeningPid(7433, "win32", () => [
    "TCP 127.0.0.1:7433 0.0.0.0:0 LISTENING 1200",
    "TCP 192.0.2.1:7433 0.0.0.0:0 LISTENING 1300",
  ].join("\n"))).toBeNull();
});

it("keeps lsof's first listener on POSIX, as rig destroy always has", () => {
  const run = vi.fn(() => "1200\n1300\n");
  expect(findListeningPid(7433, "linux", run)).toBe(1200);
  expect(run).toHaveBeenCalledWith("lsof", ["-ti", "tcp:7433", "-sTCP:LISTEN"]);
  expect(findListeningPid(7433, "darwin", () => "  \n")).toBeNull();
  expect(findListeningPid(7433, "linux", () => "not-a-pid\n")).toBeNull();
});

it("treats failed inspection as unknown", () => {
  expect(findListeningPid(7433, "win32", () => { throw new Error("unavailable"); })).toBeNull();
  expect(findListeningPid(7433, "linux", () => { throw new Error("lsof missing"); })).toBeNull();
});

it("sends SIGTERM on POSIX, but never force-terminates a Windows daemon whose drain channel refused", () => {
  const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
  terminateListenerPid(4242, "linux");
  expect(kill).toHaveBeenCalledWith(4242, "SIGTERM");
  kill.mockClear();
  expect(() => terminateListenerPid(4242, "win32")).toThrow(/no termination was sent/);
  expect(kill).not.toHaveBeenCalled();
});

it("kills a tmux session by its plain name on POSIX and by exact name on psmux", () => {
  expect(killTmuxSessionWithCli("dev@rig", "linux")).toBe(true);
  expect(child.execFileSync).toHaveBeenLastCalledWith("tmux", ["kill-session", "-t", "dev@rig"], { stdio: "ignore" });
  expect(killTmuxSessionWithCli("dev@rig", "win32")).toBe(true);
  expect(child.execFileSync).toHaveBeenLastCalledWith("tmux", ["kill-session", "-t", "=dev@rig"], { stdio: "ignore" });
  child.execFileSync.mockImplementation(() => { throw new Error("can't find session"); });
  expect(killTmuxSessionWithCli("gone@rig", "linux")).toBe(false);
});

it("recognises Windows state files under the state root whatever their separators and case", () => {
  const root = "C:\\Users\\me\\.openrig";
  expect(isWithinPath("C:\\Users\\me\\.openrig\\openrig.sqlite", root, "win32")).toBe(true);
  expect(isWithinPath("c:\\users\\ME\\.openrig\\transcripts", root, "win32")).toBe(true);
  expect(isWithinPath("C:/Users/me/.openrig/openrig.sqlite-wal", root, "win32")).toBe(true);
  expect(isWithinPath(root, root, "win32")).toBe(true);
  expect(isWithinPath("C:\\Users\\me\\.openrig-other\\openrig.sqlite", root, "win32")).toBe(false);
  expect(isWithinPath("C:\\Users\\me\\..openrig\\x", "C:\\Users\\me", "win32")).toBe(true);
  expect(isWithinPath("D:\\Users\\me\\.openrig\\openrig.sqlite", root, "win32")).toBe(false);
  // POSIX keeps its exact string-prefix rule.
  expect(isWithinPath("/home/me/.openrig/openrig.sqlite", "/home/me/.openrig", "linux")).toBe(true);
  expect(isWithinPath("/home/me/.openrig-other/x", "/home/me/.openrig", "linux")).toBe(false);
  expect(isWithinPath("/home/ME/.openrig/x", "/home/me/.openrig", "darwin")).toBe(false);
});
