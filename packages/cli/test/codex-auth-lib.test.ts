// OPR.0.4.1.29 — rig auth secret-safe core (CLI-local, daemon-free). Foundational primitives:
// fail-closed profile-name whitelist + CODEX_HOME path resolution (default $HOME/.codex, overridable).
import { describe, it, expect } from "vitest";
import { homedir, userInfo } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { validateProfileName, resolveCodexHome } from "../src/lib/codex-auth.js";

describe("validateProfileName (OPR.0.4.1.29 — fail-closed whitelist)", () => {
  it("accepts alnum-led names with . _ - (<=64 chars)", () => {
    for (const ok of ["work", "team-a", "acct.1", "A_b-2", "x", "a".repeat(64)]) {
      expect(validateProfileName(ok)).toBe(true);
    }
  });

  it("rejects traversal, separators, dotfiles, tilde, whitespace, control, shell-meta, empty, >64", () => {
    for (const bad of [
      "", ".", "..", "../x", "a/b", "a\\b", "~x", ".hidden", "-lead", "a b", "a\tb", "a\nb",
      "a;b", "a$b", "a`b", "a|b", "a\0b", "a".repeat(65),
    ]) {
      expect(validateProfileName(bad)).toBe(false);
    }
  });
});

describe("resolveCodexHome (OPR.0.4.1.29 — default $HOME/.codex, env-overridable)", () => {
  it("uses CODEX_HOME when set, deriving the secret-adjacent paths under it", () => {
    const home = resolve("fixture", "codex");
    const p = resolveCodexHome({ CODEX_HOME: home, HOME: resolve("other-home"), USERPROFILE: resolve("other-profile") });
    expect(p.codexHome).toBe(home);
    expect(p.profileDir).toBe(join(home, "auth-profiles"));
    expect(p.activeAuth).toBe(join(home, "auth.json"));
    expect(p.registryPath).toBe(join(home, "auth-seat-registry.tsv"));
  });

  it("defaults to $HOME/.codex when CODEX_HOME is unset/empty (no personal path baked in)", () => {
    const home = resolve("fixture", "home");
    expect(resolveCodexHome({ HOME: home }, "linux").codexHome).toBe(join(home, ".codex"));
    expect(resolveCodexHome({ HOME: home, CODEX_HOME: "" }, "darwin").codexHome).toBe(join(home, ".codex"));
  });

  it("keeps the POSIX fallback when HOME is unset: .codex under the account home, never USERPROFILE", () => {
    expect(resolveCodexHome({}, "linux").codexHome).toBe(join(userInfo().homedir, ".codex"));
    expect(resolveCodexHome({ USERPROFILE: resolve("other-profile") }, "darwin").codexHome).toBe(join(userInfo().homedir, ".codex"));
  });

  it("uses the profile directory on Windows, as Codex does, even when HOME points elsewhere", () => {
    const profile = resolve("fixture", "windows-profile");
    expect(resolveCodexHome({ HOME: resolve("fixture", "msys-home"), USERPROFILE: profile }, "win32").codexHome).toBe(join(profile, ".codex"));
    expect(resolveCodexHome({ USERPROFILE: profile, CODEX_HOME: "" }, "win32").codexHome).toBe(join(profile, ".codex"));
    expect(resolveCodexHome({}, "win32").codexHome).toBe(join(homedir(), ".codex"));
  });

  // Codex for Windows reads ~/.codex from the user profile, never HOME or userInfo(); the case above pins that path.
  it.skipIf(process.platform === "win32")("falls back to the user's home when HOME is unset or empty (never a cwd-relative .codex)", () => {
    expect(resolveCodexHome({}).codexHome).toBe(join(userInfo().homedir, ".codex"));
    expect(resolveCodexHome({ HOME: "" }).codexHome).toBe(join(userInfo().homedir, ".codex"));
    expect(resolveCodexHome({ HOME: "", CODEX_HOME: "" }).codexHome).toBe(join(userInfo().homedir, ".codex"));
    expect(isAbsolute(resolveCodexHome({ HOME: "" }).codexHome)).toBe(true);
  });
});
