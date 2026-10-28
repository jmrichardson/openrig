// Windows editors and checkouts may write CRLF; the plan-lock and execution-view readers accept it only on Windows.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isContentlessPlanLockSet } from "../src/domain/scope/plan-lock-artifacts.js";
import { buildExecutionView } from "../src/domain/execution-view.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "../src/db/migrations/002_bindings_sessions.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueItemSummarySchema } from "../src/db/migrations/044_queue_item_summary.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { queueTransitionWakesSchema } from "../src/db/migrations/073_queue_transition_wakes.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const setPlatform = (value: NodeJS.Platform) => Object.defineProperty(process, "platform", { ...platform, value });
const temporary: string[] = [];
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const crlf = (text: string) => text.replace(/\n/g, "\r\n");
const cases = [
  { host: "win32", crlfRead: true },
  { host: "linux", crlfRead: false },
  { host: "darwin", crlfRead: false },
] as const;

describe.each(cases)("frontmatter on $host", ({ host, crlfRead }) => {
  it("an untouched plan-lock PRD scaffold", () => {
    setPlatform(host);
    const scaffold = "---\nid: OPR.1.2.3\n---\n# Implementation PRD\n\n## Goal\n";
    expect(isContentlessPlanLockSet(scaffold, [])).toBe(true);
    // Unstripped, the frontmatter lines count as authored content.
    expect(isContentlessPlanLockSet(crlf(scaffold), [])).toBe(crlfRead);
  });

  it("a slice SPEC body, which never carries its frontmatter's lines", async () => {
    // Opened on the real platform: better-sqlite3 picks its native binding by process.platform.
    const db = createDb();
    migrate(db, [coreSchema, bindingsSessionsSchema, eventsSchema, queueItemsSchema, queueItemSummarySchema, queueTransitionsSchema, queueTransitionWakesSchema]);
    setPlatform(host);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "crlf-exec-view-"));
    temporary.push(root);
    const spec = (dir: string, text: string) => {
      fs.mkdirSync(path.join(root, "release-9.9", "slices", dir), { recursive: true });
      fs.writeFileSync(path.join(root, "release-9.9", "slices", dir, "SPEC.md"), text);
    };
    // A frontmatter line that reads as a SOFT-AFTER edge only if left in the body.
    const text = "---\nid: OPR.9.9.LF\nSOFT-AFTER: [OPR.9.9.0]\n---\n\n# Slice\n";
    spec("01-lf", text);
    spec("02-crlf", crlf(text.replace("OPR.9.9.LF", "OPR.9.9.CRLF")));
    try {
      const view = await buildExecutionView({ db, slicesRoot: () => root, exec: () => "", rigsRoot: () => root }, { mission: "release-9.9" });
      const q2 = view.q2_sequencing as Array<{ slice_id: string; soft_after: string[] }>;
      expect(q2.find((s) => s.slice_id === "OPR.9.9.LF")?.soft_after).toEqual([]);
      expect(q2.find((s) => s.slice_id === "OPR.9.9.CRLF")?.soft_after).toEqual(crlfRead ? [] : ["OPR.9.9.0"]);
    } finally { db.close(); }
  });
});
