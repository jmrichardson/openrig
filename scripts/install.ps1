# Native Windows counterpart to install.sh. No WSL, shell profile edits or logins.
[CmdletBinding()]
param(
    [Alias('dry-run')][switch]$DryRun,
    # A list: -Providers claude,codex at a PowerShell prompt binds two values; through -File it is one.
    [ValidateSet('claude', 'codex', 'claude,codex', 'codex,claude', 'both')][string[]]$Providers = @('both'),
    [switch]$Full
)
$ErrorActionPreference = 'Stop'
$script:FailureCode = 1
$providerList = $Providers -join ','

function Invoke-InstallStep {
    param([string]$Label, [string]$Executable, [string[]]$Arguments)
    Write-Host "`n[$Label] $Executable $($Arguments -join ' ')"
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) {
        $script:FailureCode = $LASTEXITCODE
        throw "FAILED [$Label] $Executable $($Arguments -join ' ') (exit $LASTEXITCODE). See the command output above."
    }
}

Write-Host @"
OpenRig native Windows install plan:
  [1/4] Check Node.js 22 or 24 and native npm.cmd on PATH; print their versions.
        As the installed checker does, refuse below 22 and odd majors; later even majors warn as untested.
  [2/4] npm.cmd install -g @openrig/cli
        Locate the installed CLI with npm.cmd root -g, not a stale rig on PATH.
        Run its scripts/check-abi.mjs even if npm skipped postinstall.
  [3/4] rig setup --dry-run --providers $providerList
  [4/4] rig setup --providers $providerList
        Check native Windows PowerShell and Git for Windows (winget Git.Git if missing).
        Check psmux's tmux.exe alias; install a SHA256-verified portable release if missing.
        Add the portable directory to user PATH without stopping existing sessions.
        Update only the OpenRig block in the existing psmux config, or create .psmux.conf.
        Install/check only selected providers; no login or provider session is started.
        No WSL, Homebrew, cmux, herdr or Unix installer is used.
Full profile: $Full (also checks/installs jq and GitHub CLI with winget).
The wrapper does not choose permissions, launch a team, or open a kernel conversation.
Missing Node: install Node.js 22 or 24 with npm from https://nodejs.org/en/download.
"@
if ($DryRun) {
    Write-Host 'Dry run: no commands executed or changes made.'
    return
}

try {
    $node = @(Get-Command node.exe -CommandType Application -ErrorAction Stop)[0].Source
    $npm = @(Get-Command npm.cmd -CommandType Application -ErrorAction Stop)[0].Source
    Invoke-InstallStep '1/4' $node @('--version')
    $major = [int]((& $node --version) -replace '^v(\d+).*$', '$1')
    if ($major -lt 22 -or ($major % 2) -ne 0) { throw "Node.js 22 or 24 is required; Node $major is below 22 or an odd-numbered release. Install a supported native Node release before retrying." }
    if ($major -ne 22 -and $major -ne 24) { Write-Warning "Node $major is untested with OpenRig. Supported: Node.js 22 and 24 (LTS)." }
    Invoke-InstallStep '1/4' $npm @('--version')
    Invoke-InstallStep '2/4' $npm @('install', '-g', '@openrig/cli')
    $modules = & $npm root -g
    if ($LASTEXITCODE -ne 0) {
        $script:FailureCode = $LASTEXITCODE
        throw "FAILED [2/4] npm.cmd root -g (exit $LASTEXITCODE)."
    }
    $package = Join-Path ([string]$modules).Trim() '@openrig/cli'
    $checker = Join-Path $package 'scripts/check-abi.mjs'
    $rig = Join-Path $package 'dist/bin-wrapper.js'
    if (-not (Test-Path -LiteralPath $checker -PathType Leaf)) { throw "Installed Node/SQLite checker not found: $checker" }
    if (-not (Test-Path -LiteralPath $rig -PathType Leaf)) { throw "Installed rig entrypoint not found: $rig" }
    Invoke-InstallStep '2/4' $node @($checker)
    Write-Host 'Node/SQLite compatibility check passed.'
    $setup = @($rig, 'setup', '--providers', $providerList)
    if ($Full) { $setup += '--full' }
    Invoke-InstallStep '3/4' $node ($setup + '--dry-run')
    Invoke-InstallStep '4/4' $node $setup
    $env:Path = $env:Path + ';' + [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
    Write-Host 'Follow the next steps printed by rig setup. Reopen your terminal to pick up newly installed tools on PATH.'
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit $script:FailureCode
}
