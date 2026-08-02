import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// Quick one-off host commands. The actual multi-minute build itself runs as a separate
// detached script (see vowifi-controller.ts), not through this — same split as
// frr-source-build.ts and the archived osmo-epdg build this replaces.
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

export const BUILD_WORKDIR = '/opt/vectorcore-build';
// Neither vectorcore-ePDG nor vectorcore-aaa had a tagged release at the time this was
// written (checked live via the GitHub tags API — both empty) — pinned to the exact
// commit SHA of `main` at research time instead, matching the exact fallback this
// project's own OSMO_EPDG_TAG precedent anticipated for this situation. Promote to a
// real tag (and rename these to reflect that) the first time either project cuts one.
export const VECTORCORE_EPDG_COMMIT = '1fa032c33c95dbed748cd8d4edd18c9328a00893';
export const VECTORCORE_AAA_COMMIT = '7dc609ef5a2128596be5cd692ec08648b159f21b';
// Bumped whenever a new local source patch is added below, independent of the two
// commit pins above — same purpose as the archived osmo-epdg build's
// OSMO_EPDG_PATCH_REV: lets vowifi-controller.ts's buildStale check detect "same
// upstream commit, but an older deployment is missing a since-added local patch"
// without forcing a reinstall for unrelated version bumps.
export const VECTORCORE_PATCH_REV = 1;
export const RUNTIME_BIN_DIR = '/opt/vectorcore';
export const VECTORCORE_EPDG_CONFIG_DIR = '/etc/vectorcore/epdg';
export const VECTORCORE_AAA_CONFIG_DIR = '/etc/vectorcore/aaa';

export const VOWIFI_BUILD_STEPS = [
  'preparing', 'installing_apt_deps', 'installing_vectorcore_epdg', 'installing_vectorcore_aaa', 'verifying',
] as const;
export type VowifiBuildStep = typeof VOWIFI_BUILD_STEPS[number];

// Builds both components from source and installs them to their vendor-documented
// runtime layout (/opt/vectorcore/{epdg,aaa}/bin/..., matching each project's own
// `make install`/Makefile convention exactly — no adaptation needed, confirmed by
// reading both Makefiles directly). Config generation itself (epdg.yaml, aaa.config,
// certs) is a separate step, done by configureVowifi() in vowifi-controller.ts, not
// here — same split the archived osmo-epdg build used (build produces binaries +
// the pristine example config as a template; Configure patches that template).
export function buildVowifiScript(): string {
  return `#!/bin/bash
set -e
echo "==STEP:preparing=="
mkdir -p ${BUILD_WORKDIR}
cd ${BUILD_WORKDIR}

start_heartbeat() {
  ( while true; do echo "==HEARTBEAT:$(date +%s)=="; sleep 15; done ) &
  HEARTBEAT_PID=$!
}
stop_heartbeat() {
  kill "$HEARTBEAT_PID" 2>/dev/null || true
}

echo "==STEP:installing_apt_deps=="
# clang/llvm/libbpf-dev: BPF program compilation for vectorcore-ePDG's XDP/TC dataplane
# (make generate). erlang/rebar3: already an existing apt dependency from the archived
# osmo-epdg build — installed here too since that build is no longer guaranteed to have
# run on this host, and vectorcore-aaa (Erlang, forked from the same osmo-epdg AAA
# lineage) needs the exact same toolchain.
start_heartbeat
DEBIAN_FRONTEND=noninteractive apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y clang llvm libbpf-dev erlang rebar3 git golang-go 2>&1
stop_heartbeat

echo "==STEP:installing_vectorcore_epdg=="
rm -rf vectorcore-ePDG
start_heartbeat
git clone https://github.com/vectorcore-mobile/vectorcore-ePDG
cd vectorcore-ePDG
git checkout ${VECTORCORE_EPDG_COMMIT}
stop_heartbeat

make install

cd ${BUILD_WORKDIR}

echo "==STEP:installing_vectorcore_aaa=="
rm -rf vectorcore-aaa
start_heartbeat
git clone https://github.com/vectorcore-mobile/vectorcore-aaa
cd vectorcore-aaa
git checkout ${VECTORCORE_AAA_COMMIT}
make build
stop_heartbeat

mkdir -p ${RUNTIME_BIN_DIR}/aaa/bin
install -m 0755 _build/default/bin/vectorcore-aaa ${RUNTIME_BIN_DIR}/aaa/bin/vectorcore-aaa
mkdir -p ${VECTORCORE_AAA_CONFIG_DIR}
mkdir -p /var/log/vectorcore/aaa

echo "==STEP:verifying=="
test -x ${RUNTIME_BIN_DIR}/epdg/bin/epdg
test -x ${RUNTIME_BIN_DIR}/aaa/bin/vectorcore-aaa
echo "==STEP:done=="
`;
}
