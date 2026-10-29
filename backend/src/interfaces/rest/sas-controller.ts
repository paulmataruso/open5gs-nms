import { Router } from 'express';
import { spawn } from 'node:child_process';
import type pino from 'pino';
import { requireAdmin } from './middleware/auth-middleware';
import type { IHostExecutor } from '../../domain/interfaces/host-executor';
import type { IAuditLogger } from '../../domain/interfaces/audit-logger';

// ── CBRS SAS ────────────────────────────────────────────────────────────────
// This NMS does not implement a SAS. SASBench does, as its own container, and
// it owns the SAS-CBSD protocol ports (SAS_HTTP_PORT / SAS_HTTPS_PORT in .env)
// directly — no part of this deployment sits in front of it. Radios talk to
// SASBench; nothing here proxies, terminates TLS for, or rewrites that traffic.
//
// All this router does is read SASBench's public REST API (/api/v1) so the NMS
// can render a status page and the dashboard card. It is READ-ONLY by design:
// everything that changes SAS state belongs in SASBench's own admin UI, which
// the status page links to.
//
// SASBench credentials stay server-side. The browser never receives them — it
// only ever sees this router's own already-authenticated /api/sas routes.

export interface SasBenchConfig {
  /** Base URL of SASBench's UI/REST port, as reachable from the backend. */
  apiUrl: string;
  /** Real host port of SASBench's UI — what the browser is told to open. */
  uiPort: number;
  user: string;
  password: string;
  /**
   * SASBench's source checkout on the host (SASBENCH_DIR, the sasbench
   * service's build context). The NMS keeps this in step with upstream; it
   * is outside this repository on purpose — SASBench is proprietary and this
   * project is AGPL-3.0.
   */
  dir: string;
}

/**
 * One call into SASBench's REST API.
 *
 * SASBench answers HTTP Basic (see its api/v1/auth.ts: session | password |
 * token | open), so no API key has to be provisioned before the NMS can read
 * it — the admin account from SAS_ADMIN_PASSWORD is enough. A deployment
 * running SAS_AUTH=off ignores the header and answers anyway.
 */
async function sasbench(
  cfg: SasBenchConfig,
  path: string,
  timeoutMs = 5000,
): Promise<{ ok: true; data: any } | { ok: false; status: number; error: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${cfg.apiUrl}/api/v1${path}`, {
      signal: ctrl.signal,
      headers: {
        Accept: 'application/json',
        Authorization: `Basic ${Buffer.from(`${cfg.user}:${cfg.password}`).toString('base64')}`,
      },
    });
    // SASBench reports its own errors as JSON; keep the status so the UI can
    // tell "SASBench is down" (ECONNREFUSED below) from "it said no" (401/403).
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, status: res.status, error: body.slice(0, 500) || res.statusText };
    }
    return { ok: true, data: await res.json() };
  } catch (err: any) {
    const reason = err?.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : String(err?.message ?? err);
    return { ok: false, status: 0, error: reason };
  } finally {
    clearTimeout(timer);
  }
}



// ── Band occupancy ──────────────────────────────────────────────────────────
// SASBench reports `authorizedMHz` as the SUM of every live grant's width,
// which on a GAA deployment routinely exceeds the band itself: grants may
// overlap freely, so 9 grants totalling 200 MHz can sit inside a 150 MHz band.
// That number answers "how much spectrum did we hand out", not "how much of
// the band is in use", and presenting it as occupancy would be wrong.
//
// So the NMS derives both from the real grant ranges: the UNION (distinct
// spectrum actually in use) and the peak overlap depth (how many radios share
// the busiest frequency — the thing that actually predicts co-channel
// interference on GAA, where nothing is protected).

export interface SasOccupancy {
  bandLowHz: number;
  bandHighHz: number;
  bandMHz: number;
  /** Sum of grant widths, i.e. SASBench's own authorizedMHz. */
  grantedMHz: number;
  /** Union of grant ranges — distinct spectrum in use. Never exceeds bandMHz. */
  distinctMHz: number;
  /** distinctMHz as a percentage of the band. */
  occupancyPct: number;
  /** Most grants overlapping any single frequency. 1 = no co-channel sharing. */
  maxOverlap: number;
  /** Contiguous free run, the biggest block a new grant could take. */
  largestGapMHz: number;
  liveGrants: number;
}

/** Union length, peak overlap and largest free run of a set of ranges. */
function occupancyOf(
  ranges: Array<{ low: number; high: number }>,
  bandLow: number,
  bandHigh: number,
): { unionHz: number; maxOverlap: number; largestGapHz: number } {
  // Clip to the band first: a grant reaching outside it must not inflate the
  // union past the band width, which is what makes the percentage meaningful.
  const clipped = ranges
    .map((r) => ({ low: Math.max(Number(r.low), bandLow), high: Math.min(Number(r.high), bandHigh) }))
    .filter((r) => Number.isFinite(r.low) && Number.isFinite(r.high) && r.high > r.low)
    .sort((a, b) => a.low - b.low);

  // Merge overlapping and touching ranges into disjoint runs, then measure
  // both the runs (union) and the holes between them (gaps) off that one list.
  const merged: Array<{ low: number; high: number }> = [];
  for (const r of clipped) {
    const last = merged[merged.length - 1];
    if (last && r.low <= last.high) last.high = Math.max(last.high, r.high);
    else merged.push({ ...r });
  }

  const unionHz = merged.reduce((n, r) => n + (r.high - r.low), 0);

  let largestGapHz = 0;
  let edge = bandLow;
  for (const r of merged) {
    largestGapHz = Math.max(largestGapHz, r.low - edge);
    edge = r.high;
  }
  // Also the run from the last grant to the top of the band — and, when there
  // are no grants at all, this single step correctly yields the whole band.
  largestGapHz = Math.max(largestGapHz, bandHigh - edge);

  // Peak overlap: sweep the edges, +1 at each low, -1 at each high. Ends sort
  // before starts at the same frequency, so a grant ending exactly where the
  // next begins counts as adjacent rather than overlapping.
  const events = clipped
    .flatMap((r) => [[r.low, 1], [r.high, -1]] as Array<[number, number]>)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let depth = 0;
  let maxOverlap = 0;
  for (const [, delta] of events) {
    depth += delta;
    if (depth > maxOverlap) maxOverlap = depth;
  }

  return { unionHz, maxOverlap, largestGapHz };
}

/** Everything the status cards show beyond SASBench's own counts. */
export interface SasDerived {
  occupancy: SasOccupancy;
  /** Registered radios holding at least one live grant — actually on air. */
  radiosWithGrant: number;
  /** Registered radios with no live grant: attached to the SAS, not transmitting. */
  radiosIdle: number;
  /** Registered radios by FCC category. */
  byCategory: { A: number; B: number; unknown: number };
  /** Live grants by channel type. */
  byChannelType: Record<string, number>;
}

function deriveFrom(spectrum: any): SasDerived | null {
  const bandLow = Number(spectrum?.band?.low);
  const bandHigh = Number(spectrum?.band?.high);
  if (!Number.isFinite(bandLow) || !Number.isFinite(bandHigh) || bandHigh <= bandLow) return null;

  const grants: any[] = Array.isArray(spectrum.grants) ? spectrum.grants : [];
  const cbsds: any[] = Array.isArray(spectrum.cbsds) ? spectrum.cbsds : [];
  const { unionHz, maxOverlap, largestGapHz } = occupancyOf(grants, bandLow, bandHigh);
  const bandHz = bandHigh - bandLow;
  const grantedHz = grants.reduce((n, g) => n + Math.max(0, Number(g.high) - Number(g.low)), 0);

  const withGrant = new Set(grants.map((g) => g.cbsdId));
  const byCategory = { A: 0, B: 0, unknown: 0 };
  for (const c of cbsds) {
    if (c.category === 'A') byCategory.A++;
    else if (c.category === 'B') byCategory.B++;
    else byCategory.unknown++;
  }
  const byChannelType: Record<string, number> = {};
  for (const g of grants) {
    const t = typeof g.channelType === 'string' && g.channelType ? g.channelType : 'UNKNOWN';
    byChannelType[t] = (byChannelType[t] ?? 0) + 1;
  }

  return {
    occupancy: {
      bandLowHz: bandLow,
      bandHighHz: bandHigh,
      bandMHz: bandHz / 1e6,
      grantedMHz: grantedHz / 1e6,
      distinctMHz: unionHz / 1e6,
      occupancyPct: bandHz > 0 ? (unionHz / bandHz) * 100 : 0,
      maxOverlap,
      largestGapMHz: largestGapHz / 1e6,
      liveGrants: grants.length,
    },
    radiosWithGrant: cbsds.filter((c) => withGrant.has(c.cbsdId)).length,
    radiosIdle: cbsds.filter((c) => !withGrant.has(c.cbsdId)).length,
    byCategory,
    byChannelType,
  };
}

// ── Keeping SASBench current ────────────────────────────────────────────────
// SASBench is developed upstream, so this deployment tracks it rather than
// freezing a copy: the NMS reads the checkout's own git state, says when it is
// behind, and applies the update itself (pull -> rebuild the image -> recreate
// the container). An operator never has to shell onto the host for it.
//
// Applying an update RECREATES the sasbench container, so the SAS-CBSD
// listeners are down for as long as the new one takes to come up and live
// radios miss heartbeats across that gap. That is why this is an explicit,
// admin-only action and not something a status poll can trigger.
//
// SASBENCH_DIR is outside this repository on purpose — SASBench is proprietary
// and this project is AGPL-3.0, so its source is never vendored in. A
// deployment whose SASBENCH_DIR is an unpacked tarball rather than a git
// checkout reports `managed: false`, which the UI must show as its own state:
// "cannot be updated from here", never "up to date".

export interface SasBenchVersion {
  /** SASBENCH_DIR is a git checkout with a remote, so the NMS can update it. */
  managed: boolean;
  dir: string;
  /** Why it is not managed, or why `behind` could not be determined. */
  reason?: string;
  remoteUrl?: string;
  branch?: string;
  localCommit?: string;
  localDate?: string;
  localSubject?: string;
  upstreamCommit?: string;
  upstreamDate?: string;
  upstreamSubject?: string;
  /** Commits on the tracked upstream branch that this checkout does not have. */
  behind?: number;
  /** Local commits not upstream — a pull would not be a fast-forward. */
  ahead?: number;
  /** Uncommitted local changes, which an update must not silently discard. */
  dirty?: boolean;
  /** ISO time upstream refs were last fetched SUCCESSFULLY, else null. */
  fetchedAt?: string | null;
  /**
   * Why the last fetch failed. `behind` then describes the last refs that were
   * successfully fetched, which may be stale — so the UI must show this rather
   * than presenting a cached "up to date" as current.
   */
  fetchError?: string;
  /** The version SASBench itself reports, when it is reachable. */
  runningVersion?: string;
}

/**
 * Refreshing upstream refs is a network call to the git remote, so it is NOT
 * done on the status path: the SAS page polls every 15 s, which would mean
 * four fetches a minute forever. The cached refs answer every read; a fetch
 * happens when the operator asks, or at most once per this interval.
 */
const FETCH_TTL_MS = 30 * 60 * 1000;
/**
 * Last fetch ATTEMPT, success or not. The TTL is keyed off the attempt on
 * purpose: if it keyed off success, a remote that is unreachable (no route
 * out, GitHub down, credentials gone) would be retried on every single
 * 15-second poll forever, which is exactly the hammering the TTL exists to
 * prevent — and the failure case is the one where retrying helps least.
 */
let lastFetchAt = 0;
/**
 * Floor between fetches even when one is explicitly asked for. "Check for
 * updates" is a button a person clicks, so a 30 s floor is invisible to real
 * use — but without it any signed-in user (not just an admin: /version is a
 * read) could drive one git fetch per request by repeating ?refresh=1.
 */
const MIN_FETCH_INTERVAL_MS = 30 * 1000;
/** Last fetch that actually succeeded — what `fetchedAt` reports. */
let lastFetchOkAt = 0;
/** Why the last fetch failed, so the page can say so instead of going quiet. */
let lastFetchError: string | null = null;

/** One update at a time — two concurrent builds of the same image race. */
let updateInFlight = false;

async function readVersion(
  cfg: SasBenchConfig,
  host: IHostExecutor,
  opts: { fetch: boolean },
): Promise<SasBenchVersion> {
  const dir = cfg.dir;
  const git = (args: string[]) =>
    host.executeCommand('git', ['-C', dir, ...args], 60000, { expectedFailure: true });
  const out = async (args: string[]): Promise<string | null> => {
    const r = await git(args).catch(() => null);
    return r && r.exitCode === 0 ? r.stdout.trim() : null;
  };

  const inside = await out(['rev-parse', '--is-inside-work-tree']);
  if (inside !== 'true') {
    return {
      managed: false,
      dir,
      reason: `${dir} is not a git checkout, so the NMS cannot update it. Replace it with one: `
        + `git clone https://github.com/paulmataruso/SASBench.git ${dir}`,
    };
  }

  const remoteUrl = (await out(['remote', 'get-url', 'origin'])) ?? undefined;
  if (!remoteUrl) {
    return { managed: false, dir, reason: `${dir} is a git checkout with no "origin" remote to update from.` };
  }

  if (opts.fetch) {
    // --prune so a deleted upstream branch does not leave a stale ref that
    // makes @{u} resolve to something that no longer exists.
    lastFetchAt = Date.now();
    const f = await git(['fetch', '--prune', '--quiet', 'origin']);
    if (f.exitCode === 0) {
      lastFetchOkAt = lastFetchAt;
      lastFetchError = null;
    } else {
      lastFetchError = (f.stderr || f.stdout || `git fetch exited ${f.exitCode}`).trim().slice(0, 300);
    }
  }

  const branch = (await out(['rev-parse', '--abbrev-ref', 'HEAD'])) ?? undefined;
  const [localCommit, localDate, localSubject] = (
    (await out(['log', '-1', '--format=%h%x1f%cI%x1f%s'])) ?? ''
  ).split('\x1f');

  const v: SasBenchVersion = {
    managed: true,
    dir,
    remoteUrl,
    branch,
    localCommit: localCommit || undefined,
    localDate: localDate || undefined,
    localSubject: localSubject || undefined,
    dirty: (await out(['status', '--porcelain'])) !== '',
    fetchedAt: lastFetchOkAt ? new Date(lastFetchOkAt).toISOString() : null,
    fetchError: lastFetchError ?? undefined,
  };

  // @{u} is the tracked upstream branch. A checkout made by `git clone` has
  // one; a detached HEAD or a hand-made branch may not, and that is reported
  // rather than guessed at.
  const upstream = await out(['rev-parse', '--abbrev-ref', '@{u}']);
  if (!upstream) {
    v.reason = `${branch ?? 'HEAD'} tracks no upstream branch, so there is nothing to compare against.`;
    return v;
  }

  const [up, upDate, upSubject] = (
    (await out(['log', '-1', '--format=%h%x1f%cI%x1f%s', '@{u}'])) ?? ''
  ).split('\x1f');
  v.upstreamCommit = up || undefined;
  v.upstreamDate = upDate || undefined;
  v.upstreamSubject = upSubject || undefined;

  // One call gives both directions: "<behind>\t<ahead>" relative to upstream.
  const counts = await out(['rev-list', '--left-right', '--count', `${upstream}...HEAD`]);
  if (counts) {
    const [behind, ahead] = counts.split(/\s+/).map((n) => parseInt(n, 10));
    if (Number.isFinite(behind)) v.behind = behind;
    if (Number.isFinite(ahead)) v.ahead = ahead;
  }

  return v;
}

/** The directory `docker compose` must run from — the NMS's own project. */
async function composeDir(host: IHostExecutor): Promise<string | null> {
  try {
    const r = await host.executeLocalCommand('docker', [
      'inspect', 'open5gs-nms-backend', '--format',
      '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}',
    ]);
    const dir = r.stdout.trim();
    return r.exitCode === 0 && dir && dir !== '<no value>' ? dir : null;
  } catch {
    return null;
  }
}

export function createSasRouter(
  cfg: SasBenchConfig,
  logger: pino.Logger,
  hostExecutor: IHostExecutor,
  auditLogger: IAuditLogger,
): Router {
  const router = Router();

  // Status for both the SAS page and the dashboard card. `reachable: false`
  // is a normal answer, not a 5xx — SASBench being down is exactly the thing
  // this card exists to show, so the UI always gets a usable body.
  router.get('/status', async (_req, res) => {
    const r = await sasbench(cfg, '/status');
    if (!r.ok) {
      logger.debug({ error: r.error, status: r.status }, 'SASBench status unavailable');
      return res.json({
        reachable: false,
        error: r.error,
        httpStatus: r.status || undefined,
        uiPort: cfg.uiPort,
      });
    }
    // Real band occupancy, which SASBench's own counts cannot express: its
    // `authorizedMHz` sums grant widths and so exceeds the band whenever GAA
    // grants overlap (9 grants / 200 MHz inside a 150 MHz band, live). The
    // union and the peak overlap depth are computed here from the real grant
    // ranges. A failure to read /spectrum is not a failure of /status — the
    // cards drop the extra detail and keep every count they already had.
    let derived: SasDerived | null = null;
    const sp = await sasbench(cfg, '/spectrum');
    if (sp.ok) derived = deriveFrom(sp.data);
    else logger.debug({ error: sp.error }, 'SASBench spectrum unavailable; status served without occupancy');

    res.json({ reachable: true, uiPort: cfg.uiPort, ...r.data, derived: derived ?? undefined });
  });

  // Registered radios, as SASBench sees them. Its list endpoints answer
  // { items, total, limit, offset } (api/v1/routes/common.ts sqlPage).
  router.get('/cbsds', async (_req, res) => {
    const r = await sasbench(cfg, '/cbsds?limit=200');
    if (!r.ok) return res.json({ reachable: false, error: r.error, cbsds: [], total: 0 });
    res.json({ reachable: true, cbsds: r.data?.items ?? [], total: r.data?.total ?? 0 });
  });

  // Live grants only. SASBench keeps ended grants (TERMINATED/RELINQUISHED/
  // EXPIRED/DELETED) in the same table until purged, so filter server-side
  // rather than render an ever-growing history on a status page.
  router.get('/grants', async (_req, res) => {
    const r = await sasbench(cfg, '/grants?state=GRANTED,AUTHORIZED&limit=200');
    if (!r.ok) return res.json({ reachable: false, error: r.error, grants: [], total: 0 });
    res.json({ reachable: true, grants: r.data?.items ?? [], total: r.data?.total ?? 0 });
  });

  // Everything the band-occupancy chart draws: the managed band, GAA ranges,
  // PAL/PPA channels, protections, live grants and the registered radios they
  // belong to. Passed through nearly as-is — the chart needs the real ranges,
  // and reshaping them here would only mean two places to keep in step with
  // SASBench's own Spectrum page.
  router.get('/spectrum', async (_req, res) => {
    const r = await sasbench(cfg, '/spectrum', 8000);
    if (!r.ok) return res.json({ reachable: false, error: r.error });
    const d = r.data ?? {};
    res.json({
      reachable: true,
      band: d.band ?? null,
      gaaRanges: d.gaaRanges ?? [],
      protections: d.protections ?? [],
      ppas: d.ppas ?? [],
      grants: d.grants ?? [],
      cbsds: d.cbsds ?? [],
      derived: deriveFrom(d) ?? undefined,
    });
  });

  // ── Version / updates ─────────────────────────────────────────────────────

  // What is installed, and whether upstream has moved on. Safe to poll: it
  // only refreshes upstream refs when they are older than FETCH_TTL_MS, or
  // when asked with ?refresh=1 (what the UI's "Check for updates" sends).
  router.get('/version', async (req, res) => {
    const forced = req.query.refresh === '1' || req.query.refresh === 'true';
    const sinceFetch = Date.now() - lastFetchAt;
    const doFetch = sinceFetch > FETCH_TTL_MS || (forced && sinceFetch > MIN_FETCH_INTERVAL_MS);
    try {
      const v = await readVersion(cfg, hostExecutor, { fetch: doFetch });
      // The version SASBench reports about itself, so the page can show what
      // is actually running next to what the checkout says.
      const h = await sasbench(cfg, '/health', 3000);
      if (h.ok && typeof h.data?.version === 'string') v.runningVersion = h.data.version;
      res.json(v);
    } catch (err: any) {
      logger.error({ err }, 'Reading the SASBench version failed');
      res.status(500).json({ managed: false, dir: cfg.dir, reason: String(err?.message ?? err) });
    }
  });

  // Apply an upstream update: pull, rebuild the image, recreate the container.
  //
  // Streams its output (chunked) the same way every other long-running action
  // in this NMS does — a real build takes well over nginx's generic 120 s
  // /api/ read timeout, so this path needs its own location block in
  // nginx.conf (see CLAUDE.md pattern #5).
  //
  // Deliberately NOT killed when the browser disconnects: a half-finished
  // `docker compose build` leaves a worse state than one that runs to
  // completion, and the final `up -d` is idempotent.
  router.post('/update', requireAdmin, async (req, res) => {
    const user = (req as any).user?.username ?? 'unknown';
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();
    const write = (t: string) => { res.write(t.endsWith('\n') ? t : t + '\n'); };

    const fail = async (msg: string) => {
      write(`\n❌ ${msg}`);
      await auditLogger.log({ action: 'sasbench_update', user, details: msg, success: false }).catch(() => {});
      res.end();
    };

    if (updateInFlight) return fail('A SASBench update is already running. Wait for it to finish.');
    updateInFlight = true;
    try {
      // Force a real fetch: this path must decide on current refs, never on
      // whatever the status poll last cached.
      lastFetchAt = 0;
      const v = await readVersion(cfg, hostExecutor, { fetch: true });
      if (!v.managed) return await fail(v.reason ?? `${cfg.dir} cannot be updated from here.`);
      if (v.fetchError) return await fail(`Could not reach the git remote: ${v.fetchError}`);

      // Local edits to a proprietary upstream checkout are never discarded
      // silently — the operator put them there on purpose or has a problem
      // worth seeing, and either way a --ff-only pull would just fail later.
      if (v.dirty) {
        return await fail(
          `${cfg.dir} has uncommitted local changes. Commit, stash or revert them first `
          + `(git -C ${cfg.dir} status), then run the update again.`,
        );
      }
      if (v.ahead) {
        return await fail(
          `${cfg.dir} has ${v.ahead} local commit(s) not in ${v.branch ?? 'upstream'}, so the update `
          + `would not be a fast-forward. Reconcile it by hand first.`,
        );
      }
      if (!v.behind) {
        write(`Already current: ${v.localCommit} ${v.localSubject ?? ''}`);
        write('Nothing to update.');
        await auditLogger.log({ action: 'sasbench_update', user, details: 'already current', success: true }).catch(() => {});
        return res.end();
      }

      const dir = await composeDir(hostExecutor);
      if (!dir) {
        return await fail(
          'Could not resolve this deployment\'s compose project directory, so the image cannot be '
          + 'rebuilt. Update by hand: git -C ' + cfg.dir + ' pull && docker compose build sasbench '
          + '&& docker compose up -d sasbench',
        );
      }

      write(`SASBench update: ${v.behind} commit(s) behind ${v.branch} (${v.localCommit} -> ${v.upstreamCommit})`);
      write(`Checkout: ${cfg.dir}    Compose project: ${dir}`);
      write('Recreating the container drops the SAS protocol listeners briefly; radios will miss a heartbeat.\n');

      const script = [
        'set -o pipefail',
        `cd ${JSON.stringify(cfg.dir)} || exit 1`,
        'echo "=== Pulling SASBench ==="',
        'git merge --ff-only "@{u}" || exit 1',
        'git log -1 --format="Now at %h %ci %s" || exit 1',
        'echo',
        'echo "=== Rebuilding the sasbench image ==="',
        `cd ${JSON.stringify(dir)} || exit 1`,
        'docker compose build sasbench || exit 1',
        'echo',
        'echo "=== Recreating the sasbench container ==="',
        'docker compose up -d sasbench || exit 1',
      ].join('\n');

      // detached so nsenter leads its own process group (CLAUDE.md pattern
      // #20: nsenter -p forks internally, so the direct child is not the
      // process doing the work).
      const code = await new Promise<number>((resolve) => {
        const child = spawn('nsenter', ['-t', '1', '-m', '-u', '-i', '-p', '--', 'bash', '-c', script], {
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true,
        });
        child.stdout.on('data', (d: Buffer) => write(d.toString()));
        child.stderr.on('data', (d: Buffer) => write(d.toString()));
        child.on('close', (c) => resolve(c ?? 1));
        child.on('error', (e) => { write(String(e)); resolve(1); });
      });

      if (code !== 0) return await fail(`Update failed (exit ${code}). The previous image is still in place.`);

      // "compose up -d returned 0" is not "the SAS is serving again" — wait
      // for SASBench's own health endpoint to report both listeners back up
      // before calling this done (CLAUDE.md: verify, don't trust success).
      write('\n=== Waiting for SASBench to come back ===');
      let healthy: any = null;
      for (let i = 0; i < 30; i++) {
        const h = await sasbench(cfg, '/health', 3000);
        if (h.ok && h.data?.status === 'ok' && h.data?.listeners?.http !== undefined) { healthy = h.data; break; }
        await new Promise((r) => setTimeout(r, 2000));
      }
      if (!healthy) {
        return await fail(
          'SASBench did not report healthy within 60 s. Check: docker logs sasbench',
        );
      }

      const after = await readVersion(cfg, hostExecutor, { fetch: false });
      write(`SASBench ${healthy.version} is up — SAS HTTP ${healthy.listeners.http ? 'listening' : 'DOWN'}, `
        + `SAS HTTPS ${healthy.listeners.https ? 'listening' : 'DOWN'}`);
      write(`Now at ${after.localCommit} ${after.localSubject ?? ''}`);
      write('\n✅ Update applied.');
      await auditLogger.log({
        action: 'sasbench_update', user, success: true,
        details: `${v.localCommit} -> ${after.localCommit} (${v.behind} commits)`,
      }).catch(() => {});
      res.end();
    } catch (err: any) {
      await fail(String(err?.message ?? err));
    } finally {
      updateInFlight = false;
    }
  });

  return router;
}
