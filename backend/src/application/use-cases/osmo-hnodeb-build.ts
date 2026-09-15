import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// Same shape as osmo-hnbgw-build.ts / osmo-sip-connector-build.ts.
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

export const BUILD_WORKDIR = '/opt/osmo-hnodeb-build';
export const BIN = '/usr/local/bin/osmo-hnodeb';
export const UNIT_PATH = '/etc/systemd/system/osmo-hnodeb.service';
export const CFG_PATH = '/etc/osmocom/osmo-hnodeb.cfg';

// OsmoHNodeB — Osmocom's own software/virtual 3G Home NodeB (L2 Uu + Iuh in
// software, no real RF). Direct parallel to osmo-bts-virtual's role in the
// 2G module: lets the whole HNBAP/RANAP/AKA signaling chain through
// OsmoHNBGW be proven before the real ip.access nano3G is ever touched.
// Tag pinned the same way HNBGW_TAG is (see osmo-hnbgw-build.ts's comment)
// — osmo-hnodeb's own configure.ac dependency floors were checked against
// every one of its 7 tags; 0.1.0 is the newest whose floors
// (libosmocore>=1.7.0, libosmo-sigtran>=1.6.0, libosmo-rua/ranap/hnbap
// >=1.3.0) are satisfied by this host's actual installed versions — every
// tag from 0.1.1 up needs libosmocore>=1.8.0 or higher. Confirmed
// buildable, not just floor-compatible on paper: a real scratch
// clone+autoreconf+configure+make of tag 0.1.0 completed clean, zero
// errors, `ldd` reported no missing shared libraries, and the resulting
// binary correctly printed "OsmoHNodeB version 0.1.0" (2026-09-13).
export const HNODEB_TAG = '0.1.0';

// Bump whenever the build steps below change in a way that needs a rebuild.
export const BUILD_REV = 1;

export const BUILD_STEPS = [
  'preparing', 'installing_apt_deps', 'cloning', 'building', 'verifying', 'deploying',
] as const;
export type HnodebBuildStep = typeof BUILD_STEPS[number];

export function buildOsmoHnodebScript(force = false): string {
  return `#!/bin/bash
set -e
export DEBIAN_FRONTEND=noninteractive

start_heartbeat() {
  ( while true; do sleep 15; echo "... still working (\${SECONDS}s in this phase)"; done ) &
  echo $! > /tmp/hnodeb-build-heartbeat.pid
}
stop_heartbeat() {
  if [ -f /tmp/hnodeb-build-heartbeat.pid ]; then
    kill "$(cat /tmp/hnodeb-build-heartbeat.pid)" 2>/dev/null || true
    rm -f /tmp/hnodeb-build-heartbeat.pid
  fi
}
trap stop_heartbeat EXIT

echo "==STEP:preparing=="
REV_FILE="${BUILD_WORKDIR}/.build-rev"
if [ "${force ? '1' : '0'}" != "1" ] && [ -x "${BIN}" ] && [ "$(cat "$REV_FILE" 2>/dev/null || echo -1)" = "${BUILD_REV}" ]; then
  V="$(${BIN} --version 2>&1 | head -1)"
  echo "osmo-hnodeb already built ($V) — nothing to do."
  echo "==STEP:done=="
  exit 0
fi
mkdir -p ${BUILD_WORKDIR}

echo "==STEP:installing_apt_deps=="
start_heartbeat
apt-get update -qq
# Same dependency set as osmo-hnbgw (shared upstream libs) — confirmed live
# 2026-09-13 by a real successful build at tag ${HNODEB_TAG}.
apt-get install -y \\
  build-essential autotools-dev dh-autoreconf pkg-config libsctp-dev \\
  libosmocore-dev libosmo-sigtran-dev libosmo-ranap-dev libosmo-hnbap-dev \\
  libosmo-rua-dev libosmo-sabp-dev
stop_heartbeat

echo "==STEP:cloning=="
cd ${BUILD_WORKDIR}
rm -rf osmo-hnodeb
start_heartbeat
git clone https://gitea.osmocom.org/cellular-infrastructure/osmo-hnodeb.git 2>/dev/null \\
  || git clone https://github.com/osmocom/osmo-hnodeb.git
cd osmo-hnodeb
git checkout ${HNODEB_TAG}
stop_heartbeat
echo "checked out: $(git describe --tags 2>/dev/null || echo ${HNODEB_TAG})"

echo "==STEP:building=="
start_heartbeat
autoreconf -fi
./configure --prefix=/usr/local
make -j"$(nproc)"
stop_heartbeat
echo ${BUILD_REV} > "$REV_FILE"

echo "==STEP:verifying=="
test -f src/osmo-hnodeb/osmo-hnodeb || { echo "ERROR: build did not produce src/osmo-hnodeb/osmo-hnodeb"; exit 1; }
cp src/osmo-hnodeb/osmo-hnodeb ${BIN}.new
chmod 755 ${BIN}.new
mv ${BIN}.new ${BIN}
${BIN} --version
ldd "${BIN}" | grep -iE "not found" && { echo "ERROR: unresolved shared libs"; exit 1; } || true

echo "==STEP:deploying=="
mkdir -p /etc/osmocom
echo "binary deployed: ${BIN}"

echo "==STEP:done=="
`;
}

export async function verifyOsmoHnodebBuild(): Promise<{ installed: boolean; version: string }> {
  try {
    const { stdout, stderr } = await nsenter('bash', ['-c', `test -x ${BIN} && ${BIN} --version 2>&1 | head -1`]);
    const out = (stdout + stderr).trim();
    return { installed: out.length > 0, version: out };
  } catch {
    return { installed: false, version: '' };
  }
}

// Upstream's own contrib/systemd/osmo-hnodeb.service template (confirmed
// live 2026-09-13 by fetching it directly from the tag ${HNODEB_TAG} tree),
// ExecStart repointed at /usr/local/bin to match where this build deploys.
export function osmoHnodebSystemdUnit(cfgPath = CFG_PATH): string {
  return `[Unit]
Description=OsmoHNodeB (virtual 3G Home NodeB — protocol testing only, no real RF)
After=network-online.target osmo-hnbgw.service
Wants=network-online.target
Requires=osmo-hnbgw.service

[Service]
Type=simple
Restart=always
RestartSec=2
ExecStart=${BIN} -c ${cfgPath}

[Install]
WantedBy=multi-user.target
`;
}

// Minimal config confirmed against this exact binary's own --vty-ref-xml
// (2026-09-13) — identity/PLMN/cell-identity/LAC at the hnodeb node, iuh
// remote-ip/remote-port pointing at OsmoHNBGW's own Iuh listener. No RF/Uu
// config exists in this version worth exposing — this is a signaling-only
// test tool. gtpLocalIp is NOT optional in practice — osmo-hnodeb's GTP-U
// bind (fixed port 2152) defaults to 0.0.0.0 and fatally collides with
// Open5GS's own UPF on this host if left unset; see HNODEB_GTP_LOCAL_IP's
// comment in hnbgw-controller.ts for the confirmed-live incident.
export function osmoHnodebCfg(mcc: string, mnc: string, iuhRemoteIp: string, iuhRemotePort: number, gtpLocalIp: string): string {
  // The VTY grammar here is a plain integer range (<1-999>/<0-999>), not a
  // zero-padded string — Number() strips e.g. mnc "01" down to 1, since
  // this project's own mcc/mnc source (readMccMnc()-style parsing of
  // mme.yaml) always returns the zero-padded form.
  const mccNum = Number(mcc);
  const mncNum = Number(mnc);
  return `log stderr
 logging filter all 1
 logging print category 1
line vty
 no login
hnodeb
 identity nms-virtual-hnb
 network country code ${mccNum}
 mobile network code ${mncNum}
 cell_identity 1
 location_area_code 1
 iuh
  remote-ip ${iuhRemoteIp}
  remote-port ${iuhRemotePort}
 gtp
  local-ip ${gtpLocalIp}
`;
}
