import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// Same nsenter pattern as kamailio-source-build.ts / frr-source-build.ts.
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

// Real, confirmed live 2026-09-29: 4G<->5G/5G<->5G cross-RAT calls intermittently died a
// few seconds into a real, fully-connected, real-two-way-audio call. Root-caused via a raw
// packet capture: rtpengine's own relay pairing looped a local UDP port pair back on itself
// (the host's own IP sending to itself at ~15,000-30,000 packets/sec — not real UE traffic
// at all), which overflows rtpengine's per-socket receive-loop iteration cap and aborts,
// dropping packets — confirmed via the real rtpengine source
// (daemon/media_socket.c:40-46): `MAX_RECV_ITERS`/`MAX_RECV_LOOP_STRIKES` are hardcoded
// `#ifndef`-guarded compile-time constants (50 / 5 by default) with NO runtime config-file
// or CLI equivalent — raising them requires a real source rebuild. The actual root cause of
// the loop itself is a separate, already-fixed Kamailio script bug (rtp.cfg/mo.cfg/mt.cfg:
// route(NATMANAGE) calling rtpengine_manage() twice for the same offer/answer on a real SIP
// retransmission landing during the N5-fallback path's extra HTTP/2-to-PCF latency) — this
// build's own widened limits are a real, deliberate hardening on top of that fix, not a
// substitute for it: even a single genuine burst larger than the stock 50-iteration cap
// (plausible on a real 5G radio path's own jitter/buffering) would hit the same symptom.
export const DEFAULT_RTPENGINE_TAG = '11.5.1.18-1ubuntu1.2'; // matches this project's currently-targeted Ubuntu 24.04 apt version — see buildRtpengineSourceScript()'s own apt-get source call, not a git tag
export const BUILD_WORKDIR = '/opt/rtpengine-build';
export const RTPENGINE_BIN = '/usr/bin/rtpengine';

export const MAX_RECV_ITERS = 500; // stock default: 50 — confirmed live via real source, daemon/media_socket.c
export const MAX_RECV_LOOP_STRIKES = 20; // stock default: 5 — self-healing counter, widened for extra tolerance alongside MAX_RECV_ITERS

// Real apt build-dependencies, taken directly from the real Debian control file
// (`debian/control`'s Build-Depends) for this exact installed rtpengine version — confirmed
// live 2026-09-29 by actually building against them. NOT `default-libmysqlclient-dev`:
// confirmed live this host already has `libmariadb-dev` installed (Debian's real
// Conflicts/Breaks alternative to libmysqlclient-dev), so installing both fails apt's
// dependency resolver outright — same exact landmine as kamailio-source-build.ts's own
// BUILD_APT_DEPS hit for the same reason. rtpengine's own media_player.c genuinely needs
// MySQL/MariaDB client headers (`mysql.h`, `mysql/errmsg.h`) — satisfied via the
// mysql_config-shim + errmsg.h-symlink workaround in buildRtpengineSourceScript() below,
// not by installing a second, conflicting client library.
export const BUILD_APT_DEPS = [
  'gperf', 'libavcodec-dev', 'libavfilter-dev', 'libavformat-dev', 'libavutil-dev',
  'libbcg729-dev', 'libbencode-perl', 'libcrypt-openssl-rsa-perl', 'libcrypt-rijndael-perl',
  'libcurl4-openssl-dev', 'libdigest-crc-perl', 'libdigest-hmac-perl', 'libevent-dev',
  'libglib2.0-dev', 'libhiredis-dev', 'libio-multiplex-perl', 'libio-socket-inet6-perl',
  'libio-socket-ip-perl', 'libiptc-dev', 'libjson-glib-dev', 'libjson-perl',
  'libmosquitto-dev', 'libncurses-dev', 'libnet-interface-perl', 'libopus-dev',
  'libpcap0.8-dev', 'libpcre2-dev', 'libsocket6-perl', 'libspandsp-dev', 'libssl-dev',
  'libswresample-dev', 'libsystemd-dev', 'libtest2-suite-perl', 'libwebsockets-dev',
  'libxmlrpc-core-c3-dev', 'libxtables-dev', 'markdown', 'pandoc',
];

// Real unified diff against the actual fetched 11.5.1.18 source (daemon/media_socket.c,
// confirmed live 2026-09-29 via `apt-get source rtpengine-daemon` on this exact host) —
// same `patch -p1 --forward --batch` idiom already proven in this codebase by
// kamailio-ims-modules-build.ts's own CCR_C_PATCH/IMS_RO_C_PATCH, chosen over a fragile
// exact-string-replace specifically so a future upstream source revision that shifts
// surrounding lines still applies cleanly (or fails loudly via a real patch-reject, not
// silently doing nothing).
export const MEDIA_SOCKET_C_MARKER = 'NMS tuning';
// Verified live 2026-09-29 with a real `patch -p1 --forward --batch --fuzz=0` dry-run AND
// real apply against a freshly `apt-get source rtpengine-daemon`-fetched, unmodified copy of
// 11.5.1.18 — byte-for-byte diffed against an independently hand-edited expected result to
// confirm correctness. This is the literal output of `diff -u` (blank context lines are a
// single space + newline, not empty — a hand-rolled version of this patch that used empty
// context lines silently only applied via patch's fuzz-2 leniency, never with --fuzz=0, which
// this build script does not pass, so it must stay in this exact diff -u-produced form).
export const MEDIA_SOCKET_C_PATCH = String.raw`--- a/daemon/media_socket.c
+++ b/daemon/media_socket.c
@@ -38,11 +38,21 @@
 #endif
 
 #ifndef MAX_RECV_ITERS
-#define MAX_RECV_ITERS 50
+/* NMS tuning, confirmed live via a real 5G VoNR call: this cap is a hardcoded,
+ * compile-time-only per-read-event iteration limit for ONE socket's ONE epoll callback,
+ * unrelated to the worker thread pool size. 50 is too tight for a real burst on a real 5G
+ * radio path's own jitter/buffering (confirmed via packet capture + a real "Too many
+ * packets in UDP receive queue" log line matching a live call's own Call-ID). 10x headroom.
+ */
+#define MAX_RECV_ITERS 500
 #endif
 
 #ifndef MAX_RECV_LOOP_STRIKES
-#define MAX_RECV_LOOP_STRIKES 5
+/* NMS tuning — same real incident as MAX_RECV_ITERS above. Self-healing counter
+ * (decremented on a clean read elsewhere in this file), not a permanent breaker, widened
+ * alongside MAX_RECV_ITERS for extra tolerance during a rough patch of radio-side jitter.
+ */
+#define MAX_RECV_LOOP_STRIKES 20
 #endif
 
 #define DS_io(x, ps, ke, io) do {						\
`;

export const RTPENGINE_BUILD_STEPS = [
  'preparing', 'building_rtpengine', 'swapping', 'starting_service', 'verifying',
] as const;
export type RtpengineBuildStep = typeof RTPENGINE_BUILD_STEPS[number];

export interface RtpengineSourceBuildOptions {
  snapshotDir: string;
}

// Isolated build -> snapshot -> swap -> verify, same shape as kamailio-source-build.ts /
// frr-source-build.ts. Everything through a successful compile happens in an isolated build
// directory without touching the live rtpengine-daemon service at all. Only "swapping"
// (after a successful compile) stops it, snapshots the current binary for rollback, and
// swaps in the new build — gated the same way as the Kamailio build's own swap step, since
// rtpengine carries live call media just like Kamailio carries live call signaling.
export function buildRtpengineSourceScript(opts: RtpengineSourceBuildOptions): string {
  return `#!/bin/bash
set -e
export DEBIAN_FRONTEND=noninteractive

start_heartbeat() {
  ( while true; do sleep 15; echo "... still working (\${SECONDS}s in this phase)"; done ) &
  echo $! > /tmp/rtpengine-source-build-heartbeat.pid
}
stop_heartbeat() {
  if [ -f /tmp/rtpengine-source-build-heartbeat.pid ]; then
    kill "$(cat /tmp/rtpengine-source-build-heartbeat.pid)" 2>/dev/null || true
    rm -f /tmp/rtpengine-source-build-heartbeat.pid
  fi
}
trap 'ec=\$?; stop_heartbeat; if [ "\$ec" -ne 0 ]; then echo "==STEP:script_failed=="; echo "(exited \$ec)"; fi' EXIT

echo "==STEP:preparing=="
avail_kb=$(df -Pk /opt | tail -1 | awk '{print $4}')
if [ "$avail_kb" -lt 3000000 ]; then
  echo "ERROR: less than ~3GB free under /opt (have: \${avail_kb}KB) — aborting before a long build fills the disk."
  exit 1
fi
apt-get update -qq
apt-get install -y ${BUILD_APT_DEPS.join(' \\\n  ')}

echo "==STEP:building_rtpengine=="
mkdir -p ${BUILD_WORKDIR}
cd ${BUILD_WORKDIR}
rm -rf rtpengine-src
mkdir -p rtpengine-src
cd rtpengine-src
start_heartbeat
apt-get source rtpengine-daemon
stop_heartbeat
SRC_DIR="$(find . -maxdepth 1 -type d -iname 'rtpengine-*' | head -1)"
if [ -z "$SRC_DIR" ]; then
  echo "ERROR: apt-get source did not produce a rtpengine-* source directory."
  exit 1
fi
cd "$SRC_DIR"

echo "==STEP:patching=="
MEDIA_SOCKET_C=daemon/media_socket.c
if grep -q "${MEDIA_SOCKET_C_MARKER}" "$MEDIA_SOCKET_C"; then
  echo "  ok    $MEDIA_SOCKET_C (already patched)"
else
  cat > /tmp/media_socket.c.patch <<'PATCHEOF'
${MEDIA_SOCKET_C_PATCH}
PATCHEOF
  patch -p1 --forward --batch < /tmp/media_socket.c.patch
  grep -q "${MEDIA_SOCKET_C_MARKER}" "$MEDIA_SOCKET_C" || { echo "ERROR: $MEDIA_SOCKET_C patch marker missing after apply — upstream source may have changed, review manually."; exit 1; }
  echo "  PATCH $MEDIA_SOCKET_C"
fi

cd daemon

# mysql_config shim (this host has libmariadb-dev, not the conflicting
# default-libmysqlclient-dev — see this file's own BUILD_APT_DEPS comment) + a targeted
# errmsg.h symlink (MariaDB's real compat dir has client_plugin.h/plugin_auth.h but not
# errmsg.h, which media_player.c needs at the mysql/errmsg.h path specifically).
mkdir -p /tmp/mysql-shim
cat > /tmp/mysql-shim/mysql_config <<'EOF'
#!/bin/bash
exec mariadb_config "$@"
EOF
chmod +x /tmp/mysql-shim/mysql_config
MARIADB_INCDIR="$(mariadb_config --variable=pkgincludedir 2>/dev/null || echo /usr/include/mariadb)"
if [ ! -f "$MARIADB_INCDIR/mysql/errmsg.h" ] && [ -f "$MARIADB_INCDIR/errmsg.h" ]; then
  mkdir -p "$MARIADB_INCDIR/mysql"
  ln -sf "$MARIADB_INCDIR/errmsg.h" "$MARIADB_INCDIR/mysql/errmsg.h"
fi

start_heartbeat
PATH=/tmp/mysql-shim:$PATH make -j"$(nproc)" rtpengine rtpengine.8
stop_heartbeat

test -f rtpengine || { echo "ERROR: build did not produce the rtpengine binary."; exit 1; }
echo "rtpengine binary built: $(pwd)/rtpengine"
./rtpengine --version

# ─── Everything above this line is isolated in the build directory — the live ───
# ─── rtpengine-daemon service has not been touched at all.                    ───

echo "==STEP:swapping=="

# Never stop a media relay carrying live call audio — same standing project convention as
# every other Kamailio/Asterisk/rtpengine restart this project makes. Bounded retry
# (20 x 30s = up to 10 minutes) rather than an infinite wait or an immediate give-up.
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
    echo "ERROR: $active active call(s)/dialog(s) still present after 20 checks (~10 minutes) — aborting swap. The live rtpengine binary was NOT touched. The compiled build is preserved in ${BUILD_WORKDIR}/rtpengine-src for a manual retry once calls have cleared."
    exit 1
  fi
  echo "$active active call(s)/dialog(s) present — waiting 30s before recheck (attempt $attempt/20)..."
  attempt=$((attempt + 1))
  sleep 30
done

SNAPSHOT_DIR="${opts.snapshotDir}"
mkdir -p "$SNAPSHOT_DIR"
if [ -f "${RTPENGINE_BIN}" ]; then cp -a "${RTPENGINE_BIN}" "$SNAPSHOT_DIR/rtpengine-bin"; fi
dpkg-query -W -f='\${Version}\\n' rtpengine-daemon 2>/dev/null > "$SNAPSHOT_DIR/apt-version.txt" || true
touch "$SNAPSHOT_DIR/.snapshot-complete"
echo "snapshot written: $SNAPSHOT_DIR"

systemctl stop rtpengine-daemon || true

# Atomic swap, not an in-place overwrite — the running process still holds the old binary's
# inode open ("Text file busy" on a direct cp), confirmed live 2026-09-29.
cp "$(pwd)/rtpengine" "${RTPENGINE_BIN}.new"
mv "${RTPENGINE_BIN}.new" "${RTPENGINE_BIN}"
echo "installed: ${RTPENGINE_BIN}"

echo "==STEP:starting_service=="
systemctl daemon-reload
systemctl start rtpengine-daemon
sleep 3

echo "==STEP:verifying=="
${RTPENGINE_BIN} --version
systemctl is-active rtpengine-daemon

echo "==STEP:done=="
`;
}

export async function restoreRtpengineFromSnapshot(
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
systemctl stop rtpengine-daemon || true
if [ -f "${snapshotDir}/rtpengine-bin" ]; then
  cp "${snapshotDir}/rtpengine-bin" "${RTPENGINE_BIN}.restore"
  mv "${RTPENGINE_BIN}.restore" "${RTPENGINE_BIN}"
fi
systemctl daemon-reload
systemctl start rtpengine-daemon
`;
  await nsenter('bash', ['-c', script], 60000);
  return { restored: true };
}

export async function verifyRtpengineBuild(): Promise<{
  active: boolean;
  version: string | null;
}> {
  let active = false;
  try {
    const { stdout } = await nsenter('systemctl', ['is-active', 'rtpengine-daemon']);
    active = stdout.trim() === 'active';
  } catch {}
  let version: string | null = null;
  try {
    const { stdout } = await nsenter(RTPENGINE_BIN, ['--version']);
    version = stdout.split('\n')[0]?.trim() ?? null;
  } catch {}
  return { active, version };
}
