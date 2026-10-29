import { execFileSync } from "node:child_process";
import path from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { powershellQuote } from "@openrig/daemon/windows-launch";

/** Encode the script rather than interpolating Windows paths through cmd.exe. */
export function powershellCommand(script: string): string {
  // Desktop terminals can inherit PowerShell 7's module path, while these
  // commands deliberately run Windows PowerShell 5.1. Use its own system
  // modules for hashing, archive extraction and setup without profile edits.
  return `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(`$env:PSModulePath = [IO.Path]::Combine($env:WINDIR, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'); $ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); ${script}`, "utf16le").toString("base64")}`;
}

export const WINDOWS_POWERSHELL_PROBE = powershellCommand("$PSVersionTable.PSVersion.ToString()");

/** Start only the daemon outside the caller's ConPTY process tree. No permanent startup change. */
export function windowsOperatorDaemonStartCommand(node = process.execPath, entry = fileURLToPath(new URL("./bin-wrapper.js", import.meta.url)), env: NodeJS.ProcessEnv = process.env): string {
  const keys = ["OPENRIG_HOME", "RIGGED_HOME", "OPENRIG_DB", "RIGGED_DB", "OPENRIG_PORT", "RIGGED_PORT", "OPENRIG_BIND_HOST", "PSMUX_DATA_DIR", "CODEX_HOME", "CLAUDE_CONFIG_DIR"];
  const settings = keys.filter(key => env[key] !== undefined).map(key => `$env:${key} = ${powershellQuote(env[key]!)}`).join("\n");
  const child = Buffer.from(`$env:PSModulePath = [IO.Path]::Combine($env:WINDIR, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules')\n${settings}\n& ${powershellQuote(node)} ${powershellQuote(entry)} daemon start\nexit $LASTEXITCODE`, "utf16le").toString("base64");
  return powershellCommand(`
$name = 'OpenRig-operator-start-' + [Guid]::NewGuid().ToString('N')
$action = New-ScheduledTaskAction -Execute ([IO.Path]::Combine($env:WINDIR, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')) -Argument '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${child}'
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 3)
Register-ScheduledTask -TaskName $name -Action $action -Principal $principal -Settings $settings | Out-Null
try {
  $started = [DateTime]::Now.AddSeconds(-1)
  Start-ScheduledTask -TaskName $name
  $deadline = [DateTime]::UtcNow.AddSeconds(130)
  do {
    Start-Sleep -Milliseconds 200
    $task = Get-ScheduledTask -TaskName $name
    $info = Get-ScheduledTaskInfo -TaskName $name
    if ($info.LastRunTime -ge $started -and $task.State -notin @('Running', 'Queued')) {
      if ($info.LastTaskResult -ne 0) { throw ('OpenRig daemon start failed with exit code ' + $info.LastTaskResult + '; inspect rig daemon logs.') }
      return
    }
  } while ([DateTime]::UtcNow -lt $deadline)
  throw ('Timed out waiting for ' + $name + '; inspect rig status before retrying.')
} finally {
  $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  if ($task -and $task.State -notin @('Running', 'Queued')) { Unregister-ScheduledTask -TaskName $name -Confirm:$false }
}
`);
}

/** Opt-in per-user startup; absolute paths avoid npm shim and shell PATH dependencies. */
export function windowsAutostartCommand(node = process.execPath, entry = fileURLToPath(new URL("./bin-wrapper.js", import.meta.url))): string {
  return powershellCommand(`
$action = New-ScheduledTaskAction -Execute ${powershellQuote(node)} -Argument ${powershellQuote(`"${entry}" start --last --json`)}
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
Register-ScheduledTask -TaskName 'OpenRig - Start daemon and kernel' -Description 'Start OpenRig and restore previously running rigs at Windows sign-in.' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
`);
}

/** The policy a new Windows PowerShell starts with: drop any -ExecutionPolicy override this probe inherited. */
export const WINDOWS_EXECUTION_POLICY_PROBE = powershellCommand("Remove-Item Env:PSExecutionPolicyPreference -ErrorAction SilentlyContinue; [string](Get-ExecutionPolicy)");

/** In a PowerShell seat pane `rig` resolves to the seat bin's rig.ps1 ahead of rig.cmd, and these policies refuse
 *  to run it. Only reported: the policy belongs to the person or their administrator. */
export function windowsExecutionPolicyCheck(exec: (cmd: string) => string): { status: "pass" | "warn"; message: string; reason?: string; fix?: string } {
  let policy: string;
  try {
    policy = exec(WINDOWS_EXECUTION_POLICY_PROBE).trim();
  } catch (err) {
    return { status: "warn", message: `Could not read the Windows PowerShell execution policy: ${String(err)}` };
  }
  if (policy !== "Restricted" && policy !== "AllSigned") return { status: "pass", message: `Windows PowerShell execution policy: ${policy}.` };
  return {
    status: "warn",
    message: `Windows PowerShell's execution policy is ${policy}, so the rig command fails in PowerShell seats.`,
    reason: "In a PowerShell pane, rig runs the seat's rig.ps1 script, which this policy refuses. Git Bash and cmd seats are unaffected.",
    fix: "Run Set-ExecutionPolicy -Scope CurrentUser RemoteSigned in Windows PowerShell. If Group Policy sets the policy, ask your administrator.",
  };
}

export function windowsPsmuxDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return path.win32.join(env["LOCALAPPDATA"] ?? path.win32.join(env["USERPROFILE"] ?? homedir(), "AppData", "Local"), "OpenRig", "tools", "psmux-3.4.0");
}

/** Add $destination to the user Path once. Read and write the raw registry value: [Environment] would return
 *  it expanded and store it as REG_SZ, freezing every %VAR% entry (such as the default WindowsApps one). */
const USER_PATH_SCRIPT = `
$openrigEnvironment = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
try {
  $userPath = [string]$openrigEnvironment.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  $entries = @($userPath -split ';' | ForEach-Object { [Environment]::ExpandEnvironmentVariables($_).TrimEnd('\\') })
  if ($entries -notcontains $destination.TrimEnd('\\')) {
    $kind = if ($null -eq $openrigEnvironment.GetValue('Path')) { [Microsoft.Win32.RegistryValueKind]::ExpandString } else { $openrigEnvironment.GetValueKind('Path') }
    $openrigEnvironment.SetValue('Path', (($userPath.TrimEnd(';') + ';' + $destination).TrimStart(';')), $kind)
    # Tell Explorer, as [Environment] does. Without it only processes started after the next sign-in see the change.
    try {
      Add-Type -Namespace OpenRig -Name SettingChange -MemberDefinition '[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);'
      $openrigResult = [UIntPtr]::Zero
      [void][OpenRig.SettingChange]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$openrigResult)
    } catch { }
  }
} finally { $openrigEnvironment.Close() }
`;

/** Put an earlier setup's portable psmux back on the user Path without touching its files. */
export function psmuxUserPathCommand(env: NodeJS.ProcessEnv = process.env): string {
  return powershellCommand(`
$destination = ${powershellQuote(windowsPsmuxDirectory(env))}
if (-not (Test-Path -LiteralPath (Join-Path $destination 'tmux.exe') -PathType Leaf)) { throw "No portable psmux at $destination." }
${USER_PATH_SCRIPT}`);
}

/** Portable upstream artifacts preserve running sessions; the NSIS installer kills them. */
export function psmuxInstallCommand(env: NodeJS.ProcessEnv = process.env, arch: string = process.arch): string {
  const releases: Record<string, { arch: string; sha256: string }> = {
    x64: { arch: "x64", sha256: "a66b6be7c13c6fa0dc3660a267b9e34eaa91a4eb7f07fbd55a0468018bd0f721" },
    arm64: { arch: "arm64", sha256: "b123398e3b37408032bc268b4da6e7a6eab5b56461e0c3414914513a57a7a5cf" },
    ia32: { arch: "x86", sha256: "b1d5f037befaa4dca94280bf0559531d9bbbc2d03e66cbb4f47961f82a8fc0c1" },
  };
  const release = releases[arch];
  if (!release) throw new Error(`No native psmux release for architecture ${arch}.`);
  const destination = powershellQuote(windowsPsmuxDirectory(env));
  return powershellCommand(`
$destination = ${destination}
if (Test-Path -LiteralPath $destination) { throw "Refusing to overwrite existing psmux directory: $destination. Add it to PATH or repair it manually." }
$temp = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $temp | Out-Null
try {
  $archive = Join-Path $temp 'psmux.zip'
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/psmux/psmux/releases/download/v3.4.0/psmux-v3.4.0-windows-${release.arch}.zip' -OutFile $archive
  if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne '${release.sha256}') { throw 'psmux archive SHA256 mismatch' }
  $expanded = Join-Path $temp 'expanded'
  Expand-Archive -LiteralPath $archive -DestinationPath $expanded
  $binary = @(Get-ChildItem -LiteralPath $expanded -Filter tmux.exe -Recurse -File)
  if ($binary.Count -ne 1) { throw 'psmux archive must contain exactly one tmux.exe' }
  New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
  Move-Item -LiteralPath $binary[0].Directory.FullName -Destination $destination
${USER_PATH_SCRIPT}
} finally { Remove-Item -LiteralPath $temp -Recurse -Force }
`);
}

/** Preserve this process's PATH overrides and pick up newly installed user/machine tools. */
export function refreshWindowsPath(): void {
  const script = "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); [Environment]::GetEnvironmentVariable('Path','Machine'); [Environment]::GetEnvironmentVariable('Path','User')";
  const output = execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
  const paths = [process.env["PATH"] ?? "", ...output.trim().split(/\r?\n/)].join(";").split(";").filter(Boolean);
  process.env["PATH"] = [...new Set(paths)].join(";");
}

export function wingetInstallCommand(id: string): string {
  return powershellCommand(`& winget.exe install --id ${powershellQuote(id)} --exact --accept-source-agreements --accept-package-agreements --disable-interactivity; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`);
}
