import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { createConnection } from "node:net";
import { startWindowsDaemonControl, requestWindowsDaemonStop } from "../src/windows-daemon-control.js";
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const run of cleanup.splice(0).reverse()) await run(); });
/** Writes one raw request line to the published control pipe; resolves with everything answered before it closed. */
async function sendControlLine(home: string, line: string): Promise<string> {
  const { pipe } = JSON.parse(readFileSync(path.join(home, "windows-control/daemon-control.json"), "utf8"));
  const socket = createConnection(pipe);
  let response = "";
  socket.on("data", chunk => { response += chunk; });
  socket.on("error", () => {});
  socket.on("connect", () => socket.write(`${line}\n`));
  await once(socket, "close");
  return response;
}
/** Starts the production startServer fixture on home; cleanup kills it if it is still running. */
function spawnDaemonFixture(home: string) {
  const child = spawn(process.execPath, ["--experimental-loader", pathToFileURL(path.join(import.meta.dirname, "fixtures/shutdown-loader.mjs")).href,
    path.join(import.meta.dirname, "fixtures/shutdown-child.mjs")], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, S15_SOURCE_ROOT: path.resolve(import.meta.dirname, "../../.."), S15_CASE: "clean", OPENRIG_HOME: home,
      OPENRIG_DB: path.join(home, "db.sqlite"), OPENRIG_NO_KERNEL: "1", OPENRIG_URL: "" } });
  const output = { stdout: "", stderr: "", all: "" };
  child.stdout.on("data", chunk => { output.stdout += chunk; output.all += chunk; });
  child.stderr.on("data", chunk => { output.stderr += chunk; output.all += chunk; });
  cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await once(child, "exit"); } });
  /** Resolves with the daemon state from the fixture's ready.json. */
  const waitReady = async () => {
    const ready = path.join(home, "ready.json");
    const deadline = Date.now() + 5000;
    while (!existsSync(ready) && Date.now() < deadline && child.exitCode === null) await new Promise(resolve => setTimeout(resolve, 25));
    expect(existsSync(ready), `fixture exit=${child.exitCode}; ${output.all}`).toBe(true);
    return JSON.parse(readFileSync(ready, "utf8"));
  };
  return { child, output, waitReady };
}
describe.skipIf(process.platform !== "win32")("native Windows drain request", () => {
  it("refuses an inherited-access control directory before publishing a capability", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "openrig-control-acl-"));
    cleanup.push(() => rmSync(home, { recursive: true, force: true }));
    mkdirSync(path.join(home, "windows-control"));
    await expect(startWindowsDaemonControl(home, () => {})).rejects.toThrow("no capability published");
    expect(existsSync(path.join(home, "windows-control/daemon-control.json"))).toBe(false);
  });
  it("crosses the production startServer drain, still up after a JSON null request, and persists a clean receipt", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "openrig-control-drain-"));
    cleanup.push(() => rmSync(home, { recursive: true, force: true }));
    const { child, output, waitReady } = spawnDaemonFixture(home);
    const state = await waitReady();
    expect(await sendControlLine(home, "null")).toBe("");
    await new Promise(resolve => setTimeout(resolve, 250));
    expect(child.exitCode, output.all).toBeNull();
    expect(output.all).not.toContain("TypeError");
    const exited = once(child, "exit");
    await requestWindowsDaemonStop(home, state);
    const [code] = await exited;
    expect(code).toBe(0);
    expect(JSON.parse(readFileSync(path.join(home, "daemon-shutdown.json"), "utf8"))).toMatchObject({ pid: child.pid, outcome: "clean", phase: "complete" });
    expect(existsSync(path.join(home, "windows-control/daemon-control.json"))).toBe(false);
    expect(readFileSync(path.join(home, `measurements-${child.pid}.jsonl`), "utf8")).toContain("shutdown.consumer");
  }, 15000);
  it("exits before listening when the production startServer cannot publish the channel", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "openrig-control-refused-"));
    cleanup.push(() => rmSync(home, { recursive: true, force: true }));
    // An inherited-access directory is refused before any capability is published.
    mkdirSync(path.join(home, "windows-control"));
    const { child, output } = spawnDaemonFixture(home);
    const [code] = await once(child, "exit");
    expect(code, `stdout=${output.stdout}; stderr=${output.stderr}`).toBe(1);
    expect(output.stderr).toContain("[windows-control] Windows private control directory unavailable; no capability published; the daemon did not start.");
    expect(output.stdout).not.toContain("listening");
    expect(existsSync(path.join(home, "ready.json"))).toBe(false);
    expect(existsSync(path.join(home, "windows-control/daemon-control.json"))).toBe(false);
  }, 15000);
  it("rejects stale identity and accepts exactly the current instance", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "openrig-control-"));
    cleanup.push(() => rmSync(home, { recursive: true, force: true }));
    const state = { pid: process.pid, startedAt: new Date().toISOString() };
    writeFileSync(path.join(home, "daemon.json"), JSON.stringify(state));
    let requested = 0;
    const close = await startWindowsDaemonControl(home, () => { requested += 1; });
    cleanup.push(close);
    await expect(requestWindowsDaemonStop(home, { ...state, startedAt: "wrong" })).rejects.toThrow("unverified");
    expect(requested).toBe(0);
    await requestWindowsDaemonStop(home, state);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(requested).toBe(1);
  });
  it("refuses a JSON null, array or primitive request and keeps accepting the current instance", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "openrig-control-"));
    cleanup.push(() => rmSync(home, { recursive: true, force: true }));
    const state = { pid: process.pid, startedAt: new Date().toISOString() };
    writeFileSync(path.join(home, "daemon.json"), JSON.stringify(state));
    let requested = 0;
    const close = await startWindowsDaemonControl(home, () => { requested += 1; });
    cleanup.push(close);
    for (const line of ["null", "[]", `[${JSON.stringify(state)}]`, "5", '"token"', "true"]) expect(await sendControlLine(home, line), line).toBe("");
    expect(requested).toBe(0);
    await requestWindowsDaemonStop(home, state);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(requested).toBe(1);
  });
  it("preserves a successor's capability when closing a predecessor", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "openrig-control-"));
    cleanup.push(() => rmSync(home, { recursive: true, force: true }));
    const close = await startWindowsDaemonControl(home, () => {});
    const file = path.join(home, "windows-control/daemon-control.json");
    const successor = { ...JSON.parse(readFileSync(file, "utf8")), token: "successor" };
    writeFileSync(file, JSON.stringify(successor));
    await close();
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8")).token).toBe("successor");
  });
});
