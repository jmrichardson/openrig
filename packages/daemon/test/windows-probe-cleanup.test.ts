import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { stopGroup } from "../src/domain/codex-network-default.js";

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function firstLine(child: ChildProcess): Promise<string> {
  const result = Promise.withResolvers<string>();
  let output = "";
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => {
    output += chunk;
    if (output.includes("\n")) result.resolve(output.split("\n")[0]!);
  });
  child.once("error", result.reject);
  child.once("exit", () => result.reject(new Error("fixture exited before publishing child identity")));
  return result.promise;
}

function cleanup(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    execFileSync(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
      ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 5000 });
  } catch { child.kill(); }
}

describe.skipIf(process.platform !== "win32")("native bounded probe cleanup", () => {
  it("ends the owned process tree without touching a sibling probe", async () => {
    const child = spawn(process.execPath, ["-e", `const {spawn}=require('node:child_process'); const nested=spawn(process.execPath,['-e','process.stdin.resume()'],{stdio:['pipe','ignore','ignore'],windowsHide:true}); console.log(nested.pid); process.stdin.resume();`],
      { stdio: ["pipe", "pipe", "ignore"], detached: true, windowsHide: true });
    const sibling = spawn(process.execPath, ["-e", "console.log(process.pid);process.stdin.resume()"],
      { stdio: ["pipe", "pipe", "ignore"], detached: true, windowsHide: true });
    try {
      const nestedPid = Number(await firstLine(child));
      const siblingPid = Number(await firstLine(sibling));
      expect(alive(nestedPid)).toBe(true);
      await stopGroup(child, 200);
      // Integration: taskkill and kernel process exit use real time, not the JS timer clock.
      const deadline = Date.now() + 3000;
      while (alive(nestedPid) && Date.now() < deadline) await delay(25);
      expect(alive(nestedPid)).toBe(false);
      expect(alive(child.pid!)).toBe(false);
      expect(alive(siblingPid)).toBe(true);
    } finally {
      cleanup(child);
      cleanup(sibling);
    }
  }, 15000);
});
