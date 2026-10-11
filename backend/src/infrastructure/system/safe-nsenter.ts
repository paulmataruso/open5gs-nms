import { spawn } from 'child_process';

// ── Safe nsenter -p wrapper ──────────────────────────────────────────────
//
// Real, reproduced-live bug (found 2026-09-25 building the SigScale OCS
// Grafana dashboard, confirmed broader while building the Asterisk one):
// `nsenter -p` (PID-namespace entry) forks internally BEFORE it execs the
// wrapped command — a process cannot setns() itself into a new PID
// namespace, only its future children can (documented util-linux behavior;
// see `nsenter --help`'s own `-F, --no-fork` entry). This is unconditional
// on whether the wrapped command itself forks: even a bare, non-forking
// binary (`kamcmd`, `sleep`) still ends up a GRANDCHILD of the process
// Node's own `execFile`/`spawn` tracks. `execFile`'s own `timeout` option
// (and any hand-rolled equivalent that just calls `child.kill()`) only
// signals that single tracked top PID — the real wrapped command survives,
// reparented to init, invisible to Node from then on.
//
// This was originally found and fixed only for `ocs-controller.ts`'s own
// Erlang-RPC chain (`runOcsEval` -> `runuser -> bash -> erl`), then reused
// as-is for the new Asterisk dashboard poller. **Now also the underlying
// mechanism for `LocalHostExecutor.executeCommand()`** (2026-09-25,
// dedicated follow-up, not bundled into either dashboard item that found
// it) — that class is the single most widely-used host-execution path in
// this codebase (every `systemctl`/`ip`/generic host command across nearly
// every controller), and `KamailioStatsMonitor` alone was already calling
// through it every 15s, forever, in production, making it the highest-
// consequence caller of this exact bug. `executeLocalCommand()` (the OTHER
// method on that class) does NOT go through nsenter at all — it runs
// directly inside the container for tools like mongodump that must write
// to container-mounted volumes — so it was never exposed to this and is
// untouched.
//
// Fix: spawn detached — this makes the `nsenter` process the leader of its
// own new process group, and every descendant it forks inherits that same
// PGID (confirmed live) — so a timeout or stdout-overflow can safely kill
// the WHOLE group via `process.kill(-pid, 'SIGKILL')` instead of Node's
// single-PID default, without touching this Node process's own group.
//
// Also uses a generous maxBuffer (100MB, matching what `LocalHostExecutor`
// already used before this migration — see this file's own git history /
// that class's still-present comment on the real tshark/6.4MB incident
// that fix addressed) rather than `execFile`'s 1MB default, which silently
// truncate-kills exactly like the timeout case above.
//
// Every rejection (timeout, stdout overflow, or a genuine non-zero exit)
// carries whatever stdout/stderr had actually been captured up to that
// point as `.stdout`/`.stderr` properties on the Error, and a non-zero
// exit also carries `.code` — matching the shape `child_process`'s own
// promisified errors have, since `LocalHostExecutor.executeCommand()`'s
// existing catch block already destructures errors that way and every
// other caller of this function should be able to rely on the same shape.

const SAFE_NSENTER_MAX_BUFFER_BYTES = 100 * 1024 * 1024; // 100MB

export function safeNsenter(cmd: string, args: string[] = [], timeoutMs = 20000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('nsenter', ['-t', '1', '-m', '-u', '-i', '-p', cmd, ...args], {
      detached: true,
      env: { ...process.env, DBUS_SYSTEM_BUS_ADDRESS: 'unix:path=/var/run/dbus/system_bus_socket' },
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const killGroup = () => {
      if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } }
    };
    const finish = (err: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(Object.assign(err, { stdout, stderr })); else resolve({ stdout, stderr });
    };
    const timer = setTimeout(() => {
      killGroup();
      finish(new Error(`nsenter ${cmd}: timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout?.on('data', (d: Buffer) => {
      if (settled) return;
      stdout += d.toString('utf-8');
      if (stdout.length > SAFE_NSENTER_MAX_BUFFER_BYTES) {
        killGroup();
        finish(new Error(`nsenter ${cmd}: stdout exceeded ${SAFE_NSENTER_MAX_BUFFER_BYTES} bytes`));
      }
    });
    child.stderr?.on('data', (d: Buffer) => { if (!settled) stderr += d.toString('utf-8'); });
    child.on('error', (err) => finish(err));
    child.on('close', (code) => {
      if (code === 0) finish(null);
      else finish(Object.assign(new Error(`nsenter ${cmd} exited with code ${code}: ${stderr.trim() || stdout.trim()}`), { code }));
    });
  });
}
