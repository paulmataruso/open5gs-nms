import { useCallback, useEffect, useState, type JSX } from 'react';
import {
  Shield, ExternalLink, RefreshCw, AlertTriangle, Radio, Signal, Activity,
  Download, GitBranch, CheckCircle2, BarChart3, Lock,
} from 'lucide-react';
import {
  sasApi, sasbenchUiUrl,
  type SasStatus, type SasCbsd, type SasGrant, type SasListener, type SasBenchVersion,
  type SasSpectrum,
} from '../api/sas';
import { BandOccupancy } from '../components/sas/BandOccupancy';
import { ConfirmModal } from '../components/common/ConfirmModal';
import toast from 'react-hot-toast';

// ── CBRS SAS ────────────────────────────────────────────────────────────────
// A status view of SASBench, which IS the SAS on this deployment: it runs as
// its own container and binds the SAS-CBSD protocol ports directly, so radios
// connect to it and nothing in this NMS sits in the protocol path.
//
// This page is deliberately read-only about SAS *state*. Everything that
// changes it — registrations, grants, spectrum, PKI, fault injection,
// settings — lives in SASBench's own admin UI, linked from the header.
// Rebuilding any of that here would mean two consoles disagreeing about one
// system's state.
//
// The one thing the NMS does own is SASBench's own software: it tracks the
// upstream checkout, says when it is behind and applies the update itself, so
// keeping the SAS current never means shelling onto the host. That is an
// explicit button and not automatic, because applying it recreates the
// container and the SAS listeners drop while it restarts.

/**
 * Why an update cannot (or need not) run, or null when there is genuinely
 * something to apply. These mirror the refusals POST /api/sas/update makes
 * server-side — the backend stays the authority, this just says why before
 * taking the SAS listeners down for nothing.
 */
function updateBlockReason(v: SasBenchVersion): string | null {
  if (!v.managed) {
    return v.reason ?? 'SASBENCH_DIR is not a git checkout, so there is no upstream to update from.';
  }
  if (v.fetchError) {
    return `Could not reach the git remote, so there is nothing reliable to compare against: ${v.fetchError}`;
  }
  if (v.dirty) {
    return 'The checkout has uncommitted local changes — updating would discard them. Resolve them on the host first.';
  }
  if (v.ahead) {
    return `The checkout has ${v.ahead} local commit${v.ahead === 1 ? '' : 's'} that are not upstream, so an update would not be a fast-forward. Reconcile it by hand.`;
  }
  if (!v.behind) {
    return `Already up to date with ${v.branch ?? 'upstream'}${v.localCommit ? ` (${v.localCommit})` : ''}.`;
  }
  return null;
}

const MHz = (hz: number) => (hz / 1e6).toFixed(1);

function ago(ts: number | null | undefined): string {
  if (!ts) return '—';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 0) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function uptime(startedAt: number | undefined, now: number | undefined): string {
  if (!startedAt) return '—';
  const s = Math.floor(((now ?? Date.now()) - startedAt) / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

function StatCard({ label, value, hint, tone = 'default' }: {
  label: string; value: string | number; hint?: string;
  tone?: 'default' | 'good' | 'warn' | 'bad';
}): JSX.Element {
  const toneClass =
    tone === 'good' ? 'text-nms-green' :
    tone === 'warn' ? 'text-nms-amber' :
    tone === 'bad' ? 'text-nms-red' : 'text-nms-text';
  return (
    <div className="nms-card">
      <p className="text-xs text-nms-text-dim uppercase tracking-wider">{label}</p>
      <p className={`text-2xl font-semibold font-display mt-1 ${toneClass}`}>{value}</p>
      {hint && <p className="text-xs text-nms-text-dim mt-1">{hint}</p>}
    </div>
  );
}

function ListenerRow({ name, l, extra }: { name: string; l?: SasListener; extra?: string }): JSX.Element {
  // "enabled but not listening" is the state worth seeing: it means the port
  // was wanted and could not be bound, which is almost always a collision
  // with something else on the host rather than a SASBench fault.
  const bad = !!l && l.enabled && !l.listening;
  return (
    <div className="flex items-center justify-between py-2 border-b border-nms-border last:border-0">
      <div className="flex items-center gap-2">
        <span
          className={
            !l || !l.enabled ? 'status-dot bg-nms-text-dim'
              : l.listening ? 'status-dot-active' : 'status-dot bg-nms-red'
          }
        />
        <span className="text-sm text-nms-text">{name}</span>
        {extra && <span className="text-xs text-nms-text-dim">{extra}</span>}
      </div>
      <div className="text-right">
        <span className="text-sm font-mono text-nms-text">
          {l ? (l.enabled ? `:${l.port}` : 'disabled') : '—'}
        </span>
        {bad && (
          <p className="text-xs text-nms-red mt-0.5">{l.error ?? 'not listening'}</p>
        )}
      </div>
    </div>
  );
}

export function SASPage(): JSX.Element {
  const [status, setStatus] = useState<SasStatus | null>(null);
  const [cbsds, setCbsds] = useState<SasCbsd[]>([]);
  const [grants, setGrants] = useState<SasGrant[]>([]);
  const [spectrum, setSpectrum] = useState<SasSpectrum | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [version, setVersion] = useState<SasBenchVersion | null>(null);
  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [updateLog, setUpdateLog] = useState('');
  const [confirmUpdate, setConfirmUpdate] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const s = await sasApi.getStatus();
      setStatus(s);
      if (s.reachable) {
        const [c, g, sp] = await Promise.all([
          sasApi.getCbsds(), sasApi.getGrants(), sasApi.getSpectrum(),
        ]);
        setCbsds(c.cbsds ?? []);
        setGrants(g.grants ?? []);
        setSpectrum(sp.reachable ? sp : null);
      } else {
        setCbsds([]);
        setGrants([]);
        setSpectrum(null);
      }
    } catch {
      setStatus({ reachable: false, uiPort: 8094, error: 'Could not reach the NMS backend' });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Cached-only on the poll path: sasApi.getVersion() without `refresh`
  // never contacts the git remote, so this page does not fetch GitHub every
  // 15 seconds. The button below is what refreshes upstream.
  const loadVersion = useCallback(async (refresh: boolean) => {
    if (refresh) setChecking(true);
    try {
      setVersion(await sasApi.getVersion(refresh));
    } catch {
      /* the card simply does not render; /status already covers "backend down" */
    } finally {
      if (refresh) setChecking(false);
    }
  }, []);

  useEffect(() => {
    void load();
    void loadVersion(false);
    const t = setInterval(() => void load(), 15000);
    return () => clearInterval(t);
  }, [load, loadVersion]);

  const runUpdate = useCallback(async () => {
    setUpdating(true);
    setUpdateLog('');
    try {
      await sasApi.update((chunk) => setUpdateLog((prev) => prev + chunk));
    } catch (err) {
      setUpdateLog((prev) => prev + `\n\u274c ${String(err)}`);
    } finally {
      setUpdating(false);
      // The container was just recreated, so everything on this page is stale.
      await loadVersion(false);
      await load();
    }
  }, [load, loadVersion]);

  /**
   * The header button. Contacts the git remote for the latest refs (a read,
   * so it needs no confirmation), then asks before applying, because applying
   * recreates the container and the SAS listeners drop while it restarts —
   * every live radio misses a heartbeat. When there is nothing to apply it
   * says so and stops, rather than rebuilding for no reason.
   */
  const checkThenUpdate = useCallback(async () => {
    setChecking(true);
    setUpdateLog('');
    try {
      const v = await sasApi.getVersion(true);
      setVersion(v);
      const blocked = updateBlockReason(v);
      if (blocked) {
        // "Already up to date" is the good outcome, not a failure.
        if (v.managed && !v.behind && !v.dirty && !v.ahead && !v.fetchError) toast.success(blocked);
        else toast.error(blocked);
        setUpdateLog(blocked + '\n');
        return;
      }
      setConfirmUpdate(true);
    } catch (err) {
      const msg = `Could not check for updates: ${String(err)}`;
      toast.error(msg);
      setUpdateLog(msg + '\n');
    } finally {
      setChecking(false);
    }
  }, []);

  const counts = status?.counts;
  const uiUrl = sasbenchUiUrl(status?.uiPort ?? 8094);
  const authorized = counts?.grantsByState?.AUTHORIZED ?? 0;
  const granted = counts?.grantsByState?.GRANTED ?? 0;
  const updateAvailable = !!version?.managed && !!version.behind && version.behind > 0;
  // Occupancy and the radio/grant breakdowns the NMS derives from the real
  // grant ranges; absent when SASBench answered /status but not /spectrum.
  const derived = status?.derived;
  const https = status?.listeners?.https;
  // SASBench reports the negotiated suites as one colon-separated string;
  // the list itself is long and belongs in SASBench's own TLS page, so the
  // count is what is useful at a glance here.
  const cipherCount = https?.ciphers ? https.ciphers.split(':').filter(Boolean).length : null;

  return (
    <div className="p-4 space-y-4 md:p-6 md:space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold font-display flex items-center gap-2">
            <Shield className="w-6 h-6 text-nms-accent" />
            CBRS SAS
          </h1>
          <p className="text-sm text-nms-text-dim mt-1">
            Spectrum Access System status, served by SASBench. Radios connect to SASBench
            directly — this page is read-only.
          </p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          {status && (
            <span
              className={`px-2.5 py-1 rounded-md text-xs font-medium border ${
                status.reachable
                  ? 'bg-nms-green/10 text-nms-green border-nms-green/30'
                  : 'bg-nms-red/10 text-nms-red border-nms-red/30'
              }`}
            >
              {status.reachable ? 'Online' : 'Unreachable'}
            </span>
          )}
          {status?.reachable && status.version && (
            <span className="px-2.5 py-1 rounded-md text-xs font-medium bg-nms-surface-2 text-nms-text border border-nms-border font-mono">
              SASBench {status.version}
            </span>
          )}
          {status?.profile && (
            <span className="px-2.5 py-1 rounded-md text-xs font-medium bg-nms-surface-2 text-nms-text-dim border border-nms-border">
              profile: {status.profile}
            </span>
          )}
          {updateAvailable && (
            <span className="px-2.5 py-1 rounded-md text-xs font-medium bg-nms-amber/10 text-nms-amber border border-nms-amber/30">
              update available
            </span>
          )}
          <button
            onClick={() => void load()}
            disabled={refreshing}
            className="nms-btn-ghost flex items-center gap-2"
            aria-label="Refresh SAS status"
          >
            <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
            Refresh
          </button>
          {/* Manual update. One click fetches upstream and applies it if there
              is anything new; the software card below is the same thing in two
              steps, for reading what is coming first. */}
          <button
            onClick={() => void checkThenUpdate()}
            disabled={checking || updating}
            className={`nms-btn-ghost flex items-center gap-2 ${updateAvailable ? 'text-nms-amber' : ''}`}
            title="Fetch the latest SASBench from GitHub and apply it if there is anything new"
          >
            <Download className={`w-4 h-4 ${updating ? 'animate-pulse' : checking ? 'animate-spin' : ''}`} />
            {updating ? 'Updating…' : checking ? 'Checking…' : 'Update SASBench'}
          </button>
          <a
            href={uiUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="nms-btn-primary flex items-center gap-2"
          >
            <ExternalLink className="w-4 h-4" />
            Open SASBench
          </a>
        </div>
      </div>

      {/* Unreachable */}
      {status && !status.reachable && (
        <div className="nms-card border-nms-red/40 bg-nms-red/5">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-nms-red shrink-0 mt-0.5" />
            <div className="min-w-0">
              <p className="text-sm font-medium text-nms-red">SASBench is not answering</p>
              <p className="text-sm text-nms-text-dim mt-1">
                No SAS is running, so radios cannot register, get grants or heartbeat.
                Existing grants stay valid on each radio only until its transmit expiry
                elapses.
              </p>
              {status.error && (
                <p className="text-xs font-mono text-nms-text-dim mt-2 break-all">
                  {status.httpStatus ? `HTTP ${status.httpStatus}: ` : ''}{status.error}
                </p>
              )}
              <p className="text-xs text-nms-text-dim mt-2">
                Check the container: <code className="text-nms-text">docker compose ps sasbench</code>
                {' · '}
                <code className="text-nms-text">docker compose logs -f sasbench</code>
              </p>
            </div>
          </div>
        </div>
      )}

      {/* SASBench software — the one thing the NMS updates itself */}
      {version && (
        <div className={`nms-card ${updateAvailable ? 'border-nms-amber/40' : ''}`}>
          <div className="flex items-start justify-between flex-wrap gap-3">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-nms-text flex items-center gap-2">
                <GitBranch className="w-4 h-4 text-nms-accent" />
                SASBench software
              </h2>
              <p className="text-xs text-nms-text-dim mt-1">
                This NMS keeps SASBench in step with upstream. Its source lives on the host
                at <code className="text-nms-text">{version.dir}</code>, outside this repository.
              </p>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <button
                onClick={() => void loadVersion(true)}
                disabled={checking || updating || !version.managed}
                className="nms-btn-ghost flex items-center gap-2"
              >
                <RefreshCw className={`w-4 h-4 ${checking ? 'animate-spin' : ''}`} />
                Check for updates
              </button>
              {updateAvailable && (
                <button
                  onClick={() => void runUpdate()}
                  disabled={updating || version.dirty || !!version.ahead}
                  className="nms-btn-primary flex items-center gap-2"
                >
                  <Download className={`w-4 h-4 ${updating ? 'animate-pulse' : ''}`} />
                  {updating ? 'Updating…' : `Update (${version.behind} commit${version.behind === 1 ? '' : 's'})`}
                </button>
              )}
            </div>
          </div>

          {/* Not a git checkout: its own state, never shown as "up to date". */}
          {!version.managed ? (
            <div className="mt-3 flex items-start gap-2 text-sm">
              <AlertTriangle className="w-4 h-4 text-nms-amber shrink-0 mt-0.5" />
              <p className="text-nms-text-dim">{version.reason}</p>
            </div>
          ) : (
            <>
              <dl className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-nms-text-dim">Running version</dt>
                  <dd className="text-nms-text font-mono">{version.runningVersion ?? '—'}</dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-nms-text-dim">Tracking</dt>
                  <dd className="text-nms-text font-mono text-right break-all">{version.branch ?? '—'}</dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-nms-text-dim">Installed commit</dt>
                  <dd className="text-nms-text font-mono">
                    {version.localCommit ?? '—'}
                    {version.localDate ? ` · ${new Date(version.localDate).toLocaleDateString()}` : ''}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-nms-text-dim">Last checked</dt>
                  <dd className="text-nms-text font-mono">
                    {version.fetchedAt ? ago(Date.parse(version.fetchedAt)) : 'not yet'}
                  </dd>
                </div>
              </dl>

              {updateAvailable ? (
                <div className="mt-3 pt-3 border-t border-nms-border space-y-1.5">
                  <p className="text-sm text-nms-amber">
                    {version.behind} new commit{version.behind === 1 ? '' : 's'} upstream
                    {version.upstreamCommit ? ` (latest ${version.upstreamCommit})` : ''}.
                  </p>
                  {version.upstreamSubject && (
                    <p className="text-xs text-nms-text-dim break-words">
                      <span className="uppercase tracking-wider">newest:</span>{' '}
                      <span className="text-nms-text">{version.upstreamSubject}</span>
                    </p>
                  )}
                  <p className="text-xs text-nms-text-dim">
                    Applying it pulls the new source, rebuilds the image and recreates the
                    container. The SAS HTTP and HTTPS listeners are down while it restarts,
                    so radios will miss a heartbeat — grants survive, but expect a brief gap.
                  </p>
                </div>
              ) : (
                <p className="mt-3 pt-3 border-t border-nms-border text-sm text-nms-green flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4" />
                  Up to date with {version.branch}.
                </p>
              )}

              {version.fetchError && (
                <p className="text-xs text-nms-amber mt-2 break-words">
                  Could not reach the git remote on the last check, so this comparison may be
                  out of date: <span className="font-mono text-nms-text">{version.fetchError}</span>
                </p>
              )}
              {version.dirty && (
                <p className="text-xs text-nms-amber mt-2">
                  The checkout has uncommitted local changes, so the NMS will not update it —
                  an update would discard them. Resolve them on the host first.
                </p>
              )}
              {!!version.ahead && (
                <p className="text-xs text-nms-amber mt-2">
                  The checkout has {version.ahead} local commit{version.ahead === 1 ? '' : 's'} that
                  are not upstream, so an update would not be a fast-forward. Reconcile it by hand.
                </p>
              )}
            </>
          )}

          {updateLog && (
            <pre
              className="mt-4 p-3 rounded-md bg-nms-surface-2 border border-nms-border text-[11px]
                         font-mono text-nms-text whitespace-pre-wrap break-words max-h-80 overflow-auto"
              aria-live="polite"
            >
              {updateLog}
            </pre>
          )}
        </div>
      )}

      <ConfirmModal
        open={confirmUpdate}
        title="Update SASBench?"
        message={
          `This pulls ${version?.behind ?? 0} new commit${version?.behind === 1 ? '' : 's'} from upstream, rebuilds the ` +
          'image and recreates the container. The SAS HTTP and HTTPS listeners are down while it ' +
          'restarts, so every radio misses a heartbeat — existing grants survive, but expect a brief gap.'
        }
        confirmLabel="Update now"
        onConfirm={() => { setConfirmUpdate(false); void runUpdate(); }}
        onCancel={() => setConfirmUpdate(false)}
      />

      {loading && !status && (
        <div className="nms-card text-sm text-nms-text-dim">Loading SAS status…</div>
      )}

      {status?.reachable && (
        <>
          {/* Counts */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard
              label="Registered CBSDs"
              value={counts?.cbsdsRegistered ?? 0}
              hint={
                derived
                  ? `${derived.radiosWithGrant} on air · ${derived.radiosIdle} idle`
                    + `${counts?.cbsdsPending ? ` · ${counts.cbsdsPending} pending` : ''}`
                  : counts
                    ? `${counts.cbsdsTotal} known${counts.cbsdsPending ? ` · ${counts.cbsdsPending} pending` : ''}`
                    : undefined
              }
            />
            <StatCard
              label="Authorized grants"
              value={authorized}
              tone={authorized > 0 ? 'good' : 'default'}
              hint={granted ? `${granted} granted, not yet transmitting` : 'radios cleared to transmit'}
            />
            {/* Band occupancy, not the sum of grant widths. SASBench's own
                authorizedMHz adds every grant up and so exceeds the band
                whenever GAA grants overlap — which is the normal case here.
                The headline is therefore the UNION, with the sum as context. */}
            <StatCard
              label="Band occupancy"
              value={derived ? `${derived.occupancy.occupancyPct.toFixed(0)}%` : `${(counts?.authorizedMHz ?? 0).toFixed(1)} MHz`}
              hint={
                derived
                  ? `${derived.occupancy.distinctMHz.toFixed(0)} of ${derived.occupancy.bandMHz.toFixed(0)} MHz in use`
                    + ` · ${derived.occupancy.grantedMHz.toFixed(0)} MHz granted`
                  : 'total across all live grants'
              }
            />
            <StatCard
              label="Errors (1h)"
              value={counts?.errorsLastHour ?? 0}
              tone={(counts?.errorsLastHour ?? 0) > 0 ? 'warn' : 'good'}
              hint={`${counts?.messagesLastHour ?? 0} messages in the last hour`}
            />
          </div>

          {/* Band occupancy — the same band plan SASBench's Spectrum page
              draws, from the same /api/v1/spectrum data, so the two cannot
              disagree about one band. */}
          <div className="nms-card">
            <div className="flex items-start justify-between flex-wrap gap-3 mb-3">
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-nms-text flex items-center gap-2">
                  <BarChart3 className="w-4 h-4 text-nms-accent" />
                  Band occupancy
                </h2>
                <p className="text-xs text-nms-text-dim mt-1">
                  Every live grant across the managed band, with GAA availability, PAL
                  channels and any active protection.
                </p>
              </div>
              {derived && (
                <div className="flex items-center gap-4 text-xs">
                  <div className="text-right">
                    <p className="text-nms-text-dim">In use</p>
                    <p className="font-mono text-nms-text">
                      {derived.occupancy.distinctMHz.toFixed(0)}/{derived.occupancy.bandMHz.toFixed(0)} MHz
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-nms-text-dim">Largest free block</p>
                    <p className="font-mono text-nms-text">
                      {derived.occupancy.largestGapMHz.toFixed(0)} MHz
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-nms-text-dim">Deepest overlap</p>
                    <p
                      className={`font-mono ${derived.occupancy.maxOverlap > 1 ? 'text-nms-amber' : 'text-nms-text'}`}
                    >
                      {derived.occupancy.maxOverlap} grant{derived.occupancy.maxOverlap === 1 ? '' : 's'}
                    </p>
                  </div>
                </div>
              )}
            </div>

            {spectrum?.band ? (
              <BandOccupancy
                band={spectrum.band}
                gaaRanges={spectrum.gaaRanges}
                protections={spectrum.protections}
                ppas={spectrum.ppas}
                grants={spectrum.grants}
                cbsds={spectrum.cbsds}
              />
            ) : (
              <p className="text-sm text-nms-text-dim py-6 text-center">
                Band plan unavailable — SASBench answered its status but not its
                spectrum overview.
              </p>
            )}

            {/* The number worth explaining rather than just printing: on GAA
                nothing stops two radios taking the same channel, so an overlap
                depth above 1 is a real co-channel contention reading, not an
                error. */}
            {derived && derived.occupancy.maxOverlap > 1 && (
              <p className="text-xs text-nms-text-dim mt-3 pt-3 border-t border-nms-border">
                Up to {derived.occupancy.maxOverlap} grants share one frequency.
                GAA spectrum is unprotected, so the SAS authorizes overlapping grants by
                design — the radios involved contend for the same channel.
                {derived.occupancy.grantedMHz > derived.occupancy.bandMHz && (
                  <>
                    {' '}That is also why {derived.occupancy.grantedMHz.toFixed(0)} MHz of
                    grants fit inside a {derived.occupancy.bandMHz.toFixed(0)} MHz band.
                  </>
                )}
              </p>
            )}
          </div>

          {/* Listeners + service */}
          <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6">
            <div className="nms-card">
              <h2 className="text-sm font-semibold text-nms-text flex items-center gap-2 mb-3">
                <Signal className="w-4 h-4 text-nms-accent" />
                Protocol listeners
              </h2>
              <ListenerRow name="SAS HTTP" l={status.listeners?.http} />
              <ListenerRow name="SAS HTTPS" l={status.listeners?.https} />
              {status.urls && status.urls.length > 0 && (
                <div className="mt-3 pt-3 border-t border-nms-border">
                  <p className="text-xs text-nms-text-dim uppercase tracking-wider mb-1.5">
                    Endpoints radios use
                  </p>
                  <ul className="space-y-1">
                    {status.urls.map((u) => (
                      <li key={u} className="text-xs font-mono text-nms-text break-all">{u}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            {/* TLS — what a radio actually has to satisfy to connect over
                HTTPS, which is the first thing to check when one can reach the
                port but never registers. clientAuth lives here rather than
                beside the listener: it is a policy, not a property of the
                socket. */}
            <div className="nms-card">
              <h2 className="text-sm font-semibold text-nms-text flex items-center gap-2 mb-3">
                <Lock className="w-4 h-4 text-nms-accent" />
                TLS
              </h2>
              {status.listeners?.https?.enabled ? (
                <>
                  <dl className="space-y-2 text-sm">
                    <div className="flex items-center justify-between gap-3">
                      <dt className="text-nms-text-dim">Client certificates</dt>
                      <dd className={`font-mono text-right ${
                        https?.clientAuth === 'require' ? 'text-nms-amber' : 'text-nms-text'
                      }`}>
                        {https?.clientAuth ?? '—'}
                      </dd>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <dt className="text-nms-text-dim">Protocol</dt>
                      <dd className="text-nms-text font-mono text-right">{https?.protocols ?? '—'}</dd>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <dt className="text-nms-text-dim">Cipher suites</dt>
                      <dd className="text-nms-text font-mono text-right">{cipherCount ?? '—'}</dd>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <dt className="text-nms-text-dim">Trust anchors</dt>
                      <dd className="text-nms-text font-mono text-right">{https?.trustAnchors ?? '—'}</dd>
                    </div>
                  </dl>
                  {https?.serverCerts && https.serverCerts.length > 0 && (
                    <div className="mt-3 pt-3 border-t border-nms-border">
                      <p className="text-xs text-nms-text-dim uppercase tracking-wider mb-1.5">
                        Server certificates
                      </p>
                      <ul className="space-y-1">
                        {https.serverCerts.map((c) => (
                          <li key={c} className="text-xs text-nms-text break-words">{c}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {https?.clientAuth === 'require' && (
                    <p className="text-xs text-nms-amber mt-3">
                      Mutual TLS is required, so a radio without a client certificate
                      SASBench trusts cannot register at all.
                    </p>
                  )}
                </>
              ) : (
                <p className="text-sm text-nms-text-dim">
                  The HTTPS listener is disabled, so radios can only reach the SAS over
                  plain HTTP.
                </p>
              )}
            </div>

            <div className="nms-card">
              <h2 className="text-sm font-semibold text-nms-text flex items-center gap-2 mb-3">
                <Activity className="w-4 h-4 text-nms-accent" />
                Service
              </h2>
              <dl className="space-y-2 text-sm">
                {[
                  ['Version', status.version ?? '—'],
                  ['Uptime', uptime(status.startedAt, status.now)],
                  ['Host', status.hostname ?? '—'],
                  ['Settings profile', status.profile ?? 'custom'],
                  ['Active protections', String(counts?.activeProtections ?? 0)],
                  ['PPAs', String(counts?.ppas ?? 0)],
                  ['Fault rules enabled', String(counts?.faultRules ?? 0)],
                  ['ESC', status.flags?.escConnected ? 'connected' : 'not connected'],
                  ['Terrain tiles', String(status.terrain?.tiles ?? 0)],
                  [
                    'Measurement reports',
                    [
                      status.triggers?.measInRegistration ? 'registration' : null,
                      status.triggers?.measInHeartbeat ? 'heartbeat' : null,
                    ].filter(Boolean).join(' + ') || 'not requested',
                  ],
                ].map(([k, v]) => (
                  <div key={k} className="flex items-center justify-between gap-3">
                    <dt className="text-nms-text-dim">{k}</dt>
                    <dd className="text-nms-text font-mono text-right break-all">{v}</dd>
                  </div>
                ))}
              </dl>
              {(counts?.faultRules ?? 0) > 0 && (
                <p className="text-xs text-nms-amber mt-3">
                  Fault injection is active — SASBench is deliberately returning
                  non-normal responses to some requests.
                </p>
              )}
            </div>
          </div>

          {/* Radios */}
          <div className="nms-card">
            <h2 className="text-sm font-semibold text-nms-text flex items-center gap-2 mb-3">
              <Radio className="w-4 h-4 text-nms-accent" />
              Radios <span className="text-nms-text-dim font-normal">({cbsds.length})</span>
            </h2>
            {cbsds.length === 0 ? (
              <p className="text-sm text-nms-text-dim">No CBSD has registered yet.</p>
            ) : (
              <div className="nms-table-wrap">
                <div className="nms-table-scroll">
                  <table className="w-full text-sm">
                    <thead className="bg-nms-surface-2">
                      <tr className="text-left text-xs text-nms-text-dim uppercase tracking-wider">
                        <th className="px-3 py-2 font-medium">FCC ID</th>
                        <th className="px-3 py-2 font-medium">Serial</th>
                        <th className="px-3 py-2 font-medium">State</th>
                        <th className="px-3 py-2 font-medium">Cat</th>
                        <th className="px-3 py-2 font-medium">Source</th>
                        <th className="px-3 py-2 font-medium">Grants</th>
                        <th className="px-3 py-2 font-medium">Last seen</th>
                      </tr>
                    </thead>
                    <tbody>
                      {cbsds.map((c) => {
                        const live = (c.grants?.AUTHORIZED ?? 0) + (c.grants?.GRANTED ?? 0);
                        return (
                          <tr key={c.cbsdId} className="border-t border-nms-border">
                            <td className="px-3 py-2 font-mono text-xs text-nms-text">{c.fccId}</td>
                            <td className="px-3 py-2 font-mono text-xs text-nms-text-dim">{c.serial}</td>
                            <td className="px-3 py-2">
                              <span
                                className={
                                  c.state === 'REGISTERED' ? 'text-nms-green'
                                    : c.state === 'PENDING' ? 'text-nms-amber' : 'text-nms-text-dim'
                                }
                              >
                                {c.state}
                              </span>
                            </td>
                            <td className="px-3 py-2 text-nms-text-dim">{c.category ?? '—'}</td>
                            <td className="px-3 py-2 font-mono text-xs text-nms-text-dim">
                              {c.remoteAddr ?? '—'}
                              {c.transport ? <span className="ml-1 opacity-60">{c.transport}</span> : null}
                            </td>
                            <td className="px-3 py-2 text-nms-text">{live || '—'}</td>
                            <td className="px-3 py-2 text-nms-text-dim">{ago(c.lastSeen)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>

          {/* Grants */}
          <div className="nms-card">
            <h2 className="text-sm font-semibold text-nms-text flex items-center gap-2 mb-3">
              <Signal className="w-4 h-4 text-nms-accent" />
              Live grants <span className="text-nms-text-dim font-normal">({grants.length})</span>
            </h2>
            {grants.length === 0 ? (
              <p className="text-sm text-nms-text-dim">No live grant. No radio is authorized to transmit.</p>
            ) : (
              <div className="nms-table-wrap">
                <div className="nms-table-scroll">
                  <table className="w-full text-sm">
                    <thead className="bg-nms-surface-2">
                      <tr className="text-left text-xs text-nms-text-dim uppercase tracking-wider">
                        <th className="px-3 py-2 font-medium">Serial</th>
                        <th className="px-3 py-2 font-medium">Frequency</th>
                        <th className="px-3 py-2 font-medium">BW</th>
                        <th className="px-3 py-2 font-medium">Max EIRP</th>
                        <th className="px-3 py-2 font-medium">Type</th>
                        <th className="px-3 py-2 font-medium">State</th>
                        <th className="px-3 py-2 font-medium">Heartbeat</th>
                      </tr>
                    </thead>
                    <tbody>
                      {grants.map((g) => (
                        <tr key={g.grantId} className="border-t border-nms-border">
                          <td className="px-3 py-2 font-mono text-xs text-nms-text">
                            {g.serial ?? g.cbsdId}
                          </td>
                          <td className="px-3 py-2 font-mono text-xs text-nms-text">
                            {MHz(g.low)}–{MHz(g.high)} MHz
                          </td>
                          <td className="px-3 py-2 text-nms-text-dim">
                            {MHz(g.high - g.low)} MHz
                          </td>
                          <td className="px-3 py-2 text-nms-text-dim">{g.maxEirp} dBm/MHz</td>
                          <td className="px-3 py-2 text-nms-text-dim">{g.channelType}</td>
                          <td className="px-3 py-2">
                            <span className={g.state === 'AUTHORIZED' ? 'text-nms-green' : 'text-nms-amber'}>
                              {g.state}
                            </span>
                            {g.suspended && <span className="ml-1 text-nms-red text-xs">suspended</span>}
                          </td>
                          <td className="px-3 py-2 text-nms-text-dim">
                            {ago(g.lastHeartbeat)}
                            <span className="ml-1 opacity-60 text-xs">/ {g.heartbeatInterval}s</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>

          <p className="text-xs text-nms-text-dim">
            Registrations, grants, spectrum, certificates, fault injection and settings are
            managed in SASBench's own console — <a href={uiUrl} target="_blank" rel="noopener noreferrer" className="text-nms-accent hover:underline">open it</a>.
          </p>
        </>
      )}
    </div>
  );
}
