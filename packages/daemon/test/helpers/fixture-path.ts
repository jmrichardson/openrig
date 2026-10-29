import nodePath from "node:path";

/**
 * Tests author in-memory fixture paths in POSIX form ("/project/rigs/x"). Product code builds
 * paths with node:path, which on win32 yields drive-qualified backslash paths
 * ("C:\project\rigs\x"), or rooted-but-driveless ones when it only joins ("\project\rigs\x").
 * `nativePath` maps either form to the one absolute path the product means. Identity on POSIX.
 */
export function nativePath(p: string): string {
  return process.platform === "win32" ? nodePath.resolve(p) : p;
}

/**
 * The key of a POSIX-form fixture map that names the same file as the product-built path `p`,
 * or undefined. Looked up on every call so maps mutated after creation still match.
 */
export function fixtureKey(files: Record<string, unknown>, p: string): string | undefined {
  if (Object.hasOwn(files, p)) return p;
  const native = nativePath(p);
  return Object.keys(files).find((k) => nativePath(k) === native);
}

/** Read-only in-memory fs over a fixture map keyed by POSIX-form paths. */
export function fixtureFs(files: Record<string, string>): { readFile(p: string): string; exists(p: string): boolean } {
  return {
    readFile: (p) => {
      const k = fixtureKey(files, p);
      if (k === undefined) throw new Error(`Not found: ${p}`);
      return files[k]!;
    },
    exists: (p) => fixtureKey(files, p) !== undefined,
  };
}
