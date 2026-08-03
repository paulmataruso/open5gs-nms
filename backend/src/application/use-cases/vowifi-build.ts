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
export const VECTORCORE_PATCH_REV = 6;
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

# Open5GS SMF's S2b Create Session handling doesn't honor the GTPv2-C
# Indication IE HI hint (i.e. doesn't return the subscriber's real static IP)
# for a handover-flagged request — confirmed live 2026-08-02/08-03: every
# VoLTE<->VoWiFi handover-mode reconnect got a fresh, mismatched dynamic PAA
# instead of the requested one, and the real UE (iPhone) appears to reject
# that mismatch and retry, producing an endless reconnect churn that never
# let VoWiFi settle into a stable, usable state. Until Open5GS SMF's side of
# this is fixed, force every ePDG attach through the plain (non-handover)
# path by never letting sa.handoverIP get set — costs real VoLTE<->VoWiFi IP
# continuity on a genuine handover, but that path was already broken (worse:
# it broke every attach, not just true handovers).
grep -q 'sa.handoverIP = ip' internal/ikev2/auth.go || { echo "ERROR: auth.go patch site (handoverIP assignment) not found — upstream source may have changed, review manually"; exit 1; }
sed -i 's/sa\.handoverIP = ip/\/\/ NMS patch: handoverIP intentionally never set, see vowifi-build.ts/' internal/ikev2/auth.go
grep -q 'NMS patch: handoverIP intentionally never set' internal/ikev2/auth.go || { echo "ERROR: handoverIP patch did not apply"; exit 1; }

# xfrm.LocalIPFor(remote.IP) derives the kernel XFRM SA's local address via
# an OS-routing-table trick (dial a connected UDP socket to the remote UE
# and read back whichever local address the OS happens to pick) instead of
# using the ePDG's own configured ListenAddr. On a host whose default route
# goes out a different interface than the ePDG's actual bind address
# (confirmed live 2026-08-03: ePDG listens on a dedicated dummy interface
# address, host default route is a separate real WAN interface), this
# silently anchors every kernel XFRM SA to the WRONG local address — IKE/
# NAT-T control-plane traffic still limped through (NAT-T tolerates exactly
# this kind of address mismatch), but the XDP/TC-BPF data-plane forwarding
# on the real configured interface never saw a single packet, since the SA
# the kernel actually installed didn't correspond to that interface at all.
grep -q 'localIP, _ := xfrm.LocalIPFor(remote.IP)' internal/ikev2/init.go || { echo "ERROR: init.go patch site (LocalIPFor call) not found — upstream source may have changed, review manually"; exit 1; }
sed -i 's/localIP, _ := xfrm\.LocalIPFor(remote\.IP)/localIP := net.ParseIP(s.cfg.ListenAddr); if localIP == nil { localIP, _ = xfrm.LocalIPFor(remote.IP) }/' internal/ikev2/init.go
grep -q 'localIP := net.ParseIP(s.cfg.ListenAddr)' internal/ikev2/init.go || { echo "ERROR: LocalIPFor patch did not apply"; exit 1; }

# NATTSrcPort was hardcoded to the nattPort constant (4500), assuming NAT-T
# detection always means the exchange migrated to port 4500 on both sides
# per RFC 7296. Confirmed live 2026-08-03: a real UE stayed on port 500 for
# its entire IKE exchange despite NAT being detected — the kernel XFRM SA's
# NAT-T encap was then configured expecting port 4500, which never matched
# any real packet, so 100% of inbound ESP traffic was silently rejected
# (kernel's XfrmInStateMismatch counter) before the TC-BPF uplink program
# ever saw a single packet — a real, measured, total data-plane outage.
# Use the real local port the exchange is actually happening on instead.
grep -q 'NATTSrcPort:  nattPort,' internal/ikev2/auth.go || { echo "ERROR: auth.go patch site (NATTSrcPort) not found — upstream source may have changed, review manually"; exit 1; }
sed -i 's/NATTSrcPort:  nattPort,/NATTSrcPort:  conn.LocalAddr().(*net.UDPAddr).Port,/' internal/ikev2/auth.go
grep -q 'NATTSrcPort:  conn.LocalAddr().(\*net.UDPAddr).Port,' internal/ikev2/auth.go || { echo "ERROR: NATTSrcPort patch did not apply"; exit 1; }

# detectNAT() was called with the just-generated *responder* SPI (spiR) to
# validate the NAT_DETECTION_SOURCE_IP notify carried in the IKE_SA_INIT
# REQUEST. Per RFC 7296 SS2.23, the initiator computes that hash using the
# SPIs "as they appear in the header of the message containing the notify"
# — and in the IKE_SA_INIT REQUEST, SPI_r is always 0 (the initiator has no
# way to know our SPI yet). Comparing against the real random spiR instead
# of 0 meant the hash could never match, so NAT was "detected" on literally
# every session, 100% deterministically (confirmed live 2026-08-03: every
# session logged natt:true regardless of actual network path). This forced
# every kernel XFRM SA into NAT-T/UDP-encap (espinudp) mode even for a real
# UE on a non-NATed path that correctly sent plain ESP (IP proto 50, no UDP
# wrapper) — a guaranteed SA/packet-format mismatch (kernel
# XfrmInStateMismatch) that silently dropped 100% of real inbound ESP
# traffic before it ever reached the XDP/TC-BPF forwarding programs.
grep -q 'natDetected = detectNAT(notifyPayloads, remote, spiI, spiR)' internal/ikev2/init.go || { echo "ERROR: init.go patch site (detectNAT spiR arg) not found — upstream source may have changed, review manually"; exit 1; }
sed -i 's/natDetected = detectNAT(notifyPayloads, remote, spiI, spiR)/natDetected = detectNAT(notifyPayloads, remote, spiI, 0)/' internal/ikev2/init.go
grep -q 'natDetected = detectNAT(notifyPayloads, remote, spiI, 0)' internal/ikev2/init.go || { echo "ERROR: detectNAT spiR patch did not apply"; exit 1; }

stop_heartbeat

make install

cd ${BUILD_WORKDIR}

echo "==STEP:installing_vectorcore_aaa=="
rm -rf vectorcore-aaa
start_heartbeat
git clone https://github.com/vectorcore-mobile/vectorcore-aaa
cd vectorcore-aaa
git checkout ${VECTORCORE_AAA_COMMIT}

# Two real upstream bugs in aaa_ue_fsm.erl, found and originally fixed live
# 2026-08-01 but only ever applied to that session's running binary, never
# baked in here — confirmed regressed 2026-08-02 evening after a routine
# reinstall silently reverted to pristine unpatched upstream source, causing
# a 100%-reproducible "Re-synch MAC failed" HSS rejection on every single
# real-device auth attempt (root-caused via a packet capture + cross-referenced
# ePDG/AAA/HSS logs, not guessed). Both patches must keep landing here, not
# just on a live host, or every reinstall silently reintroduces both bugs.
grep -q 'PdpTypeNr, Authorization,' src/aaa_ue_fsm.erl || { echo "ERROR: aaa_ue_fsm.erl patch site (Authorization AVP) not found — upstream source may have changed, review manually"; exit 1; }
sed -i 's/PdpTypeNr, Authorization,/PdpTypeNr, [],/' src/aaa_ue_fsm.erl
grep -q 'PdpTypeNr, \[\],' src/aaa_ue_fsm.erl || { echo "ERROR: Authorization AVP patch did not apply"; exit 1; }

grep -q 'to_binary(ApnA) =:= to_binary(ApnB).' src/aaa_ue_fsm.erl || { echo "ERROR: aaa_ue_fsm.erl patch site (same_apn) not found — upstream source may have changed, review manually"; exit 1; }
sed -i 's/to_binary(ApnA) =:= to_binary(ApnB)\./string:lowercase(to_binary(ApnA)) =:= string:lowercase(to_binary(ApnB))./' src/aaa_ue_fsm.erl
grep -q 'string:lowercase(to_binary(ApnA)) =:= string:lowercase(to_binary(ApnB))\.' src/aaa_ue_fsm.erl || { echo "ERROR: same_apn patch did not apply"; exit 1; }

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
