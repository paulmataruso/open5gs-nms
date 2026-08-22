// Open5GS MME "duplicate Release Access Bearers Request" patch — builds a
// patched open5gs-mmed from source and installs it over the host's existing
// binary, matching whatever commit the host already has installed (same
// approach as smf-late-csr-patch.ts — Open5GS itself is NOT vendored by this
// NMS, so this can't pin a fixed commit the way vowifi-build.ts/
// frr-source-build.ts do for components this project DOES fully own).
//
// Root cause (confirmed live 2026-08-21, via a real UE's "internet drops but
// connection never shows as down" complaint, diagnosed from trace-level
// core logs during a live reproduction): sgsap_handle_lu_reject()
// (src/mme/sgsap-handler.c) fires a Release Access Bearers Request TWICE
// for the same TAU. Once indirectly — both its BCS and No-BCS branches
// eventually reach mme_send_tau_accept_and_check_release() (src/mme/
// mme-path.c), which already sends a Release Access Bearers Request
// whenever active_flag==0 and no next P-TMSI is pending — and then AGAIN,
// unconditionally, via a trailing block in sgsap-handler.c itself that
// re-checks the exact same condition and calls the exact same send
// function a second time.
//
// This only actually causes damage when a second signaling event (a UE
// Service Request — e.g. this network's radios support both LTE and NR, so
// a UE bouncing between them generates exactly this kind of fast follow-up)
// lands in the ~milliseconds window between the two duplicate transactions.
// The Service Request rebuilds the S1 context, which can orphan whichever
// of the two Release Access Bearers responses arrives second — SGW-C
// answers both correctly (confirmed live: both PFCP Session Modification
// round-trips to SGW-U completed in 1-2ms), but MME can no longer match the
// orphaned response to a live context. ~7 seconds later MME's own GTP
// transaction timeout fires ("GTP Timeout: Message-Type[170]") and MME
// forcibly tears down the *entire* session — and because Open5GS's SMF
// shares session state across 4G and 5G access for the same IMSI+APN, this
// kills the UE's data connectivity even though RRC/NAS looked completely
// fine, matching exactly what was reported ("lose internet, connection
// never drops").
//
// Fix: delete the redundant trailing block in sgsap-handler.c — every code
// path that reaches it has already sent the Release Access Bearers Request
// exactly once via mme_send_tau_accept_and_check_release(). This isn't just
// dodging the race: the block was dead/duplicate logic on every path,
// including one this patch also incidentally corrects (the BCS-mismatch
// path, where the trailing block used to fire even before the BCS-driven
// session deletion + TAU accept had completed).
//
// This is a real gap in upstream Open5GS MME, not anything in this
// project's own config generation — worth reporting upstream (not yet done
// as of this writing), but baked in here so it applies automatically to
// every deployment: this use-case is invoked once, non-blocking, on every
// backend startup (see index.ts) — new installs pick it up on first boot,
// existing installs pick it up the next time the backend container is
// restarted (already this project's standard "redeploy backend" step), and
// the marker-file check makes every re-run after the first an instant
// no-op.
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
// SMF_LATE_CSR_PATCH_REV. The generated script checks this against its own
// marker file to decide whether a re-run needs to rebuild at all.
export const MME_DUP_RAB_PATCH_REV = 1;
export const MME_SRC_DIR = '/opt/open5gs-nms-patches/open5gs-mme-source';
export const MME_PATCH_MARKER_FILE = '/etc/open5gs-nms/mme-dup-release-access-bearers-patch.json';

// Generates the full patch/build/install script, run via nsenter bash -c.
// Every step is idempotent and safe to re-run: version/commit detection,
// the marker-file fast-skip, the grep-guarded source patch, and the build
// itself (ninja no-ops on an unchanged tree). The one non-idempotent action
// — the binary swap + service restart — only happens if the marker check
// didn't already short-circuit, and is guarded by an automatic rollback to
// the pre-patch binary if the newly built one fails to come up healthy: MME
// is one of the 17 core, always-on NFs, not an optional module — a bad
// restart here affects every 4G subscriber, not just the one UE that
// exposed the bug.
export function buildMmeDupReleaseAccessBearersPatchScript(): string {
  return `#!/bin/bash
set -e

MARKER="${MME_PATCH_MARKER_FILE}"
PATCH_REV=${MME_DUP_RAB_PATCH_REV}
SRC_DIR="${MME_SRC_DIR}"

echo "==STEP:detecting_installed_mme_version=="
# -v prints the version and exits immediately, no config/network required —
# safe to run even if open5gs-mmed is currently down/crash-looping for an
# unrelated reason.
INSTALLED_VERSION=$(open5gs-mmed -v 2>&1 | grep -oE 'v[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9]+-g[0-9a-f]+)?' | head -1)
INSTALLED_COMMIT=$(echo "$INSTALLED_VERSION" | grep -oE 'g[0-9a-f]+$' | sed 's/^g//')
echo "Installed open5gs-mmed: ${'$'}{INSTALLED_VERSION:-unknown} (commit: ${'$'}{INSTALLED_COMMIT:-none})"

if [ -z "$INSTALLED_COMMIT" ]; then
  echo "Could not determine the installed open5gs-mmed's exact upstream commit from its -v output — this usually means it wasn't built from a git checkout (e.g. installed via a .deb package instead). Skipping the MME duplicate-release-access-bearers patch: rebuilding from a different/unrelated commit than what's actually running risks a real ABI/behavior mismatch with a live, non-optional core NF. If you built Open5GS from source yourself, restart the backend after confirming 'open5gs-mmed -v' prints a real '-g<hash>' suffix."
  echo "==STEP:done=="
  exit 0
fi

echo "==STEP:checking_marker=="
if [ -f "$MARKER" ] && grep -q "\\"commit\\": \\"$INSTALLED_COMMIT\\"" "$MARKER" && grep -q "\\"patchRev\\": $PATCH_REV" "$MARKER"; then
  echo "MME duplicate-release-access-bearers patch already applied for this exact commit ($INSTALLED_COMMIT) at patch rev $PATCH_REV — nothing to do."
  echo "==STEP:done=="
  exit 0
fi

echo "==STEP:installing_build_deps=="
# Open5GS's own official quickstart build-dependency list (open5gs.org) —
# unconditional apt-get, same pattern this project's other from-source
# build steps (vowifi-build.ts, frr-source-build.ts, smf-late-csr-patch.ts)
# already use.
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
echo "Checked out commit $INSTALLED_COMMIT (matching the host's installed open5gs-mmed exactly)."

echo "==STEP:patching_sgsap_handler=="
grep -q 'mme_send_release_access_bearer_or_ue_context_release(enb_ue);' src/mme/sgsap-handler.c || { echo "ERROR: sgsap-handler.c patch site (the trailing duplicate Release-Access-Bearers-Request block) not found at commit $INSTALLED_COMMIT — upstream source differs from what this patch expects, skipping, please review manually"; echo "==STEP:done=="; exit 1; }
if grep -q 'NMS-PATCH mme-dup-release-access-bearers-fix' src/mme/sgsap-handler.c; then
  echo "sgsap-handler.c already has the patch applied (matches this exact checkout) — skipping re-patch."
else
  python3 - <<'PYEOF'
path = "src/mme/sgsap-handler.c"
with open(path) as f:
    src = f.read()
needle = '''        }

        /*
         * When active_flag is 0, check if the P-TMSI has been updated.
         * If the P-TMSI has changed, wait to receive the TAU Complete message
         * from the UE before sending the UEContextReleaseCommand.
         *
         * This ensures that the UE has acknowledged the new P-TMSI,
         * allowing the TAU procedure to complete successfully
         * and maintaining synchronization between the UE and the network.
         */
        if (!mme_ue->nas_eps.update.active_flag &&
            !MME_NEXT_P_TMSI_IS_AVAILABLE(mme_ue)) {
            enb_ue->relcause.group = S1AP_Cause_PR_nas;
            enb_ue->relcause.cause = S1AP_CauseNas_normal_release;
            mme_send_release_access_bearer_or_ue_context_release(enb_ue);
        }
    } else {'''
replacement = '''        }

        /* NMS-PATCH mme-dup-release-access-bearers-fix: removed a
         * duplicate Release-Access-Bearers-Request call that used to sit
         * here \\u2014 mme_send_tau_accept_and_check_release() (reached via
         * both branches above, directly or via
         * mme_send_delete_session_or_tau_accept()) already sends it
         * exactly once whenever active_flag==0. Firing it twice raced
         * with a fast follow-up Service Request (e.g. LTE/NR reselection)
         * and could orphan one response, leaving MME to self-timeout and
         * forcibly kill the whole session ~7s later even though the peer
         * had answered correctly. */
    } else {'''
if needle not in src:
    raise SystemExit(1)
src = src.replace(needle, replacement, 1)
with open(path, "w") as f:
    f.write(src)
print("patched src/mme/sgsap-handler.c")
PYEOF
fi
grep -q 'NMS-PATCH mme-dup-release-access-bearers-fix' src/mme/sgsap-handler.c || { echo "ERROR: sgsap-handler.c patch did not apply"; echo "==STEP:done=="; exit 1; }

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
test -x build/src/mme/open5gs-mmed

echo "==STEP:installing_and_restarting=="
BACKUP="/usr/bin/open5gs-mmed.pre-dup-rab-patch-backup"
cp /usr/bin/open5gs-mmed "$BACKUP"
systemctl stop open5gs-mmed
cp build/src/mme/open5gs-mmed /usr/bin/open5gs-mmed
systemctl reset-failed open5gs-mmed 2>/dev/null || true
systemctl start open5gs-mmed
sleep 5
if systemctl is-active --quiet open5gs-mmed; then
  echo "open5gs-mmed patched and restarted successfully."
  mkdir -p "$(dirname "$MARKER")"
  cat > "$MARKER" <<EOF
{"commit": "$INSTALLED_COMMIT", "patchRev": $PATCH_REV, "appliedAt": "$(date -u +%FT%TZ)"}
EOF
else
  echo "WARNING: patched open5gs-mmed failed to come up healthy — rolling back to the pre-patch binary automatically (MME is a core NF used by every 4G subscriber, not an optional module)."
  systemctl stop open5gs-mmed 2>/dev/null || true
  cp "$BACKUP" /usr/bin/open5gs-mmed
  systemctl reset-failed open5gs-mmed 2>/dev/null || true
  systemctl start open5gs-mmed
  sleep 3
  if systemctl is-active --quiet open5gs-mmed; then
    echo "Rolled back successfully — open5gs-mmed is back on the original, unpatched binary. The duplicate-release-access-bearers patch was NOT applied; the LTE/NR-reselection session-drop bug may still occur. Check the build output above for the real failure — this step will retry automatically on the next backend restart."
    echo "==STEP:done=="
    exit 1
  else
    echo "CRITICAL: rollback ALSO failed to bring open5gs-mmed back up — this needs immediate manual attention (journalctl -u open5gs-mmed), every 4G subscriber's connectivity is affected right now."
    echo "==STEP:done=="
    exit 1
  fi
fi

echo "==STEP:done=="
`;
}
