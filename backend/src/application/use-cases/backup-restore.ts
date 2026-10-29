import pino from 'pino';
import { IHostExecutor } from '../../domain/interfaces/host-executor';
import { IConfigRepository } from '../../domain/interfaces/config-repository';
import { EXTRA_BACKUP_FILES } from '../../infrastructure/yaml/yaml-config-repository';
import * as path from 'path';
import * as fs from 'fs';
import * as yaml from 'js-yaml';

export interface BackupListItem {
  name: string;
  path: string;
  timestamp: Date;
  type: 'config' | 'mongodb' | 'combined';
  size?: string;
}

export interface BackupSettings {
  configBackupsToKeep: number;
  mongoBackupsToKeep: number;
}

// ── Full-backup categories ────────────────────────────────────────────────────
// Each category is independently backed up into its own subdirectory of the
// archive and independently selectable on restore.
//
// 2026-08-25 audit ("does this back up EVERYTHING needed to restore to a new
// host, all modules") found and fixed two real gaps:
//   1. `core-configs` silently dropped sepp1.yaml — the exact "stale 16 vs
//      17 core NF list" drift CLAUDE.md warns about (SEPP was added as the
//      17th core NF; this list was never updated). Fixed below.
//   2. SecGW's own CA + per-radio IPsec certs/keys (`secgw-pki`) and
//      GenieACS's device/preset/session inventory (`genieacs`, its own
//      separate MongoDB database — not part of the `open5gs` db dump) had NO
//      backup coverage at all. Both added as new first-class categories.
//
// Still deliberately excludes: the IMS database (PyHSS's own MariaDB — a
// separate system entirely, reinstalled and resynced from Open5GS
// subscribers rather than restored — `.ims-config.json`/`.ims-install.json`
// now travel with `optional-modules` so Install→Configure→Sync reproduces it
// exactly) and Asterisk's own installed binary (`pstn_extensions` rides
// along in the `subscribers` dump, `.pstn-config.json` now travels with
// `optional-modules` too — only the actual Asterisk package/install itself
// needs redoing, same as every other module's own Install step). Also
// excludes Prometheus/Grafana's own data (a pre-existing, separately-deployed
// monitoring stack this project reuses, not part of open5gs-nms itself) and
// migration-wizard progress state (see EXTRA_BACKUP_FILES's own comment).
export type BackupCategory =
  | 'subscribers'
  | 'core-configs'
  | 'suci-keys'
  | 'secgw-pki'
  | 'optional-modules'
  | 'l3-network'
  | 'dns'
  | 'genieacs'
  | 'auth'
  | 'ui-modules'
  | 'ocs-data'
  | 'radio-backups';

export interface BackupCategoryInfo {
  id: BackupCategory;
  label: string;
  description: string;
  present: boolean;
  itemCount: number;
}

// Every optional module's own marker file, basename -> module id. Used to
// derive `presentModules` on the manifest at backup time (which files
// actually landed in optional-modules/ or secgw-pki/) so a bootstrap-a-
// fresh-host restore flow knows exactly which modules' real packages/
// binaries need installing before the archive's config is written to disk —
// installing every module unconditionally would be needlessly slow and,
// for modules like VoWiFi/FRR source-build, multi-minute-plus. Several
// basenames map to the same module (e.g. SMS-over-SGs has no JSON state
// file of its own — see module-fixall-usecase.ts precedent — so its 3 host
// .cfg files are the only signal); that's fine, presentModules is a Set.
// Deliberately excludes markers with no real bootstrap action of their own:
// sepp.{crt,key}/sepp-peer-ca.crt (core SEPP, no separate install step) and
// .swu-emulator-state.json (a dev test tool, not a deployment module).
export const MODULE_MARKER_FILES: Record<string, string> = {
  'osmo-hlr.cfg': 'smsOverSgs', 'osmo-msc.cfg': 'smsOverSgs', 'osmo-stp.cfg': 'smsOverSgs', 'hlr.db': 'smsOverSgs',
  'osmo-hnbgw.cfg': 'hnbgw', 'osmo-mgw-hnbgw.cfg': 'hnbgw', '.nms-hnbgw-state.json': 'hnbgw',
  'osmo-epdg.config': 'vowifi', 'epdg.yaml': 'vowifi', 'aaa.config': 'vowifi', '.vowifi-state.json': 'vowifi',
  '.ims-config.json': 'ims', '.ims-install.json': 'ims',
  '.mms-config.json': 'mms',
  '.pstn-config.json': 'pstn', 'pstn-astdb.sqlite3': 'pstn',
  '.asterisk2g-config.json': 'asterisk2g', 'asterisk2g-astdb.sqlite3': 'asterisk2g',
  '.vectorcore-smsc-config.json': 'vectorcoreSmsc',
  '.twamp-config.json': 'twamp',
  '.ocs-config.json': 'ocs',
  'frr-source-build-state.json': 'frrSourceBuild',
  '.nms-gsm-bts-state.json': 'gsm',
  'chrony.conf': 'chrony',
  '71-open5gs-nms-forward.conf': 'syslog',
  // Lives under secgw-pki/, not optional-modules/ — see createFullBackup()'s
  // own secgw-pki block, which copies this file alongside the pki/radios dirs.
  '.secgw-state.json': 'secgw',
};

// Scans both directories a module marker file could land in (optional-
// modules/ for most, secgw-pki/ for SecGW's own state file — see comment
// above) and returns the resulting set of present module ids, sorted for a
// stable/deterministic manifest.
function derivePresentModules(tmpDir: string): string[] {
  const present = new Set<string>();
  for (const dir of [`${tmpDir}/optional-modules`, `${tmpDir}/secgw-pki`]) {
    let entries: string[] = [];
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      const moduleId = MODULE_MARKER_FILES[name];
      if (moduleId) present.add(moduleId);
    }
  }
  return [...present].sort();
}

// All 17 core NFs (matches yaml-config-repository.ts's own authoritative
// list) — this used to say 16 and silently drop sepp1.yaml, the exact
// "stale core-NF list" class of bug CLAUDE.md calls out by name. A restore
// onto a new host with SEPP/N32 roaming configured would have come back up
// with no sepp1.yaml at all.
const CORE_SERVICES = ['nrf', 'scp', 'amf', 'smf', 'upf', 'ausf', 'udm', 'udr', 'pcf', 'nssf', 'bsf', 'mme', 'hss', 'pcrf', 'sgwc', 'sgwu', 'sepp1'];

// Real, 2026-09-24 finding: independently rediscovered by 5 separate module
// audits this session (Core-17 itself, SEPP/TLS, the DNS Migration Wizard,
// VoWiFi, SigScale OCS) — `/etc/freeDiameter/{mme,hss,pcrf,smf}.conf` (the
// Diameter peer/identity config each of those 4 NFs' own freeDiameter stack
// reads) was never captured by ANY backup category. Only these 4 of the 17
// core NFs actually have one (confirmed live via `ls /etc/freeDiameter` on
// both hosts — every other NF either doesn't speak Diameter or uses a
// different mechanism), and unlike /etc/open5gs (direct-bind-mounted into
// this container, see docker-compose.yml), /etc/freeDiameter has no such
// mount — accessed the same way as every other host path not directly
// mounted (SecGW's PKI dir, OCS's Mnesia db, etc.): via /proc/1/root.
// Looping all 17 and skipping whichever don't have a file (rather than
// hardcoding the 4) means a future NF gaining a freeDiameter identity is
// covered automatically, no second list to keep in sync.
const HOST_FREEDIAMETER_DIR = '/proc/1/root/etc/freeDiameter';

// SUCI/SUPI concealment home-network private keys — referenced by *path* from
// udm.yaml's `hnet:` block, never embedded in it. Losing this directory
// permanently breaks SUCI de-concealment for every 5G subscriber using it;
// the old backup only ever copied udm.yaml itself (a pointer to these files,
// not the key material). `/etc/open5gs` is bind-mounted directly into this
// container (see docker-compose.yml), so no /proc/1/root prefix needed here.
const SUCI_KEY_DIR = '/etc/open5gs/hnet';

// L3/FRR — genuinely not derivable from anything else backed up elsewhere:
// frr.conf/daemons is the real EIGRP config, and the netplan file carries the
// host's own physical interface addressing (e.g. ens20's point-to-point IP
// for the EIGRP neighbor), not just NF-config-derived dummy interfaces. None
// of these paths are bind-mounted into this container — go through
// /proc/1/root like every other host-file access pattern in this codebase.
const HOST_FRR_CONF = '/proc/1/root/etc/frr/frr.conf';
const HOST_FRR_DAEMONS = '/proc/1/root/etc/frr/daemons';
// Real, 2026-09-24 audit finding: this file was captured/restored by the FRR
// Source Build module's OWN self-backup (frr-source-build-controller.ts) but
// omitted from this, the MAIN Full Backup archive — an inconsistency with
// frr.conf/daemons right above it, not a deliberate exclusion.
const HOST_VTYSH_CONF = '/proc/1/root/etc/frr/vtysh.conf';
const HOST_NETPLAN = '/proc/1/root/etc/netplan/60-open5gs-managed.yaml';

// DNS/BIND — the FQDN-based NF discovery zones (5gc/epc/ims/pub) this whole
// project's addressing scheme depends on. Not explicitly named by the user's
// "IP configs" request but squarely part of it in any normal reading.
const HOST_BIND_DIR = '/proc/1/root/etc/bind';
const HOST_BIND_ZONES_DIR = '/proc/1/root/etc/bind/zones';

// SecGW's own CA + every issued per-radio IPsec cert/key — genuinely
// irreplaceable material (same tier as SUCI keys, not just "config that's
// annoying to retype"): secgw-controller.ts's own comment confirms the CA's
// private key lives ONLY here, never copied into swanctl's own dir. Losing
// this on restore means every live radio's IPsec tunnel breaks and needs a
// brand new cert re-provisioned onto the physical radio by hand. Real nested
// directory tree (ca.crt/ca.key/client-<id>.{crt,key}/revoked/ under pki/,
// one subdirectory per radio under radios/) — needs a recursive tar copy,
// not the flat single-file copy every other category uses.
const SECGW_PKI_DIR = '/proc/1/root/etc/open5gs-nms/secgw/pki';
const SECGW_RADIOS_DIR = '/proc/1/root/etc/open5gs-nms/secgw/radios';
const SECGW_STATE_FILE = '/proc/1/root/etc/open5gs-nms/.secgw-state.json';
// Real, 2026-09-24 finding: secgwCaAndServerCertGenScript()'s CA-skip guard
// checks SECGW_PKI_DIR/ca.crt (backed up above), but its SERVER cert skip
// guard checks this SEPARATE path — never captured, so every reapply that
// reaches configureSecgw() regenerates a brand-new gateway server key+cert
// (still correctly signed by the preserved CA, functionally harmless, but
// discards the original bytes and resets the 825-day validity clock).
// Folded into the SAME secgw-pki directory-tree loop below for byte
// fidelity across a restore.
const SECGW_SWANCTL_X509_DIR = '/proc/1/root/etc/swanctl/x509';
const SECGW_SWANCTL_X509CA_DIR = '/proc/1/root/etc/swanctl/x509ca';
const SECGW_SWANCTL_PRIVATE_DIR = '/proc/1/root/etc/swanctl/private';
// strongSwan's own GLOBAL charon daemon config (replay-window, etc.) — has
// a real, first-party UI edit path (SecGW's own Setup tab config browser,
// GET/PUT /api/secgw/configs/content), so an operator customization here
// is genuine, deliberate content with no other source of truth. Plain
// text file, no live-write concern.
const SECGW_STRONGSWAN_CONF = '/proc/1/root/etc/strongswan.conf';

// Real, 2026-09-24 finding: SigScale OCS's actual datastore — every rating
// plan/offer, registered Diameter client, and (most importantly) every
// subscriber's real prepaid balance/bucket — lives entirely in Mnesia, NOT
// in Mongo (Mongo's nms_charging_plans is just this NMS's own bookkeeping
// layer on top, per CLAUDE.md). `.ocs-config.json` (optional-modules) only
// captures connection parameters, never this data. Confirmed live: this
// directory holds real .DCD/.DCL Mnesia table files (offer/product/bucket/
// service/client/httpd_user/schema), owned by the `otp` OS user the `ocs`
// systemd unit runs as (User=otp Group=otp in its own unit file). Unlike
// SecGW's PKI certs (static files, safe to cp -r live), Mnesia's files are
// actively written by the running BEAM process — there is no sqlite3-style
// online-backup command available here, so both backup and restore stop the
// `ocs` service first for a consistent copy (a deliberate, disclosed
// tradeoff — see this category's own manifest description).
const OCS_DB_DIR = '/proc/1/root/home/otp/db';
const OCS_DB_DIR_HOST = '/home/otp/db';
const OCS_SERVICE = 'ocs';
const OCS_OS_USER = 'otp';

// NMS's own user/session store (Lucia v3 + better-sqlite3, see config/index.ts's
// `authDbPath`) — deliberately isolated from the `open5gs` MongoDB database (a
// real security measure, not an oversight), which is exactly why it had NO
// backup coverage anywhere in this file until this fix: nothing in the
// `subscribers` (Mongo) category or any config-file category was ever going to
// pick it up. Without this, a restore onto a new host came back up with a
// fresh, empty auth store instead of the original host's real admin/viewer
// accounts — same "irreplaceable, not regenerable by Configure" tier as SUCI
// keys and SecGW's PKI. Backed up via SQLite's own `.backup` command (safe
// against a concurrently-open connection from the running backend), not a raw
// file copy — same reasoning that already uses `mongodump`/`mongorestore`
// instead of copying Mongo's own data directory.
const AUTH_DB_PATH = '/app/data/auth.db';

// Real subscriber/routing data living in SQLite files, not YAML/JSON — same
// "needs sqlite3 .backup, not a raw copy" reasoning as AUTH_DB_PATH above,
// since each is open on a live process (osmo-hlr / Asterisk) at backup time.
// Real, 2026-09-22 audit finding: none of these were captured anywhere.
// hlr.db holds real 2G/3G subscriber auth keys (Ki/OPc) — a completely
// separate credential store from the `open5gs` Mongo database (which only
// covers 4G/5G AKA subscribers); without it every 2G/3G subscriber loses the
// ability to re-authenticate after a restore. The two astdb.sqlite3 files
// hold real per-subscriber PSTN routing data (pstn_subscriber_msisdn,
// pstn_subscriber_outbound_callerid) for PSTN Gateway and Asterisk-2G
// respectively — confirmed live via `database show` this same session.
//
// Unlike AUTH_DB_PATH (bind-mounted straight into this container), these
// live only on the HOST — and confirmed live 2026-09-22: sqlite3's own
// `.backup` command fails with "unable to open database file" when given a
// `/proc/1/root/...`-prefixed path (its locking/open logic doesn't tolerate
// that indirection the way a plain fs.copyFileSync does). So the source
// path here is the real host path, for use with hostExecutor.executeCommand
// (which nsenters into the host mount namespace first, same as every other
// host-side command in this codebase) — paired with a *_PROC constant for
// this container's own fs.existsSync pre-checks.
const HLR_DB_HOST_PATH = '/var/lib/osmocom/hlr.db';
const HLR_DB_PROC_PATH = `/proc/1/root${HLR_DB_HOST_PATH}`;
const PSTN_ASTDB_HOST_PATH = '/var/lib/asterisk/astdb.sqlite3';
const PSTN_ASTDB_PROC_PATH = `/proc/1/root${PSTN_ASTDB_HOST_PATH}`;
// PSTN's own Asterisk instance deliberately reuses the system-wide stock
// /etc/asterisk (unlike Asterisk-2G's own isolated /etc/asterisk-2g tree),
// so configurePstn() correctly can't blindly overwrite pjsip.conf/
// extensions.conf/modules.conf the way configureAsterisk2g() does — it
// merges/upserts instead (ensureIncludes(), disableChanSip(),
// ensureStrictRtpDisabled()). That's the right call, but it means these
// files hold real, host-specific content with no other source of truth —
// confirmed live 2026-09-24: production's real rtp.conf has a narrowed
// rtpstart/rtpend port range (a real external-SIP-trunk NAT/firewall
// requirement), set via this module's own raw config editor, uncaptured by
// any backup category. Explicit prefixed archive names (not the generic
// EXTRA_BACKUP_FILES basename convention), since Asterisk-2G's own tree
// uses these exact same 5 filenames and a bare basename would collide if
// ever added there too.
const PSTN_ASTERISK_DIR = '/proc/1/root/etc/asterisk';
const PSTN_BASE_CONFIG_FILES: readonly (readonly [string, string])[] = [
  [`${PSTN_ASTERISK_DIR}/asterisk.conf`, 'pstn-asterisk.conf'],
  [`${PSTN_ASTERISK_DIR}/pjsip.conf`, 'pstn-pjsip.conf'],
  [`${PSTN_ASTERISK_DIR}/extensions.conf`, 'pstn-extensions.conf'],
  [`${PSTN_ASTERISK_DIR}/modules.conf`, 'pstn-modules.conf'],
  [`${PSTN_ASTERISK_DIR}/rtp.conf`, 'pstn-rtp.conf'],
];
// nginx's own TLS material. Only the Sercomm factory-default ACS relay pair
// (acs.crt/acs.key, CN=acs.sc.sercomm.com) lives here now: nginx fails to
// start outright without it, so a restore that omitted it would leave the
// whole web UI down.
//
// The CBRS SAS is NOT here any more. SASBench is the SAS; it owns the
// SAS-CBSD ports itself, builds its own PKI on first start and keeps it in
// its own `sas-data` Docker volume. nginx terminates no SAS TLS and holds no
// SAS certificate, so there is nothing for this backup to capture — back up
// SASBench's volume (or export from its own Certificates page) instead.
// Directly bind-mounted read-only into this container
// (./nginx/certs:/etc/nginx/certs:ro) — readable directly for backup, but
// restore needs the real host path via getComposeWorkingDir() since the
// container's own mount can't be written to. Restore also reloads nginx
// afterward (see the restore-side loop below) — a bare file copy alone
// wouldn't take effect until nginx re-reads it.
const NGINX_CERT_DIR = '/etc/nginx/certs';
const NGINX_CERT_FILES: readonly string[] = ['acs.crt', 'acs.key'];
const ASTERISK_2G_ASTDB_HOST_PATH = '/var/lib/asterisk-2g/astdb.sqlite3';
const ASTERISK_2G_ASTDB_PROC_PATH = `/proc/1/root${ASTERISK_2G_ASTDB_HOST_PATH}`;
// VectorCore MMSC's own sqlite database — message/delivery metadata only;
// real attachment CONTENT (photos/video a subscriber actually sent) lives
// as individual files under MMS_STORE_DIR instead, referenced by path from
// the db. Both are real, irreplaceable user data (same tier as hlr.db's
// keys) once real MMS traffic flows — no other source of truth for either.
const MMS_DB_HOST_PATH = '/opt/vectorcore/data/vectorcore-mmsc.db';
const MMS_DB_PROC_PATH = `/proc/1/root${MMS_DB_HOST_PATH}`;
const MMS_STORE_DIR = '/proc/1/root/opt/vectorcore/data/store';
// Host-side scratch dir for sqlite3's backup output before it's copied into
// this container's own tmpDir — /tmp is real HOST /tmp, reachable from here
// via the same /proc/1/root/ indirection a plain copy (not sqlite3) tolerates.
const HOST_SQLITE_STAGING_DIR = '/tmp/open5gs-nms-sqlite-backup-staging';

// Real, 2026-09-22 audit finding: the systemd-networkd files behind every
// dummy interface this project creates (VoWiFi's ePDG, PSTN's external
// trunk, SecGW's gateway, IMS/MMS/DNS dummy addresses — see
// dummy-interface.ts's own naming: `20-nms-dummy-<name>.netdev`/`.network`)
// were never captured anywhere. Without them, restoring config alone does
// NOT recreate the interface those modules' own bind IPs depend on — the
// module's own Configure has to be re-run afterward to call
// createDummyInterface() again. A variable-count glob, not a fixed list
// (which dummy interfaces exist depends on which optional modules are
// installed on this specific host), so it can't just be added to the flat
// EXTRA_BACKUP_FILES array.
const DUMMY_NETWORKD_DIR = '/proc/1/root/etc/systemd/network';
const DUMMY_NETWORKD_PREFIX = '20-nms-dummy-';

// The repo-root .env's `ENABLE_*` UI module-visibility flags — baked into
// the frontend at `docker compose build frontend` time (see .env's own "UI
// Module Toggles" comment block), genuinely outside every other category's
// territory (not /etc/open5gs, not Mongo, not /etc/bind). Real, 2026-09-23
// finding: a fresh-VM restore brought back every opt-in module's real
// backend state (SecGW's own tunnels included) correctly, but the frontend
// nav never showed them — the target host's own .env.example-derived
// defaults were never reconciled against the source host's actual choices.
const NMS_BACKEND_CONTAINER = 'open5gs-nms-backend';
const ENABLE_FLAG_RE = /^ENABLE_[A-Z0-9_]+=.*$/;

// Real, 2026-09-24 finding: a small, explicit allowlist of non-ENABLE_*
// .env values that ride along in the SAME ui-modules category/file as the
// ENABLE_* flags — plain outbound API/service credentials with NO local
// ciphertext coupling (unlike RADIO_CREDENTIALS_KEY, captured under `auth`
// instead since it must be force-overwritten in lockstep with auth.db's
// restored ciphertext — see that category's own comment). eSIM generation's
// Simlessly credentials and GenieACS UI's own JWT secret/port are both this
// simpler shape: losing them on restore just means a clear, actionable
// error until an operator re-enters them, no cascading data loss. Captured
// only when actually SET on the source (see the capture-side filter below)
// — an unset value must never blank out a real one already configured
// independently on the target.
const UI_MODULES_EXTRA_ENV_KEYS: readonly string[] = [
  'SIMLESSLY_ACCESS_KEY',
  'SIMLESSLY_SECRET_KEY',
  'GENIEACS_UI_JWT_SECRET',
  'GENIEACS_UI_PORT',
];

export class BackupRestoreUseCase {
  constructor(
    private readonly hostExecutor: IHostExecutor,
    private readonly configRepo: IConfigRepository,
    private readonly logger: pino.Logger,
    private readonly configBackupPath: string,
    private readonly mongoBackupPath: string,
  ) {}

  // Resolves this host's real on-disk docker-compose project directory via
  // the container's own compose-assigned label, rather than a hardcoded
  // path — this project's repo has been observed at two different real
  // paths across its two live hosts this same session
  // (/home/paulmataruso/open5gs-nms vs /opt/open5gs-nms), so a fixed guess
  // would already have been wrong on one of them. Runs through
  // executeLocalCommand (this container's own docker-ce-cli talking to the
  // mounted /var/run/docker.sock), matching this file's existing
  // docker ps/restart precedent — no nsenter needed for a read-only inspect.
  private async getComposeWorkingDir(): Promise<string | null> {
    try {
      const r = await this.hostExecutor.executeLocalCommand('docker', [
        'inspect', NMS_BACKEND_CONTAINER, '--format',
        '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}',
      ]);
      const dir = r.stdout.trim();
      return r.exitCode === 0 && dir && dir !== '<no value>' ? dir : null;
    } catch {
      return null;
    }
  }

  // Merge, never raw-overwrite — same discipline as the netplan
  // dummy-devices fix (see HOST_NETPLAN's restore block): only the specific
  // keys present in the incoming set are touched (ENABLE_* flags plus
  // UI_MODULES_EXTRA_ENV_KEYS — the regex itself is general, safety comes
  // entirely from the hasOwnProperty(incoming) gate below, and the caller
  // always pre-filters `incoming` to just those two sets), every other line
  // in the target's own .env (other secrets, ports, host-specific settings)
  // is left byte-for-byte alone. A key present in the incoming set but
  // absent from the target file entirely (an older .env.example predating
  // a newer flag) is appended rather than dropped silently.
  private mergeEnvFlags(targetContent: string, incoming: Record<string, string>): { merged: string; changed: boolean } {
    let changed = false;
    const seen = new Set<string>();
    const lines = targetContent.split('\n').map(line => {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && Object.prototype.hasOwnProperty.call(incoming, m[1])) {
        seen.add(m[1]);
        const newLine = `${m[1]}=${incoming[m[1]]}`;
        if (newLine !== line) changed = true;
        return newLine;
      }
      return line;
    });
    const missing = Object.keys(incoming).filter(k => !seen.has(k));
    if (missing.length > 0) {
      changed = true;
      lines.push('', '# Synced from source host by Full Restore (ui-modules category):');
      for (const k of missing) lines.push(`${k}=${incoming[k]}`);
    }
    return { merged: lines.join('\n'), changed };
  }

  // ── Full backup (all categories, one archive) ──────────────────────────────

  async createFullBackup(): Promise<{ success: boolean; archivePath: string; error?: string }> {
    let tmpDir = '';
    try {
      const now = new Date();
      const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
      const dirName = `open5gs-full-backup-${dateStr}`;
      tmpDir = `/tmp/${dirName}`;
      const archivePath = `/tmp/${dirName}.tar.gz`;

      this.logger.info({ tmpDir, archivePath }, 'Creating full backup archive');

      await this.hostExecutor.executeLocalCommand('mkdir', [
        '-p',
        `${tmpDir}/subscribers`, `${tmpDir}/core-configs`, `${tmpDir}/suci-keys`,
        `${tmpDir}/secgw-pki`, `${tmpDir}/optional-modules`, `${tmpDir}/l3-network`,
        `${tmpDir}/dns`, `${tmpDir}/genieacs`, `${tmpDir}/auth`, `${tmpDir}/ocs-data`,
        `${tmpDir}/radio-backups`,
      ]);

      const categories: Record<BackupCategory, BackupCategoryInfo> = {
        subscribers: { id: 'subscribers', label: 'Subscribers & SAS', description: 'MongoDB `open5gs` database — subscribers (incl. APNs/IPs/security keys), SAS grants/CBSDs, subscriber groups, APN profiles, RF Planning projects, TWAMP targets/history, users, audit log', present: false, itemCount: 0 },
        'core-configs': { id: 'core-configs', label: 'Core NF Configs', description: `${CORE_SERVICES.length} core Open5GS NF YAML files (incl. SEPP), plus MME/HSS/PCRF/SMF's own /etc/freeDiameter/*.conf peer configs`, present: false, itemCount: 0 },
        'suci-keys': { id: 'suci-keys', label: 'SUCI Keys', description: 'SUCI/SUPI concealment home-network private/public keys (5G-AKA)', present: false, itemCount: 0 },
        'secgw-pki': { id: 'secgw-pki', label: 'SecGW Certificates', description: "Security Gateway's own CA and every issued per-radio IPsec certificate/key — irreplaceable, not regenerable by re-running Configure", present: false, itemCount: 0 },
        'optional-modules': { id: 'optional-modules', label: 'Optional Module Configs', description: 'IMS/VoLTE, SMS (SGs + VectorCore), MMS, PSTN Gateway, Asterisk-2G (2G voice), VoWiFi, TWAMP, FRR source-build state, chrony, syslog forwarding — every optional module\'s own settings', present: false, itemCount: 0 },
        'l3-network': { id: 'l3-network', label: 'L3 / IP Network Config', description: 'FRR (EIGRP) config and host interface addressing (netplan)', present: false, itemCount: 0 },
        dns: { id: 'dns', label: 'DNS / BIND', description: 'BIND9 named.conf + all FQDN zone files', present: false, itemCount: 0 },
        genieacs: { id: 'genieacs', label: 'GenieACS (Radio Provisioning)', description: 'GenieACS\'s own MongoDB database — device inventory, presets, provisioning scripts, TR-069 session history (separate from the `open5gs` database)', present: false, itemCount: 0 },
        auth: { id: 'auth', label: 'NMS Login (Users)', description: 'This NMS\'s own admin/viewer accounts (Lucia + SQLite) — deliberately isolated from the `open5gs` database, so it needs its own category; without it a restore comes back up with no real user accounts. Also carries UE Signal Monitoring\'s AES-256-GCM-encrypted radio credentials plus the RADIO_CREDENTIALS_KEY needed to decrypt them, and the RAN Kill Switches\' active block list (which 3G/4G/5G radios are currently nftables-blocked) — skipping this category on restore silently leaves any previously-blocked radio unblocked, with no warning.', present: false, itemCount: 0 },
        'ui-modules': { id: 'ui-modules', label: 'UI Module Toggles', description: 'The repo .env\'s ENABLE_* flags controlling which optional module pages appear in the frontend nav (restoring this without a frontend rebuild has no visible effect), plus a small allowlist of plain outbound-API/service .env credentials riding along in the same file: eSIM generation\'s SIMLESSLY_ACCESS_KEY/SIMLESSLY_SECRET_KEY and GenieACS UI\'s GENIEACS_UI_JWT_SECRET/GENIEACS_UI_PORT', present: false, itemCount: 0 },
        'ocs-data': { id: 'ocs-data', label: 'SigScale OCS Data', description: "SigScale OCS's own Mnesia database — every rating plan/offer, registered Diameter client, and subscriber's real prepaid balance/bucket. Briefly stops the ocs service during backup and restore for a consistent copy (Mnesia has no online-backup command).", present: false, itemCount: 0 },
        'radio-backups': { id: 'radio-backups', label: 'Radio Config Backups', description: "Per-radio point-in-time configuration snapshots saved automatically after every successful GenieACS provisioning change (plus any manual \"Snapshot Now\" trigger from this page's own Radio Config Backups panel) — covers Baicells, Sercomm 4G, and Sercomm 5G NR radios. History only: the live radio and the `genieacs` category's own device dump both already hold each radio's CURRENT config; this is what's lost if you need to see what a radio's config looked like at a past point in time.", present: false, itemCount: 0 },
      };

      // subscribers — MongoDB, scoped to the `open5gs` database only. The old
      // code ran a bare `mongodump -o dir` with no --db, which blindly dumped
      // *every* database on the instance, including GenieACS's own DB and
      // Mongo's internal admin/config/local system databases — restoring
      // those onto a different host risks corrupting auth/replication state
      // for no benefit, since none of it is data this backup is meant to
      // cover. Scoped down as part of this audit.
      const mongoResult = await this.hostExecutor.executeLocalCommand('mongodump', ['--db', 'open5gs', '-o', `${tmpDir}/subscribers`]);
      if (mongoResult.exitCode !== 0) {
        throw new Error(`mongodump failed: ${mongoResult.stderr}`);
      }
      categories.subscribers.present = true;
      this.logger.info('MongoDB (open5gs db) dump complete');

      // core-configs
      for (const service of CORE_SERVICES) {
        try {
          await this.hostExecutor.copyFile(`/etc/open5gs/${service}.yaml`, `${tmpDir}/core-configs/${service}.yaml`);
          categories['core-configs'].itemCount++;
        } catch {
          this.logger.warn({ service }, 'Config file not found, skipping');
        }
      }
      // freeDiameter configs — see HOST_FREEDIAMETER_DIR's own comment above.
      // Only 4 of the 17 CORE_SERVICES actually have one; fs.existsSync
      // silently skips the rest, same non-fatal-per-file style as the YAML
      // loop just above.
      try {
        fs.mkdirSync(`${tmpDir}/core-configs/freediameter`, { recursive: true });
        for (const service of CORE_SERVICES) {
          const src = `${HOST_FREEDIAMETER_DIR}/${service}.conf`;
          if (fs.existsSync(src)) {
            fs.copyFileSync(src, `${tmpDir}/core-configs/freediameter/${service}.conf`);
            categories['core-configs'].itemCount++;
          }
        }
      } catch (err) {
        this.logger.warn({ err: String(err) }, 'freeDiameter config directory not found or unreadable, skipping');
      }
      categories['core-configs'].present = categories['core-configs'].itemCount > 0;

      // suci-keys
      try {
        if (fs.existsSync(SUCI_KEY_DIR)) {
          const keyFiles = fs.readdirSync(SUCI_KEY_DIR);
          for (const f of keyFiles) {
            fs.copyFileSync(`${SUCI_KEY_DIR}/${f}`, `${tmpDir}/suci-keys/${f}`);
          }
          categories['suci-keys'].itemCount = keyFiles.length;
    categories['suci-keys'].present = keyFiles.length > 0;
        }
      } catch (err) {
        this.logger.warn({ err: String(err) }, 'SUCI key directory not found or unreadable, skipping');
      }

      // secgw-pki — real recursive directory trees (not flat), plain `cp -r`
      // into the archive's own subdirectory rather than walked file-by-file.
      try {
        for (const [hostDir, name] of [
          [SECGW_PKI_DIR, 'pki'], [SECGW_RADIOS_DIR, 'radios'],
          [SECGW_SWANCTL_X509_DIR, 'swanctl-x509'],
          [SECGW_SWANCTL_X509CA_DIR, 'swanctl-x509ca'],
          [SECGW_SWANCTL_PRIVATE_DIR, 'swanctl-private'],
        ] as const) {
          if (!fs.existsSync(hostDir)) continue;
          const cpResult = await this.hostExecutor.executeLocalCommand('cp', ['-r', hostDir, `${tmpDir}/secgw-pki/${name}`]);
          if (cpResult.exitCode === 0) {
            const countResult = await this.hostExecutor.executeLocalCommand('bash', ['-c', `find '${tmpDir}/secgw-pki/${name}' -type f | wc -l`]);
            categories['secgw-pki'].itemCount += parseInt(countResult.stdout.trim(), 10) || 0;
          } else {
            this.logger.warn({ hostDir, stderr: cpResult.stderr }, 'Failed to copy SecGW PKI directory, skipping');
          }
        }
        if (fs.existsSync(SECGW_STATE_FILE)) {
          fs.copyFileSync(SECGW_STATE_FILE, `${tmpDir}/secgw-pki/.secgw-state.json`);
          categories['secgw-pki'].itemCount++;
        }
        if (fs.existsSync(SECGW_STRONGSWAN_CONF)) {
          fs.copyFileSync(SECGW_STRONGSWAN_CONF, `${tmpDir}/secgw-pki/strongswan.conf`);
          categories['secgw-pki'].itemCount++;
        }
        categories['secgw-pki'].present = categories['secgw-pki'].itemCount > 0;
      } catch (err) {
        this.logger.warn({ err: String(err) }, 'SecGW PKI directory not found or unreadable, skipping');
      }

      // radio-backups — plain directory tree, no /proc/1/root prefix needed
      // (this.configBackupPath is bind-mounted directly into this container
      // at the identical host path — see docker-compose.yml). No live
      // process holds these files open (each snapshot is a one-shot
      // writeFileSync from an HTTP request, triggered automatically after
      // every successful GenieACS provision plus any manual "Snapshot Now"
      // click), so a live cp -r is safe. Confirmed live 2026-09-24: real
      // 35+-day-old production data with zero prior backup coverage.
      try {
        const radioBackupsSrc = `${this.configBackupPath}/radio-backups`;
        if (fs.existsSync(radioBackupsSrc)) {
          const cpResult = await this.hostExecutor.executeLocalCommand('cp', ['-r', radioBackupsSrc, `${tmpDir}/radio-backups/devices`]);
          if (cpResult.exitCode === 0) {
            const countResult = await this.hostExecutor.executeLocalCommand('bash', ['-c', `find '${tmpDir}/radio-backups/devices' -type f | wc -l`]);
            categories['radio-backups'].itemCount = parseInt(countResult.stdout.trim(), 10) || 0;
            categories['radio-backups'].present = categories['radio-backups'].itemCount > 0;
          } else {
            this.logger.warn({ stderr: cpResult.stderr }, 'Failed to copy radio-backups directory, skipping');
          }
        }
      } catch (err) {
        this.logger.warn({ err: String(err) }, 'radio-backups directory not found or unreadable, skipping');
      }

      // ocs-data — see OCS_DB_DIR's own comment above for why this needs a
      // stop/copy/start cycle rather than a plain live cp -r (Mnesia's files
      // are actively written by the running BEAM process). Wrapped in
      // try/finally so `ocs` always comes back up even if the copy itself
      // fails partway through. Skipped entirely (no stop/start at all) if
      // the service isn't even installed/running on this host.
      try {
        if (fs.existsSync(OCS_DB_DIR)) {
          const wasActive = await this.hostExecutor.isServiceActive(OCS_SERVICE).catch(() => false);
          if (wasActive) await this.hostExecutor.stopService(OCS_SERVICE).catch(() => {});
          try {
            const cpResult = await this.hostExecutor.executeLocalCommand('cp', ['-r', OCS_DB_DIR, `${tmpDir}/ocs-data/db`]);
            if (cpResult.exitCode === 0) {
              const countResult = await this.hostExecutor.executeLocalCommand('bash', ['-c', `find '${tmpDir}/ocs-data/db' -type f | wc -l`]);
              categories['ocs-data'].itemCount = parseInt(countResult.stdout.trim(), 10) || 0;
              categories['ocs-data'].present = categories['ocs-data'].itemCount > 0;
            } else {
              this.logger.warn({ stderr: cpResult.stderr }, 'Failed to copy OCS Mnesia directory, skipping');
            }
          } finally {
            if (wasActive) await this.hostExecutor.startService(OCS_SERVICE).catch(() => {});
          }
        }
      } catch (err) {
        this.logger.warn({ err: String(err) }, 'OCS Mnesia directory not found or unreadable, skipping');
      }

      // optional-modules — every optional module's own NMS-side state file
      // (IMS, SMS-over-SGs, MMS, PSTN, VectorCore SMSC, VoWiFi, TWAMP,
      // FRR source-build, chrony, syslog forwarding) — see
      // EXTRA_BACKUP_FILES's own comment for the full list and what's
      // deliberately excluded.
      for (const filePath of EXTRA_BACKUP_FILES) {
        try {
          await this.hostExecutor.copyFile(`/proc/1/root${filePath}`, `${tmpDir}/optional-modules/${path.basename(filePath)}`);
          categories['optional-modules'].itemCount++;
        } catch {
          this.logger.warn({ filePath }, 'Optional-module config not found, skipping');
        }
      }
      // Real SQLite data files (2G/3G subscriber auth keys, PSTN routing data)
      // — see HLR_DB_HOST_PATH's own comment for why these need sqlite3's
      // online .backup command run ON THE HOST (via executeCommand's nsenter,
      // not the plain copyFile the loop above uses, and not
      // executeLocalCommand either — confirmed live 2026-09-22 that a
      // /proc/1/root/-prefixed path fails inside sqlite3 specifically).
      // Two-step: back up to a host-side scratch file first (real host path
      // in, real host path out — sqlite3 never sees this container's own
      // /tmp at all), then a plain copy pulls the result in here, same as
      // every other file in this function.
      await this.hostExecutor.executeCommand('mkdir', ['-p', HOST_SQLITE_STAGING_DIR]).catch(() => {});
      for (const [hostSrc, procSrc, name] of [
        [HLR_DB_HOST_PATH, HLR_DB_PROC_PATH, 'hlr.db'],
        [PSTN_ASTDB_HOST_PATH, PSTN_ASTDB_PROC_PATH, 'pstn-astdb.sqlite3'],
        [ASTERISK_2G_ASTDB_HOST_PATH, ASTERISK_2G_ASTDB_PROC_PATH, 'asterisk2g-astdb.sqlite3'],
        [MMS_DB_HOST_PATH, MMS_DB_PROC_PATH, 'vectorcore-mmsc.db'],
      ] as const) {
        const hostStagedPath = `${HOST_SQLITE_STAGING_DIR}/${name}`;
        try {
          if (fs.existsSync(procSrc)) {
            const result = await this.hostExecutor.executeCommand('sqlite3', [hostSrc, `.backup '${hostStagedPath}'`]);
            const procStagedPath = `/proc/1/root${hostStagedPath}`;
            if (result.exitCode === 0 && fs.existsSync(procStagedPath)) {
              fs.copyFileSync(procStagedPath, `${tmpDir}/optional-modules/${name}`);
              categories['optional-modules'].itemCount++;
            } else {
              this.logger.warn({ hostSrc, stderr: result.stderr }, 'SQLite data file backup failed, skipping');
            }
          }
        } catch (err) {
          this.logger.warn({ hostSrc, err: String(err) }, 'SQLite data file not found or unreadable, skipping');
        } finally {
          await this.hostExecutor.executeCommand('rm', ['-f', hostStagedPath]).catch(() => {});
        }
      }
      // MMS attachment CONTENT — see MMS_STORE_DIR's own comment above. A
      // plain live cp -r (no stop/start dance): VectorCore's own
      // filesystemStore.Put() is a plain os.Create()+io.Copy(), not an
      // atomic write-then-rename, so a message actively mid-send during
      // this exact copy could in principle land truncated — the same
      // accepted-risk tier as secgw-pki's own live cp -r, not OCS's Mnesia
      // (which needed a stop precisely because Mnesia is continuously
      // hammered, unlike this store's occasional per-message writes).
      try {
        if (fs.existsSync(MMS_STORE_DIR)) {
          const cpResult = await this.hostExecutor.executeLocalCommand('cp', ['-r', MMS_STORE_DIR, `${tmpDir}/optional-modules/mms-store`]);
          if (cpResult.exitCode === 0) {
            const countResult = await this.hostExecutor.executeLocalCommand('bash', ['-c', `find '${tmpDir}/optional-modules/mms-store' -type f | wc -l`]);
            categories['optional-modules'].itemCount += parseInt(countResult.stdout.trim(), 10) || 0;
          } else {
            this.logger.warn({ stderr: cpResult.stderr }, 'Failed to copy MMS store directory, skipping');
          }
        }
      } catch (err) {
        this.logger.warn({ err: String(err) }, 'MMS store directory not found or unreadable, skipping');
      }
      // PSTN's own stock-Asterisk-tree base config files — see
      // PSTN_ASTERISK_DIR's own comment above. Plain text files, no live-
      // write concern (unlike the sqlite loop above), so a plain copy is
      // fine — matches l3-network's own plain-copy idiom.
      for (const [src, name] of PSTN_BASE_CONFIG_FILES) {
        try {
          if (fs.existsSync(src)) {
            fs.copyFileSync(src, `${tmpDir}/optional-modules/${name}`);
            categories['optional-modules'].itemCount++;
          }
        } catch (err) {
          this.logger.warn({ src, err: String(err) }, 'PSTN base Asterisk config not found, skipping');
        }
      }
      // nginx's TLS cert — see NGINX_CERT_DIR's own comment above. The
      // `sas-` archive filename prefix is kept deliberately: it is what
      // every existing archive uses, and the restore side below matches on
      // it, so renaming would silently stop older backups restoring.
      for (const name of NGINX_CERT_FILES) {
        try {
          const src = `${NGINX_CERT_DIR}/${name}`;
          if (fs.existsSync(src)) {
            fs.copyFileSync(src, `${tmpDir}/optional-modules/sas-${name}`);
            categories['optional-modules'].itemCount++;
          }
        } catch (err) {
          this.logger.warn({ name, err: String(err) }, 'nginx TLS cert file not found, skipping');
        }
      }
      categories['optional-modules'].present = categories['optional-modules'].itemCount > 0;

      // l3-network (FRR + netplan)
      for (const [src, name] of [[HOST_FRR_CONF, 'frr.conf'], [HOST_FRR_DAEMONS, 'daemons'], [HOST_VTYSH_CONF, 'vtysh.conf'], [HOST_NETPLAN, '60-open5gs-managed.yaml']] as const) {
        try {
          if (fs.existsSync(src)) {
            fs.copyFileSync(src, `${tmpDir}/l3-network/${name}`);
            categories['l3-network'].itemCount++;
          }
        } catch (err) {
          this.logger.warn({ src, err: String(err) }, 'L3/network config not found, skipping');
        }
      }
      // Dummy-interface systemd-networkd files — see DUMMY_NETWORKD_DIR's own
      // comment. Whatever real interfaces exist on this specific host.
      try {
        if (fs.existsSync(DUMMY_NETWORKD_DIR)) {
          const dummyFiles = fs.readdirSync(DUMMY_NETWORKD_DIR).filter(f => f.startsWith(DUMMY_NETWORKD_PREFIX));
          if (dummyFiles.length > 0) fs.mkdirSync(`${tmpDir}/l3-network/dummy-interfaces`, { recursive: true });
          for (const f of dummyFiles) {
            fs.copyFileSync(`${DUMMY_NETWORKD_DIR}/${f}`, `${tmpDir}/l3-network/dummy-interfaces/${f}`);
            categories['l3-network'].itemCount++;
          }
        }
      } catch (err) {
        this.logger.warn({ err: String(err) }, 'Dummy-interface configs not found, skipping');
      }
      categories['l3-network'].present = categories['l3-network'].itemCount > 0;

      // dns (BIND)
      try {
        for (const name of ['named.conf.local', 'named.conf.options']) {
          const src = `${HOST_BIND_DIR}/${name}`;
          if (fs.existsSync(src)) {
            fs.copyFileSync(src, `${tmpDir}/dns/${name}`);
            categories.dns.itemCount++;
          }
        }
        if (fs.existsSync(HOST_BIND_ZONES_DIR)) {
          fs.mkdirSync(`${tmpDir}/dns/zones`, { recursive: true });
          const zoneFiles = fs.readdirSync(HOST_BIND_ZONES_DIR);
          for (const f of zoneFiles) {
            fs.copyFileSync(`${HOST_BIND_ZONES_DIR}/${f}`, `${tmpDir}/dns/zones/${f}`);
          }
          categories.dns.itemCount += zoneFiles.length;
        }
        categories.dns.present = categories.dns.itemCount > 0;
      } catch (err) {
        this.logger.warn({ err: String(err) }, 'DNS/BIND config not found, skipping');
      }

      // genieacs — its own separate MongoDB database (device inventory,
      // presets, provisioning scripts, TR-069 session history), deliberately
      // NOT part of the `subscribers` category's `--db open5gs` dump (see
      // that block's own comment). Non-fatal if missing/empty — plenty of
      // deployments never touch GenieACS-managed radios at all.
      try {
        const genieacsResult = await this.hostExecutor.executeLocalCommand('mongodump', ['--db', 'genieacs', '-o', `${tmpDir}/genieacs`]);
        if (genieacsResult.exitCode === 0 && fs.existsSync(`${tmpDir}/genieacs/genieacs`)) {
          categories.genieacs.present = true;
          categories.genieacs.itemCount = fs.readdirSync(`${tmpDir}/genieacs/genieacs`).length;
        } else {
          this.logger.warn({ stderr: genieacsResult.stderr }, 'GenieACS database not found or empty, skipping');
        }
      } catch (err) {
        this.logger.warn({ err: String(err) }, 'GenieACS mongodump failed, skipping');
      }

      // genieacs/ext — GenieACS's own GENIEACS_EXT_DIR filesystem
      // customization directory (real Node.js scripts a Provision script can
      // invoke via ext(...)). Bind-mounted from ./genieacs/ext, a path
      // inside the repo checkout (not a fixed /etc/... host path), so this
      // needs getComposeWorkingDir() + /proc/1/root like ui-modules' own
      // .env handling. Currently empty on both known hosts (only .gitkeep),
      // but the mechanism is real and was previously completely unguarded.
      try {
        const workingDir = await this.getComposeWorkingDir();
        if (workingDir) {
          const extDir = `/proc/1/root${workingDir}/genieacs/ext`;
          if (fs.existsSync(extDir)) {
            const cpResult = await this.hostExecutor.executeLocalCommand('cp', ['-r', extDir, `${tmpDir}/genieacs/ext`]);
            if (cpResult.exitCode === 0) {
              const countResult = await this.hostExecutor.executeLocalCommand('bash', ['-c', `find '${tmpDir}/genieacs/ext' -type f ! -name .gitkeep | wc -l`]);
              const extCount = parseInt(countResult.stdout.trim(), 10) || 0;
              if (extCount > 0) {
                categories.genieacs.itemCount += extCount;
                categories.genieacs.present = true;
              }
            } else {
              this.logger.warn({ stderr: cpResult.stderr }, 'Failed to copy GenieACS ext directory, skipping');
            }
          }
        }
      } catch (err) {
        this.logger.warn({ err: String(err) }, 'GenieACS ext directory not found or unreadable, skipping');
      }

      // auth — SQLite's own online-backup command, safe against the running
      // backend's own concurrently-open connection (unlike a raw file copy).
      try {
        if (fs.existsSync(AUTH_DB_PATH)) {
          const authResult = await this.hostExecutor.executeLocalCommand('sqlite3', [
            AUTH_DB_PATH, `.backup '${tmpDir}/auth/auth.db'`,
          ]);
          if (authResult.exitCode === 0 && fs.existsSync(`${tmpDir}/auth/auth.db`)) {
            categories.auth.present = true;
            categories.auth.itemCount = 1;
          } else {
            this.logger.warn({ stderr: authResult.stderr }, 'auth.db backup failed, skipping');
          }
        }
      } catch (err) {
        this.logger.warn({ err: String(err) }, 'auth.db not found or unreadable, skipping');
      }

      // Real, 2026-09-24 finding: auth.db (above) carries UE Signal
      // Monitoring's own tables, including AES-256-GCM-encrypted radio admin
      // credentials (radio-signal-controller.ts). The key that
      // encrypts/decrypts them, RADIO_CREDENTIALS_KEY, is a plain .env value
      // — never swept up by ui-modules' ENABLE_*-only capture below.
      // Restoring the ciphertext without the exact key that produced it
      // leaves it permanently undecryptable — confirmed live on the test VM
      // (172.16.0.104): 3 real radios' ciphertext arrived via a prior
      // auth.db restore, the target's key was left blank, guaranteed to fail
      // the instant anyone touches the Radio Signal page. Captured alongside
      // auth.db (not folded into ui-modules) because it's specifically bound
      // to this data, not a general UI toggle.
      try {
        const workingDir = await this.getComposeWorkingDir();
        if (workingDir) {
          const envPath = `/proc/1/root${workingDir}/.env`;
          if (fs.existsSync(envPath)) {
            const m = fs.readFileSync(envPath, 'utf-8').match(/^RADIO_CREDENTIALS_KEY=(.*)$/m);
            if (m && m[1].trim()) {
              fs.mkdirSync(`${tmpDir}/auth`, { recursive: true });
              fs.writeFileSync(`${tmpDir}/auth/radio-credentials.key`, m[1].trim(), 'utf-8');
            }
          }
        }
      } catch (err) {
        this.logger.warn({ err: String(err) }, 'Could not capture RADIO_CREDENTIALS_KEY, skipping');
      }

      // ui-modules — see NMS_BACKEND_CONTAINER's own comment above. Non-fatal
      // if the compose project dir can't be resolved (e.g. not actually run
      // via `docker compose`) or .env isn't where expected — every other
      // category still backs up normally.
      try {
        const workingDir = await this.getComposeWorkingDir();
        if (workingDir) {
          const envPath = `/proc/1/root${workingDir}/.env`;
          if (fs.existsSync(envPath)) {
            const envContent = fs.readFileSync(envPath, 'utf-8');
            const flagLines = envContent.split('\n').filter(l => {
              const trimmed = l.trim();
              if (ENABLE_FLAG_RE.test(trimmed)) return true;
              // UI_MODULES_EXTRA_ENV_KEYS — only capture when actually set;
              // an unset source value must never blank a real target value.
              const m = trimmed.match(/^([A-Z0-9_]+)=(.*)$/);
              return !!m && UI_MODULES_EXTRA_ENV_KEYS.includes(m[1]) && m[2].trim().length > 0;
            });
            if (flagLines.length > 0) {
              fs.mkdirSync(`${tmpDir}/ui-modules`, { recursive: true });
              fs.writeFileSync(`${tmpDir}/ui-modules/env-flags.txt`, flagLines.join('\n') + '\n', 'utf-8');
              categories['ui-modules'].present = true;
              categories['ui-modules'].itemCount = flagLines.length;
            }
          }
        } else {
          this.logger.warn('Could not resolve compose project working dir, skipping ui-modules category');
        }
      } catch (err) {
        this.logger.warn({ err: String(err) }, '.env UI module flags not found or unreadable, skipping');
      }

      const presentModules = derivePresentModules(tmpDir);
      this.logger.info({ categories, presentModules }, 'All backup categories collected');

      const manifest = JSON.stringify({
        version: '2.2',
        createdAt: now.toISOString(),
        categories,
        presentModules,
      }, null, 2);
      await fs.promises.writeFile(`${tmpDir}/manifest.json`, manifest, 'utf8');

      const tarResult = await this.hostExecutor.executeLocalCommand('tar', [
        '-czf', archivePath,
        '-C', '/tmp',
        dirName,
      ]);
      if (tarResult.exitCode !== 0) {
        throw new Error(`tar failed: ${tarResult.stderr}`);
      }

      await this.hostExecutor.executeLocalCommand('rm', ['-rf', tmpDir]);

      this.logger.info({ archivePath }, 'Full backup archive created successfully');
      return { success: true, archivePath };
    } catch (err) {
      await this.hostExecutor.executeLocalCommand('rm', ['-rf', tmpDir]).catch(() => {});
      const error = err instanceof Error ? err.message : String(err);
      this.logger.error({ err: error }, 'Full backup failed');
      return { success: false, archivePath: '', error };
    }
  }

  // ── Zip Slip prevention — shared by inspect and restore ────────────────────
  private async validateArchiveMembers(archivePath: string): Promise<void> {
    const listResult = await this.hostExecutor.executeLocalCommand('tar', ['-tvf', archivePath]);
    if (listResult.exitCode !== 0) {
      throw new Error(`Failed to read archive members: ${listResult.stderr}`);
    }
    for (const line of listResult.stdout.split('\n')) {
      if (!line.trim()) continue;
      const typeChar = line[0];
      if (typeChar === 'l' || typeChar === 'h' || typeChar === 'b' || typeChar === 'c' || typeChar === 'p') {
        throw new Error(`Archive rejected: contains unsafe entry type '${typeChar}' in line: ${line.trim()}`);
      }
      const parts = line.trim().split(/\s+/);
      const memberPath = parts[parts.length - 1];
      if (!memberPath) continue;
      if (memberPath.startsWith('/')) {
        throw new Error(`Archive rejected: contains absolute path '${memberPath}'`);
      }
      if (memberPath.split('/').some(seg => seg === '..')) {
        throw new Error(`Archive rejected: contains path traversal component in '${memberPath}'`);
      }
    }
  }

  // ── Inspect an uploaded/existing archive without restoring anything ───────
  async inspectFullBackup(archivePath: string): Promise<{ success: boolean; categories?: BackupCategoryInfo[]; createdAt?: string; presentModules?: string[]; error?: string }> {
    const tmpDir = `/tmp/open5gs-full-inspect-${Date.now()}`;
    try {
      await this.validateArchiveMembers(archivePath);

      await this.hostExecutor.executeLocalCommand('mkdir', ['-p', tmpDir]);
      // Pull out the manifest plus every optional-module marker file (small
      // JSON/conf files, not the huge subscribers/genieacs Mongo dumps or
      // secgw-pki's cert tree) — enough to derive presentModules fresh below
      // without a full extraction.
      const extractResult = await this.hostExecutor.executeLocalCommand('tar', [
        '-xzf', archivePath, '-C', tmpDir, '--strip-components=1',
        '--wildcards',
        '*/manifest.json', 'manifest.json',
        '*/optional-modules/*', 'optional-modules/*',
        '*/secgw-pki/.secgw-state.json', 'secgw-pki/.secgw-state.json',
      ]);
      let manifestPath = `${tmpDir}/manifest.json`;
      if (extractResult.exitCode !== 0 || !fs.existsSync(manifestPath)) {
        // Older (pre-category) backups have no manifest at all — fall back to
        // a full extraction so we can still detect what's inside by directory.
        await this.hostExecutor.executeLocalCommand('rm', ['-rf', tmpDir]);
        await this.hostExecutor.executeLocalCommand('mkdir', ['-p', tmpDir]);
        const fullExtract = await this.hostExecutor.executeLocalCommand('tar', ['-xzf', archivePath, '-C', tmpDir, '--strip-components=1']);
        if (fullExtract.exitCode !== 0) {
          throw new Error(`tar extract failed: ${fullExtract.stderr}`);
        }
        manifestPath = `${tmpDir}/manifest.json`;
      }

      let categories: BackupCategoryInfo[];
      let createdAt: string | undefined;
      if (fs.existsSync(manifestPath)) {
        const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
        createdAt = manifest.createdAt;
        if (manifest.categories) {
          categories = Object.values(manifest.categories);
        } else {
          // v1.0 manifest: only { contents: ['mongodb','config'] }, no per-category detail.
          categories = this.legacyManifestToCategories(tmpDir);
        }
      } else {
        categories = this.legacyManifestToCategories(tmpDir);
      }
      // Always derived fresh from the actually-extracted files, never trusted
      // from the manifest's own stored copy — same "current, read fresh"
      // discipline as ip-plan-controller.ts. Correctly comes back empty for
      // pre-2.2 archives that never had optional-modules files extracted
      // this cheaply — acceptable: those are pre-existing backups, and a
      // fresh-host bootstrap flow just won't have module suggestions for one.
      const presentModules = derivePresentModules(tmpDir);

      await this.hostExecutor.executeLocalCommand('rm', ['-rf', tmpDir]);
      return { success: true, categories, createdAt, presentModules };
    } catch (err) {
      await this.hostExecutor.executeLocalCommand('rm', ['-rf', tmpDir]).catch(() => {});
      const error = err instanceof Error ? err.message : String(err);
      this.logger.error({ err: error, archivePath }, 'Failed to inspect backup archive');
      return { success: false, error };
    }
  }

  // Best-effort category detection for archives with no per-category manifest
  // (pre-2026-08-02 full backups: just `mongodb/` and `config/` directories).
  private legacyManifestToCategories(tmpDir: string): BackupCategoryInfo[] {
    const has = (p: string) => { try { return fs.existsSync(`${tmpDir}/${p}`); } catch { return false; } };
    return [
      { id: 'subscribers', label: 'Subscribers & SAS', description: 'MongoDB dump (legacy archive — may include extra databases)', present: has('mongodb'), itemCount: 0 },
      { id: 'core-configs', label: 'Core NF Configs', description: 'Core Open5GS NF YAML files', present: has('config'), itemCount: 0 },
      { id: 'suci-keys', label: 'SUCI Keys', description: 'Not present in this legacy archive', present: false, itemCount: 0 },
      { id: 'secgw-pki', label: 'SecGW Certificates', description: 'Not present in this legacy archive', present: false, itemCount: 0 },
      { id: 'optional-modules', label: 'Optional Module Configs', description: 'SMS-over-SGs / VoWiFi configs (legacy archive — bundled with core configs)', present: has('config'), itemCount: 0 },
      { id: 'l3-network', label: 'L3 / IP Network Config', description: 'Not present in this legacy archive', present: false, itemCount: 0 },
      { id: 'dns', label: 'DNS / BIND', description: 'Not present in this legacy archive', present: false, itemCount: 0 },
      { id: 'genieacs', label: 'GenieACS (Radio Provisioning)', description: 'Not present in this legacy archive', present: false, itemCount: 0 },
      { id: 'auth', label: 'NMS Login (Users)', description: 'Not present in this legacy archive', present: false, itemCount: 0 },
      { id: 'ui-modules', label: 'UI Module Toggles', description: 'Not present in this legacy archive', present: false, itemCount: 0 },
      // Real, 2026-09-24 finding: 'ocs-data' was already missing from this
      // list (pre-existing, predates this specific fix) — added alongside
      // the new 'radio-backups' entry while already here, rather than
      // leaving a second known gap sitting next to a freshly-fixed one.
      { id: 'ocs-data', label: 'SigScale OCS Data', description: 'Not present in this legacy archive', present: false, itemCount: 0 },
      { id: 'radio-backups', label: 'Radio Config Backups', description: 'Not present in this legacy archive', present: false, itemCount: 0 },
    ];
  }

  // ── Restore selected categories from an already-uploaded/on-disk archive ──
  async restoreFullBackup(archivePath: string, selectedCategories?: BackupCategory[]): Promise<{ success: boolean; restored?: BackupCategory[]; error?: string }> {
    const tmpDir = `/tmp/open5gs-full-restore-${Date.now()}`;
    try {
      this.logger.info({ archivePath, tmpDir, selectedCategories }, 'Restoring full backup archive');

      await this.validateArchiveMembers(archivePath);

      await this.hostExecutor.executeLocalCommand('mkdir', ['-p', tmpDir]);
      const tarResult = await this.hostExecutor.executeLocalCommand('tar', ['-xzf', archivePath, '-C', tmpDir, '--strip-components=1']);
      if (tarResult.exitCode !== 0) {
        throw new Error(`tar extract failed: ${tarResult.stderr}`);
      }

      // Default to everything for backward-compat (e.g. scripted/API use) —
      // the UI always passes an explicit selection after an inspect step.
      const isLegacy = !fs.existsSync(`${tmpDir}/manifest.json`) || !JSON.parse(await fs.promises.readFile(`${tmpDir}/manifest.json`, 'utf8')).categories;
      // Real, 2026-09-24 finding: this hand-maintained fallback list had
      // already drifted from BackupCategory's real union before this fix
      // ('ui-modules' was missing too) — every new category needs adding
      // here explicitly, nothing enforces it at compile time (unlike the
      // categories info object below, a Record<BackupCategory,...> that DOES
      // fail to compile if a case is missed). Not reachable via the real
      // HTTP API today (backup-controller.ts's /full/restore route requires
      // an explicit non-empty categories array), but a real landmine for any
      // other direct caller.
      const all: BackupCategory[] = ['subscribers', 'core-configs', 'suci-keys', 'secgw-pki', 'optional-modules', 'l3-network', 'dns', 'genieacs', 'auth', 'ui-modules', 'ocs-data', 'radio-backups'];
      const wanted = new Set(selectedCategories && selectedCategories.length > 0 ? selectedCategories : all);
      const restored: BackupCategory[] = [];

      if (wanted.has('subscribers')) {
        const mongoDir = isLegacy ? `${tmpDir}/mongodb/open5gs` : `${tmpDir}/subscribers/open5gs`;
        const legacyMongoDir = `${tmpDir}/mongodb`;
        const restoreDir = fs.existsSync(mongoDir) ? mongoDir : legacyMongoDir;
        if (fs.existsSync(restoreDir)) {
          const mongoResult = await this.hostExecutor.executeLocalCommand('mongorestore', ['--drop', '--db', 'open5gs', restoreDir]);
          if (mongoResult.exitCode !== 0) {
            // Legacy full-database dumps don't have a single --db-restorable
            // subdirectory laid out the same way — fall back to a plain
            // directory restore for those (pre-existing legacy behavior).
            const fallback = await this.hostExecutor.executeLocalCommand('mongorestore', ['--drop', legacyMongoDir]);
            if (fallback.exitCode !== 0) {
              throw new Error(`mongorestore failed: ${mongoResult.stderr}`);
            }
          }
          restored.push('subscribers');
          this.logger.info('Subscribers/SAS (MongoDB) restored');
        }
      }

      if (wanted.has('core-configs')) {
        const dir = isLegacy ? `${tmpDir}/config` : `${tmpDir}/core-configs`;
        let any = false;
        for (const service of CORE_SERVICES) {
          try {
            await this.hostExecutor.copyFile(`${dir}/${service}.yaml`, `/etc/open5gs/${service}.yaml`);
            any = true;
          } catch {
            this.logger.warn({ service }, 'Config file missing from archive, skipping');
          }
        }
        // freeDiameter configs — see HOST_FREEDIAMETER_DIR's own comment
        // above. Never present in a legacy (pre-manifest) archive, so this
        // is simply a no-op there (fs.existsSync per file correctly finds
        // nothing). Written to disk here, then picked up by the SAME
        // unconditional restartCore17() this category already triggers
        // (has('core-configs') at the top of runRestart()) — no separate
        // restart wiring needed.
        for (const service of CORE_SERVICES) {
          const src = `${tmpDir}/core-configs/freediameter/${service}.conf`;
          if (fs.existsSync(src)) {
            try {
              // HOST_FREEDIAMETER_DIR is the DIRECTORY files get copied
              // into (matching SUCI_KEY_DIR's own idiom two blocks up), not
              // a single file's path — path.dirname(HOST_FREEDIAMETER_DIR)
              // was a real bug, computing the PARENT of this directory
              // instead of the directory itself (copy-pasted from a
              // neighboring single-FILE destination's idiom, e.g.
              // SECGW_STATE_FILE, where path.dirname() is correct). Silently
              // caused every restore to ENOENT and no-op on a target host
              // where /etc/freeDiameter didn't already exist, swallowed by
              // the per-service try/catch below — latent on both real
              // hosts today (the dir ships with the open5gs NF packages,
              // already present before any restore runs) but a real defect.
              fs.mkdirSync(HOST_FREEDIAMETER_DIR, { recursive: true });
              fs.copyFileSync(src, `${HOST_FREEDIAMETER_DIR}/${service}.conf`);
              any = true;
            } catch (err) {
              this.logger.warn({ service, err: String(err) }, 'Failed to restore freeDiameter config');
            }
          }
        }
        if (any) restored.push('core-configs');
      }

      if (wanted.has('suci-keys')) {
        try {
          if (fs.existsSync(`${tmpDir}/suci-keys`)) {
            fs.mkdirSync(SUCI_KEY_DIR, { recursive: true });
            for (const f of fs.readdirSync(`${tmpDir}/suci-keys`)) {
              fs.copyFileSync(`${tmpDir}/suci-keys/${f}`, `${SUCI_KEY_DIR}/${f}`);
            }
            restored.push('suci-keys');
            this.logger.info('SUCI keys restored');
          }
        } catch (err) {
          this.logger.warn({ err: String(err) }, 'Failed to restore SUCI keys');
        }
      }

      if (wanted.has('secgw-pki')) {
        try {
          let any = false;
          for (const [dst, name] of [
            [SECGW_PKI_DIR, 'pki'], [SECGW_RADIOS_DIR, 'radios'],
            [SECGW_SWANCTL_X509_DIR, 'swanctl-x509'],
            [SECGW_SWANCTL_X509CA_DIR, 'swanctl-x509ca'],
            [SECGW_SWANCTL_PRIVATE_DIR, 'swanctl-private'],
          ] as const) {
            const src = `${tmpDir}/secgw-pki/${name}`;
            if (fs.existsSync(src)) {
              fs.mkdirSync(path.dirname(dst), { recursive: true });
              fs.rmSync(dst, { recursive: true, force: true });
              const cpResult = await this.hostExecutor.executeLocalCommand('cp', ['-r', src, dst]);
              if (cpResult.exitCode === 0) any = true;
              else this.logger.warn({ dst, stderr: cpResult.stderr }, 'Failed to restore SecGW PKI directory');
            }
          }
          const stateSrc = `${tmpDir}/secgw-pki/.secgw-state.json`;
          if (fs.existsSync(stateSrc)) {
            fs.mkdirSync(path.dirname(SECGW_STATE_FILE), { recursive: true });
            fs.copyFileSync(stateSrc, SECGW_STATE_FILE);
            any = true;
          }
          const strongswanConfSrc = `${tmpDir}/secgw-pki/strongswan.conf`;
          if (fs.existsSync(strongswanConfSrc)) {
            fs.mkdirSync(path.dirname(SECGW_STRONGSWAN_CONF), { recursive: true });
            fs.copyFileSync(strongswanConfSrc, SECGW_STRONGSWAN_CONF);
            any = true;
          }
          if (any) {
            restored.push('secgw-pki');
            this.logger.info('SecGW certificates restored');
          }
        } catch (err) {
          this.logger.warn({ err: String(err) }, 'Failed to restore SecGW PKI');
        }
      }

      if (wanted.has('radio-backups')) {
        try {
          const src = `${tmpDir}/radio-backups/devices`;
          const dst = `${this.configBackupPath}/radio-backups`;
          if (fs.existsSync(src)) {
            fs.mkdirSync(path.dirname(dst), { recursive: true });
            fs.rmSync(dst, { recursive: true, force: true });
            const cpResult = await this.hostExecutor.executeLocalCommand('cp', ['-r', src, dst]);
            if (cpResult.exitCode === 0) {
              restored.push('radio-backups');
              this.logger.info('Radio config backup history restored');
            } else {
              this.logger.warn({ dst, stderr: cpResult.stderr }, 'Failed to restore radio-backups directory');
            }
          }
        } catch (err) {
          this.logger.warn({ err: String(err) }, 'Failed to restore radio-backups directory');
        }
      }

      if (wanted.has('ocs-data')) {
        try {
          const src = `${tmpDir}/ocs-data/db`;
          if (fs.existsSync(src)) {
            const wasActive = await this.hostExecutor.isServiceActive(OCS_SERVICE).catch(() => false);
            if (wasActive) await this.hostExecutor.stopService(OCS_SERVICE).catch(() => {});
            try {
              fs.mkdirSync(path.dirname(OCS_DB_DIR), { recursive: true });
              fs.rmSync(OCS_DB_DIR, { recursive: true, force: true });
              const cpResult = await this.hostExecutor.executeLocalCommand('cp', ['-r', src, OCS_DB_DIR]);
              if (cpResult.exitCode === 0) {
                // chown via nsenter (host namespace, plain host path) — "otp"
                // only resolves against the HOST's own /etc/passwd (created
                // by the ocs apt package), not this container's. Without
                // this, the restored files land root-owned (this container
                // runs as root) and the otp-user ocs service can't read/
                // write its own database.
                //
                // Real, 2026-09-24 finding: a failed chown here used to be
                // silently swallowed, and `systemctl is-active ocs` reports
                // "active" regardless — Mnesia fails per-table
                // ({badrpc,{'EXIT',{aborted,{no_exists,...}}}}), not at
                // daemon startup, so the service looks healthy while every
                // real balance/offer/client is actually unreadable. Now
                // checked explicitly and logged loudly (not just warn) so
                // this can't happen silently again, given the whole point of
                // this category is avoiding exactly this kind of silent
                // billing-data loss.
                const chownResult = await this.hostExecutor.executeCommand('chown', ['-R', `${OCS_OS_USER}:${OCS_OS_USER}`, OCS_DB_DIR_HOST]).catch(err => ({ exitCode: 1, stderr: String(err), stdout: '' }));
                if (chownResult.exitCode !== 0) {
                  this.logger.error({ stderr: chownResult.stderr }, `OCS Mnesia database restored but chown to ${OCS_OS_USER}:${OCS_OS_USER} failed — the ocs service will report active but its database will be unreadable until this is fixed manually (chown -R ${OCS_OS_USER}:${OCS_OS_USER} ${OCS_DB_DIR_HOST} then systemctl restart ocs)`);
                }
                restored.push('ocs-data');
                this.logger.info('OCS Mnesia database restored');
              } else {
                this.logger.warn({ stderr: cpResult.stderr }, 'Failed to restore OCS Mnesia directory');
              }
            } finally {
              // Always bring ocs back up (even on a failed copy above, or if
              // it wasn't running before) — restoring this category's whole
              // point is "OCS should be up and serving the restored data,"
              // unlike the backup side which only respects wasActive.
              await this.hostExecutor.startService(OCS_SERVICE).catch(() => {});
            }
          }
        } catch (err) {
          this.logger.warn({ err: String(err) }, 'Failed to restore OCS Mnesia database');
        }
      }

      if (wanted.has('optional-modules')) {
        const dir = isLegacy ? `${tmpDir}/config` : `${tmpDir}/optional-modules`;
        let any = false;
        for (const filePath of EXTRA_BACKUP_FILES) {
          try {
            await this.hostExecutor.copyFile(`${dir}/${path.basename(filePath)}`, `/proc/1/root${filePath}`);
            any = true;
          } catch {
            this.logger.warn({ filePath }, 'Optional-module config missing from archive, skipping');
          }
        }
        // SQLite data files — plain file copy is fine on restore (unlike
        // backup, nothing has the destination open yet on a fresh/stopped
        // target), but the owning daemon (osmo-hlr / Asterisk) must be
        // restarted afterward to pick it up rather than keep serving from
        // its own already-open, now-stale connection.
        for (const [dst, name] of [
          [HLR_DB_PROC_PATH, 'hlr.db'],
          [PSTN_ASTDB_PROC_PATH, 'pstn-astdb.sqlite3'],
          [ASTERISK_2G_ASTDB_PROC_PATH, 'asterisk2g-astdb.sqlite3'],
          [MMS_DB_PROC_PATH, 'vectorcore-mmsc.db'],
          // PSTN's own base Asterisk config files — a plain copy is
          // identical mechanics to the sqlite files above on the RESTORE
          // side (only the BACKUP side needed sqlite3's own .backup
          // command); folded into this same loop rather than a separate
          // one. PSTN_BASE_CONFIG_FILES's own [hostPath, archiveName] shape
          // already matches this loop's [dst, name] destructuring exactly.
          ...PSTN_BASE_CONFIG_FILES,
        ] as const) {
          try {
            const src = `${dir}/${name}`;
            if (fs.existsSync(src)) {
              await this.hostExecutor.copyFile(src, dst);
              any = true;
            }
          } catch (err) {
            this.logger.warn({ dst, err: String(err) }, 'Failed to restore SQLite data file');
          }
        }
        // MMS attachment content — see the backup side's own comment.
        const mmsStoreSrc = `${dir}/mms-store`;
        if (fs.existsSync(mmsStoreSrc)) {
          try {
            fs.mkdirSync(path.dirname(MMS_STORE_DIR), { recursive: true });
            fs.rmSync(MMS_STORE_DIR, { recursive: true, force: true });
            const cpResult = await this.hostExecutor.executeLocalCommand('cp', ['-r', mmsStoreSrc, MMS_STORE_DIR]);
            if (cpResult.exitCode === 0) any = true;
            else this.logger.warn({ stderr: cpResult.stderr }, 'Failed to restore MMS store directory');
          } catch (err) {
            this.logger.warn({ err: String(err) }, 'Failed to restore MMS store directory');
          }
        }
        // nginx's TLS cert — see NGINX_CERT_DIR's own comment above. The
      // `sas-` archive filename prefix is kept deliberately: it is what
      // every existing archive uses, and the restore side below matches on
      // it, so renaming would silently stop older backups restoring. The
        // container's own mount is read-only, so restore needs the real
        // host path via getComposeWorkingDir() (same pattern as ui-modules'
        // .env / genieacs's ext/ dir), not the ro-mounted /etc/nginx/certs
        // this class reads from elsewhere.
        try {
          const workingDir = await this.getComposeWorkingDir();
          if (workingDir) {
            let sasCertRestored = false;
            for (const name of NGINX_CERT_FILES) {
              const src = `${dir}/sas-${name}`;
              if (fs.existsSync(src)) {
                const certDst = `/proc/1/root${workingDir}/nginx/certs/${name}`;
                fs.mkdirSync(path.dirname(certDst), { recursive: true });
                fs.copyFileSync(src, certDst);
                any = true;
                sasCertRestored = true;
              }
            }
            // A bare file copy doesn't take effect until nginx re-reads it —
            // real gap found 2026-10-02 (API regression suite critic
            // audit): restoring the cert files alone left nginx still
            // serving whatever it already had loaded. `nginx -t` first,
            // same care-before-acting shape the SAS PKI helper used to have
            // reloadNginx() — a bad cert pair would otherwise take the live
            // SAS endpoint down for every already-connected radio, not just
            // fail silently for a restore that was supposed to fix trust.
            if (sasCertRestored) {
              try {
                await this.hostExecutor.executeLocalCommand('docker', ['exec', 'open5gs-nms-nginx', 'nginx', '-t']);
                await this.hostExecutor.executeLocalCommand('docker', ['exec', 'open5gs-nms-nginx', 'nginx', '-s', 'reload']);
              } catch (err) {
                this.logger.warn({ err: String(err) }, 'Restored nginx TLS cert but nginx -t/-s reload failed — the old cert may still be live until nginx is restarted manually');
              }
            }
          }
        } catch (err) {
          this.logger.warn({ err: String(err) }, 'Failed to restore nginx TLS cert');
        }
        if (any) restored.push('optional-modules');
      }

      if (wanted.has('l3-network')) {
        let any = false;
        for (const [dst, name] of [[HOST_FRR_CONF, 'frr.conf'], [HOST_FRR_DAEMONS, 'daemons'], [HOST_VTYSH_CONF, 'vtysh.conf']] as const) {
          try {
            const src = `${tmpDir}/l3-network/${name}`;
            if (fs.existsSync(src)) {
              fs.mkdirSync(path.dirname(dst), { recursive: true });
              fs.copyFileSync(src, dst);
              any = true;
            }
          } catch (err) {
            this.logger.warn({ dst, err: String(err) }, 'Failed to restore L3/network config');
          }
        }
        // Netplan is NEVER a raw overwrite, unlike frr.conf/daemons above —
        // real, 2026-09-23 incident: `ethernets:` (ens18/ens19/ens20 and
        // their addresses) is fundamentally host-specific physical NIC
        // wiring, not portable NF/module config, but this file's own
        // top-level `network:` block mixes it together with
        // `dummy-devices:` (which genuinely IS portable NMS state). A raw
        // copy onto a different host silently overwrote that host's own
        // management-interface address with the SOURCE host's — real,
        // live outage caught only because the operator was watching for
        // it. Fixed: only ever merge the incoming `dummy-devices:` block
        // into whatever `ethernets:` the TARGET host already has —
        // `ethernets:` itself is never touched by a restore, on any host.
        try {
          const src = `${tmpDir}/l3-network/60-open5gs-managed.yaml`;
          if (fs.existsSync(src)) {
            const incoming = yaml.load(fs.readFileSync(src, 'utf-8')) as any;
            const incomingDummies = incoming?.network?.['dummy-devices'];
            if (incomingDummies) {
              let target: any = null;
              if (fs.existsSync(HOST_NETPLAN)) {
                try { target = yaml.load(fs.readFileSync(HOST_NETPLAN, 'utf-8')) as any; } catch { /* fall through to fresh skeleton below */ }
              }
              if (!target || typeof target !== 'object') target = { network: { version: 2 } };
              if (!target.network || typeof target.network !== 'object') target.network = { version: 2 };
              target.network['dummy-devices'] = incomingDummies;
              fs.mkdirSync(path.dirname(HOST_NETPLAN), { recursive: true });
              fs.writeFileSync(HOST_NETPLAN, yaml.dump(target), 'utf-8');
              any = true;
            }
          }
        } catch (err) {
          this.logger.warn({ err: String(err) }, 'Failed to restore netplan dummy-devices');
        }
        // Dummy-interface files — restoring the .netdev/.network files alone
        // does not bring the interface up; that needs `systemctl restart
        // systemd-networkd` (or a reboot) afterward, same "restore doesn't
        // restart anything yet" caveat as the rest of this function.
        try {
          const srcDir = `${tmpDir}/l3-network/dummy-interfaces`;
          if (fs.existsSync(srcDir)) {
            for (const f of fs.readdirSync(srcDir)) {
              fs.copyFileSync(`${srcDir}/${f}`, `${DUMMY_NETWORKD_DIR}/${f}`);
              any = true;
            }
          }
        } catch (err) {
          this.logger.warn({ err: String(err) }, 'Failed to restore dummy-interface configs');
        }
        if (any) restored.push('l3-network');
      }

      if (wanted.has('dns')) {
        try {
          let any = false;
          for (const name of ['named.conf.local', 'named.conf.options']) {
            const src = `${tmpDir}/dns/${name}`;
            if (fs.existsSync(src)) {
              fs.mkdirSync(HOST_BIND_DIR, { recursive: true });
              fs.copyFileSync(src, `${HOST_BIND_DIR}/${name}`);
              any = true;
            }
          }
          const zonesSrc = `${tmpDir}/dns/zones`;
          if (fs.existsSync(zonesSrc)) {
            fs.mkdirSync(HOST_BIND_ZONES_DIR, { recursive: true });
            for (const f of fs.readdirSync(zonesSrc)) {
              fs.copyFileSync(`${zonesSrc}/${f}`, `${HOST_BIND_ZONES_DIR}/${f}`);
            }
            any = true;
          }
          if (any) restored.push('dns');
        } catch (err) {
          this.logger.warn({ err: String(err) }, 'Failed to restore DNS/BIND config');
        }
      }

      if (wanted.has('genieacs')) {
        try {
          const dir = `${tmpDir}/genieacs/genieacs`;
          if (fs.existsSync(dir)) {
            const mongoResult = await this.hostExecutor.executeLocalCommand('mongorestore', ['--drop', '--db', 'genieacs', dir]);
            if (mongoResult.exitCode !== 0) {
              throw new Error(`mongorestore failed: ${mongoResult.stderr}`);
            }
            restored.push('genieacs');
            this.logger.info('GenieACS (MongoDB) restored');
          }
        } catch (err) {
          this.logger.warn({ err: String(err) }, 'Failed to restore GenieACS database');
        }

        // genieacs/ext — see the backup side's own comment above. Real,
        // 2026-09-24 finding (from an earlier pass's critic): the ext
        // directory's own chown -R 999:999 only runs via genieacs-init's
        // `depends_on: condition: service_completed_successfully` (a real
        // `docker compose up`), never on the bare `docker restart genieacs`
        // this category's own reapply step uses — so restored files would
        // land root-owned (this backend container runs as root) and stay
        // that way, since GenieACS's own process runs as uid 999. Chown
        // explicitly here, immediately after the copy, rather than relying
        // on any later reapply step to fix it.
        try {
          const extSrc = `${tmpDir}/genieacs/ext`;
          if (fs.existsSync(extSrc)) {
            const workingDir = await this.getComposeWorkingDir();
            if (workingDir) {
              const extDir = `/proc/1/root${workingDir}/genieacs/ext`;
              fs.mkdirSync(extDir, { recursive: true });
              for (const f of fs.readdirSync(extSrc)) {
                if (f === '.gitkeep') continue;
                fs.copyFileSync(`${extSrc}/${f}`, `${extDir}/${f}`);
              }
              const chownResult = await this.hostExecutor.executeCommand('chown', ['-R', '999:999', `${workingDir}/genieacs/ext`]).catch(err => ({ exitCode: 1, stderr: String(err), stdout: '' }));
              if (chownResult.exitCode !== 0) {
                this.logger.error({ stderr: chownResult.stderr }, 'GenieACS ext directory restored but chown to 999:999 failed — files may be unreadable by the genieacs container until fixed manually');
              }
              restored.push('genieacs');
              this.logger.info('GenieACS ext directory restored');
            } else {
              this.logger.warn('Could not resolve compose project working dir, skipping GenieACS ext restore');
            }
          }
        } catch (err) {
          this.logger.warn({ err: String(err) }, 'Failed to restore GenieACS ext directory');
        }
      }

      if (wanted.has('auth')) {
        try {
          const src = `${tmpDir}/auth/auth.db`;
          if (fs.existsSync(src)) {
            fs.mkdirSync(path.dirname(AUTH_DB_PATH), { recursive: true });
            fs.copyFileSync(src, AUTH_DB_PATH);
            restored.push('auth');
            this.logger.info('NMS login (auth.db) restored — a backend restart is needed to pick it up cleanly');
          }
        } catch (err) {
          this.logger.warn({ err: String(err) }, 'Failed to restore auth.db');
        }

        // RADIO_CREDENTIALS_KEY travels with auth.db (see the 2026-09-24
        // comment on its backup side) — the just-restored auth.db's radio
        // ciphertext can only ever decrypt with the SOURCE host's exact key,
        // so this always overwrites the target's existing value. Unlike
        // ui-modules' ENABLE_* merge (which deliberately preserves the
        // target's own prior choice), preserving the target's prior key
        // here would leave the restored ciphertext permanently broken.
        try {
          const keySrc = `${tmpDir}/auth/radio-credentials.key`;
          if (fs.existsSync(keySrc)) {
            const workingDir = await this.getComposeWorkingDir();
            if (workingDir) {
              const envPath = `/proc/1/root${workingDir}/.env`;
              if (fs.existsSync(envPath)) {
                const key = fs.readFileSync(keySrc, 'utf-8').trim();
                const current = fs.readFileSync(envPath, 'utf-8');
                const newLine = `RADIO_CREDENTIALS_KEY=${key}`;
                const merged = /^RADIO_CREDENTIALS_KEY=.*$/m.test(current)
                  ? current.replace(/^RADIO_CREDENTIALS_KEY=.*$/m, newLine)
                  : `${current}\n${newLine}\n`;
                if (merged !== current) {
                  fs.writeFileSync(envPath, merged, 'utf-8');
                  this.logger.info('RADIO_CREDENTIALS_KEY (.env) synced from source host — backend restart needed to take effect');
                }
              } else {
                this.logger.warn({ envPath }, 'Target .env not found, skipping RADIO_CREDENTIALS_KEY restore');
              }
            } else {
              this.logger.warn('Could not resolve compose project working dir, skipping RADIO_CREDENTIALS_KEY restore');
            }
          }
        } catch (err) {
          this.logger.warn({ err: String(err) }, 'Failed to restore RADIO_CREDENTIALS_KEY');
        }
      }

      if (wanted.has('ui-modules')) {
        try {
          const src = `${tmpDir}/ui-modules/env-flags.txt`;
          if (fs.existsSync(src)) {
            const workingDir = await this.getComposeWorkingDir();
            if (workingDir) {
              const envPath = `/proc/1/root${workingDir}/.env`;
              if (fs.existsSync(envPath)) {
                const incoming: Record<string, string> = {};
                for (const line of fs.readFileSync(src, 'utf-8').split('\n')) {
                  const trimmed = line.trim();
                  const m = trimmed.match(/^([A-Z0-9_]+)=(.*)$/);
                  if (m && (ENABLE_FLAG_RE.test(trimmed) || UI_MODULES_EXTRA_ENV_KEYS.includes(m[1]))) {
                    incoming[m[1]] = m[2];
                  }
                }
                const { merged, changed } = this.mergeEnvFlags(fs.readFileSync(envPath, 'utf-8'), incoming);
                if (changed) {
                  fs.writeFileSync(envPath, merged, 'utf-8');
                  this.logger.info('UI module toggles (.env) synced from source host — frontend rebuild needed to take effect');
                } else {
                  this.logger.info('UI module toggles (.env) already matched source host, nothing to change');
                }
                restored.push('ui-modules');
              } else {
                this.logger.warn({ envPath }, 'Target .env not found, skipping ui-modules restore');
              }
            } else {
              this.logger.warn('Could not resolve compose project working dir, skipping ui-modules restore');
            }
          }
        } catch (err) {
          this.logger.warn({ err: String(err) }, 'Failed to restore ui-modules (.env) config');
        }
      }

      await this.hostExecutor.executeLocalCommand('rm', ['-rf', tmpDir]);
      await this.hostExecutor.executeLocalCommand('rm', ['-f', archivePath]).catch(() => {});

      this.logger.info({ restored }, 'Full backup restore complete');
      return { success: true, restored };
    } catch (err) {
      await this.hostExecutor.executeLocalCommand('rm', ['-rf', tmpDir]).catch(() => {});
      const error = err instanceof Error ? err.message : String(err);
      this.logger.error({ err: error }, 'Full backup restore failed');
      return { success: false, error };
    }
  }

  // ── MongoDB-only backup/restore (legacy, `open5gs` db scoped) ──────────────

  async createMongoBackup(): Promise<{ success: boolean; backupName: string; error?: string }> {
    try {
      const dateStr = new Date().toISOString().split('T')[0].split('-').reverse().join('-'); // dd-mm-yyyy
      const backupName = `Open5Gs_${dateStr}`;
      const backupPath = `${this.mongoBackupPath}/${backupName}`;

      this.logger.info({ backupName, backupPath }, 'Creating MongoDB backup');

      const result = await this.hostExecutor.executeLocalCommand('mongodump', ['--db', 'open5gs', '-o', backupPath]);

      if (result.exitCode !== 0) {
        throw new Error(result.stderr || `mongodump failed with exit code ${result.exitCode}`);
      }

      this.logger.info({ backupName }, 'MongoDB backup created successfully');
      return { success: true, backupName };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.logger.error({ err: error }, 'MongoDB backup failed');
      return { success: false, backupName: '', error };
    }
  }

  async restoreMongoBackup(backupName: string): Promise<{ success: boolean; error?: string }> {
    try {
      const backupPath = `${this.mongoBackupPath}/${backupName}`;

      this.logger.info({ backupName, backupPath }, 'Restoring MongoDB backup');

      const exists = await this.hostExecutor.fileExists(backupPath);
      if (!exists) {
        throw new Error(`Backup not found: ${backupName}`);
      }

      // Newer backups are scoped to `${backupPath}/open5gs`; older ones dumped
      // every database straight into `backupPath`. Try the scoped path first.
      const scopedPath = `${backupPath}/open5gs`;
      const scopedExists = await this.hostExecutor.fileExists(scopedPath);
      const result = scopedExists
        ? await this.hostExecutor.executeLocalCommand('mongorestore', ['--drop', '--db', 'open5gs', scopedPath])
        : await this.hostExecutor.executeLocalCommand('mongorestore', ['--drop', backupPath]);

      if (result.exitCode !== 0) {
        throw new Error(result.stderr || `mongorestore failed with exit code ${result.exitCode}`);
      }

      this.logger.info({ backupName }, 'MongoDB backup restored successfully');
      return { success: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.logger.error({ err: error, backupName }, 'MongoDB restore failed');
      return { success: false, error };
    }
  }

  async createConfigBackup(): Promise<{ success: boolean; backupName: string; error?: string }> {
    try {
      const now = new Date();
      const backupName = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
      const backupPath = `${this.configBackupPath}/${backupName}`;

      this.logger.info({ backupName, backupPath }, 'Creating config backup');

      await this.configRepo.backupAll(backupPath);

      this.logger.info({ backupName }, 'Config backup created successfully');
      return { success: true, backupName };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.logger.error({ err: error }, 'Config backup failed');
      return { success: false, backupName: '', error };
    }
  }

  async restoreConfigBackup(backupName: string): Promise<{ success: boolean; error?: string }> {
    try {
      const backupPath = `${this.configBackupPath}/${backupName}`;

      this.logger.info({ backupName, backupPath }, 'Restoring config backup');

      await this.configRepo.restoreBackup(backupPath);

      this.logger.info({ backupName }, 'Config backup restored successfully');
      return { success: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.logger.error({ err: error, backupName }, 'Config restore failed');
      return { success: false, error };
    }
  }

  async listMongoBackups(): Promise<BackupListItem[]> {
    try {
      const entries = await this.hostExecutor.listDirectory(this.mongoBackupPath);

      const backups = entries
        .filter(name => name.trim().length > 0 && name.startsWith('Open5Gs_'))
        .map(name => {
          // Parse date from Open5Gs_dd-mm-yyyy format
          const datePart = name.replace('Open5Gs_', '');
          const [day, month, year] = datePart.split('-');
          const timestamp = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));

          return {
            name,
            path: `${this.mongoBackupPath}/${name}`,
            timestamp,
            type: 'mongodb' as const,
          };
        })
        .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

      return backups;
    } catch (err) {
      this.logger.warn({ err: String(err) }, 'No MongoDB backups found or directory does not exist');
      return [];
    }
  }

  async listConfigBackups(): Promise<BackupListItem[]> {
    try {
      const entries = await this.hostExecutor.listDirectory(this.configBackupPath);

      // Only match yyyy-mm-dd-hhmm format (e.g. 2026-03-04-1430)
      // This excludes pre-restore-* and any other non-backup directories
      const configBackupPattern = /^\d{4}-\d{2}-\d{2}-\d{4}$/;

      const backups = entries
        .filter(name => configBackupPattern.test(name.trim()))
        .map(name => {
          // Parse date from yyyy-mm-dd-hhmm format
          const parts = name.split('-');
          const year = parseInt(parts[0]);
          const month = parseInt(parts[1]) - 1;
          const day = parseInt(parts[2]);
          const hour = parseInt(parts[3]?.substring(0, 2) || '0');
          const minute = parseInt(parts[3]?.substring(2) || '0');
          const timestamp = new Date(year, month, day, hour, minute);

          // Skip if date parsing produced an invalid date
          if (isNaN(timestamp.getTime())) {
            this.logger.warn({ name }, 'Skipping backup with unparseable date');
            return null;
          }

          return {
            name,
            path: `${this.configBackupPath}/${name}`,
            timestamp,
            type: 'config' as const,
          };
        })
        .filter((b): b is NonNullable<typeof b> => b !== null)
        .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

      return backups;
    } catch (err) {
      this.logger.warn({ err: String(err) }, 'No config backups found or directory does not exist');
      return [];
    }
  }

  async cleanupOldBackups(settings: BackupSettings): Promise<void> {
    try {
      // Cleanup old MongoDB backups
      const mongoBackups = await this.listMongoBackups();
      if (mongoBackups.length > settings.mongoBackupsToKeep) {
        const toDelete = mongoBackups.slice(settings.mongoBackupsToKeep);
        for (const backup of toDelete) {
          await this.hostExecutor.executeCommand('rm', ['-rf', backup.path]);
          this.logger.info({ backup: backup.name }, 'Deleted old MongoDB backup');
        }
      }

      // Cleanup old config backups
      const configBackups = await this.listConfigBackups();
      if (configBackups.length > settings.configBackupsToKeep) {
        const toDelete = configBackups.slice(settings.configBackupsToKeep);
        for (const backup of toDelete) {
          await this.hostExecutor.executeCommand('rm', ['-rf', backup.path]);
          this.logger.info({ backup: backup.name }, 'Deleted old config backup');
        }
      }
    } catch (err) {
      this.logger.error({ err: String(err) }, 'Failed to cleanup old backups');
    }
  }

  async getLastConfigBackup(): Promise<string | null> {
    const backups = await this.listConfigBackups();
    return backups.length > 0 ? backups[0].name : null;
  }

  async restoreBoth(configBackupName: string, mongoBackupName: string): Promise<{ success: boolean; errors: string[] }> {
    const errors: string[] = [];

    // Restore config
    const configResult = await this.restoreConfigBackup(configBackupName);
    if (!configResult.success) {
      errors.push(`Config restore failed: ${configResult.error}`);
    }

    // Restore MongoDB
    const mongoResult = await this.restoreMongoBackup(mongoBackupName);
    if (!mongoResult.success) {
      errors.push(`MongoDB restore failed: ${mongoResult.error}`);
    }

    return {
      success: errors.length === 0,
      errors,
    };
  }

  async getConfigDiff(backupName: string): Promise<{ success: boolean; files?: Record<string, { current: string; backup: string; hasDiff: boolean }>; error?: string }> {
    try {
      const backupPath = `${this.configBackupPath}/${backupName}`;

      // Check if backup exists
      const exists = await this.hostExecutor.fileExists(backupPath);
      if (!exists) {
        throw new Error(`Backup not found: ${backupName}`);
      }

      // Reuse CORE_SERVICES (all 17, incl. sepp1) instead of a second local
      // copy of this list — the exact drift that let core-configs backup
      // silently miss sepp1.yaml for who knows how long.
      const services = CORE_SERVICES;
      const files: Record<string, { current: string; backup: string; hasDiff: boolean }> = {};

      for (const service of services) {
        try {
          // Get current YAML
          const current = await this.configRepo.getRawYaml(service);

          // Get backup YAML
          const backupFilePath = `${backupPath}/${service}.yaml`;
          const backup = await this.hostExecutor.readFile(backupFilePath);

          files[service] = {
            current,
            backup,
            hasDiff: current.trim() !== backup.trim(),
          };
        } catch (err) {
          this.logger.warn({ service, err: String(err) }, 'Failed to load config for diff');
          // Skip this service if it doesn't exist
        }
      }

      return { success: true, files };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.logger.error({ err: error, backupName }, 'Failed to generate config diff');
      return { success: false, error };
    }
  }

  async restoreSelectedConfigs(backupName: string, services: string[]): Promise<{ success: boolean; restored: string[]; errors: Record<string, string> }> {
    try {
      const backupPath = `${this.configBackupPath}/${backupName}`;

      // Check if backup exists
      const exists = await this.hostExecutor.fileExists(backupPath);
      if (!exists) {
        throw new Error(`Backup not found: ${backupName}`);
      }

      const restored: string[] = [];
      const errors: Record<string, string> = {};

      for (const service of services) {
        try {
          // Real, confirmed-live 2026-09-30 finding (adversarial critic review):
          // this function built /etc/open5gs/<service>.yaml from a caller-supplied
          // string with no validation against CORE_SERVICES — true "only ever a
          // core NF" by convention (the real frontend only ever sends real names),
          // not because this function enforced it. Same explicit-allowlist pattern
          // already used elsewhere in this codebase for this exact risk class
          // (e.g. kamailio-source-build.ts's isValidKamailioTag()).
          if (!CORE_SERVICES.includes(service)) {
            throw new Error(`Not a recognized core NF service: ${service}`);
          }
          const backupFilePath = `${backupPath}/${service}.yaml`;
          const currentFilePath = `/etc/open5gs/${service}.yaml`;

          // Copy backup file to current location
          await this.hostExecutor.copyFile(backupFilePath, currentFilePath);
          restored.push(service);
          this.logger.info({ service }, 'Config file restored');
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          errors[service] = error;
          this.logger.error({ service, err: error }, 'Failed to restore config file');
        }
      }

      return {
        success: Object.keys(errors).length === 0,
        restored,
        errors,
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.logger.error({ err: error, backupName }, 'Selective config restore failed');
      throw err;
    }
  }
}
