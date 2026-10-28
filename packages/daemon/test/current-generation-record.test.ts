// OPR.0.5.9.13 — no name-keyed pointer or transcript recency signal is occupant identity. Resolve
// the canonical current generation through its binding and verified pane/process instead.

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  paneClaudeSessionIdArgument,
  resolveIdentityVerifiedClaudeRecord,
  resolveLiveCodexThreadId,
  type ProcessRow,
} from "../src/domain/model-divergence/current-generation-record.js";

describe("resolveIdentityVerifiedClaudeRecord — canonical occupant identity", () => {
  const canonicalId = "f16594c5-179a-4be7-bf5e-fd759b2b87a3";
  const reserveId = "9e1ac0df-505a-4050-857b-a494b46dabc6";
  const bootAt = "2026-09-04T02:00:00.000Z";
  const canonicalSession = "orch-advisor@v-openrig-build";
  const processes: ProcessRow[] = [
    { pid: 10, ppid: 1, command: "-zsh" },
    { pid: 20, ppid: 10, command: `claude --model claude-fable-5-1 --resume ${canonicalId} --name ${canonicalSession}` },
    { pid: 30, ppid: 1, command: "-zsh" },
    { pid: 40, ppid: 30, command: `claude --model claude-fable-5 --resume ${reserveId} --name ${canonicalSession}` },
  ];

  function input(transcriptPath: string) {
    return {
      sessionName: canonicalSession,
      generation: "generation-current",
      occupantBootAt: bootAt,
      binding: { tmuxSession: canonicalSession, tmuxPane: "%156" },
      identity: {
        verdict: "verified",
        sessionName: canonicalSession,
        observedAt: "2026-09-04T02:30:00.000Z",
        evidence: { registeredPane: "%156", observedPid: 10 },
      },
      sidecar: {
        session_id: canonicalId,
        session_name: canonicalSession,
        transcript_path: transcriptPath,
        sampled_at: "2026-09-04T02:31:00.000Z",
      },
    } as const;
  }

  it("the verified canonical pane wins while the retained alias reserve advances", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openrig-current-occupant-"));
    try {
      const canonicalPath = join(dir, `${canonicalId}.jsonl`);
      const reservePath = join(dir, `${reserveId}.jsonl`);
      writeFileSync(canonicalPath, '{"model":"claude-fable-5-1"}\n');
      writeFileSync(reservePath, '{"model":"claude-opus-5"}\n');
      utimesSync(canonicalPath, new Date("2026-09-04T02:20:00Z"), new Date("2026-09-04T02:20:00Z"));
      utimesSync(reservePath, new Date("2026-09-04T02:40:00Z"), new Date("2026-09-04T02:40:00Z"));

      const base = input(reservePath);
      const out = await resolveIdentityVerifiedClaudeRecord(
        {
          ...base,
          sidecar: {
            ...base.sidecar,
            session_id: reserveId,
            occupant_generation: "generation-retained-predecessor",
          },
        },
        {
          getPanePid: async (target) => target === "%156" ? 10 : null,
          listProcesses: async () => processes,
          readThreadIdByPid: () => undefined,
        },
        (path) => { try { return statSync(path).isFile(); } catch { return false; } },
      );

      expect(out).toEqual({
        ok: true,
        id: canonicalId,
        path: canonicalPath,
        source: "verified-pane-argument",
      });
      expect(statSync(reservePath).mtimeMs).toBeGreaterThan(statSync(canonicalPath).mtimeMs);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("missing, stale, changed, or ambiguous pane identity is explicit and never transcript-recency-selected", async () => {
    const readable = () => true;
    const base = input(`/tmp/${canonicalId}.jsonl`);
    const cases = [
      { value: { ...base, generation: null }, reason: "occupant generation is unknown" },
      { value: { ...base, identity: null }, reason: "no verified pane identity" },
      { value: { ...base, identity: { ...base.identity, observedAt: "2026-09-04T01:59:59.000Z" } }, reason: "predates occupant generation" },
      { value: { ...base, identity: { ...base.identity, evidence: { ...base.identity.evidence, registeredPane: "%6" } } }, reason: "registered pane does not match" },
    ];
    for (const testCase of cases) {
      const out = await resolveIdentityVerifiedClaudeRecord(testCase.value, {
        getPanePid: async () => 10,
        listProcesses: async () => processes,
        readThreadIdByPid: () => undefined,
      }, readable);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toContain(testCase.reason);
    }

    const changed = await resolveIdentityVerifiedClaudeRecord(base, {
      getPanePid: async () => 999,
      listProcesses: async () => processes,
      readThreadIdByPid: () => undefined,
    }, readable);
    expect(!changed.ok && changed.reason).toContain("changed since identity verification");

    const ambiguous = await resolveIdentityVerifiedClaudeRecord(base, {
      getPanePid: async () => 10,
      listProcesses: async () => [...processes, {
        pid: 21,
        ppid: 10,
        command: "claude --resume 11111111-1111-4111-8111-111111111111",
      }],
      readThreadIdByPid: () => undefined,
    }, readable);
    expect(!ambiguous.ok && ambiguous.reason).toContain("multiple claude session ids");
  });

  it("a generation-stamped sidecar may name a provider rollover inside the verified occupant", async () => {
    const rolledId = "22222222-2222-4222-8222-222222222222";
    const base = input(`/tmp/${rolledId}.jsonl`);
    const out = await resolveIdentityVerifiedClaudeRecord({
      ...base,
      sidecar: { ...base.sidecar, session_id: rolledId, occupant_generation: "generation-current" },
    }, {
      getPanePid: async () => 10,
      listProcesses: async () => processes,
      readThreadIdByPid: () => undefined,
    }, () => true);
    expect(out).toMatchObject({ ok: true, id: rolledId, source: "generation-sidecar" });
  });
});

const TABLE: ProcessRow[] = [
  { pid: 10, ppid: 1, command: "-zsh" },
  { pid: 20, ppid: 10, command: "claude --permission-mode acceptEdits --session-id daaeb7b4-841b-45cb-8a33-b062e0ce8296 --name dev-planner@r" },
  { pid: 30, ppid: 10, command: "/usr/local/bin/codex --yolo resume 019f6343-aaaa-bbbb-cccc-ddddeeeeffff" },
  { pid: 40, ppid: 20, command: "node some-child" },
];

const deps = {
  getPanePid: async () => 10,
  listProcesses: async () => TABLE,
  readThreadIdByPid: (pid: number) => (pid === 30 ? "thread-live-123" : undefined),
};

describe("paneClaudeSessionIdArgument (a CANDIDATE source, never the answer alone)", () => {
  it("reads the launch-argument session uuid (the specimen shape)", async () => {
    const out = await paneClaudeSessionIdArgument("dev-planner@r", deps);
    expect(out).toEqual({ ok: true, id: "daaeb7b4-841b-45cb-8a33-b062e0ce8296" });
  });

  it("no pane pid / no claude process / no id argument each yield a NAMED reason, never a silent null", async () => {
    const none = await paneClaudeSessionIdArgument("s", { ...deps, getPanePid: async () => null });
    expect(!none.ok && none.reason).toContain("no live pane pid");
    const noClaude = await paneClaudeSessionIdArgument("s", { ...deps, listProcesses: async () => [{ pid: 10, ppid: 1, command: "-zsh" }] });
    expect(!noClaude.ok && noClaude.reason).toContain("no claude process");
    const noArg = await paneClaudeSessionIdArgument("s", { ...deps, listProcesses: async () => [{ pid: 20, ppid: 10, command: "claude --name x" }, { pid: 10, ppid: 1, command: "-zsh" }] });
    expect(!noArg.ok && noArg.reason).toContain("no --session-id/--resume argument");
  });
});

describe("resolveLiveCodexThreadId", () => {
  it("joins through the live codex pid's logs, bypassing any stored token", async () => {
    const out = await resolveLiveCodexThreadId("s", deps);
    expect(out).toEqual({ ok: true, id: "thread-live-123" });
  });

  it("a codex process whose logs yield nothing is a NAMED reason", async () => {
    const out = await resolveLiveCodexThreadId("s", { ...deps, readThreadIdByPid: () => undefined });
    expect(!out.ok && out.reason).toContain("yielded no thread id");
  });
});

describe("resolveIdentityVerifiedClaudeRecord — occupant boot_at is a SQLite UTC stamp", () => {
  it("accepts an identity verified after boot on a non-UTC host", async () => {
    // occupant_tenures.boot_at comes from datetime('now'): UTC with no zone marker. Read as local
    // time on a UTC-7 host it lands 7h late, so a fresh identity looked like it predated the boot.
    const originalTz = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    try {
      const sessionId = "f16594c5-179a-4be7-bf5e-fd759b2b87a3";
      const out = await resolveIdentityVerifiedClaudeRecord(
        {
          sessionName: "seat@rig",
          generation: "generation-current",
          occupantBootAt: "2026-09-04 02:00:00",
          binding: { tmuxSession: "seat@rig", tmuxPane: "%1" },
          identity: {
            verdict: "verified",
            sessionName: "seat@rig",
            observedAt: "2026-09-04T02:30:00.000Z",
            evidence: { registeredPane: "%1", observedPid: 10 },
          },
          sidecar: {
            session_id: sessionId,
            session_name: "seat@rig",
            transcript_path: `/transcripts/${sessionId}.jsonl`,
            sampled_at: "2026-09-04T02:31:00.000Z",
            occupant_generation: "generation-current",
          },
        },
        {
          getPanePid: async () => 10,
          listProcesses: async () => [
            { pid: 10, ppid: 1, command: "-zsh" },
            { pid: 20, ppid: 10, command: `claude --resume ${sessionId}` },
          ],
          readThreadIdByPid: () => undefined,
        },
        () => true,
      );
      expect(out).toMatchObject({ ok: true, id: sessionId, source: "generation-sidecar" });
    } finally {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
  });
});

describe("native Windows current-generation observation", () => {
  const sessionId = "daaeb7b4-841b-45cb-8a33-b062e0ce8296";
  const otherId = "11111111-1111-4111-8111-111111111111";
  const birth = "2026-10-17T10:00:00.000Z";
  function row(pid: number, ppid: number, executablePath: string, args = "", startedAt = birth): ProcessRow {
    return {
      platform: "win32", pid, ppid, executablePath,
      executableName: executablePath.split("\\").at(-1),
      command: `"${executablePath}"${args ? ` ${args}` : ""}`,
      startedAt,
    };
  }
  const shell = row(10, 1, String.raw`C:\Program Files\PowerShell\7\pwsh.exe`);
  const claude = String.raw`C:\Program Files\Claude\claude.exe`;
  const codex = String.raw`C:\Program Files\Codex\codex.exe`;
  const node = String.raw`C:\Program Files\nodejs\node.exe`;
  const claudeScript = String.raw`C:\Users\Test User\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\cli.js`;
  const codexScript = String.raw`C:\Users\Test User\AppData\Roaming\npm\node_modules\@openai\codex\bin\codex.js`;

  it.each([
    [claude, ""],
    [node, `"${claudeScript}" `],
  ])("reads quoted Claude identity from %s", async (executable, prefix) => {
    expect(await paneClaudeSessionIdArgument("s", {
      getPanePid: async () => 10,
      listProcesses: async () => [shell, row(20, 10, executable, `${prefix}--resume "${sessionId}"`)],
    })).toEqual({ ok: true, id: sessionId });
  });

  it.each([
    [codex, ""],
    [node, `"${codexScript}" `],
  ])("passes the native PID and ISO birth stamp to the Codex log join for %s", async (executable, prefix) => {
    const calls: Array<[number, string | undefined]> = [];
    expect(await resolveLiveCodexThreadId("s", {
      getPanePid: async () => 10,
      listProcesses: async () => [shell, row(20, 10, executable, `${prefix}resume "${sessionId}"`)],
      readThreadIdByPid: (pid, identity) => { calls.push([pid, identity]); return sessionId; },
    })).toEqual({ ok: true, id: sessionId });
    expect(calls).toEqual([[20, birth]]);
  });

  it("recognizes a runtime that is itself the pane process", async () => {
    expect(await paneClaudeSessionIdArgument("s", {
      getPanePid: async () => 10,
      listProcesses: async () => [row(10, 1, claude, `--session-id="${sessionId}"`)],
    })).toEqual({ ok: true, id: sessionId });
  });

  it("rejects unrelated executables, argument mentions, and untrusted Node entrypoints", async () => {
    for (const candidate of [
      row(20, 10, String.raw`C:\Tools\notclaude.exe`, `--resume "${sessionId}"`),
      row(20, 10, node, `"C:\\Tools\\report.js" "${claude}" --resume "${sessionId}"`),
      row(20, 10, node, `-e "claude" --resume "${sessionId}"`),
      { ...row(20, 10, claude, `--resume "${sessionId}"`), executableName: "unrelated.exe" },
    ]) {
      const result = await paneClaudeSessionIdArgument("s", {
        getPanePid: async () => 10, listProcesses: async () => [shell, candidate],
      });
      expect(result.ok).toBe(false);
    }
  });

  it("rejects ambiguous and quoted non-identity Claude arguments", async () => {
    for (const args of [
      `--resume "${sessionId}" --resume "${otherId}"`,
      `--resume "${sessionId}" --session-id "${otherId}"`,
      `--name "--resume ${sessionId}"`,
    ]) {
      expect((await paneClaudeSessionIdArgument("s", {
        getPanePid: async () => 10,
        listProcesses: async () => [shell, row(20, 10, claude, args)],
      })).ok).toBe(false);
    }
    expect((await paneClaudeSessionIdArgument("s", {
      getPanePid: async () => 10,
      listProcesses: async () => [
        shell, row(20, 10, claude, `--resume "${sessionId}"`),
        row(21, 10, claude, `--resume "${otherId}"`),
      ],
    })).ok).toBe(false);
  });

  it("does not join children of a recycled or unobserved Windows parent PID", async () => {
    for (const rows of [
      [shell, row(20, 10, codex, "", "2026-10-17T09:00:00.000Z")],
      [shell, { ...row(20, 10, codex), startedAt: undefined }],
      [row(20, 10, codex)],
    ]) {
      const calls: number[] = [];
      expect((await resolveLiveCodexThreadId("s", {
        getPanePid: async () => 10, listProcesses: async () => rows,
        readThreadIdByPid: (pid) => { calls.push(pid); return sessionId; },
      })).ok).toBe(false);
      expect(calls).toEqual([]);
    }
  });

  it("rejects multiple native Codex conversations rather than picking the first", async () => {
    expect((await resolveLiveCodexThreadId("s", {
      getPanePid: async () => 10,
      listProcesses: async () => [shell, row(20, 10, codex), row(21, 10, codex)],
      readThreadIdByPid: (pid) => pid === 20 ? sessionId : otherId,
    })).ok).toBe(false);
  });

  it.each([false, true])("checks native pane birth before selecting the generation sidecar (recycled: %s)", async (recycled) => {
    const result = await resolveIdentityVerifiedClaudeRecord({
      sessionName: "s", generation: "current", occupantBootAt: "2026-10-17T08:00:00.000Z",
      binding: { tmuxSession: "s", tmuxPane: "%1" },
      identity: {
        verdict: "verified", sessionName: "s",
        observedAt: recycled ? "2026-10-17T09:00:00.000Z" : "2026-10-17T11:00:00.000Z",
        evidence: { registeredPane: "%1", observedPid: 10 },
      },
      sidecar: {
        session_id: sessionId, session_name: "s", transcript_path: `C:\\records\\${sessionId}.jsonl`,
        sampled_at: birth, occupant_generation: "current",
      },
    }, {
      getPanePid: async () => 10,
      listProcesses: async () => [shell, row(20, 10, claude, `--resume "${sessionId}"`)],
    }, () => true);
    if (recycled) {
      expect(result.ok).toBe(false);
      expect(!result.ok && result.reason).toContain("process birth");
    } else {
      expect(result).toMatchObject({ ok: true, id: sessionId, source: "generation-sidecar" });
    }
  });
});

// `ps` rows (no platform, no OS executable) keep the original descendant scan: any argv token whose
// basename is the runtime, and the first 36-character lowercase id after --session-id, then --resume.
describe("POSIX current-generation observation", () => {
  const sessionId = "daaeb7b4-841b-45cb-8a33-b062e0ce8296";
  const otherId = "11111111-1111-4111-8111-111111111111";
  const shell: ProcessRow = { pid: 10, ppid: 1, command: "-zsh", startedAt: "Sat Oct 17 10:00:00 2026" };
  const child = (command: string, startedAt = "Sat Oct 17 10:00:05 2026"): ProcessRow => ({ pid: 20, ppid: 10, command, startedAt });
  const claudeArgument = (rows: ProcessRow[]) => paneClaudeSessionIdArgument("s", { getPanePid: async () => 10, listProcesses: async () => rows });

  it.each([
    `claude --resume ${sessionId}`,
    `node /usr/local/bin/claude --session-id ${sessionId}`,
    `'/opt/bin/claude' --session-id ${sessionId}`,
    `claude --verbose --add-dir /tmp/x --session-id=${sessionId}`,
    `claude --resume ${otherId} --session-id ${sessionId}`,
  ])("reads the session id from %s", async (command) => {
    expect(await claudeArgument([shell, child(command)])).toEqual({ ok: true, id: sessionId });
  });

  it("keeps a child whose ps start time precedes its parent's", async () => {
    expect(await claudeArgument([shell, child(`claude --resume ${sessionId}`, "Sat Oct 17 09:59:00 2026")])).toEqual({ ok: true, id: sessionId });
  });

  it.each([
    `/Users/x/.local/share/claude/versions/2.1.5 --session-id ${sessionId}`,
    `node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js --session-id ${sessionId}`,
  ])("does not scan %s as a claude process", async (command) => {
    expect(await claudeArgument([shell, child(command)])).toEqual({ ok: false, reason: "no claude process under the live pane of s" });
  });

  it("does not scan the pane process itself", async () => {
    expect(await claudeArgument([{ ...shell, command: `claude --session-id ${sessionId}` }]))
      .toEqual({ ok: false, reason: "no claude process under the live pane of s" });
  });

  it.each([`claude --session-id abc`, `claude --session-id ${sessionId.toUpperCase()}`])("reads no session id from %s", async (command) => {
    expect(await claudeArgument([shell, child(command)]))
      .toEqual({ ok: false, reason: "live claude process under s carries no --session-id/--resume argument" });
  });

  it("joins a Codex npm launcher and its native child to the log reader, launcher first", async () => {
    const calls: number[] = [];
    const rows: ProcessRow[] = [shell, child("node /usr/local/bin/codex resume x"),
      { pid: 30, ppid: 20, command: "/usr/local/lib/node_modules/@openai/codex/vendor/x/codex/codex resume x", startedAt: shell.startedAt }];
    expect(await resolveLiveCodexThreadId("s", {
      getPanePid: async () => 10, listProcesses: async () => rows,
      readThreadIdByPid: (pid) => { calls.push(pid); return pid === 30 ? sessionId : undefined; },
    })).toEqual({ ok: true, id: sessionId });
    expect(calls).toEqual([20, 30]);
    expect((await resolveLiveCodexThreadId("s", {
      getPanePid: async () => 10, listProcesses: async () => [shell, child("node /usr/lib/node_modules/@openai/codex/bin/codex.js resume x")],
      readThreadIdByPid: () => sessionId,
    }))).toEqual({ ok: false, reason: "no codex process under the live pane of s" });
  });
});
