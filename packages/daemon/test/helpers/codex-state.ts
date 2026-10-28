import Database from "better-sqlite3";
import { join } from "node:path";

/** The launch-local `-c` defaults every managed Codex command carries; native Windows also prefers the MXC
 *  sandbox and sets the seat shell's execution policy when the seat's Codex config chooses neither (fixtures
 *  have no config). */
export const CODEX_LAUNCH_DEFAULTS = "'-c' 'check_for_update_on_startup=false'"
  + (process.platform === "win32" ? " -c 'features.prefer_mxc=true' -c 'shell_environment_policy.set.PSExecutionPolicyPreference=RemoteSigned'" : "");

/** Native logs identify processes; retained CLI rows identify resumable conversations. */
export function seedCodexThreads(home: string, ids: string[]): void {
  const db = new Database(join(home, ".codex", "state_5.sqlite"));
  try {
    db.exec("CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, source TEXT, rollout_path TEXT)");
    const insert = db.prepare("INSERT OR REPLACE INTO threads VALUES (?, 'cli', ?)");
    for (const id of ids) insert.run(id, join(home, `${id}.jsonl`));
  } finally { db.close(); }
}
