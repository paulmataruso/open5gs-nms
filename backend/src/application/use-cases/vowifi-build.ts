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
export const VECTORCORE_PATCH_REV = 7;
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
sed -i 's#sa\.handoverIP = ip#// NMS patch: handoverIP intentionally never set, see vowifi-build.ts#' internal/ikev2/auth.go
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
grep -qF 'NATTSrcPort:  conn.LocalAddr().(*net.UDPAddr).Port,' internal/ikev2/auth.go || { echo "ERROR: NATTSrcPort patch did not apply"; exit 1; }

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

# The half-open IKE SA reaper called s.deleteSA(spiI) directly when expiring
# a stuck half-open session (e.g. one stuck at EAPAuthenticated) —
# deleteSA() only removes the low-level IKE SA map entry, it never touches
# the separate, higher-level internal/session registry the admin API's
# /api/v1/clients endpoint actually lists, and never sends SWm STR to
# notify AAA. Confirmed live 2026-08-08: reaped half-open sessions left
# permanent zombie "EAPAuthenticated" entries in the admin API client list
# (one real deployment showed 4 entries for the same IMSI, 3 of them
# zombies) and almost certainly orphaned Diameter session state at AAA too,
# since SWm STR was never sent for these. fullTeardown() is a strict
# superset of the old behavior — it handles a partial/incomplete session
# gracefully (checks hasS2B, checks swmSessionID != "", etc.) and itself
# calls deleteSA() at the end.
grep -q 's.deleteSA(spiI)' internal/ikev2/inform.go || { echo "ERROR: inform.go patch site (half-open reaper deleteSA call) not found — upstream source may have changed, review manually"; exit 1; }
sed -i 's/s\.deleteSA(spiI)/s.fullTeardown(sa, "half_open_timeout")/' internal/ikev2/inform.go
grep -q 's.fullTeardown(sa, "half_open_timeout")' internal/ikev2/inform.go || { echo "ERROR: half-open reaper patch did not apply"; exit 1; }

# Uplink GTP-U packets were silently lost 100% of the time when the PGW is
# colocated on the same host (our deployment always colocates ePDG + UPF —
# see the project's core architecture). Root cause: the TC-BPF uplink
# program's bpf_redirect_neigh() call needs a real, ARP-resolvable L2
# neighbor for the destination — impossible for a same-host/locally-owned
# destination regardless of which interface is named as the redirect
# target (confirmed multiple ways live 2026-08-08/09: the encapsulated
# frame appears to leave the ePDG's interface in a raw packet capture, with
# a correct TEID matching the real session, but the PGW's own receive-path
# logging — instrumented directly in Open5GS UPF's source for this
# investigation — never saw a single matching entry; four different
# in-kernel-redirect variants were tried and all failed for distinct,
# specific reasons documented in this project's engineering log). Fix:
# bypass the in-kernel redirect for uplink entirely — the TC-BPF program
# now hands the selected TEID + raw inner packet to userspace via a
# BPF_MAP_TYPE_RINGBUF map, and a new Go goroutine (ulRingbufLoop)
# delivers each one with a plain UDP sendto() on the ePDG's existing GTP-U
# control socket instead — the same ordinary local-delivery path every
# other process on the host already uses successfully. Verified live: a
# real phone completed a full REGISTER -> 401 Challenge -> REGISTER -> 200
# OK -> SUBSCRIBE -> NOTIFY exchange end to end for the first time ever
# against this ePDG, and WiFi Calling showed Active on the device itself.
if grep -q 'ul_ringbuf' internal/gtpu/bpf/tc_gtpu_encap.c; then
  echo "tc_gtpu_encap.c already has the uplink ringbuf patch applied — skipping re-patch."
else
  grep -q 'bpf_redirect_neigh(sess->s2b_ifindex, &nh, sizeof(nh), 0);' internal/gtpu/bpf/tc_gtpu_encap.c || { echo "ERROR: tc_gtpu_encap.c patch site (uplink bpf_redirect_neigh call) not found — upstream source may have changed, review manually"; exit 1; }
  python3 - <<'PYEOF'
path = "internal/gtpu/bpf/tc_gtpu_encap.c"
new_content = r'''/* TC-BPF uplink GTP-U TEID selection.
 *
 * Attaches to vc-xfrm0 ingress (post-XFRM/IPsec decrypt).
 *
 * For each decrypted UE IPv4 packet:
 *   1. Look up the inner source IP in ue_session_map.
 *   2. Select the uplink TEID (default bearer, or a dedicated bearer if a
 *      tft_rule_map entry matches).
 *   3. Hand the TEID + raw inner packet to userspace via ul_ringbuf for
 *      delivery — NOT an in-kernel encap+redirect. See the ul_ringbuf
 *      comment below for why: PGW/UPF is always colocated on this host via
 *      dummy interfaces, and no in-kernel redirect mechanism
 *      (bpf_redirect_neigh()/bpf_redirect(), tried multiple ways) can
 *      reliably deliver a frame to a locally-owned destination. Go builds
 *      the GTP-U header and sends a plain UDP packet instead — see
 *      dataplane.go's ulRingbufLoop.
 *
 * Unknown source IPs pass through (TC_ACT_OK) — the kernel will drop or
 * route them normally, which is fine for control-plane traffic.
 */

#include <linux/bpf.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_endian.h>
#include <linux/if_ether.h>
#include <linux/ip.h>
#include <linux/udp.h>
#include <linux/in.h>
#include <linux/pkt_cls.h>

#define MAX_TFT_RULES 32

#define TFT_F_REMOTE_IP   0x01
#define TFT_F_PROTOCOL    0x02
#define TFT_F_LOCAL_PORT  0x04
#define TFT_F_REMOTE_PORT 0x08

#include "headers/gtpu.h"

/* ── Maps ─────────────────────────────────────────────────────────────────── */

struct ipv4_key {
    __u8 addr[4];
};

struct ue_session_entry {
    __u32 ul_teid;      /* uplink TEID, host byte order */
    __u8 pgw_ip[4];     /* PGW GTP-U destination IP, network byte order */
    __u8 local_ip[4];   /* ePDG S2b GTP-U source IP, network byte order */
    __u32 s2b_ifindex;  /* S2b interface index for redirect */
    __u32 rule_count;   /* bounded TFT rules for this UE */
};

struct tft_rule_key {
    __u8 addr[4];
    __u32 index;
};

struct tft_rule_entry {
    __u32 ul_teid;       /* selected dedicated bearer TEID, host byte order */
    __u8 precedence;
    __u8 flags;
    __u8 protocol;
    __u8 _pad;
    __u8 remote_ip[4];
    __u8 remote_mask[4];
    __u16 local_port_lo;
    __u16 local_port_hi;
    __u16 remote_port_lo;
    __u16 remote_port_hi;
};

struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __type(key,   struct ipv4_key);  /* UE inner IPv4 src, network byte order */
    __type(value, struct ue_session_entry);
    __uint(max_entries, 4096);
} ue_session_map SEC(".maps");

struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __type(key,   struct tft_rule_key);
    __type(value, struct tft_rule_entry);
    __uint(max_entries, 4096);
} tft_rule_map SEC(".maps");

/* ul_bearer_counters: TEID (host byte order) → packet/byte counters for
 * traffic encapsulated onto that bearer. Entries are created lazily on
 * first packet (see tc_gtpu_encap_func) and deleted from Go when the
 * bearer/TEID is torn down. */
struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __type(key,   __u32);
    __type(value, struct bearer_counters);
    __uint(max_entries, 4096);
} ul_bearer_counters SEC(".maps");

/* NMS fix: PGW/UPF is always colocated on this host via dummy interfaces
 * (dummy-epdg / dummy-upf) — bpf_redirect_neigh()/bpf_redirect() cannot
 * reliably deliver an in-kernel-redirected frame to a locally-owned
 * destination (extensively verified live: the frame appears to transmit
 * but never reaches the peer's actual socket, for several different
 * reasons depending on which redirect mechanism/target is used — none of
 * which apply to a genuinely remote PGW, which is the scenario this
 * upstream code was designed for). Rather than keep fighting TC-redirect
 * semantics for a same-host peer, hand the selected TEID + inner packet
 * to userspace via this ringbuf and let Go deliver it with a plain UDP
 * sendto() — the same ordinary local-delivery path every other process
 * on this host already uses successfully. See dataplane.go's
 * ulRingbufLoop. */
#define MAX_UL_PAYLOAD  1500  /* real validity limit: max plausible MTU */
#define UL_PAYLOAD_MASK 2047  /* power-of-2-minus-1, >= MAX_UL_PAYLOAD, used
                                * purely to give the verifier an easily
                                * provable bound at the load_bytes call site
                                * below (a masked value's range is trivial
                                * for the verifier to track; an arbitrary
                                * runtime value bounded only by an 'if' is
                                * not always narrowed the same way). */

struct ul_event {
    __u32 teid; /* host byte order */
    __u16 len;  /* inner packet length, bytes */
    __u8  _pad[2];
    __u8  data[UL_PAYLOAD_MASK + 1];
};

struct {
    __uint(type, BPF_MAP_TYPE_RINGBUF);
    __uint(max_entries, 262144);
} ul_ringbuf SEC(".maps");

/* ── Stats ────────────────────────────────────────────────────────────────── */

enum ul_stat {
    UL_STAT_SEEN        = 0, /* IPv4 packets entering the hook */
    UL_STAT_NOT_IPV4    = 1, /* non-IPv4 passed through */
    UL_STAT_UE_MISS     = 2, /* src IP not in ue_session_map */
    UL_STAT_ADJUST_FAIL = 3, /* bpf_skb_adjust_room failed */
    UL_STAT_STORE_FAIL  = 4, /* bpf_skb_store_bytes failed */
    UL_STAT_ENCAP_OK    = 5, /* successfully encapsulated */
    UL_STAT_REDIR_FAIL  = 6, /* bpf_redirect_neigh returned error */
    UL_STAT_MAX         = 7,
};

struct {
    __uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
    __type(key,   __u32);
    __type(value, __u64);
    __uint(max_entries, 7); /* == UL_STAT_MAX */
} ul_stats SEC(".maps");

static __always_inline void stat_inc(__u32 idx)
{
    __u64 *v = bpf_map_lookup_elem(&ul_stats, &idx);
    if (v)
        __sync_fetch_and_add(v, 1);
}

static __always_inline int ipv4_mask_match(const __u8 pkt_ip[4], const __u8 rule_ip[4], const __u8 mask[4])
{
    if (((pkt_ip[0] ^ rule_ip[0]) & mask[0]) != 0)
        return 0;
    if (((pkt_ip[1] ^ rule_ip[1]) & mask[1]) != 0)
        return 0;
    if (((pkt_ip[2] ^ rule_ip[2]) & mask[2]) != 0)
        return 0;
    if (((pkt_ip[3] ^ rule_ip[3]) & mask[3]) != 0)
        return 0;
    return 1;
}

static __always_inline int tft_rule_matches(struct tft_rule_entry *rule, struct iphdr *inner_ip,
                                            __u16 src_port, __u16 dst_port, int has_ports)
{
    if ((rule->flags & TFT_F_REMOTE_IP) &&
        !ipv4_mask_match((const __u8 *)&inner_ip->daddr, rule->remote_ip, rule->remote_mask))
        return 0;

    if ((rule->flags & TFT_F_PROTOCOL) && inner_ip->protocol != rule->protocol)
        return 0;

    if (rule->flags & TFT_F_LOCAL_PORT) {
        if (!has_ports || src_port < rule->local_port_lo || src_port > rule->local_port_hi)
            return 0;
    }

    if (rule->flags & TFT_F_REMOTE_PORT) {
        if (!has_ports || dst_port < rule->remote_port_lo || dst_port > rule->remote_port_hi)
            return 0;
    }

    return 1;
}

/* ── Program ──────────────────────────────────────────────────────────────── */

SEC("tc")
int tc_gtpu_encap_func(struct __sk_buff *skb)
{
    /* Only handle IPv4. */
    if (skb->protocol != bpf_htons(ETH_P_IP)) {
        stat_inc(UL_STAT_NOT_IPV4);
        return TC_ACT_OK;
    }

    stat_inc(UL_STAT_SEEN);

    struct ipv4_key key = {};
    if (bpf_skb_load_bytes_relative(skb, offsetof(struct iphdr, saddr), key.addr, sizeof(key.addr), BPF_HDR_START_NET) < 0)
        return TC_ACT_OK;

    struct ue_session_entry *sess = bpf_map_lookup_elem(&ue_session_map, &key);
    if (!sess) {
        stat_inc(UL_STAT_UE_MISS);
        return TC_ACT_OK;
    }

    struct iphdr inner_ip = {};
    if (bpf_skb_load_bytes_relative(skb, 0, &inner_ip, sizeof(inner_ip), BPF_HDR_START_NET) < 0)
        return TC_ACT_OK;
    if (inner_ip.version != 4 || inner_ip.ihl != 5)
        return TC_ACT_OK;

    __u16 inner_tot_be;
    if (bpf_skb_load_bytes_relative(skb, offsetof(struct iphdr, tot_len), &inner_tot_be, sizeof(inner_tot_be), BPF_HDR_START_NET) < 0)
        return TC_ACT_OK;
    __u32 inner_len = bpf_ntohs(inner_tot_be);

    __u32 selected_teid = sess->ul_teid;
    __u8 best_precedence = 255;
    int has_ports = 0;
    __u16 src_port = 0;
    __u16 dst_port = 0;
    if (inner_ip.protocol == IPPROTO_TCP || inner_ip.protocol == IPPROTO_UDP) {
        __u8 ihl = inner_ip.ihl * 4;
        __u16 ports[2] = {};
        if (bpf_skb_load_bytes_relative(skb, ihl, &ports, sizeof(ports), BPF_HDR_START_NET) == 0) {
            src_port = bpf_ntohs(ports[0]);
            dst_port = bpf_ntohs(ports[1]);
            has_ports = 1;
        }
    }

    __u32 rule_count = sess->rule_count;
    if (rule_count > MAX_TFT_RULES)
        rule_count = MAX_TFT_RULES;

    for (__u32 i = 0; i < MAX_TFT_RULES; i++) {
        if (i >= rule_count)
            break;

        struct tft_rule_key rule_key = {};
        __builtin_memcpy(rule_key.addr, key.addr, sizeof(rule_key.addr));
        rule_key.index = i;

        struct tft_rule_entry *rule = bpf_map_lookup_elem(&tft_rule_map, &rule_key);
        if (!rule)
            continue;

        if (rule->precedence >= best_precedence)
            continue;

        if (!tft_rule_matches(rule, &inner_ip, src_port, dst_port, has_ports))
            continue;

        selected_teid = rule->ul_teid;
        best_precedence = rule->precedence;
    }

    /* Hand the selected TEID + raw inner packet to userspace instead of
     * building outer headers and redirecting in-kernel (see the ul_ringbuf
     * comment above for why). Go already tracks bearersByRemoteTEID /
     * sessionsByPAA for every session, so it can resolve the destination
     * PGW IP from the TEID alone — no need to duplicate sess->pgw_ip here. */
    if (inner_len < 1)
        return TC_ACT_OK;
    if (inner_len > MAX_UL_PAYLOAD) {
        stat_inc(UL_STAT_ADJUST_FAIL);
        return TC_ACT_OK;
    }
    /* Re-clamp with a bitmask right at the point of use: some verifier
     * versions don't carry a scalar's narrowed range across the
     * bpf_ringbuf_reserve() helper call below cleanly enough to prove
     * ev->data[0..inner_len) is in-bounds and non-zero-length at the
     * bpf_skb_load_bytes_relative() call site otherwise. */
    __u32 copy_len = inner_len & UL_PAYLOAD_MASK;
    if (copy_len == 0)
        copy_len = 1;

    struct ul_event *ev = bpf_ringbuf_reserve(&ul_ringbuf, sizeof(*ev), 0);
    if (!ev) {
        stat_inc(UL_STAT_REDIR_FAIL);
        return TC_ACT_OK;
    }
    ev->teid = selected_teid;
    ev->len  = (__u16)inner_len;

    if (bpf_skb_load_bytes_relative(skb, 0, ev->data, copy_len, BPF_HDR_START_NET) < 0) {
        bpf_ringbuf_discard(ev, 0);
        stat_inc(UL_STAT_STORE_FAIL);
        return TC_ACT_OK;
    }

    bpf_ringbuf_submit(ev, 0);
    stat_inc(UL_STAT_ENCAP_OK);

    struct bearer_counters *bc = bpf_map_lookup_elem(&ul_bearer_counters, &selected_teid);
    if (!bc) {
        struct bearer_counters zero = {};
        bpf_map_update_elem(&ul_bearer_counters, &selected_teid, &zero, BPF_NOEXIST);
        bc = bpf_map_lookup_elem(&ul_bearer_counters, &selected_teid);
    }
    if (bc) {
        __sync_fetch_and_add(&bc->packets, 1);
        __sync_fetch_and_add(&bc->bytes, inner_len);
    }

    /* We're delivering this packet ourselves via ul_ringbuf/userspace —
     * consume the original so the kernel doesn't also try to route the
     * raw (non-GTP-U-encapsulated) inner packet on its own. */
    return TC_ACT_SHOT;
}

char _license[] SEC("license") = "GPL";
'''
with open(path, "w") as f:
    f.write(new_content)
print("patched tc_gtpu_encap.c (full rewrite)")
PYEOF
fi
grep -q 'ul_ringbuf SEC(".maps")' internal/gtpu/bpf/tc_gtpu_encap.c || { echo "ERROR: tc_gtpu_encap.c ringbuf patch did not apply"; exit 1; }

if grep -qF 'ulReader *ringbuf.Reader' internal/gtpu/tc_loader.go; then
  echo "tc_loader.go already has the uplink ringbuf patch applied — skipping re-patch."
else
  grep -q '"github.com/cilium/ebpf/link"' internal/gtpu/tc_loader.go || { echo "ERROR: tc_loader.go patch site (ebpf/link import) not found — upstream source may have changed, review manually"; exit 1; }
  python3 - <<'PYEOF'
path = "internal/gtpu/tc_loader.go"
with open(path) as f:
    src = f.read()

edits = [
    (
        r'''	"github.com/cilium/ebpf"
	"github.com/cilium/ebpf/link"
	"github.com/vishvananda/netlink"
)''',
        r'''	"github.com/cilium/ebpf"
	"github.com/cilium/ebpf/link"
	"github.com/cilium/ebpf/ringbuf"
	"github.com/vishvananda/netlink"
)''',
    ),
    (
        r'''	tcLink   link.Link
	xfrmLink netlink.Link // the vc-xfrm0 interface
	ifID     uint32
}''',
        r'''	tcLink   link.Link
	xfrmLink netlink.Link // the vc-xfrm0 interface
	ifID     uint32
	ulReader *ringbuf.Reader // ul_ringbuf — see UplinkRingbufReader
}''',
    ),
    (
        r'''	// ── Attach TC-BPF to XFRM interface ingress ─────────────────────────────
	d.tcLink, err = link.AttachTCX(link.TCXOptions{
		Interface: xfrmLink.Attrs().Index,
		Program:   d.objs.TcGtpuEncapFunc,
		Attach:    ebpf.AttachTCXIngress,
	})
	if err != nil {
		d.objs.Close()
		return nil, fmt.Errorf("tc: attach TC-BPF to %s ingress: %w", ifName, err)
	}

	return d, nil
}

// IfaceIndex returns the kernel index of the vc-xfrm0 interface.''',
        r'''	// ul_ringbuf carries uplink G-PDUs (TEID + inner packet) that the TC-BPF
	// program deliberately does NOT try to redirect in-kernel — see the
	// comment on ul_ringbuf in tc_gtpu_encap.c for why. Manager.ulRingbufLoop
	// reads from this and delivers them via a plain UDP sendto() instead.
	ulReader, err := ringbuf.NewReader(d.objs.UlRingbuf)
	if err != nil {
		d.objs.Close()
		return nil, fmt.Errorf("tc: open ul_ringbuf reader: %w", err)
	}
	d.ulReader = ulReader

	// ── Attach TC-BPF to XFRM interface ingress ─────────────────────────────
	d.tcLink, err = link.AttachTCX(link.TCXOptions{
		Interface: xfrmLink.Attrs().Index,
		Program:   d.objs.TcGtpuEncapFunc,
		Attach:    ebpf.AttachTCXIngress,
	})
	if err != nil {
		_ = d.ulReader.Close()
		d.objs.Close()
		return nil, fmt.Errorf("tc: attach TC-BPF to %s ingress: %w", ifName, err)
	}

	return d, nil
}

// UplinkRingbufReader returns the reader for ul_ringbuf — see the comment on
// that map in tc_gtpu_encap.c. Manager.ulRingbufLoop consumes it.
func (d *TCDataplane) UplinkRingbufReader() *ringbuf.Reader {
	return d.ulReader
}

// IfaceIndex returns the kernel index of the vc-xfrm0 interface.''',
    ),
    (
        r'''func (d *TCDataplane) Close() error {
	var first error
	if d.tcLink != nil {''',
        r'''func (d *TCDataplane) Close() error {
	var first error
	if d.ulReader != nil {
		// Close first so Manager.ulRingbufLoop's blocking Read() unblocks
		// with ringbuf.ErrClosed and exits cleanly before the underlying
		// BPF objects (closed below) go away.
		if err := d.ulReader.Close(); err != nil && first == nil {
			first = err
		}
	}
	if d.tcLink != nil {''',
    ),
]

for needle, replacement in edits:
    if needle not in src:
        raise SystemExit(f"needle not found:\\n{needle[:120]}")
    src = src.replace(needle, replacement, 1)

with open(path, "w") as f:
    f.write(src)
print("patched tc_loader.go")
PYEOF
fi
grep -qF 'ulReader *ringbuf.Reader' internal/gtpu/tc_loader.go || { echo "ERROR: tc_loader.go ringbuf patch did not apply"; exit 1; }

if grep -qF 'func (m *Manager) ulRingbufLoop' internal/gtpu/dataplane.go; then
  echo "dataplane.go already has the uplink ringbuf patch applied — skipping re-patch."
else
  grep -q '"github.com/cilium/ebpf"' internal/gtpu/dataplane.go || { echo "ERROR: dataplane.go patch site (ebpf import) not found — upstream source may have changed, review manually"; exit 1; }
  python3 - <<'PYEOF'
path = "internal/gtpu/dataplane.go"
with open(path) as f:
    src = f.read()

edits = [
    (
        r'''	"github.com/cilium/ebpf"
	"github.com/vishvananda/netlink"
	"golang.org/x/sys/unix"''',
        r'''	"github.com/cilium/ebpf"
	"github.com/cilium/ebpf/ringbuf"
	"github.com/vishvananda/netlink"
	"golang.org/x/sys/unix"''',
    ),
    (
        r'''	goroutines := 2
	goroutines++ // bpfStatsLoop
	m.wg.Add(goroutines)
	go m.udpReadLoop(runCtx)
	go m.pathEchoLoop(runCtx)
	go m.bpfStatsLoop(runCtx)
	return nil
}''',
        r'''	goroutines := 2
	goroutines++ // bpfStatsLoop
	goroutines++ // ulRingbufLoop
	m.wg.Add(goroutines)
	go m.udpReadLoop(runCtx)
	go m.pathEchoLoop(runCtx)
	go m.bpfStatsLoop(runCtx)
	go m.ulRingbufLoop(runCtx)
	return nil
}''',
    ),
    (
        r'''// bearerCounterReader reads per-TEID packet/byte counters from a BPF map.''',
        r'''// ulRingbufLoop reads uplink G-PDUs (TEID + raw inner packet) off ul_ringbuf
// and delivers each one to the PGW with a plain UDP sendto() on the same
// GTP-U control socket (m.udp) everything else in this file already uses.
//
// NMS fix: the TC-BPF program deliberately does NOT try to redirect these
// in-kernel anymore — see the ul_ringbuf comment in tc_gtpu_encap.c. PGW/UPF
// is always colocated on this host via dummy interfaces, and
// bpf_redirect_neigh()/bpf_redirect() cannot reliably deliver a
// kernel-redirected frame to a locally-owned destination (verified multiple
// ways live: the frame appears to transmit but the peer's own receive path
// never sees it, for different reasons depending on which redirect
// mechanism/target is used — none of which apply to a real remote PGW,
// which is the scenario the upstream redirect design targets). A normal
// userspace socket send uses the kernel's ordinary, well-trodden
// local-delivery path instead, sidestepping all of that.
func (m *Manager) ulRingbufLoop(ctx context.Context) {
	defer m.wg.Done()
	m.markLoop("ulRingbuf", true)
	defer m.markLoop("ulRingbuf", false)

	if m.tc == nil {
		return
	}
	reader := m.tc.UplinkRingbufReader()
	if reader == nil {
		return
	}

	for {
		record, err := reader.Read()
		if err != nil {
			if ctx.Err() != nil || errors.Is(err, ringbuf.ErrClosed) {
				return
			}
			m.log.Warn("uplink ringbuf read failed", "error", err)
			continue
		}

		raw := record.RawSample
		if len(raw) < 8 {
			continue
		}
		teid := binary.LittleEndian.Uint32(raw[0:4])
		plen := int(binary.LittleEndian.Uint16(raw[4:6]))
		if 8+plen > len(raw) {
			m.log.Warn("uplink ringbuf event has invalid length", "teid", teid, "len", plen, "raw_len", len(raw))
			continue
		}
		inner := raw[8 : 8+plen]

		m.mu.RLock()
		ref := m.bearersByRemoteTEID[teid]
		var pgwIP net.IP
		if ref != nil {
			if ds, ok := m.sessionsByID[ref.SessionID]; ok {
				if b, ok := ds.Bearers[ref.BearerEBI]; ok {
					pgwIP = b.PGWGTPUIP
				}
			}
		}
		m.mu.RUnlock()
		if pgwIP == nil {
			// Bearer was torn down between the eBPF program's map lookup
			// and this read — same as the existing UE_MISS/no-context case,
			// nothing meaningful to do with an orphaned uplink packet.
			continue
		}

		pkt, err := encodeGPDU(teid, inner)
		if err != nil {
			m.log.Warn("uplink G-PDU encode failed", "teid", teid, "error", err)
			continue
		}
		if _, err := m.udp.WriteToUDP(pkt, &net.UDPAddr{IP: pgwIP, Port: config.GTPUPort}); err != nil {
			m.log.Warn("uplink G-PDU send failed", "teid", teid, "pgw", pgwIP.String(), "error", err)
		}
	}
}

// encodeGPDU builds a GTP-U T-PDU (G-PDU) message: 8-byte header (version=1,
// PT=1, no optional fields) + the raw inner packet as payload. Mirrors the
// eBPF uplink encapsulator's header layout (tc_gtpu_encap.c's GTP_FLAGS/
// GTPU_G_PDU) exactly, just built in Go instead of in-kernel.
func encodeGPDU(teid uint32, inner []byte) ([]byte, error) {
	if len(inner) > 0xffff {
		return nil, fmt.Errorf("GTP-U G-PDU payload too large: %d", len(inner))
	}
	out := make([]byte, 8+len(inner))
	out[0] = gtpuVersionPT
	out[1] = gtpuMsgTPDU
	binary.BigEndian.PutUint16(out[2:4], uint16(len(inner)))
	binary.BigEndian.PutUint32(out[4:8], teid)
	copy(out[8:], inner)
	return out, nil
}

// bearerCounterReader reads per-TEID packet/byte counters from a BPF map.''',
    ),
]

for needle, replacement in edits:
    if needle not in src:
        raise SystemExit(f"needle not found:\\n{needle[:120]}")
    src = src.replace(needle, replacement, 1)

with open(path, "w") as f:
    f.write(src)
print("patched dataplane.go")
PYEOF
fi
grep -qF 'func (m *Manager) ulRingbufLoop' internal/gtpu/dataplane.go || { echo "ERROR: dataplane.go ringbuf patch did not apply"; exit 1; }

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
grep -qF 'PdpTypeNr, [],' src/aaa_ue_fsm.erl || { echo "ERROR: Authorization AVP patch did not apply"; exit 1; }

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
