/** A leading "/". On Windows, also a leading "\" (root-relative or UNC) and any drive prefix,
 *  including drive-relative "C:notes.md", which resolves against that drive's current folder. */
export function isRootedPath(path: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32" ? /^[\\/]|^[A-Za-z]:/.test(path) : path.startsWith("/");
}

/** How error text names the isRootedPath rule on this platform. */
export const ROOTED_PATH_RULE = process.platform === "win32" ? "rooted paths" : "leading '/'";

/**
 * Validates that a path is safe: relative, no traversal, no absolute.
 * @param path - the path to validate
 * @param label - human-readable label for error messages
 * @param platform - whose path rules apply; Windows also refuses drive-relative paths
 * @returns error string or null if valid
 */
export function validateSafePath(path: string, label: string, platform: NodeJS.Platform = process.platform): string | null {
  if (!path || typeof path !== "string") return `${label}: path is required`;
  // Windows drive letter absolute (on Windows, also drive-relative)
  if ((platform === "win32" ? /^[A-Za-z]:/ : /^[A-Za-z]:[/\\]/).test(path)) return `${label}: absolute paths are not allowed (got "${path}")`;
  // Normalize backslashes for traversal check
  const normalized = path.replace(/\\/g, "/");
  // Absolute path
  if (normalized.startsWith("/")) return `${label}: absolute paths are not allowed (got "${path}")`;
  // Traversal
  const segments = normalized.split("/");
  if (segments.some((s) => s === "..")) return `${label}: path traversal (..) is not allowed (got "${path}")`;
  return null;
}
