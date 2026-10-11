import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  CMD_C_MARKER, CMD_C_PATCH_KAMAILIO6, SAVE_C_MARKER, SAVE_C_PATCH,
  CCR_C_MARKER, CCR_C_PATCH, ROC_C_MARKER, IMS_RO_C_PATCH,
  CDP_COMMON_C_MARKER, CDP_COMMON_C_PATCH, CDP_ACCTSM_C_MARKER, CDP_ACCTSM_C_PATCH,
  CDP_MOD_C_MARKER, CDP_MOD_C_PATCH,
  SECVERIFY_C_MARKER, SECVERIFY_C_PATCH,
} from './kamailio-ims-modules-build';

const execFileAsync = promisify(execFile);

// Same pattern as frr-source-build.ts / osmo-sip-connector-build.ts. Quick one-off host
// commands; the multi-minute build itself runs as a detached streamed script, not through this.
export const nsenter = async (
  cmd: string,
  args: string[] = [],
  timeoutMs = 20000,
): Promise<{ stdout: string; stderr: string }> =>
  execFileAsync('nsenter', ['-t', '1', '-m', '-u', '-i', '-p', cmd, ...args], {
    timeout: timeoutMs,
    encoding: 'utf-8',
    env: { ...process.env, DBUS_SYSTEM_BUS_ADDRESS: 'unix:path=/var/run/dbus/system_bus_socket' },
  });

// Real, confirmed live 2026-09-29: P-CSCF needs to speak real HTTP/2 to correctly call
// N5/Npcf_PolicyAuthorization on PCF via SCP, which is a genuine HTTP/2-only server —
// confirmed via SCP's own log rejecting Kamailio 5.8.8's existing http_client module's
// plain HTTP/1.1 with "nghttp2_session_mem_recv() failed (-903:Received bad client magic
// byte string)". The actual mechanism is `http_client`'s own new
// `http_client_request_v2pk(met, url, body, hdrs, respv)` function (HTTP/2 via libcurl's
// CURLOPT_HTTP_VERSION_2_PRIOR_KNOWLEDGE) — confirmed against the real 6.0.8 source
// (src/modules/http_client/README §4.7) — added to the ALREADY-loaded `http_client` module
// in the 6.0 release cycle, not a new module. (The `nghttp2` module was initially suspected
// to be the mechanism — it's real and does first appear in 6.0, but confirmed against its
// real source, src/modules/nghttp2/nghttp2_mod.c, it's an INBOUND-ONLY embedded HTTP/2
// *server* with exactly 2 exported script functions, both scoped to replying inside
// event_route[nghttp2:request] — no outbound client capability at all, so it's correctly
// left out of REQUIRED_MODULES below.) Still a genuine major-version requirement either
// way: http_client_request_v2pk doesn't exist before 6.0 (confirmed via the real upstream
// source: the function is absent from the 5.8 and 5.9 branches' http_client README).
export const DEFAULT_KAMAILIO_TAG = '6.0.8'; // latest real stable 6.0.x tag as of 2026-09-29
export const BUILD_WORKDIR = '/opt/kamailio-6-build';
export const MODULES_DIR = '/usr/lib/x86_64-linux-gnu/kamailio/modules';
export const KAMAILIO_BIN = '/usr/sbin/kamailio';

// A git ref/tag is the only thing here that could ever originate from user input before
// being embedded directly into a shell script — same guard as frr-source-build.ts.
const SAFE_TAG_RE = /^[A-Za-z0-9._-]+$/;
export function isValidKamailioTag(tag: string): boolean {
  return SAFE_TAG_RE.test(tag) && tag.length > 0 && tag.length < 128;
}

// Ground-truth module list, corrected 2026-09-29 after a real build failure: the ORIGINAL
// list (grep ^loadmodule against the static config templates) included modules gated behind
// #!ifdef flags that aren't actually enabled on this host — `kamcmd -s <ctl-socket>
// core.modules` against each of the 4 real running processes is what this list is actually
// built from now (ground truth: what's really loaded right now, not what a template's dead
// ifdef branches reference). One entry from the original list, `rtpping`, turned out not to
// exist in Kamailio 6.0's source tree AT ALL (confirmed: absent from src/modules/ at tag
// 6.0.8) — since core.modules confirms it was never actually loaded here either
// (WITH_RTPPING is undefined on this host), it's correctly dropped rather than chased as a
// rename. `nghttp2` is deliberately NOT included — see this file's own top comment for why
// it turned out not to be the actual mechanism this build exists to enable.
export const REQUIRED_MODULES = [
  // P-CSCF
  'auth', 'cdp', 'cdp_avp', 'cfg_rpc', 'corex', 'ctl', 'db_cluster', 'db_mysql', 'debugger',
  'dispatcher', 'htable', 'http_client', 'ims_dialog', 'ims_ipsec_pcscf', 'ims_qos',
  'ims_registrar_pcscf', 'ims_usrloc_pcscf', 'jansson', 'jsonrpcs', 'kex', 'maxfwd',
  'nathelper', 'path', 'pike', 'pua', 'pv', 'registrar', 'rr', 'rtimer', 'rtpengine',
  'sanity', 'sctp', 'sdpops', 'siptrace', 'siputils', 'sl', 'sqlops',
  'statistics', 'textops', 'textopsx', 'tls', 'tm', 'tmx', 'uac', 'usrloc', 'uuid',
  'websocket', 'xhttp', 'xlog', 'xmlrpc',
  // S-CSCF (additions beyond the above)
  'acc', 'enum', 'ims_auth', 'ims_charging', 'ims_isc', 'ims_registrar_scscf',
  'ims_usrloc_scscf', 'presence',
  // I-CSCF (additions beyond the above)
  'ims_icscf',
  // SMSC (additions beyond the above)
  'dialplan', 'json', 'pua_reginfo', 'smsops', 'utils',
] as const;

// Real apt build-dependencies, narrowed from Kamailio 6.0's own full noble Build-Depends
// list (pkg/kamailio/deb/noble/control) down to exactly what REQUIRED_MODULES above needs
// — confirmed against each module's own Makefile, not the full (much larger) upstream list,
// which also covers erlang/ruby/python/kazoo/rabbitmq/etc. this deployment never uses.
// libmnl-dev/libssl-dev/build-essential/bison/flex already independently confirmed as real
// requirements by kamailio-ims-modules-build.ts's own already-proven build of
// ims_ipsec_pcscf/ims_registrar_pcscf/ims_charging against 5.8.8 — reused here since they
// apply identically to 6.0's own copies of those same three modules.
// NOT 'default-libmysqlclient-dev': confirmed live 2026-09-29 this host already has
// libmariadb-dev installed (MariaDB's client library, Debian-packaged as a Conflicts/Breaks
// alternative to libmysqlclient-dev — the same db_mysql module's real 5.8.8 build on this
// host was already built against it, confirmed via `mariadb_config`/libmariadb.pc present),
// so installing default-libmysqlclient-dev alongside it fails apt's dependency resolver
// outright. db_mysql's own Makefile accepts either mysql_config or mariadb_config — don't
// add either package explicitly, the already-installed libmariadb-dev satisfies it.
export const BUILD_APT_DEPS = [
  'build-essential', 'dpkg-dev', 'bison', 'flex', 'pkg-config',
  'libxml2-dev', 'libmnl-dev', 'libsctp-dev', 'uuid-dev',
  'libjansson-dev', 'libssl-dev', 'libpcre2-dev', 'libunistring-dev', 'libcurl4-openssl-dev',
];

export const KAMAILIO_BUILD_STEPS = [
  'preparing', 'building_kamailio', 'swapping', 'starting_services', 'verifying',
] as const;
export type KamailioBuildStep = typeof KAMAILIO_BUILD_STEPS[number];

export interface KamailioSourceBuildOptions {
  targetTag: string;
  // Real host path where the pre-swap kamailio binary + modules dir is snapshotted, so a
  // failed cutover can be rolled back without depending on apt at all (apt would just
  // reinstall the same 5.8.8 .debs — fine for a clean revert, but slower and this project's
  // own established convention, per frr-source-build.ts, is a snapshot-based restore that
  // doesn't depend on network/apt availability).
  snapshotDir: string;
}

// Generates the full build script. Ordered to minimize the live-outage window: everything
// through a successful compile happens in an isolated build directory without touching any
// of the 4 running Kamailio services at all. Only "swapping" (after a successful compile)
// stops them, snapshots the current binary+modules for rollback, and swaps in the new
// build. Config files under /etc/kamailio_{pcscf,scscf,icscf,smsc}/ are this project's own
// non-standard paths (not Kamailio's own default /etc/kamailio/) — `make install` never
// touches them, confirmed against the real Debian packaging rules
// (cfg_target=/etc/kamailio/, a path this project has never used).
export function buildKamailioSourceScript(opts: KamailioSourceBuildOptions): string {
  if (!isValidKamailioTag(opts.targetTag)) {
    throw new Error(`Invalid Kamailio target tag: ${JSON.stringify(opts.targetTag)}`);
  }
  const includeModules = REQUIRED_MODULES.join(' ');

  return `#!/bin/bash
set -e
export DEBIAN_FRONTEND=noninteractive

# Heartbeat: clone/configure/compile phases can go quiet for minutes at a time, which reads
# as "stuck" from a live log viewer even though it's working — same shape as
# frr-source-build.ts's own heartbeat.
start_heartbeat() {
  ( while true; do sleep 15; echo "... still working (\${SECONDS}s in this phase)"; done ) &
  echo $! > /tmp/kamailio-source-build-heartbeat.pid
}
stop_heartbeat() {
  if [ -f /tmp/kamailio-source-build-heartbeat.pid ]; then
    kill "$(cat /tmp/kamailio-source-build-heartbeat.pid)" 2>/dev/null || true
    rm -f /tmp/kamailio-source-build-heartbeat.pid
  fi
}
# A bare set -e death (e.g. an apt dependency conflict) otherwise leaves no terminal
# sentinel at all — a log watcher polling for ==STEP:done== or a literal ERROR: line would
# wait forever on a process that's already gone. Captures the real exit code before
# stop_heartbeat can touch $?, and only emits the failure sentinel for a genuine nonzero
# exit (a normal/expected exit already logs its own ==STEP:done== earlier and hits this
# trap with $?=0).
trap 'ec=\$?; stop_heartbeat; if [ "\$ec" -ne 0 ]; then echo "==STEP:script_failed=="; echo "(exited \$ec)"; fi' EXIT

echo "==STEP:preparing=="
avail_kb=$(df -Pk /opt | tail -1 | awk '{print $4}')
if [ "$avail_kb" -lt 3000000 ]; then
  echo "ERROR: less than ~3GB free under /opt (have: \${avail_kb}KB) — aborting before a long build fills the disk."
  exit 1
fi
apt-get update -qq
apt-get install -y ${BUILD_APT_DEPS.join(' \\\n  ')}

echo "==STEP:building_kamailio=="
mkdir -p ${BUILD_WORKDIR}
cd ${BUILD_WORKDIR}
rm -rf kamailio-src
start_heartbeat
git clone --branch ${opts.targetTag} --depth 1 https://github.com/kamailio/kamailio.git kamailio-src
stop_heartbeat
cd kamailio-src

echo "==STEP:patching=="
# Same 4 real behavioral fixes kamailio-ims-modules-build.ts already applies against the
# 5.8.8 apt package (ipsec_create()'s unconditional NULL-security_temp hard-fail, the
# via-URI reg_state fallback lookup, and the 5 Diameter Ro/Gy AVP-format fixes) — a fresh
# vanilla 6.0.8 compile would otherwise silently lack all of them, which is exactly what
# caused a real live regression this project hit (see CMD_C_PATCH_KAMAILIO6's own comment,
# kamailio-ims-modules-build.ts): 4G calling broke after this build's first use until these
# were re-applied by hand. CMD_C_PATCH_KAMAILIO6 (not CMD_C_PATCH) is used deliberately —
# see its own comment for why the stock CMD_C_PATCH's 4th hunk must NOT be ported here
# (upstream Kamailio already contains that fix as of 6.0.8; forcing it via fuzzy-patch
# produces a real duplicate-assignment line, confirmed live 2026-09-29). All 4 patches
# below were verified live 2026-09-29 with a real \`patch --fuzz=0\` dry-run AND a real
# sequential apply against a freshly cloned, unmodified ${opts.targetTag} checkout before
# being wired in here.
IPSEC_C=src/modules/ims_ipsec_pcscf/cmd.c
REGISTRAR_C=src/modules/ims_registrar_pcscf/save.c
CCR_C=src/modules/ims_charging/ccr.c
IMS_RO_C=src/modules/ims_charging/ims_ro.c

if grep -q "${CMD_C_MARKER}" "$IPSEC_C"; then
  echo "  ok    $IPSEC_C (already patched)"
else
  cat > /tmp/cmd.c.patch <<'PATCHEOF'
${CMD_C_PATCH_KAMAILIO6}
PATCHEOF
  patch -p1 --forward --batch < /tmp/cmd.c.patch
  grep -q "${CMD_C_MARKER}" "$IPSEC_C" || { echo "ERROR: $IPSEC_C patch marker missing after apply — upstream source may have changed, review manually."; exit 1; }
  echo "  PATCH $IPSEC_C"
fi

# Same file as CMD_C_PATCH_KAMAILIO6 above (ims_ipsec_pcscf/cmd.c), applied second —
# disjoint regions (ipsec_create() vs ipsec_forward()/add_security_verify_header()),
# verified live 2026-10-01 to apply cleanly in this exact sequential order against this
# exact source tree. Full rationale in SECVERIFY_C_PATCH's own comment
# (kamailio-ims-modules-build.ts).
if grep -q "${SECVERIFY_C_MARKER}" "$IPSEC_C"; then
  echo "  ok    $IPSEC_C (already patched for sec-agree)"
else
  cat > /tmp/secverify.c.patch <<'PATCHEOF'
${SECVERIFY_C_PATCH}
PATCHEOF
  patch -p1 --forward --batch < /tmp/secverify.c.patch
  grep -q "${SECVERIFY_C_MARKER}" "$IPSEC_C" || { echo "ERROR: $IPSEC_C sec-agree patch marker missing after apply — upstream source may have changed, review manually."; exit 1; }
  echo "  PATCH $IPSEC_C (sec-agree on MT INVITE)"
fi

if grep -q "${SAVE_C_MARKER}" "$REGISTRAR_C"; then
  echo "  ok    $REGISTRAR_C (already patched)"
else
  cat > /tmp/save.c.patch <<'PATCHEOF'
${SAVE_C_PATCH}
PATCHEOF
  patch -p1 --forward --batch < /tmp/save.c.patch
  grep -q "${SAVE_C_MARKER}" "$REGISTRAR_C" || { echo "ERROR: $REGISTRAR_C patch marker missing after apply — upstream source may have changed, review manually."; exit 1; }
  echo "  PATCH $REGISTRAR_C"
fi

if grep -q "${CCR_C_MARKER}" "$CCR_C"; then
  echo "  ok    $CCR_C (already patched)"
else
  cat > /tmp/ccr.c.patch <<'PATCHEOF'
${CCR_C_PATCH}
PATCHEOF
  patch -p1 --forward --batch < /tmp/ccr.c.patch
  grep -q "${CCR_C_MARKER}" "$CCR_C" || { echo "ERROR: $CCR_C patch marker missing after apply — upstream source may have changed, review manually."; exit 1; }
  echo "  PATCH $CCR_C"
fi

if grep -q "${ROC_C_MARKER}" "$IMS_RO_C"; then
  echo "  ok    $IMS_RO_C (already patched)"
else
  cat > /tmp/ims_ro.c.patch <<'PATCHEOF'
${IMS_RO_C_PATCH}
PATCHEOF
  patch -p1 --forward --batch < /tmp/ims_ro.c.patch
  grep -q "${ROC_C_MARKER}" "$IMS_RO_C" || { echo "ERROR: $IMS_RO_C patch marker missing after apply — upstream source may have changed, review manually."; exit 1; }
  echo "  PATCH $IMS_RO_C"
fi

# Real bug found live 2026-10-01, a direct side effect of CCR_C_PATCH above (not a
# separate regression): removing Accounting-Record-Type/Number from every CCR — correct,
# since OCS's strict decoder rejects them — left cdp's own generic "cc_acc" session state
# machine (acctstatemachine.c) with no way to tell a CCR-Initial/Update/Terminate apart,
# since it reads that exact AVP to decide. Fix re-derives the same signal from
# CC-Request-Type (a real, always-present RFC 4006 AVP) as a fallback that only engages
# when Accounting-Record-Type is absent entirely. Full rationale in
# CDP_COMMON_C_PATCH's/CDP_ACCTSM_C_PATCH's own comments (kamailio-ims-modules-build.ts).
CDP_COMMON_C=src/modules/cdp/common.c
CDP_ACCTSM_C=src/modules/cdp/acctstatemachine.c

if grep -q "${CDP_COMMON_C_MARKER}" "$CDP_COMMON_C"; then
  echo "  ok    $CDP_COMMON_C (already patched)"
else
  cat > /tmp/cdp_common.c.patch <<'PATCHEOF'
${CDP_COMMON_C_PATCH}
PATCHEOF
  patch -p1 --forward --batch < /tmp/cdp_common.c.patch
  grep -q "${CDP_COMMON_C_MARKER}" "$CDP_COMMON_C" || { echo "ERROR: $CDP_COMMON_C patch marker missing after apply — upstream source may have changed, review manually."; exit 1; }
  echo "  PATCH $CDP_COMMON_C (+ common.h)"
fi

if grep -q "${CDP_ACCTSM_C_MARKER}" "$CDP_ACCTSM_C"; then
  echo "  ok    $CDP_ACCTSM_C (already patched)"
else
  cat > /tmp/cdp_acctsm.c.patch <<'PATCHEOF'
${CDP_ACCTSM_C_PATCH}
PATCHEOF
  patch -p1 --forward --batch < /tmp/cdp_acctsm.c.patch
  grep -q "${CDP_ACCTSM_C_MARKER}" "$CDP_ACCTSM_C" || { echo "ERROR: $CDP_ACCTSM_C patch marker missing after apply — upstream source may have changed, review manually."; exit 1; }
  echo "  PATCH $CDP_ACCTSM_C"
fi

# The cdp process-slot fix. Previously lived only as an inline sed in
# ims-controller.ts's Install step, so a source build replaced cdp.so with an
# unpatched one and silently dropped it (confirmed live 2026-10-03) — see
# CDP_MOD_C_PATCH's own comment. Applied here so the pipeline that builds
# cdp.so is also the one that keeps every cdp patch on it.
CDP_MOD_C=src/modules/cdp/cdp_mod.c

if grep -q "${CDP_MOD_C_MARKER}" "$CDP_MOD_C"; then
  echo "  ok    $CDP_MOD_C (already patched)"
else
  cat > /tmp/cdp_mod.c.patch <<'PATCHEOF'
${CDP_MOD_C_PATCH}
PATCHEOF
  patch -p1 --forward --batch < /tmp/cdp_mod.c.patch
  grep -q "${CDP_MOD_C_MARKER}" "$CDP_MOD_C" || { echo "ERROR: $CDP_MOD_C patch marker missing after apply — upstream source may have changed, review manually."; exit 1; }
  echo "  PATCH $CDP_MOD_C"
fi

echo "Selected modules: ${includeModules}"
make include_modules="${includeModules}" cfg

# Dry-run sanity check before spending minutes on the real compile: print-modules shows
# exactly what would be included/excluded for this include_modules= selection — confirms
# every module we actually need really resolved to something buildable, not a typo'd name
# that Kamailio's own module resolution silently dropped.
make print-modules > /tmp/kamailio-print-modules.log 2>&1 || true
for m in ${includeModules}; do
  if ! grep -q "\\b$m\\b" /tmp/kamailio-print-modules.log; then
    echo "ERROR: module '$m' does not appear in 'make print-modules' output — likely a bad module name. See /tmp/kamailio-print-modules.log."
    exit 1
  fi
done
echo "print-modules sanity check passed — all ${REQUIRED_MODULES.length} required modules resolved."

start_heartbeat
make all
stop_heartbeat

# Confirm the new http_client.so was actually produced before going any further — the
# module carrying the real fix this build exists for (http_client_request_v2pk(), which
# doesn't exist before 6.0 — see this file's own top comment for why nghttp2 itself turned
# out not to be the mechanism).
NEW_HTTP_CLIENT_SO="$(find . -path '*/modules/http_client/http_client.so' | head -1)"
test -n "$NEW_HTTP_CLIENT_SO" && test -f "$NEW_HTTP_CLIENT_SO" || { echo "ERROR: build did not produce http_client.so."; exit 1; }
echo "http_client.so built: $NEW_HTTP_CLIENT_SO"

# ─── Everything above this line is isolated in the build directory — none of the 4 ───
# ─── live Kamailio services (pcscf/scscf/icscf/smsc) have been touched at all.     ───

echo "==STEP:swapping=="

# Never stop a Kamailio/Asterisk instance carrying live traffic — same standing project
# convention as every other Kamailio/Asterisk restart this session (S-CSCF's own real-time
# dialog count via kamcmd, plus both Asterisk instances' own "core show channels count",
# the exact mechanism call-stats-monitor.ts/asterisk-stats-monitor.ts already use live).
# The build itself (clone+compile, above) can run for a long time before reaching this
# point, so the check has to happen HERE, right before the stop — not just once back when
# the build was originally requested. Bounded retry (20 x 30s = up to 10 minutes) rather
# than an infinite wait or an immediate give-up: real calls are typically short, and a
# failed check after a successful multi-minute compile shouldn't throw the compiled build
# away — it just means the swap needs a manual retry once calls clear.
check_active_calls() {
  local total=0
  if [ -S /run/kamailio_scscf/kamailio_ctl ]; then
    local dlg
    dlg=$(kamcmd -s /run/kamailio_scscf/kamailio_ctl stats.get_statistics dialog_ng: 2>/dev/null | grep -oP 'dialog_ng:active\\s*=\\s*\\K\\d+' || echo 0)
    total=$((total + \${dlg:-0}))
  fi
  if [ -S /run/asterisk/asterisk.ctl ]; then
    local pstn
    pstn=$(asterisk -rx "core show channels count" 2>/dev/null | grep -oP '^\\K\\d+(?= active calls?)' || echo 0)
    total=$((total + \${pstn:-0}))
  fi
  if [ -S /run/asterisk-2g/asterisk.ctl ]; then
    local a2g
    a2g=$(asterisk -C /etc/asterisk-2g/asterisk.conf -rx "core show channels count" 2>/dev/null | grep -oP '^\\K\\d+(?= active calls?)' || echo 0)
    total=$((total + \${a2g:-0}))
  fi
  echo "$total"
}

attempt=1
while true; do
  active=$(check_active_calls)
  if [ "$active" -eq 0 ]; then
    echo "No active calls (attempt $attempt) — proceeding with swap."
    break
  fi
  if [ "$attempt" -ge 20 ]; then
    echo "ERROR: $active active call(s)/dialog(s) still present after 20 checks (~10 minutes) — aborting swap. Live Kamailio/Asterisk services were NOT touched. The compiled build is preserved in ${BUILD_WORKDIR}/kamailio-src for a manual retry once calls have cleared."
    exit 1
  fi
  echo "$active active call(s)/dialog(s) present — waiting 30s before recheck (attempt $attempt/20)..."
  attempt=$((attempt + 1))
  sleep 30
done

SNAPSHOT_DIR="${opts.snapshotDir}"
mkdir -p "$SNAPSHOT_DIR"
if [ -f "${KAMAILIO_BIN}" ]; then cp -a "${KAMAILIO_BIN}" "$SNAPSHOT_DIR/kamailio-bin"; fi
if [ -d "${MODULES_DIR}" ]; then cp -a "${MODULES_DIR}" "$SNAPSHOT_DIR/modules-dir"; fi
dpkg-query -W -f='\${Version}\\n' kamailio kamailio-ims-modules kamailio-extra-modules kamailio-json-modules kamailio-mysql-modules kamailio-presence-modules kamailio-sctp-modules kamailio-tls-modules kamailio-utils-modules 2>/dev/null > "$SNAPSHOT_DIR/apt-versions.txt" || true
touch "$SNAPSHOT_DIR/.snapshot-complete"
echo "snapshot written: $SNAPSHOT_DIR"

# Zero active calls confirmed by the caller (ims-controller.ts) immediately before this
# script is invoked — same discipline as every other restart this project makes to a
# live-traffic service. Stop all 4 before installing new binaries/modules so nothing is
# left running against a half-swapped module directory.
systemctl stop kamailio-pcscf kamailio-scscf kamailio-icscf kamailio-smsc || true

make install prefix=/usr LIBDIR=lib/x86_64-linux-gnu
echo "installed: ${KAMAILIO_BIN}"
echo "installed: ${MODULES_DIR}"

echo "==STEP:starting_services=="
systemctl daemon-reload
for svc in kamailio-pcscf kamailio-scscf kamailio-icscf kamailio-smsc; do
  systemctl start "$svc"
done
sleep 3

echo "==STEP:verifying=="
${KAMAILIO_BIN} -V | head -1
for svc in kamailio-pcscf kamailio-scscf kamailio-icscf kamailio-smsc; do
  systemctl is-active "$svc"
done

echo "==STEP:done=="
`;
}

// Restore Kamailio to its previous working state from a snapshot taken during the
// "swapping" step of a prior build — same no-apt-dependency rollback shape as
// frr-source-build.ts's restoreFrrFromSnapshot(). No-ops safely if the snapshot never
// completed (i.e. a failed build never reached "swapping", meaning the previously-running
// Kamailio install was never touched in the first place).
export async function restoreKamailioFromSnapshot(
  snapshotDir: string,
): Promise<{ restored: boolean }> {
  const { stdout: markerCheck } = await nsenter('bash', [
    '-c', `[ -f "${snapshotDir}/.snapshot-complete" ] && echo yes || echo no`,
  ]);
  if (markerCheck.trim() !== 'yes') {
    return { restored: false };
  }

  const script = `
set -e
systemctl stop kamailio-pcscf kamailio-scscf kamailio-icscf kamailio-smsc || true
if [ -f "${snapshotDir}/kamailio-bin" ]; then
  cp -a "${snapshotDir}/kamailio-bin" "${KAMAILIO_BIN}"
fi
if [ -d "${snapshotDir}/modules-dir" ]; then
  rm -rf "${MODULES_DIR}"
  cp -a "${snapshotDir}/modules-dir" "${MODULES_DIR}"
fi
systemctl daemon-reload
for svc in kamailio-pcscf kamailio-scscf kamailio-icscf kamailio-smsc; do
  systemctl start "$svc"
done
`;
  await nsenter('bash', ['-c', script], 60000);
  return { restored: true };
}

// Real post-build check — asks the host directly whether all 4 services are up and
// reports the live version string, rather than scraping build-log text.
export async function verifyKamailioBuild(): Promise<{
  pcscfActive: boolean;
  scscfActive: boolean;
  icscfActive: boolean;
  smscActive: boolean;
  version: string | null;
}> {
  const isActive = async (svc: string): Promise<boolean> => {
    try {
      const { stdout } = await nsenter('systemctl', ['is-active', svc]);
      return stdout.trim() === 'active';
    } catch { return false; }
  };
  let version: string | null = null;
  try {
    const { stdout } = await nsenter(KAMAILIO_BIN, ['-V']);
    version = stdout.split('\n')[0]?.trim() ?? null;
  } catch {}
  const [pcscfActive, scscfActive, icscfActive, smscActive] = await Promise.all([
    isActive('kamailio-pcscf'), isActive('kamailio-scscf'), isActive('kamailio-icscf'), isActive('kamailio-smsc'),
  ]);
  return { pcscfActive, scscfActive, icscfActive, smscActive, version };
}

// Real, confirmed live 2026-09-29: `http_client_request_v2pk()` (the N5/Npcf_
// PolicyAuthorization HTTP/2 call in kamailio_pcscf's mo.cfg/mt.cfg,
// route[MO/MT_N5_CALL_PCF_POLICY_AUTH]) does not exist in stock Kamailio 5.8.8's
// http_client module at all — calling it is not a runtime failure, it's a FATAL
// CONFIG PARSE ERROR ("unknown command, missing loadmodule?"), confirmed via a
// real `kamailio -c` config-check against the actual 5.8.8 binary (this project's
// own pre-swap snapshot) and a minimal test .cfg. Both N5 routes are wrapped in a
// single `#!ifdef WITH_N5 ... #!endif` block spanning the whole route body, so
// Kamailio's preprocessor strips them entirely (never reaching the parser) when
// WITH_N5 is undefined — meaning ims-controller.ts's pcscfIncludeCfg() MUST only
// emit `#!define WITH_N5` when this function confirms Kamailio 6.0+ is actually
// the one that will run the generated config, or P-CSCF fails to start AT ALL
// (not just "VoNR doesn't work") on every deployment still on the default,
// apt-installed 5.8.8 — i.e., every fresh install and every existing deployment
// that hasn't also run the separate, opt-in Kamailio 6.0.8 source-build.
export async function isKamailioHttp2Capable(): Promise<boolean> {
  try {
    const { stdout } = await nsenter(KAMAILIO_BIN, ['-V']);
    const m = stdout.match(/kamailio\s+(\d+)\./i);
    return !!m && parseInt(m[1], 10) >= 6;
  } catch {
    return false;
  }
}
