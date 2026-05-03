#!/usr/bin/env python3
"""
femto_provision.py - Sercomm SCE4255W provisioning script.
Bundled in open5gs-nms backend Docker image at /app/tools/
"""
import argparse, base64, hashlib, json, re, sys, time
import requests, urllib3
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

try:
    import paramiko
    PARAMIKO_AVAILABLE = True
except ImportError:
    PARAMIKO_AVAILABLE = False

CONFIG = {
    "admin_state": True, "carrier_number": "2",
    "auto_internal_neighbors": True, "carrier_aggregation": True,
    "contiguous_cc": True, "bandwidth": "20",
    "freq_band": "48,48", "earfcn": "55340,55538",
    "cell_identity": "350,351", "pci": "400,401",
    "tx_power": "13,13", "sync_source": "FREE_RUNNING",
    "tunnel_type": "IPv4", "mme_ip": "10.0.1.175",
    "plmn_id": "99970", "tac": "1",
    "sas_enable": False, "sas_location": "indoor",
    "sas_location_source": "0", "sas_latitude": "43375246",
    "sas_longitude": "-72180291",
    "cwmp_enable": False, "cwmp_init_enable": False,
}

KEYWORDS = {
    "ID": "Q?*ztBa3", "Debug": "BYEBKCSe", "Telnet": "O6QSBT5l",
    "Partner": "zv8t3ZjU", "Sc_femto": "gv9tdTj1",
    "Admin": "lw8w3djo", "scert": "y2QMsQ==",
}
ALPHABET36 = "kj9uzli3x5t8ah1wbgm2c0on6epd4fsy7qvr"
SC_FEMTO_PASS_LIST = ["tsFid2wz", "scHt3pp"]


def sanitize_mac(mac):
    mac = re.sub(r'[^0-9a-f]', '', mac.strip().lower())
    if len(mac) != 12 or not re.fullmatch(r'[0-9a-f]{12}', mac):
        raise ValueError("MAC must be 12 hex digits.")
    return mac

def map36_byte(b): return ALPHABET36[b % 36]

def derive_code(base, key):
    km = KEYWORDS.get(key, key if key else "")
    d = hashlib.md5(((base or "")[:16] + (km or "")[:16]).encode('latin-1', errors='ignore')).digest()
    return ''.join(map36_byte(b) for b in d)

def derive_credentials(mac):
    mac = sanitize_mac(mac)
    bid = derive_code(mac, "ID")
    return derive_code(bid, "Telnet"), derive_code(bid, "Debug")


def get_mac_via_ssh(ip, dry_run=False):
    if dry_run:
        print("[DRY RUN] Would SSH as sc_femto to get MAC")
        return "3C:62:F0:AA:AA:AA"
    if not PARAMIKO_AVAILABLE:
        print("[-] paramiko not installed"); sys.exit(1)
    print(f"[*] Connecting to sc_femto@{ip}...")
    last_err = None
    for pw in SC_FEMTO_PASS_LIST:
        try:
            c = paramiko.SSHClient()
            c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            c.connect(ip, username="sc_femto", password=pw, timeout=10)
            _, stdout, _ = c.exec_command("rma get mac")
            out = stdout.read().decode().strip(); c.close()
            print(f"    Password #{SC_FEMTO_PASS_LIST.index(pw)+1} OK  output: {out}")
            m = re.search(r'\[mac\]\s*([0-9A-Fa-f:]{17})', out)
            if not m: print(f"[-] Cannot parse MAC from: {out}"); sys.exit(1)
            mac = m.group(1); print(f"[+] MAC: {mac}"); return mac
        except paramiko.AuthenticationException:
            print(f"    Password #{SC_FEMTO_PASS_LIST.index(pw)+1} failed, trying next...")
            last_err = "Auth failed"; continue
        except Exception as e:
            print(f"[-] SSH error: {e}"); sys.exit(1)
    print(f"[-] All sc_femto passwords failed: {last_err}"); sys.exit(1)


def check_webui(ip, dry_run=False):
    if dry_run:
        print("[DRY RUN] Would check WebUI"); return False
    url = f"https://{ip}/logon.htm"
    print(f"[*] Checking WebUI at {url}...")
    try:
        r = requests.get(url, timeout=5, verify=False)
        if r.status_code == 200 and "SmallCell" in r.text:
            print("[+] WebUI already enabled"); return True
        print(f"    HTTP {r.status_code} — not ready"); return False
    except Exception:
        print("    WebUI not reachable"); return False


def enable_webui(ip, root_pass, dry_run=False):
    if dry_run:
        print("[DRY RUN] Would SSH as root and enable WebUI"); return
    if not PARAMIKO_AVAILABLE:
        print("[-] paramiko not installed"); sys.exit(1)
    print(f"[*] SSH as root@{ip}...")
    try:
        c = paramiko.SSHClient()
        c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        c.connect(ip, username="root", password=root_pass, timeout=10)
        for cmd in [
            'femto_cli sset Device.X_SCM_DeviceFeature.X_SCM_WebServerEnable="1"',
            "femto_cli fsave", "reboot",
        ]:
            print(f"    # {cmd}")
            _, stdout, _ = c.exec_command(cmd)
            out = stdout.read().decode().strip()
            if out: print(f"      {out}")
        c.close(); print("[+] WebUI enabled, device rebooting...")
    except Exception as e:
        print(f"[-] Root SSH failed: {e}"); sys.exit(1)


def wait_for_webui_up(ip, timeout=300, interval=10, dry_run=False):
    if dry_run:
        print("[DRY RUN] Would wait for WebUI to come up"); return
    print("[*] Waiting for WebUI to come up...")
    url = f"https://{ip}/logon.htm"; elapsed = 0
    while elapsed < timeout:
        time.sleep(interval); elapsed += interval
        try:
            r = requests.get(url, timeout=5, verify=False)
            if r.status_code == 200 and "SmallCell" in r.text:
                print(f"[+] WebUI up after {elapsed}s"); return
        except Exception: pass
        print(f"    Still offline... ({elapsed}s)")
    print(f"[!] WebUI did not come up within {timeout}s — continuing anyway")


def wait_for_webui_reboot(ip, timeout=600, interval=10, dry_run=False):
    if dry_run:
        print("[DRY RUN] Would wait for reboot cycle"); return
    url = f"https://{ip}/logon.htm"
    print("[*] Waiting for device to go offline...")
    elapsed = 0
    while elapsed < timeout:
        time.sleep(interval); elapsed += interval
        try:
            r = requests.get(url, timeout=5, verify=False)
            if r.status_code != 200:
                print(f"    Offline after {elapsed}s"); break
        except Exception:
            print(f"    Offline after {elapsed}s"); break
        print(f"    Still up... ({elapsed}s)")
    else:
        print("[!] Device never went offline — may have already rebooted"); return
    print("[*] Waiting for WebUI to come back up...")
    elapsed = 0
    while elapsed < timeout:
        time.sleep(interval); elapsed += interval
        try:
            r = requests.get(url, timeout=5, verify=False)
            if r.status_code == 200 and "SmallCell" in r.text:
                print(f"[+] WebUI back up after {elapsed}s"); return
        except Exception: pass
        print(f"    Still offline... ({elapsed}s)")
    print("[!] WebUI did not come back up within timeout — device may still be rebooting")


def webui_login(session, base_url, username, password):
    un = base64.b64encode(username.encode()).decode()
    pw = base64.b64encode(password.encode()).decode()
    print(f"[*] Logging in as '{username}'")
    r = session.post(f"{base_url}/status.htm",
        data={"un": un, "pw": pw, "login_name": "", "login_pwd": "",
              "todo": "login", "this_file": "logon.htm", "next_file": "status.htm"},
        timeout=10, allow_redirects=True, verify=False)
    if "logon" in r.url.lower():
        print("[-] WebUI login failed"); sys.exit(1)
    print(f"[+] Login OK (cookies: {dict(session.cookies)})")


def post_page(session, base_url, page_name, post_data, dry_run=False):
    url = f"{base_url}/setup.cgi"
    if dry_run:
        print(f"\n[DRY RUN] {page_name} -> POST {url}:")
        print("-" * 60)
        for k, v in sorted(post_data.items()):
            print(f"  {k:<55} = {v}")
        print("-" * 60)
        return True
    print(f"[*] Saving {page_name}...")
    r = session.post(url, data=post_data, timeout=15, allow_redirects=True,
                     verify=False, headers={"Referer": f"{base_url}/{page_name}"})
    if r.status_code == 200 and "logon" not in r.url.lower():
        print(f"[+] {page_name} saved"); return True
    print(f"[-] {page_name} failed (HTTP {r.status_code})"); return False


def build_devcomstate(cfg):
    data = {}
    if cfg["admin_state"]:
        data["FAPService_FAPControl_LTE_AdminState"] = "FAPService_FAPControl_LTE_AdminState"
    data["h_FAPService_FAPControl_LTE_AdminState"] = "1" if cfg["admin_state"] else "0"
    if cfg["auto_internal_neighbors"]:
        data["auto_internal_neighbors"] = "auto_internal_neighbors"
    data["h_auto_internal_neighbors"] = "1" if cfg["auto_internal_neighbors"] else "0"
    if cfg["carrier_aggregation"]:
        data["enable_ca"] = "enable_ca"
    data["h_enable_ca"] = "1" if cfg["carrier_aggregation"] else "0"
    if cfg["contiguous_cc"]:
        data["contiguous_cc"] = "contiguous_cc"
    data["h_contiguous_cc"]    = "1" if cfg["contiguous_cc"] else "0"
    data["cell_number"]        = cfg["carrier_number"]
    data["bandwidth"]          = cfg["bandwidth"]
    data["freqband"]           = cfg["freq_band"]
    data["rf_earfcnul"]        = cfg["earfcn"]
    data["cellidentity"]       = cfg["cell_identity"]
    data["phycellid"]          = cfg["pci"]
    data["txpower"]            = cfg["tx_power"]
    data["sync_source"]        = cfg["sync_source"]
    data["tunnel_type"]        = cfg["tunnel_type"]
    data["mme_ip_addr"]        = cfg["mme_ip"]
    data["plmn_id"]            = cfg["plmn_id"]
    data["enodeb_tac"]         = cfg["tac"]
    data["todo"]               = "save"
    data["next_file"]          = "devComState.htm"
    data["this_file"]          = "devComState.htm"
    data["object_value"]       = ""
    data["object_uri"]         = ""
    data["object_index"]       = ""
    data["message"]            = ""
    data["h_enodebtype"]       = "0"
    data["h_sync_source"]      = cfg["sync_source"]
    data["h_sync_mode"]        = "TIME"
    data["h_ptp_mode"]         = "0"
    data["h_enable_cwmp"]      = "0"
    data["h_hems_tunnel_type"] = "Device.IP.Interface.1.IPv4Address.1."
    return data


def build_sasconf(cfg):
    data = {}
    if cfg["sas_enable"]:
        data["sas_enable"] = "sas_enable"
    data["h_sas_enable"]                    = "1" if cfg["sas_enable"] else "0"
    data["sas_Location"]                    = cfg["sas_location"]
    data["sas_LocationSource"]              = cfg["sas_location_source"]
    data["sas_Latitude"]                    = cfg["sas_latitude"]
    data["sas_Longitude"]                   = cfg["sas_longitude"]
    data["h_sas_Location"]                  = cfg["sas_location"]
    data["h_sas_LocationSource"]            = cfg["sas_location_source"]
    data["h_sas_Latitude"]                  = cfg["sas_latitude"]
    data["h_sas_Longitude"]                 = cfg["sas_longitude"]
    data["h_sas_Method"]                    = "0"
    data["h_sas_DiscontinuousEARFCNEnable"] = ""
    data["h_sas_SpectrumInterval"]          = ""
    data["h_sas_Bandwidth"]                 = ""
    data["h_sas_Contiguous_cc"]             = ""
    data["h_sas_ManufacturerPrefixEnable"]  = "0"
    data["h_sas_InstallationMethod"]        = "Single-Step"
    data["h_sas_CPIEnable"]                 = "0"
    data["h_sas_ServerUrl"]                 = ""
    data["h_sas_UserContactInformation"]    = ""
    data["h_sas_ICGGroupId"]                = ""
    data["h_sas_Category"]                  = "A"
    data["h_sas_ChannelType"]               = "GAA"
    data["h_sas_CPISignatureData"]          = ""
    data["h_sas_HeightType"]                = "AMSL"
    data["h_sas_Elevation"]                 = "0"
    data["h_sas_AGLHeight"]                 = "0"
    data["todo"]         = "save"
    data["next_file"]    = "sasConf.htm"
    data["this_file"]    = "sasConf.htm"
    data["object_value"] = ""
    data["object_uri"]   = ""
    data["object_index"] = ""
    data["message"]      = ""
    return data


def build_tr098_mgnt(cfg):
    data = {}
    if cfg["cwmp_enable"]:
        data["Device_ManagementServer_EnableCWMP"] = "Device_ManagementServer_EnableCWMP"
    data["h_Device_ManagementServer_EnableCWMP"]                     = "1" if cfg["cwmp_enable"] else "0"
    if cfg["cwmp_init_enable"]:
        data["Device_ManagementServer_EnableInitCWMP"] = "Device_ManagementServer_EnableInitCWMP"
    data["h_Device_ManagementServer_EnableInitCWMP"]                 = "1" if cfg["cwmp_init_enable"] else "0"
    data["h_Device_ManagementServer_InitCwmp_KeepAlive"]             = "1"
    data["h_Device_ManagementServer_X_SCM_UseCertificateEnable"]     = "1"
    data["h_Device_ManagementServer_X_SCM_InitUseCertificateEnable"] = "1"
    data["h_Device_ManagementServer_PeriodicInformEnable"]           = "1"
    data["h_Device_ManagementServer_InitPeriodicInformEnable"]       = "1"
    data["h_Device_ManagementServer_STUNEnable"]                     = "0"
    data["h_Device_ManagementServer_NATDetected"]                    = "0"
    data["h_Device_ManagementServer_InitSTUNEnable"]                 = "0"
    data["h_Device_ManagementServer_InitNATDetected"]                = "0"
    data["h_Device_ManagementServer_NextHopMACAddressDetected"]      = "0"
    data["h_Device_ManagementServer_X_SCM_NetconfEnable"]            = "0"
    data["h_Device_ManagementServer_X_SCM_InitLess1bootEnable"]      = "1"
    data["h_Device_ManagementServer_X_SCM_Less1bootEnable"]          = "1"
    data["h_Device_IP_X_SCM_NetworkDetectEnable"]                    = "0"
    data["h_Device_IP_X_SCM_NetworkDetectIPv4"]                      = "0"
    data["h_Device_IP_X_SCM_NetworkDetectIPv6"]                      = "0"
    data["h_Device_IP_X_SCM_NetworkDetectSecGWDetectEnable"]         = "0"
    data["todo"]                = "save"
    data["next_file"]           = "TR098_MgntServer.htm"
    data["this_file"]           = "TR098_MgntServer.htm"
    data["object_value"]        = ""
    data["object_uri"]          = ""
    data["object_index"]        = ""
    data["message"]             = ""
    data["FAPService_list_val"] = ""
    return data


def reboot_device(session, base_url, dry_run=False):
    if dry_run:
        print(f"[DRY RUN] Would reboot"); return
    print("[*] Sending reboot command...")
    try:
        session.get(f"{base_url}/setup.cgi",
                    params={"this_file": "status.htm", "todo": "reboot"},
                    timeout=10, verify=False)
        print("[+] Reboot command sent")
    except Exception:
        print("[+] Reboot sent (connection closed — normal)")


def main():
    parser = argparse.ArgumentParser(description="Provision Sercomm SCE4255W Small Cell")
    parser.add_argument("--ip",          required=True)
    parser.add_argument("--port",        default="443")
    mac_group = parser.add_mutually_exclusive_group(required=True)
    mac_group.add_argument("--mac")
    mac_group.add_argument("--get-mac",  action="store_true")
    parser.add_argument("--root-pass",   default=None)
    parser.add_argument("--webui-user",  default="debug")
    parser.add_argument("--webui-pass",  default=None)
    parser.add_argument("--config-json", default=None,
                        help="JSON string overriding CONFIG values (used by NMS WebUI)")
    parser.add_argument("--mac-only",    action="store_true")
    parser.add_argument("--force",       action="store_true")
    parser.add_argument("--skip-enable", action="store_true")
    parser.add_argument("--dry-run",     action="store_true")
    args = parser.parse_args()

    if args.config_json:
        try:
            CONFIG.update(json.loads(args.config_json))
        except json.JSONDecodeError as e:
            print(f"[-] Invalid --config-json: {e}"); sys.exit(1)

    base_url = f"https://{args.ip}:{args.port}"
    print(f"\n{'='*60}\n  Sercomm SCE4255W Provisioning Script")
    print(f"  Target: {base_url}")
    print(f"  Mode:   {'DRY RUN' if args.dry_run else 'LIVE'}\n{'='*60}\n")

    print("[1/6] Getting MAC address...")
    if args.get_mac:
        mac = get_mac_via_ssh(args.ip, dry_run=args.dry_run)
    else:
        mac = args.mac
        try: sanitize_mac(mac)
        except ValueError as e: print(f"[-] Invalid MAC: {e}"); sys.exit(1)
    print(f"    MAC: {mac}")

    if args.mac_only:
        print(f"\n[+] MAC: {mac}"); sys.exit(0)

    print("\n[2/6] Resolving credentials...")
    derived_root, derived_webui = derive_credentials(mac)
    root_pass  = args.root_pass  or derived_root
    webui_pass = args.webui_pass or derived_webui
    print(f"    Root:  {'(provided)' if args.root_pass  else root_pass}")
    print(f"    WebUI: {'(provided)' if args.webui_pass else webui_pass}")

    print("\n[3/6] Checking WebUI...")
    if args.force:
        print("    --force — running full provisioning"); webui_up = False
    elif args.skip_enable:
        print("    --skip-enable — assuming WebUI up"); webui_up = True
    else:
        webui_up = check_webui(args.ip, dry_run=args.dry_run)

    if not webui_up:
        print("\n[4/6] Enabling WebUI via SSH...")
        enable_webui(args.ip, root_pass, dry_run=args.dry_run)
        print("\n[4/6] Waiting for WebUI to come up...")
        wait_for_webui_up(args.ip, dry_run=args.dry_run)
    else:
        print("\n[4/6] WebUI already up — skipping")

    print("\n[5/6] Configuring WebUI...")
    session = requests.Session()
    session.headers.update({"User-Agent": "Mozilla/5.0"})
    if not args.dry_run:
        webui_login(session, base_url, args.webui_user, webui_pass)

    results = [
        ("devComState.htm",
         post_page(session, base_url, "devComState.htm", build_devcomstate(CONFIG), args.dry_run)),
        ("sasConf.htm",
         post_page(session, base_url, "sasConf.htm", build_sasconf(CONFIG), args.dry_run)),
        ("TR098_MgntServer.htm",
         post_page(session, base_url, "TR098_MgntServer.htm", build_tr098_mgnt(CONFIG), args.dry_run)),
    ]

    print(f"\n[6/6] Rebooting...")
    reboot_device(session, base_url, dry_run=args.dry_run)
    try:
        wait_for_webui_reboot(args.ip, dry_run=args.dry_run)
    except SystemExit:
        print("[!] Reboot wait timed out — device may still be rebooting")
        print("    Config was applied successfully before reboot")

    print(f"\n{'='*60}\n  Results:")
    all_ok = True
    for page, ok in results:
        print(f"    {'[+] OK' if ok else '[-] FAILED'}  {page}")
        if not ok: all_ok = False
    print(f"  Credentials: WebUI={'(provided)' if args.webui_pass else '(derived)'}"
          f"  Root={'(provided)' if args.root_pass else '(derived)'}")
    print(f"{'='*60}\n")
    # Exit 0 if all config pages saved — reboot wait is best-effort only
    sys.exit(0 if all_ok else 1)


if __name__ == "__main__":
    main()