import { expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { resolveWindowsCodexCommand } from "@openrig/daemon/windows-launch";
import { defaultWakeRunner } from "../src/ask-wake.js";

vi.mock("node:child_process", () => ({ execFile: vi.fn((_file: string, _args: string[], _options: unknown, done: (error: Error | null, stdout: string, stderr: string) => void) => done(null, "answer", "")) }));
vi.mock("@openrig/daemon/windows-launch", () => ({ resolveWindowsCodexCommand: vi.fn(() => ({ command: "C:\\Node\\node.exe", args: ["C:\\npm\\codex.js"] })) }));

it("runs headless Codex through its resolved npm entry without evaluating the prompt", async () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  try {
    expect(await defaultWakeRunner("codex", ["exec", "resume", "token", "$(literal)&question"], { timeoutMs: 1000 })).toMatchObject({ stdout: "answer", code: 0 });
    expect(resolveWindowsCodexCommand).toHaveBeenCalledWith(process.env["PATH"] ?? "", process.execPath);
    expect(execFile).toHaveBeenCalledWith("C:\\Node\\node.exe", ["C:\\npm\\codex.js", "exec", "resume", "token", "$(literal)&question"], expect.objectContaining({ timeout: 1000 }), expect.any(Function));
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
});
