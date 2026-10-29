import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveCliEntry } from "../src/cli-entry.js";

describe("standalone TUI CLI entry", () => {
  it.each(["linux", "darwin"] as const)("keeps the launching entry or rig from PATH on %s", (platform) => {
    const exists = vi.fn(() => true);
    expect(resolveCliEntry(path.resolve("packages/tui/dist"), { OPENRIG_TUI_CLI_ENTRY: "/opt/openrig/dist/bin-wrapper.js" }, exists, platform)).toBe("/opt/openrig/dist/bin-wrapper.js");
    expect(resolveCliEntry(path.resolve("packages/tui/dist"), { PATH: "/usr/local/bin" }, exists, platform)).toBeUndefined();
    expect(exists).not.toHaveBeenCalled();
  });
  it("retains the launching CLI rather than resolving a conflicting PATH shim", () => {
    const exists = vi.fn(() => false);
    expect(resolveCliEntry("unused", { OPENRIG_TUI_CLI_ENTRY: "C:\\Program Files\\OpenRig\\dist\\bin-wrapper.js" }, exists, "win32")).toBe("C:\\Program Files\\OpenRig\\dist\\bin-wrapper.js");
    expect(exists).not.toHaveBeenCalled();
  });
  it.each([
    ["packages/tui/dist", "packages/cli/dist/bin-wrapper.js"],
    ["installed/cli/tui/dist", "installed/cli/dist/bin-wrapper.js"],
  ])("locates the JavaScript entry from %s without executing rig.cmd", (base, entry) => {
    const expected = path.resolve(entry);
    expect(resolveCliEntry(path.resolve(base), {}, candidate => candidate === expected, "win32")).toBe(expected);
  });
  it("falls back to the JavaScript entry behind npm's rig.cmd on PATH", () => {
    const files = new Set(["C:\\npm\\rig.cmd", "C:\\npm\\node_modules\\@openrig\\cli\\dist\\bin-wrapper.js", "D:\\tools\\node_modules\\@openrig\\cli\\dist\\bin-wrapper.js"]);
    const env = { PATH: "relative;D:\\tools;C:\\npm" };
    expect(resolveCliEntry(path.resolve("standalone/tui/dist"), env, file => files.has(file), "win32")).toBe("C:\\npm\\node_modules\\@openrig\\cli\\dist\\bin-wrapper.js");
  });
  it("reads a quoted PATH entry as Windows does", () => {
    const files = new Set(["C:\\Program Files\\nodejs\\rig.cmd", "C:\\Program Files\\nodejs\\node_modules\\@openrig\\cli\\dist\\bin-wrapper.js"]);
    const env = { PATH: "C:\\Windows;\"C:\\Program Files\\nodejs\"" };
    expect(resolveCliEntry(path.resolve("standalone/tui/dist"), env, file => files.has(file), "win32")).toBe("C:\\Program Files\\nodejs\\node_modules\\@openrig\\cli\\dist\\bin-wrapper.js");
  });
  it("reports an unavailable CLI rather than inventing a local reader", () => {
    expect(resolveCliEntry(path.resolve("standalone/tui/dist"), { PATH: "C:\\npm" }, () => false, "win32")).toBeUndefined();
  });
});
