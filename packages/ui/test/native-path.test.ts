import { describe, expect, it } from "vitest";
import { isPathPrefix, isWindowsPath, pathBasename, relativeUnder } from "../src/lib/native-path.js";

describe("native-path helpers for daemon-reported absolute paths", () => {
  it("keeps POSIX paths '/'-only and case-sensitive", () => {
    expect(isPathPrefix("/Users/x/", "/Users/x/missions/m1")).toBe(true);
    expect(isPathPrefix("/work", "/workspace")).toBe(false);
    expect(isPathPrefix("/Users/X", "/Users/x/missions")).toBe(false);
    expect(isPathPrefix("/w", "/w\\missions")).toBe(false);
    expect(relativeUnder("/Users/x", "/Users/x/missions/m1/")).toBe("missions/m1");
    expect(relativeUnder("/Users/x", "/Users/x")).toBe("");
    expect(relativeUnder("/Users/x", "/elsewhere/")).toBe("/elsewhere");
    expect(pathBasename("/Users/x/workspace/")).toBe("workspace");
    expect(pathBasename("/Users/x/back\\slash")).toBe("back\\slash");
    expect(isWindowsPath("//not/unc")).toBe(false);
  });

  it("reads Windows drive and UNC paths with either separator and any drive or ASCII casing", () => {
    expect(isPathPrefix("C:\\w", "C:\\w\\missions\\m1")).toBe(true);
    expect(isPathPrefix("c:\\W\\", "C:\\w\\missions")).toBe(true);
    expect(isPathPrefix("C:\\work", "C:\\workspace")).toBe(false);
    expect(isPathPrefix("\\\\server\\share", "\\\\server\\share\\missions")).toBe(true);
    expect(relativeUnder("C:\\w", "C:\\w\\missions\\M1")).toBe("missions/M1");
    expect(relativeUnder("c:/w", "C:\\W\\missions\\m1\\")).toBe("missions/m1");
    expect(relativeUnder("\\\\server\\share\\", "\\\\server\\share\\missions\\m1")).toBe("missions/m1");
    expect(relativeUnder("C:\\w", "C:\\W")).toBe("");
    expect(pathBasename("C:\\Users\\x\\workspace\\")).toBe("workspace");
    expect(pathBasename("C:\\")).toBe("C:");
  });

  it("never matches a Windows path against a POSIX one", () => {
    expect(isPathPrefix("/", "\\\\server\\share")).toBe(false);
    expect(isPathPrefix("C:\\w", "/w/missions")).toBe(false);
  });
});
