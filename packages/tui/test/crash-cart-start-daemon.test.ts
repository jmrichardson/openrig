import { describe, it, expect } from "vitest";
import { daemonStartArgs, fleetRestoreStartCommand } from "../src/crash-cart/start-daemon.js";
import { resolveCrashCartKey } from "../src/crash-cart/keys.js";

describe("local startup target", () => {
  it("starts only the intended local daemon, leaving occupant selection to the user", () => {
    expect(daemonStartArgs("http://127.0.0.1:17433")).toEqual([
      "daemon", "start", "--no-kernel", "--host", "127.0.0.1", "--port", "17433",
    ]);
  });
  it.each(["https://example.test", "http://10.0.0.2:7433", "http://user:password@localhost:7433", "http://localhost:7433/other"])(
    "does not turn %s into local startup authority", (target) => {
      expect(() => daemonStartArgs(target)).toThrow("no local daemon was started");
    },
  );
  it.each(["linux", "darwin"] as const)("restores the fleet with a plain rig daemon start from PATH on %s", (platform) => {
    expect(fleetRestoreStartCommand("/usr/bin/node", ["/opt/openrig/dist/bin-wrapper.js"], platform)).toEqual({ executable: "rig", args: ["daemon", "start"] });
  });
  it("restores the fleet through the CLI entry on Windows, keeping the plain daemon start", () => {
    expect(fleetRestoreStartCommand("C:\\node\\node.exe", ["C:\\npm\\node_modules\\@openrig\\cli\\dist\\bin-wrapper.js"], "win32")).toEqual({
      executable: "C:\\node\\node.exe", args: ["C:\\npm\\node_modules\\@openrig\\cli\\dist\\bin-wrapper.js", "daemon", "start"],
    });
  });
  it("unavailable prerequisites permit inspection/retry but no recovery effects", () => {
    const opts = { unavailable: "native load failed" };
    expect(resolveCrashCartKey("r", opts)).toBe("retry");
    expect(resolveCrashCartKey("d", opts)).toBe("details");
    for (const key of ["s", "n", "enter", "i"]) expect(resolveCrashCartKey(key, opts)).toBeNull();
  });
});
