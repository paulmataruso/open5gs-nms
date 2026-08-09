import { Router, Request, Response } from 'express';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import pino from 'pino';
import { IAuditLogger } from '../../domain/interfaces/audit-logger';
import { requireAdmin } from './middleware/auth-middleware';
import { createDummyInterface, deleteDummyInterface } from '../../infrastructure/network/dummy-interface';
import {
  nsenter, BUILD_WORKDIR, RUNTIME_BIN_DIR, VECTORCORE_EPDG_CONFIG_DIR, VECTORCORE_AAA_CONFIG_DIR,
  VOWIFI_BUILD_STEPS, VowifiBuildStep, buildVowifiScript,
  VECTORCORE_EPDG_COMMIT, VECTORCORE_AAA_COMMIT, VECTORCORE_PATCH_REV,
} from '../../application/use-cases/vowifi-build';

// Bumped whenever configureVowifi()'s generated output changes (epdg.yaml/
// aaa.config templates, systemd unit templates, DNS zone handling, cert
// generation, ...) — independent of VECTORCORE_PATCH_REV (source patches,
// applied at Install time) since Install and Configure are independent
// actions with independent staleness, same reasoning ims-controller.ts's
// configStale/installStale split already uses. Lets the /status endpoint's
// configStale check detect "this deployment was configured by an older
// version of this logic" without forcing a reinstall for unrelated changes.
export const VOWIFI_CONFIG_GEN_VERSION = 1;

// ─── Host paths ─────────────────────────────────────────────────────────────
const HOST_STATE_FILE     = '/proc/1/root/etc/open5gs-nms/.vowifi-state.json';
const HOST_HSS_CONF       = '/proc/1/root/etc/freeDiameter/hss.conf';
const HOST_SMF_CONF       = '/proc/1/root/etc/freeDiameter/smf.conf';
const HOST_SMF_YAML       = '/proc/1/root/etc/open5gs/smf.yaml';
const HOST_SMF_CONF_BAK   = '/proc/1/root/etc/open5gs-nms/.vowifi-smf-conf.bak';
const HOST_HSS_CONF_BAK   = '/proc/1/root/etc/open5gs-nms/.vowifi-hss-conf.bak';
const HOST_MME_YAML       = '/proc/1/root/etc/open5gs/mme.yaml';
const HOST_BIND_DIR       = '/proc/1/root/etc/bind';
const HOST_BIND_ZONES_DIR = '/proc/1/root/etc/bind/zones';
const HOST_SYSTEMD_DIR    = '/proc/1/root/etc/systemd/system';
const HOST_EPDG_RUNTIME_BIN = `/proc/1/root${RUNTIME_BIN_DIR}/epdg/bin/epdg`;
const HOST_AAA_RUNTIME_BIN  = `/proc/1/root${RUNTIME_BIN_DIR}/aaa/bin/vectorcore-aaa`;
const HOST_BUILD_WORKDIR    = `/proc/1/root${BUILD_WORKDIR}`;
const HOST_EPDG_CONFIG_DIR  = `/proc/1/root${VECTORCORE_EPDG_CONFIG_DIR}`;
const HOST_AAA_CONFIG_DIR   = `/proc/1/root${VECTORCORE_AAA_CONFIG_DIR}`;
const HOST_EPDG_YAML        = `${HOST_EPDG_CONFIG_DIR}/epdg.yaml`;
const HOST_AAA_CONFIG       = `${HOST_AAA_CONFIG_DIR}/aaa.config`;
const HOST_EPDG_CERT_DIR    = `${HOST_EPDG_CONFIG_DIR}/certs`;
const LOG_FILE              = '/var/log/open5gs-nms/vowifi-install.log'; // bind-mounted, host-visible

const DUMMY_IF_NAME = 'dummy-epdg';
const DEFAULT_EPDG_IP = '10.0.1.180';
const DEFAULT_AAA_LISTEN_IP = '127.0.0.11';
// Dedicated loopback source address for the ePDG's own SWm Diameter/SCTP connection to
// VectorCore AAA — deliberately NOT the same as epdgIp. Confirmed live 2026-08-01: an
// SCTP association sourced from a real/dummy-interface address (epdgIp) to a loopback
// destination (aaaListenIp) times out on this host with no INIT-ACK ever returned, while
// the identical connect from ANY loopback source address succeeds immediately — a
// real Docker-host netfilter/conntrack quirk with non-loopback-to-loopback SCTP, not an
// application bug. Every other Diameter interface in this project (S6a, S6b, Cx, Rx,
// etc.) already uses loopback-to-loopback for exactly this reason; SWm now follows the
// same convention instead of reusing the public-facing epdgIp.
const EPDG_SWM_LOCAL_IP = '127.0.0.16';
const AAA_DIAMETER_PORT = 3868;
// 8080 collides with PyHSS's own apiService.py (already bound 0.0.0.0:8080 on this
// host as part of the IMS module) — confirmed live 2026-08-01. 8091 follows the same
// admin-API port family as VectorCore MMSC's 8090 (see mms-controller.ts).
const ADMIN_API_PORT = 8091;

// NOTE: the archived osmo-epdg backend used a fwmark + policy-routing + nftables
// scheme here to force decrypted UE traffic out via its own kernel GTP tun device,
// since otherwise-normal routing could send it somewhere else entirely. VectorCore's
// dataplane doesn't need (and must NOT carry forward) that scheme: its TC-BPF program
// attaches directly to the kernel XFRM interface it owns (vc-xfrm0) via a TC hook,
// which sees every decrypted packet unconditionally, regardless of routing/policy —
// no fwmark or custom route required. Confirmed live 2026-08-02: carrying the old
// scheme forward anyway (with a renamed-but-never-real "vc-epdg-tun" interface
// constant) left a stale `ip rule fwmark 100 -> table vowifi_epdg -> default dev
// gtp0` policy route active on this host (gtp0 being the OLD system's device, long
// gone) — every real decrypted uplink packet got policy-routed into that dead route
// instead of ever reaching vc-xfrm0's TC-BPF program, which is exactly why
// `/api/v1/stats/bpf` showed `tc_uplink.seen: 0` despite real ESP packets arriving
// on the wire and real IKE_AUTH completing successfully. Removed entirely rather
// than fixed, since it's dead weight for this architecture, not a needed safeguard.

// ─── State ──────────────────────────────────────────────────────────────────
export type VowifiInstallStatus = 'idle' | VowifiBuildStep | 'complete' | 'failed';

export interface VowifiState {
  installStatus: VowifiInstallStatus;
  installStartedAt: string | null;
  installCompletedAt: string | null;
  installError: string | null;
  configured: boolean;
  configuredAt: string | null;
  configuredWithVersion: number | null;
  epdgIp: string | null;
  epdgInterfaceMode: 'dummy' | 'existing' | null;
  // vectorcore-aaa's own Diameter listen IP (loopback-only) — replaces the archived
  // backend's s6bLocalIp. Same underlying purpose (a private address SMF's own
  // freeDiameter ConnectPeer dials into for S6b), but now shared by SWm (from the
  // ePDG) and SWx (to the HSS) too, since vectorcore-aaa is a single Diameter stack
  // for all three interfaces rather than osmo-epdg's per-interface split.
  aaaListenIp: string | null;
  aaaFqdn: string | null;
  smfConfHadBackup: boolean;
  hssConfHadBackup: boolean;
  builtWithVectorcoreEpdgCommit: string | null;
  builtWithVectorcoreAaaCommit: string | null;
  builtWithVectorcorePatchRev: number | null;
}

function defaultState(): VowifiState {
  return {
    installStatus: 'idle', installStartedAt: null, installCompletedAt: null, installError: null,
    configured: false, configuredAt: null, configuredWithVersion: null,
    epdgIp: null, epdgInterfaceMode: null, aaaListenIp: null, aaaFqdn: null,
    smfConfHadBackup: false, hssConfHadBackup: false,
    builtWithVectorcoreEpdgCommit: null, builtWithVectorcoreAaaCommit: null, builtWithVectorcorePatchRev: null,
  };
}

export function loadState(): VowifiState {
  try {
    if (fs.existsSync(HOST_STATE_FILE)) {
      return { ...defaultState(), ...JSON.parse(fs.readFileSync(HOST_STATE_FILE, 'utf-8')) };
    }
  } catch { /* corrupt — fall through to defaults */ }
  return defaultState();
}

function saveState(state: VowifiState): void {
  const dir = path.dirname(HOST_STATE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(HOST_STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

function appendLog(msg: string): void {
  const dir = path.dirname(LOG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(LOG_FILE, msg.endsWith('\n') ? msg : msg + '\n', 'utf-8');
}

function tailLog(maxLines: number): string {
  try {
    const content = fs.readFileSync(LOG_FILE, 'utf-8');
    return content.split('\n').slice(-maxLines).join('\n');
  } catch {
    return '';
  }
}

// ─── Domain helpers (unchanged from the archived backend — generic, not
// osmo-epdg-specific: read real host state rather than hardcoding it) ───────

function readFreeDiameterIdentity(confPath: string, fallback: string): string {
  try {
    const raw = fs.readFileSync(confPath, 'utf-8');
    const m = raw.match(/^\s*Identity\s*=\s*"([^"]+)"\s*;/m);
    return m?.[1] ?? fallback;
  } catch {
    return fallback;
  }
}

function readFreeDiameterListenOn(confPath: string, fallback: string): string {
  try {
    const raw = fs.readFileSync(confPath, 'utf-8');
    const m = raw.match(/^\s*ListenOn\s*=\s*"([^"]+)"\s*;/m);
    return m?.[1] ?? fallback;
  } catch {
    return fallback;
  }
}

function realmFromIdentity(identity: string): string {
  const idx = identity.indexOf('.');
  return idx >= 0 ? identity.slice(idx + 1) : 'localdomain';
}

// Live fallbacks for the Setup form's ePDG IP / AAA Listen IP pre-fill and the
// /status endpoint, for a deployment configured before epdgIp/aaaListenIp
// tracking existed (or configured outside this NMS entirely) — same reasoning
// as the derivedAaaFqdn fallback below: the real ground truth is what's
// actually in epdg.yaml, not what this NMS instance remembers. Exported:
// swu-emulator-controller.ts's readVowifiEpdgIp() reuses this exact same
// derivation instead of duplicating it — same underlying gap (the SWu-IKEv2
// test emulator was gated on state.configured too, so it would fail with
// "VoWiFi is not configured yet" against a deployment configured before this
// tracking existed, exactly like the Setup page was).
export function readEpdgListenAddr(): string | null {
  try {
    const raw = fs.readFileSync(HOST_EPDG_YAML, 'utf-8');
    return raw.match(/^\s*listen_addr:\s*(\S+)\s*$/m)?.[1] ?? null;
  } catch {
    return null;
  }
}

function readEpdgSwmPeerAddr(): string | null {
  try {
    const raw = fs.readFileSync(HOST_EPDG_YAML, 'utf-8');
    return raw.match(/^\s*peer_addr:\s*(\S+)\s*$/m)?.[1] ?? null;
  } catch {
    return null;
  }
}

function readMccMnc(): { mcc: string; mnc: string } {
  let mcc = '001'; let mnc = '01';
  try {
    const raw = fs.readFileSync(HOST_MME_YAML, 'utf-8');
    const mccM = raw.match(/mcc:\s*['"]?(\d+)['"]?/);
    const mncM = raw.match(/mnc:\s*['"]?(\d+)['"]?/);
    if (mccM) mcc = mccM[1];
    if (mncM) mnc = mncM[1];
  } catch { /* use defaults */ }
  return { mcc, mnc };
}

function readSmfGtpcAddress(): string {
  try {
    const raw = fs.readFileSync(HOST_SMF_YAML, 'utf-8');
    const m = raw.match(/gtpc:\s*\n\s*server:\s*\n\s*-\s*address:\s*([0-9.]+)/);
    return m?.[1] ?? '127.0.0.4';
  } catch {
    return '127.0.0.4';
  }
}

// 3GPP TS 23.003 ePDG discovery FQDN — unchanged from the archived backend. Real UEs
// resolve this via DNS to find the ePDG regardless of which binary answers on the
// resolved IP; per the migration plan's explicit decision, this backend swap reuses
// the exact same zone/FQDN/virtual IP, so DNS/BIND config is untouched by this file.
function pubEpdgDomain(mcc: string, mnc: string): string {
  return `mnc${mnc.padStart(3, '0')}.mcc${mcc}.pub.3gppnetwork.org`;
}

function pubEpdgZoneFile(pubDomain: string, dnsIp: string, epdgIp: string): string {
  const serial = Math.floor(Date.now() / 1000);
  return `\$TTL 300
\$ORIGIN ${pubDomain}.

@   IN SOA   ns1 hostmaster (${serial} 3600 1800 604800 300)
@   IN NS    ns1
ns1 IN A     ${dnsIp}

epdg.epc IN A ${epdgIp}
`;
}

function bindNamedOptionsDefault(): string {
  return `options {
\tdirectory "/var/cache/bind";
\tlisten-on { any; };
\tlisten-on-v6 { ::1; };
\tallow-query { any; };
\trecursion yes;
\tforwarders { 8.8.8.8; 8.8.4.4; };
\tdnssec-validation no;
};
`;
}

function upsertNamedZone(raw: string, zoneName: string, zoneFilePath: string): string {
  const zoneBlock = `zone "${zoneName}" {\n    type master;\n    file "${zoneFilePath}";\n};\n`;
  if (raw.includes(`zone "${zoneName}"`)) {
    const zoneRe = new RegExp(`zone\\s+"${zoneName.replace(/\./g, '\\.')}"\\s*\\{[^}]*\\};?\\s*`, 'g');
    return raw.replace(zoneRe, zoneBlock);
  }
  return raw.trimEnd() + '\n\n' + zoneBlock;
}

function removeNamedZone(raw: string, zoneName: string): string {
  const zoneRe = new RegExp(`zone\\s+"${zoneName.replace(/\./g, '\\.')}"\\s*\\{[^}]*\\};?\\s*`, 'g');
  return raw.replace(zoneRe, '');
}

// Surgical single-record upsert INSIDE an existing zone file's own content — distinct
// from upsertNamedZone/removeNamedZone above, which manage the zone STANZA in
// named.conf.local, not a zone file's records. Used only for the shared internal "epc"
// zone, which is otherwise entirely owned and wholesale-regenerated by the DNS/FQDN
// Migration Wizard (dns-migration-usecase.ts, from its own fixed core-17-NF list, which
// has no notion of optional add-on modules like VoWiFi) — a merge here, never a full
// rewrite, so this "aaa" line survives untouched across VoWiFi's own repeated Configure
// calls. NOTE: re-running the Migration Wizard's own Phase C *will* wipe this line (it
// doesn't know AAA exists) — Configure must be re-run afterward to restore it, the same
// re-apply requirement plmn-migration-usecase.ts already imposes on VoWiFi's SMF/HSS
// ConnectPeer entries.
function upsertZoneRecordLine(raw: string, name: string, ip: string): string {
  const lineRe = new RegExp(`^${name}\\s+IN\\s+A\\s+\\S+\\s*$`, 'm');
  const line = `${name} IN A ${ip}`;
  return lineRe.test(raw) ? raw.replace(lineRe, line) : raw.trimEnd() + '\n' + line + '\n';
}

function removeZoneRecordLine(raw: string, name: string): string {
  const lineRe = new RegExp(`^${name}\\s+IN\\s+A\\s+\\S+\\s*\\n?`, 'm');
  return raw.replace(lineRe, '');
}

// ─── Config generators ───────────────────────────────────────────────────────

// epdg.yaml — field values per the real vendor-shipped example config (fetched and
// read directly, not guessed), mapped onto this project's PLMN/HSS/SMF constants the
// same way ims-controller.ts's template functions map PLMN constants into Kamailio
// config. See docs/vectorcore-epdg-integration-plan.md §5.2 for the full field-by-field
// reasoning; only the load-bearing decisions are called out inline below.
function epdgYamlConf(opts: {
  epdgIp: string; mcc: string; mnc: string; realm: string;
  aaaListenIp: string; smfGtpcIp: string; swmLocalIp: string;
}): string {
  const mncLength = opts.mnc.length;
  return `epdg:
  name: epdg.${opts.realm}
  realm: ${opts.realm}
  mcc: "${opts.mcc}"
  mnc: "${opts.mnc}"
  mnc_length: ${mncLength}

logging:
  level: info
  file: /var/log/vectorcore/epdg/epdg.log

api:
  # Read-only admin/diagnostics API (Huma) — no auth of its own per the vendor's own
  # docs, so this is bound to loopback only; this project's Node backend is the sole
  # client, proxied through an authenticated NMS endpoint (see the /admin/* route
  # below), same pattern already used for VectorCore MMSC's equally-unauthenticated
  # admin API in mms-controller.ts.
  enabled: true
  listen_address: 127.0.0.1
  listen_port: ${ADMIN_API_PORT}

ikev2:
  listen_addr: ${opts.epdgIp}
  cert_file: ${VECTORCORE_EPDG_CONFIG_DIR}/certs/epdg.crt
  key_file:  ${VECTORCORE_EPDG_CONFIG_DIR}/certs/epdg.key
  ca_file:   ${VECTORCORE_EPDG_CONFIG_DIR}/certs/ca.crt
  dpd_enabled: true
  dpd_delay: 30
  dpd_timeout: 120
  max_concurrent_packets: 2048
  half_open_sa_timeout: 30
  max_half_open_sas: 4096
  cookie_threshold: 2048

swm:
  local_addr: ${opts.swmLocalIp}
  peer_addr: ${opts.aaaListenIp}
  peer_port: ${AAA_DIAMETER_PORT}
  proto: sctp
  origin_host: epdg.${opts.realm}
  origin_realm: ${opts.realm}
  destination_realm: ${opts.realm}
  watchdog_interval_seconds: 30
  watchdog_timeout_seconds: 10

gtp:
  local_gtpc: ${opts.epdgIp}
  local_gtpu: ${opts.epdgIp}
  local_port: 2152
  pgw_gtpc: ${opts.smfGtpcIp}
  mtu: 1400
  validate_outer_peer: true
  strict_peer_check: true

pgw_discovery:
  # Open5GS's SMF does not publish S-NAPTR PGW-discovery records — the vendor's own
  # example config explicitly calls out disabling this for Open5GS. Followed literally,
  # not second-guessed (see integration plan §5.2).
  dns_enabled: false
  allow_s5s8_fallback: false

bpf:
  # generic (SKB) mode, not native — confirmed live on this host that XDP attaches
  # cleanly to a dummy interface in BOTH modes, but "generic works on any NIC; use
  # native for full performance on supported drivers" is the vendor's own guidance,
  # and a dummy interface is not a real NIC driver in the sense native mode assumes.
  # Safer default; revisit only if generic-mode throughput proves insufficient.
  xdp_attach_mode: generic
  xdp_interface: ${DUMMY_IF_NAME}
  map_max_entries: 20480

apn:
  default: ims

pco:
  enabled: true
  request_dns_v4: true
  request_dns_v6: false
  request_pcscf_v4: true
  request_pcscf_v6: false
  include_apco: true
  strict_decode: false

shutdown:
  timeout_seconds: 5
`;
}

// aaa.config — Erlang term format, structurally close to the archived osmo-epdg.config
// (same lager logging block verbatim) since vectorcore-aaa is a direct fork of that
// lineage. Peers list follows the same "accept-only for peers that connect to us,
// actively connect out only where we must" pattern already used throughout this
// project (P-CSCF/PCRF, I-CSCF/S-CSCF/HSS) — SWm (from the ePDG) and S6b (from SMF)
// are both accept-only here; only SWx (to the real HSS) is an active outbound peer.
function aaaConfigFile(opts: {
  aaaListenIp: string; realm: string; epdgFqdn: string; smfIdentity: string; hssSwxIp: string;
}): string {
  return `[%% ===========================================
 %% vectorcore_aaa standalone config
 %% ===========================================
 {vectorcore_aaa,
  [{diameter,
    [{origin_host, "aaa.${opts.realm}"},
     {origin_realm, "${opts.realm}"},
     {vendor_id, 0},
     {listen_ip, "${opts.aaaListenIp}"},
     {listen_port, ${AAA_DIAMETER_PORT}},
     {proto, sctp},
     {connect_timer, 30000},
     {watchdog_timer, 30000},
     {watchdog_config, [{okay, 3}, {suspect, 1}]},
     {apps, [swm, s6b, swx]},
     {peers, [
       {epdg, [{host, "${opts.epdgFqdn}"}, {apps, [swm]}]},
       {smf, [{host, "${opts.smfIdentity}"}, {apps, [s6b]}]},
       {hss, [{host, "hss.${opts.realm}"}, {ip, "${opts.hssSwxIp}"}, {port, 3868}, {connect, true}, {apps, [swx]}]}
     ]}
    ]},
   {eap_aka_prime_network_name, "wlan.${opts.realm}"}
  ]},
 %% ===========================================
 %% Lager logging config
 %% ===========================================
  {lager, [
    {log_root, "/var/log/vectorcore/aaa"},
    {colored, true},
    {handlers,
      [{lager_console_backend, [{level, info}]},
      {lager_file_backend,
        [{file, "console.log"}, {level, debug}, {size, 104857600}, {date, "$D0"}, {count, 10}]},
      {lager_file_backend,
        [{file, "error.log"}, {level, error}, {size, 104857600}, {date, "$D0"}, {count, 10}]}]},
    {crash_log, "crash.log"},
    {crash_log_msg_size, 65536},
    {crash_log_size, 104857600},
    {crash_log_date, "$D0"},
    {crash_log_count, 10},
    {error_logger_redirect, true}
  ]},
  {kernel, [
   {logger, [{handler, debug, logger_std_h,
              #{config => #{file => "/var/log/vectorcore/aaa/erlang.log"}}
            }]
    }
  ]}
].
`;
}

// Self-signed CA + ePDG certificate, generated idempotently (only if missing) —
// exact copy-paste procedure from the vendor's own README, using this project's
// existing nginx/setup-sas-cert.sh self-signed-cert pattern as the model for
// "generate once, regenerate only if missing". Real UEs will NOT trust this
// self-signed CA by default — same trust tier as this project's existing
// self-signed SAS/ACS certs (already accepted by real Sercomm/Baicells radios in
// this specific deployment's configuration), but a real limitation worth surfacing,
// not silently papered over (see integration plan §5.3's OPEN QUESTION).
function epdgCertGenScript(epdgFqdn: string): string {
  return `if [ ! -f ${VECTORCORE_EPDG_CONFIG_DIR}/certs/epdg.crt ]; then
  mkdir -p ${VECTORCORE_EPDG_CONFIG_DIR}/certs
  cd ${VECTORCORE_EPDG_CONFIG_DIR}/certs
  openssl genrsa -out ca.key 4096
  openssl req -x509 -new -nodes -key ca.key -sha256 -days 3650 -subj "/CN=open5gs-nms VectorCore ePDG Lab CA" -out ca.crt
  openssl genrsa -out epdg.key 2048
  openssl req -new -key epdg.key -subj "/CN=${epdgFqdn}" -out epdg.csr
  openssl x509 -req -in epdg.csr -CA ca.crt -CAkey ca.key -CAcreateserial -sha256 -days 825 \\
    -extfile <(printf "subjectAltName=DNS:${epdgFqdn}\\nkeyUsage=critical,digitalSignature,keyEncipherment\\nextendedKeyUsage=serverAuth") -out epdg.crt
  rm -f epdg.csr
  chmod 0640 ca.crt epdg.crt epdg.key
fi`;
}

function vectorcoreEpdgUnit(): string {
  return `[Unit]
Description=VoWiFi ePDG (VectorCore) — managed by open5gs-nms
After=network.target

[Service]
Type=simple
WorkingDirectory=${RUNTIME_BIN_DIR}
ExecStart=${RUNTIME_BIN_DIR}/epdg/bin/epdg -c ${VECTORCORE_EPDG_CONFIG_DIR}/epdg.yaml
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
`;
}

function vectorcoreAaaUnit(): string {
  return `[Unit]
Description=VoWiFi AAA (VectorCore) — managed by open5gs-nms
After=network.target

[Service]
Type=simple
Environment="ERL_FLAGS=-config ${VECTORCORE_AAA_CONFIG_DIR}/aaa"
ExecStart=${RUNTIME_BIN_DIR}/aaa/bin/vectorcore-aaa
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
`;
}

function upsertSmfAaaPeer(raw: string, aaaFqdn: string, aaaListenIp: string): string {
  const peerLine = `ConnectPeer = "${aaaFqdn}" { ConnectTo = "${aaaListenIp}"; No_TLS; };`;
  // Unconditionally strip EVERY "aaa.*" ConnectPeer entry first — this slot is
  // exclusively owned by this function — then add exactly one clean line back.
  // Carried over verbatim from the archived backend's own hard-won fix: matching
  // literally any "aaa.*" identity (not just the currently-expected one) avoids
  // leaving a stale duplicate behind across a realm change (PLMN migration) or a
  // backend swap, either of which freeDiameter's peer-election/fd_peer_add logic
  // reacts very badly to (confirmed live: ELECTION_LOST loops, or a hard SMF
  // crash-loop on a literal duplicate ConnectPeer).
  const withoutAnyAaaPeer = raw.replace(/^[ \t]*ConnectPeer\s*=\s*"aaa\.[^"]*"[^\n]*\n?/gm, '');
  return withoutAnyAaaPeer.trimEnd() + '\n' + peerLine + '\n';
}

function removeSmfAaaPeer(raw: string, aaaFqdn: string): string {
  const escaped = aaaFqdn.replace(/\./g, '\\.');
  const re = new RegExp(`^[ \\t]*ConnectPeer\\s*=\\s*"${escaped}"[^\n]*\n?`, 'm');
  return raw.replace(re, '');
}

// open5gs-hssd has real, built-in Swx support (compiled directly into the binary —
// ogs_diam_swx_init/swx_rx_mar/swx_rx_sar etc., confirmed live via `strings` on the
// binary 2026-08-01) — it does NOT need PyHSS or any translator, contrary to this
// migration's original assumption. freeDiameter's own default policy rejects any
// connecting peer whose identity has no matching ConnectPeer entry ("no_connection"
// on the AAA side, confirmed live), so this upsert is required for real Swx auth to
// ever succeed, exactly like upsertSmfAaaPeer() above for S6b.
function upsertHssAaaPeer(raw: string, aaaFqdn: string, aaaListenIp: string): string {
  const peerLine = `ConnectPeer = "${aaaFqdn}" { ConnectTo = "${aaaListenIp}"; No_TLS; };`;
  const withoutAnyAaaPeer = raw.replace(/^[ \t]*ConnectPeer\s*=\s*"aaa\.[^"]*"[^\n]*\n?/gm, '');
  // Also drop a stale, wrong "epdg.localdomain" ConnectPeer entry found live in
  // hss.conf 2026-08-01 — predates this backend entirely (file untouched since
  // 2026-07-25, a leftover from an earlier, unrelated experiment) and was never a
  // reachable real Swx peer; harmless until this migration made Swx load-bearing.
  const withoutStaleEpdgLocaldomain = withoutAnyAaaPeer.replace(/^[ \t]*ConnectPeer\s*=\s*"epdg\.localdomain"[^\n]*\n?/gm, '');
  return withoutStaleEpdgLocaldomain.trimEnd() + '\n' + peerLine + '\n';
}

function removeHssAaaPeer(raw: string, aaaFqdn: string): string {
  const escaped = aaaFqdn.replace(/\./g, '\\.');
  const re = new RegExp(`^[ \\t]*ConnectPeer\\s*=\\s*"${escaped}"[^\n]*\n?`, 'm');
  return raw.replace(re, '');
}

// ─── Config file manifest ────────────────────────────────────────────────────

interface ConfigFileEntry {
  path: string;
  label: string;
  group: string;
  language: string;
  restartServices: string[];
  exists: boolean;
}

function getVowifiConfigManifest(): ConfigFileEntry[] {
  const entries: Omit<ConfigFileEntry, 'exists'>[] = [
    { group: 'VectorCore ePDG', label: 'epdg.yaml', path: `${VECTORCORE_EPDG_CONFIG_DIR}/epdg.yaml`, language: 'yaml', restartServices: ['vowifi-vectorcore-epdg'] },
    { group: 'VectorCore AAA', label: 'aaa.config', path: `${VECTORCORE_AAA_CONFIG_DIR}/aaa.config`, language: 'erlang', restartServices: ['vowifi-vectorcore-aaa'] },
    { group: 'Open5GS', label: 'smf.conf (S6b peer)', path: '/etc/freeDiameter/smf.conf', language: 'plaintext', restartServices: ['open5gs-smfd'] },
    { group: 'Open5GS', label: 'hss.conf (Swx peer)', path: '/etc/freeDiameter/hss.conf', language: 'plaintext', restartServices: ['open5gs-hssd'] },
    { group: 'Systemd Units', label: 'vowifi-vectorcore-epdg.service', path: '/etc/systemd/system/vowifi-vectorcore-epdg.service', language: 'ini', restartServices: ['vowifi-vectorcore-epdg'] },
    { group: 'Systemd Units', label: 'vowifi-vectorcore-aaa.service', path: '/etc/systemd/system/vowifi-vectorcore-aaa.service', language: 'ini', restartServices: ['vowifi-vectorcore-aaa'] },
  ];
  return entries.map(e => ({ ...e, exists: fs.existsSync(`/proc/1/root${e.path}`) }));
}

function isAllowedConfigPath(p: string): boolean {
  return getVowifiConfigManifest().some(e => e.path === p);
}

// ─── Install (detached build, mirrors frr-source-build-controller.ts and the
// archived osmo-epdg backend's own install flow) ─────────────────────────────

async function verifyInstall(): Promise<void> {
  const s = loadState();
  const epdgExists = fs.existsSync(HOST_EPDG_RUNTIME_BIN);
  const aaaExists = fs.existsSync(HOST_AAA_RUNTIME_BIN);
  const ok = epdgExists && aaaExists;
  s.installStatus = ok ? 'complete' : 'failed';
  s.installCompletedAt = new Date().toISOString();
  if (ok) {
    s.builtWithVectorcoreEpdgCommit = VECTORCORE_EPDG_COMMIT;
    s.builtWithVectorcoreAaaCommit = VECTORCORE_AAA_COMMIT;
    s.builtWithVectorcorePatchRev = VECTORCORE_PATCH_REV;
  }
  if (!ok) s.installError = 'Build finished but expected binaries were not found (epdg or vectorcore-aaa).';
  saveState(s);
  appendLog(`\n==VERIFY:epdg=${epdgExists} vectorcore-aaa=${aaaExists}==\n`);
}

function startInstall(logger: pino.Logger): void {
  const script = buildVowifiScript();
  fs.mkdirSync(HOST_BUILD_WORKDIR, { recursive: true });
  fs.writeFileSync(`${HOST_BUILD_WORKDIR}/run.sh`, script, { mode: 0o755 });

  const logFd = fs.openSync(LOG_FILE, 'a');
  const child = spawn(
    'nsenter',
    ['-t', '1', '-m', '-u', '-i', '-p', '--', 'bash', `${BUILD_WORKDIR}/run.sh`],
    { stdio: ['ignore', logFd, logFd], detached: true },
  );
  fs.closeSync(logFd);
  logger.info({ pid: child.pid }, 'VoWiFi (VectorCore) install started (detached)');

  let processExited = false;
  child.on('exit', () => { processExited = true; });
  child.unref();

  const poll = setInterval(() => {
    const state = loadState();
    if (state.installStatus === 'complete' || state.installStatus === 'failed') {
      clearInterval(poll);
      return;
    }
    let content = '';
    try { content = fs.readFileSync(LOG_FILE, 'utf-8'); } catch { return; }

    if (processExited && !content.includes('==STEP:done==')) {
      clearInterval(poll);
      const s = loadState();
      s.installStatus = 'failed';
      s.installCompletedAt = new Date().toISOString();
      s.installError = 'The build process exited before completing — check the install log for the actual error.';
      saveState(s);
      appendLog('\n==BUILD:process exited early, marking failed==\n');
      return;
    }

    const stepMatches = [...content.matchAll(/==STEP:([a-z_]+)==/g)];
    if (stepMatches.length > 0) {
      const lastStep = stepMatches[stepMatches.length - 1][1];
      if (lastStep === 'done') {
        clearInterval(poll);
        verifyInstall().catch(err => {
          const s = loadState();
          s.installStatus = 'failed';
          s.installCompletedAt = new Date().toISOString();
          s.installError = String(err);
          saveState(s);
        });
        return;
      }
      if ((VOWIFI_BUILD_STEPS as readonly string[]).includes(lastStep)) {
        const s = loadState();
        s.installStatus = lastStep as VowifiBuildStep;
        saveState(s);
      }
    }
  }, 3000);
}

export async function reconcileVowifiInstallState(logger: pino.Logger): Promise<void> {
  const state = loadState();
  const terminal: VowifiInstallStatus[] = ['idle', 'complete', 'failed'];
  if (terminal.includes(state.installStatus)) return;

  let content = '';
  try { content = fs.readFileSync(LOG_FILE, 'utf-8'); } catch {
    state.installStatus = 'failed';
    state.installError = 'Backend restarted and no install log was found — state unknown';
    saveState(state);
    return;
  }
  if (content.includes('==STEP:done==')) {
    await verifyInstall();
  } else {
    logger.warn('Backend restarted while a VoWiFi install appears to still be in progress on the host — leaving state as-is; check /api/vowifi/install/log');
  }
}

// ─── Configure (extracted for reuse by the PLMN Migration Wizard) ────────────
export class VowifiConfigureError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export interface VowifiConfigureFullInput {
  epdgIp: string;
  aaaListenIp: string;
  interfaceMode: 'dummy' | 'existing';
  previousPubDomain?: string;
}

export async function configureVowifi(input: VowifiConfigureFullInput): Promise<{
  epdgIp: string; interfaceMode: 'dummy' | 'existing'; aaaListenIp: string;
  aaaFqdn: string; hssSwxIp: string; smfGtpcIp: string; smfActive: boolean; hssActive: boolean; dnsConfigured: boolean;
}> {
  const { epdgIp, aaaListenIp, interfaceMode, previousPubDomain } = input;

  const state = loadState();
  if (state.installStatus !== 'complete') {
    throw new VowifiConfigureError('Run Install first — VoWiFi is not built yet.', 409);
  }

  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(epdgIp)) {
    throw new VowifiConfigureError('Invalid epdgIp', 400);
  }
  if (!/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(aaaListenIp)) {
    throw new VowifiConfigureError('AAA listen IP must be a loopback (127.0.0.0/8) address — SMF cannot route loopback-sourced Diameter traffic to a non-loopback local destination.', 400);
  }

  // 1. ePDG local IP — same dummy-interface convention as every other core NF and as
  // the archived VoWiFi backend used (not advertised into EIGRP — that was the
  // trigger for a real eigrpd crash-loop incident on this host).
  if (interfaceMode === 'dummy') {
    await createDummyInterface(DUMMY_IF_NAME, epdgIp, 24, true);
  } else {
    const ipPresent = await nsenter('bash', ['-c', `ip -o addr show | awk '{print $4}' | cut -d/ -f1 | grep -qx '${epdgIp}' && echo yes || echo no`])
      .then(r => r.stdout.trim() === 'yes').catch(() => false);
    if (!ipPresent) {
      throw new VowifiConfigureError(
        `${epdgIp} is not currently assigned to any interface on this host (checked with "ip addr show"). ` +
        `In "use existing IP" mode you must bind it yourself first — e.g. add it to a LAN interface via ` +
        `systemd-networkd/netplan, or add it as a loopback alias (ip addr add ${epdgIp}/32 dev lo) — then retry.`,
        400,
      );
    }
  }

  // 2. Read real HSS/SMF addresses and PLMN — never hardcode these.
  const hssSwxIp = readFreeDiameterListenOn(HOST_HSS_CONF, '127.0.0.8');
  const smfGtpcIp = readSmfGtpcAddress();
  const smfIdentity = readFreeDiameterIdentity(HOST_SMF_CONF, 'smf.localdomain');
  const realm = realmFromIdentity(smfIdentity);
  const aaaFqdn = `aaa.${realm}`;
  const { mcc, mnc } = readMccMnc();
  // `realm` already starts with "epc." (it's sliced straight off SMF's own freeDiameter
  // Identity, e.g. "smf.epc.mnc001.mcc001.3gppnetwork.org" -> "epc.mnc001.mcc001...") —
  // do not re-prepend "epc." here or in any of the Diameter FQDNs derived from it below,
  // that produces a real, confirmed-live "epc.epc...." double-domain bug.
  const epdgFqdn = `epdg.${realm}`;

  // 3. epdg.yaml + certs
  fs.mkdirSync(HOST_EPDG_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(HOST_EPDG_YAML, epdgYamlConf({ epdgIp, mcc, mnc, realm, aaaListenIp, smfGtpcIp, swmLocalIp: EPDG_SWM_LOCAL_IP }), 'utf-8');
  fs.mkdirSync(HOST_EPDG_CERT_DIR, { recursive: true });
  await nsenter('bash', ['-c', epdgCertGenScript(epdgFqdn)], 30000);

  // 4. aaa.config
  fs.mkdirSync(HOST_AAA_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(HOST_AAA_CONFIG, aaaConfigFile({ aaaListenIp, realm, epdgFqdn, smfIdentity, hssSwxIp }), 'utf-8');

  // 6. systemd units
  fs.mkdirSync(HOST_SYSTEMD_DIR, { recursive: true });
  fs.writeFileSync(`${HOST_SYSTEMD_DIR}/vowifi-vectorcore-epdg.service`, vectorcoreEpdgUnit(), 'utf-8');
  fs.writeFileSync(`${HOST_SYSTEMD_DIR}/vowifi-vectorcore-aaa.service`, vectorcoreAaaUnit(), 'utf-8');
  await nsenter('systemctl', ['daemon-reload']);

  // 7. smf.conf — exactly one new ConnectPeer line, back up first
  let smfConfHadBackup = state.smfConfHadBackup;
  if (fs.existsSync(HOST_SMF_CONF)) {
    if (!fs.existsSync(HOST_SMF_CONF_BAK)) {
      fs.copyFileSync(HOST_SMF_CONF, HOST_SMF_CONF_BAK);
      smfConfHadBackup = true;
    }
    const smfRaw = fs.readFileSync(HOST_SMF_CONF, 'utf-8');
    fs.writeFileSync(HOST_SMF_CONF, upsertSmfAaaPeer(smfRaw, aaaFqdn, aaaListenIp), 'utf-8');
    await nsenter('systemctl', ['restart', 'open5gs-smfd']);
    await new Promise(r => setTimeout(r, 3000));
  }

  // 7b. hss.conf — open5gs-hssd has real, built-in Swx support, but freeDiameter
  // rejects any connecting peer with no matching ConnectPeer entry ("no_connection"
  // on the AAA side, confirmed live 2026-08-01 — every real EAP-AKA' attempt failed
  // silently until this was added). Same back-up-first pattern as smf.conf above.
  let hssConfHadBackup = state.hssConfHadBackup;
  if (fs.existsSync(HOST_HSS_CONF)) {
    if (!fs.existsSync(HOST_HSS_CONF_BAK)) {
      fs.copyFileSync(HOST_HSS_CONF, HOST_HSS_CONF_BAK);
      hssConfHadBackup = true;
    }
    const hssRaw = fs.readFileSync(HOST_HSS_CONF, 'utf-8');
    fs.writeFileSync(HOST_HSS_CONF, upsertHssAaaPeer(hssRaw, aaaFqdn, aaaListenIp), 'utf-8');
    await nsenter('systemctl', ['restart', 'open5gs-hssd']);
    await new Promise(r => setTimeout(r, 3000));
  }

  // 8. Verify Gx/S6a survived the SMF/HSS restarts
  const smfActive = await nsenter('systemctl', ['is-active', 'open5gs-smfd'])
    .then(r => r.stdout.trim() === 'active').catch(() => false);
  const hssActive = await nsenter('systemctl', ['is-active', 'open5gs-hssd'])
    .then(r => r.stdout.trim() === 'active').catch(() => false);

  // 9. DNS — ePDG discovery FQDN, reused as-is per the migration plan's explicit
  // decision (§3): only which binary answers on the resolved IP changes, not the
  // discovery mechanism itself.
  let dnsConfigured = false;
  try {
    const bindInstalled = await nsenter('bash', ['-c', 'command -v named >/dev/null 2>&1 && echo yes || echo no'])
      .then(r => r.stdout.trim() === 'yes').catch(() => false);
    if (!bindInstalled) {
      await nsenter('bash', ['-c', 'DEBIAN_FRONTEND=noninteractive apt-get install -y bind9 bind9utils dnsutils 2>&1'], 120000);
    }
    fs.mkdirSync(HOST_BIND_ZONES_DIR, { recursive: true });
    if (!fs.existsSync(`${HOST_BIND_DIR}/named.conf.options`)) {
      fs.writeFileSync(`${HOST_BIND_DIR}/named.conf.options`, bindNamedOptionsDefault(), 'utf-8');
    }
    const pubDomain = pubEpdgDomain(mcc, mnc);
    const zoneFilePath = `/etc/bind/zones/${pubDomain}.zone`;
    fs.writeFileSync(`${HOST_BIND_ZONES_DIR}/${pubDomain}.zone`, pubEpdgZoneFile(pubDomain, epdgIp, epdgIp), 'utf-8');
    let namedLocalRaw = fs.existsSync(`${HOST_BIND_DIR}/named.conf.local`)
      ? fs.readFileSync(`${HOST_BIND_DIR}/named.conf.local`, 'utf-8')
      : '';
    namedLocalRaw = upsertNamedZone(namedLocalRaw, pubDomain, zoneFilePath);
    if (previousPubDomain && previousPubDomain !== pubDomain) {
      const oldZoneFile = `${HOST_BIND_ZONES_DIR}/${previousPubDomain}.zone`;
      if (fs.existsSync(oldZoneFile)) fs.unlinkSync(oldZoneFile);
      namedLocalRaw = removeNamedZone(namedLocalRaw, previousPubDomain);
    }
    fs.writeFileSync(`${HOST_BIND_DIR}/named.conf.local`, namedLocalRaw, 'utf-8');

    // "aaa" record in the shared internal epc zone — see upsertZoneRecordLine()'s
    // comment for why this is a merge into a file another module owns, not a fresh
    // write. Zone filename matches `realm` exactly (confirmed live 2026-08-01:
    // realm === "epc.mnc001.mcc001.3gppnetwork.org", the same string the Migration
    // Wizard names this zone file after).
    const epcZonePath = `${HOST_BIND_ZONES_DIR}/${realm}.zone`;
    if (fs.existsSync(epcZonePath)) {
      const epcZoneRaw = fs.readFileSync(epcZonePath, 'utf-8');
      fs.writeFileSync(epcZonePath, upsertZoneRecordLine(epcZoneRaw, 'aaa', aaaListenIp), 'utf-8');
    }

    await nsenter('systemctl', ['enable', '--now', 'bind9']).catch(() => {});
    await nsenter('systemctl', ['restart', 'bind9']);
    dnsConfigured = true;
  } catch { /* non-fatal — configure otherwise succeeded, logged by caller if desired */ }

  const newState: VowifiState = {
    ...state, configured: true, configuredAt: new Date().toISOString(),
    configuredWithVersion: VOWIFI_CONFIG_GEN_VERSION,
    epdgIp, epdgInterfaceMode: interfaceMode, aaaListenIp, aaaFqdn, smfConfHadBackup, hssConfHadBackup,
  };
  saveState(newState);

  return { epdgIp, interfaceMode, aaaListenIp, aaaFqdn, hssSwxIp, smfGtpcIp, smfActive, hssActive, dnsConfigured };
}

// ─── Router ──────────────────────────────────────────────────────────────────

export function createVowifiRouter(logger: pino.Logger, auditLogger: IAuditLogger): Router {
  const router = Router();

  router.get('/status', async (_req: Request, res: Response) => {
    try {
      const state = loadState();
      const installedOnDisk = fs.existsSync(HOST_EPDG_RUNTIME_BIN) && fs.existsSync(HOST_AAA_RUNTIME_BIN);

      const [epdgRes, aaaRes] = await Promise.allSettled([
        nsenter('systemctl', ['is-active', 'vowifi-vectorcore-epdg']),
        nsenter('systemctl', ['is-active', 'vowifi-vectorcore-aaa']),
      ]);
      const svcActive = (r: PromiseSettledResult<any>) => r.status === 'fulfilled' && r.value.stdout.trim() === 'active';

      const dummyInterfaceUp = await nsenter('bash', ['-c', `ip link show ${DUMMY_IF_NAME} >/dev/null 2>&1 && echo yes || echo no`])
        .then(r => r.stdout.trim() === 'yes').catch(() => false);

      let activeClients = 0;
      if (svcActive(epdgRes)) {
        activeClients = await nsenter('curl', ['-fsS', `http://127.0.0.1:${ADMIN_API_PORT}/api/v1/stats`], 5000)
          .then(r => JSON.parse(r.stdout)?.active_clients ?? 0).catch(() => 0);
      }

      // Prefer the tracked aaaFqdn from a Configure run through this NMS, but
      // fall back to deriving it fresh from SMF's own freeDiameter Identity —
      // the same derivation configureVowifi() itself uses — so this check
      // still reflects reality on a deployment that was configured before
      // configuredWithVersion tracking existed, or any other reason state.aaaFqdn
      // never got persisted. Real ground truth is what's actually in smf.conf,
      // not what this NMS instance remembers clicking through.
      const smfConfExists = fs.existsSync(HOST_SMF_CONF);
      const derivedAaaFqdn = state.aaaFqdn ?? (smfConfExists
        ? `aaa.${realmFromIdentity(readFreeDiameterIdentity(HOST_SMF_CONF, 'smf.localdomain'))}`
        : null);
      const smfConnectPeerPresent = derivedAaaFqdn
        ? smfConfExists && fs.readFileSync(HOST_SMF_CONF, 'utf-8').includes(`"${derivedAaaFqdn}"`)
        : false;

      // Same live-fallback reasoning as derivedAaaFqdn above, for the Setup
      // form's ePDG IP / AAA Listen IP pre-fill — without this, a deployment
      // configured before this tracking existed shows the generic placeholder
      // defaults instead of what's actually running, which risks a Configure
      // click silently repointing a working deployment at the wrong addresses.
      const derivedEpdgIp = state.epdgIp ?? readEpdgListenAddr();
      const derivedAaaListenIp = state.aaaListenIp ?? readEpdgSwmPeerAddr();
      const derivedEpdgInterfaceMode = state.epdgInterfaceMode ?? (dummyInterfaceUp ? 'dummy' : 'existing');

      const buildStale = installedOnDisk &&
        (state.builtWithVectorcoreEpdgCommit !== VECTORCORE_EPDG_COMMIT ||
         state.builtWithVectorcoreAaaCommit !== VECTORCORE_AAA_COMMIT ||
         state.builtWithVectorcorePatchRev !== VECTORCORE_PATCH_REV);

      const configStale = state.configured &&
        state.configuredWithVersion !== VOWIFI_CONFIG_GEN_VERSION;

      res.json({
        success: true,
        installedOnDisk,
        builtWithVectorcoreEpdgCommit: state.builtWithVectorcoreEpdgCommit,
        currentVectorcoreEpdgCommit: VECTORCORE_EPDG_COMMIT,
        builtWithVectorcoreAaaCommit: state.builtWithVectorcoreAaaCommit,
        currentVectorcoreAaaCommit: VECTORCORE_AAA_COMMIT,
        builtWithVectorcorePatchRev: state.builtWithVectorcorePatchRev,
        currentVectorcorePatchRev: VECTORCORE_PATCH_REV,
        buildStale,
        installStatus: state.installStatus,
        installStartedAt: state.installStartedAt,
        installCompletedAt: state.installCompletedAt,
        installError: state.installError,
        configured: state.configured,
        configuredAt: state.configuredAt,
        configuredWithVersion: state.configuredWithVersion,
        currentConfigGenVersion: VOWIFI_CONFIG_GEN_VERSION,
        configStale,
        epdgIp: derivedEpdgIp,
        epdgInterfaceMode: derivedEpdgInterfaceMode,
        aaaListenIp: derivedAaaListenIp,
        aaaFqdn: derivedAaaFqdn,
        smfConnectPeerPresent,
        dummyInterfaceUp,
        activeClients,
        services: {
          'vowifi-vectorcore-epdg': svcActive(epdgRes),
          'vowifi-vectorcore-aaa': svcActive(aaaRes),
        },
      });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  router.get('/install/log', (_req: Request, res: Response) => {
    res.type('text/plain').send(tailLog(2000));
  });

  router.get('/install/log/stream', (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();
    res.write(tailLog(500));
    let closed = false;
    req.on('close', () => { closed = true; });
    const interval = setInterval(() => {
      if (closed) { clearInterval(interval); return; }
      const state = loadState();
      if (state.installStatus === 'complete' || state.installStatus === 'failed') {
        res.write(`\n==FINAL:${state.installStatus}==\n`);
        clearInterval(interval);
        res.end();
      }
    }, 2000);
  });

  router.post('/install', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const state = loadState();
    if (!['idle', 'failed', 'complete'].includes(state.installStatus)) {
      res.status(409).json({ success: false, error: `An install is already in progress (status: ${state.installStatus})` });
      return;
    }
    const newState: VowifiState = { ...defaultState(), installStatus: 'preparing', installStartedAt: new Date().toISOString() };
    saveState(newState);
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.writeFileSync(LOG_FILE, `=== VoWiFi (VectorCore) install started ${newState.installStartedAt} by ${user} ===\n`, 'utf-8');
    startInstall(logger);
    await auditLogger.log({ action: 'vowifi_install', user, details: 'Started VectorCore ePDG/AAA install', success: true });
    res.json({ ok: true, installStatus: 'preparing' });
  });

  router.post('/configure', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      const body = req.body ?? {};
      const epdgIp = typeof body.epdgIp === 'string' && body.epdgIp ? body.epdgIp : DEFAULT_EPDG_IP;
      const aaaListenIp = typeof body.aaaListenIp === 'string' && body.aaaListenIp ? body.aaaListenIp : DEFAULT_AAA_LISTEN_IP;
      const interfaceMode: 'dummy' | 'existing' = body.interfaceMode === 'existing' ? 'existing' : 'dummy';
      const result = await configureVowifi({ epdgIp, aaaListenIp, interfaceMode });
      await auditLogger.log({ action: 'vowifi_configure', user, details: `epdgIp=${epdgIp} interfaceMode=${interfaceMode} aaaListenIp=${aaaListenIp} dnsConfigured=${result.dnsConfigured}`, success: true });
      res.json({ ok: true, ...result });
    } catch (err) {
      const status = err instanceof VowifiConfigureError ? err.status : 500;
      await auditLogger.log({ action: 'vowifi_configure', user, details: String(err), success: false });
      res.status(status).json({ ok: false, error: String(err instanceof Error ? err.message : err) });
    }
  });

  router.post('/start', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      await nsenter('systemctl', ['enable', '--now', 'vowifi-vectorcore-aaa']);
      await new Promise(r => setTimeout(r, 1500));
      // 35s, not the 20s default: the epdg unit's ExecStartPost polls up to 20s for its
      // tun device to appear before systemd reports the unit started (confirmed live
      // 2026-08-01 — the default timeout killed this exec even though the service came
      // up fine moments later).
      await nsenter('systemctl', ['enable', '--now', 'vowifi-vectorcore-epdg'], 35000);
      await auditLogger.log({ action: 'vowifi_start', user, details: 'Started vowifi-vectorcore-aaa + vowifi-vectorcore-epdg', success: true });
      res.json({ ok: true });
    } catch (err) {
      await auditLogger.log({ action: 'vowifi_start', user, details: String(err), success: false });
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  router.post('/stop', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      await nsenter('systemctl', ['disable', '--now', 'vowifi-vectorcore-epdg']).catch(() => {});
      await nsenter('systemctl', ['disable', '--now', 'vowifi-vectorcore-aaa']).catch(() => {});
      await auditLogger.log({ action: 'vowifi_stop', user, details: 'Stopped VectorCore VoWiFi services', success: true });
      res.json({ ok: true });
    } catch (err) {
      await auditLogger.log({ action: 'vowifi_stop', user, details: String(err), success: false });
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  router.post('/restart', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      await nsenter('systemctl', ['restart', 'vowifi-vectorcore-aaa']);
      await new Promise(r => setTimeout(r, 1500));
      await nsenter('systemctl', ['restart', 'vowifi-vectorcore-epdg'], 35000);
      await auditLogger.log({ action: 'vowifi_restart', user, details: 'Restarted VectorCore VoWiFi services', success: true });
      res.json({ ok: true });
    } catch (err) {
      await auditLogger.log({ action: 'vowifi_restart', user, details: String(err), success: false });
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  router.get('/configs', (_req: Request, res: Response) => {
    res.json({ success: true, configs: getVowifiConfigManifest() });
  });

  router.get('/configs/content', (req: Request, res: Response) => {
    const p = String(req.query.path ?? '');
    if (!isAllowedConfigPath(p)) { res.status(400).json({ success: false, error: 'Path not in manifest' }); return; }
    try {
      res.json({ success: true, content: fs.readFileSync(`/proc/1/root${p}`, 'utf-8') });
    } catch (err) {
      res.status(404).json({ success: false, error: String(err) });
    }
  });

  router.put('/configs/content', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const { path: p, content } = req.body ?? {};
    if (!isAllowedConfigPath(p) || typeof content !== 'string') { res.status(400).json({ success: false, error: 'Invalid request' }); return; }
    try {
      fs.writeFileSync(`/proc/1/root${p}`, content, 'utf-8');
      const entry = getVowifiConfigManifest().find(e => e.path === p);
      for (const svc of entry?.restartServices ?? []) {
        await nsenter('systemctl', ['restart', svc]).catch(() => {});
      }
      await auditLogger.log({ action: 'vowifi_config_save', user, details: `path=${p}`, success: true });
      res.json({ ok: true });
    } catch (err) {
      await auditLogger.log({ action: 'vowifi_config_save', user, details: String(err), success: false });
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  // GET /api/vowifi/admin/* — read-only proxy into VectorCore ePDG's own admin API
  // (:8080 has zero auth of its own — bound to 127.0.0.1 only, this project's own
  // session auth is the sole gate). Copied directly from mms-controller.ts's
  // existing getAdmin proxy pattern for VectorCore MMSC's equally-unauthenticated
  // admin API — same vendor, same shape, no reinvention needed.
  router.get('/admin/*', requireAdmin, async (req: Request, res: Response) => {
    const subPath = (req.params as any)[0] as string;
    const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    try {
      const { stdout } = await nsenter('curl', ['-fsS', `http://127.0.0.1:${ADMIN_API_PORT}/${subPath}${qs}`], 10000);
      res.type('application/json').send(stdout);
    } catch (err) {
      res.status(502).json({ success: false, error: String(err) });
    }
  });

  router.post('/uninstall', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();
    const write = (s: string) => { res.write(s.endsWith('\n') ? s : s + '\n'); };

    try {
      const state = loadState();

      write('=== Stopping and disabling VoWiFi (VectorCore) services ===');
      await nsenter('systemctl', ['disable', '--now', 'vowifi-vectorcore-epdg']).catch(() => {});
      await nsenter('systemctl', ['disable', '--now', 'vowifi-vectorcore-aaa']).catch(() => {});
      for (const unit of ['vowifi-vectorcore-epdg.service', 'vowifi-vectorcore-aaa.service']) {
        const p = `${HOST_SYSTEMD_DIR}/${unit}`;
        if (fs.existsSync(p)) fs.unlinkSync(p);
      }
      await nsenter('systemctl', ['daemon-reload']).catch(() => {});
      write('Services stopped, disabled, and unit files removed.');

      write('\n=== Removing smf.conf S6b/SWm peer entry ===');
      if (state.aaaFqdn && fs.existsSync(HOST_SMF_CONF)) {
        if (fs.existsSync(HOST_SMF_CONF_BAK)) {
          fs.copyFileSync(HOST_SMF_CONF_BAK, HOST_SMF_CONF);
          fs.unlinkSync(HOST_SMF_CONF_BAK);
          write('Restored smf.conf from pre-configure backup.');
        } else {
          const raw = fs.readFileSync(HOST_SMF_CONF, 'utf-8');
          fs.writeFileSync(HOST_SMF_CONF, removeSmfAaaPeer(raw, state.aaaFqdn), 'utf-8');
          write('Removed the ConnectPeer line directly (no backup was present).');
        }
        await nsenter('systemctl', ['restart', 'open5gs-smfd']).catch(() => {});
        await new Promise(r => setTimeout(r, 3000));
        const smfActive = await nsenter('systemctl', ['is-active', 'open5gs-smfd'])
          .then(r => r.stdout.trim() === 'active').catch(() => false);
        write(`SMF restarted — is-active: ${smfActive}`);
        if (!smfActive) write('WARNING: open5gs-smfd is not active — check smf.conf manually before assuming Gx is healthy.');
      } else {
        write('No S6b/SWm peer entry was ever added to smf.conf — nothing to remove.');
      }

      write('\n=== Removing hss.conf Swx peer entry ===');
      if (state.aaaFqdn && fs.existsSync(HOST_HSS_CONF)) {
        if (fs.existsSync(HOST_HSS_CONF_BAK)) {
          fs.copyFileSync(HOST_HSS_CONF_BAK, HOST_HSS_CONF);
          fs.unlinkSync(HOST_HSS_CONF_BAK);
          write('Restored hss.conf from pre-configure backup.');
        } else {
          const raw = fs.readFileSync(HOST_HSS_CONF, 'utf-8');
          fs.writeFileSync(HOST_HSS_CONF, removeHssAaaPeer(raw, state.aaaFqdn), 'utf-8');
          write('Removed the ConnectPeer line directly (no backup was present).');
        }
        await nsenter('systemctl', ['restart', 'open5gs-hssd']).catch(() => {});
        await new Promise(r => setTimeout(r, 3000));
        const hssActive = await nsenter('systemctl', ['is-active', 'open5gs-hssd'])
          .then(r => r.stdout.trim() === 'active').catch(() => false);
        write(`HSS restarted — is-active: ${hssActive}`);
        if (!hssActive) write('WARNING: open5gs-hssd is not active — check hss.conf manually before assuming S6a is healthy.');
      } else {
        write('No Swx peer entry was ever added to hss.conf — nothing to remove.');
      }

      if (state.epdgInterfaceMode === 'existing') {
        write('\n=== Skipping dummy-epdg removal — configured to use an existing IP, VoWiFi never created an interface ===');
      } else {
        write('\n=== Removing dummy-epdg interface ===');
        await deleteDummyInterface(DUMMY_IF_NAME).catch(() => {});
        write('dummy-epdg removed.');
      }

      // One-time legacy cleanup: VectorCore's own Configure/systemd-unit generation
      // never creates this fwmark/policy-routing/nftables scheme (removed 2026-08-02 —
      // it was dead weight carried over from the archived osmo-epdg backend, and on
      // this host it was actively misrouting real decrypted uplink packets into a
      // stale `default dev gtp0` route instead of vc-xfrm0's own TC-BPF program). Kept
      // here only to clean up any host that configured VoWiFi before that fix.
      write('\n=== Removing legacy fwmark policy routing + nftables marking table (if present) ===');
      await nsenter('bash', ['-c',
        'while ip rule del priority 230 2>/dev/null; do :; done; ' +
        'while ip rule del fwmark 100 table vowifi_epdg priority 230 2>/dev/null; do :; done; ' +
        'while ip rule del priority 231 2>/dev/null; do :; done; ' +
        'while ip rule del fwmark 100 priority 231 blackhole 2>/dev/null; do :; done; ' +
        'ip route flush table vowifi_epdg 2>/dev/null; ' +
        'nft delete table inet vowifi_epdg 2>/dev/null; true']).catch(() => {});
      write('Removed any legacy fwmark ip rules, flushed the routing table, deleted the nftables table.');

      write('\n=== Removing ePDG DNS zone (leaving BIND9 itself installed — shared infrastructure) ===');
      try {
        const { mcc, mnc } = readMccMnc();
        const pubDomain = pubEpdgDomain(mcc, mnc);
        const zoneFilePath = `${HOST_BIND_ZONES_DIR}/${pubDomain}.zone`;
        if (fs.existsSync(zoneFilePath)) fs.unlinkSync(zoneFilePath);
        if (fs.existsSync(`${HOST_BIND_DIR}/named.conf.local`)) {
          const raw = fs.readFileSync(`${HOST_BIND_DIR}/named.conf.local`, 'utf-8');
          const zoneRe = new RegExp(`zone\\s+"${pubDomain.replace(/\./g, '\\.')}"\\s*\\{[^}]*\\};?\\s*`, 'g');
          fs.writeFileSync(`${HOST_BIND_DIR}/named.conf.local`, raw.replace(zoneRe, ''), 'utf-8');
        }
        // "aaa" record in the shared internal epc zone — remove just this one line,
        // never the whole file (that zone belongs to the DNS Migration Wizard).
        const smfIdentityForRemoval = readFreeDiameterIdentity(HOST_SMF_CONF, 'smf.localdomain');
        const epcZonePath = `${HOST_BIND_ZONES_DIR}/${realmFromIdentity(smfIdentityForRemoval)}.zone`;
        if (fs.existsSync(epcZonePath)) {
          const epcZoneRaw = fs.readFileSync(epcZonePath, 'utf-8');
          fs.writeFileSync(epcZonePath, removeZoneRecordLine(epcZoneRaw, 'aaa'), 'utf-8');
        }
        await nsenter('systemctl', ['restart', 'bind9']).catch(() => {});
        write(`Removed zone ${pubDomain} and the "aaa" record from the internal epc zone.`);
      } catch (err) {
        write(`Could not clean up DNS zone (non-fatal): ${String(err)}`);
      }

      write('\n=== Removing VectorCore binaries, configs, and build tree ===');
      await nsenter('bash', ['-c', `rm -rf ${RUNTIME_BIN_DIR} ${VECTORCORE_EPDG_CONFIG_DIR} ${VECTORCORE_AAA_CONFIG_DIR} /var/log/vectorcore ${BUILD_WORKDIR}`], 30000).catch(() => {});
      write('Removed /opt/vectorcore, /etc/vectorcore/{epdg,aaa}, /var/log/vectorcore, and the build tree.');

      if (fs.existsSync(HOST_STATE_FILE)) fs.unlinkSync(HOST_STATE_FILE);
      if (fs.existsSync(LOG_FILE)) fs.unlinkSync(LOG_FILE);
      write('\n=== Uninstall complete ===');
      await auditLogger.log({ action: 'vowifi_uninstall', user, details: 'Uninstalled VectorCore VoWiFi backend', success: true });
    } catch (err) {
      write(`\nERROR: ${String(err)}`);
      await auditLogger.log({ action: 'vowifi_uninstall', user, details: String(err), success: false });
    }
    res.end();
  });

  return router;
}
