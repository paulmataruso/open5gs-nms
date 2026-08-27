import { Router, Request, Response } from 'express';
import { spawn, execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import pino from 'pino';
import { IAuditLogger } from '../../domain/interfaces/audit-logger';
import { requireAdmin } from './middleware/auth-middleware';
import { createDummyInterface, deleteDummyInterface, nsenter } from '../../infrastructure/network/dummy-interface';
import {
  buildSecgwScript, SECGW_PATCH_REV, SECGW_BUILD_WORKDIR, SECGW_INSTALL_PREFIX,
  SECGW_CHARON_BIN, SECGW_SWANCTL_BIN,
} from '../../application/use-cases/secgw-build';

// Bumped whenever configureSecgw()'s generated output changes (swanctl.conf template,
// per-radio conf.d template, systemd unit template, cert generation) — same reasoning as
// VOWIFI_CONFIG_GEN_VERSION in vowifi-controller.ts: lets /status's configStale check flag
// a deployment configured by an older version of this logic, independent of whether
// strongSwan itself was rebuilt. Independent of SECGW_PATCH_REV (source build, applied at
// Install time) for the same reason vowifi-controller.ts keeps its two version constants
// separate — Install and Configure are independent actions with independent staleness.
export const SECGW_CONFIG_GEN_VERSION = 2;

// ─── Host paths ─────────────────────────────────────────────────────────────
// Real host paths (no /proc/1/root prefix) — used inside nsenter'd shell scripts, which
// already run in the host's own mount namespace and so see these paths directly.
const SECGW_PKI_DIR         = '/etc/open5gs-nms/secgw/pki';
const SECGW_RADIOS_DIR      = '/etc/open5gs-nms/secgw/radios';
const SWANCTL_DIR           = '/etc/swanctl';
const SWANCTL_CONF          = `${SWANCTL_DIR}/swanctl.conf`;
const SWANCTL_CONFD_DIR     = `${SWANCTL_DIR}/conf.d`;
const SWANCTL_X509_DIR      = `${SWANCTL_DIR}/x509`;
const SWANCTL_X509CA_DIR    = `${SWANCTL_DIR}/x509ca`;
const SWANCTL_PRIVATE_DIR   = `${SWANCTL_DIR}/private`;
const STRONGSWAN_CONF       = '/etc/strongswan.conf';

// Container-view paths (/proc/1/root prefix) — used for direct Node fs access from inside
// the backend container, matching every other optional module's convention.
const HOST_SECGW_PKI_DIR       = `/proc/1/root${SECGW_PKI_DIR}`;
const HOST_SECGW_RADIOS_DIR    = `/proc/1/root${SECGW_RADIOS_DIR}`;
const HOST_STATE_FILE          = '/proc/1/root/etc/open5gs-nms/.secgw-state.json';
const HOST_SWANCTL_CONF        = `/proc/1/root${SWANCTL_CONF}`;
const HOST_SWANCTL_CONFD_DIR   = `/proc/1/root${SWANCTL_CONFD_DIR}`;
const HOST_SWANCTL_X509_DIR    = `/proc/1/root${SWANCTL_X509_DIR}`;
const HOST_SWANCTL_X509CA_DIR  = `/proc/1/root${SWANCTL_X509CA_DIR}`;
const HOST_SWANCTL_PRIVATE_DIR = `/proc/1/root${SWANCTL_PRIVATE_DIR}`;
const HOST_MME_YAML   = '/proc/1/root/etc/open5gs/mme.yaml';
const HOST_SGWU_YAML  = '/proc/1/root/etc/open5gs/sgwu.yaml';
const HOST_AMF_YAML   = '/proc/1/root/etc/open5gs/amf.yaml';
const HOST_UPF_YAML   = '/proc/1/root/etc/open5gs/upf.yaml';
const HOST_BIND_ZONES_DIR = '/proc/1/root/etc/bind/zones';

const DUMMY_IF_NAME = 'dummy-secgw';
const DEFAULT_GATEWAY_IP = '10.0.1.190';
const DEFAULT_POOL_CIDR = '10.0.1.200/29';
// This project's own source-built strongSwan (see secgw-build.ts) always installs this
// exact unit file at this canonical systemd path, so SERVICE_NAME stays 'strongswan'
// regardless of whether the distro's strongswan-swanctl/charon-systemd packages are also
// present on the host (they're unused — we build+install our own binaries under
// SECGW_INSTALL_PREFIX and never depend on the distro's runtime packages).
const SERVICE_NAME = 'strongswan';
const HOST_SYSTEMD_UNIT_PATH = '/proc/1/root/usr/lib/systemd/system/strongswan.service';

// ─── Auth mode + algorithm proposal option tables ────────────────────────────
// Mirrors the exact fields/labels Baicells' own IPsec config page exposes (Left/Right
// Auth, IKE/ESP Encryption+Auth+DH Group) — the operator picks matching values on the
// radio's own UI by hand (v1 is manual-download-only, no TR-069 push), so our own
// dropdowns need to show the same vendor labels, not just generic strongSwan jargon.
// "value" is the real strongSwan proposal keyword; "label" is what Baicells' own UI
// calls it. Only PSK and certificate (pubkey) auth are implemented — Baicells also
// lists "eap-aka" as a Left/Right Auth choice, but that would need a full subscriber-
// style AuC credential issuance flow per radio, out of scope for this version.
export type SecGwAuthMode = 'psk' | 'cert';

// Type unions are supersets covering BOTH Baicells' and Nokia's algorithm vocabularies
// (added 2026-08-14 for Nokia) — each vendor's own *_OPTIONS list below only exposes its
// own subset as dropdown choices, but the underlying strongSwan token space is shared so
// buildProposal()/isAeadCipher() work uniformly across vendors.
export type SecGwIkeEncryption = 'aes128' | 'aes192' | 'aes256' | '3des' | 'des' | 'aes128gcm16' | 'aes256gcm16';
export type SecGwEspEncryption = 'aes128' | 'aes192' | 'aes256' | '3des' | 'des' | 'aes128gcm16' | 'aes256gcm16' | 'aes128gmac' | 'aes256gmac';
export type SecGwIkeIntegrity = 'sha256' | 'sha256_96' | 'sha1_96' | 'sha1' | 'aesxcbc';
export type SecGwEspIntegrity = 'sha1' | 'sha256' | 'sha1_160' | 'sha256_96' | 'aesxcbc';
export type SecGwDhGroup = 'modp1024' | 'modp2048' | 'ecp256' | 'ecp384';

interface AlgoOption<T extends string> { label: string; value: T }

export const IKE_ENCRYPTION_OPTIONS: AlgoOption<SecGwIkeEncryption>[] = [
  { label: 'AES128', value: 'aes128' },
  { label: 'AES256', value: 'aes256' },
  { label: '3DES', value: '3des' },
  { label: 'DES', value: 'des' },
];
export const ESP_ENCRYPTION_OPTIONS: AlgoOption<SecGwEspEncryption>[] = [
  { label: 'AES128', value: 'aes128' },
  { label: 'AES256', value: 'aes256' },
  { label: '3DES', value: '3des' },
  { label: 'DES', value: 'des' },
];
// "SHA1_60" is Baicells' own label verbatim (per user report) — no such algorithm
// exists in strongSwan's keyword set, so this is mapped to sha1_96 (== plain "sha1",
// HMAC-SHA1-96, the overwhelmingly common default) as the closest plausible
// equivalent. UNVERIFIED against real Baicells firmware — flag this specific mapping
// if a real handshake using this option fails where "SHA1" (also sha1_96) succeeds.
export const IKE_INTEGRITY_OPTIONS: AlgoOption<SecGwIkeIntegrity>[] = [
  { label: 'SHA256', value: 'sha256' },
  { label: 'SHA256_96', value: 'sha256_96' },
  { label: 'SHA1_60', value: 'sha1_96' },
  { label: 'SHA1', value: 'sha1' },
];
export const ESP_INTEGRITY_OPTIONS: AlgoOption<SecGwEspIntegrity>[] = [
  { label: 'SHA1', value: 'sha1' },
  { label: 'SHA256', value: 'sha256' },
  { label: 'SHA1_160', value: 'sha1_160' },
  { label: 'SHA256_96', value: 'sha256_96' },
];
export const IKE_DH_GROUP_OPTIONS: AlgoOption<SecGwDhGroup>[] = [
  { label: 'MODP1024', value: 'modp1024' },
  { label: 'MODP2048', value: 'modp2048' },
];
export const ESP_DH_GROUP_OPTIONS: AlgoOption<SecGwDhGroup>[] = [
  { label: 'MODP1024', value: 'modp1024' },
  { label: 'MODP2048', value: 'modp2048' },
];

function isValidOption<T extends string>(options: AlgoOption<T>[], value: unknown): value is T {
  return typeof value === 'string' && options.some(o => o.value === value);
}

// ─── Nokia option tables (added 2026-08-14) ──────────────────────────────────
// Nokia's own IPsec config page field/label vocabulary, given directly by the user —
// PSK-only for now (Nokia's own cert/PKI options aren't implemented, same "start with
// what's actually needed" reasoning as Baicells originally being cert-first before PSK
// was added). "DH19"/"DH20" are real IKEv2 ECC groups (RFC 5903/RFC 6954): DH19 = 256-bit
// ECP (secp256r1), DH20 = 384-bit ECP (secp384r1) — strongSwan tokens ecp256/ecp384.
export const NOKIA_IKE_DH_GROUP_OPTIONS: AlgoOption<SecGwDhGroup>[] = [
  { label: 'DH2 - 1024 Bits', value: 'modp1024' },
  { label: 'DH14 - 2048 Bits', value: 'modp2048' },
  { label: 'DH19 - 256 Bits elliptic curve', value: 'ecp256' },
  { label: 'DH20 - 384 Bits elliptic curve', value: 'ecp384' },
];
// Same 4 options, reused verbatim for the separate PFS DH Group field.
export const NOKIA_PFS_DH_GROUP_OPTIONS = NOKIA_IKE_DH_GROUP_OPTIONS;

export const NOKIA_IKE_ENCRYPTION_OPTIONS: AlgoOption<SecGwIkeEncryption>[] = [
  { label: 'AES_128_CBC', value: 'aes128' },
  { label: '3DES_192_CBC', value: '3des' },
  { label: 'AES_192_CBC', value: 'aes192' },
  { label: 'AES_256_CBC', value: 'aes256' },
  { label: 'AES_GCM_ICV16_128', value: 'aes128gcm16' },
  { label: 'AES_GCM_ICV16_256', value: 'aes256gcm16' },
];
// The two AES_GCM_ICV* entries here are the SAME combined-mode ciphers as in the
// encryption list above, not a separate integrity algorithm — Nokia's own menu lists
// them again here because when a GCM cipher is chosen for encryption, its authentication
// is built in (AEAD). isAeadCipher()/buildNokiaIkeProposal() special-case this: the
// separate integrity value is ignored for the actual proposal whenever encryption is a
// GCM/GMAC cipher, and a PRF is used instead (required by IKEv2 for key derivation,
// independent of the AEAD transform). "HMAC_SHA_96" (no "1") is Nokia's own label for
// plain HMAC-SHA1-96 — same value as ESP's "HMAC_SHA1_96" below.
export const NOKIA_IKE_INTEGRITY_OPTIONS: AlgoOption<SecGwIkeIntegrity>[] = [
  { label: 'HMAC_SHA_96', value: 'sha1_96' },
  { label: 'HMAC_SHA2_256_128', value: 'sha256' },
  { label: 'AES_XCBC_MAC_96', value: 'aesxcbc' },
  { label: 'AES_GCM_ICV_16_128', value: 'sha256' },
  { label: 'AES_GCM_ICV16_256', value: 'sha256' },
];

export const NOKIA_ESP_ENCRYPTION_OPTIONS: AlgoOption<SecGwEspEncryption>[] = [
  { label: 'AES_128_CBC', value: 'aes128' },
  { label: '3DES_192_CBC', value: '3des' },
  { label: 'AES_GMAC_128', value: 'aes128gmac' },
  { label: 'AES_GMAC_256', value: 'aes256gmac' },
  { label: 'AES_192_CBC', value: 'aes192' },
  { label: 'AES_256_CBC', value: 'aes256' },
  { label: 'AES_GCM_ICV_16_128', value: 'aes128gcm16' },
  { label: 'AES_GCM_ICV16_256', value: 'aes256gcm16' },
];
// Same reasoning as NOKIA_IKE_INTEGRITY_OPTIONS above — GMAC/GCM entries here mirror the
// encryption list's combined-mode ciphers rather than naming a real separate integrity
// algorithm; ignored by buildNokiaEspProposal() whenever ESP encryption is AEAD.
export const NOKIA_ESP_INTEGRITY_OPTIONS: AlgoOption<SecGwEspIntegrity>[] = [
  { label: 'HMAC_SHA1_96', value: 'sha1' },
  { label: 'HMAC_SHA2_256_128', value: 'sha256' },
  { label: 'AES_GMAC_128', value: 'sha256' },
  { label: 'AES_GMAC_256', value: 'sha256' },
  { label: 'AES_XCBC_MAC_96', value: 'aesxcbc' },
  { label: 'AES_GCM_ICV_16_128', value: 'sha256' },
  { label: 'AES_GCM_ICV16_256', value: 'sha256' },
];

function isAeadCipher(enc: string): boolean {
  return /gcm|gmac/i.test(enc);
}

// GCM/GMAC are combined (AEAD) modes — the cipher itself provides authentication, so no
// separate integrity token is used. IKEv2 still needs a PRF (pseudo-random function) for
// key derivation independent of the AEAD transform; prfsha256 is a safe modern default
// not separately exposed as a Nokia setting. See the NOKIA_*_INTEGRITY_OPTIONS comments
// above for why their dropdowns still list GCM/GMAC entries despite this.
function buildNokiaIkeProposal(encryption: string, integrity: string, dhGroup: string): string {
  if (isAeadCipher(encryption)) return `${encryption}-prfsha256-${dhGroup}`;
  return `${encryption}-${integrity}-${dhGroup}`;
}

function buildNokiaEspProposal(encryption: string, integrity: string, pfsDhGroup: string | null): string {
  const base = isAeadCipher(encryption) ? encryption : `${encryption}-${integrity}`;
  return pfsDhGroup ? `${base}-${pfsDhGroup}` : base;
}

function generatePsk(): string {
  return crypto.randomBytes(32).toString('hex');
}

// ─── State ──────────────────────────────────────────────────────────────────
export type SecGwInstallStatus = 'idle' | 'installing' | 'complete' | 'failed';
export type SecGwRadioType = '4g' | '5g';
export type SecGwRadioStatus = 'pending' | 'active' | 'revoked';
// Orthogonal to radioType — a Nokia radio can be 4G (AirScale, per CLAUDE.md reference
// facts) just as easily as 5G. Drives which tab/form the Radios UI shows and which
// algorithm option tables apply, not the destination NF selection.
export type SecGwRadioVendor = 'baicells' | 'nokia';
export type SecGwIkeSaMode = 'initiator_responder' | 'responder';

export interface SecGwRadio {
  id: string;
  name: string;
  vendor: SecGwRadioVendor;
  radioType: SecGwRadioType;
  genieacsDeviceId: string | null;
  manualIdentifier: string | null;
  peerIdentity: string;
  destination: 'mme_sgwu' | 'amf_upf';
  // localTs = deriveLocalTs(radioType) (the core NF pair) PLUS extraLocalCidrs below,
  // always recomputed fresh on every add/edit — never hand-edit localTs directly.
  localTs: string;
  // Extra destinations reachable through this radio's tunnel, beyond the auto-derived
  // core NF pair — e.g. the BIND DNS server, added live 2026-08-14 for a Nokia radio
  // whose own IPsec page couldn't do a plaintext "Bypass" policy for DNS and needed it
  // added as a real Protect entry instead. Each entry is a normalized IPv4 CIDR
  // (bare IPs get /32 appended). Applies to any vendor — not Nokia-specific.
  extraLocalCidrs: string[];
  remoteTs: string;
  // The specific /32 auto-allocated for this radio from the pool CIDR, offered to it via
  // IKEv2 Configuration Payload — see allocatePoolAddress()'s comment for why this exists
  // (a real outage: multiple radios sharing the same pool CIDR as their remote_ts collide
  // on a single kernel XFRM policy slot, and whichever negotiates last silently steals it
  // from the others). Baicells-only — always null for Nokia radios by design, since Nokia
  // has no CP support at all (confirmed live 2026-08-14 against the radio's own IPsec
  // page); Nokia's remote_ts is instead the radio's own real IP (localIpAddress). For
  // Baicells, null only means a radio added before this field existed or a pool-exhausted
  // add attempt.
  poolAddress: string | null;
  authMode: SecGwAuthMode;
  psk: string | null;
  ikeEncryption: SecGwIkeEncryption;
  ikeIntegrity: SecGwIkeIntegrity;
  ikeDhGroup: SecGwDhGroup;
  espEncryption: SecGwEspEncryption;
  espIntegrity: SecGwEspIntegrity;
  espDhGroup: SecGwDhGroup;
  certIssuedAt: string | null;
  certExpiresAt: string | null;
  certSerial: string | null;
  // `status` is a one-way PKI/provisioning lifecycle latch (pending -> active once a
  // credential has ever been used to establish a tunnel; -> revoked on removal) — it
  // is NOT live connectivity and must never be read as "is the tunnel up right now".
  // Confirmed live 2026-08-23: a Nokia radio physically powered off still showed
  // status "active" here (correctly latched from an earlier successful connection)
  // while `swanctl --list-sas` had already correctly dropped it via DPD (dpd_delay=30s,
  // dpd_action=clear — DPD itself was working fine, the persisted field just isn't a
  // live signal and was being displayed as if it were one). Real-time tunnel state is
  // `tunnelActive` on the /radios and /status responses instead — always recomputed
  // fresh from swanctl, never persisted. `enabled` below is the third, independent
  // axis: an explicit admin on/off toggle, orthogonal to both.
  status: SecGwRadioStatus;
  // Administrative on/off — independent of both `status` (PKI lifecycle) and live
  // tunnel state. Disabling unloads the radio's swanctl connection and tears down any
  // live SA without touching its certificate/PSK, so it can be re-enabled later without
  // re-provisioning. Defaults true (backfillRadioDefaults) for every radio added before
  // this field existed — nothing already deployed silently goes dark on upgrade.
  enabled: boolean;

  // ── Nokia-only fields (added 2026-08-14) — all null/default for Baicells radios.
  // Several of these are informational only: they describe a setting on the RADIO's
  // own IPsec page that has no swanctl-side equivalent to generate (the operator just
  // needs to know what to pick), surfaced in the Nokia connection-info sheet so nothing
  // requires cross-referencing this plan against Nokia's own field names by hand.
  ikeSaMode: SecGwIkeSaMode; // informational — describes the RADIO's own initiate behavior, not ours (we're always a pure responder, remote_addrs = %any)
  ikeReauthEnabled: boolean; // maps to swanctl reauth_time: enabled -> ikeSaLifetimeSeconds, disabled -> 0
  pfsEnabled: boolean; // whether esp_proposals includes a DH group suffix at all
  pfsDhGroup: SecGwDhGroup; // only used when pfsEnabled
  antiReplayEnabled: boolean; // informational only — see the comment on ensurePoolRoute-adjacent code: charon's replay window is a GLOBAL strongswan.conf setting, not per-connection, so this can't be enforced per-radio; captured for documentation/parity with Nokia's own config page only
  antiReplayWindowSize: 64 | 28; // informational only, same reason as above (28 is the exact value the user specified, not "corrected" to 32 — unverified against real Nokia firmware)
  dpdDelaySeconds: number; // maps to swanctl dpd_delay, 10-360
  ikeSaLifetimeSeconds: number; // maps to swanctl rekey_time (connection-level), 3600-86400
  childSaLifetimeSeconds: number; // maps to swanctl rekey_time (child-level), 300-86400
  localIpAddress: string | null; // informational — the radio's own U-Plane/M-Plane/C-Plane IP, for documentation only
}

export interface SecGwState {
  installStatus: SecGwInstallStatus;
  installStartedAt: string | null;
  installCompletedAt: string | null;
  installError: string | null;
  builtWithPatchRev: number | null;
  configured: boolean;
  configuredAt: string | null;
  configuredWithVersion: number | null;
  gatewayIp: string | null;
  interfaceMode: 'dummy' | 'existing' | null;
  gatewayFqdn: string | null;
  caCreatedAt: string | null;
  // Virtual IP pool for radios that request one via IKEv2 Configuration Payload (real,
  // confirmed-live Baicells behavior — it requests %any rather than doing classic
  // site-to-site fixed-subnet IPsec, so without a pool its CHILD_SA never completes:
  // "no virtual IP found for %any requested by ..." / "failed to establish CHILD_SA,
  // keeping IKE_SA"). Radios that don't request one simply ignore this — safe to
  // reference unconditionally from every radio's connection config.
  poolCidr: string | null;
  radios: SecGwRadio[];
}

function defaultState(): SecGwState {
  return {
    installStatus: 'idle', installStartedAt: null, installCompletedAt: null, installError: null,
    builtWithPatchRev: null,
    configured: false, configuredAt: null, configuredWithVersion: null,
    gatewayIp: null, interfaceMode: null, gatewayFqdn: null, caCreatedAt: null, poolCidr: null,
    radios: [],
  };
}

// Backfills defaults for fields added after a radio was first saved to disk — the
// top-level `{...defaultState(), ...parsed}` spread in loadState() only covers
// SecGwState's own top-level keys, not individual elements of the `radios` array
// (that array is replaced wholesale by whatever's in the parsed JSON, never deep-
// merged). Without this, radios added before the Nokia vendor split (2026-08-14)
// would load with `vendor: undefined`, which fails every `r.vendor === 'baicells'`
// tab filter in the frontend and silently vanishes them from both tabs.
function backfillRadioDefaults(radio: Partial<SecGwRadio>): SecGwRadio {
  return {
    vendor: 'baicells',
    enabled: true,
    ikeSaMode: 'initiator_responder',
    ikeReauthEnabled: false,
    pfsEnabled: true,
    pfsDhGroup: 'modp2048',
    antiReplayEnabled: true,
    antiReplayWindowSize: 64,
    dpdDelaySeconds: 30,
    ikeSaLifetimeSeconds: 28800,
    childSaLifetimeSeconds: 3600,
    localIpAddress: null,
    extraLocalCidrs: [],
    ...radio,
  } as SecGwRadio;
}

// Real bug found live (2026-08-14): the per-radio dedicated-pool fix (see
// allocatePoolAddress()'s comment) was originally applied to 3 already-live radios by
// hand-editing their conf.d files directly and reloading swanctl, WITHOUT going back
// through this app's own add/edit endpoints — so .secgw-state.json's poolAddress for
// those 3 radios was never updated and stayed null. Every add-radio call computes its
// "already used" set purely from state.radios[].poolAddress, so those 3 addresses
// looked free and a newly-added Nokia radio was handed one of them (10.0.50.201),
// silently colliding with an already-ESTABLISHED Baicells tunnel on the same address.
// Fix: on every load, for any radio missing poolAddress, recover the REAL address from
// its live conf.d file's `pools{}` block (ground truth for what's actually negotiated)
// rather than leaving it null and letting allocatePoolAddress() hand out a duplicate.
function reconcilePoolAddressFromDisk(radio: SecGwRadio): SecGwRadio {
  if (radio.poolAddress) return radio;
  try {
    const confPath = `${HOST_SWANCTL_CONFD_DIR}/${radio.id}.conf`;
    if (!fs.existsSync(confPath)) return radio;
    const content = fs.readFileSync(confPath, 'utf-8');
    const match = content.match(/addrs\s*=\s*(\d{1,3}(?:\.\d{1,3}){3})\/32/);
    if (match) {
      return { ...radio, poolAddress: match[1], remoteTs: `${match[1]}/32` };
    }
  } catch { /* best-effort reconciliation only — fall through unchanged */ }
  return radio;
}

export function loadState(): SecGwState {
  try {
    if (fs.existsSync(HOST_STATE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(HOST_STATE_FILE, 'utf-8'));
      const merged: SecGwState = { ...defaultState(), ...parsed };
      merged.radios = (merged.radios ?? []).map(backfillRadioDefaults).map(reconcilePoolAddressFromDisk);
      return merged;
    }
  } catch { /* corrupt — fall through to defaults */ }
  return defaultState();
}

function saveState(state: SecGwState): void {
  const dir = path.dirname(HOST_STATE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(HOST_STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

// ─── Domain helpers ──────────────────────────────────────────────────────────

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

// Real 3GPP TS 23.003 EPC realm — same construction already used throughout this
// project's Diameter FQDNs (see CLAUDE.md reference facts). Built directly from
// MCC/MNC rather than sliced off another NF's freeDiameter Identity (SecGW has no
// freeDiameter peer of its own), so this is intentionally independent of vowifi-
// controller.ts's realmFromIdentity() approach.
function deriveRealm(): string {
  const { mcc, mnc } = readMccMnc();
  return `epc.mnc${mnc.padStart(3, '0')}.mcc${mcc}.3gppnetwork.org`;
}

function readYamlServerAddress(yamlPath: string, sectionRegex: RegExp, fallback: string): string {
  try {
    const raw = fs.readFileSync(yamlPath, 'utf-8');
    return raw.match(sectionRegex)?.[1] ?? fallback;
  } catch {
    return fallback;
  }
}

// Derives the plaintext destination(s) a given radio type's decrypted traffic should
// land on, read live from the real NF configs rather than hardcoded — same reasoning
// as vowifi-controller.ts's readSmfGtpcAddress(). 4G: S1-MME (MME) + S1-U (SGW-U).
// 5G: N2 (AMF) + N3 (UPF).
function deriveLocalTs(radioType: SecGwRadioType): string {
  if (radioType === '5g') {
    const amf = readYamlServerAddress(HOST_AMF_YAML, /ngap:\s*\n\s*server:\s*\n\s*-\s*address:\s*([0-9.]+)/, '127.0.0.18');
    const upf = readYamlServerAddress(HOST_UPF_YAML, /gtpu:\s*\n\s*server:\s*\n\s*-\s*address:\s*([0-9.]+)/, '127.0.0.7');
    return `${amf}/32,${upf}/32`;
  }
  const mme = readYamlServerAddress(HOST_MME_YAML, /s1ap:\s*\n\s*server:\s*\n\s*-\s*address:\s*([0-9.]+)/, '127.0.0.2');
  const sgwu = readYamlServerAddress(HOST_SGWU_YAML, /gtpu:\s*\n\s*server:\s*\n\s*-\s*address:\s*([0-9.]+)/, '127.0.0.6');
  return `${mme}/32,${sgwu}/32`;
}

// Normalizes one operator-entered destination into an IPv4 CIDR — a bare IP gets /32
// appended (the common case: "just let this radio also reach the BIND server").
function normalizeCidr(input: string): string | null {
  const trimmed = input.trim();
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(trimmed)) return `${trimmed}/32`;
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}$/.test(trimmed)) return trimmed;
  return null;
}

// Parses the comma-separated "Additional Protected Destinations" field — real need
// found live (2026-08-14): a Nokia radio couldn't do a plaintext "Bypass" policy for
// DNS (to the BIND server) at all, and needed it added as a real "Protect" traffic
// selector instead, which means OUR gateway's local_ts must also include that
// destination or the CHILD_SA negotiation fails with TS_UNACCEPTABLE. Returns null
// (not an empty array) to signal a validation failure vs. legitimately-empty input.
function parseExtraLocalCidrs(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return [];
  if (typeof raw !== 'string') return null;
  if (!raw.trim()) return [];
  const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
  const normalized: string[] = [];
  for (const part of parts) {
    const n = normalizeCidr(part);
    if (!n) return null;
    normalized.push(n);
  }
  return normalized;
}

function combineLocalTs(radioType: SecGwRadioType, extraLocalCidrs: string[]): string {
  return [...deriveLocalTs(radioType).split(','), ...extraLocalCidrs].join(',');
}

// Surgical single-record upsert inside the shared internal "epc" zone file — copied
// from vowifi-controller.ts's identical helper (not exported there, so duplicated here
// rather than introducing a shared-utils module for two small regexes). That zone is
// wholesale-owned/regenerated by the DNS/FQDN Migration Wizard (CLAUDE.md gotcha #4),
// so this only ever merges one "secgw" line into it, never rewrites the whole file.
function upsertZoneRecordLine(raw: string, name: string, ip: string): string {
  const lineRe = new RegExp(`^${name}\\s+IN\\s+A\\s+\\S+\\s*$`, 'm');
  const line = `${name} IN A ${ip}`;
  return lineRe.test(raw) ? raw.replace(lineRe, line) : raw.trimEnd() + '\n' + line + '\n';
}

function removeZoneRecordLine(raw: string, name: string): string {
  const lineRe = new RegExp(`^${name}\\s+IN\\s+A\\s+\\S+\\s*\\n?`, 'm');
  return raw.replace(lineRe, '');
}

function epcZonePath(realm: string): string {
  return `${HOST_BIND_ZONES_DIR}/${realm}.zone`;
}

// Live status of the "secgw" A record — deliberately NOT hard-gated on BIND being
// installed: the zone file simply won't exist yet on a host where BIND was never set
// up (or the DNS/FQDN Migration Wizard was never run), and that's a normal, expected
// state here, not an error. The frontend uses zoneExists to decide whether to show a
// "waiting on BIND" message or an actionable "Add DNS Record" retry button.
function readSecgwDnsRecordStatus(gatewayIp: string | null): { zoneExists: boolean; recordPresent: boolean } {
  const zonePath = epcZonePath(deriveRealm());
  if (!fs.existsSync(zonePath)) return { zoneExists: false, recordPresent: false };
  try {
    const raw = fs.readFileSync(zonePath, 'utf-8');
    const m = raw.match(/^secgw\s+IN\s+A\s+(\S+)\s*$/m);
    return { zoneExists: true, recordPresent: !!(m && gatewayIp && m[1] === gatewayIp) };
  } catch {
    return { zoneExists: true, recordPresent: false };
  }
}

// Adds/updates the "secgw" record — called both from Configure (best-effort, non-
// fatal — Configure must still succeed even if BIND isn't set up yet) and from the
// dedicated /dns-record retry endpoint (for when BIND gets installed later).
async function upsertSecgwDnsRecord(gatewayIp: string): Promise<{ zoneExists: boolean; added: boolean }> {
  const zonePath = epcZonePath(deriveRealm());
  if (!fs.existsSync(zonePath)) return { zoneExists: false, added: false };
  const raw = fs.readFileSync(zonePath, 'utf-8');
  fs.writeFileSync(zonePath, upsertZoneRecordLine(raw, 'secgw', gatewayIp), 'utf-8');
  await nsenter('systemctl', ['restart', 'bind9']).catch(() => {});
  return { zoneExists: true, added: true };
}

async function removeSecgwDnsRecord(): Promise<void> {
  const zonePath = epcZonePath(deriveRealm());
  if (!fs.existsSync(zonePath)) return;
  const raw = fs.readFileSync(zonePath, 'utf-8');
  fs.writeFileSync(zonePath, removeZoneRecordLine(raw, 'secgw'), 'utf-8');
  await nsenter('systemctl', ['restart', 'bind9']).catch(() => {});
}

async function readCertMeta(hostRealCertPath: string): Promise<{ certIssuedAt: string; certExpiresAt: string; certSerial: string }> {
  try {
    const { stdout } = await nsenter('openssl', ['x509', '-in', hostRealCertPath, '-noout', '-startdate', '-enddate', '-serial'], 10000);
    const notBefore = stdout.match(/notBefore=(.+)/)?.[1]?.trim();
    const notAfter = stdout.match(/notAfter=(.+)/)?.[1]?.trim();
    const serial = stdout.match(/serial=(.+)/)?.[1]?.trim();
    return {
      certIssuedAt: notBefore ? new Date(notBefore).toISOString() : new Date().toISOString(),
      certExpiresAt: notAfter ? new Date(notAfter).toISOString() : new Date().toISOString(),
      certSerial: serial ?? 'unknown',
    };
  } catch {
    return { certIssuedAt: new Date().toISOString(), certExpiresAt: new Date().toISOString(), certSerial: 'unknown' };
  }
}

// ─── Config generators ───────────────────────────────────────────────────────

// CA + this gateway's own server cert — extends vowifi-controller.ts's epdgCertGenScript()
// pattern (same idempotent, CA-then-leaf openssl procedure) with one deliberate change:
// the CA's PRIVATE key stays only in SECGW_PKI_DIR, never copied into swanctl's own
// private/ dir — strongSwan itself only ever needs the CA's public cert (to validate
// incoming client certs) plus its own server cert+key. VoWiFi's single-leaf case didn't
// need this distinction; SecGW's CA signs many client certs over the module's lifetime,
// so keeping the signing key in a narrower-scope, NMS-owned directory is worth the split.
function secgwCaAndServerCertGenScript(gatewayFqdn: string): string {
  return `mkdir -p ${SECGW_PKI_DIR} ${SWANCTL_X509_DIR} ${SWANCTL_X509CA_DIR} ${SWANCTL_PRIVATE_DIR}
if [ ! -f ${SECGW_PKI_DIR}/ca.crt ]; then
  cd ${SECGW_PKI_DIR}
  openssl genrsa -out ca.key 4096
  openssl req -x509 -new -nodes -key ca.key -sha256 -days 3650 -subj "/CN=open5gs-nms SecGW CA" -out ca.crt
  chmod 0640 ca.key ca.crt
fi
if [ ! -f ${SWANCTL_X509_DIR}/server.crt ]; then
  cd ${SECGW_PKI_DIR}
  openssl genrsa -out server.key 2048
  openssl req -new -key server.key -subj "/CN=${gatewayFqdn}" -out server.csr
  openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -sha256 -days 825 \\
    -extfile <(printf "subjectAltName=DNS:${gatewayFqdn}\\nkeyUsage=critical,digitalSignature,keyEncipherment\\nextendedKeyUsage=serverAuth") -out server.crt
  rm -f server.csr
  cp server.crt ${SWANCTL_X509_DIR}/server.crt
  cp ca.crt ${SWANCTL_X509CA_DIR}/ca.crt
  cp server.key ${SWANCTL_PRIVATE_DIR}/server.key
  chmod 0640 server.crt server.key
  chmod 0640 ${SWANCTL_PRIVATE_DIR}/server.key
fi`;
}

// Per-radio client cert, signed by the same CA — deliberately NOT idempotent-skip like
// the CA/server script above: every call is either a brand-new radio or a deliberate
// "Reissue Certificate" rotation, so it always regenerates. Copies the issued cert+key
// plus the CA's public cert into the radio's own staging dir for later bundling by the
// download route — SECGW_PKI_DIR itself (containing ca.key) is never exposed for download.
function secgwRadioClientCertGenScript(radioId: string, peerIdentity: string): string {
  return `mkdir -p ${SECGW_RADIOS_DIR}/${radioId}
cd ${SECGW_PKI_DIR}
openssl genrsa -out client-${radioId}.key 2048
openssl req -new -key client-${radioId}.key -subj "/CN=${peerIdentity}" -out client-${radioId}.csr
openssl x509 -req -in client-${radioId}.csr -CA ca.crt -CAkey ca.key -CAcreateserial -sha256 -days 825 \\
  -extfile <(printf "subjectAltName=DNS:${peerIdentity}\\nkeyUsage=critical,digitalSignature,keyAgreement\\nextendedKeyUsage=clientAuth") -out client-${radioId}.crt
rm -f client-${radioId}.csr
cp client-${radioId}.crt client-${radioId}.key ca.crt ${SECGW_RADIOS_DIR}/${radioId}/
chmod 0640 client-${radioId}.crt client-${radioId}.key
chmod 0640 ${SECGW_RADIOS_DIR}/${radioId}/client-${radioId}.key`;
}

// "Remove Radio" — no CRL/OCSP in v1 (deliberate simplification, see plan). Moves the
// signed cert+key out of SECGW_PKI_DIR into a revoked/ subdirectory rather than deleting
// them, purely for audit trail — the connection definition being gone (see the router's
// DELETE handler) is what actually stops this peer from negotiating, not this move.
function secgwRevokeRadioCertScript(radioId: string): string {
  return `mkdir -p ${SECGW_PKI_DIR}/revoked
mv -f ${SECGW_PKI_DIR}/client-${radioId}.crt ${SECGW_PKI_DIR}/client-${radioId}.key ${SECGW_PKI_DIR}/revoked/ 2>/dev/null || true`;
}

// No shared pool lives here anymore — each radio gets its own dedicated single-address
// pool defined inside its own conf.d file (see allocatePoolAddress()'s comment for why:
// a real outage found live 2026-08-13, multiple radios sharing one pool CIDR as their
// remote_ts collided on a single kernel XFRM policy slot).
function baseSwanctlConf(): string {
  return `# Managed by open5gs-nms — per-radio connections live under conf.d/, do not
# hand-edit connection blocks in this file; use the Radios tab instead.
include conf.d/*.conf
`;
}

function buildProposal(encryption: string, integrity: string, dhGroup: string): string {
  return `${encryption}-${integrity}-${dhGroup}`;
}

// Written (and rewritten, since gatewayIp can change on a reconfigure) at Configure
// time — `make install` from secgw-build.ts's source build drops its own generic
// version of this same unit once at Install time, but only Configure actually knows
// the real gatewayIp that SECGW_BIND_ADDR needs to bind to instead of the wildcard
// (see secgw-build.ts's header comment for why this env var exists at all).
function secgwSystemdUnit(gatewayIp: string): string {
  return `[Unit]
Description=strongSwan IPsec IKEv1/IKEv2 daemon using swanctl
After=network-online.target

[Service]
Type=notify
Environment=SECGW_BIND_ADDR=${gatewayIp}
ExecStart=${SECGW_CHARON_BIN}
ExecStartPost=${SECGW_SWANCTL_BIN} --load-all --noprompt
ExecReload=${SECGW_SWANCTL_BIN} --reload
ExecReload=${SECGW_SWANCTL_BIN} --load-all --noprompt
Restart=on-abnormal

[Install]
WantedBy=multi-user.target
Alias=strongswan-swanctl.service
`;
}

// Resolves which interface currently holds a given IP — needed for the pool route
// (see below) since interfaceMode can be 'existing', where the IP isn't necessarily on
// DUMMY_IF_NAME.
async function findInterfaceForIp(ip: string): Promise<string | null> {
  try {
    const { stdout } = await nsenter('bash', ['-c',
      `ip -o addr show | awk -v target="${ip}" '{split($4,a,"/"); if (a[1]==target) {print $2; exit}}'`]);
    const iface = stdout.trim();
    return iface || null;
  } catch {
    return null;
  }
}

// The pool CIDR (see SecGwState.poolCidr) only ever needs to be reachable from THIS
// host — pool addresses are virtual, assigned to radios only inside an established
// CHILD_SA, and only this host's own kernel XFRM policy can ever actually deliver to
// one. It must NOT be advertised into EIGRP (unlike the gateway IP itself) — nothing
// else on the network needs to route to it, or ever could. A plain local route via the
// gateway's own interface is enough: it makes the kernel's route lookup for a pool
// address succeed (return "yes, this is routable, here's an egress interface") so the
// packet is handed to the network stack for output — at which point the XFRM policy
// strongSwan installs for the negotiated CHILD_SA intercepts it and encrypts/tunnels
// it to the radio's real address instead of ever actually transmitting on that
// interface's L2. Confirmed live 2026-08-12 with a real Baicells eNB.
async function ensurePoolRoute(poolCidr: string, gatewayIp: string): Promise<void> {
  const iface = await findInterfaceForIp(gatewayIp);
  if (!iface) return;
  await nsenter('bash', ['-c', `ip route replace ${poolCidr} dev ${iface}`]).catch(() => {});
}

async function removePoolRoute(poolCidr: string): Promise<void> {
  await nsenter('bash', ['-c', `ip route del ${poolCidr}`]).catch(() => {});
}

// IP <-> uint32 helpers. Every intermediate value is forced through `>>> 0` — the exact
// same JS bitwise-operator footgun already documented in ip-utils.ts's cidrRange bug
// (CLAUDE.md gotcha): a subnet whose first octet is >=128 produces a corrupted SIGNED
// 32-bit int from an unmasked `<<`/`&`, silently yielding wrong addresses. Not optional
// here — 10.0.50.0/29 alone wouldn't trigger it, but this must stay correct for any
// operator-chosen pool CIDR, including ones starting >=128.
function ipToInt(ip: string): number {
  const [a, b, c, d] = ip.split('.').map(Number);
  return (((a << 24) | (b << 16) | (c << 8) | d) >>> 0);
}

function intToIp(n: number): string {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

function poolCidrHostRange(poolCidr: string): { network: number; hostCount: number } | null {
  const m = poolCidr.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\/(\d{1,2})$/);
  if (!m) return null;
  const prefix = Number(m[2]);
  if (prefix < 1 || prefix > 30) return null; // need room for >=1 usable host
  const hostBits = 32 - prefix;
  const mask = hostBits === 32 ? 0 : ((0xFFFFFFFF << hostBits) >>> 0);
  const network = (ipToInt(m[1]) & mask) >>> 0;
  return { network, hostCount: (1 << hostBits) >>> 0 };
}

// Allocates a unique /32 for a radio from the configured pool CIDR — deliberately NOT a
// shared range handed to every radio. Real outage found live 2026-08-13: giving multiple
// radios the identical pool CIDR as their remote_ts meant their negotiated CHILD_SAs
// installed the SAME kernel XFRM policy selector, and since only one policy can occupy a
// given selector, whichever radio negotiated most recently silently stole the policy from
// whichever radio had it before — that radio's swanctl state still said ESTABLISHED, but
// its real traffic path was gone (confirmed via `ip xfrm policy` showing exactly one
// policy for the shared /29, pointing at only one of three "connected" radios). A
// per-radio dedicated single-address pool + matching remote_ts makes every radio's
// selector unique by construction, so this collision can't happen regardless of
// strongSwan's own (apparently non-deterministic) CP-narrowing behavior.
function allocatePoolAddress(poolCidr: string, usedAddresses: Set<string>): string | null {
  const range = poolCidrHostRange(poolCidr);
  if (!range) return null;
  // Usable host range excludes the network and broadcast addresses.
  for (let i = 1; i <= range.hostCount - 2; i++) {
    const candidate = intToIp((range.network + i) >>> 0);
    if (!usedAddresses.has(candidate)) return candidate;
  }
  return null;
}

// Resolves the single /32 address to use as remote_ts, and (only for vendors that
// actually support it) the pool address to dedicate to this radio via IKEv2
// Configuration Payload. Real design bug found live (2026-08-14): Nokia was originally
// given the exact same CP + dedicated-pool treatment as Baicells, but Nokia's own IPsec
// page (confirmed directly against the radio, not assumed) has no virtual-IP/CP concept
// at all — only explicit "Local/Remote tunnel endpoint" fields (the real outer IPs) and
// a separate static traffic-selector pair ("Local/Remote IP address"), configured as one
// or more standalone "Protect" policies. Since Nokia never requests an address via CP,
// offering one and using it as remote_ts meant the CHILD_SA could never actually
// negotiate — Nokia's own static remote_ts is its own real IP (localIpAddress), which
// the operator already provides and which is locked read-only on the radio's own page.
function resolveRemoteTs(
  vendor: SecGwRadioVendor, localIpAddress: string | null, poolCidr: string, usedAddresses: Set<string>,
): { poolAddress: string | null; remoteTsAddress: string; error?: undefined } | { error: string; status: number } {
  if (vendor === 'nokia') {
    if (!localIpAddress) {
      return {
        error: "Local IP Address is required for Nokia radios — it's used as the remote traffic "
          + "selector (Nokia has no IKEv2 Configuration Payload support, unlike Baicells).",
        status: 400,
      };
    }
    return { poolAddress: null, remoteTsAddress: localIpAddress };
  }
  const allocated = allocatePoolAddress(poolCidr, usedAddresses);
  if (!allocated) return { error: `The virtual IP pool (${poolCidr}) is exhausted — widen it on the Setup tab.`, status: 409 };
  return { poolAddress: allocated, remoteTsAddress: allocated };
}

// Per-radio swanctl connection block, now driven by operator-selected algorithms
// (not a hardcoded default) and supporting either certificate or PSK auth — see the
// algorithm option tables above. For PSK mode this also emits a `secrets{}` block in
// the SAME conf.d file, matched by the radio's peerIdentity — swanctl's multi-file
// conf.d layout supports both `connections{}` and `secrets{}` per file, merged by
// `swanctl --load-all` the same way this module already merges connection blocks.
function swanctlRadioConnConf(opts: {
  radioId: string; gatewayIp: string; gatewayFqdn: string; peerIdentity: string;
  localTs: string;
  // The single /32 to use as remote_ts — Baicells' auto-allocated pool address (CP-
  // requested) or Nokia's own real IP (static, no CP). See resolveRemoteTs()'s comment.
  remoteTsAddress: string;
  // Only non-null for vendors that actually use IKEv2 Configuration Payload (Baicells) —
  // when null, no `pools{}` block/offer is emitted at all (Nokia).
  poolAddress: string | null;
  authMode: SecGwAuthMode; psk: string | null;
  vendor: SecGwRadioVendor;
  ikeEncryption: SecGwIkeEncryption; ikeIntegrity: SecGwIkeIntegrity; ikeDhGroup: SecGwDhGroup;
  espEncryption: SecGwEspEncryption; espIntegrity: SecGwEspIntegrity; espDhGroup: SecGwDhGroup;
  // Nokia-only (see the matching SecGwRadio field comments) — ignored for Baicells.
  ikeReauthEnabled?: boolean;
  pfsEnabled?: boolean;
  pfsDhGroup?: SecGwDhGroup;
  dpdDelaySeconds?: number;
  ikeSaLifetimeSeconds?: number;
  childSaLifetimeSeconds?: number;
}): string {
  const isNokia = opts.vendor === 'nokia';
  // Baicells always effectively runs with PFS on (espDhGroup baked into every esp
  // proposal) — Nokia's PFS is a real toggle, so its ESP proposal omits the DH group
  // entirely unless pfsEnabled. See buildNokiaEspProposal()'s comment for the AEAD case.
  const ikeProposal = isNokia
    ? buildNokiaIkeProposal(opts.ikeEncryption, opts.ikeIntegrity, opts.ikeDhGroup)
    : buildProposal(opts.ikeEncryption, opts.ikeIntegrity, opts.ikeDhGroup);
  const espProposal = isNokia
    ? buildNokiaEspProposal(opts.espEncryption, opts.espIntegrity, opts.pfsEnabled ? opts.pfsDhGroup ?? opts.ikeDhGroup : null)
    : buildProposal(opts.espEncryption, opts.espIntegrity, opts.espDhGroup);
  const localAuth = opts.authMode === 'cert' ? 'auth = pubkey\n      certs = server.crt' : 'auth = psk';
  const remoteAuth = opts.authMode === 'cert' ? 'auth = pubkey' : 'auth = psk';
  // Nokia's own IPsec page has only ONE identity field at all ("Peer IKE identity" —
  // confirmed live 2026-08-14 by the user directly reading the page) describing what
  // identity the radio expects FROM us, with no separate field to set what identity the
  // RADIO presents as its own. Per RFC 7296's common implementation default, a device
  // with no configurable local ID identifies itself using its own tunnel-endpoint IP
  // (ID_IPV4_ADDR) — so unlike Baicells (which gets told to present the synthetic
  // `radio-xxx.secgw.<realm>` peerIdentity string), Nokia's presented IDi will be its
  // real IP, and remote.id here must match that, not the synthetic string. remoteTsAddress
  // already equals localIpAddress for Nokia (see resolveRemoteTs()), so it doubles as the
  // expected remote identity here. Locking remote_addrs to that same known static IP
  // (instead of %any) is extra insurance that doesn't depend on identity-matching working
  // — Nokia's tunnel endpoint is static/known upfront, unlike Baicells which may be
  // NATed/unknown ahead of time.
  const remoteIdValue = isNokia ? opts.remoteTsAddress : opts.peerIdentity;
  const remoteAddrsValue = isNokia ? opts.remoteTsAddress : '%any';
  const secretsBlock = opts.authMode === 'psk'
    ? `\nsecrets {\n  ike-${opts.radioId} {\n    id = ${remoteIdValue}\n    secret = "${opts.psk}"\n  }\n}\n`
    : '';
  // Dedicated single-address pool, unique per radio — see allocatePoolAddress()'s
  // comment for why this can never be a shared range. remote_ts matches the SAME
  // address exactly, so the negotiated CHILD_SA selector is always this radio's own
  // unique /32, never overlapping with any other radio's. Only offered/emitted for
  // vendors that actually request one via CP — see resolveRemoteTs()'s comment for why
  // Nokia never gets a pools{} block at all.
  const poolName = `secgw-pool-${opts.radioId}`;
  const poolLine = opts.poolAddress ? `\n    pools = ${poolName}` : '';
  const poolBlock = opts.poolAddress ? `\npools {\n  ${poolName} {\n    addrs = ${opts.poolAddress}/32\n  }\n}\n` : '';
  const dpdDelay = `${opts.dpdDelaySeconds ?? 30}s`;
  // Nokia's "IKE association max lifetime" -> swanctl's connection-level rekey_time.
  // "IKE reauthentication enable" is a genuinely separate toggle from rekeying (rekey
  // refreshes keys under the same authenticated identity; reauth tears down and
  // re-authenticates from scratch) — swanctl's own default (reauth_time unset/0) means
  // "no reauth", so this line is only emitted at all when explicitly enabled.
  const ikeRekeyLine = isNokia && opts.ikeSaLifetimeSeconds ? `\n    rekey_time = ${opts.ikeSaLifetimeSeconds}s` : '';
  const reauthLine = isNokia && opts.ikeReauthEnabled && opts.ikeSaLifetimeSeconds
    ? `\n    reauth_time = ${opts.ikeSaLifetimeSeconds}s` : '';
  // Nokia's "Security association max lifetime" -> child-level rekey_time.
  const childRekeyLine = isNokia && opts.childSaLifetimeSeconds ? `\n        rekey_time = ${opts.childSaLifetimeSeconds}s` : '';

  return `connections {
  secgw-${opts.radioId} {
    local_addrs = ${opts.gatewayIp}
    remote_addrs = ${remoteAddrsValue}${poolLine}
    local {
      ${localAuth}
      id = ${opts.gatewayFqdn}
    }
    remote {
      ${remoteAuth}
      id = ${remoteIdValue}
    }
    children {
      secgw-${opts.radioId}-child {
        local_ts = ${opts.localTs}
        remote_ts = ${opts.remoteTsAddress}/32
        mode = tunnel
        dpd_action = clear
        esp_proposals = ${espProposal}${childRekeyLine}
      }
    }
    version = 2
    proposals = ${ikeProposal}
    dpd_delay = ${dpdDelay}${ikeRekeyLine}${reauthLine}
  }
}
${poolBlock}${secretsBlock}`;
}

// Human-readable cheat sheet bundled alongside the cert files (or, for PSK radios, the
// only file in the bundle) — everything an operator needs to hand-configure a radio's
// own IPsec page, since v1 deliberately has no automatic TR-069 push (see plan's Open
// Risks / confirmed scope). Field names/order deliberately match Baicells' own IPsec
// config page (Left = the radio itself, Right = this gateway, from the radio's POV).
function baicellsConnectionInfoSheet(opts: {
  radioName: string; radioType: SecGwRadioType; gatewayIp: string; gatewayFqdn: string;
  peerIdentity: string; localTs: string; poolAddress: string;
  authMode: SecGwAuthMode; psk: string | null;
  ikeEncryption: SecGwIkeEncryption; ikeIntegrity: SecGwIkeIntegrity; ikeDhGroup: SecGwDhGroup;
  espEncryption: SecGwEspEncryption; espIntegrity: SecGwEspIntegrity; espDhGroup: SecGwDhGroup;
  certExpiresAt: string | null;
}): string {
  const label = <T extends string>(options: AlgoOption<T>[], value: T) => options.find(o => o.value === value)?.label ?? value;
  const authBlock = opts.authMode === 'psk'
    ? `Left Auth (radio, local)      : PSK\nRight Auth (this gateway)     : PSK\nSecret Key (PSK)              : ${opts.psk}`
    : `Left Auth (radio, local)      : PubKey (Certificate)\nRight Auth (this gateway)     : PubKey (Certificate)`;
  const filesBlock = opts.authMode === 'cert'
    ? `Files in this bundle:
  ca.crt                     - CA certificate, import as the trusted root
  client-<radioId>.crt       - This radio's client certificate
  client-<radioId>.key       - This radio's private key (keep secret)

Certificate expires: ${opts.certExpiresAt}`
    : `This connection uses a pre-shared key (PSK), not certificates — no certificate
files are included in this bundle. Keep the Secret Key above confidential.`;

  return `open5gs-nms Security Gateway — Radio Connection Info
======================================================
Radio: ${opts.radioName} (${opts.radioType.toUpperCase()})
Generated: ${new Date().toISOString()}

Field names below match Baicells' own IPsec config page (Left = the radio
itself, Right = this gateway).

${authBlock}

Right ID (this gateway's IKE identity)                       : ${opts.gatewayFqdn}
Left ID (this radio's IKE identity — set this on the radio)  : ${opts.peerIdentity}
Right Subnet (reachable through this gateway)                : ${opts.localTs}
Left Subnet (this radio's own subnet, if the field is asked) : usually leave blank/auto — this
                                                                gateway assigns a virtual IP
                                                                (${opts.poolAddress}) via IKEv2
                                                                Configuration Payload; the radio
                                                                does not need a static subnet here.

IKE Encryption : ${label(IKE_ENCRYPTION_OPTIONS, opts.ikeEncryption)}
IKE Auth       : ${label(IKE_INTEGRITY_OPTIONS, opts.ikeIntegrity)}
IKE DH Group   : ${label(IKE_DH_GROUP_OPTIONS, opts.ikeDhGroup)}
ESP Encryption : ${label(ESP_ENCRYPTION_OPTIONS, opts.espEncryption)}
ESP Auth       : ${label(ESP_INTEGRITY_OPTIONS, opts.espIntegrity)}
ESP DH Group   : ${label(ESP_DH_GROUP_OPTIONS, opts.espDhGroup)}
Mode           : Tunnel
DPD Delay      : 30s
IKE Version    : IKEv2

${filesBlock}

IMPORTANT: Do not point this radio's S1-MME/N2 signaling at the gateway IP above
until you have verified the tunnel comes up (use the "Test Tunnel" button on the
Radios tab) — this radio keeps working over its existing plaintext path until you
make that change yourself. This module never edits the radio's own configuration.
`;
}

// Nokia's own connection-info sheet — field names/order match Nokia's IPsec config
// page directly (given verbatim by the user), unlike Baicells' Left/Right convention.
// PSK-only for now (Nokia's cert/PKI path isn't implemented — same reasoning as
// Baicells originally being cert-first: build what's actually needed first).
// No poolAddress/CP field here — confirmed live against the radio's own page (2026-08-14)
// that Nokia has no virtual-IP/Configuration Payload concept at all, only explicit tunnel
// endpoints + static traffic selectors defined as one or more standalone SPD-style
// "Protect" policies. See resolveRemoteTs()'s comment for the full story.
function nokiaConnectionInfoSheet(opts: {
  radioName: string; radioType: SecGwRadioType; gatewayIp: string; gatewayFqdn: string;
  peerIdentity: string; localTs: string; psk: string | null;
  ikeEncryption: SecGwIkeEncryption; ikeIntegrity: SecGwIkeIntegrity; ikeDhGroup: SecGwDhGroup;
  espEncryption: SecGwEspEncryption; espIntegrity: SecGwEspIntegrity;
  ikeSaMode: SecGwIkeSaMode; ikeReauthEnabled: boolean;
  pfsEnabled: boolean; pfsDhGroup: SecGwDhGroup;
  antiReplayEnabled: boolean; antiReplayWindowSize: 64 | 28;
  dpdDelaySeconds: number; ikeSaLifetimeSeconds: number; childSaLifetimeSeconds: number;
  localIpAddress: string | null;
}): string {
  const label = <T extends string>(options: AlgoOption<T>[], value: T) => options.find(o => o.value === value)?.label ?? value;
  const remoteIps = opts.localTs.split(',').map(s => s.trim().replace(/\/32$/, ''));
  const remoteIpNote = remoteIps.length > 1
    ? `\n                                        (${remoteIps.length} separate destinations — if this radio's page only
                                         accepts ONE Remote IP address per policy, create ${remoteIps.length} separate
                                         "Protect" policies, one per address above, all sharing the SAME
                                         Local/Remote tunnel endpoint, PSK, and algorithm settings below)`
    : '';

  return `open5gs-nms Security Gateway — Radio Connection Info (Nokia)
===============================================================
Radio: ${opts.radioName} (${opts.radioType.toUpperCase()})
Generated: ${new Date().toISOString()}

Field names below match Nokia's own IPsec config page directly. "Local/Remote IP
address" below is the traffic selector (what traffic gets protected) — it is a
DIFFERENT thing from "Local/Remote tunnel endpoint" (the real outer IPs the IKE/ESP
packets themselves travel between). Do not confuse the two.

IPsec action                          : Protect
Traffic IP version                    : IPv4
Local IP Address (U-Plane/M-Plane/C-Plane) : ${opts.localIpAddress ?? '(as already set on the radio — not managed by this gateway)'}
Local Port                            : any
Local tunnel endpoint IP address      : ${opts.localIpAddress ?? '(this radio\'s own outward IP — same as Local IP Address above)'}
Protocol                              : any (this tunnel carries both SCTP signaling and GTP-U — do not narrow to a single protocol)
Remote IP address                     : ${remoteIps.join(' , ')}${remoteIpNote}
Remote Port                           : any
Remote tunnel endpoint                : ${opts.gatewayIp} (${opts.gatewayFqdn})
Peer IKE identity                     : ${opts.gatewayFqdn} (the identity THIS GATEWAY presents — Nokia's page has
                                         no separate field for what identity your own radio presents, so it
                                         defaults to its own tunnel-endpoint IP; this gateway is configured
                                         to expect exactly that, no action needed on your end for that part)

Secret Key (PSK)                      : ${opts.psk}

IKE DH Group      : ${label(NOKIA_IKE_DH_GROUP_OPTIONS, opts.ikeDhGroup)}
IKE Encryption    : ${label(NOKIA_IKE_ENCRYPTION_OPTIONS, opts.ikeEncryption)}
IKE Authentication: ${label(NOKIA_IKE_INTEGRITY_OPTIONS, opts.ikeIntegrity)}
IKE SA connection establishment mode : ${opts.ikeSaMode === 'responder' ? 'Responder' : 'Initiator and Responder'} (this gateway is always a pure responder regardless of what you pick here)
IKE reauthentication enable          : ${opts.ikeReauthEnabled ? 'Yes' : 'No'}

ESP Encryption    : ${label(NOKIA_ESP_ENCRYPTION_OPTIONS, opts.espEncryption)}
ESP Authentication: ${label(NOKIA_ESP_INTEGRITY_OPTIONS, opts.espIntegrity)}
IPsec perfect forward secrecy enable : ${opts.pfsEnabled ? 'Yes' : 'No'}
${opts.pfsEnabled ? `PFS DH group                          : ${label(NOKIA_PFS_DH_GROUP_OPTIONS, opts.pfsDhGroup)}\n` : ''}
Anti replay enable                   : ${opts.antiReplayEnabled ? 'Yes' : 'No'} (informational — this gateway's replay window is a global daemon setting, not adjustable per radio; set to match on the radio side as best you can)
Anti replay window size              : ${opts.antiReplayWindowSize}
Dead peer detection delay            : ${opts.dpdDelaySeconds}s
IKE association max lifetime         : ${opts.ikeSaLifetimeSeconds}s
Security association max lifetime    : ${opts.childSaLifetimeSeconds}s

IMPORTANT: Do not point this radio's S1-MME/N2 signaling at the gateway IP above
until you have verified the tunnel comes up (use the "Test Tunnel" button on the
Radios tab) — this radio keeps working over its existing plaintext path until you
make that change yourself. This module never edits the radio's own configuration.
`;
}

// ─── Config file manifest ────────────────────────────────────────────────────

interface SecGwConfigFileEntry {
  path: string;
  label: string;
  group: string;
  language: string;
  exists: boolean;
}

function getSecgwConfigManifest(): SecGwConfigFileEntry[] {
  const state = loadState();
  const entries: Omit<SecGwConfigFileEntry, 'exists'>[] = [
    { group: 'strongSwan', label: 'swanctl.conf', path: SWANCTL_CONF, language: 'plaintext' },
    { group: 'strongSwan', label: 'strongswan.conf', path: STRONGSWAN_CONF, language: 'plaintext' },
    ...state.radios
      .filter(r => r.status !== 'revoked')
      .map(r => ({
        group: 'Radios',
        label: `${r.name} (conf.d/${r.id}.conf)`,
        path: `${SWANCTL_CONFD_DIR}/${r.id}.conf`,
        language: 'plaintext',
      })),
  ];
  return entries.map(e => ({ ...e, exists: fs.existsSync(`/proc/1/root${e.path}`) }));
}

function isAllowedConfigPath(p: string): boolean {
  return getSecgwConfigManifest().some(e => e.path === p);
}

// ─── Live session parsing (`swanctl --list-sas` stdout, plain-text — no vici Node
// client library exists anywhere in this codebase; follows ipsec-sa-cleanup.ts's
// existing text-parsing convention for `ip -s xfrm state` rather than adding a new
// npm dependency). Deliberately does NOT touch raw `ip xfrm state` — that table is
// shared with Kamailio's unrelated ims_ipsec_pcscf SAs (see plan's routing-integration
// gotcha), so this stays scoped to charon's own SAs via swanctl's own query surface. ──

export interface SecGwSession {
  radioId: string;
  connectionName: string;
  ikeState: string;
  established: boolean;
  remoteAddr: string | null;
  childState: string | null;
  localTs: string | null;
  remoteTs: string | null;
  bytesIn: number | null;
  bytesOut: number | null;
}

// Real `swanctl --list-sas` traffic-selector/byte-counter lines, confirmed live
// 2026-08-13 against real established SAs (the original regexes here were an
// unverified guess — flagged as an open risk in the plan — and never matched real
// output, always leaving localTs/remoteTs/bytesIn/bytesOut null):
//   local  10.0.1.175/32 10.0.1.176/32
//   remote 10.0.50.201/32
//   in  cba9e332,   6776 bytes,    95 packets,     1s ago
//   out c325827d,   6820 bytes,    95 packets,     1s ago
// (NOT "X === Y" on one line, and NOT "bytes_i"/"bytes_o" suffixes — both wrong
// guesses.) The CHILD_SA's local/remote lines are CIDR-only and un-indented
// consistently differently from the IKE_SA's own `local 'id' @ ip[port]` line, so
// anchoring on "one or more CIDR blocks and nothing else" is what distinguishes them.
const CIDR_RE = String.raw`\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/\d{1,2}`;
const LOCAL_TS_RE = new RegExp(`^\\s*local\\s+(${CIDR_RE}(?:\\s+${CIDR_RE})*)\\s*$`, 'm');
const REMOTE_TS_RE = new RegExp(`^\\s*remote\\s+(${CIDR_RE}(?:\\s+${CIDR_RE})*)\\s*$`, 'm');

function parseListSas(raw: string): SecGwSession[] {
  const sessions: SecGwSession[] = [];
  const blocks = raw.split(/\n(?=\S+: #\d+,)/);
  for (const block of blocks) {
    const header = block.match(/^(\S+):\s*#(\d+),\s*([A-Z_]+)/);
    if (!header) continue;
    const connectionName = header[1];
    const ikeState = header[3];
    const radioId = connectionName.replace(/^secgw-/, '');
    const remoteMatch = block.match(/remote\s+'[^']*'\s*@\s*([0-9.]+)/);
    const remoteAddr = remoteMatch?.[1] ?? null;
    const established = ikeState === 'ESTABLISHED';

    // A single IKE_SA can carry MULTIPLE CHILD_SAs — real scenario for a Nokia radio
    // using extraLocalCidrs (one CHILD_SA per protected destination — MME, SGW-U,
    // BIND, etc. — all under one IKE_SA), unlike Baicells which only ever negotiates
    // one. Split the block into per-child sub-blocks and emit one session row per
    // child instead of one per IKE_SA — the previous single `.match()` calls below
    // only ever found the FIRST child, silently dropping every other one from both
    // the API response and the Live Sessions table. Found live 2026-08-14: a Nokia
    // radio with 3 active CHILD_SAs (MME/SGW-U/BIND) showed only 1 in the UI.
    const childBlocks = block.split(/\n(?=\s+\S+-child:\s*#\d+,)/).slice(1);
    if (childBlocks.length === 0) {
      sessions.push({
        radioId, connectionName, ikeState, established, remoteAddr,
        childState: null, localTs: null, remoteTs: null, bytesIn: null, bytesOut: null,
      });
      continue;
    }
    for (const childBlock of childBlocks) {
      const childMatch = childBlock.match(/#\d+,\s*reqid\s*\d+,\s*([A-Z_]+),\s*TUNNEL/);
      const localTsMatch = childBlock.match(LOCAL_TS_RE);
      const remoteTsMatch = childBlock.match(REMOTE_TS_RE);
      const bytesInMatch = childBlock.match(/^\s*in\s+\S+,\s*(\d+)\s*bytes/m);
      const bytesOutMatch = childBlock.match(/^\s*out\s+\S+,\s*(\d+)\s*bytes/m);
      sessions.push({
        radioId, connectionName, ikeState, established, remoteAddr,
        childState: childMatch?.[1] ?? null,
        localTs: localTsMatch?.[1]?.trim().replace(/\s+/g, ',') ?? null,
        remoteTs: remoteTsMatch?.[1]?.trim().replace(/\s+/g, ',') ?? null,
        bytesIn: bytesInMatch ? Number(bytesInMatch[1]) : null,
        bytesOut: bytesOutMatch ? Number(bytesOutMatch[1]) : null,
      });
    }
  }
  return sessions;
}

// Real-time tunnel liveness, recomputed fresh from swanctl on every call — never
// persisted, never latched. This is the ONLY correct source for "is this radio's
// tunnel actually up right now" (see the SecGwRadio.status field comment for why
// the persisted PKI-lifecycle status must not be used for this). Returns an empty
// set (not an error) if the service isn't active or swanctl can't be reached —
// callers already treat "not in the set" as "not live", which is the right default.
async function getLiveRadioIds(): Promise<Set<string>> {
  const serviceActive = await nsenter('systemctl', ['is-active', SERVICE_NAME])
    .then(r => r.stdout.trim() === 'active').catch(() => false);
  if (!serviceActive) return new Set();
  const sessions = await nsenter('swanctl', ['--list-sas'], 10000)
    .then(r => parseListSas(r.stdout)).catch(() => [] as SecGwSession[]);
  return new Set(sessions.filter(s => s.established).map(s => s.radioId));
}

// ─── Configure (extracted for reuse the same way vowifi-controller.ts exports
// configureVowifi() for the PLMN Migration Wizard) ────────────────────────────
export class SecGwConfigureError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

// ─── Router ──────────────────────────────────────────────────────────────────

// Extracted so the cross-module Fix-All orchestrator (module-fixall-usecase.ts) can
// invoke the same install logic in-process — write() is the only side-channel.
export async function installSecgw(write: (s: string) => void): Promise<{ success: boolean; error?: string }> {
    const state = loadState();
    if (state.installStatus === 'installing') {
      return { success: false, error: 'An install is already in progress.' };
    }

    state.installStatus = 'installing';
    state.installStartedAt = new Date().toISOString();
    state.installError = null;
    saveState(state);

    write('=== Building strongSwan from source (patched socket-default, see secgw-build.ts) ===');
    write('This installs its own binaries under /opt/strongswan — no dependency on the distro strongswan-swanctl/charon-systemd packages. Takes a few minutes.');

    return new Promise((resolve) => {
      const child = spawn(
        'nsenter',
        ['-t', '1', '-m', '-u', '-i', '-n', '-p', '--', 'bash', '-c', buildSecgwScript()],
        { env: { ...process.env, DBUS_SYSTEM_BUS_ADDRESS: 'unix:path=/var/run/dbus/system_bus_socket' } },
      );

      child.stdout.on('data', d => write(d.toString()));
      child.stderr.on('data', d => write(d.toString()));

      child.on('error', (err) => {
        const s = loadState();
        s.installStatus = 'failed';
        s.installCompletedAt = new Date().toISOString();
        s.installError = String(err);
        saveState(s);
        write(`\nERROR: ${String(err)}`);
        resolve({ success: false, error: String(err) });
      });

      child.on('close', (code) => {
        const s = loadState();
        const builtOk = code === 0 && fs.existsSync(`/proc/1/root${SECGW_CHARON_BIN}`) && fs.existsSync(`/proc/1/root${SECGW_SWANCTL_BIN}`);
        if (builtOk) {
          s.installStatus = 'complete';
          s.installCompletedAt = new Date().toISOString();
          s.builtWithPatchRev = SECGW_PATCH_REV;
          write('\n=== strongSwan built and installed successfully ===');
        } else {
          s.installStatus = 'failed';
          s.installCompletedAt = new Date().toISOString();
          s.installError = code === 0
            ? 'Build finished but expected binaries were not found under /opt/strongswan.'
            : `Build exited with code ${code}`;
          write(`\n=== Install FAILED: ${s.installError} ===`);
        }
        saveState(s);
        resolve({ success: builtOk, error: builtOk ? undefined : (s.installError ?? undefined) });
      });
    });
}

// Extracted so the cross-module Fix-All orchestrator (module-fixall-usecase.ts) can
// invoke the same configure logic in-process, always passing the last-saved gatewayIp/
// interfaceMode/poolCidr explicitly rather than an empty body — re-running Configure with
// defaults would silently reset real per-deployment values (DEFAULT_GATEWAY_IP/DEFAULT_POOL_CIDR).
export async function configureSecgw(input: {
  gatewayIp: string; interfaceMode: 'dummy' | 'existing'; poolCidr: string;
}): Promise<{ success: boolean; error?: string; gatewayIp?: string; interfaceMode?: string; gatewayFqdn?: string; poolCidr?: string; bindZoneExists?: boolean; dnsRecordAdded?: boolean }> {
  const gatewayIp = input.gatewayIp || DEFAULT_GATEWAY_IP;
  const interfaceMode = input.interfaceMode === 'existing' ? 'existing' : 'dummy';
  const poolCidr = input.poolCidr || DEFAULT_POOL_CIDR;
  try {
      const state = loadState();
      if (state.installStatus !== 'complete') {
        return { success: false, error: 'Run Install first — strongSwan is not installed yet.' };
      }
      if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(gatewayIp)) {
        return { success: false, error: 'Invalid gatewayIp' };
      }
      if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}$/.test(poolCidr)) {
        return { success: false, error: 'Invalid poolCidr — expected CIDR notation, e.g. 10.0.1.200/29' };
      }

      // Gateway IP — same dummy-interface convention as every other module, but
      // unlike VoWiFi's ePDG IP, this one MUST be reachable from real RAN radios
      // behind the existing EIGRP-carried topology; the frontend Setup tab shows a
      // manual frr.conf hint before Configure runs (this backend never touches
      // frr.conf itself — CLAUDE.md gotcha #7).
      if (interfaceMode === 'dummy') {
        await createDummyInterface(DUMMY_IF_NAME, gatewayIp, 24, true);
      } else {
        const ipPresent = await nsenter('bash', ['-c', `ip -o addr show | awk '{print $4}' | cut -d/ -f1 | grep -qx '${gatewayIp}' && echo yes || echo no`])
          .then(r => r.stdout.trim() === 'yes').catch(() => false);
        if (!ipPresent) {
          return {
            success: false,
            error: `${gatewayIp} is not currently assigned to any interface on this host (checked with "ip addr show"). ` +
              `In "use existing IP" mode you must bind it yourself first, then retry.`,
          };
        }
      }

      const realm = deriveRealm();
      const gatewayFqdn = `secgw.${realm}`;

      fs.mkdirSync(HOST_SECGW_PKI_DIR, { recursive: true });
      fs.mkdirSync(HOST_SWANCTL_X509_DIR, { recursive: true });
      fs.mkdirSync(HOST_SWANCTL_X509CA_DIR, { recursive: true });
      fs.mkdirSync(HOST_SWANCTL_PRIVATE_DIR, { recursive: true });
      fs.mkdirSync(HOST_SWANCTL_CONFD_DIR, { recursive: true });
      await nsenter('bash', ['-c', secgwCaAndServerCertGenScript(gatewayFqdn)], 30000);

      fs.writeFileSync(HOST_SWANCTL_CONF, baseSwanctlConf(), 'utf-8');
      // Rewritten every Configure run — gatewayIp (baked in as SECGW_BIND_ADDR) can
      // change on a reconfigure, so the unit can't just be written once at Install.
      fs.writeFileSync(HOST_SYSTEMD_UNIT_PATH, secgwSystemdUnit(gatewayIp), 'utf-8');
      await nsenter('systemctl', ['daemon-reload'], 20000).catch(() => {});
      await nsenter('systemctl', ['enable', '--now', SERVICE_NAME], 20000).catch(() => {});
      // Restart (not just start) in case the service was already running with a stale
      // unit/SECGW_BIND_ADDR from a previous gatewayIp — enable --now is a no-op if
      // already active, so this guarantees the new bind address actually takes effect.
      await nsenter('systemctl', ['restart', SERVICE_NAME], 20000).catch(() => {});
      await ensurePoolRoute(poolCidr, gatewayIp);
      await nsenter('swanctl', ['--load-all'], 15000).catch(() => {});

      const newState: SecGwState = {
        ...state, configured: true, configuredAt: new Date().toISOString(),
        configuredWithVersion: SECGW_CONFIG_GEN_VERSION,
        gatewayIp, interfaceMode, gatewayFqdn, poolCidr,
        caCreatedAt: state.caCreatedAt ?? new Date().toISOString(),
      };
      saveState(newState);

      // Best-effort — BIND may not be installed / the DNS Migration Wizard may never
      // have been run on this host yet, and that's fine: upsertSecgwDnsRecord() just
      // reports zoneExists:false in that case rather than throwing, so Configure still
      // succeeds. The Setup tab surfaces a retry action via POST /dns-record for later.
      const dns = await upsertSecgwDnsRecord(gatewayIp);

      return { success: true, gatewayIp, interfaceMode, gatewayFqdn, poolCidr, bindZoneExists: dns.zoneExists, dnsRecordAdded: dns.added };
    } catch (err) {
      return { success: false, error: String(err instanceof Error ? err.message : err) };
    }
}

export interface SecgwStalenessResult {
  installedOnDisk: boolean;
  hasSavedConfig: boolean;
  buildStale: boolean;
  configStale: boolean;
  builtWithPatchRev?: number;
  configuredWithVersion?: number;
  savedGatewayIp?: string;
  savedInterfaceMode?: 'dummy' | 'existing';
  savedPoolCidr?: string;
}

// Cheap staleness check for the cross-module Fix-All aggregator — mirrors the
// comparison GET /status already does, without the rest of that endpoint's work
// (swanctl session listing, DNS status, etc).
export function getSecgwStaleness(): SecgwStalenessResult {
  const state = loadState();
  const installedOnDisk = fs.existsSync(`/proc/1/root${SECGW_CHARON_BIN}`) && fs.existsSync(`/proc/1/root${SECGW_SWANCTL_BIN}`);
  const buildStale = installedOnDisk && state.builtWithPatchRev !== SECGW_PATCH_REV;
  const configStale = state.configured && state.configuredWithVersion !== SECGW_CONFIG_GEN_VERSION;
  return {
    installedOnDisk,
    hasSavedConfig: state.configured,
    buildStale,
    configStale,
    builtWithPatchRev: state.builtWithPatchRev ?? undefined,
    configuredWithVersion: state.configuredWithVersion ?? undefined,
    savedGatewayIp: state.gatewayIp ?? undefined,
    savedInterfaceMode: state.interfaceMode ?? undefined,
    savedPoolCidr: state.poolCidr ?? undefined,
  };
}

export function createSecgwRouter(logger: pino.Logger, auditLogger: IAuditLogger): Router {
  const router = Router();

  router.get('/status', async (_req: Request, res: Response) => {
    try {
      const state = loadState();
      const installedOnDisk = fs.existsSync(`/proc/1/root${SECGW_CHARON_BIN}`) && fs.existsSync(`/proc/1/root${SECGW_SWANCTL_BIN}`);
      const buildStale = installedOnDisk && state.builtWithPatchRev !== SECGW_PATCH_REV;
      const serviceActive = await nsenter('systemctl', ['is-active', SERVICE_NAME])
        .then(r => r.stdout.trim() === 'active').catch(() => false);
      const dummyInterfaceUp = await nsenter('bash', ['-c', `ip link show ${DUMMY_IF_NAME} >/dev/null 2>&1 && echo yes || echo no`])
        .then(r => r.stdout.trim() === 'yes').catch(() => false);

      let sessions: SecGwSession[] = [];
      if (serviceActive) {
        sessions = await nsenter('swanctl', ['--list-sas'], 10000)
          .then(r => parseListSas(r.stdout)).catch(() => []);
      }

      const configStale = state.configured && state.configuredWithVersion !== SECGW_CONFIG_GEN_VERSION;
      const dnsStatus = readSecgwDnsRecordStatus(state.gatewayIp);
      // Dedup by radioId, not session-row count — a single radio can now produce
      // multiple session rows (one per CHILD_SA, e.g. a Nokia radio using
      // extraLocalCidrs), so counting rows directly would overcount active tunnels.
      const liveRadioIds = new Set(sessions.filter(s => s.established).map(s => s.radioId));
      const activeTunnelCount = liveRadioIds.size;
      const nonRevokedRadios = state.radios.filter(r => r.status !== 'revoked');
      if (state.radios.some(r => r.status === 'pending' && liveRadioIds.has(r.id))) {
        for (const r of state.radios) {
          if (r.status === 'pending' && liveRadioIds.has(r.id)) r.status = 'active';
        }
        saveState(state);
      }

      res.json({
        success: true,
        installedOnDisk,
        builtWithPatchRev: state.builtWithPatchRev,
        currentPatchRev: SECGW_PATCH_REV,
        buildStale,
        installStatus: state.installStatus,
        installStartedAt: state.installStartedAt,
        installCompletedAt: state.installCompletedAt,
        installError: state.installError,
        configured: state.configured,
        configuredAt: state.configuredAt,
        configuredWithVersion: state.configuredWithVersion,
        currentConfigGenVersion: SECGW_CONFIG_GEN_VERSION,
        configStale,
        gatewayIp: state.gatewayIp,
        interfaceMode: state.interfaceMode,
        gatewayFqdn: state.gatewayFqdn,
        poolCidr: state.poolCidr,
        dummyInterfaceUp,
        serviceActive,
        bindZoneExists: dnsStatus.zoneExists,
        dnsRecordPresent: dnsStatus.recordPresent,
        radioCount: nonRevokedRadios.length,
        pendingRadioCount: nonRevokedRadios.filter(r => r.status === 'pending').length,
        activeTunnelCount,
      });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  router.get('/sessions', async (_req: Request, res: Response) => {
    try {
      const state = loadState();
      const { stdout } = await nsenter('swanctl', ['--list-sas'], 10000).catch(() => ({ stdout: '' }));
      const sessions = parseListSas(stdout).map(s => ({
        ...s,
        radioName: state.radios.find(r => r.id === s.radioId)?.name ?? s.radioId,
      }));
      res.json({ success: true, sessions });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  router.post('/install', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const preState = loadState();
    if (preState.installStatus === 'installing') {
      res.status(409).json({ success: false, error: 'An install is already in progress.' });
      return;
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();
    const write = (s: string) => { res.write(s.endsWith('\n') ? s : s + '\n'); };
    const result = await installSecgw(write);
    await auditLogger.log({ action: 'secgw_install', user, details: result.error ?? 'success', success: result.success });
    res.end();
  });

  router.post('/configure', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const body = req.body ?? {};
    const result = await configureSecgw({
      gatewayIp: typeof body.gatewayIp === 'string' ? body.gatewayIp : '',
      interfaceMode: body.interfaceMode === 'existing' ? 'existing' : 'dummy',
      poolCidr: typeof body.poolCidr === 'string' ? body.poolCidr : '',
    });
    if (!result.success) {
      await auditLogger.log({ action: 'secgw_configure', user, details: result.error ?? 'failed', success: false });
      return res.status(400).json({ success: false, error: result.error });
    }
    await auditLogger.log({ action: 'secgw_configure', user, details: `gatewayIp=${result.gatewayIp} interfaceMode=${result.interfaceMode} poolCidr=${result.poolCidr} dnsRecordAdded=${result.dnsRecordAdded}`, success: true });
    res.json({ success: true, gatewayIp: result.gatewayIp, interfaceMode: result.interfaceMode, gatewayFqdn: result.gatewayFqdn, poolCidr: result.poolCidr, bindZoneExists: result.bindZoneExists, dnsRecordAdded: result.dnsRecordAdded });
  });

  // Retry hook for "add the secgw DNS record now" — for when BIND9 (and the internal
  // epc zone via the DNS/FQDN Migration Wizard) gets set up AFTER SecGW was already
  // configured, since Configure's own attempt above is silent/best-effort.
  router.post('/dns-record', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      const state = loadState();
      if (!state.gatewayIp) {
        res.status(409).json({ success: false, error: 'Configure SecGW first — no gateway IP set.' });
        return;
      }
      const result = await upsertSecgwDnsRecord(state.gatewayIp);
      if (!result.zoneExists) {
        res.status(409).json({
          success: false,
          error: 'The internal "epc" DNS zone does not exist yet — install/configure BIND9 and run the DNS/FQDN Migration Wizard first, then retry.',
        });
        return;
      }
      await auditLogger.log({ action: 'secgw_dns_record_add', user, details: `gatewayIp=${state.gatewayIp}`, success: true });
      res.json({ success: true, added: result.added });
    } catch (err) {
      await auditLogger.log({ action: 'secgw_dns_record_add', user, details: String(err), success: false });
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  router.post('/start', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      await nsenter('systemctl', ['enable', '--now', SERVICE_NAME], 20000);
      await auditLogger.log({ action: 'secgw_start', user, details: 'Started strongSwan', success: true });
      res.json({ success: true });
    } catch (err) {
      await auditLogger.log({ action: 'secgw_start', user, details: String(err), success: false });
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  router.post('/stop', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      await nsenter('systemctl', ['disable', '--now', SERVICE_NAME], 20000);
      await auditLogger.log({ action: 'secgw_stop', user, details: 'Stopped strongSwan', success: true });
      res.json({ success: true });
    } catch (err) {
      await auditLogger.log({ action: 'secgw_stop', user, details: String(err), success: false });
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  router.post('/restart', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      await nsenter('systemctl', ['restart', SERVICE_NAME], 20000);
      await nsenter('swanctl', ['--load-all'], 15000).catch(() => {});
      await auditLogger.log({ action: 'secgw_restart', user, details: 'Restarted strongSwan', success: true });
      res.json({ success: true });
    } catch (err) {
      await auditLogger.log({ action: 'secgw_restart', user, details: String(err), success: false });
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  router.get('/radios', async (_req: Request, res: Response) => {
    try {
      const liveRadioIds = await getLiveRadioIds();
      const radios = loadState().radios.map(r => ({ ...r, tunnelActive: liveRadioIds.has(r.id) }));
      res.json({ success: true, radios });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  router.post('/radios', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      const state = loadState();
      if (!state.configured || !state.gatewayIp || !state.gatewayFqdn) {
        res.status(409).json({ success: false, error: 'Configure SecGW before adding radios.' });
        return;
      }
      const body = req.body ?? {};
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      const vendor: SecGwRadioVendor = body.vendor === 'nokia' ? 'nokia' : 'baicells';
      const radioType: SecGwRadioType = body.radioType === '5g' ? '5g' : '4g';
      const genieacsDeviceId = typeof body.genieacsDeviceId === 'string' && body.genieacsDeviceId ? body.genieacsDeviceId : null;
      const manualIdentifier = typeof body.manualIdentifier === 'string' && body.manualIdentifier ? body.manualIdentifier : null;
      if (!name) {
        res.status(400).json({ success: false, error: 'name is required' });
        return;
      }
      if (!genieacsDeviceId && !manualIdentifier) {
        res.status(400).json({ success: false, error: 'Provide either genieacsDeviceId or manualIdentifier' });
        return;
      }

      // Nokia is PSK-only for now — no cert/PKI path implemented yet (same "build what's
      // actually needed first" reasoning Baicells originally followed the other way).
      const authMode: SecGwAuthMode = vendor === 'nokia' ? 'psk' : (body.authMode === 'psk' ? 'psk' : 'cert');
      const ikeEncOptions = vendor === 'nokia' ? NOKIA_IKE_ENCRYPTION_OPTIONS : IKE_ENCRYPTION_OPTIONS;
      const ikeIntOptions = vendor === 'nokia' ? NOKIA_IKE_INTEGRITY_OPTIONS : IKE_INTEGRITY_OPTIONS;
      const ikeDhOptions = vendor === 'nokia' ? NOKIA_IKE_DH_GROUP_OPTIONS : IKE_DH_GROUP_OPTIONS;
      const espEncOptions = vendor === 'nokia' ? NOKIA_ESP_ENCRYPTION_OPTIONS : ESP_ENCRYPTION_OPTIONS;
      const espIntOptions = vendor === 'nokia' ? NOKIA_ESP_INTEGRITY_OPTIONS : ESP_INTEGRITY_OPTIONS;
      const ikeEncryption = isValidOption(ikeEncOptions, body.ikeEncryption) ? body.ikeEncryption : 'aes256';
      const ikeIntegrity = isValidOption(ikeIntOptions, body.ikeIntegrity) ? body.ikeIntegrity : 'sha256';
      const ikeDhGroup = isValidOption(ikeDhOptions, body.ikeDhGroup) ? body.ikeDhGroup : 'modp2048';
      const espEncryption = isValidOption(espEncOptions, body.espEncryption) ? body.espEncryption : 'aes256';
      const espIntegrity = isValidOption(espIntOptions, body.espIntegrity) ? body.espIntegrity : 'sha256';
      const espDhGroup = isValidOption(ESP_DH_GROUP_OPTIONS, body.espDhGroup) ? body.espDhGroup : 'modp2048';
      // Operator-supplied PSK is honored (so it can be set to match a value already
      // typed into the radio), otherwise a strong random one is generated — either
      // way it's surfaced once in the connection-info sheet for the operator to copy.
      const psk = authMode === 'psk'
        ? (typeof body.psk === 'string' && body.psk.trim() ? body.psk.trim() : generatePsk())
        : null;

      // Nokia-only settings — see the matching SecGwRadio field comments for what each
      // maps to (some are swanctl-generating, several are informational-only).
      const ikeSaMode: SecGwIkeSaMode = body.ikeSaMode === 'responder' ? 'responder' : 'initiator_responder';
      const ikeReauthEnabled = body.ikeReauthEnabled === true;
      const pfsEnabled = body.pfsEnabled !== false; // defaults on — matches Baicells' always-on PFS behavior
      const pfsDhGroup = isValidOption(NOKIA_PFS_DH_GROUP_OPTIONS, body.pfsDhGroup) ? body.pfsDhGroup : ikeDhGroup;
      const antiReplayEnabled = body.antiReplayEnabled !== false;
      const antiReplayWindowSize: 64 | 28 = body.antiReplayWindowSize === 28 ? 28 : 64;
      const dpdDelaySeconds = Number.isFinite(Number(body.dpdDelaySeconds)) ? Math.min(360, Math.max(10, Number(body.dpdDelaySeconds))) : 30;
      const ikeSaLifetimeSeconds = Number.isFinite(Number(body.ikeSaLifetimeSeconds)) ? Math.min(86400, Math.max(3600, Number(body.ikeSaLifetimeSeconds))) : 28800;
      const childSaLifetimeSeconds = Number.isFinite(Number(body.childSaLifetimeSeconds)) ? Math.min(86400, Math.max(300, Number(body.childSaLifetimeSeconds))) : 3600;
      const localIpAddress = typeof body.localIpAddress === 'string' && body.localIpAddress.trim() ? body.localIpAddress.trim() : null;

      const id = `radio-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const realm = deriveRealm();
      const peerIdentity = `${id}.secgw.${realm}`;
      const destination: 'mme_sgwu' | 'amf_upf' = radioType === '5g' ? 'amf_upf' : 'mme_sgwu';
      const extraLocalCidrs = parseExtraLocalCidrs(body.extraLocalCidrs);
      if (extraLocalCidrs === null) {
        res.status(400).json({ success: false, error: 'Additional Protected Destinations must be valid IPv4 addresses or CIDRs, comma-separated.' });
        return;
      }
      const localTs = combineLocalTs(radioType, extraLocalCidrs);
      // Every radio gets its OWN dedicated single-address pool, never a shared range —
      // see allocatePoolAddress()'s comment for the real outage (2026-08-13) this fixes:
      // multiple radios sharing one pool CIDR as remote_ts collided on a single kernel
      // XFRM policy slot, and whichever negotiated last silently stole it from the rest.
      // Baicells-only mechanism — Nokia has no CP support, see resolveRemoteTs()'s comment.
      const poolCidr = state.poolCidr ?? DEFAULT_POOL_CIDR;
      const usedAddresses = new Set(
        state.radios.filter(r => r.status !== 'revoked' && r.poolAddress).map(r => r.poolAddress as string),
      );
      const resolvedTs = resolveRemoteTs(vendor, localIpAddress, poolCidr, usedAddresses);
      if ('status' in resolvedTs) {
        res.status(resolvedTs.status).json({ success: false, error: resolvedTs.error });
        return;
      }
      const { poolAddress, remoteTsAddress } = resolvedTs;
      const remoteTs = `${remoteTsAddress}/32`;

      fs.mkdirSync(`${HOST_SECGW_RADIOS_DIR}/${id}`, { recursive: true });
      let certIssuedAt: string | null = null; let certExpiresAt: string | null = null; let certSerial: string | null = null;
      if (authMode === 'cert') {
        await nsenter('bash', ['-c', secgwRadioClientCertGenScript(id, peerIdentity)], 30000);
        ({ certIssuedAt, certExpiresAt, certSerial } = await readCertMeta(`${SECGW_PKI_DIR}/client-${id}.crt`));
      }

      fs.mkdirSync(HOST_SWANCTL_CONFD_DIR, { recursive: true });
      fs.writeFileSync(`${HOST_SWANCTL_CONFD_DIR}/${id}.conf`, swanctlRadioConnConf({
        radioId: id, gatewayIp: state.gatewayIp, gatewayFqdn: state.gatewayFqdn, peerIdentity, localTs,
        remoteTsAddress, poolAddress,
        vendor, authMode, psk, ikeEncryption, ikeIntegrity, ikeDhGroup, espEncryption, espIntegrity, espDhGroup,
        ikeReauthEnabled, pfsEnabled, pfsDhGroup, dpdDelaySeconds, ikeSaLifetimeSeconds, childSaLifetimeSeconds,
      }), 'utf-8');
      await nsenter('swanctl', ['--load-all'], 15000);

      fs.writeFileSync(`${HOST_SECGW_RADIOS_DIR}/${id}/connection-info.txt`,
        vendor === 'nokia'
          ? nokiaConnectionInfoSheet({
              radioName: name, radioType, gatewayIp: state.gatewayIp, gatewayFqdn: state.gatewayFqdn,
              peerIdentity, localTs, psk,
              ikeEncryption, ikeIntegrity, ikeDhGroup, espEncryption, espIntegrity,
              ikeSaMode, ikeReauthEnabled, pfsEnabled, pfsDhGroup, antiReplayEnabled, antiReplayWindowSize,
              dpdDelaySeconds, ikeSaLifetimeSeconds, childSaLifetimeSeconds, localIpAddress,
            })
          : baicellsConnectionInfoSheet({
              radioName: name, radioType, gatewayIp: state.gatewayIp, gatewayFqdn: state.gatewayFqdn,
              peerIdentity, localTs, poolAddress: poolAddress!, authMode, psk,
              ikeEncryption, ikeIntegrity, ikeDhGroup, espEncryption, espIntegrity, espDhGroup, certExpiresAt,
            }),
        'utf-8');

      const radio: SecGwRadio = {
        id, name, vendor, radioType, genieacsDeviceId, manualIdentifier, peerIdentity, destination,
        localTs, extraLocalCidrs, remoteTs, poolAddress, authMode, psk,
        ikeEncryption, ikeIntegrity, ikeDhGroup, espEncryption, espIntegrity, espDhGroup,
        certIssuedAt, certExpiresAt, certSerial, status: 'pending', enabled: true,
        ikeSaMode, ikeReauthEnabled, pfsEnabled, pfsDhGroup, antiReplayEnabled, antiReplayWindowSize,
        dpdDelaySeconds, ikeSaLifetimeSeconds, childSaLifetimeSeconds, localIpAddress,
      };
      state.radios.push(radio);
      saveState(state);

      await auditLogger.log({ action: 'secgw_radio_add', user, details: `id=${id} name=${name} vendor=${vendor} radioType=${radioType} authMode=${authMode}`, success: true });
      res.json({ success: true, radio });
    } catch (err) {
      await auditLogger.log({ action: 'secgw_radio_add', user, details: String(err), success: false });
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // Full edit — any field can be changed after creation, not just credential rotation.
  // Rewrites the radio's conf.d file + connection-info.txt and reloads swanctl, so any
  // in-progress SA is torn down and must reconnect with the new settings. Switching
  // authMode handles the cert/PSK lifecycle transition (generates a cert when switching
  // into cert mode, deletes the old one when switching out of it). Not allowed on a
  // revoked radio — add a new one instead, same rule rotate-credential already applies.
  router.put('/radios/:id', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      const state = loadState();
      const radio = state.radios.find(r => r.id === req.params.id);
      if (!radio) {
        res.status(404).json({ success: false, error: 'Radio not found' });
        return;
      }
      if (radio.status === 'revoked') {
        res.status(409).json({ success: false, error: 'Radio is revoked — add a new radio instead of editing it.' });
        return;
      }
      if (!state.gatewayIp || !state.gatewayFqdn) {
        res.status(409).json({ success: false, error: 'SecGW is not configured.' });
        return;
      }

      const body = req.body ?? {};
      const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : radio.name;
      // vendor is fixed at creation — not editable (mirrors radio.peerIdentity, both are
      // established identity/config-family choices, not day-to-day tunable settings).
      const radioType: SecGwRadioType = body.radioType === '5g' || body.radioType === '4g' ? body.radioType : radio.radioType;
      const genieacsDeviceId = typeof body.genieacsDeviceId === 'string' ? (body.genieacsDeviceId || null) : radio.genieacsDeviceId;
      const manualIdentifier = typeof body.manualIdentifier === 'string' ? (body.manualIdentifier || null) : radio.manualIdentifier;
      const authMode: SecGwAuthMode = radio.vendor === 'nokia' ? 'psk' : (body.authMode === 'psk' || body.authMode === 'cert' ? body.authMode : radio.authMode);
      const ikeEncOptions = radio.vendor === 'nokia' ? NOKIA_IKE_ENCRYPTION_OPTIONS : IKE_ENCRYPTION_OPTIONS;
      const ikeIntOptions = radio.vendor === 'nokia' ? NOKIA_IKE_INTEGRITY_OPTIONS : IKE_INTEGRITY_OPTIONS;
      const ikeDhOptions = radio.vendor === 'nokia' ? NOKIA_IKE_DH_GROUP_OPTIONS : IKE_DH_GROUP_OPTIONS;
      const espEncOptions = radio.vendor === 'nokia' ? NOKIA_ESP_ENCRYPTION_OPTIONS : ESP_ENCRYPTION_OPTIONS;
      const espIntOptions = radio.vendor === 'nokia' ? NOKIA_ESP_INTEGRITY_OPTIONS : ESP_INTEGRITY_OPTIONS;
      const ikeEncryption = isValidOption(ikeEncOptions, body.ikeEncryption) ? body.ikeEncryption : radio.ikeEncryption;
      const ikeIntegrity = isValidOption(ikeIntOptions, body.ikeIntegrity) ? body.ikeIntegrity : radio.ikeIntegrity;
      const ikeDhGroup = isValidOption(ikeDhOptions, body.ikeDhGroup) ? body.ikeDhGroup : radio.ikeDhGroup;
      const espEncryption = isValidOption(espEncOptions, body.espEncryption) ? body.espEncryption : radio.espEncryption;
      const espIntegrity = isValidOption(espIntOptions, body.espIntegrity) ? body.espIntegrity : radio.espIntegrity;
      const espDhGroup = isValidOption(ESP_DH_GROUP_OPTIONS, body.espDhGroup) ? body.espDhGroup : radio.espDhGroup;

      // Nokia-only settings — see the matching SecGwRadio field comments.
      const ikeSaMode: SecGwIkeSaMode = body.ikeSaMode === 'responder' || body.ikeSaMode === 'initiator_responder' ? body.ikeSaMode : radio.ikeSaMode;
      const ikeReauthEnabled = typeof body.ikeReauthEnabled === 'boolean' ? body.ikeReauthEnabled : radio.ikeReauthEnabled;
      const pfsEnabled = typeof body.pfsEnabled === 'boolean' ? body.pfsEnabled : radio.pfsEnabled;
      const pfsDhGroup = isValidOption(NOKIA_PFS_DH_GROUP_OPTIONS, body.pfsDhGroup) ? body.pfsDhGroup : radio.pfsDhGroup;
      const antiReplayEnabled = typeof body.antiReplayEnabled === 'boolean' ? body.antiReplayEnabled : radio.antiReplayEnabled;
      const antiReplayWindowSize: 64 | 28 = body.antiReplayWindowSize === 28 || body.antiReplayWindowSize === 64 ? body.antiReplayWindowSize : radio.antiReplayWindowSize;
      const dpdDelaySeconds = Number.isFinite(Number(body.dpdDelaySeconds)) ? Math.min(360, Math.max(10, Number(body.dpdDelaySeconds))) : radio.dpdDelaySeconds;
      const ikeSaLifetimeSeconds = Number.isFinite(Number(body.ikeSaLifetimeSeconds)) ? Math.min(86400, Math.max(3600, Number(body.ikeSaLifetimeSeconds))) : radio.ikeSaLifetimeSeconds;
      const childSaLifetimeSeconds = Number.isFinite(Number(body.childSaLifetimeSeconds)) ? Math.min(86400, Math.max(300, Number(body.childSaLifetimeSeconds))) : radio.childSaLifetimeSeconds;
      const localIpAddress = typeof body.localIpAddress === 'string' ? (body.localIpAddress.trim() || null) : radio.localIpAddress;

      const authModeChanged = authMode !== radio.authMode;
      const radioTypeChanged = radioType !== radio.radioType;
      const destination: 'mme_sgwu' | 'amf_upf' = radioType === '5g' ? 'amf_upf' : 'mme_sgwu';
      const extraLocalCidrs = typeof body.extraLocalCidrs === 'string' ? parseExtraLocalCidrs(body.extraLocalCidrs) : radio.extraLocalCidrs;
      if (extraLocalCidrs === null) {
        res.status(400).json({ success: false, error: 'Additional Protected Destinations must be valid IPv4 addresses or CIDRs, comma-separated.' });
        return;
      }
      // Always recomputed (not "only when radioType changed") so an edit to
      // extraLocalCidrs alone actually takes effect. See combineLocalTs()'s comment.
      const localTs = combineLocalTs(radioType, extraLocalCidrs);
      // Baicells: stable across edits — reallocating on every save would be pointless
      // churn and, worse, briefly free up this radio's address for another radio to
      // grab. Only ever (re)allocated if somehow still null (a radio added before this
      // field existed). See allocatePoolAddress()'s comment for why this must stay
      // unique. Nokia has no CP support (see resolveRemoteTs()'s comment) — its
      // remote_ts is always derived fresh from localIpAddress, since that's the actual
      // load-bearing input, not something to "stabilize" the way an allocation is.
      let poolAddress: string | null;
      let remoteTsAddress: string;
      if (radio.vendor === 'nokia') {
        if (!localIpAddress) {
          res.status(400).json({
            success: false,
            error: "Local IP Address is required for Nokia radios — it's used as the remote traffic selector.",
          });
          return;
        }
        poolAddress = null;
        remoteTsAddress = localIpAddress;
      } else if (radio.poolAddress) {
        poolAddress = radio.poolAddress;
        remoteTsAddress = radio.poolAddress;
      } else {
        const poolCidr = state.poolCidr ?? DEFAULT_POOL_CIDR;
        const usedAddresses = new Set(
          state.radios.filter(r => r.id !== radio.id && r.status !== 'revoked' && r.poolAddress).map(r => r.poolAddress as string),
        );
        const allocated = allocatePoolAddress(poolCidr, usedAddresses);
        if (!allocated) {
          res.status(409).json({ success: false, error: `The virtual IP pool (${poolCidr}) is exhausted — widen it on the Setup tab.` });
          return;
        }
        poolAddress = allocated;
        remoteTsAddress = allocated;
      }
      const remoteTs = `${remoteTsAddress}/32`;

      let psk = radio.psk;
      if (authMode === 'psk') {
        if (typeof body.psk === 'string' && body.psk.trim()) psk = body.psk.trim();
        else if (!psk) psk = generatePsk();
      } else {
        psk = null;
      }

      let certIssuedAt = radio.certIssuedAt; let certExpiresAt = radio.certExpiresAt; let certSerial = radio.certSerial;
      if (authMode === 'cert' && (authModeChanged || !certExpiresAt)) {
        await nsenter('bash', ['-c', secgwRadioClientCertGenScript(radio.id, radio.peerIdentity)], 30000);
        ({ certIssuedAt, certExpiresAt, certSerial } = await readCertMeta(`${SECGW_PKI_DIR}/client-${radio.id}.crt`));
      } else if (authMode === 'psk' && authModeChanged) {
        // Switching a radio OUT of cert mode — this is an edit, not a security revoke
        // (see secgwRevokeRadioCertScript's audit-trail reasoning), so the now-unused
        // cert is just deleted rather than moved to revoked/.
        await nsenter('bash', ['-c', `rm -f ${SECGW_PKI_DIR}/client-${radio.id}.crt ${SECGW_PKI_DIR}/client-${radio.id}.key`], 15000).catch(() => {});
        certIssuedAt = null; certExpiresAt = null; certSerial = null;
      }

      fs.mkdirSync(HOST_SWANCTL_CONFD_DIR, { recursive: true });
      fs.writeFileSync(`${HOST_SWANCTL_CONFD_DIR}/${radio.id}.conf`, swanctlRadioConnConf({
        radioId: radio.id, gatewayIp: state.gatewayIp, gatewayFqdn: state.gatewayFqdn, peerIdentity: radio.peerIdentity,
        localTs, remoteTsAddress, poolAddress, vendor: radio.vendor, authMode, psk, ikeEncryption, ikeIntegrity, ikeDhGroup, espEncryption, espIntegrity, espDhGroup,
        ikeReauthEnabled, pfsEnabled, pfsDhGroup, dpdDelaySeconds, ikeSaLifetimeSeconds, childSaLifetimeSeconds,
      }), 'utf-8');
      await nsenter('swanctl', ['--load-all'], 15000).catch(() => {});

      fs.mkdirSync(`${HOST_SECGW_RADIOS_DIR}/${radio.id}`, { recursive: true });
      fs.writeFileSync(`${HOST_SECGW_RADIOS_DIR}/${radio.id}/connection-info.txt`,
        radio.vendor === 'nokia'
          ? nokiaConnectionInfoSheet({
              radioName: name, radioType, gatewayIp: state.gatewayIp, gatewayFqdn: state.gatewayFqdn,
              peerIdentity: radio.peerIdentity, localTs, psk,
              ikeEncryption, ikeIntegrity, ikeDhGroup, espEncryption, espIntegrity,
              ikeSaMode, ikeReauthEnabled, pfsEnabled, pfsDhGroup, antiReplayEnabled, antiReplayWindowSize,
              dpdDelaySeconds, ikeSaLifetimeSeconds, childSaLifetimeSeconds, localIpAddress,
            })
          : baicellsConnectionInfoSheet({
              radioName: name, radioType, gatewayIp: state.gatewayIp, gatewayFqdn: state.gatewayFqdn,
              peerIdentity: radio.peerIdentity, localTs, poolAddress: poolAddress!, authMode, psk,
              ikeEncryption, ikeIntegrity, ikeDhGroup, espEncryption, espIntegrity, espDhGroup, certExpiresAt,
            }),
        'utf-8');

      Object.assign(radio, {
        name, radioType, genieacsDeviceId, manualIdentifier, remoteTs, poolAddress, localTs, extraLocalCidrs, destination, authMode, psk,
        ikeEncryption, ikeIntegrity, ikeDhGroup, espEncryption, espIntegrity, espDhGroup,
        certIssuedAt, certExpiresAt, certSerial,
        ikeSaMode, ikeReauthEnabled, pfsEnabled, pfsDhGroup, antiReplayEnabled, antiReplayWindowSize,
        dpdDelaySeconds, ikeSaLifetimeSeconds, childSaLifetimeSeconds, localIpAddress,
        // Config changed underneath any live SA — it must reconnect, so this no longer
        // counts as a confirmed-live tunnel until Test Tunnel (or the next /status
        // poll) sees a fresh established SA again.
        status: 'pending',
      });
      saveState(state);

      await auditLogger.log({ action: 'secgw_radio_edit', user, details: `id=${radio.id} authMode=${authMode}`, success: true });
      res.json({ success: true, radio });
    } catch (err) {
      await auditLogger.log({ action: 'secgw_radio_edit', user, details: String(err), success: false });
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // Administrative disable — independent of revoke: unloads this radio's swanctl
  // connection and tears down any live SA, but keeps its certificate/PSK and
  // conf.d generation inputs intact so /enable can bring it straight back without
  // re-provisioning. Same unload sequence DELETE /radios/:id already uses (remove
  // the conf.d file, --load-all, --terminate the IKE_SA), just without the
  // cert-revoke/status='revoked' step.
  router.post('/radios/:id/disable', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      const state = loadState();
      const radio = state.radios.find(r => r.id === req.params.id);
      if (!radio) { res.status(404).json({ success: false, error: 'Radio not found' }); return; }
      if (radio.status === 'revoked') { res.status(409).json({ success: false, error: 'Radio is revoked' }); return; }

      const confPath = `${HOST_SWANCTL_CONFD_DIR}/${radio.id}.conf`;
      if (fs.existsSync(confPath)) fs.unlinkSync(confPath);
      await nsenter('swanctl', ['--load-all'], 15000).catch(() => {});
      await nsenter('swanctl', ['--terminate', '--ike', `secgw-${radio.id}`], 10000).catch(() => {});

      radio.enabled = false;
      saveState(state);
      await auditLogger.log({ action: 'secgw_radio_disable', user, details: `id=${radio.id} name=${radio.name}`, success: true });
      res.json({ success: true, radio });
    } catch (err) {
      await auditLogger.log({ action: 'secgw_radio_disable', user, details: String(err), success: false });
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // Re-enable — regenerates the same conf.d file from the radio's already-stored
  // settings (identical to what add/edit would generate) and loads it, so the
  // radio can reconnect without touching its certificate/PSK.
  router.post('/radios/:id/enable', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      const state = loadState();
      const radio = state.radios.find(r => r.id === req.params.id);
      if (!radio) { res.status(404).json({ success: false, error: 'Radio not found' }); return; }
      if (radio.status === 'revoked') { res.status(409).json({ success: false, error: 'Radio is revoked' }); return; }
      if (!state.gatewayIp || !state.gatewayFqdn) { res.status(409).json({ success: false, error: 'SecGW is not configured' }); return; }

      fs.mkdirSync(HOST_SWANCTL_CONFD_DIR, { recursive: true });
      fs.writeFileSync(`${HOST_SWANCTL_CONFD_DIR}/${radio.id}.conf`, swanctlRadioConnConf({
        radioId: radio.id, gatewayIp: state.gatewayIp, gatewayFqdn: state.gatewayFqdn,
        peerIdentity: radio.peerIdentity, localTs: radio.localTs,
        remoteTsAddress: radio.remoteTs.replace(/\/32$/, ''), poolAddress: radio.poolAddress,
        vendor: radio.vendor, authMode: radio.authMode, psk: radio.psk,
        ikeEncryption: radio.ikeEncryption, ikeIntegrity: radio.ikeIntegrity, ikeDhGroup: radio.ikeDhGroup,
        espEncryption: radio.espEncryption, espIntegrity: radio.espIntegrity, espDhGroup: radio.espDhGroup,
        ikeReauthEnabled: radio.ikeReauthEnabled, pfsEnabled: radio.pfsEnabled, pfsDhGroup: radio.pfsDhGroup,
        dpdDelaySeconds: radio.dpdDelaySeconds, ikeSaLifetimeSeconds: radio.ikeSaLifetimeSeconds,
        childSaLifetimeSeconds: radio.childSaLifetimeSeconds,
      }), 'utf-8');
      await nsenter('swanctl', ['--load-all'], 15000);

      radio.enabled = true;
      // A freshly re-loaded connection hasn't proven itself live yet — same
      // reasoning PUT /radios/:id already applies after any config change.
      radio.status = radio.status === 'active' ? 'pending' : radio.status;
      saveState(state);
      await auditLogger.log({ action: 'secgw_radio_enable', user, details: `id=${radio.id} name=${radio.name}`, success: true });
      res.json({ success: true, radio });
    } catch (err) {
      await auditLogger.log({ action: 'secgw_radio_enable', user, details: String(err), success: false });
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  router.delete('/radios/:id', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      const state = loadState();
      const radio = state.radios.find(r => r.id === req.params.id);
      if (!radio) {
        res.status(404).json({ success: false, error: 'Radio not found' });
        return;
      }
      if (radio.status === 'revoked') {
        res.json({ success: true, radio });
        return;
      }

      const confPath = `${HOST_SWANCTL_CONFD_DIR}/${radio.id}.conf`;
      if (fs.existsSync(confPath)) fs.unlinkSync(confPath);
      await nsenter('swanctl', ['--load-all'], 15000).catch(() => {});
      await nsenter('swanctl', ['--terminate', '--ike', `secgw-${radio.id}`], 10000).catch(() => {});

      await nsenter('bash', ['-c', secgwRevokeRadioCertScript(radio.id)], 15000).catch(() => {});
      const bundleDir = `${HOST_SECGW_RADIOS_DIR}/${radio.id}`;
      if (fs.existsSync(bundleDir)) fs.rmSync(bundleDir, { recursive: true, force: true });

      radio.status = 'revoked';
      saveState(state);
      await auditLogger.log({ action: 'secgw_radio_remove', user, details: `id=${radio.id} name=${radio.name}`, success: true });
      res.json({ success: true, radio });
    } catch (err) {
      await auditLogger.log({ action: 'secgw_radio_remove', user, details: String(err), success: false });
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // Permanent hard delete — distinct from the soft-revoke above (which deliberately
  // keeps a "revoked" stub around for audit trail, see secgwRevokeRadioCertScript's
  // comment). This removes the radio from state entirely and cleans up every trace of
  // it (conf.d file if still present, both the active AND revoked/ copies of its cert,
  // its staging/bundle directory) — works on a radio in any status, including one
  // that was never revoked first (does the same live teardown inline in that case).
  router.delete('/radios/:id/permanent', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      const state = loadState();
      const idx = state.radios.findIndex(r => r.id === req.params.id);
      if (idx === -1) {
        res.status(404).json({ success: false, error: 'Radio not found' });
        return;
      }
      const radio = state.radios[idx];

      if (radio.status !== 'revoked') {
        const confPath = `${HOST_SWANCTL_CONFD_DIR}/${radio.id}.conf`;
        if (fs.existsSync(confPath)) fs.unlinkSync(confPath);
        await nsenter('swanctl', ['--load-all'], 15000).catch(() => {});
        await nsenter('swanctl', ['--terminate', '--ike', `secgw-${radio.id}`], 10000).catch(() => {});
      }

      await nsenter('bash', ['-c',
        `rm -f ${SECGW_PKI_DIR}/client-${radio.id}.crt ${SECGW_PKI_DIR}/client-${radio.id}.key ` +
        `${SECGW_PKI_DIR}/revoked/client-${radio.id}.crt ${SECGW_PKI_DIR}/revoked/client-${radio.id}.key`,
      ], 15000).catch(() => {});
      const bundleDir = `${HOST_SECGW_RADIOS_DIR}/${radio.id}`;
      if (fs.existsSync(bundleDir)) fs.rmSync(bundleDir, { recursive: true, force: true });

      state.radios.splice(idx, 1);
      saveState(state);
      await auditLogger.log({ action: 'secgw_radio_delete', user, details: `id=${radio.id} name=${radio.name}`, success: true });
      res.json({ success: true });
    } catch (err) {
      await auditLogger.log({ action: 'secgw_radio_delete', user, details: String(err), success: false });
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // Rotates whichever credential this radio actually uses — a fresh CA-signed cert
  // for cert-mode radios, or a fresh random PSK for psk-mode radios (renamed from an
  // earlier cert-only "/reissue-cert" now that both auth modes are supported — one
  // button covers both, since the operator-facing action is conceptually the same:
  // "give me a fresh credential and connection-info sheet for this radio").
  router.post('/radios/:id/rotate-credential', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      const state = loadState();
      const radio = state.radios.find(r => r.id === req.params.id);
      if (!radio) {
        res.status(404).json({ success: false, error: 'Radio not found' });
        return;
      }
      if (radio.status === 'revoked') {
        res.status(409).json({ success: false, error: 'Radio is revoked — add a new radio instead of rotating its credential.' });
        return;
      }
      if (!state.gatewayIp || !state.gatewayFqdn) {
        res.status(409).json({ success: false, error: 'SecGW is not configured.' });
        return;
      }

      if (radio.authMode === 'cert') {
        await nsenter('bash', ['-c', secgwRadioClientCertGenScript(radio.id, radio.peerIdentity)], 30000);
        const meta = await readCertMeta(`${SECGW_PKI_DIR}/client-${radio.id}.crt`);
        radio.certIssuedAt = meta.certIssuedAt;
        radio.certExpiresAt = meta.certExpiresAt;
        radio.certSerial = meta.certSerial;
      } else {
        radio.psk = generatePsk();
      }

      // Baicells: a radio added before per-radio pools existed won't have one yet —
      // allocate on first touch. See allocatePoolAddress()'s comment for why this must
      // be unique. Nokia has no CP support (see resolveRemoteTs()'s comment) — its
      // remote_ts is always the radio's own real IP and doesn't need "allocation" at
      // all, just re-deriving in case localIpAddress was edited since it was added.
      if (radio.vendor === 'nokia') {
        if (!radio.localIpAddress) {
          res.status(409).json({ success: false, error: 'This Nokia radio is missing its Local IP Address — edit it and set one before rotating.' });
          return;
        }
        radio.poolAddress = null;
        radio.remoteTs = `${radio.localIpAddress}/32`;
      } else if (!radio.poolAddress) {
        const poolCidr = state.poolCidr ?? DEFAULT_POOL_CIDR;
        const usedAddresses = new Set(
          state.radios.filter(r => r.id !== radio.id && r.status !== 'revoked' && r.poolAddress).map(r => r.poolAddress as string),
        );
        const allocated = allocatePoolAddress(poolCidr, usedAddresses);
        if (!allocated) {
          res.status(409).json({ success: false, error: `The virtual IP pool (${poolCidr}) is exhausted — widen it on the Setup tab.` });
          return;
        }
        radio.poolAddress = allocated;
        radio.remoteTs = `${allocated}/32`;
      }
      const remoteTsAddress = radio.vendor === 'nokia' ? radio.localIpAddress! : radio.poolAddress!;

      fs.writeFileSync(`${HOST_SWANCTL_CONFD_DIR}/${radio.id}.conf`, swanctlRadioConnConf({
        radioId: radio.id, gatewayIp: state.gatewayIp, gatewayFqdn: state.gatewayFqdn, peerIdentity: radio.peerIdentity,
        localTs: radio.localTs, remoteTsAddress, poolAddress: radio.poolAddress, vendor: radio.vendor, authMode: radio.authMode, psk: radio.psk,
        ikeEncryption: radio.ikeEncryption, ikeIntegrity: radio.ikeIntegrity, ikeDhGroup: radio.ikeDhGroup,
        espEncryption: radio.espEncryption, espIntegrity: radio.espIntegrity, espDhGroup: radio.espDhGroup,
        ikeReauthEnabled: radio.ikeReauthEnabled, pfsEnabled: radio.pfsEnabled, pfsDhGroup: radio.pfsDhGroup,
        dpdDelaySeconds: radio.dpdDelaySeconds, ikeSaLifetimeSeconds: radio.ikeSaLifetimeSeconds, childSaLifetimeSeconds: radio.childSaLifetimeSeconds,
      }), 'utf-8');
      await nsenter('swanctl', ['--load-all'], 15000).catch(() => {});

      fs.writeFileSync(`${HOST_SECGW_RADIOS_DIR}/${radio.id}/connection-info.txt`,
        radio.vendor === 'nokia'
          ? nokiaConnectionInfoSheet({
              radioName: radio.name, radioType: radio.radioType, gatewayIp: state.gatewayIp, gatewayFqdn: state.gatewayFqdn,
              peerIdentity: radio.peerIdentity, localTs: radio.localTs, psk: radio.psk,
              ikeEncryption: radio.ikeEncryption, ikeIntegrity: radio.ikeIntegrity, ikeDhGroup: radio.ikeDhGroup,
              espEncryption: radio.espEncryption, espIntegrity: radio.espIntegrity,
              ikeSaMode: radio.ikeSaMode, ikeReauthEnabled: radio.ikeReauthEnabled, pfsEnabled: radio.pfsEnabled, pfsDhGroup: radio.pfsDhGroup,
              antiReplayEnabled: radio.antiReplayEnabled, antiReplayWindowSize: radio.antiReplayWindowSize,
              dpdDelaySeconds: radio.dpdDelaySeconds, ikeSaLifetimeSeconds: radio.ikeSaLifetimeSeconds, childSaLifetimeSeconds: radio.childSaLifetimeSeconds,
              localIpAddress: radio.localIpAddress,
            })
          : baicellsConnectionInfoSheet({
              radioName: radio.name, radioType: radio.radioType, gatewayIp: state.gatewayIp, gatewayFqdn: state.gatewayFqdn,
              peerIdentity: radio.peerIdentity, localTs: radio.localTs, poolAddress: radio.poolAddress!,
              authMode: radio.authMode, psk: radio.psk,
              ikeEncryption: radio.ikeEncryption, ikeIntegrity: radio.ikeIntegrity, ikeDhGroup: radio.ikeDhGroup,
              espEncryption: radio.espEncryption, espIntegrity: radio.espIntegrity, espDhGroup: radio.espDhGroup,
              certExpiresAt: radio.certExpiresAt,
            }),
        'utf-8');

      saveState(state);
      await auditLogger.log({ action: 'secgw_radio_reissue_cert', user, details: `id=${radio.id} authMode=${radio.authMode}`, success: true });
      res.json({ success: true, radio });
    } catch (err) {
      await auditLogger.log({ action: 'secgw_radio_reissue_cert', user, details: String(err), success: false });
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  router.post('/radios/:id/test-tunnel', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      const state = loadState();
      const radio = state.radios.find(r => r.id === req.params.id);
      if (!radio) {
        res.status(404).json({ success: false, error: 'Radio not found' });
        return;
      }

      const { stdout } = await nsenter('swanctl', ['--list-sas', '--ike', `secgw-${radio.id}`], 10000).catch(() => ({ stdout: '' }));
      const sessions = parseListSas(stdout).filter(s => s.radioId === radio.id);
      const established = sessions.some(s => s.established);
      if (established && radio.status === 'pending') {
        radio.status = 'active';
        saveState(state);
      }
      await auditLogger.log({ action: 'secgw_radio_test_tunnel', user, details: `id=${radio.id} established=${established}`, success: true });
      res.json({ success: true, established, sessions });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  router.get('/radios/:id/bundle', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      const state = loadState();
      const radio = state.radios.find(r => r.id === req.params.id);
      if (!radio) {
        res.status(404).json({ success: false, error: 'Radio not found' });
        return;
      }
      if (radio.status === 'revoked') {
        res.status(410).json({ success: false, error: 'This radio has been revoked — its certificate bundle is no longer available.' });
        return;
      }

      const dir = `${HOST_SECGW_RADIOS_DIR}/${radio.id}`;
      const files = radio.authMode === 'cert'
        ? ['ca.crt', `client-${radio.id}.crt`, `client-${radio.id}.key`, 'connection-info.txt']
        : ['connection-info.txt'];
      for (const f of files) {
        if (!fs.existsSync(`${dir}/${f}`)) {
          res.status(500).json({ success: false, error: `Missing bundle file: ${f} — try rotating its credential.` });
          return;
        }
      }
      const archivePath = `${dir}/bundle.tar.gz`;
      await new Promise<void>((resolve, reject) => {
        execFile('tar', ['-czf', archivePath, '-C', dir, ...files], (err) => (err ? reject(err) : resolve()));
      });

      const filename = `secgw-${radio.name.replace(/[^a-zA-Z0-9_-]/g, '_')}.tar.gz`;
      res.setHeader('Content-Type', 'application/gzip');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      const stream = fs.createReadStream(archivePath);
      stream.pipe(res);
      stream.on('end', () => { fs.unlink(archivePath, () => {}); });
      stream.on('error', (err) => {
        logger.error({ err }, 'Error streaming SecGW radio bundle');
        fs.unlink(archivePath, () => {});
      });

      await auditLogger.log({ action: 'secgw_radio_bundle_download', user, details: `id=${radio.id}`, success: true });
    } catch (err) {
      await auditLogger.log({ action: 'secgw_radio_bundle_download', user, details: String(err), success: false });
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  router.get('/configs', (_req: Request, res: Response) => {
    res.json({ success: true, configs: getSecgwConfigManifest() });
  });

  router.get('/configs/content', (req: Request, res: Response) => {
    const p = String(req.query.path ?? '');
    if (!isAllowedConfigPath(p)) {
      res.status(400).json({ success: false, error: 'Path not in manifest' });
      return;
    }
    try {
      res.json({ success: true, content: fs.readFileSync(`/proc/1/root${p}`, 'utf-8') });
    } catch (err) {
      res.status(404).json({ success: false, error: String(err) });
    }
  });

  router.put('/configs/content', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const { path: p, content } = req.body ?? {};
    if (!isAllowedConfigPath(p) || typeof content !== 'string') {
      res.status(400).json({ success: false, error: 'Invalid request' });
      return;
    }
    try {
      fs.writeFileSync(`/proc/1/root${p}`, content, 'utf-8');
      await nsenter('swanctl', ['--load-all'], 15000).catch(() => {});
      if (p === STRONGSWAN_CONF) {
        await nsenter('systemctl', ['restart', SERVICE_NAME], 20000).catch(() => {});
      }
      await auditLogger.log({ action: 'secgw_config_save', user, details: `path=${p}`, success: true });
      res.json({ success: true });
    } catch (err) {
      await auditLogger.log({ action: 'secgw_config_save', user, details: String(err), success: false });
      res.status(500).json({ success: false, error: String(err) });
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

      write('=== Stopping and disabling strongSwan ===');
      await nsenter('systemctl', ['disable', '--now', SERVICE_NAME], 20000).catch(() => {});
      write('Service stopped and disabled.');

      write('\n=== Removing per-radio swanctl connections ===');
      if (fs.existsSync(HOST_SWANCTL_CONFD_DIR)) {
        for (const f of fs.readdirSync(HOST_SWANCTL_CONFD_DIR)) {
          fs.unlinkSync(`${HOST_SWANCTL_CONFD_DIR}/${f}`);
        }
      }
      write('Removed conf.d/*.conf.');

      if (state.interfaceMode === 'existing') {
        write('\n=== Skipping dummy-secgw removal — configured to use an existing IP, SecGW never created an interface ===');
      } else {
        write('\n=== Removing dummy-secgw interface ===');
        await deleteDummyInterface(DUMMY_IF_NAME).catch(() => {});
        write('dummy-secgw removed.');
      }

      write('\n=== Removing "secgw" DNS record from the internal epc zone (if present) ===');
      try {
        await removeSecgwDnsRecord();
        write('Removed (or the zone/record never existed — nothing to do).');
      } catch (err) {
        write(`Could not clean up the DNS record (non-fatal): ${String(err)}`);
      }

      if (state.poolCidr) {
        write('\n=== Removing the pool route (if present) ===');
        await removePoolRoute(state.poolCidr);
        write(`Removed local route for ${state.poolCidr} (if it existed).`);
      }

      write('\n=== Removing strongSwan config and CA/certificate material ===');
      await nsenter('bash', ['-c',
        `rm -rf ${SWANCTL_X509_DIR} ${SWANCTL_X509CA_DIR} ${SWANCTL_PRIVATE_DIR} ${SWANCTL_CONF} ${SECGW_PKI_DIR} ${SECGW_RADIOS_DIR}`,
      ], 30000).catch(() => {});
      write('Removed /etc/swanctl/{x509,x509ca,private,swanctl.conf} and /etc/open5gs-nms/secgw.');

      write('\n=== Removing source-built strongSwan binaries ===');
      await nsenter('bash', ['-c', `
        rm -rf ${SECGW_INSTALL_PREFIX} ${SECGW_BUILD_WORKDIR}
        if [ -L /usr/sbin/swanctl ]; then rm -f /usr/sbin/swanctl; fi
        if [ -f /usr/sbin/swanctl.apt-orig ]; then mv /usr/sbin/swanctl.apt-orig /usr/sbin/swanctl; fi
        rm -f /usr/lib/systemd/system/strongswan.service
        systemctl daemon-reload
      `], 30000).catch(() => {});
      write(`Removed ${SECGW_INSTALL_PREFIX} and ${SECGW_BUILD_WORKDIR}, restored the original swanctl binary (if it had been replaced by a symlink), removed the systemd unit.`);

      if (fs.existsSync(HOST_STATE_FILE)) fs.unlinkSync(HOST_STATE_FILE);
      write('\n=== Uninstall complete ===');
      await auditLogger.log({ action: 'secgw_uninstall', user, details: 'Uninstalled SecGW module', success: true });
    } catch (err) {
      write(`\nERROR: ${String(err)}`);
      await auditLogger.log({ action: 'secgw_uninstall', user, details: String(err), success: false });
    }
    res.end();
  });

  return router;
}
