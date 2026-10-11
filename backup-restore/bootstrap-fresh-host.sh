#!/usr/bin/env bash
set -euo pipefail

# bootstrap-fresh-host.sh
#
# Automates INSTALL.md's "Prerequisites" and "Installation Steps" sections
# end-to-end on a fresh Ubuntu 24.04 host: system packages, Docker, MongoDB,
# Open5GS (the 17 core NF systemd services), and the NMS's own Docker Compose
# stack. Run this BEFORE restoring a Full Backup onto a new host so there is
# something real underneath the restored config. Idempotent — safe to re-run
# if it fails partway through or you just want to confirm everything's in
# place.
#
# Usage:
#   git clone https://github.com/paulmataruso/open5gs-nms /opt/open5gs-nms
#   cd /opt/open5gs-nms
#   sudo ./backup-restore/bootstrap-fresh-host.sh [-y|--yes]
#
# Environment overrides (all optional):
#   FIRST_RUN_PASSWORD   Admin password for first login. If unset, the NMS
#                         generates a random one and prints it to backend
#                         container logs on first start (see INSTALL.md).
#   MONGO_MODE            auto (default) | host | docker
#                         auto = installs MongoDB on the host if the CPU has
#                         AVX, otherwise runs it in Docker and source-builds
#                         Open5GS instead (apt's open5gs package requires a
#                         local mongod — see INSTALL.md's AVX Workaround).
#   SKIP_FIREWALL          1 to skip the ufw rules (default 0).
#   SKIP_DOCKER_BUILD      1 to skip `docker compose build` (default 0) —
#                         useful if you already built images separately.
#
# What this script deliberately does NOT do (see INSTALL.md's
# "Post-Installation Configuration" and docs/requirements.md for these):
#   - Install any optional module (IMS, VoWiFi, PSTN, GSM, SecGW, OCS, ...).
#     Those install themselves through the NMS's own API once it's running —
#     the Backup page's Full Restore flow drives that automatically when you
#     check "This is a fresh host" before restoring.
#   - Configure a PLMN, subscribers, or radios.
#   - Set up HTTPS/production hardening (see docs/deployment.md).

# SCRIPT_DIR is this script's own directory (backup-restore/) — where its two
# sibling scripts (generate_open5gs_systemd.sh, service_control.sh) live.
# REPO_ROOT is one level up — docker-compose.yml, .env, mongo_docker/, etc.
# all live there, not alongside this script.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

FIRST_RUN_PASSWORD="${FIRST_RUN_PASSWORD:-}"
MONGO_MODE="${MONGO_MODE:-auto}"
SKIP_FIREWALL="${SKIP_FIREWALL:-0}"
SKIP_DOCKER_BUILD="${SKIP_DOCKER_BUILD:-0}"
ASSUME_YES=0

for arg in "$@"; do
  case "$arg" in
    -y|--yes) ASSUME_YES=1 ;;
    *) echo "Unknown argument: $arg" >&2; exit 1 ;;
  esac
done

log()  { echo -e "\n\033[1;36m==> $*\033[0m"; }
warn() { echo -e "\033[1;33m!!  $*\033[0m" >&2; }
die()  { echo -e "\033[1;31mxx  $*\033[0m" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Run as root (sudo ./backup-restore/bootstrap-fresh-host.sh)."
[[ -f "$REPO_ROOT/docker-compose.yml" && -f "$SCRIPT_DIR/service_control.sh" ]] \
  || die "Run this from inside an open5gs-nms checkout (docker-compose.yml not found in $REPO_ROOT, or service_control.sh not found alongside this script)."

REAL_USER="${SUDO_USER:-root}"

if [[ $ASSUME_YES -ne 1 ]]; then
  echo "This will install system packages, Docker, MongoDB, Open5GS, and bring up"
  echo "the NMS's own Docker Compose stack on this host ($REPO_ROOT)."
  read -r -p "Continue? [y/N] " reply
  [[ "$reply" =~ ^[Yy]$ ]] || die "Aborted."
fi

export DEBIAN_FRONTEND=noninteractive

# ---------------------------------------------------------------------------
log "1/10 — System packages"
# iptables-persistent prompts interactively to save current rules unless
# preseeded — required for a truly non-interactive run.
debconf-set-selections <<< "iptables-persistent iptables-persistent/autosave_v4 boolean true"
debconf-set-selections <<< "iptables-persistent iptables-persistent/autosave_v6 boolean true"
apt-get update -qq
apt-get install -y -qq \
  iptables-persistent conntrack tshark python3 python3-pip chrony \
  curl gnupg ca-certificates lsb-release software-properties-common

# frr/frr-pythontools pulled out of the combined install above and made
# conditional — real, 2026-09-23 incident: this project's own FRR Source
# Build feature (the pattern-7 eigrpd crash-guard patch) replaces the stock
# binaries via `make install` directly, entirely outside dpkg/apt — dpkg has
# no record of it, so it still considers frr "not installed" and will
# unconditionally try to install the stock package on every re-run. Because
# the patched build already owns /etc/frr/daemons and frr.conf as real,
# locally-modified files, that apt-get install hits an interactive dpkg
# conffile prompt ("keep your version or the package maintainer's?") with no
# TTY available in a non-interactive run — it hangs on stdin EOF and the
# whole script dies with exit 100, while dpkg has ALREADY unpacked (though
# not configured) the stock package's regular files, silently overwriting
# the patched eigrpd/zebra/watchfrr binaries on disk (the already-running
# process is unaffected — it keeps using the old inode — but a FUTURE
# restart would silently load the unpatched, crash-vulnerable binary with
# no warning at all). Confirmed live: exactly this happened, recovered via
# `make install` from the still-intact source tree at
# /opt/frr-build/frr-frr-<tag>. `command -v vtysh` — not a dpkg/apt check —
# is what actually reflects whether FRR is present, since it's true either
# way (apt package or source build).
if ! command -v vtysh >/dev/null 2>&1; then
  apt-get install -y -qq frr frr-pythontools
else
  echo "frr already present (vtysh found) — skipping, to avoid disturbing a possibly source-built/patched install with a live EIGRP neighbor."
fi

# ---------------------------------------------------------------------------
log "2/10 — Node.js (host)"
# Real, 2026-09-22 live-fresh-VM finding: Ubuntu's own default `nodejs`
# package is ancient (v12 on 22.04 — EOL since 2022) and Debian/Ubuntu don't
# ship a modern one via plain apt. The backend/frontend containers get Node
# 20 from their own Docker base image, so this was never noticed there — but
# several optional modules with a real web UI (MMS/VectorCore MMSC,
# VectorCore SMSC) build that UI with `npm`/`vite` directly on the HOST (via
# nsenter, same as every other from-source module install), which needs
# `>=20.0.0` per those projects' own package.json. Without this, their
# Install fails deep inside a vite build with a confusing
# "SyntaxError: Unexpected reserved word" (top-level `await import()` isn't
# valid under an old Node's default module handling) — confirmed live,
# traced back to this exact root cause. Matches this project's own pinned
# major version (backend/frontend Dockerfiles both use `node:20-*`).
if ! command -v node >/dev/null 2>&1 || [[ "$(node --version | grep -oE '^v[0-9]+' | tr -d v)" -lt 20 ]]; then
  # Real, live-confirmed gotcha: NodeSource's own `nodejs` package conflicts
  # on-disk with Ubuntu's distro `libnode-dev` (both ship
  # /usr/include/node/common.gypi) — and libnode-dev/libnode72/nodejs v12
  # end up installed anyway as a transitive dependency of other packages
  # earlier in this same script (confirmed live: present on a host that
  # never explicitly asked for Node at all). Purge the distro packages
  # first, standard NodeSource-on-Ubuntu guidance, or the dpkg unpack
  # below fails with an "trying to overwrite" conflict.
  apt-get remove -y -qq nodejs libnode-dev libnode72 npm 2>/dev/null || true
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
else
  echo "Node.js $(node --version) already installed, skipping."
fi
node --version

# ---------------------------------------------------------------------------
log "3/10 — Docker"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
  sh /tmp/get-docker.sh
  rm -f /tmp/get-docker.sh
else
  echo "Docker already installed, skipping."
fi
if [[ "$REAL_USER" != "root" ]]; then
  usermod -aG docker "$REAL_USER" || true
fi
apt-get install -y -qq docker-compose-plugin
docker --version
docker compose version

# ---------------------------------------------------------------------------
log "4/10 — MongoDB"
if [[ "$MONGO_MODE" == "auto" ]]; then
  if grep -qi avx /proc/cpuinfo; then
    MONGO_MODE="host"
  else
    MONGO_MODE="docker"
    warn "No AVX support detected — running MongoDB in Docker and source-building Open5GS instead of using apt (see INSTALL.md's AVX Workaround)."
  fi
fi

if [[ "$MONGO_MODE" == "host" ]]; then
  if ! command -v mongod >/dev/null 2>&1; then
    apt-get install -y -qq gnupg
    curl -fsSL https://pgp.mongodb.com/server-8.0.asc | gpg -o /usr/share/keyrings/mongodb-server-8.0.gpg --dearmor
    echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-8.0.gpg] https://repo.mongodb.org/apt/ubuntu jammy/mongodb-org/8.0 multiverse" \
      > /etc/apt/sources.list.d/mongodb-org-8.0.list
    apt-get update -qq
    apt-get install -y -qq mongodb-org
  else
    echo "mongod already installed, skipping."
  fi
  systemctl enable --now mongod
  systemctl status mongod --no-pager -l | head -5
else
  log "4/10 — MongoDB (Docker mode)"
  (cd "$REPO_ROOT/mongo_docker" && docker compose -f docker-compose-basic.yaml up -d)
fi

# ---------------------------------------------------------------------------
log "5/10 — Open5GS"
if [[ "$MONGO_MODE" == "host" ]]; then
  if ! command -v open5gs-nrfd >/dev/null 2>&1; then
    add-apt-repository -y ppa:open5gs/latest
    apt-get update -qq
    apt-get install -y -qq open5gs
  else
    echo "open5gs already installed, skipping."
  fi
else
  # No local mongod => apt's open5gs package's own dependency check hangs.
  # Build from source per INSTALL.md's "Building Open5GS from Source".
  #
  # Pinned, not a moving HEAD — real, 2026-09-23 incident: an earlier
  # fresh-VM bootstrap (no pin) built whatever upstream's default branch
  # happened to be that day (v2.8.0-202-g7953b00), 147 commits past what
  # this project's own reference host actually runs (v2.8.0-55-gc0ec755) —
  # defeating "100% full replication" at the Open5GS binary level, not just
  # config, and reproducibly broke UPF's own dual-subnet (v4+v6 on one
  # `dev:`) tun-interface bring-up on the newer commit specifically: the
  # `internet` DNN's `ogstun` came up as a device with no address (silent,
  # no error at setup time — only surfaced later as "UEs have no internet"
  # plus a `[sock] WARNING: ogs_read() failed (77:File descriptor in bad
  # state)` busy-loop), while the reference host's older commit brings the
  # exact same upf.yaml up correctly. Root cause inside upstream Open5GS's
  # own tun-setup code was not chased further — pinning to the known-good
  # commit this project is actually built/tested against sidesteps it
  # entirely and is the correct fix for "replication" regardless.
  OPEN5GS_PIN_COMMIT="c0ec755"
  if ! command -v open5gs-nrfd >/dev/null 2>&1; then
    apt-get install -y -qq \
      build-essential git meson ninja-build pkg-config cmake \
      libglib2.0-dev libgnutls28-dev libgcrypt-dev libidn11-dev \
      libmongoc-dev libbson-dev libyaml-dev libmicrohttpd-dev \
      libnghttp2-dev libsctp-dev lksctp-tools flex bison libssl-dev \
      libtalloc-dev libcurl4-openssl-dev uuid-dev liblz4-dev
    [[ -d /opt/open5gs-src ]] || git clone https://github.com/open5gs/open5gs /opt/open5gs-src
    (
      cd /opt/open5gs-src
      # Always re-checkout, even on a pre-existing clone from an earlier,
      # unpinned run (or an interrupted attempt left on the wrong commit) —
      # ninja rebuilds only what actually changed, so this is safe/fast on
      # a clone that's already at the right commit.
      git fetch origin "$OPEN5GS_PIN_COMMIT" 2>/dev/null || true
      git checkout "$OPEN5GS_PIN_COMMIT"
      [[ -d build ]] || meson setup build --prefix=/usr --sysconfdir=/etc --localstatedir=/var
      ninja -C build
      ninja -C build install
      ldconfig
    )
  else
    echo "open5gs already installed, skipping."
  fi
fi

# Idempotent regardless of install path: (re)generate unit files + enable +
# start all 17 core NFs in this project's own required order.
"$SCRIPT_DIR/generate_open5gs_systemd.sh"
"$SCRIPT_DIR/service_control.sh" start || warn "One or more core NFs failed to start — expected on a truly blank /etc/open5gs config until the NMS (or a restored backup) applies real network config. Check: systemctl status open5gs-*"

# Real, 2026-09-29 incident: none of the 17 core NFs' own logs
# (/var/log/open5gs/*.log) ever had logrotate — each one grows unbounded for
# the life of the host, and on a long-running deployment this filled the root
# filesystem to 96% before being noticed (found while chasing an unrelated
# "testing is difficult" report — slow disk I/O from a nearly-full filesystem
# was the actual cause). `copytruncate`, not the more common
# create+postrotate-reload pattern: Open5GS's NFs don't reopen their log file
# on SIGHUP or any other signal in this deployment's config, so a straight
# rename-based rotation would leave each NF writing forever into a now
# file-descriptor-orphaned, unlisted inode — invisible to `ls` and never
# actually freeing space until the process restarts. copytruncate avoids that
# entirely by truncating the same inode in place. size 200M as a secondary
# trigger alongside daily, since a single NF logging heavily (e.g. debug
# level left on) can otherwise still fill the disk well before its next
# scheduled daily rotation.
cat > /etc/logrotate.d/open5gs <<'EOF'
/var/log/open5gs/*.log {
	daily
	rotate 5
	missingok
	notifempty
	compress
	delaycompress
	copytruncate
	size 200M
}
EOF

# ---------------------------------------------------------------------------
log "6/10 — DNS sanity check"
# getent, not nslookup — real, 2026-09-23 finding: nslookup (dnsutils) isn't
# installed on a minimal Ubuntu image and isn't in this script's own step 1
# package list either, so this check always "failed" here regardless of
# real DNS state. getent hosts uses glibc's own resolver via libc-bin,
# which is always present — confirmed live this doesn't false-positive.
if ! getent hosts registry.npmjs.org >/dev/null 2>&1; then
  warn "DNS resolution looks broken (getent hosts registry.npmjs.org failed). Docker image builds need working DNS — fix /etc/resolv.conf if step 9 fails."
fi

# ---------------------------------------------------------------------------
log "7/10 — .env"
if [[ ! -f "$REPO_ROOT/.env" ]]; then
  cp "$REPO_ROOT/.env.example" "$REPO_ROOT/.env"
  if [[ -n "$FIRST_RUN_PASSWORD" ]]; then
    sed -i "s/^FIRST_RUN_PASSWORD=.*/FIRST_RUN_PASSWORD=$FIRST_RUN_PASSWORD/" "$REPO_ROOT/.env"
  fi
else
  echo ".env already exists, leaving it untouched."
fi

# ---------------------------------------------------------------------------
log "8/10 — Backup directories"
mkdir -p /etc/open5gs/backups/config /etc/open5gs/backups/mongodb
chmod 755 /etc/open5gs/backups

# ---------------------------------------------------------------------------
log "9/10 — Build and start the NMS"
if [[ "$SKIP_DOCKER_BUILD" != "1" ]]; then
  (cd "$REPO_ROOT" && docker compose build --no-cache)
fi
(cd "$REPO_ROOT" && docker compose up -d)

echo -n "Waiting for backend health check"
for _ in $(seq 1 60); do
  if curl -sf http://localhost:3001/api/health >/dev/null 2>&1; then
    echo " OK"
    break
  fi
  echo -n "."
  sleep 5
done
if ! curl -sf http://localhost:3001/api/health >/dev/null 2>&1; then
  warn "Backend did not report healthy within 5 minutes — check: docker compose logs backend"
fi

# ---------------------------------------------------------------------------
log "10/10 — Firewall"
if [[ "$SKIP_FIREWALL" != "1" ]] && command -v ufw >/dev/null 2>&1; then
  ufw allow 8888/tcp || true
  ufw allow 53/udp || true
  ufw allow 53/tcp || true
else
  echo "Skipping firewall rules (ufw not present or SKIP_FIREWALL=1)."
fi

# ---------------------------------------------------------------------------
log "Done"
echo "NMS should be reachable at: http://$(hostname -I | awk '{print $1}'):8888"
if [[ -z "$FIRST_RUN_PASSWORD" ]]; then
  echo "Retrieve the generated admin password with:"
  echo "  docker logs open5gs-nms-backend 2>&1 | grep -A4 'FIRST RUN'"
fi
echo ""
echo "Next: on the Backup page, upload a Full Backup archive and check"
echo "\"This is a fresh host\" before restoring — that installs every optional"
echo "module the backup used (IMS, VoWiFi, PSTN, ...) before writing its config."
