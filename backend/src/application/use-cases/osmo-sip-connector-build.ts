import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// Same shape as osmo-msc-build.ts / kamailio-ims-modules-build.ts. Quick
// one-off host commands; the multi-minute build itself runs as a detached
// streamed script (see gsm-controller.ts's /install), not through this.
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

export const BUILD_WORKDIR = '/opt/osmo-sip-connector-build';
export const BIN = '/usr/local/bin/osmo-sip-connector';
export const UNIT_PATH = '/etc/systemd/system/osmo-sip-connector.service';
export const CFG_PATH = '/etc/osmocom/osmo-sip-connector.cfg';
// Matches osmo-msc.cfg's own `mncc external <path>` line exactly (confirmed
// live 2026-09-12) — this is fixed by that config, not something SIP-side
// configuration has any say over.
export const MNCC_SOCKET_PATH = '/tmp/osmo-msc-mncc.sock';

// Pinned specifically to match this deployment's installed libosmocore-dev
// (confirmed live 2026-09-12: 1.7.0-3.1build2, via `dpkg -s libosmocore-dev`).
// This is NOT an arbitrary/stale pick — osmo-sip-connector's own
// debian/control Build-Depends raises its libosmocore-dev floor on almost
// every release: 1.6.1 needs >=1.5.0, 1.6.2 needs >=1.8.0, 1.6.3 needs
// >=1.9.0, every 1.7.x needs >=1.10.0 (all confirmed live by fetching each
// tag's debian/control directly). 1.6.1 is the NEWEST tag this host can
// actually build against. If libosmocore-dev is ever upgraded past 1.9.0
// here, a newer tag becomes buildable — check upstream's debian/control
// (https://gitea.osmocom.org/cellular-infrastructure/osmo-sip-connector)
// before bumping this.
export const SIPCONN_TAG = '1.6.1';

// Bump whenever the build steps below change in a way that needs a rebuild.
export const BUILD_REV = 3;

export const BUILD_STEPS = [
  'preparing', 'installing_apt_deps', 'cloning', 'patching', 'building', 'verifying', 'deploying',
] as const;
export type SipConnBuildStep = typeof BUILD_STEPS[number];

// Otherwise a clean upstream build — an earlier version of this module
// carried hand-written C patches to sdp.c (payload-type echo + AMR
// octet-align) chasing 2G<->IMS voice-interop audio bugs; both were reverted
// (regressions, never confirmed fixed) along with the whole voice-interop
// routing direction on 2026-09-12. Wiring this daemon into any specific
// call-routing scheme is still left to whoever configures the "remote" SIP
// target (see osmoSipConnectorCfg() below), not baked in here.
//
// The ONE patch this build DOES carry (BUILD_REV 2, added 2026-09-21) is
// unrelated to routing/audio-codec content — it's a real, confirmed-live
// signaling-timeout bug: mncc.c's start_cmd_timer() hardcodes a 5s window
// for every "wait for the next expected MNCC message" case it's used for,
// including MNCC_SETUP_COMPL_IND — the *originating* leg's own confirmation
// that its UE received CONNECT and sent back CONNECT ACKNOWLEDGE, after the
// callee has already answered. That's a real over-the-air round trip
// (UE<->BTS<->BSC<->MSC), and 5s isn't consistently enough for it under
// normal GSM scheduling/retransmission timing — confirmed live 2026-09-21
// via a full capture session: the exact same caller/callee pair on a native
// 2G-to-2G short-code call succeeded on one attempt and failed the next,
// every failure showing this exact timer expiring
// (`command(0x106) never arrived for leg(...)`) moments after both legs had
// already been marked connected, tearing down a call that was otherwise
// completely healthy. SIPCONN_SETUP_COMPL_TIMEOUT_PATCH below widens ONLY
// that one call site via a new start_cmd_timer_t() helper — every other
// start_cmd_timer() caller (RTP_CREATE, REL_CNF, REL_IND) keeps the original
// 5s, deliberately not touched since they weren't implicated.
//
// BUILD_REV 3 (2026-09-26): widened again, 15s -> 30s. A real 19-call mixed
// 2G/4G/5G/PSTN test session the same day reproduced this exact timer firing
// on 3 separate calls even at 15s (`command(0x106) never arrived for
// leg(...)`, same signature as the original 2026-09-21 find) — 15s was a
// real improvement over the stock 5s but still evidently insufficient under
// this deployment's real over-the-air conditions. This is explicitly a
// stopgap, not a resolved root cause: whether the underlying MNCC_SETUP_
// COMPL_IND message is genuinely just slow, or is being lost/delayed by
// something else entirely (worth checking against a fresh capture with
// Asterisk verbose logging enabled — see gsm-controller.ts/pstn-controller.ts
// logger.conf notes), is still an open question. If 30s still isn't enough,
// don't just widen a third time without checking that first.
const SIPCONN_SETUP_COMPL_TIMEOUT_PATCH = `import re, sys
path = 'src/mncc.c'
src = open(path).read()

old_fn = '''static void start_cmd_timer(struct mncc_call_leg *leg, uint32_t expected_next)
{
	leg->rsp_wanted = expected_next;

	leg->cmd_timeout.cb = cmd_timeout;
	leg->cmd_timeout.data = leg;
	LOGP(DMNCC, LOGL_DEBUG, "Starting Timer for %s\\\\n", osmo_mncc_name(expected_next));
	osmo_timer_schedule(&leg->cmd_timeout, 5, 0);
}'''
new_fn = '''static void start_cmd_timer_t(struct mncc_call_leg *leg, uint32_t expected_next, int timeout_secs)
{
	leg->rsp_wanted = expected_next;

	leg->cmd_timeout.cb = cmd_timeout;
	leg->cmd_timeout.data = leg;
	LOGP(DMNCC, LOGL_DEBUG, "Starting Timer for %s (%ds)\\\\n", osmo_mncc_name(expected_next), timeout_secs);
	osmo_timer_schedule(&leg->cmd_timeout, timeout_secs, 0);
}

static void start_cmd_timer(struct mncc_call_leg *leg, uint32_t expected_next)
{
	start_cmd_timer_t(leg, expected_next, 5);
}'''
if old_fn not in src:
    print('PATCH FAILED: start_cmd_timer() body not found verbatim -- upstream source shape changed', file=sys.stderr)
    sys.exit(1)
src = src.replace(old_fn, new_fn, 1)

old_call = '''	start_cmd_timer(leg, MNCC_SETUP_COMPL_IND);
	mncc_send(leg->conn, MNCC_SETUP_RSP, leg->callref);'''
new_call = '''	/* Real over-the-air CONNECT -> CONNECT ACKNOWLEDGE round trip
	 * (UE<->BTS<->BSC<->MSC) routinely needs more than the default 5s under
	 * normal GSM scheduling/retransmission timing. Confirmed live 2026-09-21:
	 * intermittent call failures here, the exact same caller/callee pair
	 * sometimes succeeding and sometimes not, every failure showing this
	 * timer expiring on the originating leg moments after the callee had
	 * already answered (both legs briefly marked connected, then torn down
	 * from underneath). Widened to 15s, then to 30s on 2026-09-26 after a
	 * real mixed-RAN test session reproduced the same failure 3 times even
	 * at 15s. Other start_cmd_timer() call sites (RTP_CREATE, REL_CNF,
	 * REL_IND) are untouched at the original 5s. */
	start_cmd_timer_t(leg, MNCC_SETUP_COMPL_IND, 30);
	mncc_send(leg->conn, MNCC_SETUP_RSP, leg->callref);'''
if old_call not in src:
    print('PATCH FAILED: MNCC_SETUP_COMPL_IND call site not found verbatim -- upstream source shape changed', file=sys.stderr)
    sys.exit(1)
src = src.replace(old_call, new_call, 1)

open(path, 'w').write(src)
print('mncc.c: MNCC_SETUP_COMPL_IND timer widened 5s -> 30s')
`;
export function buildOsmoSipConnectorScript(force = false): string {
  return `#!/bin/bash
set -e
export DEBIAN_FRONTEND=noninteractive

start_heartbeat() {
  ( while true; do sleep 15; echo "... still working (\${SECONDS}s in this phase)"; done ) &
  echo $! > /tmp/sipconn-build-heartbeat.pid
}
stop_heartbeat() {
  if [ -f /tmp/sipconn-build-heartbeat.pid ]; then
    kill "$(cat /tmp/sipconn-build-heartbeat.pid)" 2>/dev/null || true
    rm -f /tmp/sipconn-build-heartbeat.pid
  fi
}
trap stop_heartbeat EXIT

echo "==STEP:preparing=="
REV_FILE="${BUILD_WORKDIR}/.build-rev"
if [ "${force ? '1' : '0'}" != "1" ] && [ -x "${BIN}" ] && [ "$(cat "$REV_FILE" 2>/dev/null || echo -1)" = "${BUILD_REV}" ]; then
  V="$(${BIN} --version 2>&1 | head -1)"
  echo "osmo-sip-connector already built ($V) — nothing to do."
  echo "==STEP:done=="
  exit 0
fi
mkdir -p ${BUILD_WORKDIR}

# Clean up stray, unowned leftovers from an old ad-hoc "make install" (found
# live 2026-09-12: a systemd unit at /usr/lib/systemd/system pointing at a
# nonexistent /usr/bin/osmo-sip-connector, plus doc/example files under
# /usr/local/share/doc — dpkg -S confirms neither is tracked by any package).
# Harmless to remove; this build writes its own unit at ${UNIT_PATH} instead.
rm -f /usr/lib/systemd/system/osmo-sip-connector.service
rm -rf /usr/local/share/doc/osmo-sip-connector

echo "==STEP:installing_apt_deps=="
start_heartbeat
apt-get update -qq
# Confirmed live 2026-09-12 directly from osmo-sip-connector's own
# debian/control Build-Depends at tag ${SIPCONN_TAG}.
apt-get install -y \\
  build-essential autotools-dev dh-autoreconf pkg-config \\
  libsofia-sip-ua-dev libsofia-sip-ua-glib-dev libosmocore-dev
stop_heartbeat

echo "==STEP:cloning=="
cd ${BUILD_WORKDIR}
rm -rf osmo-sip-connector
start_heartbeat
git clone https://gitea.osmocom.org/cellular-infrastructure/osmo-sip-connector.git 2>/dev/null \\
  || git clone https://github.com/osmocom/osmo-sip-connector.git
cd osmo-sip-connector
git checkout ${SIPCONN_TAG}
stop_heartbeat
echo "checked out: $(git describe --tags 2>/dev/null || echo ${SIPCONN_TAG})"

echo "==STEP:patching=="
cat > /tmp/sipconn-timeout-patch.py << 'PYEOF'
${SIPCONN_SETUP_COMPL_TIMEOUT_PATCH}
PYEOF
python3 /tmp/sipconn-timeout-patch.py
rm -f /tmp/sipconn-timeout-patch.py

echo "==STEP:building=="
start_heartbeat
autoreconf -fi
./configure --prefix=/usr/local
make -j"$(nproc)"
stop_heartbeat
echo ${BUILD_REV} > "$REV_FILE"

echo "==STEP:verifying=="
test -f src/osmo-sip-connector || { echo "ERROR: build did not produce src/osmo-sip-connector"; exit 1; }
cp src/osmo-sip-connector ${BIN}.new
chmod 755 ${BIN}.new
mv ${BIN}.new ${BIN}
${BIN} --version
ldd "${BIN}" | grep -iE "not found" && { echo "ERROR: unresolved shared libs"; exit 1; } || true

echo "==STEP:deploying=="
mkdir -p /etc/osmocom
echo "binary deployed: ${BIN}"
echo "(systemd unit + osmo-sip-connector.cfg are written separately, by /api/gsm/sip/configure)"

echo "==STEP:done=="
`;
}

// Real post-build check — asks the host directly, not the build log.
export async function verifyOsmoSipConnectorBuild(): Promise<{ installed: boolean; version: string }> {
  try {
    const { stdout, stderr } = await nsenter('bash', ['-c', `test -x ${BIN} && ${BIN} --version 2>&1 | head -1`]);
    const out = (stdout + stderr).trim();
    return { installed: out.length > 0, version: out };
  } catch {
    return { installed: false, version: '' };
  }
}

// Not a fresh invention — this is upstream's own contrib/systemd/
// osmo-sip-connector.service template (confirmed live 2026-09-12 by
// building tag 1.6.1 and reading it directly), with only two deployment-
// specific changes: ExecStart points at /usr/local/bin (where this build
// deploys to, not the package path /usr/bin the template assumes) and an
// explicit dependency on osmo-msc, since the MNCC socket it connects to only
// exists once osmo-msc is up.
export function osmoSipConnectorSystemdUnit(cfgPath = CFG_PATH): string {
  return `[Unit]
Description=Osmo SIP Connector (2G voice interop — MNCC to SIP bridge)
After=network-online.target osmo-msc.service
Wants=network-online.target
Requires=osmo-msc.service

[Service]
Type=simple
Restart=always
RestartSec=2
ExecStart=${BIN} -c ${cfgPath}

[Install]
WantedBy=multi-user.target
`;
}

// Matches upstream's own doc/examples/osmo-sip-connector.cfg shape exactly
// (confirmed live 2026-09-12 by building tag 1.6.1 and reading it directly)
// — this daemon's entire native config surface really is just these three
// settings: where osmo-msc's MNCC socket is, what local SIP address to
// listen on, and what single "remote" SIP peer to send/receive calls
// through. Deliberately does NOT encode any MSISDN-based routing, dial
// plan, or call-direction logic — per explicit 2026-09-12 product decision,
// there is no automatic 2G<->IMS call bridging in this module anymore;
// wiring "remote" to something that actually completes calls (this
// deployment's own P-CSCF/S-CSCF, an external SIP trunk, anything) is left
// entirely to whoever configures this tab.
export function osmoSipConnectorCfg(localIp: string, localPort: number, remoteHost: string, remotePort: number): string {
  return `log stderr
 logging color 0
 logging print category-hex 0
 logging print category 1
 logging timestamp 1
 logging print file basename last
 logging print level 1

app
mncc
 socket-path ${MNCC_SOCKET_PATH}
sip
 local ${localIp} ${localPort}
 remote ${remoteHost} ${remotePort}
`;
}
