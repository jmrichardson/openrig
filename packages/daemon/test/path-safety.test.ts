import { describe, expect, it } from "vitest";
import { isRootedPath, validateSafePath } from "../src/domain/path-safety.js";

describe("isRootedPath", () => {
  it.each(["/abs", "\\notes.md", "\\\\server\\share\\notes.md", "C:notes.md", "c:\\notes.md", "C:/notes.md"])("treats %s as rooted on Windows", (path) => {
    expect(isRootedPath(path, "win32")).toBe(true);
  });

  it("is a leading '/' elsewhere: backslash and drive-letter names are ordinary relative names there", () => {
    expect(isRootedPath("/abs", "linux")).toBe(true);
    for (const path of ["\\notes.md", "C:notes.md", "a:b/c.md", "notes.md"]) expect(isRootedPath(path, "darwin")).toBe(false);
    expect(isRootedPath("notes.md", "win32")).toBe(false);
  });
});

describe("validateSafePath", () => {
  it("refuses Windows drive-relative paths only under Windows rules", () => {
    expect(validateSafePath("C:notes.md", "path", "win32")).toBe('path: absolute paths are not allowed (got "C:notes.md")');
    expect(validateSafePath("a:notes.md", "path", "linux")).toBeNull();
  });

  it("keeps the same rules on every platform for absolute, drive-absolute and traversal paths", () => {
    for (const platform of ["linux", "win32"] as const) {
      expect(validateSafePath("/etc/passwd", "path", platform)).toBe('path: absolute paths are not allowed (got "/etc/passwd")');
      expect(validateSafePath("\\notes.md", "path", platform)).toBe('path: absolute paths are not allowed (got "\\notes.md")');
      expect(validateSafePath("C:\\notes.md", "path", platform)).toBe('path: absolute paths are not allowed (got "C:\\notes.md")');
      expect(validateSafePath("nested\\..\\notes.md", "path", platform)).toBe('path: path traversal (..) is not allowed (got "nested\\..\\notes.md")');
      expect(validateSafePath("", "path", platform)).toBe("path: path is required");
      expect(validateSafePath("nested/notes.md", "path", platform)).toBeNull();
    }
  });
});
