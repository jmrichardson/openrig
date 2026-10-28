// Native acceptance through the built CLI, production daemon, and psmux. Uses stub runtimes, no provider credentials.
// node scripts/verify-windows-native.mjs <absolute tmux.exe> [new evidence directory]
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
if (process.platform !== 'win32')
  throw new Error('This acceptance check requires native Windows');
if (!process.argv[2] || !path.isAbsolute(process.argv[2]))
  throw new Error('Pass the absolute path to psmux tmux.exe');
const base = process.argv[3] ? path.resolve(process.argv[3]) : fs.mkdtempSync(path.join(tmpdir(), 'openrig-native-accept-'));
fs.mkdirSync(base, { recursive: true });
if (fs.readdirSync(base).length)
  throw new Error('Evidence directory must be new and empty');
const root = fileURLToPath(new URL('../', import.meta.url)), cli = path.join(root, 'packages/cli/dist/bin-wrapper.js');
const mux = fs.realpathSync(process.argv[2]);
const env = { ...process.env };
for (const k of Object.keys(env))
  if (/^(OPENRIG_|RIGGED_|HERDR_|REX_)/.test(k) || ['TMUX', 'TMUX_PANE', 'CLAUDECODE', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'].includes(k))
    delete env[k];
const home = path.join(base, 'user'), state = path.join(base, 'state'), project = path.join(base, 'project');
for (const d of [home, state, project])
  fs.mkdirSync(d, { recursive: true });
Object.assign(env, { HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'), OPENRIG_HOME: state, PSMUX_DATA_DIR: path.join(base, 'psmux'), PATH: path.dirname(mux) + path.delimiter + process.env.PATH, OPENRIG_HOST_SELECTED: 'local' });
const report = { evidenceDirectory: base, platform: process.platform, node: process.version, steps: [], sessions: [], ok: false };
const run = (args, extra = {}) => new Promise((resolve, reject) => { const label = args.slice(0, 2).join('-').replace(/[^\w-]/g, '_') + '-' + report.steps.length; cp.execFile(process.execPath, [cli, ...args], { cwd: project, env: { ...env, ...extra }, windowsHide: true, timeout: 120000, maxBuffer: 4 * 1024 * 1024 }, (err, out, stderr) => { fs.writeFileSync(path.join(base, label + '.stdout.log'), out); fs.writeFileSync(path.join(base, label + '.stderr.log'), stderr); report.steps.push({ args: args.slice(0, 3), code: err?.code ?? 0, log: label }); if (err)
  reject(new Error(label + ' failed: ' + String(stderr || out).slice(-1500)));
else
  resolve(out); }); });
const muxRun = (session, args) => new Promise((res, rej) => cp.execFile(mux, ['-t', '=' + session, ...args], { env, windowsHide: true, timeout: 10000 }, (e, o) => e ? rej(e) : res(o.trim())));
(async () => {
  const server = net.createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  await new Promise(r => server.close(r));
  Object.assign(env, { OPENRIG_URL: 'http://127.0.0.1:' + port, OPENRIG_PORT: String(port), OPENRIG_HOST: '127.0.0.1', OPENRIG_DB: path.join(state, 'db.sqlite') });
  const spec = path.join(project, 'rig.yaml');
  fs.mkdirSync(path.join(project, 'agents/worker'), { recursive: true });
  fs.writeFileSync(path.join(project, 'agents/worker/agent.yaml'), 'name: worker\nversion: "1.0"\nprofiles:\n  default:\n    uses:\n      skills: []\n');
  for (const name of ['one', 'two'])
    fs.mkdirSync(path.join(project, name), { recursive: true });
  fs.writeFileSync(spec, 'version: "0.2"\nname: native-accept\npods:\n  - id: work\n    label: Work\n    members:\n      - {id: one, agent_ref: "local:agents/worker", profile: default, runtime: stub, cwd: ./one}\n      - {id: two, agent_ref: "local:agents/worker", profile: default, runtime: stub, cwd: ./two}\n    edges: []\nedges: []\n');
  let up = false, started = false;
  try {
    await run(['daemon', 'start', '--port', String(port), '--db', env.OPENRIG_DB, '--no-kernel']);
    started = true;
    up = true;
    await run(['up', spec, '--yes', '--json']);
    const seats = JSON.parse(await run(['ps', '--nodes', '--rig', 'native-accept', '--json']));
    fs.writeFileSync(path.join(base, 'seats-before.json'), JSON.stringify(seats, null, 2));
    const sessions = seats.map(s => s.canonicalSessionName);
    if (sessions.length !== 2 || seats.some(s => s.startupStatus !== 'ready'))
      throw Error('two native seats were not ready');
    report.sessions = sessions;
    const before = await Promise.all(sessions.map(s => muxRun(s, ['list-panes', '-t', '=' + s, '-F', '#{pane_id}|#{pane_pid}'])));
    await run(['send', sessions[0], 'OPENRIG_NATIVE_ACCEPT_ONE', '--json']);
    await run(['send', sessions[1], 'OPENRIG_NATIVE_ACCEPT_TWO', '--json']);
    for (let i = 0; i < sessions.length; i++) {
      const screen = await muxRun(sessions[i], ['capture-pane', '-p', '-S', '-100', '-t', '=' + sessions[i]]);
      fs.writeFileSync(path.join(base, 'pane-' + i + '.log'), screen);
      if (!screen.includes(i ? 'OPENRIG_NATIVE_ACCEPT_TWO' : 'OPENRIG_NATIVE_ACCEPT_ONE'))
        throw Error('sent marker missing from native pane ' + i);
    }
    const queued = JSON.parse(await run(['queue', 'create', '--summary', 'Native durable handoff', '--destination', sessions[1], '--body', 'Native acceptance fixture', '--json'], { OPENRIG_SESSION_NAME: sessions[0] }));
    fs.writeFileSync(path.join(base, 'queue-before.json'), JSON.stringify(queued, null, 2));
    const qitemId = queued.qitemId ?? queued.id ?? queued.qitem?.id ?? queued.item?.id;
    if (!qitemId)
      throw Error('Queue creation returned no durable qitem identity');
    await run(['daemon', 'stop']);
    started = false;
    await run(['daemon', 'start', '--port', String(port), '--db', env.OPENRIG_DB, '--no-kernel']);
    started = true;
    const after = await Promise.all(sessions.map(s => muxRun(s, ['list-panes', '-t', '=' + s, '-F', '#{pane_id}|#{pane_pid}'])));
    if (JSON.stringify(before) !== JSON.stringify(after))
      throw Error('native pane processes changed across daemon restart');
    report.panesSurvivedDaemonRestart = true;
    const restoredQueue = await run(['queue', 'show', qitemId, '--json']);
    if (!restoredQueue.includes(qitemId))
      throw Error('Queue handoff missing after daemon restart');
    report.queuePersistedAcrossDaemonRestart = true;
    await run(['send', sessions[1], 'OPENRIG_NATIVE_AFTER_RESTART', '--json']);
    report.ok = true;
  }
  finally {
    if (up)
      await run(['down', 'native-accept', '--force', '--json']).catch(e => { report.cleanupError = e.message; report.ok = false; });
    if (started)
      await run(['daemon', 'stop']).catch(e => { report.cleanupError = e.message; report.ok = false; });
    fs.writeFileSync(path.join(base, 'acceptance.json'), JSON.stringify(report, null, 2));
  }
  if (!report.ok)
    throw Error('native acceptance failed');
  console.log(JSON.stringify(report, null, 2));
})().catch(e => { report.error = e.message; fs.writeFileSync(path.join(base, 'acceptance.json'), JSON.stringify(report, null, 2)); console.error(e.message); process.exitCode = 1; });
