// Open5GS SMF "Late/overlapping Create Session Request" patch — builds a
// patched open5gs-smfd from source and installs it over the host's existing
// binary, matching whatever commit the host already has installed (Open5GS
// itself is NOT vendored/installed by this NMS — it's a separate manual
// install per the project's own architecture — so this can't pin a fixed
// commit the way vowifi-build.ts/frr-source-build.ts do for components this
// project DOES fully own; it has to detect and match the host's own version).
//
// Root cause (confirmed live 2026-08-04, via a real Nokia AirScale Pico BTS
// B66 eNB attach): smf_gsm_state_operational()'s SMF_EVT_S5C_MESSAGE switch
// (src/smf/gsm-sm.c) has no case for a Create Session Request arriving
// against a session that's already fully established — it falls into the
// generic `default: ogs_error("Not implemented(type:%d)", ...)` branch and
// silently drops the message, sending no GTP2 response at all. The peer
// (SGW-C, on behalf of MME) then times out several seconds later
// (mme-gtp-path.c "GTP Timeout"), and as an observed side effect of that
// timeout's cleanup, the UE's OTHER, unrelated sibling PDN session also gets
// torn down — e.g. a fully working "internet" bearer dies just because a
// colliding "ims" Create Session Request arrived for the same UE. This is
// what "IMS won't create the bearer" looked like from the user's side.
// Confirmed via three real Open5GS radios' worth of testing that this only
// actually manifests when something (this project's evidence: specifically
// the Nokia AirScale Pico BTS B66's own S1AP/attach timing) causes a second,
// genuinely-new (not a plain retransmission — those are already correctly
// deduplicated earlier, at the GTP transaction layer) Create Session Request
// to arrive for a UE+APN pair whose session already reached "operational".
//
// Fix: reply immediately with the cause 3GPP TS 29.274 Table 8.4-1 defines
// for exactly this collision — OGS_GTP2_CAUSE_LATE_OVERLAPPING_REQUEST (121)
// — instead of silently dropping. Verified live: turns a multi-second silent
// hang + collateral sibling-session teardown into an immediate, clean
// rejection, after which the UE's natural retry succeeds (confirmed: a real
// "ims" bearer came up cleanly on the very next attempt, and a real SIP
// REGISTER reached P-CSCF from it).
//
// This is a real gap in upstream Open5GS SMF, not anything in this project's
// own config generation — worth reporting upstream (not yet done as of this
// writing), but baked in here in the meantime so it survives an IMS
// re-install without the user having to remember it was ever live-patched.
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

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

// Bumped whenever the patch content below changes, independent of whichever
// upstream commit the host happens to have installed — same purpose as
// VECTORCORE_PATCH_REV/OSMO_EPDG_PATCH_REV elsewhere in this project. The
// generated script itself checks this against its own marker file to decide
// whether a re-run needs to rebuild at all.
export const SMF_LATE_CSR_PATCH_REV = 1;
export const SMF_SRC_DIR = '/opt/open5gs-nms-patches/open5gs-smf-source';
export const SMF_PATCH_MARKER_FILE = '/etc/open5gs-nms/smf-late-csr-patch.json';

// Generates the full patch/build/install script, run via nsenter bash -c
// (matching every other streamed Install step in ims-controller.ts). Every
// step is idempotent and safe to re-run: version/commit detection, the
// marker-file fast-skip, the grep-guarded source patch, and the build itself
// (ninja no-ops on an unchanged tree). The one non-idempotent action — the
// binary swap + service restart — only happens if the marker check didn't
// already short-circuit, and is guarded by an automatic rollback to the
// pre-patch binary if the newly built one fails to come up healthy (SMF is
// one of the 17 core, always-on NFs, not an optional module — a bad restart
// here affects every subscriber, not just IMS users, so this can never be
// allowed to leave the host worse off than before the patch was attempted).
export function buildSmfLateCsrPatchScript(): string {
  return `#!/bin/bash
set -e

MARKER="${SMF_PATCH_MARKER_FILE}"
PATCH_REV=${SMF_LATE_CSR_PATCH_REV}
SRC_DIR="${SMF_SRC_DIR}"

echo "==STEP:detecting_installed_smf_version=="
# -v prints the version and exits immediately, no config/network required —
# safe to run even if open5gs-smfd is currently down/crash-looping for an
# unrelated reason.
INSTALLED_VERSION=$(open5gs-smfd -v 2>&1 | grep -oE 'v[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9]+-g[0-9a-f]+)?' | head -1)
INSTALLED_COMMIT=$(echo "$INSTALLED_VERSION" | grep -oE 'g[0-9a-f]+$' | sed 's/^g//')
echo "Installed open5gs-smfd: ${'$'}{INSTALLED_VERSION:-unknown} (commit: ${'$'}{INSTALLED_COMMIT:-none})"

if [ -z "$INSTALLED_COMMIT" ]; then
  echo "Could not determine the installed open5gs-smfd's exact upstream commit from its -v output — this usually means it wasn't built from a git checkout (e.g. installed via a .deb package instead). Skipping the SMF late-overlapping-CSR patch: rebuilding from a different/unrelated commit than what's actually running risks a real ABI/behavior mismatch with a live, non-optional core NF. If you built Open5GS from source yourself, re-run Install after confirming 'open5gs-smfd -v' prints a real '-g<hash>' suffix."
  echo "==STEP:done=="
  exit 0
fi

echo "==STEP:checking_marker=="
if [ -f "$MARKER" ] && grep -q "\\"commit\\": \\"$INSTALLED_COMMIT\\"" "$MARKER" && grep -q "\\"patchRev\\": $PATCH_REV" "$MARKER"; then
  echo "SMF late-overlapping-CSR patch already applied for this exact commit ($INSTALLED_COMMIT) at patch rev $PATCH_REV — nothing to do."
  echo "==STEP:done=="
  exit 0
fi

echo "==STEP:installing_build_deps=="
# Open5GS's own official quickstart build-dependency list (open5gs.org) —
# unconditional apt-get, same pattern this project's other from-source
# build steps (vowifi-build.ts, frr-source-build.ts) already use.
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

echo "==STEP:patching_gsm_sm=="
grep -q 'ogs_error("Not implemented(type:%d)", gtp2_message->h.type);' src/smf/gsm-sm.c || { echo "ERROR: gsm-sm.c patch site (the SMF_EVT_S5C_MESSAGE default-case 'Not implemented' line) not found at commit $INSTALLED_COMMIT — upstream source differs from what this patch expects, skipping, please review manually"; echo "==STEP:done=="; exit 1; }
if grep -q 'Late/overlapping Create Session Request' src/smf/gsm-sm.c; then
  echo "gsm-sm.c already has the patch applied (matches this exact checkout) — skipping re-patch."
else
  python3 - <<'PYEOF'
path = "src/smf/gsm-sm.c"
with open(path) as f:
    src = f.read()
needle = '''        default:
            ogs_error("Not implemented(type:%d)", gtp2_message->h.type);
        }
        break;

    case SMF_EVT_N4_MESSAGE:'''
replacement = '''        default:
            if (gtp2_message->h.type == OGS_GTP2_CREATE_SESSION_REQUEST_TYPE) {
                smf_ue = smf_ue_find_by_id(sess->smf_ue_id);
                ogs_error("Late/overlapping Create Session Request for an "
                        "already-operational session [IMSI:%s,APN:%s]",
                        smf_ue ? smf_ue->imsi_bcd : "(unknown)",
                        sess->session.name);
                ogs_gtp2_send_error_message(gtp_xact, sess->sgw_s5c_teid,
                        OGS_GTP2_CREATE_SESSION_RESPONSE_TYPE,
                        OGS_GTP2_CAUSE_LATE_OVERLAPPING_REQUEST);
            } else {
                ogs_error("Not implemented(type:%d)", gtp2_message->h.type);
            }
        }
        break;

    case SMF_EVT_N4_MESSAGE:'''
if needle not in src:
    raise SystemExit(1)
src = src.replace(needle, replacement, 1)
with open(path, "w") as f:
    f.write(src)
print("patched src/smf/gsm-sm.c")
PYEOF
fi
grep -q 'Late/overlapping Create Session Request' src/smf/gsm-sm.c || { echo "ERROR: gsm-sm.c patch did not apply"; echo "==STEP:done=="; exit 1; }

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
BACKUP="/usr/bin/open5gs-smfd.pre-late-csr-patch-backup"
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
    echo "Rolled back successfully — open5gs-smfd is back on the original, unpatched binary. The late-overlapping-CSR patch was NOT applied; IMS PDN sessions on radios that trigger this race may still fail. Check the build output above for the real failure and re-run Install once fixed."
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
