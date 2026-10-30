import { Router } from 'express';
import type pino from 'pino';
import type { IHostExecutor } from '../../domain/interfaces/host-executor';

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
   * An OPTIONAL SASBench checkout on the host (SASBENCH_DIR). Nothing
   * requires it to exist — the sasbench service builds from a pinned remote
   * git context by default. When it is a real checkout, the SAS page reports
   * commit-level detail from it.
   */
  dir: string;
  /**
   * What the sasbench service builds from (SASBENCH_CONTEXT): by default a
   * remote git URL pinned to a commit, so a fresh host needs nothing cloned.
   * An operator developing SASBench can point it at a local path instead.
   */
  context: string;
}

/**
 * Split a build context into a repository and a ref, or return null when it
 * is a local path.
 *
 * A remote context is the default and is what makes `docker compose build`
 * work on a host with nothing cloned. Recognising it by "://" rather than by
 * trying to stat the path keeps this a pure function: it runs in the backend
 * container, where a HOST path would not resolve anyway.
 */
export function parseGitContext(context: string): { repo: string; ref: string } | null {
  const c = (context || '').trim();
  if (!c.includes('://')) return null;
  const hash = c.indexOf('#');
  if (hash < 0) return { repo: c, ref: 'HEAD' };
  // A git context ref may itself carry a subdirectory (ref:dir) — only the
  // part before the colon is the ref.
  const frag = c.slice(hash + 1);
  return { repo: c.slice(0, hash), ref: (frag.split(':')[0] || 'HEAD') };
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
  /** The NMS can rebuild SASBench from here. */
  managed: boolean;
  dir: string;
  /**
   * Where the running SASBench came from. 'pinned' is the default: the image
   * is built from a remote git context pinned to a commit by this release,
   * so there is no checkout to be behind or dirty. 'checkout' is the older
   * shape, still supported when SASBENCH_CONTEXT names a local path.
   */
  source?: 'pinned' | 'checkout';
  /** 'pinned' only: the repository and commit the stack builds from. */
  repoUrl?: string;
  pinnedRef?: string;
  /** 'pinned' only: false when upstream has moved past the pinned ref. */
  upToDate?: boolean;
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

/**
 * The default shape: the image is built from a remote git context pinned to a
 * commit, so "what is installed" is that pin and the only question is whether
 * upstream has moved past it.
 *
 * Answered with `git ls-remote`, which needs no checkout, no clone and no
 * credentials (SASBench is public) — so this works on a host where nothing
 * has ever been cloned, which is the whole point of the pinned context.
 */
async function readPinnedVersion(
  cfg: SasBenchConfig,
  host: IHostExecutor,
  parsed: { repo: string; ref: string },
  opts: { fetch: boolean },
): Promise<SasBenchVersion> {
  const v: SasBenchVersion = {
    managed: true,
    source: 'pinned',
    dir: cfg.dir,
    repoUrl: parsed.repo,
    pinnedRef: parsed.ref,
    remoteUrl: parsed.repo,
    localCommit: /^[0-9a-f]{7,40}$/i.test(parsed.ref) ? parsed.ref.slice(0, 7) : parsed.ref,
    fetchedAt: lastFetchOkAt ? new Date(lastFetchOkAt).toISOString() : null,
  };

  if (!opts.fetch) return v;

  lastFetchAt = Date.now();
  // HEAD of the default branch: the pin is a commit, so there is no tracking
  // branch to ask and the comparison is pin-vs-upstream-tip.
  const r = await host
    .executeCommand('git', ['ls-remote', parsed.repo, 'HEAD'], 60000, { expectedFailure: true })
    .catch(() => null);
  if (!r || r.exitCode !== 0) {
    lastFetchError = ((r?.stderr || r?.stdout || 'git ls-remote failed') as string).trim().slice(0, 300);
    v.fetchError = lastFetchError;
    return v;
  }
  lastFetchOkAt = lastFetchAt;
  lastFetchError = null;
  v.fetchedAt = new Date(lastFetchOkAt).toISOString();

  const upstream = (r.stdout || '').trim().split(/\s+/)[0] || '';
  if (!/^[0-9a-f]{40}$/i.test(upstream)) {
    v.reason = 'Could not read the upstream commit from git ls-remote.';
    return v;
  }
  v.upstreamCommit = upstream.slice(0, 7);
  // Compare full against full when the pin is a full SHA; otherwise the pin
  // is a branch/tag name and "up to date" is not a question this can answer.
  if (/^[0-9a-f]{40}$/i.test(parsed.ref)) {
    v.upToDate = parsed.ref.toLowerCase() === upstream.toLowerCase();
  } else {
    v.reason = `Pinned to "${parsed.ref}" rather than a commit, so the exact revision follows upstream.`;
  }
  return v;
}

async function readVersion(
  cfg: SasBenchConfig,
  host: IHostExecutor,
  opts: { fetch: boolean },
): Promise<SasBenchVersion> {
  // A remote context is the default, and then there is no local checkout to
  // inspect — asking git about one would report a missing directory as a
  // fault on a perfectly healthy deployment.
  const parsed = parseGitContext(cfg.context);
  if (parsed) return readPinnedVersion(cfg, host, parsed, opts);

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

export function createSasRouter(
  cfg: SasBenchConfig,
  logger: pino.Logger,
  hostExecutor: IHostExecutor,
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


  return router;
}
