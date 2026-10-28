import { describe, expect, it } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";

describe("psmux environment command transport", () => {
  it("keeps environment values out of native client argv and sources them only on the new session", async () => {
    const calls: string[][] = [];
    const adapter = new TmuxAdapter(async () => { throw new Error("no shell transport"); }, undefined, async argv => {
      calls.push(argv);
      return argv[1] === "new-session" ? "%1\n" : "";
    }, "psmux");
    expect(await adapter.createSession("native-worker", "C:/work space", { EXAMPLE: "two words" })).toEqual({ ok: true });
    expect(calls[0]).toEqual(["tmux", "new-session", "-d", "-s", "native-worker", "-c", "C:/work space",
      "-P", "-F", "#{pane_id}", expect.stringContaining("powershell.exe")]);
    expect(calls[1]).toEqual(["tmux", "-t", "=native-worker", "source-file", expect.any(String)]);
    expect(JSON.stringify(calls)).not.toContain("two words");
    expect(calls.some(argv => argv.includes("start-server"))).toBe(false);
  });
});
