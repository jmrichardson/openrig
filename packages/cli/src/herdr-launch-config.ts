import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** A Windows variable read case-insensitively, as Windows does; a copied environment is case-sensitive. */
export function windowsVariable(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return env[name] ?? Object.entries(env).find(([key]) => key.toUpperCase() === name)?.[1];
}

/** Herdr's directory on native Windows: XDG_CONFIG_HOME\herdr when set, else %APPDATA%\herdr (herdr 0.9.3). */
function windowsHerdrDirectory(env: NodeJS.ProcessEnv): string {
  const base = windowsVariable(env, "XDG_CONFIG_HOME") || windowsVariable(env, "APPDATA") || path.win32.join(homedir(), "AppData", "Roaming");
  return path.win32.join(base, "herdr");
}

/** The socket a Windows herdr CLI started with `env` uses: HERDR_SOCKET_PATH, else its HERDR_SESSION's, else the default. */
export function windowsHerdrSocketPath(env: NodeJS.ProcessEnv): string {
  const explicit = windowsVariable(env, "HERDR_SOCKET_PATH");
  if (explicit) return explicit;
  const session = windowsVariable(env, "HERDR_SESSION");
  return session ? path.win32.join(windowsHerdrDirectory(env), "sessions", session, "herdr.sock") : path.win32.join(windowsHerdrDirectory(env), "herdr.sock");
}

/** Each file Windows would run for a bare `name` on PATH, in its PATHEXT order. Only native executables are
 * listed: a .cmd or .bat runs through cmd.exe, which would interpret its arguments. */
export function windowsPathExecutables(env: NodeJS.ProcessEnv, name: string): string[] {
  const extensions = (windowsVariable(env, "PATHEXT") || ".COM;.EXE;.BAT;.CMD").split(";")
    .map(ext => ext.toLowerCase()).filter(ext => ext === ".exe" || ext === ".com");
  return (windowsVariable(env, "PATH") ?? "").split(";").filter(Boolean).flatMap(dir => extensions.map(ext => path.win32.join(dir, `${name}${ext}`)));
}

/** Where native Windows herdr can be: PATH, then the installer's current release and its compatibility alias. */
export function windowsHerdrCandidates(env: NodeJS.ProcessEnv): string[] {
  const local = windowsVariable(env, "LOCALAPPDATA");
  return [
    ...windowsPathExecutables(env, "herdr"),
    path.win32.join(windowsVariable(env, "USERPROFILE") || homedir(), ".herdr", "packages", "standalone", "current", "herdr.exe"),
    ...(local ? [path.win32.join(local, "Programs", "Herdr", "bin", "herdr.exe")] : []),
  ];
}

/** Herdr config precedence: personal files win; only an absent config gets a private default. */
export function prepareHerdrLaunchConfig(env: NodeJS.ProcessEnv, socketPath: string, columns?: number, platform: NodeJS.Platform = process.platform): string {
  // Windows herdr reads HERDR_CONFIG_PATH, else config.toml in its own directory.
  const p = platform === "win32" ? path.win32 : path;
  const source = platform === "win32"
    ? p.resolve(env["HERDR_CONFIG_PATH"] ?? p.join(windowsHerdrDirectory(env), "config.toml"))
    : path.resolve(env["HERDR_CONFIG_PATH"] ?? path.join(
      env["XDG_CONFIG_HOME"] ?? path.join(env["HOME"] ?? homedir(), ".config"), "herdr", "config.toml",
    ));
  // A personal config is authoritative, including an omitted sidebar setting and relative paths.
  try { readFileSync(source); return source; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const collapsed = !(Number.isSafeInteger(columns) && columns! >= 160);
  // Herdr shows its first-run tips over the view when `onboarding` is missing; the person's own
  // first Herdr launch outside OpenRig still gets them.
  const bytes = `onboarding = false\n\n[ui]\nsidebar_start_collapsed = ${collapsed}\n`;
  const key = createHash("sha256").update(source).update("\0").update(socketPath).update(String(collapsed)).digest("hex").slice(0, 20);
  const target = p.join(p.dirname(source), `.openrig-herdr-${key}.toml`);
  if (target === source) throw new Error("The private Herdr config must differ from the source config.");
  mkdirSync(p.dirname(source), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${randomUUID()}.tmp`;
  writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
  try { renameSync(temporary, target); }
  catch (error) { unlinkSync(temporary); throw error; }
  return target;
}
