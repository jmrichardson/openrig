import http from "node:http";
import net, { type AddressInfo } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposeServicesAdapter } from "../src/adapters/compose-services-adapter.js";
import { execArgvCommand } from "../src/adapters/tmux-exec.js";
import type { ExecFn } from "../src/adapters/tmux.js";

// The Windows transport: cmd.exe would keep the POSIX single quotes and has no
// /dev/null or nc, so compose runs as argv and the probes run in-process.
const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function windowsAdapter(output = "") {
  const shell = vi.fn(async () => { throw new Error("no shell command on Windows"); }) as unknown as ExecFn;
  const argv = vi.fn(async (_argv: string[]) => output);
  return { adapter: new ComposeServicesAdapter(shell, "win32", argv), shell, argv };
}

async function listen(server: net.Server, host = "127.0.0.1"): Promise<number> {
  server.listen(0, host);
  await once(server, "listening");
  cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  return (server.address() as AddressInfo).port;
}

describe("Compose services on Windows", () => {
  it("runs up, down, ps and logs as argv, with paths and names exactly as given", async () => {
    const { adapter, shell, argv } = windowsAdapter('{"Service":"api","State":"running","Status":"Up","Health":"healthy"}\n');
    const target = { composeFile: "C:\\Users\\o'brien\\my rig\\compose \"x\".yaml", projectName: "rig-abc", profiles: ["db", "cache"] };
    const base = ["docker", "compose", "-f", target.composeFile, "-p", "rig-abc", "--profile", "db", "--profile", "cache"];
    expect(await adapter.up(target)).toEqual({ ok: true });
    expect(await adapter.down({ ...target, policy: "down_and_volumes" })).toEqual({ ok: true });
    expect(await adapter.down({ ...target, policy: "down" })).toEqual({ ok: true });
    expect(await adapter.status(target)).toEqual({ ok: true, services: [{ name: "api", state: "running", status: "Up", health: "healthy" }] });
    await adapter.logs({ ...target, service: "api", tail: 0 });
    await adapter.logs({ ...target, tail: NaN });
    expect(argv.mock.calls.map(([call]) => call)).toEqual([
      [...base, "up", "-d"],
      [...base, "down", "--volumes"],
      [...base, "down"],
      [...base, "ps", "--format", "json"],
      [...base, "logs", "--tail", "0", "api"],
      [...base, "logs"],
    ]);
    expect(shell).not.toHaveBeenCalled();
  });

  it("reports a failed compose run with its output, as the shell transport does", async () => {
    const argv = vi.fn(async () => { throw new Error("Command failed: docker compose up\nno configuration file provided"); });
    const adapter = new ComposeServicesAdapter(vi.fn() as unknown as ExecFn, "win32", argv);
    expect(await adapter.up({ composeFile: "C:\\c.yaml", projectName: "p" })).toEqual({
      ok: false, code: "compose_up_failed", message: "Command failed: docker compose up\nno configuration file provided",
    });
  });

  it("passes each argument through the real execFile boundary unchanged", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "compose-win-argv-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const printer = path.join(dir, "print argv.cjs");
    fs.writeFileSync(printer, "process.stdout.write(JSON.stringify(process.argv.slice(2)))");
    // Stands in for docker: the same argv, started without a shell.
    const adapter = new ComposeServicesAdapter(vi.fn() as unknown as ExecFn, "win32", argv => execArgvCommand([process.execPath, printer, ...argv.slice(1)]));
    const composeFile = path.join(dir, "my rig", "o'brien \"x\" 100% & more.yaml");
    const result = await adapter.logs({ composeFile, projectName: "rig-abc", service: "api", tail: 25 });
    expect(result.ok).toBe(true);
    expect(JSON.parse(result.output)).toEqual(["compose", "-f", composeFile, "-p", "rig-abc", "logs", "--tail", "25", "api"]);
  });

  it("passes an HTTP target on a 2xx or 3xx answer without following a redirect", async () => {
    const paths: string[] = [];
    const server = http.createServer((req, res) => {
      paths.push(req.url!);
      if (req.url === "/ok") res.writeHead(204).end();
      else if (req.url === "/moved") res.writeHead(302, { Location: "/missing" }).end();
      else res.writeHead(req.url === "/broken" ? 500 : 404).end();
    });
    const port = await listen(server);
    const { adapter, shell } = windowsAdapter();
    expect(await adapter.probeHttp(`http://127.0.0.1:${port}/ok`, 1000)).toBe(true);
    expect(await adapter.probeHttp(`http://127.0.0.1:${port}/moved`, 1000)).toBe(true);
    expect(await adapter.probeHttp(`http://127.0.0.1:${port}/broken`, 1000)).toBe(false);
    expect(await adapter.probeHttp(`http://127.0.0.1:${port}/missing`, 1000)).toBe(false);
    expect(paths).toEqual(["/ok", "/moved", "/broken", "/missing"]);
    expect(await adapter.probeHttp("not a url", 1000)).toBe(false);
    expect(shell).not.toHaveBeenCalled();
  });

  it("gives up on an HTTP target that never answers, within the whole-second bound", async () => {
    const sockets: net.Socket[] = [];
    const server = net.createServer(socket => { sockets.push(socket); /* accepts and never answers */ });
    const port = await listen(server);
    cleanups.push(() => { for (const socket of sockets) socket.destroy(); });
    const started = Date.now();
    expect(await windowsAdapter().adapter.probeHttp(`http://127.0.0.1:${port}/`, 200)).toBe(false);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it.each(["127.0.0.1", "::1"])("probes an owned %s TCP listener", async host => {
    let connections = 0;
    const server = net.createServer(socket => { connections++; socket.end(); });
    let port: number;
    try { port = await listen(server, host); } catch { return; /* no IPv6 loopback on this host */ }
    const { adapter, shell } = windowsAdapter();
    const bracketed = host.includes(":") ? `[${host}]` : host;
    expect(await adapter.probeTcp(`${bracketed}:${port}`, 1000)).toBe(true);
    await vi.waitFor(() => expect(connections).toBe(1));
    // nc would resolve a service name; the in-process probe takes a port number only.
    expect(await adapter.probeTcp(`${bracketed}:http`, 1000)).toBe(false);
    expect(shell).not.toHaveBeenCalled();
  });

  it("fails a TCP target that cannot be reached", async () => {
    // A just-closed loopback port is not a portable negative: WSL's mirrored loopback accepts it.
    expect(await windowsAdapter().adapter.probeTcp("openrig-probe.invalid:80", 1000)).toBe(false);
    expect(await windowsAdapter().adapter.probeTcp("no-port-here", 1000)).toBe(false);
  });
});
