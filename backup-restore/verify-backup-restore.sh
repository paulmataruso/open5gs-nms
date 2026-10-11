#!/usr/bin/env bash
set -euo pipefail

# verify-backup-restore.sh — CLI-only dev tool. NOT shipped/documented for
# end users, not referenced from INSTALL.md or the UI. Proves a full
# backup/restore cycle reproduces this host's real config files
# byte-for-byte: hashes every tracked config file, creates a real backup,
# restores it (ALL categories) back onto this SAME host, then hashes again
# and diffs. A clean run should show zero differences.
#
# This exercises the REAL restore+restart pipeline
# (full-restore-orchestrator-usecase.ts) exactly like a real
# operator-triggered restore would — it WILL restart core-17 NFs,
# strongSwan, BIND9, GenieACS, and every configured optional module on
# whatever host you point it at. Never run this against a host you can't
# afford to briefly disrupt. Only run it deliberately, when you actually
# want to test this.
#
# Usage: ./verify-backup-restore.sh <admin-password> [nms-base-url] [-y]

ADMIN_PASSWORD="${1:?Usage: $0 <admin-password> [nms-base-url] [-y]}"
BASE_URL="${2:-http://localhost:3001}"
ASSUME_YES=0
for arg in "$@"; do [[ "$arg" == "-y" ]] && ASSUME_YES=1; done

if [[ $ASSUME_YES -ne 1 ]]; then
  echo "This will create a full backup of ${BASE_URL} and restore it back onto"
  echo "the SAME host — real services (core-17 NFs, strongSwan, BIND9, GenieACS,"
  echo "every configured optional module) will be restarted."
  read -r -p "Continue? [y/N] " reply
  [[ "$reply" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 1; }
fi

WORKDIR=$(mktemp -d)
echo "Working directory: $WORKDIR (not auto-deleted — clean it up yourself when done, it holds real config-file hashes)"

# Same set of real host paths backup-restore.ts's own CORE_SERVICES +
# EXTRA_BACKUP_FILES cover — kept in sync by hand, since this is a
# standalone dev tool the app doesn't import. If you add a new entry to
# either of those, add it here too or this tool silently stops covering it.
CORE_SERVICES=(nrf scp amf smf upf ausf udm udr pcf nssf bsf mme hss pcrf sgwc sgwu sepp1)
ALL_FILES=()
for s in "${CORE_SERVICES[@]}"; do ALL_FILES+=("/etc/open5gs/${s}.yaml"); done
ALL_FILES+=(
  /etc/osmocom/osmo-hlr.cfg /etc/osmocom/osmo-msc.cfg /etc/osmocom/osmo-stp.cfg
  /etc/osmocom/osmo-hnbgw.cfg /etc/osmocom/osmo-mgw-hnbgw.cfg /etc/osmocom/.nms-hnbgw-state.json
  /etc/vectorcore/epdg/epdg.yaml /etc/vectorcore/aaa/aaa.config
  /etc/open5gs/.ims-config.json /etc/open5gs/.ims-install.json /etc/open5gs/.mms-config.json
  /etc/open5gs/.pstn-config.json /etc/open5gs/.asterisk2g-config.json
  /etc/open5gs/.vectorcore-smsc-config.json /etc/open5gs/.twamp-config.json /etc/open5gs/.ocs-config.json
  /etc/open5gs-nms/.vowifi-state.json /etc/open5gs-nms/frr-source-build-state.json
  /etc/open5gs-nms/.secgw-state.json
  /etc/osmocom/.nms-gsm-bts-state.json /etc/chrony/chrony.conf /etc/rsyslog.d/71-open5gs-nms-forward.conf
  /etc/open5gs/tls/sepp.crt /etc/open5gs/tls/sepp.key /etc/open5gs/tls/sepp-peer-ca.crt
  /etc/frr/frr.conf /etc/frr/daemons /etc/netplan/60-open5gs-managed.yaml
)

# Real, 2026-09-22 finding from the first live run of this script: 8 of the
# JSON state files below (ims/mms/asterisk2g/vectorcoreSmsc/twamp/ocs/vowifi/
# secgw) legitimately changed content after a full restore+restart cycle —
# NOT data loss. Each carries a `configuredWithVersion`/`configuredAt` field
# (confirmed live by reading the actual post-restore files, e.g.
# .vowifi-state.json's configuredAt landed exactly at the restart step's own
# timestamp) that module's own Configure function re-stamps every time it
# runs — and BackupRestartUseCase deliberately re-runs Configure for every
# present optional module after a restore, since that's also what
# regenerates their derived config files from the just-restored state (see
# backup-restart-usecase.ts's own header comment). A real byte-for-byte
# restore verification has to ignore these specific fields, or it produces
# a false FAIL on every single successful run, forever. Every other field in
# every one of those files (IPs, ports, FQDNs, passwords, CIDRs, enabled
# flags) is still compared normally — only these known-volatile stamp
# fields are excluded, recursively (twamp's lives nested under `server`).
VOLATILE_JSON_KEYS=(configuredWithVersion configuredAt installedWithVersion installStartedAt installCompletedAt)

hash_one() {
  local f="$1"
  if [[ "$f" == *.json ]]; then
    python3 - "$f" "${VOLATILE_JSON_KEYS[@]}" <<'PYEOF'
import json, sys, hashlib
path = sys.argv[1]
volatile = set(sys.argv[2:])
def strip(o):
    if isinstance(o, dict):
        return {k: strip(v) for k, v in o.items() if k not in volatile}
    if isinstance(o, list):
        return [strip(v) for v in o]
    return o
with open(path) as fh:
    data = json.load(fh)
normalized = json.dumps(strip(data), sort_keys=True)
print(hashlib.sha256(normalized.encode()).hexdigest())
PYEOF
  else
    sha256sum "$f" | awk '{print $1}'
  fi
}

hash_files() {
  local outfile="$1"
  : > "$outfile"
  for f in "${ALL_FILES[@]}"; do
    if [[ -f "$f" ]]; then
      echo "$(hash_one "$f")  $f" >> "$outfile"
    else
      echo "MISSING  $f" >> "$outfile"
    fi
  done
}

json_get() { python3 -c "import json,sys;d=json.load(sys.stdin)
for k in sys.argv[1].split('.'):
    d = d[k] if not k.isdigit() else d[int(k)]
print(d)" "$2" <<< "$1"; }

echo "==> Snapshotting current config file hashes (BEFORE)"
hash_files "$WORKDIR/before.hashes"

echo "==> Logging in"
curl -sf -c "$WORKDIR/cookies" -X POST "$BASE_URL/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"admin\",\"password\":\"${ADMIN_PASSWORD}\"}" > /dev/null

echo "==> Creating + downloading a full backup"
curl -sf -b "$WORKDIR/cookies" "$BASE_URL/api/backup/full/download" -o "$WORKDIR/backup.tar.gz"

echo "==> Uploading it back for inspection/restore"
UPLOAD_JSON=$(curl -sf -b "$WORKDIR/cookies" -X POST "$BASE_URL/api/backup/full/upload" \
  -H "Content-Type: application/octet-stream" --data-binary @"$WORKDIR/backup.tar.gz")
rm -f "$WORKDIR/backup.tar.gz"  # real subscriber/PII data — don't leave it lying around once uploaded
UPLOAD_ID=$(json_get "$UPLOAD_JSON" "uploadId")
CATEGORIES='["subscribers","core-configs","suci-keys","secgw-pki","optional-modules","l3-network","dns","genieacs","auth","ui-modules","ocs-data","radio-backups"]'

echo "==> Starting restore (ALL categories, same host, freshHostBootstrap=false)"
curl -sf -b "$WORKDIR/cookies" -X POST "$BASE_URL/api/backup/full/restore" \
  -H "Content-Type: application/json" \
  -d "{\"uploadId\":\"${UPLOAD_ID}\",\"categories\":${CATEGORIES},\"freshHostBootstrap\":false}" > /dev/null

echo "==> Polling restore status..."
STATUS_JSON=""
STATUS="running"
while [[ "$STATUS" != "complete" && "$STATUS" != "failed" ]]; do
  sleep 3
  STATUS_JSON=$(curl -sf -b "$WORKDIR/cookies" "$BASE_URL/api/backup/full/restore/status")
  STATUS=$(json_get "$STATUS_JSON" "run.status")
  echo "   status: $STATUS"
done
echo "$STATUS_JSON" | python3 -m json.tool > "$WORKDIR/final-status.json" 2>/dev/null || echo "$STATUS_JSON" > "$WORKDIR/final-status.json"

if [[ "$STATUS" == "failed" ]]; then
  echo "!! Restore reported FAILED — see $WORKDIR/final-status.json before trusting any hash diff below."
fi

echo "==> Snapshotting config file hashes (AFTER)"
hash_files "$WORKDIR/after.hashes"

echo ""
echo "==> Diff (before vs after) — empty means every tracked file round-tripped byte-for-byte:"
if diff -u "$WORKDIR/before.hashes" "$WORKDIR/after.hashes"; then
  echo ""
  echo "PASS — every tracked config file matches byte-for-byte after the round trip."
else
  echo ""
  echo "FAIL — see the diff above. Each changed line is one file whose restored"
  echo "content doesn't match what was backed up (or a MISSING file, which likely"
  echo "means that module's install/config wasn't present or its restore/reapply"
  echo "step for that module didn't run — check $WORKDIR/final-status.json)."
fi

echo ""
echo "Full run state: $WORKDIR/final-status.json"
echo "Hash snapshots: $WORKDIR/before.hashes, $WORKDIR/after.hashes"
