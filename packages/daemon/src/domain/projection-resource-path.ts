import { createHash } from "node:crypto";

// NTFS allows 255 UTF-16 units per path component. The encoding below is ASCII and up to 12 times the id's length.
const MAX_WINDOWS_COMPONENT = 255;

/** Logical resource ids remain unchanged; only native Windows directory components are encoded. */
export function projectionResourceDirectory(id: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") return id;
  // Encoding uppercase/non-ASCII too prevents distinct ids colliding under NTFS case folding.
  let component = id.replace(/[^a-z0-9._-]/gu, char => Array.from(Buffer.from(char), byte => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`).join(""))
    .replace(/[. ]+$/, suffix => [...suffix].map(char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`).join(""));
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(component)) {
    component = `%${component.charCodeAt(0).toString(16).toUpperCase()}${component.slice(1)}`;
  }
  if (component.length > MAX_WINDOWS_COMPONENT) {
    // Keep a readable prefix plus a digest of the whole id. The canonical encoding never contains "~",
    // so projectionResourceId reports a shortened name as the directory it is rather than misreading it.
    const digest = createHash("sha256").update(id).digest("hex").slice(0, 16);
    component = `${component.slice(0, MAX_WINDOWS_COMPONENT - digest.length - 1)}~${digest}`;
  }
  return component;
}

/** Reverse only our canonical encoding, preserving unrelated user-installed directory names. */
export function projectionResourceId(directory: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") return directory;
  try {
    const id = decodeURIComponent(directory);
    return projectionResourceDirectory(id, platform) === directory ? id : directory;
  } catch { return directory; }
}
