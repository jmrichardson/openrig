// The Claude compaction restore packet folder: POSIX keeps the shared /tmp/claude-compaction-restore;
// Windows uses os.tmpdir(), where Git for Windows mounts /tmp, never a drive-root C:\tmp. The prompt,
// the bridge fallback and the shipped precompact hook must all name the folder the seat really uses.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { buildPostCompactRestorePrompt } from "../src/domain/claude-compaction-enforcer.js";

const PLUGIN = resolve(import.meta.dirname, "..", "assets", "plugins", "openrig-core");
const SEAT = "claude-seat@rig";
const packetRoot = (temp: string) => process.platform === "win32" ? join(temp, "claude-compaction-restore") : "/tmp/claude-compaction-restore";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "compaction-packet-root-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("Claude compaction restore packet folder", () => {
  it("the restore prompt names the platform packet folder", () => {
    const folder = process.platform === "win32" ? `${packetRoot(tmpdir())}${sep}` : "/tmp/claude-compaction-restore/";
    for (const sessionId of [undefined, "sess-1"]) {
      const prompt = buildPostCompactRestorePrompt({ sessionName: SEAT, openrigHome: join(root, "home"), sessionId });
      expect(prompt).toContain(`inspect the newest matching packet under ${folder} for `);
      if (process.platform === "win32") expect(prompt).not.toContain("/tmp/");
    }
  });

  it("the bridge falls back to the platform packet folder when the marker records none", () => {
    const home = join(root, "home");
    const marker = join(home, "compaction", "restore-pending", `${SEAT}.json`);
    mkdirSync(dirname(marker), { recursive: true });
    writeFileSync(marker, JSON.stringify({ version: 1, sessionName: SEAT, deliveryCount: 0, deliveredAt: null }));
    const result = spawnSync(process.execPath, [join(PLUGIN, "hooks", "scripts", "compaction-restore-bridge.cjs")], {
      input: JSON.stringify({ hook_event_name: "UserPromptSubmit" }), encoding: "utf8",
      env: { ...process.env, OPENRIG_HOME: home, OPENRIG_SESSION_NAME: SEAT, RIGGED_HOME: undefined, TEMP: root, TMP: root },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).hookSpecificOutput.additionalContext).toContain(`Restore packet: ${packetRoot(root)}\n`);
  });

  // POSIX writes the literal shared /tmp folder real seats use, so only Windows runs the unredirected hook here.
  it.runIf(process.platform === "win32")("the shipped precompact hook writes under os.tmpdir() and names that folder", () => {
    const home = join(root, "home");
    const transcript = join(root, "session.jsonl");
    writeFileSync(transcript, `${JSON.stringify({ type: "user", message: { role: "user", content: "hello" } })}\n`);
    const result = spawnSync(process.execPath, [join(PLUGIN, "skills", "claude-compaction-restore", "scripts", "precompact-hook.mjs")], {
      input: JSON.stringify({ session_id: "sess-1", transcript_path: transcript, cwd: root }), encoding: "utf8",
      env: { ...process.env, OPENRIG_HOME: home, OPENRIG_SESSION_NAME: SEAT, RIGGED_HOME: undefined,
        OPENRIG_COMPACTION_OUT_ROOT: undefined, TEMP: root, TMP: root },
    });
    expect(result.status, result.stderr).toBe(0);
    const message = JSON.parse(result.stdout).systemMessage as string;
    expect(message).toContain(`prepared at ${packetRoot(root)}${sep}`);
    expect(message).toContain(`--out '${packetRoot(root).replaceAll("\\", "/")}' --json`);
    const written = JSON.parse(readFileSync(join(home, "compaction", "restore-pending", `${SEAT}.json`), "utf8"));
    expect(String(written.outputDir).startsWith(`${packetRoot(root)}${sep}`)).toBe(true);
  });

  // A Windows account name may hold an apostrophe; single quotes would leave the command unbalanced.
  it.runIf(process.platform === "win32")("the restore command quotes a temp folder that holds an apostrophe", () => {
    const temp = join(root, "O'Brien");
    mkdirSync(temp);
    const transcript = join(root, "session.jsonl");
    writeFileSync(transcript, `${JSON.stringify({ type: "user", message: { role: "user", content: "hello" } })}\n`);
    const result = spawnSync(process.execPath, [join(PLUGIN, "skills", "claude-compaction-restore", "scripts", "precompact-hook.mjs")], {
      input: JSON.stringify({ session_id: "sess-1", transcript_path: transcript, cwd: root }), encoding: "utf8",
      env: { ...process.env, OPENRIG_HOME: join(root, "home"), OPENRIG_SESSION_NAME: SEAT, RIGGED_HOME: undefined,
        OPENRIG_COMPACTION_OUT_ROOT: undefined, TEMP: temp, TMP: temp },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).systemMessage).toContain(`--out "${packetRoot(temp).replaceAll("\\", "/")}" --json`);
  });
});

describe("restore-from-jsonl packet contents", () => {
  const SCRIPT = join(PLUGIN, "skills", "claude-compaction-restore", "scripts", "restore-from-jsonl.mjs");
  const toolUse = (name: string, input: Record<string, unknown>) =>
    ({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: `${name}-${Math.random()}`, name, input }] } });
  const text = (content: string) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: content }] } });
  type Summary = { files: { path: string; score: number; kinds: Record<string, number> }[]; docs: string[] };
  const packet = (records: object[], nodeArgs: string[] = []): Summary => {
    const jsonl = join(root, "session.jsonl");
    writeFileSync(jsonl, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
    const result = spawnSync(process.execPath, [...nodeArgs, SCRIPT, "--jsonl", jsonl, "--out", join(root, "out"), "--cwd", root, "--json"], {
      cwd: root, encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(readFileSync(join(JSON.parse(result.stdout).outputDir, "restore-summary.json"), "utf8"));
  };
  const entry = (summary: Summary, file: string) => summary.files.find((candidate) => candidate.path === file);

  it("ranks native tool paths, with the as-built bonus, and lists root and docs candidates", () => {
    const asBuilt = join(root, "docs", "as-built", "plan.md");
    const other = join(root, "docs", "notes", "plan.md");
    const read = join(root, "src", "x.ts");
    const summary = packet([toolUse("Write", { file_path: asBuilt }), toolUse("Write", { file_path: other }), toolUse("Read", { file_path: read })]);
    expect(entry(summary, asBuilt)?.kinds.written).toBeGreaterThan(0);
    expect(entry(summary, asBuilt)!.score - entry(summary, other)!.score).toBe(25);
    expect(entry(summary, read)?.kinds.read).toBeGreaterThan(0);

    // The docs walk keeps `find -maxdepth` (2 under docs/, 1 under docs/as-built/) and the name filter.
    for (const doc of ["README.md", "docs/as-built/codemap.md", "docs/architecture.md", "docs/notes.md", "docs/deep/er/overview.md"]) {
      mkdirSync(dirname(join(root, doc)), { recursive: true });
      writeFileSync(join(root, doc), "# doc\n");
    }
    expect(packet([text("hello")]).docs).toEqual([join(root, "README.md"), join(root, "docs", "architecture.md"),
      join(root, "docs", "as-built", "codemap.md")].sort());
  });

  // Native Claude Code on Windows records C:\ and UNC tool paths; a transcript also names drive and .\ paths in text.
  it.runIf(process.platform === "win32")("keeps Windows drive, UNC and backslash-relative paths", () => {
    const UNC = "\\\\192.0.2.1\\share\\z.md";
    const forward = join(root, "src", "forward.ts").replaceAll("\\", "/");
    const summary = packet([
      toolUse("Edit", { file_path: forward }),
      toolUse("Write", { file_path: UNC }),
      text(`Changed ${join(root, "src", "y.ts")}, see .\\notes\\todo.md.`),
    ]);
    expect(entry(summary, join(root, "src", "forward.ts"))?.kinds.written).toBeGreaterThan(0);
    expect(entry(summary, UNC)?.kinds.written).toBeGreaterThan(0);
    for (const file of [join(root, "src", "y.ts"), join(root, "notes", "todo.md")]) {
      expect(entry(summary, file)?.kinds.mentioned, file).toBeGreaterThan(0);
    }
  });

  // Probing a UNC path opens SMB to its host. Text can name any host, so a text mention is not taken,
  // and a tool's UNC path is kept without a probe. The preload records (and refuses) any UNC probe.
  it.runIf(process.platform === "win32")("never probes a UNC path, and takes none from text", () => {
    const probes = join(root, "unc-probes.txt");
    const preload = join(root, "record-unc-probes.cjs");
    writeFileSync(preload, `const fs = require("node:fs");
for (const name of ["existsSync", "statSync", "lstatSync"]) {
  const original = fs[name];
  fs[name] = (file, ...rest) => {
    if (!String(file).startsWith("\\\\\\\\")) return original(file, ...rest);
    fs.appendFileSync(${JSON.stringify(probes)}, String(file) + "\\n");
    throw new Error("UNC probe");
  };
}
`);
    const tool = "\\\\192.0.2.1\\share\\tool.md";
    const summary = packet([
      toolUse("Read", { file_path: tool }),
      text("Fetched //192.0.2.1/share/x.md and \\\\192.0.2.2\\share\\y.md; see <script src=\"//cdn.example.com/lib.js\">."),
      { type: "user", message: { role: "user", content: [{ type: "tool_result", content: "linked from \\\\192.0.2.3\\share\\z.md" }] } },
    ], ["--require", preload]);
    expect(entry(summary, tool)?.kinds.read).toBeGreaterThan(0);
    expect(summary.files.filter((file) => file.path.startsWith("\\\\")).map((file) => file.path)).toEqual([tool]);
    expect(existsSync(probes) ? readFileSync(probes, "utf8") : "").toBe("");
  });
});

describe("restore-from-jsonl transcript discovery", () => {
  const transcript = (rel: string, seconds: number) => {
    const file = join(root, "home", ".claude", "projects", ...rel.split("/"));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ type: "user", message: { role: "user", content: "hello" } })}\n`);
    utimesSync(file, seconds, seconds);
    return file;
  };
  // The real script with no transcript passed, under a private home.
  const run = (cwd: string) => spawnSync(process.execPath, [join(PLUGIN, "skills", "claude-compaction-restore", "scripts", "restore-from-jsonl.mjs"),
    "--out", join(root, "out"), "--json", "--cwd", cwd], {
    cwd: root, encoding: "utf8", env: { ...process.env, HOME: join(root, "home"), USERPROFILE: join(root, "home") },
  });

  // The newest .jsonl at most 4 levels under ~/.claude/projects, as `find -maxdepth 4` selects it
  // on POSIX and the Node walk on Windows.
  it("picks the newest transcript within the search depth", () => {
    transcript("a/older.jsonl", 1_000);
    const newest = transcript("b/c/d/at-limit.jsonl", 3_000);
    transcript("e/f/g/h/too-deep.jsonl", 9_000);
    const result = run(join(root, "elsewhere"));
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).jsonlPath).toBe(newest);
  });

  // Claude Code's project folder names for Windows paths.
  describe.runIf(process.platform === "win32")("Windows project folder", () => {
    it.each([
      ["C:\\work\\project", "C--work-project"],
      ["C:\\Users\\Test User\\my.app\\sub_dir", "C--Users-Test-User-my-app-sub-dir"],
    ])("prefers the project's own transcript for %s", (cwd, folder) => {
      const own = transcript(`${folder}/own.jsonl`, 1_000);
      transcript("other-project/newer.jsonl", 9_000);
      const result = run(cwd);
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).jsonlPath).toBe(own);
    });
  });
});
