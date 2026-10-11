import { Router, Request, Response } from 'express';
import { exec } from 'child_process';
import * as fs from 'fs';
import pino from 'pino';
import { Db } from 'mongodb';
import { IAuditLogger } from '../../domain/interfaces/audit-logger';
import { ISubscriberRepository } from '../../domain/interfaces/subscriber-repository';
import { requireAdmin } from './middleware/auth-middleware';
import { getAppVersion } from '../../infrastructure/system/app-version';
import { safeNsenter } from '../../infrastructure/system/safe-nsenter';

// ── SigScale OCS (Online Charging System, 4G/EPC Gy real-time charging) ────
//
// Installs and manages a real, third-party Erlang/OTP application (SigScale
// OCS, https://github.com/sigscale/ocs) via its own apt package, and wires
// Open5GS's SMF to it over Diameter Gy (real-time credit-control charging,
// RFC 4006) — SMF has supported Gy natively via freeDiameter since v2.4.7
// (contributed by sysmocom), but nothing in this deployment has ever used
// it before this module. 4G/EPC only — Open5GS's SMF has zero 5G online-
// charging (Nchf) support upstream (confirmed live against the real
// open5gs/open5gs GitHub discussion #4421: a community proposal exists, not
// merged, no timeline), so a 5G NR UE's session is never charged/controlled
// by this module. See CLAUDE.md's architectural pattern entry and memory
// `sigscale_ocs_gy_integration` for the full research/build arc.
//
// Three real, non-obvious deployment issues were found and fixed live
// getting this working for the first time on this host — all baked into
// this module's own generated config so a fresh install doesn't rediscover
// them:
//   1. OCS's own default HTTP/REST/GUI port (8080) collides with PyHSS's own
//      API service (already running whenever IMS is installed) — moved to
//      OCS_HTTP_PORT below.
//   2. OCS's own default Diameter listen address is the wildcard 0.0.0.0,
//      which silently fails to bind (eaddrinuse) against the OTHER NFs' own
//      dedicated-IP freeDiameter listeners sharing port 3868/3869 — the
//      Erlang `diameter` OTP application reports its own supervisor as "up"
//      even though the actual TCP transport never bound, so this does NOT
//      show up as an obvious crash; only a live `ss -ltnp` check (or a real
//      peer connection attempt) reveals it. Fixed by giving OCS its own
//      dedicated loopback IP (OCS_BIND_IP), matching this project's
//      established per-daemon-loopback-alias convention.
//   3. OCS denies any Diameter peer whose source IP isn't pre-registered in
//      its own Mnesia "client" table (confirmed live: a real CER from SMF
//      was rejected with "DIAMETER peer address not found in client table",
//      result 3010/DIAMETER_UNKNOWN_PEER) — same table RADIUS NAS clients
//      use, but it gates Diameter peers too. `configureOcs()` below
//      registers SMF as a trusted client via `ocs:add_client/6`, called by
//      RPC into the already-running `ocs` Erlang node (see addSmfAsOcsClient
//      below) — this is the same class of "reach into the real running
//      thing and do it for real" this project already does via nsenter for
//      everything else, just via Erlang's own RPC instead of a shell command.
//   4. OCS's own Diameter Origin-Host/Origin-Realm default to
//      inet:gethostname()/the system's DNS search domain (confirmed live:
//      "open5gs-core"/"example.net") — NOT anything PLMN-related, and NOT
//      what freeDiameter's ConnectPeer identity-matching expects. Both are
//      real, documented `sys.config` options (per OCS's own edoc) that
//      `ocsSysConfig()` below sets explicitly, matching this deployment's
//      real PLMN and the existing `pcrf.epc...`/`aaa.epc...` peer-naming
//      convention already used on this exact freeDiameter instance.

// Real, reproduced-live bug (2026-09-25, found reviewing the SigScale OCS
// dashboard's polling design, confirmed broader while building the
// Asterisk dashboard right after): `nsenter -p` forks internally before
// exec'ing the wrapped command, unconditionally — a bare `execFile`/spawn
// `timeout` only kills the top-level nsenter PID, orphaning the real
// wrapped process. Extracted into a shared, reusable hardened wrapper —
// see `safe-nsenter.ts`'s own header comment for the full mechanism and
// why this fix belongs there now, not duplicated per-caller.
const nsenter = safeNsenter;

export const HOST_ROOT = '/proc/1/root';
const HOST_OTP_HOME   = `${HOST_ROOT}/home/otp`;
const HOST_STATE      = `${HOST_ROOT}/etc/open5gs/.ocs-config.json`;

// Shared by any controller that needs to call into the real running `ocs`
// Erlang node — factored out here rather than re-copied a 4th time
// (setOcsUser, syncOcsSubscribers, and now charging-plans-controller.ts all
// need this exact "write a temp .erl eval file, chown to otp, run it as the
// otp user against a fresh throwaway node, clean up" dance). Two real traps
// already found and fixed live tonight, baked in here so nothing calling
// this helper can walk into them again: (1) a bare `-eval` shell has no
// .hrl loaded — never use #record{} syntax in scripts passed here, use
// positional element(N, Tuple) or raw tuple literals instead; (2) every
// `ocs:*` call inside the script MUST go through `rpc:call('ocs@open5gs-
// core', ocs, F, A)` — the throwaway node has no `ocs` application loaded,
// so a direct local `ocs:F(A)` call fails with `{undef,...}`.
export async function runOcsEval(evalScript: string, timeoutMs = 15000): Promise<string> {
  const scriptHostPath = `${HOST_ROOT}/tmp/.ocs-eval-${Date.now()}-${Math.random().toString(36).slice(2)}.erl`;
  try {
    fs.writeFileSync(scriptHostPath, evalScript, 'utf-8');
    await nsenter('chown', ['otp:otp', scriptHostPath.replace(HOST_ROOT, '')]).catch(() => {});
    const nodeSuffix = Date.now() % 100000;
    const { stdout } = await nsenter('runuser', [
      '-u', 'otp', '--',
      'bash', '-c',
      `export HOME=/home/otp; cd /home/otp; ` +
      `erl -noshell -sname ocsctl${nodeSuffix} -setcookie $(cat .erlang.cookie) ` +
      `-eval "$(cat ${scriptHostPath.replace(HOST_ROOT, '')})"`,
    ], timeoutMs);
    return stdout;
  } finally {
    try { fs.unlinkSync(scriptHostPath); } catch { /* best-effort cleanup */ }
  }
}

// Real, confirmed-live bug (2026-09-23): every RPC into the running OCS
// node hardcoded 'ocs@open5gs-core' — correct on production (whose real
// hostname genuinely is open5gs-core), but OCS's own systemd unit starts
// Erlang with just `-sname ocs`, so distributed Erlang always appends the
// HOST's own actual hostname, not this project's own naming convention.
// On any other host (confirmed live on a fresh VM, real hostname
// open5gs0-test) every one of these calls failed with {badrpc,nodedown} —
// not a startup-timing race, the target node name was simply wrong and no
// amount of retrying would ever fix it. Cached for the process lifetime
// (a host's own hostname never changes while this process runs) — matches
// frr-controller.ts's own detectHostname() fallback-on-failure shape.
let cachedOcsNodeName: string | undefined;
export async function getOcsNodeName(): Promise<string> {
  if (cachedOcsNodeName) return cachedOcsNodeName;
  try {
    const { stdout } = await nsenter('hostname');
    cachedOcsNodeName = `ocs@${stdout.trim() || 'open5gs-core'}`;
  } catch {
    cachedOcsNodeName = 'ocs@open5gs-core';
  }
  return cachedOcsNodeName;
}

const HOST_SMF_CONF   = `${HOST_ROOT}/etc/freeDiameter/smf.conf`;
// Own, module-scoped backup filename — VoWiFi's own upsertSmfAaaPeer() also
// backs up smf.conf (for its own S6b peer), under its own
// .vowifi-smf-conf.bak name. Never share a backup file between modules that
// both add their own line to the same shared conf — each module's restore
// point must only ever represent "before THIS module's own first write".
const HOST_SMF_CONF_BAK = `${HOST_ROOT}/etc/open5gs-nms/.ocs-smf-conf.bak`;
const HOST_MME_YAML   = `${HOST_ROOT}/etc/open5gs/mme.yaml`;

const SYSTEMD_UNIT = 'ocs';

// This project's per-daemon dedicated-loopback-alias convention — confirmed
// live 2026-09-16 this is genuinely necessary (not just cautious hardening):
// OCS's own default 0.0.0.0 Diameter bind silently fails against the other
// NFs' own dedicated-IP freeDiameter listeners already on 3868/3869.
const DEFAULT_BIND_IP = '127.0.1.10';
const DIAMETER_ACCT_PORT = 3868;
const DIAMETER_AUTH_PORT = 3869;
// OCS's own default (8080) collides with PyHSS's API service — confirmed
// live. 8090/8091/8092 are also taken (VectorCore MMSC, osmo-related SMSC) —
// verified free at the time this was chosen.
const DEFAULT_HTTP_PORT = 8093;

interface OcsState {
  bindIp: string;
  httpPort: number;
  // Diameter identity this instance presents — deliberately NOT left at
  // OCS's own default (inet:gethostname()/DNS search domain, confirmed live
  // to be "open5gs-core"/"example.net" on this host, neither PLMN-related)
  // — freeDiameter's ConnectPeer identity-matching on SMF's side requires an
  // exact match, confirmed live via a real rejected CEA before this was set.
  originHost: string;
  originRealm: string;
  // Real, 2026-09-16 production incident: the moment this Gy ConnectPeer
  // goes STATE_OPEN, Open5GS SMF requires a successful Gy CCA-Initial for
  // EVERY session and treats a failure as fatal to the whole Create Session
  // Response — not a soft/best-effort charging attempt. OCS has zero
  // implicit/wildcard subscriber authorization (confirmed live:
  // DIAMETER_USER_UNKNOWN/5030 for a real, existing Open5GS subscriber that
  // simply had no matching `service`+`product` record in OCS's own Mnesia)
  // — every subscriber genuinely needs one. This is the operator-supplied
  // OCS Product Offering ID (created in OCS's own web GUI — this module
  // deliberately never reimplements rating-plan/offer CRUD) that
  // syncOcsSubscribers() attaches each seeded subscriber's `service` to via
  // `ocs:add_product/2`. Left unset, `configureOcs()` still wires the Gy
  // peer (matches every prior Configure's behavior) but skips auto-sync and
  // the frontend must show a hard warning — see `configureOcs()`'s
  // `subscriberSyncWarning` return field.
  defaultOfferId?: string;
  // Persisted so /status can show sync coverage on every cheap poll without
  // an expensive Erlang RPC round-trip each time (this endpoint is polled
  // every 5s from the Dashboard, Services page, and this module's own Setup
  // tab simultaneously) — written by both /configure's auto-sync and the
  // manual /sync-subscribers button.
  lastSyncedAt?: string;
  lastSyncCounts?: { synced: number; failed: number; removed: number };
  installedWithVersion?: string;
  configuredWithVersion?: string;
}

function readMccMnc(): { mcc: string; mnc: string } {
  let mcc = '001';
  let mnc = '01';
  if (fs.existsSync(HOST_MME_YAML)) {
    const raw = fs.readFileSync(HOST_MME_YAML, 'utf-8');
    const mccM = raw.match(/mcc:\s*['"]?(\d+)['"]?/);
    const mncM = raw.match(/mnc:\s*['"]?(\d+)['"]?/);
    if (mccM) mcc = mccM[1];
    if (mncM) mnc = mncM[1];
  }
  return { mcc, mnc };
}

function defaultRealm(): string {
  const { mcc, mnc } = readMccMnc();
  return `epc.mnc${mnc.padStart(3, '0')}.mcc${mcc}.3gppnetwork.org`;
}

function stateDefaults(): OcsState {
  const realm = defaultRealm();
  return {
    bindIp: DEFAULT_BIND_IP,
    httpPort: DEFAULT_HTTP_PORT,
    originHost: `ocs.${realm}`,
    originRealm: realm,
  };
}

export function readState(): OcsState | null {
  if (!fs.existsSync(HOST_STATE)) return null;
  try { return { ...stateDefaults(), ...JSON.parse(fs.readFileSync(HOST_STATE, 'utf-8')) }; } catch { return null; }
}

function writeState(state: OcsState): void {
  fs.mkdirSync(`${HOST_ROOT}/etc/open5gs`, { recursive: true });
  fs.writeFileSync(HOST_STATE, JSON.stringify(state, null, 2), 'utf-8');
}

// Read-only peer info for any OTHER module that needs to wire its own
// Diameter client to this already-running OCS instance (e.g.
// ims-controller.ts registering S-CSCF for Ro voice charging) — deliberately
// exposes only what a peer needs (identity/IP/port), never the full
// OcsState. Returns null when OCS has never been configured (no state file
// yet) — callers should treat that the same as "OCS not available".
export function getOcsPeerInfo(): { originHost: string; bindIp: string; port: number } | null {
  const state = readState();
  if (!state) return null;
  return { originHost: state.originHost, bindIp: state.bindIp, port: DIAMETER_ACCT_PORT };
}

// ── OTP release helpers ─────────────────────────────────────────────────

// start_erl.data is the standard Erlang/OTP release-runner's own pointer to
// the currently-active release (format: "<erts-vsn> <release-dir-name>",
// e.g. "13.2.2.5 ocs-3.4.73") — reading it live rather than hardcoding a
// version keeps this module working across OCS package upgrades without
// needing a code change every time SigScale ships a new release.
function resolveActiveRelease(): string | null {
  const path = `${HOST_OTP_HOME}/releases/start_erl.data`;
  if (!fs.existsSync(path)) return null;
  const raw = fs.readFileSync(path, 'utf-8').trim();
  const parts = raw.split(/\s+/);
  return parts[1] || null;
}

function sysConfigPath(release: string): string {
  return `${HOST_OTP_HOME}/releases/${release}/sys.config`;
}

// ── sys.config generation ───────────────────────────────────────────────
//
// Full-regenerate every Configure call — matches this project's established
// convention for a module's OWN exclusively-owned config file (PyHSS's
// config.yaml, VectorCore's own configs, VectorCore AAA's own Erlang
// .config) rather than an ownership-merge (reserved for files genuinely
// shared with another module's own hand-maintained content, which this one
// is not).
function ocsSysConfig(bindIp: string, httpPort: number, originHost: string, originRealm: string, release: string): string {
  const diamOpts = `[{'Origin-Host', "${originHost}"}, {'Origin-Realm', "${originRealm}"}]`;
  return `[{ocs,
      [{radius,
               [{auth,
                      [{{0,0,0,0}, 1812, []}]},
               {acct,
                     [{{0,0,0,0}, 1813, []}]}]},
      {diameter,
               [{acct,
                      [{{${bindIp.split('.').join(',')}}, ${DIAMETER_ACCT_PORT}, ${diamOpts}}]},
               {auth,
                     [{{${bindIp.split('.').join(',')}}, ${DIAMETER_AUTH_PORT}, ${diamOpts}}]}]},
      {acct_log_rotate, 1440},
      {acct_log_rotate_time, {4,4,4}},
      {acct_log_dir, "log/acct"},
      {auth_log_dir, "log/auth"},
      {abmf_log_dir, "log/abmf"},
      {ipdr_log_dir, "log/ipdr"},
      {export_dir, "log/export"},
      {tls_key, "ssl/key.pem"},
      {tls_cert, "ssl/cert.pem"},
      {tls_cacert, "ssl/ca.pem"}]},
{radius,
      [{sock_opts, [{recbuf, 131072}, {sndbuf, 131072}]}]},
{mnesia,
      [{dir, "db"}]},
{snmp,
      [{agent,
           [{config, [{dir, "snmp/conf"}]},
           {db_dir, "snmp/db"}]}]},
{inets,
      [{services,
         [{httpd,
            [{server_name, "ocs"},
            {directory_index, ["index.html"]},
            {directory, {"/schema", []}},
            {directory, {"/doc", []}},
            {directory, {"/health", []}},
            {directory, {"/partyRoleManagement", []}},
            {directory, {"/",
                  [{auth_type, mnesia},
                  {auth_name, "ocs.sigscale.org"},
                  {require_group, ["staff"]}]}},
            {transfer_disk_log, "log/http/transfer"},
            {security_disk_log, "log/http/security"},
            {error_disk_log, "log/http/error"},
            {transfer_disk_log_size, {10485760, 10}},
            {error_disk_log_size, {10485760, 10}},
            {security_disk_log_size, {10485760, 10}},
            {disk_log_format, internal},
            {modules,
                  [mod_alias,
                  mod_auth,
                  mod_responsecontrol,
                  mod_ocs_rest_accepted_content,
                  mod_ocs_rest_get,
                  mod_get,
                  mod_ocs_rest_head,
                  mod_ocs_rest_post,
                  mod_ocs_rest_patch,
                  mod_ocs_rest_delete,
                  mod_disk_log]},
            {mime_types,
                  [{"html", "text/html"},
                  {"css", "text/css"},
                  {"js", "application/javascript"},
                  {"json", "application/json"},
                  {"jsonld", "application/linkset+json; profile=\\"https://www.rfc-editor.org/info/rfc9727\\""},
                  {"svg", "image/svg+xml"},
                  {"png", "image/png"},
                  {"csv", "text/csv"}]},
            {port, ${httpPort}},
            {socket_type, ip_comm},
            {server_root, "./"},
            {alias, {"/doc", "lib/${release}/doc"}},
            {alias, {"/schema", "lib/${release}/priv/schema"}},
            {alias, {"/.well-known/api-catalog",
                  "lib/${release}/priv/schema/api-catalog.linkset.jsonld"}},
            {document_root, "lib/${release}/priv/www"}]}]}]}].
`;
}

// ── Diameter client registration (OCS's own trust list) ────────────────
//
// OCS denies any Diameter peer whose source IP isn't pre-registered in its
// own Mnesia "client" table (confirmed live — see module header). The real,
// documented function is `ocs:add_client(Address, Port, Protocol, Secret,
// PasswordRequired, Trusted)` (ocs.erl's own edoc) — Mnesia writes are
// upserts keyed by Address, so calling this again with the same IP on every
// Configure is a safe, idempotent overwrite, not an error.
//
// This has to run as an RPC INTO the already-running `ocs` Erlang node, not
// as a local call on a fresh throwaway node — `ocs:add_client` needs Mnesia,
// which is only started on the real node (confirmed live: a local-eval
// attempt on a fresh node crashes it outright). A temp .erl-eval file sidesteps
// a real, confirmed shell-quoting problem: single-quoted Erlang atoms like
// 'ocs@open5gs-core' cannot be safely embedded in a bash -c "...-eval '...'"
// string (bash cannot escape a single quote inside a single-quoted string),
// and double-quote-based alternatives silently mis-tokenize the atom.
async function addSmfAsOcsClient(smfIp: string): Promise<{ ok: boolean; error?: string }> {
  const nodeName = await getOcsNodeName();
  const evalScript = [
    `Result = rpc:call('${nodeName}', ocs, add_client, [{${smfIp.split('.').join(',')}}, undefined, diameter, undefined, false, true]),`,
    `io:fwrite("~p~n", [Result]),`,
    `init:stop().`,
  ].join('\n');
  // Retry on 'nodedown' specifically — confirmed live 2026-09-23:
  // configureOcs()'s own restart->3s-sleep->isCodecOrServiceActive() check
  // above only proves systemd sees the run_erl daemon process as started,
  // NOT that the Erlang node has finished OTP boot / registered its short
  // name with epmd / finished loading Mnesia — a real, reproduced race
  // where this RPC fires before any of that is ready, returning
  // {badrpc,nodedown} even though the node comes up fine moments later.
  // Any OTHER error (bad args, a real Mnesia failure, etc.) is not a
  // readiness problem and fails immediately, unchanged from before.
  const maxAttempts = 6;
  let lastError = 'unknown';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const scriptHostPath = `${HOST_ROOT}/tmp/.ocs-add-client-${Date.now()}.erl`;
    try {
      fs.writeFileSync(scriptHostPath, evalScript, 'utf-8');
      await nsenter('chown', ['otp:otp', scriptHostPath.replace(HOST_ROOT, '')]).catch(() => {});
      const nodeSuffix = Date.now() % 100000;
      const { stdout } = await nsenter('runuser', [
        '-u', 'otp', '--',
        'bash', '-c',
        `export HOME=/home/otp; cd /home/otp; ` +
        `erl -noshell -sname ocsctl${nodeSuffix} -setcookie $(cat .erlang.cookie) ` +
        `-eval "$(cat ${scriptHostPath.replace(HOST_ROOT, '')})"`,
      ], 15000);
      if (stdout.includes('{ok,{client,')) {
        return { ok: true };
      }
      lastError = `Unexpected add_client result: ${stdout.trim()}`;
      if (!stdout.includes('nodedown')) {
        return { ok: false, error: lastError };
      }
    } catch (err) {
      lastError = String(err);
      if (!lastError.includes('nodedown')) {
        return { ok: false, error: lastError };
      }
    } finally {
      try { fs.unlinkSync(scriptHostPath); } catch { /* best-effort cleanup */ }
    }
    if (attempt < maxAttempts) await new Promise(r => setTimeout(r, 3000));
  }
  return { ok: false, error: `${lastError} (gave up after ${maxAttempts} attempts waiting for the OCS Erlang node to come up)` };
}

// Generic version of the same add_client call above, reusable by any OTHER
// module that needs to register a new trusted Diameter peer with this
// already-running OCS instance — ims-controller.ts uses this to register
// S-CSCF for Ro voice charging (same Diameter Credit-Control Application-Id
// 4 that Gy already uses, so no OCS-side listener change is needed, just a
// second client record keyed by S-CSCF's own IP). Goes through the shared
// runOcsEval() dance instead of duplicating addSmfAsOcsClient's own inline
// version a second time.
export async function addOcsDiameterClient(ip: string): Promise<{ ok: boolean; error?: string }> {
  const nodeName = await getOcsNodeName();
  const evalScript = [
    `Result = rpc:call('${nodeName}', ocs, add_client, [{${ip.split('.').join(',')}}, undefined, diameter, undefined, false, true]),`,
    `io:fwrite("~p~n", [Result]),`,
    `init:stop().`,
  ].join('\n');
  try {
    const stdout = await runOcsEval(evalScript);
    if (!stdout.includes('{ok,{client,')) {
      return { ok: false, error: `Unexpected add_client result: ${stdout.trim()}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// ── OCS web GUI / REST API user account ─────────────────────────────────
//
// OCS ships with NO default login — the operator must create one via its
// own `ocs` module before the web GUI or its REST API will accept anything.
// Confirmed live against the real running node (2026-09-16):
//   ocs:add_user(Username, Password, Locale)    -> {ok, LastModified}
//                                                  | {error, user_exists}
//   ocs:update_user(Username, NewPassword, Locale) -> {ok, LastModified}
//   ocs:get_user(Username)                      -> {ok, #httpd_user{}}
//                                                  | {error, no_such_user}
// `add_user` on an existing username fails with `{error,user_exists}` — it
// is NOT an upsert. Empirically round-tripped (add -> get -> update -> get
// -> add again -> delete -> get) against the real node before writing this,
// same discipline as addSmfAsOcsClient's own research above. `setOcsUser()`
// below gives the frontend a single "set credentials" action: try add_user
// first, and only on `user_exists` fall back to update_user — this is what
// lets an operator create the account once and freely change the password
// later through the exact same button.
//
// Username/password are untrusted admin input embedded directly into an
// Erlang string literal inside the generated .erl eval file — escapeErlString()
// escapes backslash/double-quote so a value containing either can't break out
// of the literal and splice in extra Erlang terms (the eval file itself is
// immune to bash-level injection regardless — see addSmfAsOcsClient's own
// comment on why a temp-file + "$(cat file)" -eval never gets word-split or
// re-expanded by the shell — but the Erlang parser still needs a well-formed
// string literal).
export function escapeErlString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

async function setOcsUser(username: string, password: string, locale = 'en'): Promise<{ ok: boolean; created: boolean; error?: string }> {
  const nodeName = await getOcsNodeName();
  const u = escapeErlString(username);
  const p = escapeErlString(password);
  const l = escapeErlString(locale);
  const runEval = async (evalScript: string): Promise<string> => {
    const scriptHostPath = `${HOST_ROOT}/tmp/.ocs-user-${Date.now()}-${Math.random().toString(36).slice(2)}.erl`;
    try {
      fs.writeFileSync(scriptHostPath, evalScript, 'utf-8');
      await nsenter('chown', ['otp:otp', scriptHostPath.replace(HOST_ROOT, '')]).catch(() => {});
      const nodeSuffix = Date.now() % 100000;
      const { stdout } = await nsenter('runuser', [
        '-u', 'otp', '--',
        'bash', '-c',
        `export HOME=/home/otp; cd /home/otp; ` +
        `erl -noshell -sname ocsctl${nodeSuffix} -setcookie $(cat .erlang.cookie) ` +
        `-eval "$(cat ${scriptHostPath.replace(HOST_ROOT, '')})"`,
      ], 15000);
      return stdout;
    } finally {
      try { fs.unlinkSync(scriptHostPath); } catch { /* best-effort cleanup */ }
    }
  };

  try {
    const addScript = [
      `Result = rpc:call('${nodeName}', ocs, add_user, ["${u}", "${p}", "${l}"]),`,
      `io:fwrite("~p~n", [Result]),`,
      `init:stop().`,
    ].join('\n');
    const addOut = await runEval(addScript);
    if (addOut.includes('{ok,')) return { ok: true, created: true };
    if (!addOut.includes('user_exists')) {
      return { ok: false, created: false, error: `Unexpected add_user result: ${addOut.trim()}` };
    }

    const updateScript = [
      `Result = rpc:call('${nodeName}', ocs, update_user, ["${u}", "${p}", "${l}"]),`,
      `io:fwrite("~p~n", [Result]),`,
      `init:stop().`,
    ].join('\n');
    const updateOut = await runEval(updateScript);
    if (updateOut.includes('{ok,')) return { ok: true, created: false };
    return { ok: false, created: false, error: `Unexpected update_user result: ${updateOut.trim()}` };
  } catch (err) {
    return { ok: false, created: false, error: String(err) };
  }
}

// ── OCS subscriber provisioning (service + product) ─────────────────────
//
// Real production incident, 2026-09-16: the moment the Gy ConnectPeer above
// goes STATE_OPEN, Open5GS SMF requires a successful Gy CCA-Initial for
// EVERY 4G session and treats a failure as FATAL to the whole Create
// Session Response (confirmed live: MME saw "CreateSessionResponse
// failure: Conditional IE missing [Cause:103]" / "No S11 TEID" for 100% of
// attach attempts, on every eNB, the instant Gy went live) — not a
// soft/best-effort charging attempt. OCS itself has zero implicit/wildcard
// subscriber authorization: a real, already-existing Open5GS subscriber
// with no matching OCS `service`+`product` record gets a hard
// DIAMETER_USER_UNKNOWN (Result-Code 5030) on every Gy CCR-Initial. This
// function is what makes "enable OCS" not silently break every UE on the
// network — it seeds one `service` per subscriber identity (IMSI, and
// MSISDN too since SMF's Gy CCR-Initial sends BOTH as separate
// Subscription-Id AVPs — confirmed live via a real Diameter capture; which
// one OCS's own Gy handler actually keys its lookup on isn't documented,
// so both are provisioned defensively) and links it to a `product`
// instance of the operator's chosen Product Offering (defaultOfferId) —
// this module deliberately never creates/edits Offers themselves (pricing/
// rating plan definition), matching this project's "link out, don't
// reimplement" convention; the operator creates the Offering once in OCS's
// own web GUI.
//
// Real API (github.com/sigscale/ocs, src/ocs.erl — no docs/specs/abstract
// code shipped in the installed release, fetched from the public repo and
// cross-checked against this node's own live exports before writing this):
//   ocs:find_service(Identity)        -> {ok, #service{}} | {error, not_found}
//   ocs:add_service(Identity, Password) -> {ok, #service{}} | {error, Reason}
//     (Identity auto-converted list->binary internally; Password=undefined
//     auto-generates one — fine, Gy authorizes by Subscription-Id, not
//     service password)
//   ocs:add_product(OfferId, ServiceRefs) -> {ok, #product{}} | {error, Reason}
//     (ServiceRefs MUST be binaries — #product.service is typed
//     [ServiceRef :: binary()] and add_product's own mnesia:read(service,
//     ServiceRef, write) match fails silently-as-service_not_found against
//     a string of the same identity, since Erlang string/binary terms are
//     never equal — this eval script only ever emits <<"...">> binary
//     literals for identities, never plain strings, to avoid that trap)
//   ocs:get_services() -> [#service{}]   (plain list, NOT {ok, List})
//   ocs:delete_service(Identity) -> ok
//   ocs:find_product(ProductRef) -> {ok, #product{}} | {error, not_found}
//   ocs:delete_product(ProductRef) -> ok  (aborts with service_exists if
//     #product.service is still non-empty — always delete_service every
//     linked identity first)
//
// Reconciliation mirrors this project's own established sync-subscribers
// idiom (ims-controller.ts/sms-controller.ts: main loop only ever inserts/
// updates, so a separate pass deletes anything no longer in the current
// subscriber set) — every #service{} in OCS whose name isn't one of the
// current sync run's identities gets deleted, then its now-possibly-orphaned
// product is deleted too if nothing else references it.
export function erlBinLit(s: string): string {
  return `<<"${escapeErlString(s)}"/utf8>>`;
}

export async function syncOcsSubscribers(
  offerId: string,
  subs: Array<{ imsi: string; msisdn?: string }>,
): Promise<{ ok: boolean; synced: number; failed: number; removed: number; error?: string }> {
  const offer = escapeErlString(offerId);
  const subsLit = subs
    .map(s => `{${erlBinLit(s.imsi)}, ${s.msisdn ? erlBinLit(s.msisdn) : 'undefined'}}`)
    .join(', ');
  // Two traps hit live getting this eval script right (2026-09-16):
  // (1) No record syntax anywhere below — a bare `-eval` shell has no .hrl
  //     loaded, so #service{...}/#product{...} pattern matching fails
  //     outright with {undefined_record,...}. Real field positions
  //     instead, confirmed against ocs.hrl's actual -record() definitions
  //     (fetched from the public repo, same session): #service{}
  //     tag+name(2)+start_date+end_date+state+password+attributes+
  //     product(8)+enabled+disconnect+session_attributes+characteristics+
  //     multisession+last_modified(14) — name=2, product=8. #product{}
  //     tag+id+name+start_date+end_date+status+product/*offering*/(7)+
  //     characteristics+payment+balance+service(11)+last_modified(12) —
  //     service=11 (the linked ServiceRefs list delete_product needs empty).
  // (2) Every `ocs:*` call MUST go through `rpc:call('ocs@open5gs-core',
  //     ocs, F, A)`, never called locally as `ocs:F(A)` — this throwaway
  //     node has no `ocs` application loaded at all (confirmed live:
  //     `{undef,[{ocs,find_service,...}]}` on the very first direct-call
  //     attempt), exactly the same trap addSmfAsOcsClient()'s own comment
  //     above already documents and this function's first draft still
  //     walked straight into. `Ocs(F, A)` below is the wrapper — every
  //     single call site uses it, no exceptions.
  const evalScript = [
    `Node = '${await getOcsNodeName()}',`,
    `Ocs = fun(F, A) -> rpc:call(Node, ocs, F, A) end,`,
    `Subs = [${subsLit}],`,
    `OfferId = "${offer}",`,
    // Real, 2026-09-24 finding: this used to call EnsureLinked separately
    // per identity (fun(Id) -> ...), so a subscriber whose IMSI AND MSISDN
    // both had no product yet got TWO independent Ocs(add_product,...)
    // calls — the exact same "split identity" bug already found and fixed
    // once in charging-plans-controller.ts's EnsurePlan (2026-09-17, see its
    // own header comment), just never ported to this sibling function.
    // Confirmed live on production: a real subscriber ended up with IMSI on
    // a real Charging Plan's product and MSISDN separately auto-linked to
    // the (at the time, stale) defaultOfferId — Gy (IMSI-keyed) and Ro
    // (MSISDN-keyed) usage silently drew from disconnected pools. Fixed
    // below to gather BOTH identities first and issue at most ONE
    // Ocs(add_product,...) covering whichever of them have no product yet —
    // deliberately NOT reusing EnsurePlan's "always move to target offer"
    // semantics: unlike Charging Plans' explicit reassignment, this sync's
    // job is only to provision identities that have NO product at all yet.
    // An identity already linked to ANY product (a real Charging Plan, or a
    // subscriber manually managed via OCS's own web GUI) is left alone,
    // matching this function's own pre-existing "already linked, leave it"
    // behavior for the single-identity case — never reassigned here.
    `EnsureLinkedPair = fun(Ids) ->`,
    `  ExistingIds = [Id || Id <- Ids, Id =/= undefined],`,
    `  case ExistingIds of`,
    `    [] -> ok;`,
    `    _ ->`,
    `      Svcs = [ case Ocs(find_service, [Id]) of`,
    `        {ok, S} -> S;`,
    `        {error, not_found} ->`,
    `          case Ocs(add_service, [Id, undefined]) of`,
    `            {ok, NewSvc} -> NewSvc;`,
    `            {error, _} -> error`,
    `          end`,
    `      end || Id <- ExistingIds ],`,
    `      case lists:member(error, Svcs) of`,
    `        true -> error;`,
    `        false ->`,
    `          ProductRefs = lists:usort([ element(8, Svc) || Svc <- Svcs ]),`,
    `          case ProductRefs of`,
    `            [undefined] ->`,
    `              case Ocs(add_product, [OfferId, ExistingIds]) of`,
    `                {ok, _} -> ok;`,
    `                {error, _} -> error`,
    `              end;`,
    `            _ -> ok`,
    `          end`,
    `      end`,
    `  end`,
    `end,`,
    `SyncOne = fun({Imsi, Msisdn}) -> EnsureLinkedPair([Imsi, Msisdn]) end,`,
    `Results = [ SyncOne(S) || S <- Subs ],`,
    // Real, 2026-09-24 finding (independent of the split-identity bug
    // above): the old {R1,_} pattern only ever inspected the IMSI half of
    // each pair's result, silently ignoring whether the MSISDN half
    // actually succeeded. SyncOne now returns one atom per subscriber
    // (matching EnsureLinkedPair's own single ok/error result for both
    // identities together), so this counts the real, whole-subscriber
    // outcome.
    `SyncedOk = length([ ok || R <- Results, R =:= ok ]),`,
    `SyncedFail = length(Subs) - SyncedOk,`,
    `AllServices = Ocs(get_services, []),`,
    `KeepIds = sets:from_list(lists:flatten([ case M of undefined -> [I]; _ -> [I, M] end || {I, M} <- Subs ])),`,
    `IsStale = fun(Svc) -> not sets:is_element(element(2, Svc), KeepIds) end,`,
    `Stale = lists:filter(IsStale, AllServices),`,
    `DeleteOne = fun(Svc) ->`,
    `   Name = element(2, Svc),`,
    `   P = element(8, Svc),`,
    `   Ocs(delete_service, [Name]),`,
    `   case P of`,
    `     undefined -> ok;`,
    `     _ -> case Ocs(find_product, [P]) of`,
    `            {ok, Prod} -> case element(11, Prod) of [] -> Ocs(delete_product, [P]); _ -> ok end;`,
    `            _ -> ok`,
    `          end`,
    `   end`,
    `end,`,
    `lists:foreach(DeleteOne, Stale),`,
    `io:format("SYNC_RESULT ~p~n", [{ok, SyncedOk, SyncedFail, length(Stale)}]),`,
    `init:stop()`,
  ].join('\n');

  const scriptHostPath = `${HOST_ROOT}/tmp/.ocs-sync-${Date.now()}.erl`;
  try {
    fs.writeFileSync(scriptHostPath, evalScript, 'utf-8');
    await nsenter('chown', ['otp:otp', scriptHostPath.replace(HOST_ROOT, '')]).catch(() => {});
    const nodeSuffix = Date.now() % 100000;
    const { stdout } = await nsenter('runuser', [
      '-u', 'otp', '--',
      'bash', '-c',
      `export HOME=/home/otp; cd /home/otp; ` +
      `erl -noshell -sname ocsctl${nodeSuffix} -setcookie $(cat .erlang.cookie) ` +
      `-eval "$(cat ${scriptHostPath.replace(HOST_ROOT, '')})"`,
    ], 60000);
    const m = stdout.match(/SYNC_RESULT \{ok,(\d+),(\d+),(\d+)\}/);
    if (!m) return { ok: false, synced: 0, failed: subs.length, removed: 0, error: `Unexpected sync result: ${stdout.trim().slice(-800)}` };
    return { ok: true, synced: Number(m[1]), failed: Number(m[2]), removed: Number(m[3]) };
  } catch (err) {
    return { ok: false, synced: 0, failed: subs.length, removed: 0, error: String(err) };
  } finally {
    try { fs.unlinkSync(scriptHostPath); } catch { /* best-effort cleanup */ }
  }
}

// ── SMF freeDiameter peer (Gy ConnectPeer) ──────────────────────────────
//
// Directly modeled on vowifi-controller.ts's upsertSmfAaaPeer()/
// removeSmfAaaPeer() — the established, proven idiom for adding exactly one
// new ConnectPeer line to smf.conf without disturbing anything else in the
// file (Gx→PCRF, S6b→VoWiFi AAA if installed). Scoped to an EXCLUSIVE
// `ocs.` identity prefix, distinct from VoWiFi's own `aaa.` prefix — see
// CLAUDE.md's Gy/OCS architectural pattern entry for the full ownership
// map. SMF actively dials OUT to OCS (ConnectTo) — OCS never gets a
// matching outbound peer entry for SMF, matching the proven "exactly one
// side actively connects" rule from this codebase's own production
// incident history (CLAUDE.md pattern #13).
function upsertSmfGyPeer(raw: string, ocsIdentity: string, ocsIp: string, ocsPort: number): string {
  const peerLine = `ConnectPeer = "${ocsIdentity}" { ConnectTo = "${ocsIp}"; Port = ${ocsPort}; No_TLS; };`;
  const withoutAnyOcsPeer = raw.replace(/^[ \t]*ConnectPeer\s*=\s*"ocs\.[^"]*"[^\n]*\n?/gm, '');
  return withoutAnyOcsPeer.trimEnd() + '\n' + peerLine + '\n';
}

function removeSmfGyPeer(raw: string, ocsIdentity: string): string {
  const escaped = ocsIdentity.replace(/\./g, '\\.');
  const re = new RegExp(`^[ \\t]*ConnectPeer\\s*=\\s*"${escaped}"[^\n]*\n?`, 'm');
  return raw.replace(re, '');
}

async function isCodecOrServiceActive(unit: string): Promise<boolean> {
  try {
    const { stdout } = await nsenter('systemctl', ['is-active', unit]);
    return stdout.trim() === 'active';
  } catch { return false; }
}

// ── Install / Configure ─────────────────────────────────────────────────

export async function installOcs(write: (s: string) => void): Promise<{ success: boolean; error?: string }> {
  try {
    write('=== Registering SigScale package repository (asia-east1-apt.pkg.dev) ===');
    const bootstrapExit: number = await new Promise((resolve) => {
      const child = exec(`nsenter -t 1 -m -u -i -p -- bash -c '` +
        `cd /tmp && ` +
        `curl -sLO https://asia-east1-apt.pkg.dev/projects/sigscale-release/pool/ubuntu-noble/sigscale-release_1.4.5-1+ubuntu24.04_all_dccb359ae044de02cad8f728fb007658.deb && ` +
        `dpkg -i sigscale-release_*.deb && apt-get update'`);
      child.stdout?.on('data', (d: Buffer) => write(d.toString()));
      child.stderr?.on('data', (d: Buffer) => write(d.toString()));
      child.on('close', (code) => resolve(code ?? 1));
    });
    if (bootstrapExit !== 0) {
      write(`\n❌ Repository bootstrap failed (exit ${bootstrapExit}).`);
      return { success: false, error: `bootstrap exit ${bootstrapExit}` };
    }

    write('\n=== Installing ocs package (this also runs SigScale\'s own Mnesia schema init on first install) ===');
    const installExit: number = await new Promise((resolve) => {
      const child = exec(`nsenter -t 1 -m -u -i -p -- bash -c 'DEBIAN_FRONTEND=noninteractive apt-get install -y ocs'`);
      child.stdout?.on('data', (d: Buffer) => write(d.toString()));
      child.stderr?.on('data', (d: Buffer) => write(d.toString()));
      child.on('close', (code) => resolve(code ?? 1));
    });
    // apt itself can report success (dpkg ii) even though the package's own
    // postinst additionally tries an eager service start that fails on a
    // fresh install (our own dedicated bind IP/port aren't wired in yet at
    // this point) — that failure is expected and harmless here, Configure
    // fixes it. Don't treat a non-zero eager-start inside postinst as an
    // apt install failure; verify what actually matters below instead.
    write(installExit === 0 ? '\n✅ ocs package installed.' : `\n⚠️  apt-get install exited ${installExit} — checking real state anyway.`);

    const dbPath = `${HOST_OTP_HOME}/db`;
    const mnesiaOk = fs.existsSync(dbPath) && fs.readdirSync(dbPath).length > 0;
    write(mnesiaOk
      ? '✅ Mnesia schema initialized (real tables present in /home/otp/db).'
      : '⚠️  /home/otp/db is empty — Mnesia schema init may not have completed. Check manually before Configuring.');

    write('\n✅ Install complete. Run Configure next.');
    const existing = readState();
    writeState({ ...(existing ?? stateDefaults()), installedWithVersion: getAppVersion() });
    return { success: mnesiaOk };
  } catch (err) {
    write(`\n❌ Install error: ${String(err)}`);
    return { success: false, error: String(err) };
  }
}

export async function configureOcs(
  input: { bindIp?: string; httpPort?: number; originHost?: string; originRealm?: string; defaultOfferId?: string },
): Promise<{ success: boolean; error?: string; gyPeerOpen?: boolean; defaultOfferId?: string }> {
  try {
    const release = resolveActiveRelease();
    if (!release) {
      return { success: false, error: 'OCS is not installed yet (no active OTP release found) — run Install first.' };
    }
    const existing = readState();
    const state: OcsState = {
      bindIp: input.bindIp || existing?.bindIp || DEFAULT_BIND_IP,
      httpPort: input.httpPort || existing?.httpPort || DEFAULT_HTTP_PORT,
      originHost: input.originHost || existing?.originHost || stateDefaults().originHost,
      originRealm: input.originRealm || existing?.originRealm || stateDefaults().originRealm,
      defaultOfferId: input.defaultOfferId !== undefined ? (input.defaultOfferId || undefined) : existing?.defaultOfferId,
      installedWithVersion: existing?.installedWithVersion,
    };

    // Idempotent, matches this project's per-daemon-loopback-alias
    // convention used everywhere else (Asterisk=127.0.1.4, etc).
    await nsenter('ip', ['addr', 'add', `${state.bindIp}/8`, 'dev', 'lo']).catch(() => {});

    const cfgPath = sysConfigPath(release);
    fs.writeFileSync(cfgPath, ocsSysConfig(state.bindIp, state.httpPort, state.originHost, state.originRealm, release), 'utf-8');
    // Written from this container as root — OCS's own process runs as the
    // `otp` user and will silently fail to read a root-owned file the same
    // way Asterisk/osmo-bsc do for their own config files elsewhere in this
    // project. Must chown immediately after every write.
    await nsenter('chown', ['otp:otp', cfgPath.replace(HOST_ROOT, '')]);

    await nsenter('systemctl', ['enable', '--now', SYSTEMD_UNIT]).catch(() => {});
    await nsenter('systemctl', ['restart', SYSTEMD_UNIT]);
    await new Promise(r => setTimeout(r, 3000));
    const serviceUp = await isCodecOrServiceActive(SYSTEMD_UNIT);
    if (!serviceUp) {
      return { success: false, error: 'ocs.service failed to become active after Configure — check `journalctl -u ocs` / /home/otp/log/erlang.log.1 on the host.' };
    }

    // Resolve SMF's own real bind IP the same "read the one real source of
    // truth" way this project's other cross-module peer wiring already
    // does (e.g. VoWiFi's readFreeDiameterIdentity()) rather than assuming
    // the compiled-in 127.0.0.4 default.
    const smfIp = readFreeDiameterListenOn(HOST_ROOT + '/etc/freeDiameter/smf.conf') || '127.0.0.4';

    const clientResult = await addSmfAsOcsClient(smfIp);
    if (!clientResult.ok) {
      return { success: false, error: `OCS is running but registering SMF as a trusted Diameter client failed: ${clientResult.error}` };
    }

    if (fs.existsSync(HOST_SMF_CONF)) {
      if (!fs.existsSync(HOST_SMF_CONF_BAK)) {
        fs.mkdirSync(`${HOST_ROOT}/etc/open5gs-nms`, { recursive: true });
        fs.copyFileSync(HOST_SMF_CONF, HOST_SMF_CONF_BAK);
      }
      const smfRaw = fs.readFileSync(HOST_SMF_CONF, 'utf-8');
      fs.writeFileSync(HOST_SMF_CONF, upsertSmfGyPeer(smfRaw, state.originHost, state.bindIp, DIAMETER_ACCT_PORT), 'utf-8');
      await nsenter('systemctl', ['restart', 'open5gs-smfd']);
      await new Promise(r => setTimeout(r, 3000));
      const smfUp = await isCodecOrServiceActive('open5gs-smfd');
      if (!smfUp) {
        return { success: false, error: 'open5gs-smfd failed to stay active after adding the Gy peer — this is a core NF, check `journalctl -u open5gs-smfd` immediately.' };
      }
    } else {
      return { success: false, error: 'smf.conf not found — configure the core SMF NF (Apply Config page) first.' };
    }

    // Best-effort, informational only — matches this project's "verify,
    // don't just trust success" convention without making Configure hang
    // waiting on freeDiameter's own retry/backoff timers.
    let gyPeerOpen = false;
    try {
      const { stdout } = await nsenter('bash', ['-c',
        `grep "${state.originHost}.*STATE_" /var/log/open5gs/smf.log 2>/dev/null | tail -1`]);
      gyPeerOpen = stdout.includes('STATE_OPEN');
    } catch { /* non-fatal — status endpoint will report current state on next poll */ }

    writeState({ ...state, configuredWithVersion: getAppVersion() });
    return { success: true, gyPeerOpen, defaultOfferId: state.defaultOfferId };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

// Every Open5GS subscriber is eligible (unlike SMS's own sync-subscribers,
// which only syncs MSISDN-having or gsmEnabled subscribers) — Gy
// CCR-Initial fires for ANY 4G attach regardless of MSISDN presence.
// Moved out of createOcsRouter()'s own closure (where it started as a
// route-local helper shared by /configure's auto-sync and the manual
// /sync-subscribers button) to module level so it's callable without a
// live HTTP request — see syncOcsSubscribersIfConfigured()'s own comment.
export async function collectSyncSubs(subscriberRepo: ISubscriberRepository): Promise<Array<{ imsi: string; msisdn?: string }>> {
  const allSubs = await subscriberRepo.findAllFull();
  return allSubs
    .filter(s => /^\d+$/.test(s.imsi))
    .map(s => ({ imsi: s.imsi, msisdn: s.msisdn?.[0] && /^\d+$/.test(s.msisdn[0]) ? s.msisdn[0] : undefined }));
}

// Real, 2026-09-24 finding: unlike IMS/SMS/MMS's own sync-subscribers (each
// ONLY ever reachable via a manual button, never called from any automated
// path at all), OCS's subscriber sync already had *some* automation — but
// it lived entirely in the POST /configure ROUTE HANDLER, written after
// its own call to the bare configureOcs() function returns, not inside
// configureOcs() itself. backup-restart-usecase.ts's OCS reapply calls the
// bare function directly (same as every other module) — meaning a restore
// hit this exact same gap regardless, just via a different mechanism than
// the other three (a route-only side effect vs. no automation of any
// kind). This wraps the route handler's own post-configure logic
// (collectSyncSubs → syncOcsSubscribers → persist lastSyncedAt/Counts) so
// BOTH the route and backup-restart-usecase.ts can share it — a no-op,
// clearly-flagged skip (not a silent no-sync) when defaultOfferId isn't
// set yet, matching the route's own existing subscriberSyncWarning wording.
export async function syncOcsSubscribersIfConfigured(
  subscriberRepo: ISubscriberRepository,
  defaultOfferId: string | undefined,
): Promise<{ subscriberSync?: { synced: number; failed: number; removed: number }; subscriberSyncWarning?: string }> {
  if (!defaultOfferId) {
    return { subscriberSyncWarning: 'No default Product Offering ID set — Gy is live but NO subscribers are provisioned in OCS yet. Every attach will be rejected as USER_UNKNOWN until you set an Offer ID and Sync Subscribers.' };
  }
  const subs = await collectSyncSubs(subscriberRepo);
  const syncResult = await syncOcsSubscribers(defaultOfferId, subs);
  if (!syncResult.ok) {
    return { subscriberSyncWarning: `Gy peer is live but subscriber sync failed: ${syncResult.error}. Every attach will be rejected as USER_UNKNOWN until you retry Sync Subscribers.` };
  }
  const subscriberSync = { synced: syncResult.synced, failed: syncResult.failed, removed: syncResult.removed };
  const s = readState();
  if (s) writeState({ ...s, lastSyncedAt: new Date().toISOString(), lastSyncCounts: subscriberSync });
  return { subscriberSync };
}

// Mirrors vowifi-controller.ts's own readFreeDiameterIdentity()/
// readFreeDiameterListenOn() shape — regex-extract straight out of the raw
// conf text, never a freeDiameter-aware parser (matches this project's
// established idiom for these files).
function readFreeDiameterListenOn(confPath: string): string | null {
  if (!fs.existsSync(confPath)) return null;
  try {
    const raw = fs.readFileSync(confPath, 'utf-8');
    const m = raw.match(/^\s*ListenOn\s*=\s*"([^"]+)"/m);
    return m ? m[1] : null;
  } catch { return null; }
}

// ── Router ───────────────────────────────────────────────────────────────

export function createOcsRouter(subscriberRepo: ISubscriberRepository, db: Db, logger: pino.Logger, auditLogger: IAuditLogger): Router {
  const router = Router();

  router.get('/status', async (_req: Request, res: Response) => {
    try {
      const release = resolveActiveRelease();
      const installed = !!release;
      const state = readState();
      const serviceActive = installed ? await isCodecOrServiceActive(SYSTEMD_UNIT) : false;
      const dbPath = `${HOST_OTP_HOME}/db`;
      const mnesiaInitialized = fs.existsSync(dbPath) && fs.readdirSync(dbPath).length > 0;

      let gyPeerWired = false;
      let gyPeerOpen = false;
      if (fs.existsSync(HOST_SMF_CONF) && state) {
        gyPeerWired = fs.readFileSync(HOST_SMF_CONF, 'utf-8').includes(`"${state.originHost}"`);
        try {
          const { stdout } = await nsenter('bash', ['-c',
            `grep "${state.originHost}.*STATE_" /var/log/open5gs/smf.log 2>/dev/null | tail -1`]);
          gyPeerOpen = stdout.includes('STATE_OPEN');
        } catch { /* SMF log not reachable right now — report false, not fatal */ }
      }

      let httpHealthy = false;
      if (serviceActive && state) {
        try {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 3000);
          const resp = await fetch(`http://${state.bindIp === DEFAULT_BIND_IP ? '127.0.0.1' : state.bindIp}:${state.httpPort}/health`, { signal: ctrl.signal });
          clearTimeout(t);
          httpHealthy = resp.status === 200;
        } catch { /* not up yet, or briefly restarting — not fatal */ }
      }

      res.json({
        success: true,
        installed,
        release,
        hasSavedConfig: !!state,
        serviceActive,
        mnesiaInitialized,
        httpHealthy,
        gyPeerWired,
        gyPeerOpen,
        currentConfig: state ?? stateDefaults(),
      });
    } catch (err) {
      logger.error({ err: String(err) }, 'ocs status error');
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  router.post('/install', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();
    const write = (s: string) => { res.write(s.endsWith('\n') ? s : s + '\n'); };
    const result = await installOcs(write);
    await auditLogger.log({ action: 'ocs_install', user, details: result.error ?? 'installed', success: result.success });
    res.end();
  });

  router.post('/configure', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const { bindIp, httpPort, originHost, originRealm, defaultOfferId } = req.body as { bindIp?: string; httpPort?: number; originHost?: string; originRealm?: string; defaultOfferId?: string };
    const result = await configureOcs({ bindIp, httpPort, originHost, originRealm, defaultOfferId });
    if (!result.success) {
      await auditLogger.log({ action: 'ocs_configure', user, details: result.error ?? 'failed', success: false });
      return res.status(400).json({ success: false, error: result.error });
    }

    // Ensure the default "Unlimited" Charging Plan exists on every Configure
    // — explicit user request that a no-cap plan be available out of the box,
    // not something an operator has to build by hand. Lazy import: this file
    // is already statically imported BY charging-plans-controller.ts (for
    // runOcsEval/escapeErlString/erlBinLit), so a static import in this
    // direction would be circular — see CLAUDE.md pattern #16. Best-effort:
    // a failure here (e.g. OCS Configure itself only partially succeeded)
    // must not fail the whole Configure response.
    try {
      const { ensureDefaultUnlimitedPlan } = await import('./charging-plans-controller');
      await ensureDefaultUnlimitedPlan(db);
    } catch (err) {
      logger.warn({ err: String(err) }, 'ocs configure: failed to ensure default Unlimited plan');
    }

    // Auto-seed on every Configure when an Offer is already known — this is
    // the direct fix for the 2026-09-16 incident (Gy went live with zero
    // subscribers provisioned in OCS, hard-rejecting every attach on every
    // radio). See syncOcsSubscribersIfConfigured()'s own comment — this is
    // now shared with backup-restart-usecase.ts's own OCS reapply, not just
    // this route.
    const { subscriberSync, subscriberSyncWarning } = await syncOcsSubscribersIfConfigured(subscriberRepo, result.defaultOfferId);

    await auditLogger.log({
      action: 'ocs_configure', user,
      details: `gyPeerOpen=${result.gyPeerOpen} subscriberSync=${subscriberSync ? `synced=${subscriberSync.synced}` : 'skipped'}`,
      success: true,
    });
    res.json({ success: true, gyPeerOpen: result.gyPeerOpen, subscriberSync, subscriberSyncWarning });
  });

  // POST /api/ocs/sync-subscribers — same seed+reconcile logic /configure
  // runs automatically, exposed as its own button for ongoing maintenance
  // (subscribers added/removed after the fact) — the user's own explicit
  // requirement, matching the IMS/SMS sync-subscribers precedent.
  router.post('/sync-subscribers', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const state = readState();
    if (!state?.defaultOfferId) {
      return res.status(400).json({ success: false, error: 'Set a default Product Offering ID first (Setup tab) — create the Offer in OCS\'s own web GUI, then paste its ID here.' });
    }
    const subs = await collectSyncSubs(subscriberRepo);
    const result = await syncOcsSubscribers(state.defaultOfferId, subs);
    if (!result.ok) {
      await auditLogger.log({ action: 'ocs_sync_subscribers', user, details: result.error ?? 'failed', success: false });
      return res.status(500).json({ success: false, error: result.error });
    }
    writeState({ ...state, lastSyncedAt: new Date().toISOString(), lastSyncCounts: { synced: result.synced, failed: result.failed, removed: result.removed } });
    await auditLogger.log({ action: 'ocs_sync_subscribers', user, details: `synced=${result.synced} failed=${result.failed} removed=${result.removed}`, success: true });
    res.json({ success: true, synced: result.synced, failed: result.failed, removed: result.removed });
  });

  // POST /api/ocs/users — creates the OCS web GUI / REST API login the
  // Setup tab used to just tell the operator to go create by hand over an
  // Erlang shell (`to_erl /run/ocs/`). Same button works to change the
  // password later too: setOcsUser() tries add_user first and transparently
  // falls back to update_user if the username is already taken — the
  // response's `created` flag just tells the frontend which toast to show.
  router.post('/users', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const { username, password } = req.body as { username?: string; password?: string };
    if (!username || !/^[A-Za-z0-9_.@-]{1,64}$/.test(username)) {
      return res.status(400).json({ success: false, error: 'Username must be 1-64 characters: letters, numbers, . _ @ -' });
    }
    if (!password || password.length < 4 || /[\r\n]/.test(password)) {
      return res.status(400).json({ success: false, error: 'Password must be at least 4 characters, no newlines' });
    }
    const result = await setOcsUser(username, password);
    if (!result.ok) {
      await auditLogger.log({ action: 'ocs_user_set', user, details: `username=${username}: ${result.error}`, success: false });
      return res.status(500).json({ success: false, error: result.error });
    }
    await auditLogger.log({ action: 'ocs_user_set', user, details: `username=${username} created=${result.created}`, success: true });
    res.json({ success: true, created: result.created });
  });

  router.post('/start', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      await nsenter('systemctl', ['start', SYSTEMD_UNIT]);
      await auditLogger.log({ action: 'ocs_start', user, details: '', success: true });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  router.post('/stop', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      await nsenter('systemctl', ['stop', SYSTEMD_UNIT]);
      await auditLogger.log({ action: 'ocs_stop', user, details: '', success: true });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  router.post('/restart', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      await nsenter('systemctl', ['restart', SYSTEMD_UNIT]);
      await auditLogger.log({ action: 'ocs_restart', user, details: '', success: true });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // POST /api/ocs/uninstall — removes only this module's own footprint: the
  // Gy peer line in smf.conf (restored from backup if present) and the ocs
  // service/package. Deliberately does NOT delete /home/otp/db — real
  // subscriber balance/product data lives there and apt purge itself never
  // touches it either (it's runtime-created, not part of the package's own
  // file manifest), matching this project's general caution against
  // needlessly destructive uninstalls.
  router.post('/uninstall', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();
    const write = (s: string) => { res.write(s.endsWith('\n') ? s : s + '\n'); };

    try {
      const state = readState();
      if (state && fs.existsSync(HOST_SMF_CONF)) {
        write('=== Removing Gy peer from smf.conf ===');
        // Always strip only THIS module's own Gy ConnectPeer line; never
        // restore the whole file from the pre-install backup.
        //
        // Real defect found in the 2026-10-10 readiness audit. smf.conf has
        // three independently-owned ConnectPeer lines (Gx `pcrf.*` owned by the
        // core, S6b `aaa.*` by VoWiFi, Gy `ocs.*` by this module -- CLAUDE.md
        // pattern #17), and each module snapshots the file into its OWN .bak on
        // its first Configure. So whether this restore clobbered a sibling
        // depended entirely on configure ORDERING: a backup taken before VoWiFi
        // was configured contains no `aaa.*` line, so restoring it here would
        // silently delete VoWiFi's S6b peer. The backups also predate the PLMN
        // migration, so a restore would revert Identity/Realm too.
        //
        // The targeted, prefix-scoped strip was already here in the else branch
        // and is correct in every case, so it is now the only path. The .bak is
        // kept purely as a "this module has written here" marker and removed.
        const raw = fs.readFileSync(HOST_SMF_CONF, 'utf-8');
        fs.writeFileSync(HOST_SMF_CONF, removeSmfGyPeer(raw, state.originHost), 'utf-8');
        write('Stripped this module\'s own Gy ConnectPeer line (targeted strip — sibling modules\' peers left intact).');
        if (fs.existsSync(HOST_SMF_CONF_BAK)) {
          try { fs.unlinkSync(HOST_SMF_CONF_BAK); } catch { /* marker only */ }
        }
        await nsenter('systemctl', ['restart', 'open5gs-smfd']).catch(() => {});
        await new Promise(r => setTimeout(r, 2000));
        const smfUp = await isCodecOrServiceActive('open5gs-smfd');
        write(smfUp ? '✅ open5gs-smfd restarted cleanly.' : '⚠️  open5gs-smfd did not come back active — check it manually.');
      }

      write('\n=== Stopping and purging ocs package (subscriber/balance data in /home/otp/db is left in place) ===');
      await nsenter('systemctl', ['disable', '--now', SYSTEMD_UNIT]).catch(() => {});
      const purgeExit: number = await new Promise((resolve) => {
        const child = exec(`nsenter -t 1 -m -u -i -p -- bash -c 'DEBIAN_FRONTEND=noninteractive apt-get purge -y ocs'`);
        child.stdout?.on('data', (d: Buffer) => write(d.toString()));
        child.stderr?.on('data', (d: Buffer) => write(d.toString()));
        child.on('close', (code) => resolve(code ?? 1));
      });

      try { fs.unlinkSync(HOST_STATE); } catch { /* may not exist */ }

      await auditLogger.log({ action: 'ocs_uninstall', user, details: `purge exit ${purgeExit}`, success: purgeExit === 0 });
      write(purgeExit === 0 ? '\n✅ SigScale OCS removed.' : `\n⚠️  Package purge exited ${purgeExit} (rest of teardown completed).`);
      res.end();
    } catch (err) {
      await auditLogger.log({ action: 'ocs_uninstall', user, details: String(err), success: false });
      write(`\n❌ Uninstall error: ${String(err)}`);
      res.end();
    }
  });

  // ─── Config file editor (mirrors gsm-controller.ts's /configs endpoints) ──
  router.get('/configs', async (_req: Request, res: Response) => {
    const release = resolveActiveRelease();
    const files = [
      release ? { path: sysConfigPath(release), label: 'sys.config', group: 'SigScale OCS', language: 'erlang', restartServices: [SYSTEMD_UNIT], exists: fs.existsSync(sysConfigPath(release)) } : null,
      {
        path: HOST_SMF_CONF, label: 'smf.conf (Gy peer)', group: 'Shared with core SMF / VoWiFi', language: 'ini',
        restartServices: ['open5gs-smfd'], exists: fs.existsSync(HOST_SMF_CONF),
        shared: true,
        sharedWith: 'Open5GS\'s own core SMF NF (and VoWiFi\'s S6b peer, if installed) — this module only owns its own single "ocs.*" ConnectPeer line inside it.',
      },
    ].filter(Boolean);
    res.json({ success: true, files });
  });

  router.get('/configs/content', requireAdmin, async (req: Request, res: Response) => {
    const release = resolveActiveRelease();
    const allowed = new Set([release ? sysConfigPath(release) : '', HOST_SMF_CONF]);
    const queryPath = req.query.path as string;
    if (!allowed.has(queryPath)) { res.status(403).json({ success: false, error: 'path not allowed' }); return; }
    try {
      const content = fs.existsSync(queryPath) ? fs.readFileSync(queryPath, 'utf-8') : '';
      res.json({ success: true, content });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  router.put('/configs/content', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const release = resolveActiveRelease();
    const allowed = new Set([release ? sysConfigPath(release) : '', HOST_SMF_CONF]);
    const { path: bodyPath, content } = req.body as { path: string; content: string };
    if (!allowed.has(bodyPath)) { res.status(403).json({ success: false, error: 'path not allowed' }); return; }
    try {
      fs.writeFileSync(bodyPath, content, 'utf-8');
      if (bodyPath !== HOST_SMF_CONF) await nsenter('chown', ['otp:otp', bodyPath.replace(HOST_ROOT, '')]).catch(() => {});
      await auditLogger.log({ action: 'ocs_config_save', user, details: bodyPath, success: true });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  router.post('/configs/restart', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const services = (req.body.services as string[]) || [];
    try {
      for (const svc of services) await nsenter('systemctl', ['restart', svc]);
      await auditLogger.log({ action: 'ocs_config_restart', user, details: services.join(','), success: true });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  return router;
}
