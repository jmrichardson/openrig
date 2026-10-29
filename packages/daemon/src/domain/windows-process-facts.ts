import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface WindowsProcessFacts {
  cwd: string;
  exe: string;
  env: { CODEX_HOME?: string; HOME?: string; USERPROFILE?: string };
  apiKeyEnvNames: string[];
}

/** Narrow process-memory observer: no credential value crosses the helper boundary. */
export async function readWindowsProcessFacts(pid: number): Promise<WindowsProcessFacts | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const { stdout } = await execFileAsync(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.resolve(import.meta.dirname, "../../assets/windows-process-facts.ps1"), "-TargetPid", String(pid)],
      { encoding: "utf8", windowsHide: true, timeout: 15000, maxBuffer: 256 * 1024 });
    const value: unknown = JSON.parse(stdout.replace(/^\uFEFF/, ""));
    if (!value || typeof value !== "object") return null;
    const facts = value as Record<string, unknown>;
    if (typeof facts.cwd !== "string" || !path.win32.isAbsolute(facts.cwd)
      || typeof facts.exe !== "string" || !path.win32.isAbsolute(facts.exe)
      || !facts.env || typeof facts.env !== "object" || Array.isArray(facts.env)
      || !Array.isArray(facts.apiKeyEnvNames)) return null;
    const env: WindowsProcessFacts["env"] = {};
    for (const [key, entry] of Object.entries(facts.env)) {
      if ((key !== "CODEX_HOME" && key !== "HOME" && key !== "USERPROFILE") || typeof entry !== "string") return null;
      env[key] = entry;
    }
    if (facts.apiKeyEnvNames.some(key => key !== "OPENAI_API_KEY" && key !== "CODEX_API_KEY")) return null;
    // The PEB keeps a trailing separator on cwd; consumers compare directory identity.
    // resolve removes it for ordinary directories without truncating drive/UNC roots.
    return { cwd: path.win32.resolve(facts.cwd), exe: facts.exe, env, apiKeyEnvNames: facts.apiKeyEnvNames as string[] };
  } catch {
    return null;
  }
}
