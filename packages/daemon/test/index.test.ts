import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const serveMock = vi.fn();
const createDaemonMock = vi.fn();
const startWindowsControlMock = vi.fn();
const serverMock = { prependListener: vi.fn() };
let signalListenersBefore: { SIGINT: Function[]; SIGTERM: Function[] };

vi.mock("@hono/node-server", () => ({
  serve: serveMock,
}));

vi.mock("../src/startup.js", () => ({
  createDaemon: createDaemonMock,
}));

// The Windows stop channel runs PowerShell and a named pipe; its own suite covers them natively.
vi.mock("../src/windows-daemon-control.js", () => ({
  startWindowsDaemonControl: startWindowsControlMock,
  requestWindowsDaemonStop: vi.fn(),
}));

describe("daemon startServer", () => {
  beforeEach(() => {
    signalListenersBefore = {
      SIGINT: process.listeners("SIGINT"),
      SIGTERM: process.listeners("SIGTERM"),
    };
    serveMock.mockReset();
    serverMock.prependListener.mockReset();
    serveMock.mockReturnValue(serverMock);
    startWindowsControlMock.mockReset();
    startWindowsControlMock.mockResolvedValue(async () => {});
    createDaemonMock.mockReset();
    createDaemonMock.mockResolvedValue({
      app: { fetch: vi.fn() },
      contextMonitor: { start: vi.fn(), stop: vi.fn() },
      deps: {},
      injectWebSocket: vi.fn(),
    });
    delete process.env.OPENRIG_HOST;
    delete process.env.RIGGED_HOST;
    delete process.env.OPENRIG_BIND_HOST;
    delete process.env.OPENRIG_AUTH_BEARER_TOKEN;
    delete process.env.OPENRIG_TERMINAL_BEARER_TOKEN;
  });

  afterEach(() => {
    // startServer installs shutdown handlers; keep this mock-only fixture isolated.
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      for (const listener of process.listeners(signal)) {
        if (!signalListenersBefore[signal].includes(listener)) {
          process.removeListener(signal, listener as () => void);
        }
      }
    }
    delete process.env.OPENRIG_HOST;
    delete process.env.RIGGED_HOST;
    delete process.env.OPENRIG_BIND_HOST;
    delete process.env.OPENRIG_AUTH_BEARER_TOKEN;
    delete process.env.OPENRIG_TERMINAL_BEARER_TOKEN;
  });

  it("binds the daemon to loopback", async () => {
    const { startServer } = await import("../src/index.js");

    const server = await startServer(7441);

    expect(serveMock).toHaveBeenCalledWith(
      expect.objectContaining({ port: 7441, hostname: "127.0.0.1" }),
      expect.any(Function)
    );
    expect(server).toBe(serverMock);
    expect(serverMock.prependListener).toHaveBeenCalledWith(
      "request", expect.any(Function),
    );
  });

  it("does not require a terminal bearer token for the default loopback bind", async () => {
    const { startServer } = await import("../src/index.js");

    await startServer(7441);

    expect(createDaemonMock).toHaveBeenCalledWith(
      expect.objectContaining({ terminalBearerToken: null }),
    );
  });

  it("uses the daemon bearer token for terminal routes on explicit public binds", async () => {
    process.env.OPENRIG_BIND_HOST = "0.0.0.0";
    process.env.OPENRIG_AUTH_BEARER_TOKEN = "daemon-token";
    const { startServer } = await import("../src/index.js");

    await startServer(7441);

    expect(createDaemonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        bearerToken: "daemon-token",
        terminalBearerToken: "daemon-token",
      }),
    );
  });

  describe("Windows private stop channel", () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    const as = (value: string) => Object.defineProperty(process, "platform", { ...platform, value });
    afterEach(() => { Object.defineProperty(process, "platform", platform); vi.restoreAllMocks(); });

    it("is published before any listener binds, so the CLI never sees a daemon it cannot drain", async () => {
      as("win32");
      const order: string[] = [];
      startWindowsControlMock.mockImplementation(async () => { order.push("control"); return async () => {}; });
      serveMock.mockImplementation(() => { order.push("serve"); return serverMock; });
      const { startServer } = await import("../src/index.js");

      await startServer(7441);

      // One serve per bind host (loopback, plus Tailscale where it is up).
      expect(order[0]).toBe("control");
      expect(order.length).toBeGreaterThan(1);
      expect(new Set(order.slice(1))).toEqual(new Set(["serve"]));
    });

    it("exits before listening, with the reason, when the channel cannot be published", async () => {
      as("win32");
      startWindowsControlMock.mockRejectedValue(new Error("Windows private control directory unavailable; no capability published"));
      const exit = vi.spyOn(process, "exit").mockImplementation(((code: number) => { throw new Error(`exit ${code}`); }) as never);
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      const { startServer } = await import("../src/index.js");

      await expect(startServer(7441)).rejects.toThrow("exit 1");

      expect(exit).toHaveBeenCalledWith(1);
      expect(serveMock).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith("[windows-control] Windows private control directory unavailable; no capability published; the daemon did not start.");
    });

    it("is never opened on Linux or macOS", async () => {
      for (const host of ["linux", "darwin"]) {
        as(host);
        const { startServer } = await import("../src/index.js");
        await startServer(7441);
      }
      expect(startWindowsControlMock).not.toHaveBeenCalled();
    });
  });
});
