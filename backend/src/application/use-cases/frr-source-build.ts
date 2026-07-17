import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// Format: H   Address           Interface  Hold  Uptime  SRTT  RTO  Q  Seq
//         0   192.168.253.1     ens20      12    0       0     2    0  22393
// H column is an integer index; skip lines that don't start with a digit.
// Lives here (not frr-controller.ts) so this module doesn't need to import back into it.
export function parseEigrpNeighbors(raw: string): any[] {
  const result: any[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || !/^\d/.test(trimmed)) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 3) continue;
    const ip    = parts[1];
    const iface = parts[2];
    const hold  = parts[3] ?? '';
    const uptime = parts[4] ?? '';
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) continue;
    result.push({ ip, iface, holdTime: hold, uptime, state: 'active' });
  }
  return result;
}

// Quick one-off host commands. The actual multi-minute build itself runs as a separate
// detached script (see the controllers that call buildFrrSourceScript), not through this.
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

export const DEFAULT_FRR_TAG = 'frr-10.6.1';
export const LIBYANG_TAG = 'v3.13.6';
export const BUILD_WORKDIR = '/opt/frr-build';

// A git ref/tag is the only thing from this module that ever originates from user input
// (the wizard's "target tag" field) before being embedded directly into a shell script —
// restrict it to a safe charset so it can't be used to break out of the script.
const SAFE_TAG_RE = /^[A-Za-z0-9._-]+$/;
export function isValidFrrTag(tag: string): boolean {
  return SAFE_TAG_RE.test(tag) && tag.length > 0 && tag.length < 128;
}

export const FRR_BUILD_STEPS = [
  'preparing', 'building_libyang', 'building_frr', 'swapping', 'starting_service', 'verifying',
] as const;
export type FrrBuildStep = typeof FRR_BUILD_STEPS[number];

// Set a "<daemon>=yes|no" line in an /etc/frr/daemons file, replacing it if present or
// appending it if missing entirely — older daemons files (pre-mgmtd, e.g. FRR 8.4.4) don't
// have a line for every daemon FRR now ships, and a plain regex .replace() silently no-ops
// when the line doesn't exist, leaving that daemon disabled.
export function ensureDaemonLine(content: string, daemon: string, enabled: boolean): string {
  const line = `${daemon}=${enabled ? 'yes' : 'no'}`;
  const re = new RegExp(`^${daemon}=.*`, 'm');
  return re.test(content) ? content.replace(re, line) : `${content.trimEnd()}\n${line}\n`;
}

export interface FrrSourceBuildOptions {
  targetTag: string;
  // Real host path (not /proc/1/root-prefixed — the script runs on the host via nsenter)
  // containing a previous frr.conf/daemons/vtysh.conf to restore after install. Omit for a
  // fresh host with no prior config (the caller writes its own config afterward).
  restoreConfigFrom?: string;
  // Real host path where the pre-swap /usr/lib/frr + config snapshot is written, so a
  // failed install can be rolled back without depending on apt at all.
  snapshotDir: string;
  // Daemon names to force to yes/no in /etc/frr/daemons, applied once before the service
  // starts (avoids editing the file and restarting a second time). Daemon names not
  // mentioned are left as whatever the installed/restored daemons file already has.
  daemonOverrides?: Record<string, boolean>;
}

// Generates the full build script. Ordered to minimize the live-outage window: everything
// through a successful compile happens in an isolated build directory without touching the
// running FRR at all. Only "swapping" (after a successful compile) stops the service,
// snapshots the current binaries+config for rollback, and swaps in the new build.
export function buildFrrSourceScript(opts: FrrSourceBuildOptions): string {
  if (!isValidFrrTag(opts.targetTag)) {
    throw new Error(`Invalid FRR target tag: ${JSON.stringify(opts.targetTag)}`);
  }
  const tagDir = `frr-${opts.targetTag}`;
  const restoreFile = (name: string) => opts.restoreConfigFrom
    ? `if [ -f "${opts.restoreConfigFrom}/${name}" ]; then install -m 640 -o frr -g frr "${opts.restoreConfigFrom}/${name}" /etc/frr/${name}; fi`
    : '';
  const daemonNameRe = /^[a-z][a-z0-9_]*$/;
  const daemonOverrideLines = Object.entries(opts.daemonOverrides ?? {})
    .filter(([name]) => {
      if (!daemonNameRe.test(name)) throw new Error(`Invalid daemon name in override: ${JSON.stringify(name)}`);
      return true;
    })
    .map(([name, enabled]) => `set_daemon "${name}" "${enabled ? 'yes' : 'no'}"`)
    .join('\n');

  return `#!/bin/bash
set -e
export DEBIAN_FRONTEND=noninteractive

# Heartbeat: some phases (clone, configure) can go quiet for a while with no output at all,
# which reads as "stuck" from a live log viewer even though it's working — emit a periodic
# line during those phases so it's always visible that the build is still alive.
start_heartbeat() {
  ( while true; do sleep 15; echo "... still working (\${SECONDS}s in this phase)"; done ) &
  echo $! > /tmp/frr-build-heartbeat.pid
}
stop_heartbeat() {
  if [ -f /tmp/frr-build-heartbeat.pid ]; then
    kill "$(cat /tmp/frr-build-heartbeat.pid)" 2>/dev/null || true
    rm -f /tmp/frr-build-heartbeat.pid
  fi
}
trap stop_heartbeat EXIT

echo "==STEP:preparing=="
avail_kb=$(df -Pk /opt | tail -1 | awk '{print $4}')
if [ "$avail_kb" -lt 3000000 ]; then
  echo "ERROR: less than ~3GB free under /opt (have: ${'$'}{avail_kb}KB) — aborting before a long build fills the disk."
  exit 1
fi
apt-get update -qq
apt-get install -y \\
  git autoconf automake libtool make libreadline-dev texinfo \\
  pkg-config libpam0g-dev libjson-c-dev bison flex \\
  libc-ares-dev python3-dev python3-sphinx \\
  install-info build-essential libsnmp-dev perl \\
  libcap-dev libelf-dev libunwind-dev \\
  protobuf-c-compiler libprotobuf-c-dev cmake

echo "==STEP:building_libyang=="
mkdir -p ${BUILD_WORKDIR}
LIBYANG_MARKER="${BUILD_WORKDIR}/.libyang-${LIBYANG_TAG}-installed"
if [ -f "$LIBYANG_MARKER" ]; then
  echo "libyang ${LIBYANG_TAG} already built — skipping."
else
  cd ${BUILD_WORKDIR}
  rm -rf libyang
  start_heartbeat
  git clone --branch ${LIBYANG_TAG} --depth 1 https://github.com/CESNET/libyang.git
  stop_heartbeat
  cd libyang
  mkdir -p build && cd build
  cmake --install-prefix /usr -D CMAKE_BUILD_TYPE:String="Release" ..
  make -j"$(nproc)"
  make install
  ldconfig
  touch "$LIBYANG_MARKER"
fi

echo "==STEP:building_frr=="
cd ${BUILD_WORKDIR}
rm -rf ${tagDir}
start_heartbeat
git clone --branch ${opts.targetTag} --depth 1 https://github.com/FRRouting/frr.git ${tagDir}
stop_heartbeat
cd ${tagDir}

./bootstrap.sh
start_heartbeat
./configure \\
    --prefix=/usr \\
    --includedir=\\\${prefix}/include \\
    --bindir=\\\${prefix}/bin \\
    --sbindir=\\\${prefix}/lib/frr \\
    --libdir=\\\${prefix}/lib/frr \\
    --libexecdir=\\\${prefix}/lib/frr \\
    --sysconfdir=/etc \\
    --localstatedir=/var \\
    --with-moduledir=\\\${prefix}/lib/frr/modules \\
    --enable-configfile-mask=0640 \\
    --enable-logfile-mask=0640 \\
    --enable-snmp \\
    --enable-multipath=64 \\
    --enable-user=frr \\
    --enable-group=frr \\
    --enable-vty-group=frrvty \\
    --with-pkg-git-version \\
    --with-pkg-extra-version=-open5gsnms1
stop_heartbeat
make -j"$(nproc)"

# ─── Everything above this line is isolated in the build directory — the live FRR ───
# ─── install has NOT been touched yet. If anything failed, nothing has happened.  ───

echo "==STEP:swapping=="
SNAPSHOT_DIR="${opts.snapshotDir}"
mkdir -p "$SNAPSHOT_DIR"
if [ -d /usr/lib/frr ]; then cp -a /usr/lib/frr "$SNAPSHOT_DIR/usr-lib-frr"; fi
for f in frr.conf daemons vtysh.conf; do
  if [ -f "/etc/frr/$f" ]; then cp -a "/etc/frr/$f" "$SNAPSHOT_DIR/$f"; fi
done
touch "$SNAPSHOT_DIR/.snapshot-complete"

systemctl stop frr || true
apt-get purge -y frr frr-pythontools || true

make install

install -m 775 -o frr -g frr -d /var/log/frr
install -m 775 -o frr -g frrvty -d /etc/frr
getent group frr >/dev/null || groupadd -r -g 92 frr
getent group frrvty >/dev/null || groupadd -r -g 85 frrvty
id frr >/dev/null 2>&1 || adduser --system --ingroup frr --home /var/run/frr/ \\
  --gecos "FRR suite" --shell /sbin/nologin frr
usermod -a -G frrvty frr

install -m 640 -o frr -g frrvty tools/etc/frr/vtysh.conf /etc/frr/vtysh.conf
install -m 640 -o frr -g frr tools/etc/frr/frr.conf /etc/frr/frr.conf
install -m 640 -o frr -g frr tools/etc/frr/daemons.conf /etc/frr/daemons.conf
install -m 640 -o frr -g frr tools/etc/frr/daemons /etc/frr/daemons
install -m 640 -o frr -g frr tools/etc/frr/support_bundle_commands.conf /etc/frr/support_bundle_commands.conf
install -m 644 tools/frr.service /etc/systemd/system/frr.service

${restoreFile('frr.conf')}
${restoreFile('vtysh.conf')}
${restoreFile('daemons')}

set_daemon() {
  if grep -q "^$1=" /etc/frr/daemons; then
    sed -i "s/^$1=.*/$1=$2/" /etc/frr/daemons
  else
    echo "$1=$2" >> /etc/frr/daemons
  fi
}
${daemonOverrideLines}
chown frr:frr /etc/frr/daemons /etc/frr/frr.conf
chown frr:frrvty /etc/frr/vtysh.conf

grep -q '^net.ipv4.ip_forward=1' /etc/sysctl.conf || echo 'net.ipv4.ip_forward=1' >> /etc/sysctl.conf
sysctl -p >/dev/null 2>&1 || true

echo "==STEP:starting_service=="
systemctl daemon-reload
systemctl enable frr
systemctl start frr
sleep 3

echo "==STEP:verifying=="
systemctl is-active frr
vtysh -c "show version"
vtysh -c "show ip eigrp neighbors" || true

echo "==STEP:done=="
`;
}

// Restore FRR to a previous working state from a snapshot taken during the "swapping" step
// of a prior build — no apt dependency, this is now the only rollback mechanism. No-ops
// safely if the snapshot never completed (i.e. the failed build never reached "swapping",
// meaning the previously-running FRR was never touched in the first place).
export async function restoreFrrFromSnapshot(snapshotDir: string): Promise<{ restored: boolean }> {
  const { stdout: markerCheck } = await nsenter('bash', [
    '-c', `[ -f "${snapshotDir}/.snapshot-complete" ] && echo yes || echo no`,
  ]);
  if (markerCheck.trim() !== 'yes') {
    return { restored: false };
  }

  const script = `
set -e
systemctl stop frr || true
if [ -d "${snapshotDir}/usr-lib-frr" ]; then
  rm -rf /usr/lib/frr
  cp -a "${snapshotDir}/usr-lib-frr" /usr/lib/frr
fi
for f in frr.conf daemons vtysh.conf; do
  if [ -f "${snapshotDir}/$f" ]; then install -m 640 -o frr -g frr "${snapshotDir}/$f" "/etc/frr/$f"; fi
done
systemctl daemon-reload
systemctl enable frr
systemctl restart frr
`;
  await nsenter('bash', ['-c', script], 60000);
  return { restored: true };
}

// Real post-build check — asks the host directly whether the service is up and whether
// EIGRP re-formed its adjacency, rather than scraping build-log text.
export async function verifyFrr(): Promise<{ active: boolean; neighborUp: boolean }> {
  let active = false;
  let neighborUp = false;
  try {
    const { stdout } = await nsenter('systemctl', ['is-active', 'frr']);
    active = stdout.trim() === 'active';
  } catch {}
  if (active) {
    try {
      const { stdout } = await nsenter('vtysh', ['-c', 'show ip eigrp neighbors']);
      neighborUp = parseEigrpNeighbors(stdout).length > 0;
    } catch {}
  }
  return { active, neighborUp };
}
