# What changed in OpenRig 0.7.5

This note is for an agent on an install that was just upgraded to 0.7.5.
It lists changes since 0.7.4. For the whole capability map, read
`rig context get onboarding-width/public-what-you-can-do.md`.
Each release replaces this note: `rig context get reference/whats-new.md`
describes the installed version once the upgraded daemon is running. Without
a daemon, read `$OPENRIG_HOME/reference/whats-new.md`; that copy refreshes at
daemon start and can still describe the previous version just after an upgrade.

## After the upgrade

- **Restart the daemon** (`rig daemon stop`, then `rig daemon start`). The new
  migration 126 stores deferred `escalates_to` addresses alongside node-bound
  edges. Existing escalation edges that were inert now route recovery for
  seats without a delegation parent, including to another rig on this daemon.
- **openrig-core goes from 0.1.21 to 0.1.22.** Its queue-handoff skill teaches
  parking waits on CI or long jobs with a continuation and wake. Managed
  refresh still preserves replaced files under
  `$OPENRIG_HOME/backups/managed-refresh/<id>/`; reapply local edits you need.
  No setting is added or removed.
- **Keep the Codex hook-refresh limit in mind.** The earlier remedy
  `rig seat restart <seat> --keep-conversation --reason "refresh hooks"`
  (preview with `--plan`) refuses a Codex seat launched by a 0.6.x
  `openrig-tmux-send` script when Codex is a grandchild of the pane's shell.
  Nothing is stopped, and the hook refresh has not happened. Issue
  [#2200](https://github.com/mvschwarz/openrig/issues/2200) is not fixed in
  0.7.5. If Codex asks for hook review, review the hooks you intend to enable;
  upgrading does not restore approvals an earlier OpenRig removed.

## New things you can do

- **Follow a task in one terminal workspace:**
  `rig terminal open qitem:<id> --follow --provider herdr`. Current obligation
  owners join as verified viewer tiles without requesting focus. Departures
  close viewers after a grace period, not agents or conversations. This is
  scoped to **Linux Herdr 0.9.5 / protocol 22**.
- **Adjust the view:** `--pin` / `--unpin`, `--suppress` / `--unsuppress`,
  `--suppression-ms`, `--max-tiles`, `--grace-ms` and `--focus-retention-ms`.
  The defaults are eight tiles, four seconds of departure grace and twelve
  more seconds for a focused leaver. `--no-follow` keeps the fixed layout.
  A completely empty task drains removable tiles; when none remain, following
  stops. Run `--follow` again to resume the same workspace.
- **Inspect following:** `rig terminal views --json` and
  `rig terminal status --json` include saved active selectors and their latest
  status. Ordinary `rig terminal open qitem:<id>` remains a one-shot open.
  A client can use `POST /api/terminal/viewer/ensure` to add or reuse a verified
  missing viewer without relaying out existing panes. Membership grants no input
  authority. See `rig context get reference/terminal-sessions.md`.
- **Use the `pi-tui` example for Pi's own terminal UI as a community harness.**
  Copy its preset and launcher from `docs/reference/community-harness-examples/pi-tui/`
  and maintain them as your own. It supplies a per-seat Pi agent folder and
  startup input. One Pi 1.4.0 / OpenRig 0.7.4 run exercised a parked wake to
  the same session and an unattended handoff to a second seat. Resume is not
  declared; the limitations below matter.

## Behaviour and output that changed

- **`rig send` waits longer for its result:** 60 seconds locally and over HTTP,
  plus any requested `--wait-for-idle` duration. A longer send or lost response
  is still unconfirmed, with no automatic resend. A busy agent can hold delivered
  input off-screen: missing pane text does not prove non-delivery. Reconcile
  before another send or filing the same work as a queue item.
- **Unconfirmed panes are not counted as opened.** Terminal CLI and TUI results
  name `pane_unconfirmed` separately from skipped seats; an all-unconfirmed open
  exits nonzero. Inspect before retrying rather than assuming nothing opened.
- **A wake recorded as unroutable can resume once its seat is pane-bound.** The
  sweep uses the row's existing wake intent so the outbox does not send the same
  settled intent again. Existing quiet hours and retry rules still apply.
- **A parentless seat's `escalates_to` destination is used for recovery,**
  including another rig on this daemon. Delegation parents still take
  precedence; an open recovery keeps its recorded owner. A stuck finding closes
  on source evidence, not because a reporting threshold or unreadable registry
  made it disappear from a report.
- **Fresh Claude handovers wait for the new process and current drawn input
  frame.** Retained scrollback and an echoed launch command are not readiness.
- **Runtime send refusals return 409 instead of 500.** A stale Claude pane
  names `rig reconcile-session <seat>` as the repair and types nothing.
- **`rig down` records an explicit stop after a rolled-back launch.**
  `rig start --last` then keeps it down. `rig ps` marks periodic snapshots active
  only for rigs the scheduler snapshots.
- **The web Overview shows the selected rig's current configuration,** not a
  same-named library template. The TUI shows the configured local host name;
  host registration explains the optional HTTP Feed subscription.
- **`attach --self` handles tmux's rewritten separators;** capture and transcript
  requests use normalized line counts; stdio MCP warns on out-of-range daemon
  ports while continuing to serve without replacing the supplied port.
- **The scope audit route accepts slice folders numbered 100 and above.**
  Moving a slice still reopens its proof judgments: structural validity does
  not mean an earlier judgment applies at the new path.

## Keep using the 0.7.4 capabilities

- **Hosted assistants can remain team members over MCP**, with roster entries,
  per-seat grants and optional webhook rings. Their reach comes from the grant,
  not the tool list. Without a wake trigger they check work when their owner
  next starts a session; finished work closes with `no-follow-on`.
  Internet-facing hosted members remain **experimental, unsupported, off by
  default and at your own risk**. This release's terminal view needs no internet
  exposure. See `rig context get reference/hosted-members.md` for narrow grants
  and token revocation.
- **External grant checks, OAuth discovery and MCP protocol 2026-07-28** remain
  available beside the older MCP handshake. A recorded principal is attribution,
  not authentication. A webhook 2xx accepts the ring, not the task; a queue claim
  is pickup, and activity between calls remains unknown.
- **`rig seat history --rig <id> --node-id <id>`** still lists eligible recorded
  conversations. Resuming a person's reviewed history remains a client operation
  through startup review, not a CLI command.
- **Daemon start restores a kernel only when this start newly detects it went
  down.** A kernel already recorded down stays down; use `rig up kernel --existing` when you want it back.
  That restore evidence still lasts only one daemon process.

## Limits to carry into your work

- **Follow mode and ensure-viewer are limited to Linux Herdr 0.9.5 / protocol 22.**
  Other platforms, providers and selectors retain one-shot open. The exercised
  follow journey used shell stand-ins, not native agents; real-agent follow
  qualification is not claimed. Active render cost is unmeasured.
- **Unreadable composers keep departed tiles.** Pi, terminal and community
  harness input may be unconfirmed. Unpinning does not make it safe to close;
  typed drafts are retained too. Each input-retained departure gets one delayed
  recheck, then an event or explicit follow command can reconsider it. Failed
  provider or membership reads retain the old view with an explanation.
- **A viewer can resize its agent's terminal.** `ignore-size` is not isolation.
  The first workspace on an empty Herdr server may gain focus. An SSH tile still
  needs reopening after a Herdr restart, and native cmux remains unqualified.
- **Use `pi-tui` unattended, not alongside a person's typing.** A wake can submit
  a half-typed draft, and an unrecognized dialog can receive a send. Draft-aware
  mode is not a known fix. Busy-turn wakes, other Pi versions, native resume and
  Pi choosing the park/handoff sequence for itself are not established by the
  example's one run. Plain terminal seats do not receive queue wakes; setting
  their typing guard to `off` can put notices into a shell. A preset's first
  startup file must use `delivery_hint: send_text` to reach its first input.
- **Cross-rig escalation is same-daemon only;** upgrade followed by snapshot
  restore of deferred targets has not been qualified.
- **The Codex restart refusal in #2200 remains.** Codex permission settings were
  qualified on native 0.164.0 in 0.7.3, not every version; isolated account-home
  switching is not part of this release.
- **OpenClaw interrupted local turns remain unrecovered;** inspect the pane and
  use its Gateway preset for unattended work. Hermes has no declared resume or
  measured idle gateway exit. `rig down` stops a community harness's pane;
  survival of independently spawned children remains untested.
- **Shared channels remain Slack only.** TUI primary-user authority is attribution,
  not authentication. Earlier Slack-thread, browser-sizing and other published
  0.7.4 limits remain unless a change above explicitly names them fixed.

## Contributors

Thanks to @icey-zzz, @Aschenbath, @DeryFerd, @Nikhi00718 and @dajiaohuang for
merged contributions, and @rudycelekli for the work completed in #2160.
