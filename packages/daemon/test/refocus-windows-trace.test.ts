// Native Windows refocus traces: python.org installs py.exe/python.exe, not python3, and the
// python3 in %LOCALAPPDATA%\Microsoft\WindowsApps is the Store alias stub. The trace script then
// cannot start the rig.cmd shim either, so it runs the seat's CLI entry with the hook's Node.
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { installNativeNodeFake } from "../../../test/native-node-fake.js";
import { writeFakeRig } from "./helpers/refocus-hook-fakes.js";

const PLUGIN = resolve(import.meta.dirname, "../assets/plugins/openrig-core");
const HOOK = join(PLUGIN, "hooks/scripts/refocus.cjs");
const TRACE = join(PLUGIN, "skills/refocusing/scripts/trace-to-root.py");
const windows = process.platform === "win32";
// A real Python 3 for the shipped script, started by its own path so the trace's PATH can omit rig.
const realPython = windows ? spawnSync("py", ["-3", "-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).stdout?.trim() : "";

let root: string | undefined;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

// A fake interpreter that records how the hook started it and answers as the trace would.
const FAKE_PYTHON = `const fs = require("node:fs");
fs.writeFileSync(process.env.PYTHON_CALL, JSON.stringify({ argv: process.argv.slice(2), cliNode: process.env.OPENRIG_CLI_NODE }));
process.stdout.write(process.env.PYTHON_ANSWER || "");
process.exitCode = Number(process.env.PYTHON_STATUS || 0);
`;

function fixture() {
  root = mkdtempSync(join(tmpdir(), "refocus-windows-trace-"));
  const bin = join(root, "bin");
  const local = join(root, "local");
  const aliases = join(local, "Microsoft", "WindowsApps");
  mkdirSync(bin, { recursive: true });
  mkdirSync(aliases, { recursive: true });
  const rig = writeFakeRig(bin, `process.stdout.write(process.argv[2] === "queue" ? "{}" : "");`);
  const call = join(root, "python-call.json");
  const run = (path: string[]) => {
    const result = spawnSync(process.execPath, [HOOK, "--runtime", "claude"], {
      input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "windows-trace" }),
      encoding: "utf8",
      env: {
        ...process.env, PYTHON: undefined, LOCALAPPDATA: local, PATH: [...path, dirname(process.execPath)].join(delimiter),
        OPENRIG_HOME: join(root!, "home"), OPENRIG_SESSION_NAME: "builder@demo", OPENRIG_CLI_ENTRY: rig,
        OPENRIG_REFOCUS_NOW: "1", OPENRIG_REFOCUS_TREES: "work", OPENRIG_WORKSPACE_ROOT: root,
        OPENRIG_REFOCUS_CONTENT_REF: undefined, OPENRIG_REFOCUS_WORK_NODE: root, OPENRIG_REFOCUS_DEPTH: undefined,
        OPENRIG_REFOCUS_TOPOLOGY_NODE: undefined, OPENRIG_REFOCUS_WORK_PACKET: undefined,
        PYTHON_CALL: call, PYTHON_ANSWER: "WORK TRACE: from the fake interpreter\n",
      },
    });
    expect(result.status, result.stderr).toBe(0);
    const context = (JSON.parse(result.stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
    return { context, call: existsSync(call) ? JSON.parse(readFileSync(call, "utf8")) as { argv: string[]; cliNode?: string } : null };
  };
  return { root, bin, aliases, rig, run };
}

describe.runIf(windows)("refocus trace interpreter on Windows", () => {
  it("runs the py launcher with -3, past the WindowsApps alias folder, and names its Node to the trace", () => {
    const f = fixture();
    installNativeNodeFake(f.aliases, "py", 'process.stderr.write("Python was not found");\nprocess.exitCode = 9009;\n');
    installNativeNodeFake(f.bin, "py", FAKE_PYTHON);
    const { context, call } = f.run([f.aliases, f.bin]);
    expect(call).toEqual({ argv: ["-3", TRACE, "--trees", "work", "--depth", "light", "--check", "--work-start", f.root], cliNode: process.execPath });
    expect(context).toContain("WORK TRACE: from the fake interpreter");
    expect(context).not.toContain("TRACE GAP");
  });

  it("uses python.exe when no py launcher is on PATH", () => {
    const f = fixture();
    installNativeNodeFake(f.bin, "python", FAKE_PYTHON);
    expect(f.run([f.bin]).call?.argv.slice(0, 2)).toEqual([TRACE, "--trees"]);
  });

  // The shipped script itself, on a real Python 3: rig is reachable only as OPENRIG_CLI_ENTRY.
  it.runIf(Boolean(realPython))("the shipped trace starts the rig CLI entry with the hook's Node", () => {
    const f = fixture();
    const calls = join(f.root, "rig-calls.log");
    const rig = writeFakeRig(f.bin, `require("node:fs").appendFileSync(process.env.RIG_CALLS, process.argv.slice(2).join(" ") + "\\n");
process.stdout.write(process.argv[2] === "scope" ? '{"ok":true,"resolution":null}\\n' : "");`);
    const result = spawnSync(realPython!, [TRACE, "--trees", "work", "--work-start", f.root, "--check"], {
      encoding: "utf8",
      env: { ...process.env, PATH: dirname(process.execPath), OPENRIG_WORKSPACE_ROOT: f.root,
        OPENRIG_CLI_NODE: process.execPath, OPENRIG_CLI_ENTRY: rig, RIG_CALLS: calls },
    });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout).not.toContain("could not start");
    expect(readFileSync(calls, "utf8")).toContain(`scope resolve-notes ${realpathSync.native(f.root)} --json`);
  });
});
