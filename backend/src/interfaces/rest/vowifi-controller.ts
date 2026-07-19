import { Router, Request, Response } from 'express';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import pino from 'pino';
import { IAuditLogger } from '../../domain/interfaces/audit-logger';
import { requireAdmin } from './middleware/auth-middleware';
import { createDummyInterface, deleteDummyInterface } from '../../infrastructure/network/dummy-interface';
import {
  nsenter, BUILD_WORKDIR, RUNTIME_BIN_DIR, OSMO_EPDG_RUNTIME_DIR, OSMO_EPDG_CONFIG_DIR,
  VOWIFI_BUILD_STEPS, VowifiBuildStep, buildVowifiScript, reloadGtpModule,
} from '../../application/use-cases/vowifi-build';

// ─── Host paths ─────────────────────────────────────────────────────────────
const HOST_STATE_FILE     = '/proc/1/root/etc/open5gs-nms/.vowifi-state.json';
const HOST_HSS_CONF       = '/proc/1/root/etc/freeDiameter/hss.conf';
const HOST_SMF_CONF       = '/proc/1/root/etc/freeDiameter/smf.conf';
const HOST_SMF_YAML       = '/proc/1/root/etc/open5gs/smf.yaml';
const HOST_SMF_CONF_BAK   = '/proc/1/root/etc/open5gs-nms/.vowifi-smf-conf.bak';
const HOST_SWANCTL_DIR    = '/proc/1/root/etc/swanctl';
const HOST_SWANCTL_CONF   = '/proc/1/root/etc/swanctl/swanctl.conf';
const HOST_STRONGSWAN_D   = '/proc/1/root/etc/strongswan.d';
const HOST_CHARON_CONF    = '/proc/1/root/etc/strongswan.d/charon.conf';
const HOST_EAP_AKA_CONF   = '/proc/1/root/etc/strongswan.d/charon/eap-aka.conf';
const HOST_SAVE_KEYS_CONF = '/proc/1/root/etc/strongswan.d/charon/save-keys.conf';
const HOST_OSMO_EPDG_TEMPLATE = `/proc/1/root${BUILD_WORKDIR}/osmo-epdg/config/sys.config`;
const HOST_OSMO_EPDG_CONFIG   = `/proc/1/root${OSMO_EPDG_CONFIG_DIR}/osmo-epdg.config`;
const HOST_SYSTEMD_DIR     = '/proc/1/root/etc/systemd/system';
const HOST_MME_YAML        = '/proc/1/root/etc/open5gs/mme.yaml';
const HOST_BIND_DIR        = '/proc/1/root/etc/bind';
const HOST_BIND_ZONES_DIR  = '/proc/1/root/etc/bind/zones';
const HOST_RUNTIME_BIN     = `/proc/1/root${RUNTIME_BIN_DIR}/osmo-epdg`;
const HOST_OSMO_EPDG_RUNTIME_DIR = `/proc/1/root${OSMO_EPDG_RUNTIME_DIR}`;
const HOST_BUILD_WORKDIR   = `/proc/1/root${BUILD_WORKDIR}`;
const LOG_FILE             = '/var/log/open5gs-nms/vowifi-install.log'; // bind-mounted, host-visible

const DUMMY_IF_NAME = 'dummy-epdg';
const DEFAULT_EPDG_IP = '10.0.1.180';
const DEFAULT_S6B_LOCAL_IP = '127.0.0.10';
const DEFAULT_GSUP_PORT = 4223;

// ─── State ──────────────────────────────────────────────────────────────────
export type VowifiInstallStatus = 'idle' | VowifiBuildStep | 'complete' | 'failed';

export interface VowifiConfigureInput {
  epdgIp?: string;
  s6bLocalIp?: string;
  gsupPort?: number;
  // 'dummy' (default): create+own a new dummy-epdg interface with epdgIp assigned to it —
  // the original, always-on behavior. 'existing': skip interface creation entirely and use
  // epdgIp as-is — for an operator who already bound it to a loopback or a real LAN
  // interface themselves (any L3-reachable IP works; osmo-epdg/strongSwan only bind to the
  // IP string, they don't care which interface owns it).
  interfaceMode?: 'dummy' | 'existing';
}

export interface VowifiState {
  installStatus: VowifiInstallStatus;
  installStartedAt: string | null;
  installCompletedAt: string | null;
  installError: string | null;
  configured: boolean;
  configuredAt: string | null;
  epdgIp: string | null;
  epdgInterfaceMode: 'dummy' | 'existing' | null;
  s6bLocalIp: string | null;
  gsupPort: number | null;
  aaaFqdn: string | null;
  smfConfHadBackup: boolean;
}

function defaultState(): VowifiState {
  return {
    installStatus: 'idle', installStartedAt: null, installCompletedAt: null, installError: null,
    configured: false, configuredAt: null,
    epdgIp: null, epdgInterfaceMode: null, s6bLocalIp: null, gsupPort: null, aaaFqdn: null,
    smfConfHadBackup: false,
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

// ─── Domain helpers ──────────────────────────────────────────────────────────

// Same convention as ims-controller.ts's readPcrfFreeDiameterInfo(): read the real,
// currently-configured address rather than hardcoding it.
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

// 3GPP TS 23.003 ePDG discovery FQDN (real UEs resolve this via DNS to find the ePDG —
// our SWu-IKEv2 test emulator bypasses this with a manual -d <ip> flag, so this was never
// exercised by that test). Reuses whatever BIND9 install already exists (from IMS, or
// installs its own if IMS isn't enabled) — see vowifi-dns-epdg-discovery memory for how
// herlesupreeth/docker_open5gs does the equivalent zone.
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

// Same shape as ims-controller.ts's removeNamedZone — used to clean up the old
// mnc/mcc.pub zone after a primary-PLMN change (this Configure route never
// tracked/removed a *previous* domain before; see configureVowifi's
// previousPubDomain param).
function removeNamedZone(raw: string, zoneName: string): string {
  const zoneRe = new RegExp(`zone\\s+"${zoneName.replace(/\./g, '\\.')}"\\s*\\{[^}]*\\};?\\s*`, 'g');
  return raw.replace(zoneRe, '');
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

// ─── Config generators ───────────────────────────────────────────────────────

// strongSwan connection definition for the ePDG's rw (road-warrior) IKEv2/EAP-AKA
// connection. `proposals` (the IKE SA itself) must be explicit, not `default` —
// confirmed empirically: strongSwan's `default` IKE proposal set does not include
// aes128-sha1-modp2048/modp1024, which is exactly what the SWu-IKEv2 test emulator
// (and real 3GPP UEs following the same mandated cipher suite) offers, so IKE_SA_INIT
// was failing with NO_PROPOSAL_CHOSEN (IKEv2 Notify type 14). `esp_proposals` for the
// child SA can stay `default` since strongSwan's default ESP set already covers
// aes128-sha256, which is what gets negotiated in practice.
function swanctlConf(epdgIp: string): string {
  return `connections {
  rw {
    local_addrs = ${epdgIp}
    local {
      auth = eap-aka
    }
    remote {
      auth = eap-aka
    }
    children {
      net {
        local_ts = 0.0.0.0/0
        esp_proposals = default
      }
    }
    version = 2
    proposals = aes128-sha1-modp2048,aes128-sha1-modp1024
  }
}
secrets {
}
pools {
}
`;
}

function eapAkaConf(): string {
  return `eap-aka {
    load = yes
    request_identity = no
}
`;
}

function saveKeysConf(): string {
  return `save-keys {
    load = yes
    esp = yes
    ike = yes
    wireshark_keys = /wireshark_keys
}
`;
}

function vowifiOsmoEpdgUnit(): string {
  // WorkingDirectory MUST be the original build tree, not a separate "clean" runtime dir:
  // the escript resolves at least one native NIF library (gen_socket_nif.so, used by
  // gen_netlink/GTP) via a path relative to cwd, baked in at rebar3-escriptize time. A
  // mismatched cwd doesn't fail loudly — the BEAM VM stays up and `systemctl is-active`
  // reports healthy, but gen_socket/gen_netlink/diameter/osmo_gsup all silently fail to
  // start, leaving SWx/S6b/GTP completely dead. Confirmed by log inspection after this bit
  // an actual test run — never assume "process is running" means "application started".
  return `[Unit]
Description=VoWiFi ePDG (osmo-epdg) — managed by open5gs-nms
After=network.target

[Service]
Type=simple
WorkingDirectory=${BUILD_WORKDIR}/osmo-epdg
Environment=HOME=${BUILD_WORKDIR}/osmo-epdg
Environment="ERL_FLAGS=-sname osmo_epdg -setcookie osmo-epdg_cookie -config ${OSMO_EPDG_CONFIG_DIR}/osmo-epdg"
ExecStartPre=-/sbin/rmmod gtp
ExecStartPre=/sbin/modprobe gtp
ExecStart=${RUNTIME_BIN_DIR}/osmo-epdg
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
`;
}

function vowifiCharonUnit(): string {
  // charon does NOT auto-load swanctl.conf on startup — connections must be pushed in
  // explicitly via `swanctl --load-all` over its vici socket. Without this ExecStartPost,
  // every restart of this unit (including cascading restarts triggered by the
  // vowifi-osmo-epdg dependency above) silently leaves charon with zero connections
  // loaded — no crash, no error, it just responds NO_PROPOSAL_CHOSEN to every IKE_SA_INIT
  // as if no config existed at all. Confirmed live: this bit a real test after an
  // unrelated restart of the osmo-epdg unit. The retry loop covers the vici socket not
  // being ready in the first instant after ExecStart.
  return `[Unit]
Description=VoWiFi ePDG (strongSwan charon, osmo_epdg plugin) — managed by open5gs-nms
After=network.target vowifi-osmo-epdg.service
Requires=vowifi-osmo-epdg.service

[Service]
Type=simple
ExecStart=/usr/local/libexec/ipsec/charon
ExecStartPost=/bin/sh -c 'for i in $(seq 1 10); do /usr/local/sbin/swanctl --load-all >/dev/null 2>&1 && exit 0; sleep 1; done; exit 1'
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
`;
}

// Copies the pristine, just-built osmo-epdg default sys.config and applies the exact
// substitutions proven working during manual testing. Deliberately does NOT regenerate
// the file from scratch — the shipped default has structure/keys beyond what's listed
// here, and reconstructing all of it by hand risks subtle Erlang term syntax errors.
function patchOsmoEpdgSysConfig(template: string, opts: {
  epdgIp: string; hssSwxIp: string; smfGtpcIp: string; s6bLocalIp: string; gsupPort: number;
  aaaFqdn: string; realm: string;
}): string {
  let content = template;
  const replaceOnce = (from: string, to: string, label: string) => {
    if (!content.includes(from)) {
      throw new Error(`osmo-epdg sys.config template is missing an expected field (${label}: "${from}") — the upstream default config may have changed. Re-check config/sys.config in the osmo-epdg source tree.`);
    }
    content = content.replace(from, to);
  };

  replaceOnce('dia_swx_remote_ip, "127.0.0.1"', `dia_swx_remote_ip, "${opts.hssSwxIp}"`, 'dia_swx_remote_ip');
  replaceOnce('gtpc_local_ip, "127.0.0.2"', `gtpc_local_ip, "${opts.epdgIp}"`, 'gtpc_local_ip');
  replaceOnce('gtpc_remote_ip, "127.0.0.1"', `gtpc_remote_ip, "${opts.smfGtpcIp}"`, 'gtpc_remote_ip');
  replaceOnce('{ip, {127,0,0,2}}', `{ip, {${opts.epdgIp.split('.').join(',')}}}`, 'gtp_u_kmod socket ip');
  replaceOnce('gsup_local_ip, "0.0.0.0"', `gsup_local_ip, "${opts.epdgIp}"`, 'gsup_local_ip');
  replaceOnce('gsup_local_port, 4222', `gsup_local_port, ${opts.gsupPort}`, 'gsup_local_port');

  // osmo-epdg's own S6b Diameter identity — the pristine template ships with stock
  // "localdomain" placeholders that were never wired up to the real PLMN's realm.
  // SMF's own S6b ConnectPeer (upsertSmfAaaPeer, below) is correctly configured to
  // expect a peer identified as `aaaFqdn` — but until osmo-epdg is ALSO told to
  // present that same identity in its own CER/CEA, the two never match. freeDiameter
  // requires "the configured Diameter Identity MUST match the information received
  // inside CEA, or the connection will be aborted" — so SMF's S6b AAR silently fails
  // with DIAMETER_UNABLE_TO_DELIVER (its ConnectPeer for aaaFqdn never opens, since
  // osmo-epdg keeps identifying itself as "aaa.localdomain" instead), which is misread
  // by Open5GS's own SMF state machine as if a Gx session existed and needs
  // terminating — the actual VoWiFi PDN session never has a chance to establish.
  // Confirmed live (2026-07-18): this was the root cause of every VoWiFi tunnel
  // attempt failing at the final IKE_AUTH step with a generic AUTHENTICATION_FAILED.
  replaceOnce('dia_s6b_origin_host, "aaa.localdomain"', `dia_s6b_origin_host, "${opts.aaaFqdn}"`, 'dia_s6b_origin_host');
  replaceOnce('dia_s6b_origin_realm, "localdomain"', `dia_s6b_origin_realm, "${opts.realm}"`, 'dia_s6b_origin_realm');
  replaceOnce('dia_s6b_context_id, "aaa@localdomain"', `dia_s6b_context_id, "aaa@${opts.realm}"`, 'dia_s6b_context_id');

  if (opts.s6bLocalIp !== '127.0.0.10' && content.includes('dia_s6b_local_ip, "127.0.0.10"')) {
    content = content.replace('dia_s6b_local_ip, "127.0.0.10"', `dia_s6b_local_ip, "${opts.s6bLocalIp}"`);
  }

  return content;
}

function upsertSmfAaaPeer(raw: string, aaaFqdn: string, s6bLocalIp: string): string {
  const peerLine = `ConnectPeer = "${aaaFqdn}" { ConnectTo = "${s6bLocalIp}"; No_TLS; };`;
  const escaped = aaaFqdn.replace(/\./g, '\\.');
  if (raw.includes(`"${aaaFqdn}"`)) {
    return raw.replace(new RegExp(`ConnectPeer\\s*=\\s*"${escaped}"[^\n]*`, 'g'), peerLine);
  }
  return raw.trimEnd() + '\n' + peerLine + '\n';
}

function removeSmfAaaPeer(raw: string, aaaFqdn: string): string {
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
    { group: 'osmo-epdg', label: 'osmo-epdg.config', path: `${OSMO_EPDG_CONFIG_DIR}/osmo-epdg.config`, language: 'erlang', restartServices: ['vowifi-osmo-epdg'] },
    { group: 'strongSwan', label: 'swanctl.conf', path: '/etc/swanctl/swanctl.conf', language: 'plaintext', restartServices: ['vowifi-charon'] },
    { group: 'strongSwan', label: 'charon.conf', path: '/etc/strongswan.d/charon.conf', language: 'plaintext', restartServices: ['vowifi-charon'] },
    { group: 'strongSwan', label: 'charon/eap-aka.conf', path: '/etc/strongswan.d/charon/eap-aka.conf', language: 'plaintext', restartServices: ['vowifi-charon'] },
    { group: 'strongSwan', label: 'charon/save-keys.conf', path: '/etc/strongswan.d/charon/save-keys.conf', language: 'plaintext', restartServices: ['vowifi-charon'] },
    { group: 'Open5GS', label: 'smf.conf (S6b peer)', path: '/etc/freeDiameter/smf.conf', language: 'plaintext', restartServices: ['open5gs-smfd'] },
    { group: 'Systemd Units', label: 'vowifi-osmo-epdg.service', path: '/etc/systemd/system/vowifi-osmo-epdg.service', language: 'ini', restartServices: ['vowifi-osmo-epdg'] },
    { group: 'Systemd Units', label: 'vowifi-charon.service', path: '/etc/systemd/system/vowifi-charon.service', language: 'ini', restartServices: ['vowifi-charon'] },
  ];
  return entries.map(e => ({ ...e, exists: fs.existsSync(`/proc/1/root${e.path}`) }));
}

function isAllowedConfigPath(p: string): boolean {
  return getVowifiConfigManifest().some(e => e.path === p);
}

// ─── Install (detached build, mirrors frr-source-build-controller.ts) ───────

async function verifyInstall(): Promise<void> {
  const s = loadState();
  const binExists = fs.existsSync(HOST_RUNTIME_BIN);
  const charonExists = fs.existsSync('/proc/1/root/usr/local/libexec/ipsec/charon');
  const ok = binExists && charonExists;
  s.installStatus = ok ? 'complete' : 'failed';
  s.installCompletedAt = new Date().toISOString();
  if (!ok) s.installError = 'Build finished but expected binaries were not found (osmo-epdg or charon).';
  saveState(s);
  appendLog(`\n==VERIFY:osmo-epdg=${binExists} charon=${charonExists}==\n`);
}

function startInstall(gsupPort: number, logger: pino.Logger): void {
  const script = buildVowifiScript({ gsupPort });
  fs.mkdirSync(HOST_BUILD_WORKDIR, { recursive: true });
  fs.writeFileSync(`${HOST_BUILD_WORKDIR}/run.sh`, script, { mode: 0o755 });

  const logFd = fs.openSync(LOG_FILE, 'a');
  const child = spawn(
    'nsenter',
    ['-t', '1', '-m', '-u', '-i', '-p', '--', 'bash', `${BUILD_WORKDIR}/run.sh`],
    { stdio: ['ignore', logFd, logFd], detached: true },
  );
  fs.closeSync(logFd);
  logger.info({ pid: child.pid }, 'VoWiFi install started (detached)');

  // Without this, a script that dies mid-step (e.g. `set -e` hitting a real error) leaves
  // the state machine stuck forever on the last-seen step, since step transitions only ever
  // move forward on sentinel lines — there was no other way to detect "the process is gone
  // and never got to done". Listened for before unref() so the exit event still fires as
  // long as this backend process itself keeps running.
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
// No internal default-fallbacks here — callers (the manual /configure route below,
// or the PLMN migration use-case) must pass a fully-populated input. Defaults for
// the manual-UI path live only in the thin route wrapper. Status-differentiated
// failures (409 "not installed" vs 400 validation vs 500 unexpected) are carried
// via VowifiConfigureError so the route wrapper can still return the right HTTP
// status without duplicating the checks.
export class VowifiConfigureError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export interface VowifiConfigureFullInput {
  epdgIp: string;
  s6bLocalIp: string;
  gsupPort: number;
  interfaceMode: 'dummy' | 'existing';
  // If provided and different from the newly-derived pub domain, its BIND zone +
  // named.conf.local stanza are removed. This route never previously tracked or
  // cleaned up a *previous* domain (only ims-controller.ts's did, via its
  // removedDomains diff) — needed so a primary-PLMN change doesn't leave the old
  // mnc/mcc.pub zone orphaned forever.
  previousPubDomain?: string;
}

export async function configureVowifi(input: VowifiConfigureFullInput): Promise<{
  epdgIp: string; interfaceMode: 'dummy' | 'existing'; s6bLocalIp: string; gsupPort: number;
  aaaFqdn: string; hssSwxIp: string; smfGtpcIp: string; smfActive: boolean; dnsConfigured: boolean;
}> {
  const { epdgIp, s6bLocalIp, gsupPort, interfaceMode, previousPubDomain } = input;

  const state = loadState();
  if (state.installStatus !== 'complete') {
    throw new VowifiConfigureError('Run Install first — VoWiFi is not built yet.', 409);
  }

  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(epdgIp)) {
    throw new VowifiConfigureError('Invalid epdgIp', 400);
  }
  if (!/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(s6bLocalIp)) {
    throw new VowifiConfigureError('S6b local IP must be a loopback (127.0.0.0/8) address — SMF cannot route loopback-sourced Diameter traffic to a non-loopback local destination.', 400);
  }

  // 1. ePDG local IP. Two modes:
  //   'dummy'    (default) — create+own a new dummy-epdg interface with epdgIp assigned
  //              (persisted across reboots, NOT advertised into EIGRP — it only needs to
  //              be reachable on this host, and EIGRP advertisement was the trigger for a
  //              real eigrpd crash-loop incident on this host).
  //   'existing' — the operator already bound epdgIp to a loopback or a real LAN
  //              interface themselves; skip interface creation entirely and just confirm
  //              it's actually present on the host before writing config that depends on
  //              being able to bind to it.
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

  // 2. Read real HSS/SMF addresses — never hardcode these.
  const hssSwxIp = readFreeDiameterListenOn(HOST_HSS_CONF, '127.0.0.8');
  const smfGtpcIp = readSmfGtpcAddress();
  const smfIdentity = readFreeDiameterIdentity(HOST_SMF_CONF, 'smf.localdomain');
  const realm = realmFromIdentity(smfIdentity);
  const aaaFqdn = `aaa.${realm}`;

  // 3. osmo-epdg config, from the pristine build template
  if (!fs.existsSync(HOST_OSMO_EPDG_TEMPLATE)) {
    throw new VowifiConfigureError(`osmo-epdg config template not found at ${BUILD_WORKDIR}/osmo-epdg/config/sys.config — the build directory may have been removed. Reinstall to regenerate it.`, 500);
  }
  const template = fs.readFileSync(HOST_OSMO_EPDG_TEMPLATE, 'utf-8');
  const patched = patchOsmoEpdgSysConfig(template, { epdgIp, hssSwxIp, smfGtpcIp, s6bLocalIp, gsupPort, aaaFqdn, realm });
  fs.mkdirSync(path.dirname(HOST_OSMO_EPDG_CONFIG), { recursive: true });
  fs.writeFileSync(HOST_OSMO_EPDG_CONFIG, patched, 'utf-8');
  fs.mkdirSync(HOST_OSMO_EPDG_RUNTIME_DIR + '/log', { recursive: true });

  // 4. strongSwan config
  fs.mkdirSync(HOST_SWANCTL_DIR, { recursive: true });
  fs.writeFileSync(HOST_SWANCTL_CONF, swanctlConf(epdgIp), 'utf-8');
  fs.mkdirSync(`${HOST_STRONGSWAN_D}/charon`, { recursive: true });
  fs.writeFileSync(HOST_EAP_AKA_CONF, eapAkaConf(), 'utf-8');
  fs.writeFileSync(HOST_SAVE_KEYS_CONF, saveKeysConf(), 'utf-8');
  if (fs.existsSync(HOST_CHARON_CONF)) {
    let charonRaw = fs.readFileSync(HOST_CHARON_CONF, 'utf-8');
    if (/^\s*#\s*force_eap_only_authentication\s*=/m.test(charonRaw)) {
      charonRaw = charonRaw.replace(/^(\s*)#\s*(force_eap_only_authentication\s*=.*)$/m, '$1$2');
    } else if (!/^\s*force_eap_only_authentication\s*=\s*yes/m.test(charonRaw)) {
      charonRaw = charonRaw.replace(/^(charon\s*\{)/m, '$1\n\tforce_eap_only_authentication = yes');
    }
    fs.writeFileSync(HOST_CHARON_CONF, charonRaw, 'utf-8');
  }

  // 5. systemd units
  fs.mkdirSync(HOST_SYSTEMD_DIR, { recursive: true });
  fs.writeFileSync(`${HOST_SYSTEMD_DIR}/vowifi-osmo-epdg.service`, vowifiOsmoEpdgUnit(), 'utf-8');
  fs.writeFileSync(`${HOST_SYSTEMD_DIR}/vowifi-charon.service`, vowifiCharonUnit(), 'utf-8');
  await nsenter('systemctl', ['daemon-reload']);

  // 6. smf.conf — exactly one new ConnectPeer line, back up first
  let smfConfHadBackup = state.smfConfHadBackup;
  if (fs.existsSync(HOST_SMF_CONF)) {
    if (!fs.existsSync(HOST_SMF_CONF_BAK)) {
      fs.copyFileSync(HOST_SMF_CONF, HOST_SMF_CONF_BAK);
      smfConfHadBackup = true;
    }
    const smfRaw = fs.readFileSync(HOST_SMF_CONF, 'utf-8');
    fs.writeFileSync(HOST_SMF_CONF, upsertSmfAaaPeer(smfRaw, aaaFqdn, s6bLocalIp), 'utf-8');
    await nsenter('systemctl', ['restart', 'open5gs-smfd']);
    await new Promise(r => setTimeout(r, 3000));
  }

  // 7. Verify Gx survived the SMF restart
  const smfActive = await nsenter('systemctl', ['is-active', 'open5gs-smfd'])
    .then(r => r.stdout.trim() === 'active').catch(() => false);

  // 8. DNS — ePDG discovery FQDN (epdg.epc.mnc<mnc>.mcc<mcc>.pub.3gppnetwork.org). Real
  // UEs resolve this to find the ePDG; the SWu-IKEv2 test emulator bypasses it with a
  // manual -d <ip> flag so this was never exercised by that test. Installs BIND9 itself
  // if not already present (e.g. IMS isn't enabled on this deployment) — see the "DNS
  // (BIND9)" page for manual editing beyond what this generates.
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
    const { mcc, mnc } = readMccMnc();
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
    await nsenter('systemctl', ['enable', '--now', 'bind9']).catch(() => {});
    await nsenter('systemctl', ['restart', 'bind9']);
    dnsConfigured = true;
  } catch { /* non-fatal — configure otherwise succeeded, logged by caller if desired */ }

  const newState: VowifiState = {
    ...state, configured: true, configuredAt: new Date().toISOString(),
    epdgIp, epdgInterfaceMode: interfaceMode, s6bLocalIp, gsupPort, aaaFqdn, smfConfHadBackup,
  };
  saveState(newState);

  return { epdgIp, interfaceMode, s6bLocalIp, gsupPort, aaaFqdn, hssSwxIp, smfGtpcIp, smfActive, dnsConfigured };
}

// ─── Router ──────────────────────────────────────────────────────────────────

export function createVowifiRouter(logger: pino.Logger, auditLogger: IAuditLogger): Router {
  const router = Router();

  router.get('/status', async (_req: Request, res: Response) => {
    try {
      const state = loadState();
      const installedOnDisk = fs.existsSync(HOST_RUNTIME_BIN) &&
        fs.existsSync('/proc/1/root/usr/local/libexec/ipsec/charon');

      const [osmoEpdgRes, charonRes] = await Promise.allSettled([
        nsenter('systemctl', ['is-active', 'vowifi-osmo-epdg']),
        nsenter('systemctl', ['is-active', 'vowifi-charon']),
      ]);
      const svcActive = (r: PromiseSettledResult<any>) => r.status === 'fulfilled' && r.value.stdout.trim() === 'active';

      const gtpModuleLoaded = await nsenter('bash', ['-c', "lsmod | grep -q '^gtp ' && echo yes || echo no"])
        .then(r => r.stdout.trim() === 'yes').catch(() => false);

      const dummyInterfaceUp = await nsenter('bash', ['-c', `ip link show ${DUMMY_IF_NAME} >/dev/null 2>&1 && echo yes || echo no`])
        .then(r => r.stdout.trim() === 'yes').catch(() => false);

      let activeIkeSas = 0;
      if (svcActive(charonRes)) {
        activeIkeSas = await nsenter('swanctl', ['--list-sas'], 10000)
          .then(r => (r.stdout.match(/ESTABLISHED/g) ?? []).length).catch(() => 0);
      }

      const smfConfExists = fs.existsSync(HOST_SMF_CONF);
      const smfConnectPeerPresent = state.aaaFqdn
        ? smfConfExists && fs.readFileSync(HOST_SMF_CONF, 'utf-8').includes(`"${state.aaaFqdn}"`)
        : false;

      res.json({
        success: true,
        installedOnDisk,
        installStatus: state.installStatus,
        installStartedAt: state.installStartedAt,
        installCompletedAt: state.installCompletedAt,
        installError: state.installError,
        configured: state.configured,
        configuredAt: state.configuredAt,
        epdgIp: state.epdgIp,
        epdgInterfaceMode: state.epdgInterfaceMode,
        s6bLocalIp: state.s6bLocalIp,
        gsupPort: state.gsupPort,
        services: {
          'vowifi-osmo-epdg': svcActive(osmoEpdgRes),
          'vowifi-charon': svcActive(charonRes),
        },
        running: svcActive(osmoEpdgRes) && svcActive(charonRes),
        gtpModuleLoaded,
        dummyInterfaceUp,
        activeIkeSas,
        smfConnectPeerPresent,
      });
    } catch (err) {
      logger.error({ err: String(err) }, 'vowifi status error');
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // POST /api/vowifi/install — detached build, mirrors FRR source-build's /start
  router.post('/install', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const current = loadState();
    if (!['idle', 'complete', 'failed'].includes(current.installStatus)) {
      return res.status(409).json({ ok: false, error: `An install is already in progress (status: ${current.installStatus})` });
    }
    try {
      const gsupPort = Number(req.body?.gsupPort) || DEFAULT_GSUP_PORT;
      const state: VowifiState = { ...defaultState(), installStatus: 'preparing', installStartedAt: new Date().toISOString() };
      saveState(state);
      appendLog(`\n==BUILD:start ts=${state.installStartedAt}==\n`);
      startInstall(gsupPort, logger);
      await auditLogger.log({ action: 'vowifi_install', user, details: `gsupPort=${gsupPort}`, success: true });
      res.json({ ok: true });
    } catch (err) {
      await auditLogger.log({ action: 'vowifi_install', user, details: String(err), success: false });
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  router.get('/install/log', (_req: Request, res: Response) => {
    res.type('text/plain').send(tailLog(100000));
  });

  router.get('/install/log/stream', (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write(tailLog(200));

    if (!fs.existsSync(LOG_FILE)) {
      fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
      fs.writeFileSync(LOG_FILE, '');
    }
    const tail = spawn('tail', ['-f', '-n', '0', LOG_FILE]);
    tail.stdout.on('data', (d: Buffer) => res.write(d));
    tail.stderr.on('data', () => {});
    const cleanup = () => { tail.kill(); };
    req.on('close', cleanup);
    tail.on('close', () => res.end());
  });

  // POST /api/vowifi/configure
  router.post('/configure', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      const body = req.body as VowifiConfigureInput;
      const epdgIp = body.epdgIp || DEFAULT_EPDG_IP;
      const s6bLocalIp = body.s6bLocalIp || DEFAULT_S6B_LOCAL_IP;
      const gsupPort = Number(body.gsupPort) || DEFAULT_GSUP_PORT;
      const interfaceMode: 'dummy' | 'existing' = body.interfaceMode === 'existing' ? 'existing' : 'dummy';

      const result = await configureVowifi({ epdgIp, s6bLocalIp, gsupPort, interfaceMode });
      if (!result.smfActive) {
        logger.error('open5gs-smfd is not active after VoWiFi configure — check smf.conf syntax');
      }
      if (!result.dnsConfigured) {
        logger.error('VoWiFi DNS zone setup failed — configure otherwise succeeded');
      }

      await auditLogger.log({ action: 'vowifi_configure', user, details: `epdgIp=${epdgIp} interfaceMode=${interfaceMode} gsupPort=${gsupPort} dnsConfigured=${result.dnsConfigured}`, success: true });
      res.json({ ok: true, ...result });
    } catch (err) {
      await auditLogger.log({ action: 'vowifi_configure', user, details: String(err), success: false });
      const status = err instanceof VowifiConfigureError ? err.status : 500;
      res.status(status).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/start', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      // `enable --now` is a no-op on an already-running unit — same class of bug found
      // and fixed in bind-controller.ts/ims-controller.ts's own Configure flows. If
      // Configure just regenerated osmo-epdg.config (e.g. a new S6b identity fix), an
      // already-running vowifi-osmo-epdg would otherwise keep serving the stale config
      // until something else happened to restart it. `enable` + unconditional
      // `restart` guarantees Start always actually applies whatever config currently
      // exists on disk, whether this is a first start or a re-start after Configure.
      await nsenter('systemctl', ['enable', 'vowifi-osmo-epdg']);
      await nsenter('systemctl', ['restart', 'vowifi-osmo-epdg']);
      await new Promise(r => setTimeout(r, 2000));
      await nsenter('systemctl', ['enable', 'vowifi-charon']);
      await nsenter('systemctl', ['restart', 'vowifi-charon']);
      await auditLogger.log({ action: 'vowifi_start', user, success: true });
      res.json({ ok: true });
    } catch (err) {
      await auditLogger.log({ action: 'vowifi_start', user, details: String(err), success: false });
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  router.post('/stop', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      await nsenter('systemctl', ['stop', 'vowifi-charon']).catch(() => {});
      await nsenter('systemctl', ['stop', 'vowifi-osmo-epdg']).catch(() => {});
      await auditLogger.log({ action: 'vowifi_stop', user, success: true });
      res.json({ ok: true });
    } catch (err) {
      await auditLogger.log({ action: 'vowifi_stop', user, details: String(err), success: false });
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  router.post('/restart', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      await nsenter('systemctl', ['stop', 'vowifi-charon']).catch(() => {});
      await nsenter('systemctl', ['restart', 'vowifi-osmo-epdg']);
      await new Promise(r => setTimeout(r, 2000));
      await nsenter('systemctl', ['start', 'vowifi-charon']);
      await auditLogger.log({ action: 'vowifi_restart', user, success: true });
      res.json({ ok: true });
    } catch (err) {
      await auditLogger.log({ action: 'vowifi_restart', user, details: String(err), success: false });
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  // POST /api/vowifi/reload-gtp-module — standalone mitigation for the known
  // gtp_u_kmod EEXIST flakiness; also runs automatically as an ExecStartPre.
  router.post('/reload-gtp-module', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      await reloadGtpModule();
      await auditLogger.log({ action: 'vowifi_reload_gtp_module', user, success: true });
      res.json({ ok: true });
    } catch (err) {
      await auditLogger.log({ action: 'vowifi_reload_gtp_module', user, details: String(err), success: false });
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  // ── Config file manifest editor (generic, same pattern as IMS) ─────────────
  router.get('/configs', (_req: Request, res: Response) => {
    res.json({ success: true, files: getVowifiConfigManifest() });
  });

  router.get('/configs/content', (req: Request, res: Response) => {
    const p = String(req.query.path ?? '');
    if (!isAllowedConfigPath(p)) return res.status(400).json({ success: false, error: 'Path not in manifest' });
    try {
      const content = fs.existsSync(`/proc/1/root${p}`) ? fs.readFileSync(`/proc/1/root${p}`, 'utf-8') : '';
      res.json({ success: true, content });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  router.put('/configs/content', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const { path: p, content } = req.body as { path: string; content: string };
    if (!isAllowedConfigPath(p)) return res.status(400).json({ success: false, error: 'Path not in manifest' });
    try {
      fs.mkdirSync(path.dirname(`/proc/1/root${p}`), { recursive: true });
      fs.writeFileSync(`/proc/1/root${p}`, content, 'utf-8');
      const entry = getVowifiConfigManifest().find(e => e.path === p);
      for (const svc of entry?.restartServices ?? []) {
        await nsenter('systemctl', ['restart', svc]).catch(() => {});
      }
      await auditLogger.log({ action: 'vowifi_config_save', user, target: p, success: true });
      res.json({ success: true });
    } catch (err) {
      await auditLogger.log({ action: 'vowifi_config_save', user, target: p, details: String(err), success: false });
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // POST /api/vowifi/uninstall — synchronous streamed teardown (fast shell ops,
  // unlike the multi-minute build — no detached-process/log-polling needed).
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

      write('=== Stopping and disabling VoWiFi services ===');
      await nsenter('systemctl', ['disable', '--now', 'vowifi-charon']).catch(() => {});
      await nsenter('systemctl', ['disable', '--now', 'vowifi-osmo-epdg']).catch(() => {});
      for (const unit of ['vowifi-charon.service', 'vowifi-osmo-epdg.service']) {
        const p = `${HOST_SYSTEMD_DIR}/${unit}`;
        if (fs.existsSync(p)) fs.unlinkSync(p);
      }
      await nsenter('systemctl', ['daemon-reload']).catch(() => {});
      write('Services stopped, disabled, and unit files removed.');

      write('\n=== Unloading gtp kernel module ===');
      // Left loaded (and gtp0 with it) after every previous uninstall — osmo-epdg is the
      // only thing that ever uses it in this deployment, and it's now stopped, so it's
      // safe to unload. Ignore failure (module may legitimately still be "in use" if
      // something else on the host happens to depend on it — non-fatal either way).
      const gtpUnloadResult = await nsenter('bash', ['-c', 'rmmod gtp 2>&1; echo "EXIT:$?"']).catch(() => ({ stdout: '', stderr: '' }));
      write(gtpUnloadResult.stdout.includes('EXIT:0')
        ? 'gtp kernel module unloaded.'
        : `gtp module unload result: ${gtpUnloadResult.stdout.trim() || '(not loaded, or already removed)'}`);

      write('\n=== Removing smf.conf S6b peer entry ===');
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
        write('No S6b peer entry was ever added to smf.conf — nothing to remove.');
      }

      if (state.epdgInterfaceMode === 'existing') {
        write('\n=== Skipping dummy-epdg removal — configured to use an existing IP, VoWiFi never created an interface ===');
      } else {
        write('\n=== Removing dummy-epdg interface ===');
        await deleteDummyInterface(DUMMY_IF_NAME).catch(() => {});
        write('dummy-epdg removed.');
      }

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
        await nsenter('systemctl', ['restart', 'bind9']).catch(() => {});
        write(`Removed zone ${pubDomain}.`);
      } catch (err) {
        write(`Could not clean up DNS zone (non-fatal): ${String(err)}`);
      }

      write('\n=== Removing strongSwan / swanctl install ===');
      const strongswanSrc = `${BUILD_WORKDIR}/strongswan-epdg`;
      const hasSrcTree = await nsenter('bash', ['-c', `[ -d ${strongswanSrc} ] && echo yes || echo no`])
        .then(r => r.stdout.trim() === 'yes').catch(() => false);
      if (hasSrcTree) {
        await nsenter('bash', ['-c', `cd ${strongswanSrc} && make uninstall 2>&1`], 60000).catch(() => {});
        write('Ran `make uninstall` from the strongswan-epdg source tree.');
      }
      await nsenter('bash', ['-c',
        'rm -rf /usr/local/sbin/swanctl /usr/local/sbin/ipsec /usr/local/libexec/ipsec ' +
        '/usr/local/lib/ipsec /etc/strongswan.d /etc/swanctl'], 30000).catch(() => {});
      write('Removed installed strongSwan binaries/plugins and /etc/strongswan.d, /etc/swanctl.');

      write('\n=== Removing osmo-epdg ===');
      await nsenter('bash', ['-c',
        `rm -rf ${RUNTIME_BIN_DIR}/osmo-epdg ${OSMO_EPDG_CONFIG_DIR} ${OSMO_EPDG_RUNTIME_DIR}`], 15000).catch(() => {});
      write('Removed osmo-epdg binary, config, and runtime directory.');

      write('\n=== Removing from-source libosmocore (leaving apt runtime .so.19 untouched) ===');
      await nsenter('bash', ['-c',
        'rm -f /usr/lib/x86_64-linux-gnu/libosmo*.so* /usr/lib/libosmo*.so* ' +
        '/usr/lib/x86_64-linux-gnu/pkgconfig/libosmo*.pc /usr/lib/pkgconfig/libosmo*.pc; ' +
        'rm -rf /usr/include/osmocom; ldconfig'], 20000).catch(() => {});

      const [hlrRes, msRes, stpRes] = await Promise.allSettled([
        nsenter('systemctl', ['is-active', 'osmo-hlr']),
        nsenter('systemctl', ['is-active', 'osmo-msc']),
        nsenter('systemctl', ['is-active', 'osmo-stp']),
      ]);
      const svcActive = (r: PromiseSettledResult<any>) => r.status === 'fulfilled' && r.value.stdout.trim() === 'active';
      write(`Post-removal check — osmo-hlr: ${svcActive(hlrRes)}, osmo-msc: ${svcActive(msRes)}, osmo-stp: ${svcActive(stpRes)} (SMS-over-SGs module must remain unaffected)`);
      if (!svcActive(hlrRes) || !svcActive(msRes) || !svcActive(stpRes)) {
        write('WARNING: one or more SMS-over-SGs services are not active after libosmocore removal — investigate before assuming this is unrelated.');
      }

      write('\n=== Removing build workdir ===');
      await nsenter('bash', ['-c', `rm -rf ${BUILD_WORKDIR}`], 30000).catch(() => {});
      write(`Removed ${BUILD_WORKDIR}.`);

      if (fs.existsSync(HOST_STATE_FILE)) fs.unlinkSync(HOST_STATE_FILE);
      if (fs.existsSync(LOG_FILE)) fs.unlinkSync(LOG_FILE);
      saveState(defaultState());

      await auditLogger.log({ action: 'vowifi_uninstall', user, success: true });
      write('\n✅ VoWiFi fully uninstalled — state reset to fresh.');
      res.end();
    } catch (err) {
      write(`\n❌ Uninstall error: ${String(err)}`);
      await auditLogger.log({ action: 'vowifi_uninstall', user, details: String(err), success: false });
      res.end();
    }
  });

  reconcileVowifiInstallState(logger).catch(err =>
    logger.error({ err: String(err) }, 'VoWiFi install-state reconciliation failed'));

  return router;
}
