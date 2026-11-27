import * as fs from 'fs';
import { safeNsenter } from '../../infrastructure/system/safe-nsenter';
import { SERVICE_UNIT_MAP, ServiceName } from '../../domain/entities/service-status';

// ── MongoDB boot-race gate ───────────────────────────────────────────────────
//
// Real, twice-confirmed outage (2026-11-25 and again 2026-11-27, both after a
// power loss on this deployment): the host comes back with 13 of 17 NFs
// healthy and exactly four — udr, pcf, hss, pcrf — stopped. Those four are
// precisely the DB-backed NFs. They started before MongoDB was accepting
// connections, failed to connect, and exited.
//
// What makes it a PERMANENT outage rather than a slow start is the amplifier,
// and it is worth stating exactly: Open5GS exits with status 0 on a failed
// database connect. systemd therefore records `Result=success`, the stock
// `Restart=on-failure` policy does not consider that a failure, `NRestarts`
// stays 0, and nothing ever retries. `systemctl reset-failed` finds nothing to
// reset because nothing ever failed in systemd's view. 4G S6a/Gx is down, 5G
// subscriber lookups are down, and the dashboard looks mostly green.
//
// This is the same shape as the 2026-10-06 DNS boot race (see
// installDnsBootGate() in bind-controller.ts) and takes the same two-layer
// treatment, for the same reason: the real liability is the amplifier, not any
// one cause. Any MongoDB unavailability at boot, from any cause, currently
// becomes a permanent manual-intervention outage.
//
//  1. A readiness barrier (open5gs-mongo-ready.service) that does not complete
//     until MongoDB actually answers.
//  2. `Restart=always` on the DB-backed NFs. This is the half that actually
//     fixes the bug: with `Restart=on-failure`, an exit-0 failure can never be
//     retried no matter how patient the budget is. The existing restart budget
//     on these units (StartLimitBurst=60/600s, installed by the DNS gate) was
//     therefore dead code for this failure mode.
//
// ── Why this does not assume how MongoDB is deployed ────────────────────────
//
// This project supports at least three arrangements and must not privilege the
// one in front of it:
//
//   - MONGO_MODE=host   — `mongodb-org` 8.0 from apt, as `mongod.service`.
//                         bootstrap-fresh-host.sh picks this when the CPU has
//                         AVX, which is the common case.
//   - MONGO_MODE=docker — a `mongo:4.4` container (`mongo_docker/`), picked
//                         automatically on a host without AVX, where MongoDB 5+
//                         cannot run at all. There is NO mongod.service here, so
//                         there is nothing for systemd to order against — which
//                         is exactly why the race is unrecoverable in this mode.
//   - a remote or replica-set MongoDB reached over the network, where neither a
//     local unit nor a local container exists.
//
// So the gate never asks "is mongod active" or "is the container up". It reads
// the endpoints out of the NFs' own `db_uri` values and waits for one to
// answer. That single question is correct in all three arrangements, and it
// also survives a later `db_uri` change with no reinstall, because the script
// re-derives the endpoints at every boot rather than baking them in.
//
// Ordering dependencies ARE mode-specific, so they are emitted per host at
// install time from what actually exists (mongod.service / mongodb.service /
// docker.service) instead of being hardcoded. `docker.service` gets ordering
// only and never a Wants=, so a host-mode deployment that happens to have
// Docker installed is not made to depend on it.
//
// Bump MONGO_BOOT_GATE_REV whenever the generated content below changes —
// installMongoBootGate() reinstalls on a rev mismatch. The rev is stamped into
// each generated file and checked rather than assumed, because this project has
// repeatedly been bitten by an edited source that never reached the host (see
// CLAUDE.md's Kamailio patching-step gotcha and its four recurrences).
export const MONGO_BOOT_GATE_REV = 1;

const GATE_SCRIPT_PATH = '/usr/local/sbin/open5gs-wait-mongo.sh';
const GATE_UNIT_NAME   = 'open5gs-mongo-ready.service';
const GATE_DROPIN_NAME = '10-mongo-boot-race.conf';
const GATE_REV_TAG     = `open5gs-nms mongo-boot-gate rev ${MONGO_BOOT_GATE_REV}`;

// Generous. A dirty journal replay after a power loss is the exact scenario
// this exists for, and in Docker mode the container cannot even be created
// until dockerd itself has finished starting. A genuinely broken (not merely
// slow) MongoDB costs this much boot delay before the gate releases and hands
// the problem to layer 2.
const GATE_WAIT_SECONDS = 300;

const HOST_OPEN5GS_DIR = '/proc/1/root/etc/open5gs';

// Candidate units to order after, if present on this host. Checked rather than
// assumed — see the mode discussion above.
const MONGO_HOST_UNITS = ['mongod.service', 'mongodb.service'];
const MONGO_CONTAINER_RUNTIME_UNIT = 'docker.service';

// Fallback only, for a host whose /etc/open5gs is not populated yet at install
// time (a fresh-host bootstrap can reach this before the open5gs packages have
// landed). The live set is always derived from which configs actually carry a
// db_uri; this list just means a fresh host is covered rather than silently
// getting an empty gate.
const DB_BACKED_FALLBACK: ServiceName[] = ['udr', 'pcf', 'hss', 'pcrf'];

export function mongoGateScript(): string {
  return `#!/bin/bash
# ${GATE_REV_TAG} — generated by mongo-boot-gate.ts, do not hand-edit.
#
# Block until MongoDB actually answers, so the DB-backed Open5GS NFs do not
# start, fail to connect, and exit 0 (which systemd records as success and
# never retries). See mongo-boot-gate.ts for the real outage behind this.
#
# Deliberately asks only "does something answer at the endpoint the NFs
# themselves are configured to use". That question is correct whether MongoDB
# is a host mongod, a container, or remote, and it keeps working after a
# db_uri change because the endpoints are re-derived here on every boot.
set -u
TIMEOUT=\${1:-${GATE_WAIT_SECONDS}}
TAG=open5gs-wait-mongo

# One group per db_uri. NOT named GROUPS: that is a bash special variable
# holding the current user's group membership, and assignments to it are
# silently ignored -- which made the gate wait out its whole timeout on every
# boot. Caught by a real test; do not rename this back.
# Within a group the hosts are a replica-set seed list,
# so ANY of them answering is enough; every group must be satisfied, since two
# different db_uri values are two genuinely different databases.
URI_GROUPS=()

while IFS= read -r uri; do
  [ -n "$uri" ] || continue
  case "$uri" in
    mongodb+srv://*)
      # A DNS seedlist carries no port and resolves through SRV records; there
      # is nothing to TCP-probe. Skip rather than guess, and let layer 2 (the
      # NFs' own Restart=always) cover it.
      logger -t "$TAG" "Skipping mongodb+srv URI (DNS seedlist, nothing to probe): $uri"
      continue ;;
    mongodb://*) ;;
    *) continue ;;
  esac
  rest=\${uri#mongodb://}
  rest=\${rest%%/*}        # drop /database and anything after it
  rest=\${rest%%\\?*}       # drop ?options when there is no /database
  rest=\${rest##*@}        # drop user:password@ (a host part cannot contain @)
  group=""
  IFS=',' read -r -a hostlist <<< "$rest"
  for h in "\${hostlist[@]}"; do
    [ -n "$h" ] || continue
    case "$h" in
      \\[*\\]*)                                   # [::1]:27017 — IPv6 literal
        host=\${h%%\\]*}; host=\${host#\\[}
        port=\${h##*\\]}; port=\${port#:} ;;
      *:*) host=\${h%%:*}; port=\${h##*:} ;;
      *)   host=$h;       port=27017 ;;
    esac
    [ -n "$port" ] || port=27017
    group="$group $host/$port"
  done
  [ -n "$group" ] && URI_GROUPS+=("\${group# }")
done < <(sed -nE 's/^[[:space:]]*db_uri:[[:space:]]*//p' /etc/open5gs/*.yaml 2>/dev/null \\
         | sed -E "s/[\\"']//g" | sort -u)

if [ \${#URI_GROUPS[@]} -eq 0 ]; then
  logger -t "$TAG" "No usable db_uri in /etc/open5gs/*.yaml -- nothing to wait for"
  exit 0
fi

# A socket that accepts is the authoritative signal that MongoDB is up: mongod
# binds its port at the end of startup, once it is ready to serve. A real ping
# is a stronger proof and is preferred -- but it must never be able to WITHHOLD
# readiness indefinitely, because the two failure directions are not
# symmetric. Declaring ready too early costs a few Restart=always retries and
# self-heals in seconds; refusing to declare ready costs the FULL timeout on
# every boot, silently. So a failing ping holds the gate only for PING_GRACE
# seconds (covering the bound-but-still-starting window), after which TCP alone
# is accepted and the weaker proof is named in the log.
# Returns 0 ready, 1 answered but not serving yet, 2 no client to ask with.
mongo_ping() {
  local host=$1 port=$2 out
  if command -v mongosh >/dev/null 2>&1; then
    out=$(timeout 10 mongosh --quiet --host "$host" --port "$port" \\
            --eval 'db.adminCommand({ping:1}).ok' 2>/dev/null)
  elif command -v mongo >/dev/null 2>&1; then
    out=$(timeout 10 mongo --quiet --host "$host" --port "$port" \\
            --eval 'db.adminCommand({ping:1}).ok' 2>/dev/null)
  elif command -v docker >/dev/null 2>&1; then
    # Docker mode installs no client on the host, but the container has one.
    # mongo:4.4 ships the legacy 'mongo' shell; 6+ ships 'mongosh'.
    local c
    c=$(docker ps --format '{{.Names}} {{.Image}}' 2>/dev/null \\
         | awk '$2 ~ /(^|\\/)mongo(:|$)/ { print $1; exit }')
    [ -n "$c" ] || return 2
    # Must target the CONFIGURED endpoint. An earlier version ran a bare
    # --eval, which pings whatever the container's own default is and so
    # reported a healthy database for ANY listening port -- confirmed live
    # against port 22. The values go in as argv ($1/$2), never interpolated
    # into the shell string, since they come out of a config file.
    out=$(timeout 10 docker exec "$c" sh -c \\
            'mongosh --quiet --host "$1" --port "$2" --eval "db.adminCommand({ping:1}).ok" 2>/dev/null \\
             || mongo --quiet --host "$1" --port "$2" --eval "db.adminCommand({ping:1}).ok" 2>/dev/null' \\
            _ "$host" "$port" 2>/dev/null)
  else
    return 2
  fi
  # An EXACT match, not a substring. Confirmed live: the legacy mongo shell
  # writes its connection error to STDOUT, and that text contains a 1 in
  # several places ("...:27999", ":374:17", "exiting with code 1"), so a *1*
  # glob reports a healthy database when nothing answered at all -- precisely
  # the case this ping exists to catch. A successful ping is the single byte 1.
  out=$(printf '%s' "$out" | tr -d '[:space:]')
  [ "$out" = "1" ] && return 0
  return 1
}

# A bare redirect can hang for the full TCP connect timeout on an unroutable
# address, which would make the loop below far less responsive than it looks.
tcp_open() {
  timeout 2 bash -c "exec 3<>/dev/tcp/$1/$2" 2>/dev/null
}

PROOF=""
PING_GRACE=30

group_ready() {
  local ep host port rc
  for ep in $1; do
    host=\${ep%/*}; port=\${ep##*/}
    tcp_open "$host" "$port" || continue
    mongo_ping "$host" "$port"; rc=$?
    [ $rc -eq 0 ] && { PROOF="ping"; return 0; }
    [ $rc -eq 2 ] && { PROOF="no-client"; return 0; }
    # rc=1: listening, but the ping did not answer. Keep waiting -- but only
    # until the grace expires. See mongo_ping's note on the asymmetry.
    [ $((SECONDS-start)) -ge $PING_GRACE ] && { PROOF="ping-failed"; return 0; }
  done
  return 1
}

start=$SECONDS
while :; do
  ready=1
  for g in "\${URI_GROUPS[@]}"; do
    group_ready "$g" || { ready=0; break; }
  done
  if [ "$ready" -eq 1 ]; then
    case "$PROOF" in
      ping)
        logger -t "$TAG" "MongoDB ready after $((SECONDS-start))s (ping answered)" ;;
      no-client)
        logger -t "$TAG" "MongoDB reachable after $((SECONDS-start))s (TCP only -- no client available to ping with)" ;;
      ping-failed)
        logger -t "$TAG" "WARNING: MongoDB port open but no ping answer in \${PING_GRACE}s -- releasing on TCP alone; check the db_uri actually points at MongoDB" ;;
    esac
    exit 0
  fi
  if [ $((SECONDS-start)) -ge "$TIMEOUT" ]; then
    # Deliberately exit 0, never 1: this gate must never be able to wedge the
    # core permanently. Releasing hands the problem to each NF's own
    # Restart=always budget (see the ${GATE_DROPIN_NAME} drop-ins), which will
    # pick the NF up by itself whenever MongoDB does arrive.
    logger -t "$TAG" "WARNING: MongoDB not reachable after \${TIMEOUT}s -- releasing gate; NF restart budgets will keep retrying"
    exit 0
  fi
  sleep 1
done
`;
}

export function mongoGateUnit(orderAfter: string[]): string {
  const after = ['network.target', ...orderAfter].join(' ');
  // Wants= only for a real MongoDB unit. docker.service gets ordering alone:
  // "if Docker is starting this boot, wait for it" costs nothing and never
  // pulls Docker in on a host-mode deployment.
  const wants = orderAfter.filter(u => u !== MONGO_CONTAINER_RUNTIME_UNIT);
  return `# ${GATE_REV_TAG} — generated by mongo-boot-gate.ts, do not hand-edit.
# MongoDB readiness barrier for the Open5GS core. The DB-backed NFs must not
# start before this completes. See ${GATE_SCRIPT_PATH}.
#
# After=/Wants= below were generated from the units that actually exist on this
# host, so they differ between a host-mongod and a containerised MongoDB. The
# readiness check itself is mode-agnostic.
[Unit]
Description=Wait for MongoDB to actually answer before starting Open5GS NFs
After=${after}
${wants.length > 0 ? `Wants=${wants.join(' ')}\n` : ''}
[Service]
Type=oneshot
# Stay active after exiting so After= ordering also holds for a later manual
# start of a single NF, not just for the boot sequence.
RemainAfterExit=yes
ExecStart=${GATE_SCRIPT_PATH} ${GATE_WAIT_SECONDS}
# Must exceed the script's own timeout so systemd never kills it mid-wait.
TimeoutStartSec=${GATE_WAIT_SECONDS + 60}

[Install]
WantedBy=multi-user.target
`;
}

export function mongoGateNfDropIn(): string {
  return `# ${GATE_REV_TAG} — generated by mongo-boot-gate.ts, do not hand-edit.
#
# Survive a MongoDB-not-ready-yet boot. See mongo-boot-gate.ts for the real
# twice-repeated power-loss outage this fixes.
#
# Restart=always is the load-bearing line, and the reason is specific: Open5GS
# exits with status 0 when it cannot reach the database, so systemd records
# Result=success and the stock Restart=on-failure never fires. The NF stays
# stopped forever with NRestarts=0 and nothing to reset-failed. Only
# Restart=always retries an exit-0 failure.
#
# A requested stop is not a restart trigger in systemd, so this does not fight
# \`systemctl stop\` or the NMS's own service controls. The StartLimit budget
# bounds a genuinely broken config to ~5 minutes of retrying (60 starts at
# RestartSec=5) rather than letting it spin forever filling the journal. After
# that systemd refuses and the unit sits in FAILED state — which, unlike the
# silent \`inactive\` this bug produces, is a state monitoring can see and
# \`systemctl reset-failed\` can actually clear.
[Unit]
After=${GATE_UNIT_NAME}
Wants=${GATE_UNIT_NAME}
StartLimitIntervalSec=600
StartLimitBurst=60

[Service]
Restart=always
RestartSec=5
`;
}

async function unitExists(unit: string): Promise<boolean> {
  try {
    await safeNsenter('systemctl', ['cat', unit], 10000);
    return true;
  } catch {
    return false;
  }
}

// Which NFs actually talk to MongoDB on THIS deployment, read from the configs
// rather than from a hardcoded list — so an NF that gains or loses a db_uri is
// picked up automatically instead of being silently missed.
export function dbBackedServicesFromConfigs(dir = HOST_OPEN5GS_DIR): ServiceName[] {
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.yaml'));
  } catch {
    return [...DB_BACKED_FALLBACK];
  }
  const found: ServiceName[] = [];
  for (const file of files) {
    let raw: string;
    try {
      raw = fs.readFileSync(`${dir}/${file}`, 'utf-8');
    } catch {
      continue;
    }
    if (!/^[ \t]*db_uri[ \t]*:/m.test(raw)) continue;
    const name = file.replace(/\.yaml$/, '') as ServiceName;
    if (name in SERVICE_UNIT_MAP) found.push(name);
  }
  return found.length > 0 ? found : [...DB_BACKED_FALLBACK];
}

export interface MongoBootGateStatus {
  installed: boolean;      // script, unit AND every applicable drop-in at the current rev
  deployedRev: number | null;
  currentRev: number;
  missingDropIns: string[];
}

// Deliberately also checks the per-NF drop-ins, not just the gate's own two
// files. On a genuinely fresh host the backend can start before the Open5GS
// packages have landed, in which case installMongoBootGate() writes the script
// and the unit but finds no NF units to drop into. Reporting that as installed
// would stamp the rev and mean the drop-ins — the half that actually fixes the
// bug — were never written and would never be retried. Reporting it as NOT
// installed makes the unconditional startup call self-healing instead.
export function checkMongoBootGate(): MongoBootGateStatus {
  let deployedRev: number | null = null;
  try {
    const raw = fs.readFileSync(`/proc/1/root${GATE_SCRIPT_PATH}`, 'utf-8');
    const m = raw.match(/mongo-boot-gate rev (\d+)/);
    if (m) deployedRev = Number(m[1]);
  } catch { /* not installed */ }
  const unitPresent = fs.existsSync(`/proc/1/root/etc/systemd/system/${GATE_UNIT_NAME}`);

  const missingDropIns: string[] = [];
  for (const svc of dbBackedServicesFromConfigs()) {
    const unit = SERVICE_UNIT_MAP[svc];
    // Only a unit that actually exists on this host can be missing a drop-in;
    // an NF this deployment does not have installed is not a gap.
    if (!fs.existsSync(`/proc/1/root/etc/systemd/system/${unit}.service`) &&
        !fs.existsSync(`/proc/1/root/lib/systemd/system/${unit}.service`) &&
        !fs.existsSync(`/proc/1/root/usr/lib/systemd/system/${unit}.service`)) continue;
    const dropIn = `/proc/1/root/etc/systemd/system/${unit}.service.d/${GATE_DROPIN_NAME}`;
    let ok = false;
    try {
      ok = fs.readFileSync(dropIn, 'utf-8').includes(GATE_REV_TAG);
    } catch { /* missing */ }
    if (!ok) missingDropIns.push(unit);
  }

  return {
    installed: unitPresent && deployedRev === MONGO_BOOT_GATE_REV && missingDropIns.length === 0,
    deployedRev,
    currentRev: MONGO_BOOT_GATE_REV,
    missingDropIns,
  };
}

export interface MongoBootGateInstallResult {
  units: string[];
  skipped: string[];
  orderAfter: string[];
}

// Installs (or re-installs, on a rev bump) the MongoDB readiness gate and the
// per-NF drop-ins. Idempotent — safe to call unconditionally.
//
// Deliberately regenerated from these constants rather than archived into a
// backup and restored: a restored copy is a point-in-time artifact that can
// silently be older than the code, which is the stale-artifact bug class this
// project keeps rediscovering.
export async function installMongoBootGate(): Promise<MongoBootGateInstallResult> {
  const orderAfter: string[] = [];
  for (const unit of MONGO_HOST_UNITS) {
    if (await unitExists(unit)) orderAfter.push(unit);
  }
  if (await unitExists(MONGO_CONTAINER_RUNTIME_UNIT)) orderAfter.push(MONGO_CONTAINER_RUNTIME_UNIT);

  fs.mkdirSync('/proc/1/root/usr/local/sbin', { recursive: true });
  fs.writeFileSync(`/proc/1/root${GATE_SCRIPT_PATH}`, mongoGateScript(), { encoding: 'utf-8', mode: 0o755 });
  // writeFileSync's mode only applies when creating the file — chmod explicitly
  // so a re-install over an existing file cannot leave it non-executable.
  fs.chmodSync(`/proc/1/root${GATE_SCRIPT_PATH}`, 0o755);
  fs.writeFileSync(`/proc/1/root/etc/systemd/system/${GATE_UNIT_NAME}`, mongoGateUnit(orderAfter), 'utf-8');

  const units: string[] = [];
  const skipped: string[] = [];
  for (const svc of dbBackedServicesFromConfigs()) {
    const unit = SERVICE_UNIT_MAP[svc];
    if (!(await unitExists(`${unit}.service`))) { skipped.push(unit); continue; }
    const dir = `/proc/1/root/etc/systemd/system/${unit}.service.d`;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${dir}/${GATE_DROPIN_NAME}`, mongoGateNfDropIn(), 'utf-8');
    units.push(unit);
  }

  await safeNsenter('systemctl', ['daemon-reload'], 30000);
  await safeNsenter('systemctl', ['enable', GATE_UNIT_NAME], 20000);
  // Start it now too: RemainAfterExit keeps it active, so an NF restarted later
  // in this same session does not block on a gate that has never run. MongoDB
  // is reachable whenever this runs from a live backend, so it returns at once.
  await safeNsenter('systemctl', ['start', GATE_UNIT_NAME], (GATE_WAIT_SECONDS + 60) * 1000);
  return { units, skipped, orderAfter };
}
