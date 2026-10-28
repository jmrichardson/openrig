import { describe, expect, it } from "vitest";
import type { TmuxResult } from "../src/adapters/tmux.js";
import { terminatePaneInPlace, type PaneCutoverTmux } from "../src/domain/pane-cutover.js";

// A pane whose root dies on the given signal; every call is recorded in order.
function fakeTmux(dieOn: "TERM" | "KILL", termResult: TmuxResult = { ok: true }) {
  const calls: string[] = [];
  let dead = false;
  const tmux: PaneCutoverTmux = {
    setRemainOnExit: async () => { calls.push("remain"); return { ok: true }; },
    signalPaneProcess: async (_pane, signal) => {
      calls.push(signal);
      if (signal === dieOn) dead = true;
      return signal === "TERM" ? termResult : { ok: true };
    },
    isPaneDead: async () => { calls.push("poll"); return dead; },
  };
  return { tmux, calls };
}

const timing = { pollMs: 10, timeoutMs: 30, sleep: async () => {} };

describe("terminatePaneInPlace", () => {
  it("waits out the TERM window before KILL when TERM was sent", async () => {
    const { tmux, calls } = fakeTmux("KILL");
    expect(await terminatePaneInPlace(tmux, "%1", timing)).toEqual({ ok: true, path: "forced" });
    expect(calls).toEqual(["remain", "TERM", "poll", "poll", "poll", "poll", "KILL", "poll"]);
  });

  it("returns graceful when the root exits on TERM", async () => {
    const { tmux, calls } = fakeTmux("TERM");
    expect(await terminatePaneInPlace(tmux, "%1", timing)).toEqual({ ok: true, path: "graceful" });
    expect(calls).toEqual(["remain", "TERM", "poll"]);
  });

  it("still waits after a TERM that failed for another reason", async () => {
    const { tmux, calls } = fakeTmux("KILL", { ok: false, code: "signal_failed", message: "no such process" });
    expect(await terminatePaneInPlace(tmux, "%1", timing)).toEqual({ ok: true, path: "forced" });
    expect(calls.slice(0, 3)).toEqual(["remain", "TERM", "poll"]);
  });

  it("goes straight to KILL when psmux reports no graceful signal exists", async () => {
    const { tmux, calls } = fakeTmux("KILL", { ok: false, code: "graceful_unsupported", message: "nothing was signalled" });
    expect(await terminatePaneInPlace(tmux, "%1", timing)).toEqual({ ok: true, path: "forced" });
    expect(calls).toEqual(["remain", "TERM", "KILL", "poll"]);
  });

  it("keeps the TERM failure text when the forced KILL does not end the pane either", async () => {
    const { tmux } = fakeTmux("TERM", { ok: false, code: "graceful_unsupported", message: "nothing was signalled" });
    tmux.isPaneDead = async () => false;
    const result = await terminatePaneInPlace(tmux, "%1", timing);
    expect(result).toEqual({ ok: false, message: 'Retiree in pane "%1" did not exit after graceful TERM + forced KILL. Tmux failures: TERM: nothing was signalled.' });
  });
});
