import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { projectionResourceDirectory, projectionResourceId } from "../src/domain/projection-resource-path.js";
import { claudeConflictTargetPath, type ProjectionPlan } from "../src/domain/projection-planner.js";
import { CodexRuntimeAdapter } from "../src/adapters/codex-runtime-adapter.js";
import { OmpRuntimeAdapter } from "../src/adapters/omp-runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** Projects `ids` as Codex plugins into a fresh root and returns that root. */
async function projectCodexPlugins(ids: string[]) {
  const root = mkdtempSync(path.join(os.tmpdir(), "openrig-projection-")); roots.push(root);
  const entries = ids.map((effectiveId, index) => {
    const source = path.join(root, `source-${index}`); mkdirSync(source);
    writeFileSync(path.join(source, "SKILL.md"), `# ${effectiveId}\n`);
    return { category: "plugin", pluginType: "codex", effectiveId, sourceSpec: "shared", sourcePath: source, resourcePath: ".", absolutePath: source, classification: "safe_projection" } as const;
  });
  const fsOps = {
    exists: existsSync, readFile: (file: string) => readFileSync(file, "utf8"),
    writeFile: (file: string, content: string) => writeFileSync(file, content),
    mkdirp: (dir: string) => { mkdirSync(dir, { recursive: true }); },
    listFiles: (dir: string) => readdirSync(dir),
  };
  const plan = { runtime: "codex", cwd: root, entries, startup: {}, conflicts: [], noOps: [], diagnostics: [] } as ProjectionPlan;
  const binding = { cwd: root, tmuxSession: "worker@rig" } as NodeBinding;
  const codex = new CodexRuntimeAdapter({ tmux: {} as TmuxAdapter, fsOps });
  expect(await codex.project(plan, binding)).toMatchObject({ projected: ids, failed: [] });
  return { root, entries, fsOps, plan, binding, plugins: path.join(root, ".codex", "plugins") };
}

describe("Windows qualified resource projection", () => {
  it.each(["shared:openrig-core", "shared%3Aopenrig-core", "CON", "nul.txt", "trailing.", "trailing ", "a/b", "a\\b"])("encodes %s reversibly without Windows reserved path characters", id => {
    const directory = projectionResourceDirectory(id, "win32");
    expect(directory).not.toMatch(/[<>:"/\\|?*]/);
    expect(directory).not.toMatch(/[. ]$/);
    expect(projectionResourceId(directory, "win32")).toBe(id);
    expect(projectionResourceDirectory(id, "linux")).toBe(id);
  });

  it("keeps percent escapes and case-distinct resource ids distinct on a case-insensitive filesystem", () => {
    const ids = ["shared:openrig-core", "shared%3Aopenrig-core", "shared%3aopenrig-core", "shared:OpenRig-Core", "CON", "con", "é", "É"];
    const directories = ids.map(id => projectionResourceDirectory(id, "win32"));
    expect(new Set(directories.map(directory => directory.toLowerCase())).size).toBe(ids.length);
    expect(directories.map(directory => projectionResourceId(directory, "win32"))).toEqual(ids);
  });

  it("keeps an encoded id within NTFS's 255-unit component limit, distinct and never misread as another id", () => {
    // 30 CJK characters encode to 270 characters (9 per character).
    const long = "技能".repeat(15), sibling = long + "x", fits = "a".repeat(255);
    const directories = [long, sibling].map(id => projectionResourceDirectory(id, "win32"));
    for (const directory of directories) {
      expect(directory.length).toBeLessThanOrEqual(255);
      expect(directory).not.toMatch(/[<>:"/\\|?*]|[. ]$/);
      expect(projectionResourceId(directory, "win32")).toBe(directory);
    }
    expect(directories[0]).not.toBe(directories[1]);
    expect(projectionResourceDirectory(long, "win32")).toBe(directories[0]);
    expect(projectionResourceDirectory(fits, "win32")).toBe(fits);
    expect(projectionResourceDirectory(long, "linux")).toBe(long);
    // The shortened name is an ordinary directory name on every filesystem.
    const root = mkdtempSync(path.join(os.tmpdir(), "openrig-projection-")); roots.push(root);
    for (const directory of directories) mkdirSync(path.join(root, directory));
    expect(readdirSync(root).sort()).toEqual([...directories].sort());
  });

  // Windows-only: the case-distinct ids below share one directory name on any other case-folding
  // filesystem (macOS APFS), where ids are not encoded.
  it.skipIf(process.platform !== "win32")("projects the Codex plugin and OMP skill on the real filesystem while retaining their logical ids", async () => {
    const ids = ["shared:openrig-core", "shared%3Aopenrig-core", "shared%3aopenrig-core", "shared:OpenRig-Core"];
    const { root, entries, fsOps, plan, binding, plugins } = await projectCodexPlugins(ids);
    expect(readdirSync(plugins).map(directory => projectionResourceId(directory)).sort()).toEqual([...ids].sort());
    const omp = new OmpRuntimeAdapter({ tmux: {} as TmuxAdapter, fsOps, stateRoot: path.join(root, "state"), runnerEntryPath: "unused" });
    expect(await omp.project({ ...plan, runtime: "omp", entries: entries.map(entry => ({ ...entry, category: "skill" })) }, binding)).toMatchObject({ projected: ids, failed: [] });
    for (const id of ids) {
      const directory = projectionResourceDirectory(id);
      expect(readFileSync(path.join(plugins, directory, "SKILL.md"), "utf8")).toBe(`# ${id}\n`);
      const target = omp.skillTargetPath(binding.tmuxSession, id)!;
      expect(target).toBe(path.join(root, "state", "worker@rig", "agent", "skills", directory, "SKILL.md"));
      expect(readFileSync(target, "utf8")).toBe(`# ${id}\n`);
      expect(claudeConflictTargetPath("skill", id, root)).toBe(path.join(root, ".claude", "skills", directory, "SKILL.md"));
    }
    expect((await omp.listInstalled(binding)).map(resource => resource.effectiveId).sort()).toEqual([...ids].sort());
  });

  it.skipIf(process.platform === "win32")("keeps the id-as-directory layout off Windows", async () => {
    const ids = ["shared:openrig-core", "shared%3Aopenrig-core"];
    const { plugins } = await projectCodexPlugins(ids);
    expect(readdirSync(plugins).sort()).toEqual([...ids].sort());
    for (const id of ids) expect(readFileSync(path.join(plugins, id, "SKILL.md"), "utf8")).toBe(`# ${id}\n`);
  });
});
