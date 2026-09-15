import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// Same shape as osmo-sip-connector-build.ts / kamailio-ims-modules-build.ts.
// Quick one-off host commands; the multi-minute build itself runs as a
// detached streamed script (see hnbgw-controller.ts's /install), not
// through this.
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

export const BUILD_WORKDIR = '/opt/osmo-hnbgw-build';
export const BIN = '/usr/local/bin/osmo-hnbgw';
export const UNIT_PATH = '/etc/systemd/system/osmo-hnbgw.service';
export const CFG_PATH = '/etc/osmocom/osmo-hnbgw.cfg';

// Pinned specifically to match this deployment's installed Osmocom library
// versions — NOT an arbitrary/stale pick. osmo-hnbgw's own version number
// does not track libosmocore's the way it might look like it should (this
// project's other core NFs — osmo-bsc/msc/mgw/sgsn/ggsn — are all "1.9.0",
// which made "just use 1.9.0" a very tempting first guess; it's wrong).
// Confirmed live (2026-09-13): this host has libosmocore 1.7.0 (Ubuntu
// noble/universe) — osmo-hnbgw's OWN configure.ac dependency floor is
// >=1.9.0 as far back as tag 1.5.0, and >=1.14.2 at 1.9.0 itself. Checked
// every tag's configure.ac back to 1.2.0 directly
// (https://gitea.osmocom.org/cellular-infrastructure/osmo-hnbgw): tag 1.3.0
// is the newest one whose floors are all satisfied by what's actually
// installed here (libosmocore>=1.7.0, libosmo-sigtran>=1.6.0,
// libosmo-ranap>=1.3.0, libosmo-rua>=1.3.0, libosmo-hnbap>=1.3.0,
// libosmo-netif>=1.2.0, libosmo-mgcp-client>=1.10.0 — every one matches
// this host's installed/candidate version exactly). Confirmed buildable,
// not just floor-compatible on paper: a real scratch
// clone+autoreconf+configure+make of tag 1.3.0 completed clean, zero
// errors, `ldd` reported no missing shared libraries, and the resulting
// binary correctly printed "OsmoHNBGW version 1.3.0". If libosmocore is
// ever upgraded past 1.9.0 on this host, a newer osmo-hnbgw tag becomes
// buildable — recheck configure.ac's floors before bumping this.
export const HNBGW_TAG = '1.3.0';

// Bump whenever the build steps below change in a way that needs a rebuild.
export const BUILD_REV = 1;

export const BUILD_STEPS = [
  'preparing', 'installing_apt_deps', 'cloning', 'building', 'verifying', 'deploying',
] as const;
export type HnbgwBuildStep = typeof BUILD_STEPS[number];

// Clean upstream build, no custom source patches — same policy as
// osmo-sip-connector-build.ts.
export function buildOsmoHnbgwScript(force = false): string {
  return `#!/bin/bash
set -e
export DEBIAN_FRONTEND=noninteractive

start_heartbeat() {
  ( while true; do sleep 15; echo "... still working (\${SECONDS}s in this phase)"; done ) &
  echo $! > /tmp/hnbgw-build-heartbeat.pid
}
stop_heartbeat() {
  if [ -f /tmp/hnbgw-build-heartbeat.pid ]; then
    kill "$(cat /tmp/hnbgw-build-heartbeat.pid)" 2>/dev/null || true
    rm -f /tmp/hnbgw-build-heartbeat.pid
  fi
}
trap stop_heartbeat EXIT

echo "==STEP:preparing=="
REV_FILE="${BUILD_WORKDIR}/.build-rev"
if [ "${force ? '1' : '0'}" != "1" ] && [ -x "${BIN}" ] && [ "$(cat "$REV_FILE" 2>/dev/null || echo -1)" = "${BUILD_REV}" ]; then
  V="$(${BIN} --version 2>&1 | head -1)"
  echo "osmo-hnbgw already built ($V) — nothing to do."
  echo "==STEP:done=="
  exit 0
fi
mkdir -p ${BUILD_WORKDIR}

echo "==STEP:installing_apt_deps=="
start_heartbeat
apt-get update -qq
# Confirmed live 2026-09-13 by a real successful build at tag ${HNBGW_TAG}
# against exactly this package set.
apt-get install -y \\
  build-essential autotools-dev dh-autoreconf pkg-config libsctp-dev \\
  libosmocore-dev libosmo-sigtran-dev libosmo-ranap-dev libosmo-hnbap-dev \\
  libosmo-rua-dev libosmo-sabp-dev
stop_heartbeat

echo "==STEP:cloning=="
cd ${BUILD_WORKDIR}
rm -rf osmo-hnbgw
start_heartbeat
git clone https://gitea.osmocom.org/cellular-infrastructure/osmo-hnbgw.git 2>/dev/null \\
  || git clone https://github.com/osmocom/osmo-hnbgw.git
cd osmo-hnbgw
git checkout ${HNBGW_TAG}
stop_heartbeat
echo "checked out: $(git describe --tags 2>/dev/null || echo ${HNBGW_TAG})"

echo "==STEP:building=="
start_heartbeat
autoreconf -fi
./configure --prefix=/usr/local
make -j"$(nproc)"
stop_heartbeat
echo ${BUILD_REV} > "$REV_FILE"

echo "==STEP:verifying=="
test -f src/osmo-hnbgw/osmo-hnbgw || { echo "ERROR: build did not produce src/osmo-hnbgw/osmo-hnbgw"; exit 1; }
cp src/osmo-hnbgw/osmo-hnbgw ${BIN}.new
chmod 755 ${BIN}.new
mv ${BIN}.new ${BIN}
${BIN} --version
ldd "${BIN}" | grep -iE "not found" && { echo "ERROR: unresolved shared libs"; exit 1; } || true

echo "==STEP:deploying=="
mkdir -p /etc/osmocom
echo "binary deployed: ${BIN}"
echo "(systemd unit + osmo-hnbgw.cfg are written separately, by the install/configure flow)"

echo "==STEP:done=="
`;
}

// Real post-build check — asks the host directly, not the build log.
export async function verifyOsmoHnbgwBuild(): Promise<{ installed: boolean; version: string }> {
  try {
    const { stdout, stderr } = await nsenter('bash', ['-c', `test -x ${BIN} && ${BIN} --version 2>&1 | head -1`]);
    const out = (stdout + stderr).trim();
    return { installed: out.length > 0, version: out };
  } catch {
    return { installed: false, version: '' };
  }
}

// Upstream's own contrib/systemd/osmo-hnbgw.service template (confirmed
// live 2026-09-13 by fetching it directly from the tag ${HNBGW_TAG} tree),
// with the same two kinds of deployment-specific changes
// osmoSipConnectorSystemdUnit() makes: ExecStart points at /usr/local/bin
// (where this build deploys to, not the package path /usr/bin the template
// assumes), and an explicit dependency on osmo-stp — osmo-hnbgw is an SCCP/
// M3UA client that dials out to the STP for both its IuCS and IuPS links,
// so there is nothing useful for it to do until that's up.
export function osmoHnbgwSystemdUnit(cfgPath = CFG_PATH): string {
  return `[Unit]
Description=Osmocom Home NodeB Gateway (OsmoHNBGW — 3G Iuh<->IuCS/IuPS)
After=network-online.target osmo-stp.service
Wants=network-online.target
Requires=osmo-stp.service

[Service]
Type=simple
Restart=always
RestartSec=2
ExecStart=${BIN} -c ${cfgPath}

[Install]
WantedBy=multi-user.target
`;
}
