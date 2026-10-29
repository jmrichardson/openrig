// The daemon reports absolute paths in its own OS's syntax. A Windows daemon sends drive
// ("C:\w") or UNC ("\\server\share") paths with "\" separators, which Windows compares
// case-insensitively. Every other path is compared with "/" separators only.

const WINDOWS_ABSOLUTE = /^(?:[a-z]:[\\/]|\\\\)/i;

export function isWindowsPath(p: string): boolean {
  return WINDOWS_ABSOLUTE.test(p);
}

/** Without trailing separators; Windows paths also switch to "/" separators. */
function trimmed(p: string, windows: boolean): string {
  return windows ? p.replace(/\\/g, "/").replace(/\/+$/, "") : p.replace(/\/+$/, "");
}

// Fold ASCII only, so a folded path keeps its length and still slices its original.
const foldCase = (p: string) => p.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** Returns true when `parent` is a path-prefix of `child`, treating both as
 *  absolute filesystem paths. Trailing separators are tolerated; segment
 *  boundaries enforced (so "/work" is NOT a prefix of "/workspace"). */
export function isPathPrefix(parent: string, child: string): boolean {
  const windows = isWindowsPath(parent) && isWindowsPath(child);
  const p = windows ? foldCase(trimmed(parent, true)) : trimmed(parent, false);
  const c = windows ? foldCase(trimmed(child, true)) : trimmed(child, false);
  if (c === p) return true;
  return c.startsWith(p + "/");
}

/** Compute the "/"-separated path inside a root: child = "<root>/<rel>" → "<rel>". */
export function relativeUnder(rootPath: string, absChild: string): string {
  const windows = isWindowsPath(rootPath) && isWindowsPath(absChild);
  const p = trimmed(rootPath, windows);
  const c = trimmed(absChild, windows);
  const [pc, cc] = windows ? [foldCase(p), foldCase(c)] : [p, c];
  if (cc === pc) return "";
  if (cc.startsWith(pc + "/")) return c.slice(p.length + 1);
  return c;
}

/** The final path segment, for display. */
export function pathBasename(p: string): string {
  if (!p) return "";
  const windows = isWindowsPath(p);
  const t = trimmed(p, windows);
  const slash = t.lastIndexOf("/");
  return slash === -1 ? t : t.slice(slash + 1);
}
