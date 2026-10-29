import { powershellQuote } from "../../adapters/windows-launch.js";

// A tile owns its attach process; no daemon watcher or steady-state polling.
// Session names survive fresh launch, handover and restart. The node identity
// must survive too: never follow a same-name session belonging to another seat.
export function tileAttachArgv(
  tmux: string, server: readonly string[], session: string, readOnly: boolean,
  retrySeconds = 30, platform?: NodeJS.Platform,
): string[] {
  if (platform === "win32") return windowsTileAttachArgv(tmux, server, session, readOnly, retrySeconds);
  const ro = readOnly ? "-r " : "-f ignore-size ";
  // No apostrophes or control characters in the script: Herdr also stores this
  // argv as its restart command. All external values stay positional arguments.
  const script = [
    'target=$1; shift;',
    `snapshot=$("$@" display-message -p -t "=$target:" "#{pid} #{session_id}:#{session_name}" 2>/dev/null) || exec "$@" attach ${ro}-t "=$target";`,
    // display-message may succeed with empty/fallback context for a missing target.
    `if [ "\${snapshot#*:}" != "$target" ]; then exec "$@" attach ${ro}-t "=$target"; fi;`,
    'snapshot=${snapshot%%:*};',
    'node=$("$@" show-environment -t "${snapshot#* }" OPENRIG_NODE_ID 2>/dev/null) || node=;',
    'case "$node" in OPENRIG_NODE_ID=?*) ;; *) node=;; esac;',
    'if [ -z "$node" ]; then',
    'printf "%s\\n" "No managed identity for $target; reopen this view after replacement.";',
    `exec "$@" attach ${ro}-t "\${snapshot#* }"; fi;`,
    'while :; do',
    `"$@" attach ${ro}-t "\${snapshot#* }";`,
    `left=${retrySeconds}; same=0;`,
    'while [ "$left" -gt 0 ]; do',
    'next=$("$@" display-message -p -t "=$target:" "#{pid} #{session_id}:#{session_name}" 2>/dev/null) || next=;',
    'if [ "${next#*:}" = "$target" ]; then next=${next%%:*}; else next=; fi;',
    'if [ -n "$next" ]; then',
    'identity=$("$@" show-environment -t "${next#* }" OPENRIG_NODE_ID 2>/dev/null) || identity=;',
    // A session can disappear between the two metadata reads; unknown waits.
    'if [ -n "$identity" ]; then',
    'if [ "$identity" != "$node" ]; then printf "%s\\n" "Seat identity changed for $target; reopen its view."; exit 1; fi;',
    'if [ "$next" != "$snapshot" ]; then snapshot=$next; break; fi;',
    // The stop adapter detaches BEFORE killing. Give that kill a chance to
    // finish; an ordinary Ctrl-b d leaves the original alive and ends the tile.
    'same=$((same + 1)); if [ "$same" -ge 3 ]; then exit 0; fi;',
    'else same=0; fi; else same=0; fi;',
    'sleep 1; left=$((left - 1));',
    'done;',
    'if [ "$left" -eq 0 ]; then printf "%s\\n" "No replacement for $target; reopen the view with rig terminal open."; exit 0; fi;',
    'done',
  ].join(" ");
  return ["/bin/sh", "-c", script, "openrig-tile", session, tmux, ...server];
}

/** Native equivalent of the POSIX tile: observe only after attach exits, and follow
 * a replacement only while its stable OpenRig node identity still matches. */
function windowsTileAttachArgv(tmux: string, server: readonly string[], session: string, readOnly: boolean, retrySeconds: number): string[] {
  const script = [
    // Older Herdr releases ignore pane.env; the attach itself carries the daemon's namespace.
    "$env:TMUX = $null; $env:PSMUX_SESSION = $null; $env:PSMUX_TARGET_SESSION = $null",
    `[Environment]::SetEnvironmentVariable('PSMUX_DATA_DIR', ${process.env.PSMUX_DATA_DIR === undefined ? "$null" : powershellQuote(process.env.PSMUX_DATA_DIR)}, 'Process')`,
    `$tmux = ${powershellQuote(tmux)}`,
    `$server = @(${server.map(powershellQuote).join(", ")})`,
    `$target = ${powershellQuote(session)}`,
    '$selector = "=$target"',
    'function Read-Snapshot {',
    '  $value = & $tmux @server -t $selector display-message -p -t "$selector`:" "#{pid} #{session_id}:#{session_name}" 2>$null',
    '  if ($LASTEXITCODE -ne 0) { return $null }',
    '  $value = ($value -join "").Trim()',
    '  if ($value -notmatch "^([0-9]+ [^:]+):(.*)$" -or $Matches[2] -cne $target) { return $null }',
    '  return $Matches[1]',
    '}',
    'function Read-Node {',
    '  $value = & $tmux @server -t $selector show-environment -t $selector OPENRIG_NODE_ID 2>$null',
    '  if ($LASTEXITCODE -ne 0) { return $null }',
    '  $nodes = @($value | Where-Object { $_ -cmatch "^OPENRIG_NODE_ID=.+$" })',
    '  if ($nodes.Count -eq 1) { return $nodes[0] }',
    '}',
    '$snapshot = Read-Snapshot',
    '$node = Read-Node',
    'while ($true) {',
    `  & $tmux @server -t $selector attach ${readOnly ? "-r " : ""}-t $selector`,
    '  if (-not $snapshot -or -not $node) { exit $LASTEXITCODE }',
    '  $same = 0; $replaced = $false',
    `  for ($left = ${Math.max(1, Math.floor(retrySeconds))}; $left -gt 0; $left--) {`,
    '    $next = Read-Snapshot; $identity = Read-Node',
    '    if ($next -and $identity) {',
    '      if ($identity -cne $node) { Write-Host "Seat identity changed; reopen its view."; exit 1 }',
    '      if ($next -cne $snapshot) { $snapshot = $next; $replaced = $true; break }',
    '      $same++; if ($same -ge 3) { exit 0 }',
    '    } else { $same = 0 }',
    '    Start-Sleep -Seconds 1',
    '  }',
    '  if (-not $replaced) { Write-Host "No replacement; reopen the view with rig terminal open."; exit 0 }',
    '}',
  ].join("\n");
  return ["powershell.exe", "-NoLogo", "-NoProfile", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
}
