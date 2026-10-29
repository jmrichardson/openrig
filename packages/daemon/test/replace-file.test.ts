import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replaceFile } from "../src/adapters/replace-file.js";
import { canCreateFileSymlinks } from "../../../test/symlink-capability.mjs";

describe("replaceFile staging ownership", () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "replace-file-")); });
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

  /** Create complete old and new bytes in an isolated directory. */
  function files() {
    const src = path.join(root, "source");
    const dest = path.join(root, "destination");
    fs.writeFileSync(src, "new complete bytes"); fs.chmodSync(src, 0o444);
    fs.writeFileSync(dest, "old complete bytes");
    return { src, dest };
  }

  // Creating a file symlink needs SeCreateSymbolicLinkPrivilege on Windows.
  it.skipIf(!canCreateFileSymlinks)("does not follow or consume an existing predictable symlink", () => {
    const { src, dest } = files();
    const victim = path.join(root, "unrelated");
    fs.writeFileSync(victim, "unrelated good bytes");
    const collision = `${dest}.${process.pid}.tmp`;
    fs.symlinkSync(victim, collision);
    replaceFile(src, dest);
    expect(fs.readFileSync(victim, "utf8")).toBe("unrelated good bytes");
    expect(fs.lstatSync(dest).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(dest, "utf8")).toBe("new complete bytes");
    expect(fs.lstatSync(collision).isSymbolicLink()).toBe(true);
  });

  it("leaves a stale readonly temporary slot intact and succeeds immediately", () => {
    const { src, dest } = files();
    const stale = `${dest}.${process.pid}.tmp`;
    fs.writeFileSync(stale, "stale bytes"); fs.chmodSync(stale, 0o444);
    replaceFile(src, dest);
    expect(fs.readFileSync(stale, "utf8")).toBe("stale bytes");
    expect(fs.readFileSync(dest, "utf8")).toBe("new complete bytes");
    expect(fs.statSync(dest).mode & 0o222).toBe(0);
  });

  it("replaces a read-only copy from an earlier call", () => {
    const { src, dest } = files();
    replaceFile(src, dest);
    fs.chmodSync(src, 0o644); fs.writeFileSync(src, "newer complete bytes"); fs.chmodSync(src, 0o444);
    replaceFile(src, dest);
    expect(fs.readFileSync(dest, "utf8")).toBe("newer complete bytes");
    expect(fs.statSync(dest).mode & 0o222).toBe(0);
    expect(fs.readdirSync(root).sort()).toEqual(["destination", "source"]);
  });

  // Windows only: the read-only attribute belongs to the file, shared by every hard link, and POSIX renames over it.
  it.runIf(process.platform === "win32")("keeps the error rather than clearing read-only on a hard-linked copy", () => {
    const { src, dest } = files();
    replaceFile(src, dest);
    const other = path.join(root, "other-link");
    fs.linkSync(dest, other);
    fs.chmodSync(src, 0o644); fs.writeFileSync(src, "newer complete bytes"); fs.chmodSync(src, 0o444);
    expect(() => replaceFile(src, dest)).toThrow(/EPERM/);
    expect(fs.statSync(other).mode & 0o222).toBe(0);
    expect(fs.readFileSync(other, "utf8")).toBe("new complete bytes");
    expect(fs.readFileSync(dest, "utf8")).toBe("new complete bytes");
    expect(fs.readdirSync(root).sort()).toEqual(["destination", "other-link", "source"]);
    fs.chmodSync(other, 0o644);
  });

  // Windows only: a copy another process holds open cannot be renamed over even once writable.
  it.runIf(process.platform === "win32")("keeps a read-only copy read-only when the retried rename fails too", () => {
    const { src, dest } = files();
    replaceFile(src, dest);
    fs.chmodSync(src, 0o644); fs.writeFileSync(src, "newer complete bytes"); fs.chmodSync(src, 0o444);
    const held = fs.openSync(dest, "r");
    try {
      expect(() => replaceFile(src, dest)).toThrow(/EPERM/);
    } finally {
      fs.closeSync(held);
    }
    expect(fs.statSync(dest).mode & 0o222).toBe(0);
    expect(fs.readFileSync(dest, "utf8")).toBe("new complete bytes");
    expect(fs.readdirSync(root).sort()).toEqual(["destination", "source"]);
  });

  it("does not remove another actor's slot when staging creation fails", () => {
    const { src, dest } = files();
    const collision = `${dest}.${process.pid}.tmp`;
    fs.writeFileSync(collision, "other actor bytes");
    const error = Object.assign(new Error("staging creation failed"), { code: "EACCES" });
    vi.spyOn(fs, "mkdtempSync").mockImplementation(() => { throw error; });
    const cleanup = vi.spyOn(fs, "rmSync");
    replaceFile(src, dest);
    expect(cleanup).not.toHaveBeenCalled();
    expect(fs.readFileSync(collision, "utf8")).toBe("other actor bytes");
    expect(fs.readFileSync(dest, "utf8")).toBe("new complete bytes");
  });

  it("reports the in-place copy error when staging creation and fallback both fail", () => {
    const { src, dest } = files();
    const stagingError = new Error("staging creation failed");
    const copyError = new Error("in-place copy failed");
    vi.spyOn(fs, "mkdtempSync").mockImplementation(() => { throw stagingError; });
    vi.spyOn(fs, "copyFileSync").mockImplementation(() => { throw copyError; });
    const cleanup = vi.spyOn(fs, "rmSync");
    expect(() => replaceFile(src, dest)).toThrow(copyError);
    expect(cleanup).not.toHaveBeenCalled();
    expect(fs.readFileSync(dest, "utf8")).toBe("old complete bytes");
  });

  it("cleans owned partial staging while preserving the destination on copy failure", () => {
    const { src, dest } = files();
    const error = new Error("partial copy failed");
    vi.spyOn(fs, "copyFileSync").mockImplementation((_src, tmp) => {
      fs.writeFileSync(tmp, "partial"); throw error;
    });
    expect(() => replaceFile(src, dest)).toThrow(error);
    expect(fs.readFileSync(dest, "utf8")).toBe("old complete bytes");
    expect(fs.readdirSync(root).sort()).toEqual(["destination", "source"]);
  });

  // Creating a file symlink needs SeCreateSymbolicLinkPrivilege on Windows.
  it.skipIf(!canCreateFileSymlinks)("refuses an unexpected symlink at the exclusive copy target", () => {
    const { src, dest } = files();
    const victim = path.join(root, "unrelated");
    fs.writeFileSync(victim, "unrelated good bytes");
    const copy = fs.copyFileSync;
    vi.spyOn(fs, "copyFileSync").mockImplementation((source, tmp, flags) => {
      fs.symlinkSync(victim, tmp);
      copy(source, tmp, flags);
    });
    expect(() => replaceFile(src, dest)).toThrow(/EEXIST/);
    expect(fs.readFileSync(victim, "utf8")).toBe("unrelated good bytes");
    expect(fs.readFileSync(dest, "utf8")).toBe("old complete bytes");
    expect(fs.readdirSync(root).sort()).toEqual(["destination", "source", "unrelated"]);
  });

  it("keeps the copy error when cleanup also fails", () => {
    const { src, dest } = files();
    const error = new Error("original copy error");
    vi.spyOn(fs, "copyFileSync").mockImplementation(() => { throw error; });
    vi.spyOn(fs, "rmSync").mockImplementation(() => { throw new Error("cleanup error"); });
    expect(() => replaceFile(src, dest)).toThrow(error);
    expect(fs.readFileSync(dest, "utf8")).toBe("old complete bytes");
  });
});
