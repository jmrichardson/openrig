import path from "node:path";
import { windowsArguments } from "./windows-argv.js";

/** A Windows launch PATH's directories as libuv and PowerShell search them: each entry
 * trimmed and unquoted, and an empty one skipped, since it never means the working directory. */
export function windowsPathEntries(searchPath: string): string[] {
  return searchPath.split(path.delimiter).map(raw => raw.trim().replace(/^"(.*)"$/, "$1")).filter(entry => entry !== "");
}

/** Parse only the literal word form produced by the runtime command builders.
 * No expansions, operators or substitutions are evaluated or translated. */
export function parseLiteralLaunchWords(command: string): string[] {
  const words: string[] = [];
  let word = "", quote: "'" | '"' | undefined, started = false;
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    if (quote) {
      if (char === quote) quote = undefined;
      else {
        if (quote === '"' && /[$`\\]/.test(char)) throw new Error("Expanded launch word is unsupported");
        word += char;
      }
    } else if (char === "'" || char === '"') { quote = char; started = true; }
    else if (/\s/.test(char)) {
      if (started) { words.push(word); word = ""; started = false; }
    } else {
      if (/[;&|<>$`(){}\\]/.test(char)) throw new Error("Nonliteral launch syntax is unsupported");
      word += char; started = true;
    }
  }
  if (quote) throw new Error("Unterminated launch word");
  if (started) words.push(word);
  if (!words[0]) throw new Error("Empty launch command");
  return words;
}

/** A PowerShell single-quoted literal. PowerShell also ends one at U+2018-U+201B, so those double too. */
export function powershellQuote(value: string): string {
  return "'" + value.replace(/['‘’‚‛]/g, "$&$&") + "'";
}

export function renderWindowsLaunch(command: string, env: Readonly<Record<string, string>> = {}, credentialStep = ""): string {
  const [executable, ...args] = parseLiteralLaunchWords(command);
  const assignments = Object.entries(env).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error("Invalid environment name");
    return `$openrigStart.EnvironmentVariables[${powershellQuote(key)}]=${powershellQuote(value)}\n`;
  }).join("");
  // Windows PowerShell's native invocation drops empty argv words. Send the
  // literal Windows command line directly to CreateProcess instead, as the
  // managed launch path does, and keep its console handles attached to the pane.
  return `& {\n$openrigStart = New-Object System.Diagnostics.ProcessStartInfo\n`
    + `$openrigStart.UseShellExecute = $false\n$openrigStart.FileName = ${powershellQuote(executable!)}\n`
    + `$openrigStart.Arguments = ${powershellQuote(windowsArguments(args))}\n${assignments}${credentialStep}`
    + `$openrigChild = [Diagnostics.Process]::Start($openrigStart)\ntry { $openrigChild.WaitForExit(); $global:LASTEXITCODE = $openrigChild.ExitCode } finally { $openrigChild.Dispose() }\n}`;
}

/** Match managed env -i admission while retaining auth only by pane variable name. */
export function renderWindowsManagedLaunch(executable: string, args: readonly string[], cwd: string,
  environment: Readonly<Record<string, string>>, inherited: readonly string[], credentialStep = ""): string {
  const names = [...new Set(inherited)];
  if ([...Object.keys(environment), ...names].some(name => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && name !== "PROGRAMFILES(X86)")) throw new Error("Invalid managed environment name");
  const entries = Object.entries(environment).map(([key, value]) => `${powershellQuote(key)}=${powershellQuote(value)}`).join("; ");
  return `& {\n$openrigChildEnv = @{${entries}}\n`
    + `foreach ($openrigName in @(${names.map(powershellQuote).join(", ")})) { $openrigValue = [Environment]::GetEnvironmentVariable($openrigName, 'Process'); if ($openrigValue) { $openrigChildEnv[$openrigName] = $openrigValue } }\n`
    + credentialStep
    + `$openrigStart = New-Object System.Diagnostics.ProcessStartInfo\n$openrigStart.UseShellExecute = $false\n$openrigStart.FileName = ${powershellQuote(executable)}\n`
    + `$openrigStart.WorkingDirectory = ${powershellQuote(cwd)}\n$openrigStart.Arguments = ${powershellQuote(windowsArguments(args))}\n$openrigStart.EnvironmentVariables.Clear()\n`
    + `foreach ($openrigName in $openrigChildEnv.Keys) { $openrigStart.EnvironmentVariables[$openrigName] = $openrigChildEnv[$openrigName] }\n`
    + `$openrigChild = [Diagnostics.Process]::Start($openrigStart)\ntry { $openrigChild.WaitForExit(); $global:LASTEXITCODE = $openrigChild.ExitCode } finally { $openrigChild.Dispose() }\n}`;
}
/** psmux can deliver late OSC colour replies as native Windows key events.
 * Only recognise an entire otherwise-empty current composer, never old history
 * or a human draft containing additional text. Used during owned launch only. */
export function hasOnlyWindowsTerminalResponseDraft(content: string): boolean {
  const lines = content.split(/\r?\n/);
  let current = -1;
  for (let i = 0; i < lines.length; i++) if (/^\s*[›>]\s/.test(lines[i]!)) current = i;
  if (current < 0 || (lines[current + 1] ?? "").trim() !== "") return false;
  return /^\s*[›>]\s*(?:\](?:10|11);rgb:[0-9a-f]{1,4}\/[0-9a-f]{1,4}\/[0-9a-f]{1,4}\\){1,2}\s*$/i.test(lines[current]!);
}
