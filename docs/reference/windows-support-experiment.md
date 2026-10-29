# Native Windows in this fork

This branch runs OpenRig directly on Windows with Windows PowerShell, psmux 3.4.0 or newer,
and Git for Windows. It combines upstream's Windows transport with the broader Windows port,
rebased onto current upstream behavior. Herdr remains the terminal workspace interface; psmux
owns durable agent sessions. No WSL is required. The upstream project and npm release have their
own support policy; install the package built from this branch to use these changes.

## Prerequisites

- Node.js 22 or 24 with npm, installed for Windows rather than inside WSL.
- Windows PowerShell 5.1 (`powershell.exe`), with an execution policy that allows local
  scripts, such as `RemoteSigned` (`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`).
  In a PowerShell seat, `rig` runs the seat's `rig.ps1`, which `Restricted` (the Windows
  client default) and `AllSigned` refuse. `rig setup` and `rig doctor` warn about those
  policies but never change them. Managed sessions start Windows PowerShell, whatever
  `SHELL` or psmux's own `default-shell` names.
- Git for Windows. The package build runs `scripts/build-package.sh` with its
  `bash.exe`, and Pi's bash tools use it.
- **psmux 3.4.0 or newer**, on PATH as `tmux.exe`. `rig setup`, `rig doctor` and
  preflight refuse older releases: 3.3.8 loses scrollback when a pane respawns.
  `rig setup` can install the portable 3.4.0 release ([what setup changes](#what-setup-changes)).
- Windows Terminal, for desktop views (`rig terminal open … --window`). The standalone
  TUI needs an interactive console.
- Provider CLIs. Managed Claude Code seats launch only from the native `claude.exe` on
  PATH, not an npm `claude.cmd` shim. Install it from Windows PowerShell with
  `irm https://claude.ai/install.ps1 | iex` and put the folder holding `claude.exe`
  (normally `%USERPROFILE%\.local\bin`) on PATH. Codex and Pi can come from npm: OpenRig
  runs the Node entry behind their standard `.cmd` shims directly, never through
  `cmd.exe`, and passes over another package manager's shim (pnpm, yarn, volta, scoop)
  to a later native or npm install on PATH. OMP needs its native executable.
- Python 3 from python.org, for the refocus hook's trace. The hook runs `py -3`, then
  `python.exe`, and skips the Microsoft Store alias under
  `%LOCALAPPDATA%\Microsoft\WindowsApps`; `PYTHON` overrides both.
- Optional: herdr, for herdr [terminal views](#terminal-views).

## Build and install from source

A default Git for Windows clone works. With `core.symlinks=false`, Git for Windows'
default, the context-pack files that link into `docs/reference/` are checked out as
one-line text files naming their target. The package build finds them in Git's index
and ships the documents they name, so you need neither Developer Mode nor
`core.symlinks=true`.

Both `npm run build:package` and `npm run build:package:windows` select Git for Windows' Bash explicitly.
The daemon and agents run as native Windows processes. Bash is needed for package assembly.

```powershell
git clone --branch feat/native-windows https://github.com/jmrichardson/openrig.git
cd openrig
npm ci
npm run build:package:windows
$package = npm pack --workspace @openrig/cli --pack-destination . | Select-Object -Last 1
npm install -g ".\$package"
rig setup --dry-run --providers codex
```

Pass `claude`, `codex`, `claude,codex` or `both` to `--providers`, then run
`rig setup` without `--dry-run` to apply it. Setup does not sign providers in.

`scripts\install.ps1` is the native counterpart of `install.sh`. It installs the
published `@openrig/cli` from npm rather than your checkout. That upstream package does not include this fork; use the source build above for native Windows. Preview its plan with
`powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1 -DryRun`.
`-Providers` takes `claude`, `codex`, `claude,codex` or `both`. Like the installed
checker, it refuses Node below 22 and odd-numbered releases, and warns that a later
even-numbered release is untested.

## What setup changes

On Windows, `rig setup`:

- checks Node.js, npm and Windows PowerShell, and installs a missing Git for Windows
  with `winget` (`Git.Git`);
- reads Windows PowerShell's execution policy and warns, without changing it, when it
  is `Restricted` or `AllSigned`;
- installs a missing psmux from the SHA256-verified portable 3.4.0 release into
  `%LOCALAPPDATA%\OpenRig\tools\psmux-3.4.0` and adds that folder to your user `Path`,
  keeping the value's registry type so `%VAR%` entries still expand. It does not stop
  running sessions and never overwrites that folder: a later run reuses the install
  there and puts it back on the user `Path`. `rig daemon start` and `rig preflight`
  also find it from a shell opened before setup;
- accepts Claude Code only as a native `claude.exe` on PATH, as the daemon does, and
  never installs Claude Code with npm; it installs a missing Codex with npm;
- reports an installed herdr and its version, but never installs or updates herdr;
- updates only the OpenRig block in the first psmux configuration it finds under
  `USERPROFILE` (`.psmux.conf`, `.psmuxrc`, `.tmux.conf`, `.config\psmux\psmux.conf`),
  or creates `.psmux.conf`;
- with `--full`, installs a missing jq and gh with `winget`;
- does not install or use WSL, Homebrew or cmux.

The rest of [what OpenRig changes on your machine](../../README.md#what-openrig-changes-on-your-machine)
applies, under your Windows user profile. Resource folders on disk encode characters
Windows reserves and case differences, so `.codex/plugins/shared:openrig-core/` is
written as `.codex/plugins/shared%3Aopenrig-core/`. A name that would pass NTFS's
255-character limit keeps a readable prefix, then `~` and 16 hex digits of the
resource ID's SHA-256. Resource IDs themselves do not change.

## Terminal views

`rig terminal open <view> --window` opens the view on the daemon's desktop:

- With herdr installed, it opens a new Windows Terminal window running a herdr client
  on the daemon's herdr endpoint. Run from inside a herdr pane, it uses that herdr
  session instead when its endpoint is the daemon's.
- Without herdr, or with `--provider tmux`, Windows Terminal lays out the view itself:
  each pane attaches to a seat's psmux session, and closing the window leaves the
  sessions running.

OpenRig looks for `herdr.exe` on PATH, in herdr's current release
(`%USERPROFILE%\.herdr\packages\standalone\current`) and at its compatibility alias
(`%LOCALAPPDATA%\Programs\Herdr\bin`). Setup never installs herdr on Windows. herdr's
own installer, from [herdr's Windows page](https://herdr.dev/docs/windows-beta/), is:

```powershell
powershell -ExecutionPolicy Bypass -c "irm https://herdr.dev/install.ps1 | iex"
```

Reopen your terminal afterwards so it sees the updated PATH. On Windows the daemon
talks to herdr over the named pipe named after herdr's socket file
(`\\.\pipe\<path of herdr.sock>`, under `%APPDATA%\herdr`, or under
`%XDG_CONFIG_HOME%\herdr` when that is set). In the daemon's environment,
`HERDR_SOCKET_PATH` names the socket file instead, and `HERDR_SESSION` selects
`sessions\<session>\herdr.sock` in that folder. The daemon does not set herdr's
`HERDR_AGENT` hint on Windows panes; herdr documents it for Linux and macOS only.

The scripts that start Windows Terminal panes are stored in
`%TEMP%\openrig-windows-terminal`, named by their content; a later open deletes those
more than a week old.

## How native Windows behaves differently

- **Terminal.** psmux runs one server per session and reuses pane IDs across sessions,
  so OpenRig scopes every pane reference to its session, including a pane bound by
  `rig attach --self`. Each launch's literal argv is rendered into a staged PowerShell
  command; unknown shells and shell expansions are refused. ConPTY drops
  bracketed-paste framing, so input to Claude Code, Codex and OpenRig's Node runners is
  written as console input events. A handover's blank pane respawns the same managed
  Windows PowerShell that a new session starts.
  Session environment values are applied from a temporary config file after creating the native shell;
  they do not travel in psmux client arguments. Native respawn applies environment overrides to that
  session before restarting its pane.
- **Stopping a runtime.** A Windows console process has no graceful termination signal,
  so OpenRig sends no `TERM` to a psmux pane's processes. Where Linux and macOS send
  `TERM` and wait, a handover's cutover and `rig seat restart --keep-conversation`
  force-terminate the runtime (`taskkill /F`, with `/T` for a pane's process tree), so it
  cannot shut down cleanly. Stopping a seat or taking a rig down kills the seat's psmux
  session (`kill-session`), then checks that the session is gone.
- **Processes.** A CIM (`Win32_Process`) census replaces `ps`. Exact restart facts come
  from a narrow reader that returns a process's working folder, executable, home
  variables and the *names* of its credential variables, never their values; a process
  it cannot read stays unverified. Windows command lines are split by Windows rules,
  including for the strict Claude resume check. Windows has no foreground process group,
  so an idle shell is the pane's own shell (such as `powershell`, `pwsh` or `cmd`,
  compared without case or `.exe`) with no live child started after it, the same in two
  CIM samples. Claude Code delivery refuses to type into such a bare prompt. Those shell
  names count only on Windows; Linux and macOS keep their own shell set.
- **Daemon and TUI control.** A Windows `SIGTERM` ends Node at once, so `rig daemon stop`
  asks for the normal shutdown drain over an instance-specific named pipe with a private
  capability instead. The TUI's control socket is a named pipe.
- **TUI.** Node cannot start npm's `rig.cmd` shim without a shell, so the TUI runs the
  CLI through its JavaScript entry: the `bin-wrapper.js` installed beside the TUI, or the
  one behind the `rig.cmd` on PATH. Its fleet restore runs a plain `rig daemon start`
  that way. Commands it shows for copying, to launch a spec or run a workflow action,
  are written for PowerShell: `''` quoting, backtick line continuations, and
  `OPENRIG_HOST_SELECTED` set for the one `rig up` only. It also reads agent refs
  written with backslashes (`local:..\agents\x`) and links drive and UNC evidence paths.
- **CLI.** `rig attach --self` runs `tmux` directly, so it needs psmux's `tmux.exe` on
  PATH; a psmux reachable only through a `.cmd` or `.ps1` shim cannot be started that
  way, and attach then records an `external_cli` attachment (outbound `rig` commands
  only). Its `--print-env` prints PowerShell assignments; `--shell posix` prints exports
  for Git Bash. `rig file copy` is refused, because rsync reads a drive path such as
  `C:\notes.md` as a remote host; copy with OpenSSH's `scp` instead.
- **Paths.** Drive and UNC paths are accepted wherever absolute paths are. Relative
  resource paths refuse drive-relative (`C:file`), rooted (`\file`) and UNC forms. A Pi
  or OMP session-file resume token may be a drive-letter or UNC path; device paths
  (`\\?\`, `\\.\`) are refused. A `/`-rooted token is still accepted under the POSIX
  rules, and Windows resolves it against the current drive's root.
- **Line endings.** The Git for Windows installer's default `core.autocrlf=true` checks
  text out with CRLF. OpenRig reads CRLF in proof receipts, permission policy specs,
  scope and proof frontmatter and `SKILL.md` frontmatter. Proof evidence, though, is
  hashed byte for byte, so a judgment recorded against an LF file reads as changed
  evidence in a CRLF checkout. In a project that records proof judgments, keep
  `missions/**` LF (`missions/** text eol=lf` in `.gitattributes`) or set
  `core.autocrlf=false`.
- **Codex sandbox.** Without a selected Windows sandbox, Codex runs OpenRig's
  `-s workspace-write` floor read-only. When neither the seat's Codex `config.toml` nor
  its selected profile's `<profile>.config.toml` sets `[windows] sandbox` or
  `features.prefer_mxc`, managed Codex launches add `-c features.prefer_mxc=true`. A
  file that does not parse counts as a choice; the legacy `features.*_windows_sandbox`
  flags do not. Codex marks MXC as under development, prints a warning at startup and
  falls back to its own selection where MXC is unavailable; a managed
  `requirements.toml` still applies. What OpenRig adds so that `rig` runs inside each
  sandbox is under [Codex sandboxes](#codex-sandboxes).
- **Codex restore.** A restore can report a Codex seat `attention_required` when it
  cannot confirm that a stray terminal reply left in the composer was cleared; the
  conversation did resume.
- **Claude command permissions.** Claude Code can run commands through its PowerShell
  tool, which Bash rules do not reach, so kernel and team Claude seats get a
  `PowerShell(x:*)` allowance beside each `Bash(x:*)` one. A team seat's lifecycle
  asks (such as `rig down`) are native `PowerShell(rig down:*)` ask rules there, so
  Claude's own PowerShell parser is the primary gate. The session hook checks each
  PowerShell command again for spellings a prefix rule may miss, such as `rig.cmd`,
  backtick escapes, assignments (`$x=rig down x`) or a computed command name after `&`.
  The cost: `rig <lifecycle> --help` prompts under PowerShell on Windows, while the Bash
  tool's help still runs without one. The PowerShell tool's hook runs node directly (an
  exec-form hook, Claude Code 2.1.139 or later), so it works without Git Bash. Like any
  Claude hook, one that times out does not block the command, but the native ask rules
  still apply; the hook asks for any PowerShell command over 16 KiB without reading it.

### Codex sandboxes

A seat's `rig` is a folder of shims (`rig.ps1`, `rig.cmd` and `rig`) in
`OPENRIG_HOME\run\seat-bin\<key>`, first on the seat's PATH. OpenRig reads sandbox
choices only from the seat's `config.toml` and selected profile's file, and adds:

- **Every mode: an execution policy for the seat's shell.** The elevated and MXC
  sandboxes set none, so PowerShell refuses `rig.ps1` there. Managed Codex launches add
  `-c shell_environment_policy.set.PSExecutionPolicyPreference=RemoteSigned`, which
  changes no machine or user setting. Setting `PSExecutionPolicyPreference` under
  `[shell_environment_policy.set]` in either file chooses another value, and OpenRig
  adds none; an `include_only` or include filter that does not match the variable drops
  it. An execution policy set by Group Policy takes precedence.
- **Elevated: a Node the sandbox can read.** Its account (group `CodexSandboxUsers`) may
  be unable to read the daemon's Node, so OpenRig copies that Node to
  `OPENRIG_HOME\run\seat-node\<key>\node.exe` and grants `CodexSandboxUsers` read and
  execute on that folder and the shims' folder. If the group does not exist because
  Codex's elevated setup has not run, the daemon logs a warning and the shims use its
  own Node.
- **Unelevated and MXC: nothing more.** Commands there read files as you.

## Token files and other secrets

OpenRig writes its secrets with POSIX modes (`0600` files, `0700` folders). Windows does
not enforce those as ACLs: Node only toggles the read-only attribute. On Windows these
files get the access of the folder that holds them:

- `activity-hook-token` and `activity-endpoint.json` in `OPENRIG_HOME`, the activity
  hook token;
- `secrets\host-<id>.token` in `OPENRIG_HOME`, host pairing tokens;
- a `terminal-token` you put in `OPENRIG_HOME` for the CLI to read.

The default `OPENRIG_HOME`, `%USERPROFILE%\.openrig`, inherits your profile's ACL, which
on a standard install grants you, SYSTEM and Administrators. Codex's elevated sandbox
setup, when its commands may read the whole disk (Codex's default), also grants its
sandbox accounts (`CodexSandboxUsers`) read access to the folders directly in your
profile, `.openrig` among them, again at each setup whatever the folder's ACL. These
files inherit it, so commands a Codex seat runs in that sandbox can read them. On Linux
and macOS, Codex's `workspace-write` sandbox reads the whole disk, these files included.
An `OPENRIG_HOME` elsewhere, such as `C:\openrig`, a folder under `C:\ProgramData` or a
shared drive, can leave these files readable by other local users. Keep `OPENRIG_HOME`
under your profile, or restrict its folder yourself, for example to your account and
SYSTEM:

```powershell
icacls $env:OPENRIG_HOME /inheritance:r /grant:r "${env:USERNAME}:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F"
```

OpenRig sets ACLs in two places. `windows-control` in `OPENRIG_HOME`, which holds the
daemon's stop capability, grants only your account and SYSTEM and inherits nothing, so
Codex's grant does not reach it. For a Codex seat in Codex's elevated sandbox, OpenRig
adds read and execute for `CodexSandboxUsers` to the `run\seat-node\<key>` folder of
its copy of Node and to the seat's own `run\seat-bin\<key>` folder of shims
([Codex sandboxes](#codex-sandboxes)).
`OPENRIG_SHADOW_CAPTURE` is refused on Windows, which cannot show that its sink's
folder is private, and `rig slack status` makes no file-mode check there.

## Repeat the native lifecycle check

After building, run `node scripts/verify-windows-native.mjs C:\path\to\tmux.exe`.
It uses an isolated home, database, and psmux namespace; starts two stub seats through the built CLI;
sends messages; records a queue handoff; restarts the daemon; verifies the same pane processes and
queue item survived; then stops its own seats and daemon. It prints the evidence directory and result.
It uses no provider credentials and does not test model reasoning or a live provider conversation.

## Isolated live-provider acceptance

CI runs the provider-free native checks in `.github/workflows/windows-native.yml`. The
real-psmux tests in that list run only when `OPENRIG_TEST_PSMUX` names a `tmux.exe`;
give them a private `PSMUX_DATA_DIR` too. A green job does not show that any provider
works. To check providers, use a profile that shares nothing with your own:

1. Create a fresh profile folder. Point `HOME` **and** `USERPROFILE` at it, and put
   `APPDATA`, `LOCALAPPDATA`, `OPENRIG_HOME`, `CLAUDE_CONFIG_DIR` and `CODEX_HOME`
   beneath it. Use a private `PSMUX_DATA_DIR`. Keep Windows variables such as
   `SystemRoot` unchanged.
2. Sign in to each provider inside that profile. Don't copy existing OAuth tokens: a
   copied refresh token goes stale when the original installation rotates it. Claude
   reads `CLAUDE_CONFIG_DIR` and Codex reads `CODEX_HOME`. Managed Pi and OMP seats
   each read their own `PI_CODING_AGENT_DIR`, at
   `OPENRIG_HOME\state\<pi|omp>\<session-name>\agent`; sign in there and choose a model
   the account can use. A global Pi or OMP login does not reach managed seats.
3. Start the daemon with `rig daemon start --no-kernel`, launch a rig with
   `rig up <rig.yaml>`, and check `rig ps --nodes --rig <rig> --json`.

A run passes when:

- each seat launches ready, without a workspace-trust or hook-review prompt;
- each seat answers a unique marker sent with `rig send`, and Claude Code and Codex
  activity hooks report `running` and `idle` during that turn;
- `rig down <rig> --snapshot` followed by `rig up <rig> --existing` reports
  `fully_restored` with every seat `resumed`, and each seat recalls a marker given
  before the snapshot;
- `rig seat restart <seat> --keep-conversation` restarts the seat in its own pane on
  the same conversation, and it recalls a marker given before the restart;
- `rig daemon stop` succeeds. It fails if the daemon's shutdown receipt is missing or
  shows an incomplete drain.

Keep credentials, session environments, staged launch scripts and raw launch argv out
of anything you post. With a report, include `rig --version`, `tmux -V`,
`$PSVersionTable.PSVersion`, `Get-ExecutionPolicy`, `node --version`, each provider
CLI's version and, if you use herdr, `herdr --version`.

## Known gaps

- Live `rig seat set-runtime` exchanges between Claude Code and Codex are refused
  before staging a successor: psmux cannot exchange panes between its per-session
  servers. Use separate Claude Code and Codex seats for cross-provider delegation.
- Not yet exercised natively: Pi and OMP live conversations, kernel and operator
  readiness, reboot, suspend, durability across power loss, and processors other than
  x64.
- Runtimes in psmux panes get no graceful stop: cutovers and in-place restarts
  force-terminate them ([stopping a runtime](#how-native-windows-behaves-differently)).
- `npm test` is not expected to pass on native Windows. Many package suites assume
  POSIX shells, paths, file modes or symbolic links. The native CI job runs the
  repository script suite and checks, then a focused set of package tests; CI runs the
  full package suites on macOS.
- Some shipped skill scripts expect `python3` or a POSIX shell. Service-backed rigs
  (Docker Compose; the daemon runs `docker compose` without a shell, so `docker.exe`
  must be on its PATH) and the CLI-tool probes for package requirements have not been
  exercised natively.

## Reproducible desktop setup and sign-in startup

Run the installed fork from the same native Windows desktop environment used for
the agent terminals:

    rig setup --providers both --autostart
    rig preflight
    rig status

Setup is per Windows user, not per project. The optional --autostart flag registers
"OpenRig - Start daemon and kernel" for that user's Windows sign-in. It invokes
Node and the installed CLI by absolute path with start --last --json: rigs stopped
on purpose stay stopped. Omitting the flag leaves startup scheduling unchanged.

Setup's PowerShell commands select Windows PowerShell's own system modules before
hashing or extracting the pinned portable psmux release. This prevents an inherited
PowerShell 7 module path from breaking Get-FileHash or Expand-Archive. No profile
or persistent execution-policy edits are needed. The CLI resolves its managed
psmux before loading commands, and preflight executes that binary by absolute
path. Windows database-owner checks use Restart Manager rather than lsof.

A sandbox or isolated installer environment can see files that the user's desktop
does not. A successful check in that environment is not desktop installation proof.
Verify the file and run preflight in the actual desktop terminal before reporting
success. If desktop psmux is missing, run setup there; copying PATH alone cannot
repair a missing executable.

For the native Windows Terminal view:

    rig terminal open saved:kernel --provider tmux --window

Tabs remain open after an attachment error so the actual error can be read.
An accepted Windows Terminal launch request does not prove that an agent is
visible. The Herdr pane/tab-ID issue seen during desktop acceptance is unresolved;
use the explicit tmux provider until that integration is qualified.

The operator can respond while hooks fail. "Kernel ready" does not certify that
all Codex/Claude hooks executed successfully. Diagnose reported hook failures
separately rather than hiding them in setup output.

### Replacing an installed package on Windows

Close OpenRig dashboard/TUI processes and stop the daemon before npm replaces
the global package. Both can load the native SQLite module, which Windows locks;
replacing the package while either holds it can fail with EBUSY. Closing the
dashboard and stopping the daemon preserve psmux agent sessions.

    rig daemon stop
    npm install -g <the-built-fork-package.tgz>
    rig setup --providers both --autostart
    rig start --last

Run these from the actual Windows desktop environment. Do not treat an installer
sandbox's file-existence check as proof that desktop terminals see the binary.

## Use the existing commands inside Zed

From a plain Zed terminal, use the original recovery command, then psmux's
standard tmux-compatible attachment command:

    rig start --last
    tmux attach -t operator-agent@kernel

This attaches only the existing operator in the current terminal. Detach with
Ctrl+B followed by D. The custom rig open extension has been removed.

For an explicitly selected missing operator, the existing recovery primitive is:

    rig launch kernel operator.agent

The --last path also checks kernel agents for positively observed missing
sessions with an explicit non-stop record and invokes that same single-seat
launch route. It never falls back to a fresh conversation. Deliberately stopped,
live, never-started and unverified sessions are left alone. Failed resumes remain
visible failures. The kernel status route checks live session presence instead
of presenting the boot-time ready flag as current liveness.

## Codex guidance, scrollback and clipboard behavior

The operator is the conversation used to design a project team. No project rig
needs to exist before talking to it. Agent skill lists in its history are
instructions for the agent; they are not a text file the person must read.

Attaching the existing conversation sends no new setup prompt.
"Back to bottom · esc" belongs to Codex's history navigation. Windows-managed
Codex launches use --no-alt-screen to preserve terminal scrollback. Existing
processes retain their current display mode until a verified conversation resume;
a refused restart must not be replaced with a fresh conversation.

When applications capture the mouse, Shift-drag can request host-terminal
selection; use the terminal's Copy action after selecting. Running the attachment command in a
plain Zed terminal avoids stacking Herdr's mouse handling over psmux and Codex.
The Herdr-in-Zed clipboard path has not been visually qualified.

The core Codex hooks use a shell-neutral Node entry, forwarding stdin and exit
status to activity/refocus handlers. Only OpenRig-owned, previously approved
legacy declarations with a matching ownership receipt can migrate automatically.
Disabled hooks, custom hashes and unknown provenance remain under native review.
