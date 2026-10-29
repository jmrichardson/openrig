import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { terminalAuthHeaders } from "../src/client.js";

// The terminal token is read from getOpenRigHome(): OPENRIG_HOME, else os.homedir()/.openrig, the home the
// daemon writes it under. Windows' os.homedir() is the profile directory (USERPROFILE), so a PowerShell or
// cmd shell with no HOME, an empty HOME, or an MSYS shell's HOME all read the profile's token. These cases
// need Windows' own os.homedir(); openrig-home-empty.test.ts covers the empty-OPENRIG_HOME lookup everywhere.
const windows = process.platform === "win32";
let root: string;
let profile: string;

function tokenUnder(home: string, token: string): void {
  fs.mkdirSync(path.join(home, ".openrig"), { recursive: true });
  fs.writeFileSync(path.join(home, ".openrig", "terminal-token"), `${token}\n`);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "rig-terminal-token-"));
  profile = path.join(root, "profile");
  tokenUnder(profile, "profile-token");
  vi.stubEnv("USERPROFILE", profile);
  vi.stubEnv("OPENRIG_HOME", undefined);
  vi.stubEnv("RIGGED_HOME", undefined);
  vi.stubEnv("OPENRIG_TERMINAL_BEARER_TOKEN", undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe.runIf(windows)("terminal token on Windows", () => {
  it("reads the terminal token from the profile directory when Windows PowerShell sets no HOME", () => {
    vi.stubEnv("HOME", undefined);
    expect(terminalAuthHeaders()).toEqual({ Authorization: "Bearer profile-token" });
  });

  it("reads the terminal token from the profile directory when HOME is empty", () => {
    vi.stubEnv("HOME", "");
    expect(terminalAuthHeaders()).toEqual({ Authorization: "Bearer profile-token" });
  });

  it("reads the terminal token from the profile directory, not an MSYS shell's HOME", () => {
    const home = path.join(root, "home");
    tokenUnder(home, "home-token");
    vi.stubEnv("HOME", home);
    expect(terminalAuthHeaders()).toEqual({ Authorization: "Bearer profile-token" });
  });
});
