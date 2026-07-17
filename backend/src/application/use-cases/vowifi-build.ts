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
export const OSMO_EPDG_TAG = '0.1.1';
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

# ─── Apply the 3 source patches proven working in manual testing — BEFORE the build below,
# so the compiled escript actually includes them ───
# 1) osmo-epdg's SWx callback never read the HSS-provided static IP (Served-Party-IP-Address)
#    for a subscriber — it only parsed the PGW address from the same AVP structure, silently
#    dropping everything else. Without this, VoWiFi sessions always request dynamic IP
#    allocation from SMF regardless of what's configured on the subscriber, which can hand
#    out an IP already in active use by a real UE.
# 2) epdg_ue_fsm.erl needs to carry that static IP through its state machine.
# 3) epdg_gtpc_s2b.erl needs to use it in the GTP-C Create Session Request's PDN Address
#    Allocation IE instead of always hardcoding 0.0.0.0.
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

old = """-record(ue_fsm_data, {
        imsi,
        apn                     = "internet"    :: string(),
        pgw_rem_addr_list       = []            :: list(),"""
new = """-record(ue_fsm_data, {
        imsi,
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

old3 = """        epdg_gtpc_s2b:create_session_req(Data#ue_fsm_data.imsi,
                                         Data#ue_fsm_data.apn,
                                         PCO,
                                         Data#ue_fsm_data.pgw_rem_addr_list),"""
new3 = """        epdg_gtpc_s2b:create_session_req(Data#ue_fsm_data.imsi,
                                         Data#ue_fsm_data.apn,
                                         PCO,
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

old = "-export([create_session_req/4, delete_session_req/1])."
new = "-export([create_session_req/5, delete_session_req/1])."
assert old in content, "epdg_gtpc_s2b.erl: export not found"
content = content.replace(old, new)

old2 = """create_session_req(Imsi, Apn, APCO, PGWAddrCandidateList) ->
    gen_server:call(?SERVER, {gtpc_create_session_req, {Imsi, Apn, APCO, PGWAddrCandidateList}})."""
new2 = """create_session_req(Imsi, Apn, APCO, PGWAddrCandidateList, StaticIp) ->
    gen_server:call(?SERVER, {gtpc_create_session_req, {Imsi, Apn, APCO, PGWAddrCandidateList, StaticIp}})."""
assert old2 in content, "epdg_gtpc_s2b.erl: public API function not found"
content = content.replace(old2, new2)

old3 = """handle_call({gtpc_create_session_req, {Imsi, Apn, APCO, PGWAddrCandidateList}}, {Pid, _Tag} = _From, State0) ->
    RemoteAddrStr = pick_gtpc_remote_address(PGWAddrCandidateList, State0),
    lager:debug("Selected PGW Remote Address ~p~n", [RemoteAddrStr]),
    {ok, RemoteAddrInet} = inet_parse:address(RemoteAddrStr),
    {Sess0, State1} = find_or_new_gtp_session(Imsi,
                        #gtp_session{pid = Pid,
                                     apn = list_to_binary(Apn),
                                     raddr_str = RemoteAddrInet,
                                     raddr = RemoteAddrInet},
                        State0),
    Req = gen_create_session_request(Sess0, APCO, State1),"""
new3 = """handle_call({gtpc_create_session_req, {Imsi, Apn, APCO, PGWAddrCandidateList, StaticIp}}, {Pid, _Tag} = _From, State0) ->
    RemoteAddrStr = pick_gtpc_remote_address(PGWAddrCandidateList, State0),
    lager:debug("Selected PGW Remote Address ~p~n", [RemoteAddrStr]),
    {ok, RemoteAddrInet} = inet_parse:address(RemoteAddrStr),
    {Sess0, State1} = find_or_new_gtp_session(Imsi,
                        #gtp_session{pid = Pid,
                                     apn = list_to_binary(Apn),
                                     raddr_str = RemoteAddrInet,
                                     raddr = RemoteAddrInet},
                        State0),
    lager:info("Requested PDN Address Allocation: ~p~n", [StaticIp]),
    Req = gen_create_session_request(Sess0, APCO, StaticIp, State1),"""
assert old3 in content, "epdg_gtpc_s2b.erl: handle_call not found"
content = content.replace(old3, new3)

old4 = """gen_create_session_request(#gtp_session{imsi = Imsi,
                                    apn = Apn,
                                    local_control_tei = LocalCtlTEI} = Sess,
                           APCO,
                           #gtp_state{laddr = LocalAddr,
                                      laddr_gtpu = LocalAddrGtpu,
                                      restart_counter = RCnt,
                                      seq_no = SeqNo}) ->"""
new4 = """gen_create_session_request(#gtp_session{imsi = Imsi,
                                    apn = Apn,
                                    local_control_tei = LocalCtlTEI} = Sess,
                           APCO,
                           StaticIp,
                           #gtp_state{laddr = LocalAddr,
                                      laddr_gtpu = LocalAddrGtpu,
                                      restart_counter = RCnt,
                                      seq_no = SeqNo}) ->
    PaaAddress = case StaticIp of
        {A, B, C, D} -> conv:ip_to_bin({A, B, C, D});
        _ -> <<0,0,0,0>>
    end,"""
assert old4 in content, "epdg_gtpc_s2b.erl: gen_create_session_request head not found"
content = content.replace(old4, new4)

old5 = "#v2_pdn_address_allocation{type = ipv4, address = <<0,0,0,0>>},"
new5 = "#v2_pdn_address_allocation{type = ipv4, address = PaaAddress},"
assert old5 in content, "epdg_gtpc_s2b.erl: PAA IE construction line not found"
content = content.replace(old5, new5)

with open(path, "w") as f:
    f.write(content)
print("epdg_gtpc_s2b.erl patched OK")
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
