// Open5GS SMF Gx "wrong-peer" patch — builds a patched open5gs-smfd from
// source and installs it over the host's existing binary, matching whatever
// commit the host already has installed. Same shape and same reasoning as
// smf-late-csr-patch.ts (see that file's own header for why this can't pin a
// fixed commit the way vowifi-build.ts/frr-source-build.ts do) — this file
// reuses its exported SMF_SRC_DIR/nsenter rather than redefining them, since
// both patches build from the exact same checked-out source tree in sequence.
//
// Root cause (confirmed live 2026-10-02, chasing a real "iPhone keeps
// connecting then disconnecting from LTE" report that traced back to a
// repeating MME "GTP Timeout : Message-Type[32]" — a Create Session Request
// that SMF never answered): smf_gx_send_ccr()'s INITIAL_REQUEST Gx CCR (src/
// smf/gx-path.c) only sets Destination-Realm + Auth-Application-Id, with no
// Destination-Host — it relies entirely on freeDiameter's realm+app-id
// candidate selection to reach PCRF. This deployment's SMF freeDiameter
// config (/etc/freeDiameter/smf.conf) has THREE ConnectPeer entries sharing
// the exact same realm (pcrf/aaa/ocs all advertise cnf_diamrlm) — and
// SigScale OCS's own CER (confirmed live by reading its actual Capabilities-
// Exchange-Answer) advertises BOTH its real application, Gy (Auth-
// Application-Id 4), AND 3GPP Gx's Auth-Application-Id (16777238) — which
// OCS does not implement at all (it ships a gx_application_cb module but
// nothing in this deployment uses it as a PCRF). With two realm+app-id
// candidates for Gx, freeDiameter occasionally routes the CCR to OCS
// instead of PCRF — confirmed live via a real Gx CCR for session-id
// "...;app_gx" captured mid-flight tagged to the OCS peer connection, with
// PCRF's own log then showing it never arrived there at all. SMF is left
// waiting for a Gx CCA that will never come, the peer's GTP retransmits get
// discarded as duplicates, and ~7.5s later MME's own GTP Holding Timeout
// fires and tears the whole PDU session down — which is exactly what
// "connects then disconnects" looks like from the UE's side. This is
// genuinely intermittent, not constant: the very same attach cycle's
// "internet" session routed to PCRF correctly moments earlier, so this only
// bites when freeDiameter's candidate pick goes the wrong way.
//
// Fix: pin the very first Gx CCR to PCRF explicitly via Destination-Host —
// same mechanism gx-path.c already uses for every CCR AFTER the first one
// on a given session (there it's learned reactively from the prior CCA's
// own Origin-Host; the gap is only on the INITIAL_REQUEST, before any
// response has been seen yet). PCRF's identity is always "pcrf." + this
// SMF's own configured Diameter realm in this deployment's naming
// convention (matching pcrf.epc.../aaa.epc.../ocs.epc... in smf.conf) — not
// read from a dedicated smf.yaml key since none exists for it upstream.
// This is a real, narrow gap in a RFC-legal but ambiguity-prone upstream
// default (worth reporting upstream — not yet done as of this writing), not
// anything in this project's own config generation.
import { nsenter, SMF_SRC_DIR } from './smf-late-csr-patch';

export { nsenter };

export const SMF_GX_PEERHOST_PATCH_REV = 1;
export const SMF_GX_PEERHOST_PATCH_MARKER_FILE = '/etc/open5gs-nms/smf-gx-peerhost-patch.json';

// Same idempotent shape as buildSmfLateCsrPatchScript(): version detection,
// marker-file fast-skip, grep-guarded source patch, ninja build (a no-op on
// an already-built tree), and a binary swap with an automatic rollback if
// the newly built smfd fails to come up healthy — SMF is a core, always-on
// NF used by every subscriber on every RAT, not an optional module, so a
// bad patch here can never be allowed to leave the host worse off than
// before it was attempted.
export function buildSmfGxPeerhostPatchScript(): string {
  return `#!/bin/bash
set -e

MARKER="${SMF_GX_PEERHOST_PATCH_MARKER_FILE}"
PATCH_REV=${SMF_GX_PEERHOST_PATCH_REV}
SRC_DIR="${SMF_SRC_DIR}"

echo "==STEP:detecting_installed_smf_version=="
INSTALLED_VERSION=$(open5gs-smfd -v 2>&1 | grep -oE 'v[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9]+-g[0-9a-f]+)?' | head -1)
INSTALLED_COMMIT=$(echo "$INSTALLED_VERSION" | grep -oE 'g[0-9a-f]+$' | sed 's/^g//')
echo "Installed open5gs-smfd: ${'$'}{INSTALLED_VERSION:-unknown} (commit: ${'$'}{INSTALLED_COMMIT:-none})"

if [ -z "$INSTALLED_COMMIT" ]; then
  echo "Could not determine the installed open5gs-smfd's exact upstream commit from its -v output — this usually means it wasn't built from a git checkout (e.g. installed via a .deb package instead). Skipping the SMF Gx wrong-peer patch: rebuilding from a different/unrelated commit than what's actually running risks a real ABI/behavior mismatch with a live, non-optional core NF. If you built Open5GS from source yourself, re-run Install after confirming 'open5gs-smfd -v' prints a real '-g<hash>' suffix."
  echo "==STEP:done=="
  exit 0
fi

echo "==STEP:checking_marker=="
if [ -f "$MARKER" ] && grep -q "\\"commit\\": \\"$INSTALLED_COMMIT\\"" "$MARKER" && grep -q "\\"patchRev\\": $PATCH_REV" "$MARKER"; then
  echo "SMF Gx wrong-peer patch already applied for this exact commit ($INSTALLED_COMMIT) at patch rev $PATCH_REV — nothing to do."
  echo "==STEP:done=="
  exit 0
fi

echo "==STEP:installing_build_deps=="
DEBIAN_FRONTEND=noninteractive apt-get update -q
DEBIAN_FRONTEND=noninteractive apt-get install -y \\
  python3-pip python3-setuptools python3-wheel ninja-build build-essential \\
  flex bison git libsctp-dev libgnutls28-dev libgcrypt-dev libssl-dev \\
  libidn11-dev libmongoc-dev libbson-dev libyaml-dev libnghttp2-dev \\
  libmicrohttpd-dev libcurl4-gnutls-dev libtins-dev libtalloc-dev meson 2>&1

echo "==STEP:fetching_source=="
mkdir -p "$(dirname "$SRC_DIR")"
if [ ! -d "$SRC_DIR/.git" ]; then
  echo "Cloning open5gs/open5gs (first run — this can take a few minutes)..."
  git clone https://github.com/open5gs/open5gs "$SRC_DIR"
else
  echo "Source tree already present — fetching."
  cd "$SRC_DIR" && git fetch origin --quiet
fi
cd "$SRC_DIR"
git checkout "$INSTALLED_COMMIT" --quiet
echo "Checked out commit $INSTALLED_COMMIT (matching the host's installed open5gs-smfd exactly)."

echo "==STEP:patching_gx_path=="
grep -q 'ogs_debug("    Allocate new session: \\[%s\\]", sess_data->gx_sid);' src/smf/gx-path.c || { echo "ERROR: gx-path.c patch site (the new-session 'Allocate new session' debug line) not found at commit $INSTALLED_COMMIT — upstream source differs from what this patch expects, skipping, please review manually"; echo "==STEP:done=="; exit 1; }
if grep -q 'Pin the very first (INITIAL_REQUEST) Gx CCR to the PCRF peer' src/smf/gx-path.c; then
  echo "gx-path.c already has the patch applied (matches this exact checkout) — skipping re-patch."
else
  python3 - <<'PYEOF'
path = "src/smf/gx-path.c"
with open(path) as f:
    src = f.read()
needle = '''        /* Allocate new session state memory */
        sess_data = new_state(sid);
        ogs_assert(sess_data);

        ogs_debug("    Allocate new session: [%s]", sess_data->gx_sid);'''
replacement = '''        /* Allocate new session state memory */
        sess_data = new_state(sid);
        ogs_assert(sess_data);

        ogs_debug("    Allocate new session: [%s]", sess_data->gx_sid);

        /*
         * Pin the very first (INITIAL_REQUEST) Gx CCR to the PCRF peer
         * explicitly via Destination-Host, rather than leaving it to
         * freeDiameter's realm + Auth-Application-Id candidate selection.
         * Subsequent CCRs on this same session already do this further
         * below (learned from the first CCA's own Origin-Host) -- the gap
         * is only here, on the very first request, before any response has
         * been seen yet. This deployment's freeDiameter config advertises
         * multiple peers sharing this same realm (pcrf/aaa/ocs all use
         * cnf_diamrlm), and at least one of them also advertises the Gx
         * Application-Id in its own CER -- confirmed live via a real Gx
         * CCR for this exact session-id pattern captured mid-flight tagged
         * to that other peer's connection instead of PCRF's, with PCRF's
         * own log then showing it never arrived there at all, leaving the
         * session hung until the UE's own GTP retransmit timer gave up and
         * tore the whole attach down. PCRF's identity is always
         * "pcrf." + this SMF's configured Diameter realm in this
         * deployment's own naming convention -- not read from a dedicated
         * smf.yaml key since none exists for it.
         */
        {
            char pcrf_host[256];
            ogs_snprintf(pcrf_host, sizeof(pcrf_host), "pcrf.%s",
                    fd_g_config->cnf_diamrlm);
            sess_data->peer_host = (os0_t)ogs_strdup(pcrf_host);
            if (!sess_data->peer_host)
                ogs_error("ogs_strdup() for peer_host failed");
        }'''
if needle not in src:
    raise SystemExit(1)
src = src.replace(needle, replacement, 1)
with open(path, "w") as f:
    f.write(src)
print("patched src/smf/gx-path.c")
PYEOF
fi
grep -q 'Pin the very first (INITIAL_REQUEST) Gx CCR to the PCRF peer' src/smf/gx-path.c || { echo "ERROR: gx-path.c patch did not apply"; echo "==STEP:done=="; exit 1; }

echo "==STEP:building=="
start_heartbeat() {
  ( while true; do echo "==HEARTBEAT:$(date +%s)=="; sleep 15; done ) &
  HEARTBEAT_PID=$!
}
stop_heartbeat() { kill "$HEARTBEAT_PID" 2>/dev/null || true; }
start_heartbeat
if [ -d build ]; then
  ninja -C build
else
  meson setup build --prefix=/usr
  ninja -C build
fi
stop_heartbeat
test -x build/src/smf/open5gs-smfd

echo "==STEP:installing_and_restarting=="
BACKUP="/usr/bin/open5gs-smfd.pre-gx-peerhost-patch-backup"
cp /usr/bin/open5gs-smfd "$BACKUP"
systemctl stop open5gs-smfd
cp build/src/smf/open5gs-smfd /usr/bin/open5gs-smfd
systemctl reset-failed open5gs-smfd 2>/dev/null || true
systemctl start open5gs-smfd
sleep 3
if systemctl is-active --quiet open5gs-smfd; then
  echo "open5gs-smfd patched and restarted successfully."
  mkdir -p "$(dirname "$MARKER")"
  cat > "$MARKER" <<EOF
{"commit": "$INSTALLED_COMMIT", "patchRev": $PATCH_REV, "appliedAt": "$(date -u +%FT%TZ)"}
EOF
else
  echo "WARNING: patched open5gs-smfd failed to come up healthy — rolling back to the pre-patch binary automatically (SMF is a core NF used by every subscriber, not just IMS)."
  systemctl stop open5gs-smfd 2>/dev/null || true
  cp "$BACKUP" /usr/bin/open5gs-smfd
  systemctl reset-failed open5gs-smfd 2>/dev/null || true
  systemctl start open5gs-smfd
  sleep 2
  if systemctl is-active --quiet open5gs-smfd; then
    echo "Rolled back successfully — open5gs-smfd is back on the original, unpatched binary. The Gx wrong-peer patch was NOT applied; Gx CCRs may still intermittently misroute to a same-realm peer. Check the build output above for the real failure and re-run Install once fixed."
    echo "==STEP:done=="
    exit 1
  else
    echo "CRITICAL: rollback ALSO failed to bring open5gs-smfd back up — this needs immediate manual attention (journalctl -u open5gs-smfd), every subscriber's PDN connectivity is affected right now."
    echo "==STEP:done=="
    exit 1
  fi
fi

echo "==STEP:done=="
`;
}
