import * as fs from 'fs';
import * as path from 'path';
import { Db } from 'mongodb';
import pino from 'pino';
import mysql from 'mysql2/promise';
import { ISubscriberRepository } from '../../../domain/interfaces/subscriber-repository';
import { Subscriber } from '../../../domain/entities/subscriber';
import { CdrDisposition, CdrDocument, CdrParty, CdrSourceInstance, CdrSourceSystem, upsertCdr } from './cdr-store';

// ── CDR sync — tails real Asterisk CDR CSVs + Kamailio's own acc DB ───────
//
// Phase 1/2: Asterisk's own cdr_csv output (PSTN Gateway, Asterisk-2G) — no
// nsenter/subprocess needed, same direct /proc/1/root read ImsCallStatsMonitor
// uses for its own state file.
// Phase 3: Kamailio's own `acc`/`missed_calls` DB tables (direct 4G/5G
// IMS-to-IMS calls, the one source with no B2BUA CDR of its own) — read via
// a direct TCP connection to the host's MariaDB (backend runs
// network_mode: host, so 127.0.0.1:3306 here IS the real host's MariaDB;
// see SCSCF_DB_CONFIG below).
//
// Polls every 20s (CDRs aren't as latency-sensitive as ImsCallStatsMonitor's
// 5s live-call-count polling) and persists a per-source cursor (Asterisk:
// byte offset; Kamailio: last-seen auto-increment id) so a backend restart
// resumes where it left off rather than re-scanning from the start of a CSV
// that only ever grows / re-processing already-synced DB rows. Confirmed
// live that Asterisk's own Master.csv is never logrotated on this host, but
// the tailer still defensively treats "file shrank since last read" as a
// rotation signal and resets to offset 0, in case that ever changes.

const SYNC_INTERVAL_MS = 20_000;
const STATE_FILE = '/proc/1/root/etc/open5gs/.cdr-sync-state.json';

interface AsteriskCsvSource {
  instance: CdrSourceInstance;
  sourceSystem: CdrSourceSystem;
  csvPath: string;
}

const ASTERISK_SOURCES: AsteriskCsvSource[] = [
  { instance: 'pstn', sourceSystem: 'pstn', csvPath: '/proc/1/root/var/log/asterisk/cdr-csv/Master.csv' },
  { instance: 'asterisk2g', sourceSystem: '2g', csvPath: '/proc/1/root/var/log/asterisk-2g/cdr-csv/Master.csv' },
];

interface SyncState {
  offsets: Record<string, number>;
  kamailioAccId?: number;
  kamailioMissedId?: number;
}

// ── Kamailio acc/missed_calls (Phase 3) ───────────────────────────────────
//
// Same loopback-only MariaDB credential DB_URL in ims-controller.ts's
// scscfIncludeCfg() already uses — not a new secret, just duplicated here to
// avoid an awkward cross-module export for a two-field constant. Only
// queried at all when setCdrAccountingEnabled()'s own toggle (checked via
// the same IMS state file that controller reads/writes) is on, so this is a
// zero-cost no-op on every deployment that hasn't enabled it.
const HOST_IMS_STATE = '/proc/1/root/etc/open5gs/.ims-config.json';
const SCSCF_DB_CONFIG = {
  host: '127.0.0.1',
  port: 3306,
  user: 'scscf',
  password: 'heslo',
  database: 'scscf',
  // Return DATETIME columns as raw "YYYY-MM-DD HH:mm:ss" strings rather than
  // mysql2's own JS-Date conversion (which applies the Node process's local
  // TZ, not necessarily matching MariaDB's) -- parsed the same explicit-UTC
  // way as parseAsteriskTimestamp() below. Confirmed live 2026-09-17 this
  // host's MariaDB time_zone is SYSTEM == Etc/UTC, same as parseAsteriskTimestamp's
  // own assumption for cdr.conf's usegmtime=yes.
  dateStrings: true as const,
};

let scscfDbPool: mysql.Pool | null = null;
function getScscfDbPool(): mysql.Pool {
  if (!scscfDbPool) scscfDbPool = mysql.createPool({ ...SCSCF_DB_CONFIG, connectionLimit: 2 });
  return scscfDbPool;
}

export async function closeScscfDbPool(): Promise<void> {
  if (scscfDbPool) {
    await scscfDbPool.end().catch(() => {});
    scscfDbPool = null;
  }
}

function isCdrAccountingEnabled(): boolean {
  try {
    if (!fs.existsSync(HOST_IMS_STATE)) return false;
    // Declared inline rather than importing ImsState from ims-controller: that
    // would make an application use-case depend on interfaces/rest and invert
    // the layering. One field is all this reads.
    const state = JSON.parse(fs.readFileSync(HOST_IMS_STATE, 'utf-8')) as { cdrAccountingEnabled?: boolean };
    return state.cdrAccountingEnabled === true;
  } catch {
    return false;
  }
}

interface KamailioAccRow {
  id: number;
  method: string;
  callid: string;
  sip_code: string;
  sip_reason: string;
  time: string;
  src_user: string | null;
  dst_user: string | null;
}

// table is always a hardcoded literal from the two call sites below, never
// user input -- template interpolation here isn't an injection surface.
async function fetchNewKamailioRows(table: 'acc' | 'missed_calls', afterId: number): Promise<KamailioAccRow[]> {
  const [rows] = await getScscfDbPool().query<mysql.RowDataPacket[]>(
    `SELECT id, method, callid, sip_code, sip_reason, time, src_user, dst_user FROM ${table} WHERE id > ? ORDER BY id ASC`,
    [afterId],
  );
  return rows as KamailioAccRow[];
}

// Re-reads ALL acc rows for one callid (not just the ones new in this sync
// pass) -- an answered call's INVITE and BYE rows routinely land in
// different 20s sync passes (BYE only appears once the call actually ends),
// so pairing needs a fresh full lookup by callid rather than trying to
// stitch partial state across passes. Idempotent: upsertCdr()'s natural-key
// upsert means re-processing an already-paired callid (e.g. triggered again
// by a stray PRACK/re-INVITE on the same dialog) just overwrites with the
// same result.
async function fetchAccRowsForCallId(callid: string): Promise<KamailioAccRow[]> {
  const [rows] = await getScscfDbPool().query<mysql.RowDataPacket[]>(
    `SELECT id, method, callid, sip_code, sip_reason, time, src_user, dst_user FROM acc WHERE callid = ? AND method IN ('INVITE','BYE') ORDER BY id ASC`,
    [callid],
  );
  return rows as KamailioAccRow[];
}

// Kamailio's own acc module: db_flag logs a row to `acc` on every 2xx-final
// transaction -- INVITE and BYE both land here for an answered call (exactly
// one of each, sharing callid). db_missed_flag logs non-2xx INVITE finals to
// `missed_calls` instead (a call that never connects has no BYE by
// definition -- confirmed live 2026-09-17 against 3 real test calls:
// answered and a rang-then-fell-to-voicemail call both produced clean
// INVITE(200)+BYE(200) acc pairs with no missed_calls row at all, since a
// voicemail pickup IS a real SIP-level answer). FLT_ACCT is set on every
// non-REGISTER/SUBSCRIBE request, so acc also logs PRACK/UPDATE/MESSAGE/
// OPTIONS rows whenever those complete a transaction while flagged --
// confirmed live real PRACK rows appear for early-media/100rel -- filtered
// out below by only ever selecting method IN ('INVITE','BYE').
function normalizeKamailioDisposition(sipCode: string): CdrDisposition {
  const code = Number(sipCode);
  if (code === 486 || code === 600) return 'busy';
  if (code === 487) return 'cancelled';
  if (code === 480 || code === 408) return 'no-answer';
  if (code >= 400) return 'failed';
  return 'unknown';
}

// Builds one CDR from a callid's paired acc row(s). Only the INVITE row's
// src_user/dst_user are used for caller/callee identity -- confirmed live
// 2026-09-17 that a BYE's src_user reflects whichever party actually sent
// the BYE (caller or callee, whoever hung up first), not the original
// caller, and a B2BUA leg's BYE dst_user is the far side's raw contact URI
// user part, not a meaningful destination digit string. dst_user itself is
// captured by kamailio_scscf.cfg's setflag() block BEFORE any PSTN/ENUM
// rewriting later in the same request, confirmed live: a PSTN Gateway test
// call showed each of the two B2BUA-split dialogs correctly captured its own
// distinct pre-rewrite $rU (the originally-dialed short code on one leg,
// Asterisk's own re-origination target on the other) -- exactly the
// per-request, sequential-assignment semantics this design assumed, not
// guessed. Returns null if no INVITE row is present (e.g. a stray in-dialog
// BYE whose matching INVITE's id falls outside this lookup) -- caller skips it.
function buildScscfCdrFromAccRows(
  callid: string,
  rows: KamailioAccRow[],
  lookup: { byImsi: Map<string, Subscriber>; byMsisdn: Map<string, Subscriber> },
): CdrDocument | null {
  const invite = rows.find(r => r.method === 'INVITE');
  if (!invite) return null;
  const bye = rows.find(r => r.method === 'BYE');

  const startTime = parseAsteriskTimestamp(invite.time);
  if (!startTime) return null;
  const endTime = bye ? parseAsteriskTimestamp(bye.time) : null;
  const durationSeconds = endTime ? Math.max(0, Math.round((endTime.getTime() - startTime.getTime()) / 1000)) : null;

  return {
    sourceSystem: 'ims',
    sourceInstance: 'scscf',
    sourceRecordId: callid,
    caller: resolveParty(invite.src_user ?? '', lookup),
    callee: resolveParty(invite.dst_user ?? '', lookup),
    startTime,
    // acc only logs on final-reply completion -- the INVITE row's own `time`
    // IS the answer moment. There is no earlier "ringing started" timestamp
    // in this schema (unlike Asterisk's separate start/answer columns), so
    // startTime and answerTime are necessarily the same value here.
    answerTime: startTime,
    endTime,
    durationSeconds,
    totalDurationSeconds: durationSeconds,
    disposition: 'answered',
    rawDisposition: `${invite.sip_code} ${invite.sip_reason}`,
    raw: { callid, invite, bye: bye ?? null },
    syncedAt: new Date(),
  };
}

function buildScscfCdrFromMissedRow(
  row: KamailioAccRow,
  lookup: { byImsi: Map<string, Subscriber>; byMsisdn: Map<string, Subscriber> },
): CdrDocument | null {
  const t = parseAsteriskTimestamp(row.time);
  if (!t) return null;
  return {
    sourceSystem: 'ims',
    sourceInstance: 'scscf',
    sourceRecordId: row.callid,
    caller: resolveParty(row.src_user ?? '', lookup),
    callee: resolveParty(row.dst_user ?? '', lookup),
    startTime: t,
    answerTime: null,
    endTime: t,
    durationSeconds: 0,
    totalDurationSeconds: 0,
    disposition: normalizeKamailioDisposition(row.sip_code),
    rawDisposition: `${row.sip_code} ${row.sip_reason}`,
    raw: { callid: row.callid, missed: row },
    syncedAt: new Date(),
  };
}

// Handles quoted fields, embedded commas inside quotes, and doubled-quote
// escaping — confirmed live that Asterisk's own lastdata field can contain
// a real comma inside quotes (e.g. "PJSIP/...@scscf_trunk,60"), which a
// naive line.split(',') would corrupt.
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else { inQuotes = false; }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

function normalizeDisposition(raw: string): CdrDisposition {
  const d = raw.trim().toUpperCase();
  if (d === 'ANSWERED') return 'answered';
  if (d === 'NO ANSWER') return 'no-answer';
  if (d === 'BUSY') return 'busy';
  if (d === 'FAILED' || d === 'CONGESTION') return 'failed';
  if (d === 'CANCEL' || d === 'CANCELLED') return 'cancelled';
  return 'unknown';
}

// cdr.conf's [csv] stanza has usegmtime=yes on both Asterisk instances
// (confirmed live) — Asterisk's own "YYYY-MM-DD HH:mm:ss" timestamps are
// already UTC wall-clock, not local time. Force UTC parsing explicitly
// rather than relying on JS's non-ISO date-string fallback (which parses
// as local time in Node), matching the real config.
function parseAsteriskTimestamp(s: string): Date | null {
  if (!s) return null;
  const d = new Date(`${s.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Column order confirmed from a real row, no header line present:
// accountcode, src, dst, dcontext, clid, channel, dstchannel, lastapp,
// lastdata, start, answer, end, duration, billsec, disposition, amaflags,
// uniqueid, userfield.
function parseAsteriskCsvRow(fields: string[], source: AsteriskCsvSource): CdrDocument | null {
  if (fields.length < 18) return null;
  const [accountcode, src, dst, dcontext, clid, channel, dstchannel, lastapp, lastdata,
    start, answer, end, duration, billsec, disposition, amaflags, uniqueid, userfield] = fields;
  if (!uniqueid) return null;

  const startTime = parseAsteriskTimestamp(start);
  if (!startTime) return null; // no usable start time — not a real record

  return {
    sourceSystem: source.sourceSystem,
    sourceInstance: source.instance,
    sourceRecordId: uniqueid,
    caller: { raw: src },
    callee: { raw: dst },
    startTime,
    answerTime: parseAsteriskTimestamp(answer),
    endTime: parseAsteriskTimestamp(end),
    durationSeconds: billsec !== '' ? Number(billsec) : null,
    totalDurationSeconds: duration !== '' ? Number(duration) : null,
    disposition: normalizeDisposition(disposition),
    rawDisposition: disposition,
    // PSTN Gateway's outbound catch-all sets CDR(accountcode)=external-did
    // right before dialing the real external trunk (see pstn-controller.ts's
    // extensionsPstnConf()) — every other entry in that module (internal
    // short codes, auto-dialed subscriber MSISDNs, Cross-RAN forwarding,
    // and every inbound DID leg) leaves accountcode unset, the same
    // already-blank default every PSTN call has always had. Scoped to
    // 'pstn' only — 2G and IMS-sourced rows aren't part of this feature.
    trunkType: source.sourceSystem === 'pstn'
      ? (accountcode === 'external-did' ? 'external-did' : 'internal')
      : undefined,
    raw: { accountcode, src, dst, dcontext, clid, channel, dstchannel, lastapp, lastdata, start, answer, end, duration, billsec, disposition, amaflags, uniqueid, userfield },
    syncedAt: new Date(),
  };
}

// Bulk-fetch once per sync pass and match client-side — same "bulk GET,
// match client-side" convention as charging-plans-controller.ts's own
// subscriber resolution, never N per-row lookups.
function buildSubscriberLookup(subs: Subscriber[]): { byImsi: Map<string, Subscriber>; byMsisdn: Map<string, Subscriber> } {
  const byImsi = new Map<string, Subscriber>();
  const byMsisdn = new Map<string, Subscriber>();
  for (const s of subs) {
    byImsi.set(s.imsi, s);
    for (const m of s.msisdn ?? []) byMsisdn.set(m, s);
  }
  return { byImsi, byMsisdn };
}

// Strips the common SIP/tel URI decorations this deployment's own IMS work
// already found biting a raw-identity match once (CLAUDE.md pattern #18) —
// sip:/tel: scheme, ;user=phone and other URI params, @domain suffix — down
// to a bare digit/username string before comparing against IMSI/MSISDN.
function stripIdentityDecorations(raw: string): string {
  return raw
    .replace(/^(sip|tel):/i, '')
    .replace(/;[^@]*$/, '')
    .replace(/@.*$/, '')
    .replace(/^\+/, '');
}

function resolveParty(raw: string, lookup: { byImsi: Map<string, Subscriber>; byMsisdn: Map<string, Subscriber> }): CdrParty {
  const stripped = stripIdentityDecorations(raw);
  const sub = lookup.byImsi.get(stripped) ?? lookup.byMsisdn.get(stripped);
  if (!sub) return { raw };
  return { raw, imsi: sub.imsi, msisdn: sub.msisdn?.[0], nickname: sub.nickname };
}

export class CdrSyncMonitor {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: Db,
    private readonly subscriberRepo: ISubscriberRepository,
    private readonly logger: pino.Logger,
  ) {}

  start(): void {
    if (this.timer) return;
    this.sync().catch(err => this.logger.warn({ err: String(err) }, 'CDR sync: initial pass failed'));
    this.timer = setInterval(() => {
      this.sync().catch(err => this.logger.warn({ err: String(err) }, 'CDR sync: pass failed'));
    }, SYNC_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    closeScscfDbPool().catch(err => this.logger.warn({ err: String(err) }, 'CDR sync: failed to close scscf DB pool'));
  }

  // Exposed for the controller's "Sync Now" button — same on-demand-trigger
  // shape as this project's other background pollers (e.g. TwampMonitor).
  async syncNow(): Promise<void> {
    await this.sync();
  }

  private loadState(): SyncState {
    try {
      if (fs.existsSync(STATE_FILE)) {
        const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
        return {
          offsets: parsed.offsets && typeof parsed.offsets === 'object' ? parsed.offsets : {},
          kamailioAccId: typeof parsed.kamailioAccId === 'number' ? parsed.kamailioAccId : undefined,
          kamailioMissedId: typeof parsed.kamailioMissedId === 'number' ? parsed.kamailioMissedId : undefined,
        };
      }
    } catch {
      // Corrupt/missing state file — start fresh rather than crash the sync loop.
    }
    return { offsets: {} };
  }

  private saveState(state: SyncState): void {
    try {
      fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    } catch (err) {
      this.logger.warn({ err: String(err) }, 'CDR sync: failed to persist state');
    }
  }

  private async sync(): Promise<void> {
    const state = this.loadState();
    const subs = await this.subscriberRepo.findAllFull();
    const lookup = buildSubscriberLookup(subs);

    for (const source of ASTERISK_SOURCES) {
      try {
        await this.syncOneSource(source, state, lookup);
      } catch (err) {
        this.logger.warn({ err: String(err), instance: source.instance }, 'CDR sync: source failed');
      }
    }

    try {
      await this.syncKamailioAcc(state, lookup);
    } catch (err) {
      this.logger.warn({ err: String(err) }, 'CDR sync: kamailio acc source failed');
    }

    this.saveState(state);
  }

  // Phase 3 — direct 4G/5G IMS-to-IMS calls via Kamailio's own acc/
  // missed_calls tables. No-op (one cheap fs.existsSync + JSON parse) unless
  // setCdrAccountingEnabled() has turned WITH_CDR on. See buildScscfCdrFromAccRows()'s
  // own comment for the INVITE/BYE pairing design and what's confirmed live.
  private async syncKamailioAcc(
    state: SyncState,
    lookup: { byImsi: Map<string, Subscriber>; byMsisdn: Map<string, Subscriber> },
  ): Promise<void> {
    if (!isCdrAccountingEnabled()) return;

    const lastAccId = state.kamailioAccId ?? 0;
    const lastMissedId = state.kamailioMissedId ?? 0;

    const newAccRows = await fetchNewKamailioRows('acc', lastAccId);
    const newMissedRows = await fetchNewKamailioRows('missed_calls', lastMissedId);

    // Re-fetch the full row set per touched callid rather than pairing off
    // just the rows new in this pass — see fetchAccRowsForCallId()'s comment.
    const touchedCallIds = new Set<string>();
    for (const row of newAccRows) {
      if (row.method === 'INVITE' || row.method === 'BYE') touchedCallIds.add(row.callid);
    }
    for (const callid of touchedCallIds) {
      const rows = await fetchAccRowsForCallId(callid);
      const doc = buildScscfCdrFromAccRows(callid, rows, lookup);
      if (doc) await upsertCdr(this.db, doc);
    }

    for (const row of newMissedRows) {
      if (row.method !== 'INVITE') continue; // defensive — missed_calls should only ever get INVITE rows
      const doc = buildScscfCdrFromMissedRow(row, lookup);
      if (doc) await upsertCdr(this.db, doc);
    }

    if (newAccRows.length > 0) state.kamailioAccId = newAccRows[newAccRows.length - 1].id;
    if (newMissedRows.length > 0) state.kamailioMissedId = newMissedRows[newMissedRows.length - 1].id;
  }

  private async syncOneSource(
    source: AsteriskCsvSource,
    state: SyncState,
    lookup: { byImsi: Map<string, Subscriber>; byMsisdn: Map<string, Subscriber> },
  ): Promise<void> {
    if (!fs.existsSync(source.csvPath)) return; // module not installed, or (2G) the cdr-csv dir doesn't exist yet

    const stat = fs.statSync(source.csvPath);
    let offset = state.offsets[source.instance] ?? 0;
    if (stat.size < offset) offset = 0; // file shrank — treat as rotation, re-read from the start

    if (stat.size === offset) return; // nothing new

    const fd = fs.openSync(source.csvPath, 'r');
    try {
      const length = stat.size - offset;
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, offset);
      const chunk = buffer.toString('utf-8');

      // Only advance the offset past whole lines — a partial trailing line
      // (Asterisk mid-write) gets re-read next pass instead of silently
      // dropped or double-counted.
      const lastNewline = chunk.lastIndexOf('\n');
      if (lastNewline === -1) return;
      const complete = chunk.slice(0, lastNewline);
      const newOffset = offset + Buffer.byteLength(complete, 'utf-8') + 1;

      const lines = complete.split('\n').filter(l => l.trim().length > 0);
      for (const line of lines) {
        const fields = parseCsvLine(line);
        const doc = parseAsteriskCsvRow(fields, source);
        if (!doc) continue;
        doc.caller = resolveParty(doc.caller.raw, lookup);
        doc.callee = resolveParty(doc.callee.raw, lookup);
        await upsertCdr(this.db, doc);
      }

      state.offsets[source.instance] = newOffset;
    } finally {
      fs.closeSync(fd);
    }
  }
}
