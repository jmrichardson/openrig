/** Starting a local instance must never silently target the default daemon or
 * launch kernel occupants before the user has selected them. */
export function daemonStartArgs(target: string): string[] {
  const url = new URL(target);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("This target is not a local daemon endpoint. Reconnect after its owner starts it; no local daemon was started.");
  }
  return ["daemon", "start", "--no-kernel", "--host", url.hostname.replace(/^\[|\]$/g, ""),
    "--port", url.port || "80"];
}

/** ⏎ RESTORE EVERYTHING runs a plain `rig daemon start`. Windows runs it through the
 * TUI's CLI entry, because Node's execFile cannot run the npm rig.cmd shim. */
export function fleetRestoreStartCommand(executable: string, prefix: string[], platform: NodeJS.Platform = process.platform): { executable: string; args: string[] } {
  if (platform === "win32") return { executable, args: [...prefix, "daemon", "start"] };
  return { executable: "rig", args: ["daemon", "start"] };
}
