import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// Quick one-off host commands. The actual multi-minute build itself runs as a separate
// detached script (see vowifi-controller.ts), not through this — same split as
// frr-source-build.ts.
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

export const BUILD_WORKDIR = '/opt/vowifi-build';
export const OSMO_EPDG_TAG = '0.1.2';
// Bumped whenever a new local source patch is added below to the vendored
// osmo-epdg tree, independent of OSMO_EPDG_TAG (the upstream git tag never
// changes for these — they're local patches on top of it). Lets
// vowifi-controller.ts's buildStale check detect "same upstream tag, but an
// older deployment is missing a since-added local patch" the same way
// mms-controller.ts's installedWithVersion/installStale does for its own
// install-time source patch, without forcing a reinstall for unrelated app
// version bumps that have nothing to do with this vendored source tree.
export const OSMO_EPDG_PATCH_REV = 5;
export const STRONGSWAN_EPDG_BRANCH = 'fix_dns_parse';
export const RUNTIME_BIN_DIR = '/usr/local/bin';
export const OSMO_EPDG_RUNTIME_DIR = '/var/lib/vowifi-osmo-epdg';
export const OSMO_EPDG_CONFIG_DIR = '/etc/osmocom';

export const VOWIFI_BUILD_STEPS = [
  'preparing', 'installing_libosmocore', 'installing_osmo_epdg', 'installing_strongswan', 'verifying',
] as const;
export type VowifiBuildStep = typeof VOWIFI_BUILD_STEPS[number];

// Clears the stale kernel GTP netlink state that otherwise makes `gtp0` interface creation
// intermittently fail with EEXIST — confirmed empirically to be a real, recurring issue on
// this kernel's `gtp` module, not a one-off. Safe to run whether or not the module is
// currently loaded (the `|| true` on rmmod tolerates "not loaded").
export const GTP_MODULE_RELOAD_SCRIPT = 'rmmod gtp 2>/dev/null || true; modprobe gtp';

export async function reloadGtpModule(): Promise<void> {
  await nsenter('bash', ['-c', GTP_MODULE_RELOAD_SCRIPT], 15000);
}

// Generates the from-source build script for the full VoWiFi stack: libosmocore (master —
// the Ubuntu apt package is missing the EPDG-specific GSUP message types/PCO fields the
// strongswan-epdg plugin needs), osmo-epdg (Erlang, pinned tag), strongswan-epdg (patched
// fork). Everything installs into standard prefixes (/usr, /usr/local) — nothing here
// touches a running service; that only happens in vowifi-controller.ts's Configure step.
//
// gsupPort is embedded into the strongswan-epdg C plugin source before it's built, because
// that port is hardcoded in osmo_epdg_plugin.c with no config option — see
// docs/session notes: default 4222 collides with the existing SMS-over-SGs OsmoHLR.
export function buildVowifiScript(opts: { gsupPort: number }): string {
  if (!Number.isInteger(opts.gsupPort) || opts.gsupPort < 1 || opts.gsupPort > 65535) {
    throw new Error(`Invalid gsupPort: ${JSON.stringify(opts.gsupPort)}`);
  }

  return `#!/bin/bash
set -e
export DEBIAN_FRONTEND=noninteractive

start_heartbeat() {
  ( while true; do sleep 15; echo "... still working (\${SECONDS}s in this phase)"; done ) &
  echo $! > /tmp/vowifi-build-heartbeat.pid
}
stop_heartbeat() {
  if [ -f /tmp/vowifi-build-heartbeat.pid ]; then
    kill "$(cat /tmp/vowifi-build-heartbeat.pid)" 2>/dev/null || true
    rm -f /tmp/vowifi-build-heartbeat.pid
  fi
}
trap stop_heartbeat EXIT

echo "==STEP:preparing=="
avail_kb=$(df -Pk /opt | tail -1 | awk '{print $4}')
if [ "$avail_kb" -lt 3000000 ]; then
  echo "ERROR: less than ~3GB free under /opt (have: ${'$'}{avail_kb}KB) — aborting before a long build fills the disk."
  exit 1
fi

# Ubuntu's packaged libosmocore-dev is missing the EPDG-specific GSUP additions we need —
# remove it first (if present) so its headers don't shadow the from-source build below.
# Its runtime .so is left alone (different soname from what we build, and osmo-hlr/osmo-msc/
# osmo-stp — the existing SMS-over-SGs stack — depend on that exact runtime package).
apt-get remove -y libosmocore-dev 2>/dev/null || true

apt-get update -qq
apt-get install -y \\
  erlang rebar3 \\
  git autoconf automake libtool pkg-config gperf bison flex \\
  libgmp-dev libssl-dev libgcrypt-dev build-essential \\
  gettext autopoint \\
  libtalloc-dev liburing-dev libpcsclite-dev libusb-1.0-0-dev \\
  libgnutls28-dev libsystemd-dev libmnl-dev libsctp-dev \\
  net-tools iproute2 nftables

mkdir -p ${BUILD_WORKDIR}
mkdir -p ${OSMO_EPDG_RUNTIME_DIR}/log
mkdir -p ${OSMO_EPDG_CONFIG_DIR}

echo "==STEP:installing_libosmocore=="
cd ${BUILD_WORKDIR}
rm -rf libosmocore
start_heartbeat
git clone --depth 1 https://gitea.osmocom.org/osmocom/libosmocore
stop_heartbeat
cd libosmocore
autoreconf -fi
./configure --prefix=/usr
start_heartbeat
make -j"$(nproc)"
stop_heartbeat
make install
ldconfig

echo "==STEP:installing_osmo_epdg=="
cd ${BUILD_WORKDIR}
rm -rf osmo-epdg
start_heartbeat
git clone --branch ${OSMO_EPDG_TAG} --depth 1 https://gitea.osmocom.org/erlang/osmo-epdg
stop_heartbeat
cd osmo-epdg

# ─── Apply the 5 source patches proven working in manual testing — BEFORE the build below,
# so the compiled escript actually includes them ───
# 1) osmo-epdg's SWx callback never read the HSS-provided static IP (Served-Party-IP-Address)
#    for a subscriber — it only parsed the PGW address from the same AVP structure, silently
#    dropping everything else. Without this, VoWiFi sessions always request dynamic IP
#    allocation from SMF regardless of what's configured on the subscriber, which can hand
#    out an IP already in active use by a real UE.
# 2) epdg_ue_fsm.erl needs to carry that static IP through its state machine.
# 3) epdg_gtpc_s2b.erl needs to use it in the GTP-C Create Session Request's PDN Address
#    Allocation IE instead of always hardcoding 0.0.0.0.
# 4) gsup_server.erl needs to reject any PDN attach for an APN other than "ims" before it
#    ever reaches epdg_ue_fsm — see the patch below (OSMO_EPDG_PATCH_REV) for the full
#    reasoning; this fixes a real duplicate-UE-IP bug confirmed live on 2026-07-31 (see
#    PROJECT_STATE.md Known Issues #9 and docs/vectorcore-epdg-integration-plan.md).
# 5) epdg_gtpc_s2b.erl's find_or_new_gtp_session/3 blindly reused an existing #gtp_session{}
#    for a repeat/reconnect from the same IMSI without checking whether its default bearer
#    was still valid. A stale session left with default_bearer_id pointing at an
#    already-removed bearer made gtp_session_default_bearer/1 return the atom 'undefined',
#    which then crashed gen_create_session_request/4 with {badrecord, undefined} on
#    Bearer#gtp_bearer.ebi — confirmed live 2026-08-01, reproduced twice with an identical
#    stack trace, both times on a real device's 2nd+ VoWiFi tunnel attempt for the same
#    IMSI. Worse: the crash cascaded — the supervisor's restart of the crashed
#    epdg_gtpc_s2b also re-triggered aaa_diameter_swx:start_link(), which collided with an
#    already-running instance 5 times running into reached_max_restart_intensity, which
#    took down the *entire* osmo_epdg OTP application while the underlying beam.smp OS
#    process stayed alive — so systemctl/pgrep kept reporting the service as healthy while
#    it was actually completely dead (every subsequent auth attempt failed with charon's
#    "no EAP key found... tried 0 SIM providers" from a GSUP connection refused on
#    127.0.0.1:4223). Fixed at the root: a stale session with no valid default bearer is
#    now discarded and replaced with a fresh one instead of being reused.
python3 << 'PYEOF'
path = "src/aaa_diameter_swx_cb.erl"
with open(path) as f:
    content = f.read()

old = """parse_pgw_addr_from_N3UA([]) ->
    undefined;
parse_pgw_addr_from_N3UA([N3UA]) ->
    #'Non-3GPP-User-Data'{'APN-Configuration' = ApnConfigs} = N3UA,
    parse_pgw_addr_from_APN_Configuration(ApnConfigs)."""

new = """parse_pgw_addr_from_N3UA([]) ->
    undefined;
parse_pgw_addr_from_N3UA([N3UA]) ->
    #'Non-3GPP-User-Data'{'APN-Configuration' = ApnConfigs} = N3UA,
    parse_pgw_addr_from_APN_Configuration(ApnConfigs).

%% Reads the subscriber's static IP (if any) from the HSS-provided
%% Served-Party-IP-Address AVP, so it can be forwarded to the PGW/SMF
%% instead of always requesting dynamic (0.0.0.0) allocation.
parse_static_ip_from_APN_Configuration([]) ->
    undefined;
parse_static_ip_from_APN_Configuration([Head | Tail] = _ApnConfigs) ->
    #'APN-Configuration'{'Served-Party-IP-Address' = ServedIpOpt} = Head,
    case ServedIpOpt of
    [] -> parse_static_ip_from_APN_Configuration(Tail);
    [StaticIp | _] -> StaticIp
    end.
parse_static_ip_from_N3UA([]) ->
    undefined;
parse_static_ip_from_N3UA([N3UA]) ->
    #'Non-3GPP-User-Data'{'APN-Configuration' = ApnConfigs} = N3UA,
    parse_static_ip_from_APN_Configuration(ApnConfigs)."""

assert old in content, "aaa_diameter_swx_cb.erl: parse_pgw_addr_from_N3UA block not found — upstream source may have changed"
content = content.replace(old, new)

old2 = """        #'SAA'{'Non-3GPP-User-Data' = N3UA} = Msg,
        PGWAddresses = parse_pgw_addr_from_N3UA(N3UA),
        case PGWAddresses of
        undefined -> ResInfo = #{};
        _ -> ResInfo = maps:put(pgw_address_list, PGWAddresses, #{})
        end,"""

new2 = """        #'SAA'{'Non-3GPP-User-Data' = N3UA} = Msg,
        PGWAddresses = parse_pgw_addr_from_N3UA(N3UA),
        StaticIp = parse_static_ip_from_N3UA(N3UA),
        ResInfo0 = case PGWAddresses of
        undefined -> #{};
        _ -> maps:put(pgw_address_list, PGWAddresses, #{})
        end,
        ResInfo = case StaticIp of
        undefined -> ResInfo0;
        _ -> maps:put(static_ip_list, StaticIp, ResInfo0)
        end,"""

assert old2 in content, "aaa_diameter_swx_cb.erl: SAA handler block not found — upstream source may have changed"
content = content.replace(old2, new2)

with open(path, "w") as f:
    f.write(content)
print("aaa_diameter_swx_cb.erl patched OK")
PYEOF

python3 << 'PYEOF'
path = "src/epdg_ue_fsm.erl"
with open(path) as f:
    content = f.read()

# osmo-epdg 0.1.2 (see OSMO_EPDG_TAG) added its own native pdp_type_nr/pdp_address
# fields to this same record — its own mechanism for forwarding a PDN address into
# the GTP-C Create Session Request, sourced from the UE's own IKEv2 CFG_REQUEST
# (via strongSwan -> GSUP) rather than the HSS's SWx-configured static IP this
# patch adds. Both now feed the same PAA IE (see epdg_gtpc_s2b.erl patch below,
# which makes static_ip win when present) — this patch's insertion point moved
# to account for those new upstream fields, verified against real 0.1.2 source
# (compiled clean via rebar3, escript built successfully) before this tag bump.
old = """-record(ue_fsm_data, {
        imsi,
        pdp_type_nr,
        pdp_address,
        apn                     = "internet"    :: string(),
        pgw_rem_addr_list       = []            :: list(),"""
new = """-record(ue_fsm_data, {
        imsi,
        pdp_type_nr,
        pdp_address,
        apn                     = "internet"    :: string(),
        pgw_rem_addr_list       = []            :: list(),
        static_ip               = undefined,"""
assert old in content, "epdg_ue_fsm.erl: record block not found"
content = content.replace(old, new)

old2 = """        case Result of
        {ok, ResInfo} ->
                % Store PGW Remote address if AAA/HSS signalled them to us:
                case maps:find(pdp_info_list, ResInfo) of
                error ->
                        Data1 = Data;
                PGWAddrCandidateList ->
                        Data1 = Data#ue_fsm_data{pgw_rem_addr_list = PGWAddrCandidateList}
                end,
                gsup_server:lu_response(Data1#ue_fsm_data.imsi, ok),"""
new2 = """        case Result of
        {ok, ResInfo} ->
                % Store PGW Remote address if AAA/HSS signalled them to us:
                case maps:find(pdp_info_list, ResInfo) of
                error ->
                        Data0 = Data;
                PGWAddrCandidateList ->
                        Data0 = Data#ue_fsm_data{pgw_rem_addr_list = PGWAddrCandidateList}
                end,
                % Store subscriber's static IP if the HSS provided one (Served-Party-IP-Address):
                case maps:find(static_ip_list, ResInfo) of
                {ok, StaticIp} ->
                        Data1 = Data0#ue_fsm_data{static_ip = StaticIp};
                error ->
                        Data1 = Data0
                end,
                gsup_server:lu_response(Data1#ue_fsm_data.imsi, ok),"""
assert old2 in content, "epdg_ue_fsm.erl: lu_response block not found"
content = content.replace(old2, new2)

# Call site now takes osmo-epdg 0.1.2's own pdp_type_nr/pdp_address too (6 args,
# up from 4 in 0.1.1) - appending static_ip as a 7th, matching
# epdg_gtpc_s2b.erl's create_session_req/7 below.
old3 = """        epdg_gtpc_s2b:create_session_req(Data#ue_fsm_data.imsi,
                                         Data#ue_fsm_data.apn,
                                         PCO,
                                         Data#ue_fsm_data.pdp_type_nr,
                                         Data#ue_fsm_data.pdp_address,
                                         Data#ue_fsm_data.pgw_rem_addr_list),"""
new3 = """        epdg_gtpc_s2b:create_session_req(Data#ue_fsm_data.imsi,
                                         Data#ue_fsm_data.apn,
                                         PCO,
                                         Data#ue_fsm_data.pdp_type_nr,
                                         Data#ue_fsm_data.pdp_address,
                                         Data#ue_fsm_data.pgw_rem_addr_list,
                                         Data#ue_fsm_data.static_ip),"""
assert old3 in content, "epdg_ue_fsm.erl: create_session_req call site not found"
content = content.replace(old3, new3)

with open(path, "w") as f:
    f.write(content)
print("epdg_ue_fsm.erl patched OK")
PYEOF

python3 << 'PYEOF'
path = "src/epdg_gtpc_s2b.erl"
with open(path) as f:
    content = f.read()

old = "-export([create_session_req/6, delete_session_req/1])."
new = "-export([create_session_req/7, delete_session_req/1])."
assert old in content, "epdg_gtpc_s2b.erl: export not found"
content = content.replace(old, new)

old2 = """create_session_req(Imsi, Apn, APCO, PdpTypeNr, PdpAddress, PGWAddrCandidateList) ->
    gen_server:call(?SERVER, {gtpc_create_session_req, {Imsi, Apn, APCO, PdpTypeNr, PdpAddress, PGWAddrCandidateList}})."""
new2 = """create_session_req(Imsi, Apn, APCO, PdpTypeNr, PdpAddress, PGWAddrCandidateList, StaticIp) ->
    gen_server:call(?SERVER, {gtpc_create_session_req, {Imsi, Apn, APCO, PdpTypeNr, PdpAddress, PGWAddrCandidateList, StaticIp}})."""
assert old2 in content, "epdg_gtpc_s2b.erl: public API function not found"
content = content.replace(old2, new2)

# A subscriber's HSS-provisioned static IP takes priority over whatever the UE
# itself requested via IKEv2 CFG_REQUEST (PdpTypeNr/PdpAddress, osmo-epdg 0.1.2's
# own native mechanism, see OSMO_EPDG_TAG) - an operator-provisioned static IP
# exists specifically to be authoritative, and falling through to a UE's own
# suggestion would defeat the point of configuring one. Falls back to upstream's
# own conv:pdp_address_to_gtp2_paa/2 (UE-requested, or its own dynamic default)
# when no static IP is configured for this subscriber. gen_create_session_request
# itself already accepts a pre-built Paa record unchanged - only this call chain
# needs to thread StaticIp through.
old3 = """handle_call({gtpc_create_session_req, {Imsi, Apn, APCO, PdpTypeNr, PdpAddress, PGWAddrCandidateList}}, {Pid, _Tag} = _From, State0) ->
    RemoteAddrStr = pick_gtpc_remote_address(PGWAddrCandidateList, State0),
    lager:debug("Selected PGW Remote Address ~p~n", [RemoteAddrStr]),
    {ok, RemoteAddrInet} = inet_parse:address(RemoteAddrStr),
    {Sess0, State1} = find_or_new_gtp_session(Imsi,
                        #gtp_session{pid = Pid,
                                     apn = list_to_binary(Apn),
                                     raddr_str = RemoteAddrInet,
                                     raddr = RemoteAddrInet},
                        State0),
    Paa = conv:pdp_address_to_gtp2_paa(PdpTypeNr, PdpAddress),
    Req = gen_create_session_request(Sess0, APCO, Paa, State1),"""
new3 = """handle_call({gtpc_create_session_req, {Imsi, Apn, APCO, PdpTypeNr, PdpAddress, PGWAddrCandidateList, StaticIp}}, {Pid, _Tag} = _From, State0) ->
    RemoteAddrStr = pick_gtpc_remote_address(PGWAddrCandidateList, State0),
    lager:debug("Selected PGW Remote Address ~p~n", [RemoteAddrStr]),
    {ok, RemoteAddrInet} = inet_parse:address(RemoteAddrStr),
    {Sess0, State1} = find_or_new_gtp_session(Imsi,
                        #gtp_session{pid = Pid,
                                     apn = list_to_binary(Apn),
                                     raddr_str = RemoteAddrInet,
                                     raddr = RemoteAddrInet},
                        State0),
    Paa = case StaticIp of
        {A, B, C, D} -> #v2_pdn_address_allocation{type = ipv4, address = conv:ip_to_bin({A, B, C, D})};
        _ -> conv:pdp_address_to_gtp2_paa(PdpTypeNr, PdpAddress)
    end,
    Req = gen_create_session_request(Sess0, APCO, Paa, State1),"""
assert old3 in content, "epdg_gtpc_s2b.erl: handle_call not found"
content = content.replace(old3, new3)

with open(path, "w") as f:
    f.write(content)
print("epdg_gtpc_s2b.erl patched OK")
PYEOF

python3 << 'PYEOF'
# Real bug, confirmed live 2026-08-01 via a temporary diagnostic log line:
# the SWx/HSS-sourced "subscriber static IP" (StaticIp) this handler
# receives is NOT scoped per-APN — it's one fixed value for the whole
# subscriber (confirmed: {10,45,0,75}, which is this subscriber's real,
# correctly-configured MongoDB static IP for the "internet" DNN, per
# open5gs.subscribers — see PROJECT_STATE.md Known Issues #9), yet it gets
# applied unconditionally regardless of which APN is actually being
# attached. For VoWiFi (this ePDG only ever serves the "ims" APN — see the
# is_apn_allowed/1 gate in gsup_server.erl above), that means every "ims"
# GTP-C session was requesting the WRONG, "internet"-scoped static address
# instead of its own real one (10.46.0.75) or a proper dynamic allocation —
# confirmed via SMF/UPF logs matching Mongo's per-DNN "ims" session data.
# Fix: never apply the SWx-sourced StaticIp override for the "ims" APN —
# fall through to pdp_address_to_gtp2_paa/2 (UE-requested, or SMF's own
# dynamic default) exactly as if no static IP had been returned at all.
# Any other APN (currently unreachable anyway, since gsup_server.erl already
# rejects non-"ims" attaches) keeps the existing StaticIp-priority behavior
# unchanged. This is NOT the same bug as the gsup_server.erl APN-gate patch
# above — that one prevented two concurrent GTP-C sessions from colliding;
# this one fixes the single remaining "ims" session getting the wrong
# address even once the collision was gone. The two DIAG log lines are left
# in place (harmless, low-volume) so a future session can quickly confirm
# via live logs that Paa now reflects a dynamic/correct address rather than
# re-deriving this from scratch.
#
# UPDATE 2026-08-01: the first version of this fix compared Apn against the
# literal lowercase "ims" and missed a real device — confirmed live, a real
# iPhone requests the APN as "IMS" (uppercase), which is NOT string-equal to
# "ims" in Erlang, so the exact-match case fell through to the StaticIp
# branch and the iPhone's "ims" session got the same wrong address bug the
# fix was supposed to prevent. Now compares case-insensitively via
# string:to_lower/1, matching how gsup_server.erl's is_apn_allowed/1 already
# does it (that one was correct from the start; this one wasn't consistent
# with it).
path = "src/epdg_gtpc_s2b.erl"
with open(path) as f:
    content = f.read()

old = """    Paa = case StaticIp of
        {A, B, C, D} -> #v2_pdn_address_allocation{type = ipv4, address = conv:ip_to_bin({A, B, C, D})};
        _ -> conv:pdp_address_to_gtp2_paa(PdpTypeNr, PdpAddress)
    end,
    Req = gen_create_session_request(Sess0, APCO, Paa, State1),"""
new = """    lager:info("DIAG-VOWIFI-IP: Imsi=~p Apn=~p PdpTypeNr=~p PdpAddress=~p StaticIp=~p~n", [Imsi, Apn, PdpTypeNr, PdpAddress, StaticIp]),
    Paa = case {string:to_lower(Apn), StaticIp} of
        {"ims", _} -> conv:pdp_address_to_gtp2_paa(PdpTypeNr, PdpAddress);
        {_, {A, B, C, D}} -> #v2_pdn_address_allocation{type = ipv4, address = conv:ip_to_bin({A, B, C, D})};
        _ -> conv:pdp_address_to_gtp2_paa(PdpTypeNr, PdpAddress)
    end,
    lager:info("DIAG-VOWIFI-IP: built Paa=~p~n", [Paa]),
    Req = gen_create_session_request(Sess0, APCO, Paa, State1),"""

assert old in content, "epdg_gtpc_s2b.erl: Paa-building insertion point not found — patch #3 above may have changed"
content = content.replace(old, new)

with open(path, "w") as f:
    f.write(content)
print("epdg_gtpc_s2b.erl StaticIp-scoping fix OK")
PYEOF

python3 << 'PYEOF'
path = "src/gsup_server.erl"
with open(path) as f:
    content = f.read()

# Real bug, confirmed live 2026-07-31 via SMF/UPF logs (see PROJECT_STATE.md Known
# Issues #9): epdg_ue_fsm is a single-APN-per-IMSI state machine — one #ue_fsm_data{}
# record, one 'apn'/'pdp_address' field, no concept of tracking two concurrent PDN
# attaches for the same subscriber. Real UEs (e.g. Android Wi-Fi Calling) can request
# a default/"internet" PDN connection over the same IKE_SA in addition to the "ims"
# one they actually need for VoLTE registration. When a second APN's auth_request
# arrives for an already-active IMSI, epdg_ue_fsm's state_active/state_authenticated
# clauses tear down the FIRST PDN's local GTP-U tunnel context and re-authenticate for
# the new APN in place — but never send a GTPv2-C Delete Session Request to the
# PGW/SMF for the old APN's session first. Both attaches also carry the SAME
# UE-negotiated IKEv2 CFG_REQUEST virtual IP unchanged (strongswan-epdg only
# negotiates one virtual IP per IKE_SA), so the old (still-live on SMF/UPF) session
# and the new one end up with the *same* IP — two independent SMF/UPF sessions both
# claiming one address, causing non-deterministic packet routing for that IP and a
# session churn loop (confirmed via repeated "Removed Session"/recreate cycles every
# 20-40s in SMF's own log). Real-world VoWiFi ePDGs only ever need to carry the IMS
# APN — general data goes over the Wi-Fi network directly, not through this tunnel —
# so the safe, minimal fix is to reject any non-IMS APN attach here, before it ever
# reaches epdg_ue_fsm, rather than teaching the FSM to track multiple concurrent
# PDN sessions per IMSI (a much larger change to a third-party component). A
# wildcard/unspecified APN ("*", GSUP's own placeholder when the UE's request
# carries no pdp_info_list at all) is treated as a request for the ePDG's sole
# supported APN and allowed through, matching how "*" is already used elsewhere
# in this file as "no APN specified."
old = """% Rx send auth info / requesting authentication tuples
rx_gsup(Socket, GsupMsgRx = #{message_type := send_auth_info_req, imsi := Imsi}, State) ->
	case maps:find(pdp_info_list, GsupMsgRx) of
	{ok, [PdpInfo]} ->
		#{pdp_context_id := _PDPCtxId,
		  pdp_address := #{address := PdpAddressRx,
				   pdp_type_nr := PdpTypeNr,
				   pdp_type_org := 241},
		  access_point_name := Apn
		} = PdpInfo,
		case maps:is_key(ipv4,PdpAddressRx) or maps:is_key(ipv6,PdpAddressRx) of
                        true -> %% Address received, use it
				PdpAddress = PdpAddressRx;
                        false -> %% No address received from strongswan, use a default value
                                PdpTypeNr = ?GTP_PDP_ADDR_TYPE_NR_IPv4,
                                PdpAddress = #{ipv4 => <<0,0,0,0>>}
		end;
	error -> % Use some sane defaults:
		PdpTypeNr = ?GTP_PDP_ADDR_TYPE_NR_IPv4,
		PdpAddress = #{ipv4 => <<0,0,0,0>>},
		Apn = "*"
	end,
	EAP = parse_eap(GsupMsgRx),
	case epdg_ue_fsm:get_pid_by_imsi(Imsi) of
		undefined -> {ok, Pid} = epdg_ue_fsm:start(Imsi);
		Pid -> Pid
	end,
	case epdg_ue_fsm:auth_request(Pid, {PdpTypeNr, PdpAddress, Apn, EAP}) of
	ok -> ok;
	{error, Err} ->
		lager:error("Auth Req for Imsi ~p failed: ~p~n", [Imsi, Err]),
		Resp = #{message_type => send_auth_info_err,
			 imsi => Imsi,
			 message_class => 5,
			 cause => ?GSUP_CAUSE_NET_FAIL
		},
		tx_gsup(Socket, Resp),
		epdg_ue_fsm:stop(Pid)
	end,
	{noreply, State};"""

new = """% Only "ims" (and an unspecified/wildcard APN, treated as a request for it) is
% accepted — see the OSMO_EPDG_PATCH_REV comment above this block for why.
is_apn_allowed(Apn) ->
	case string:to_lower(Apn) of
	"ims" -> true;
	"*" -> true;
	_ -> false
	end.

% Rx send auth info / requesting authentication tuples
rx_gsup(Socket, GsupMsgRx = #{message_type := send_auth_info_req, imsi := Imsi}, State) ->
	case maps:find(pdp_info_list, GsupMsgRx) of
	{ok, [PdpInfo]} ->
		#{pdp_context_id := _PDPCtxId,
		  pdp_address := #{address := PdpAddressRx,
				   pdp_type_nr := PdpTypeNr,
				   pdp_type_org := 241},
		  access_point_name := Apn
		} = PdpInfo,
		case maps:is_key(ipv4,PdpAddressRx) or maps:is_key(ipv6,PdpAddressRx) of
                        true -> %% Address received, use it
				PdpAddress = PdpAddressRx;
                        false -> %% No address received from strongswan, use a default value
                                PdpTypeNr = ?GTP_PDP_ADDR_TYPE_NR_IPv4,
                                PdpAddress = #{ipv4 => <<0,0,0,0>>}
		end;
	error -> % Use some sane defaults:
		PdpTypeNr = ?GTP_PDP_ADDR_TYPE_NR_IPv4,
		PdpAddress = #{ipv4 => <<0,0,0,0>>},
		Apn = "*"
	end,
	case is_apn_allowed(Apn) of
	false ->
		lager:notice("Rejecting PDN attach for Imsi ~p: APN ~p not supported by this ePDG (only ims is)~n", [Imsi, Apn]),
		Resp = #{message_type => send_auth_info_err,
			 imsi => Imsi,
			 message_class => 5,
			 cause => ?GSUP_CAUSE_NET_FAIL
		},
		tx_gsup(Socket, Resp);
	true ->
		EAP = parse_eap(GsupMsgRx),
		case epdg_ue_fsm:get_pid_by_imsi(Imsi) of
			undefined -> {ok, Pid} = epdg_ue_fsm:start(Imsi);
			Pid -> Pid
		end,
		case epdg_ue_fsm:auth_request(Pid, {PdpTypeNr, PdpAddress, Apn, EAP}) of
		ok -> ok;
		{error, Err} ->
			lager:error("Auth Req for Imsi ~p failed: ~p~n", [Imsi, Err]),
			Resp = #{message_type => send_auth_info_err,
				 imsi => Imsi,
				 message_class => 5,
				 cause => ?GSUP_CAUSE_NET_FAIL
			},
			tx_gsup(Socket, Resp),
			epdg_ue_fsm:stop(Pid)
		end
	end,
	{noreply, State};"""

assert old in content, "gsup_server.erl: send_auth_info_req rx_gsup clause not found — upstream source may have changed"
content = content.replace(old, new)

with open(path, "w") as f:
    f.write(content)
print("gsup_server.erl patched OK")
PYEOF

python3 << 'PYEOF'
path = "src/epdg_gtpc_s2b.erl"
with open(path) as f:
    content = f.read()

# See patch #5 in the comment above (OSMO_EPDG_PATCH_REV) for the full incident this
# fixes: a stale reused #gtp_session{} whose default bearer was already gone crashed
# gen_create_session_request/4 with {badrecord, undefined}, which cascaded into taking
# down the entire osmo_epdg application. Fix: discard a session with no valid default
# bearer and create a fresh one instead of handing it back to the caller.
old = """find_or_new_gtp_session(Imsi, SessTpl, State) ->
    Sess = find_gtp_session_by_imsi(Imsi, State),
    case Sess of
        #gtp_session{imsi = Imsi} ->
            {Sess, State};
        undefined ->
            new_gtp_session(Imsi, SessTpl, State)
    end."""
new = """find_or_new_gtp_session(Imsi, SessTpl, State) ->
    Sess = find_gtp_session_by_imsi(Imsi, State),
    case Sess of
        #gtp_session{imsi = Imsi} = ExistingSess ->
            case gtp_session_default_bearer(ExistingSess) of
                undefined ->
                    lager:warning("epdg_gtpc_s2b: discarding stale gtp_session for Imsi=~p (default_bearer_id=~p has no matching bearer) - creating fresh session instead of crashing~n", [Imsi, ExistingSess#gtp_session.default_bearer_id]),
                    State1 = delete_gtp_session(ExistingSess, State),
                    new_gtp_session(Imsi, SessTpl, State1);
                _Bearer ->
                    {ExistingSess, State}
            end;
        undefined ->
            new_gtp_session(Imsi, SessTpl, State)
    end."""

assert old in content, "epdg_gtpc_s2b.erl: find_or_new_gtp_session/3 not found — upstream source may have changed"
content = content.replace(old, new)

with open(path, "w") as f:
    f.write(content)
print("epdg_gtpc_s2b.erl stale-session crash-guard fix OK")
PYEOF

# Fetch dependencies (this is what makes gtp_u_kmod's source appear under
# _build/default/lib/ — it's a rebar3-managed dep, not part of osmo-epdg's own src/ tree).
rebar3 compile

# gtp_u_kmod hardcodes a 131072-entry (2^17) hash table for the gtp0 device. Confirmed
# empirically (not a guess): this kernel's GTP driver rejects that as an oversized
# allocation, making gtp0 creation fail deterministically with error -12 (ENOMEM) — this
# was previously misdiagnosed as random kernel-module flakiness and "fixed" with an
# rmmod/modprobe reload that only ever worked by coincidence. 1024 entries is more than
# enough for a handful of concurrent VoWiFi sessions and creates the tunnel reliably.
GTP_KERNEL_ERL=$(find _build/default/lib/gtp_u_kmod/src -name gtp_u_kernel.erl | head -1)
if [ -z "$GTP_KERNEL_ERL" ]; then
  echo "ERROR: gtp_u_kernel.erl not found after dependency fetch — cannot apply hashsize fix"
  exit 1
fi
sed -i 's/{hashsize, 131072}/{hashsize, 1024}/' "$GTP_KERNEL_ERL"
grep -q '{hashsize, 1024}' "$GTP_KERNEL_ERL" || { echo "ERROR: gtp_u_kmod hashsize patch did not apply — upstream source may have changed"; exit 1; }
rm -f _build/default/lib/gtp_u_kmod/ebin/gtp_u_kernel.beam

start_heartbeat
make build
stop_heartbeat
install -m 755 _build/default/bin/osmo-epdg ${RUNTIME_BIN_DIR}/osmo-epdg

echo "==STEP:installing_strongswan=="
cd ${BUILD_WORKDIR}
rm -rf strongswan-epdg
start_heartbeat
git clone https://github.com/herlesupreeth/strongswan-epdg
cd strongswan-epdg
git checkout ${STRONGSWAN_EPDG_BRANCH}
stop_heartbeat

# osmo_epdg_plugin.c hardcodes the GSUP bridge port charon connects out to — no config
# option exists for it, so it must be patched to match whatever port osmo-epdg's own GSUP
# server is configured to use (see Configure step; default 4222 collides with the existing
# SMS-over-SGs OsmoHLR on this host).
sed -i 's|tcp://127.0.0.1:4222|tcp://127.0.0.1:${opts.gsupPort}|' \\
  src/libcharon/plugins/osmo_epdg/osmo_epdg_plugin.c

autopoint --force 2>/dev/null || true
autoreconf -i
./configure --sysconfdir=/etc --enable-eap-aka --enable-eap-aka-3gpp \\
  --enable-eap-aka-3gpp2 --enable-eap-simaka-reauth --enable-save-keys \\
  --enable-p-cscf --enable-osmo-epdg --enable-swanctl --enable-vici \\
  --enable-charon --disable-systemd
start_heartbeat
make -j"$(nproc)"
stop_heartbeat
make install
ldconfig

echo "==STEP:verifying=="
test -x ${RUNTIME_BIN_DIR}/osmo-epdg
test -x /usr/local/libexec/ipsec/charon
test -x /usr/local/sbin/swanctl
echo "osmo-epdg, charon, and swanctl all present."

echo "==STEP:done=="
`;
}
