# Open5GS Network Management System (NMS)

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![Docker](https://img.shields.io/badge/Docker-Ready-blue.svg)](https://www.docker.com/)
[![Open5GS](https://img.shields.io/badge/Open5GS-2.7%2B-green.svg)](https://open5gs.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20%20LTS-brightgreen.svg)](https://nodejs.org/)
[![React](https://img.shields.io/badge/React-18.2-61DAFB.svg)](https://reactjs.org/)

Web-based management system for Open5GS 5G Core and 4G EPC networks. Provides complete configuration management, real-time monitoring, subscriber provisioning, and network visualization through an intuitive interface. Please be aware this project is heavily AI-assisted. If you find any issues please let me know — I will fix them as fast as I can.

---

## 🎯 Overview

Open5GS NMS simplifies the management of Open5GS deployments by providing:

- **Complete Network Function Management** - Configure all 17 Open5GS network functions (5G Core + 4G EPC + SEPP roaming)
- **Visual Network Topology** - Interactive real-time visualization of your network infrastructure
- **Subscriber Management** - Full CRUD operations with SIM generator and auto-provisioning
- **Real-Time Monitoring** - Live service status, logs, and active session tracking
- **Safe Configuration** - Automatic backups, validation, and rollback on failure
- **5G Privacy (SUCI)** - Home network key management for subscription concealment
- **Authentication** - Session-based login protecting all pages and API endpoints
- **Voice & SMS** - Optional IMS/VoLTE core (beta — real iPhone-to-iPhone calling confirmed working) and SGs-based SMS, both provisioned and managed from the UI
- **L3 Routing (FRR)** - Guided L2→L3 migration, EIGRP/OSPF/BGP support, and a from-source FRR reinstall path
- **End-to-End Testing** - Simulated 4G/5G test UEs (UE Validation) to verify attach/PDU/paging without a physical radio

![Dashboard Overview](docs/screenshots/dashboard-overview.png)

![IMS / VoWiFi Status Split](docs/screenshots/dashboard-ims-vowifi-split.png)

---

## ✨ Key Features

### Authentication
- **Login required** — All pages and API endpoints are protected. A login form is shown automatically to unauthenticated users
- **Session persistence** — Sessions survive page refresh (24-hour lifetime by default, configurable)
- **Secure cookies** — HttpOnly, SameSite=lax; `Secure` flag enabled when behind HTTPS
- **First-run setup** — Admin account created automatically on first deploy (see [First Login](#first-login))
- **Brute force protection** — Login endpoint rate-limited to 10 attempts per 15 minutes per IP

### Metrics & Monitoring
- **Prometheus Integration** — Prometheus scrape config auto-generated and live-reloaded on every config apply. No manual `prometheus.yml` editing needed
- **Grafana Dashboards** — Pre-built Open5GS dashboard covering AMF, SMF, UPF, PCF, HSS, PCRF and process health. Grafana datasource auto-provisioned on first start
- **Metrics Endpoints Page** — Dual-mode editor: table view for individual NF address/port editing, or direct Prometheus scrape config YAML editing. Both views stay in sync
- **One-click access** — Prometheus and Grafana links directly in the Metrics page header

![Metrics Endpoint Editor](docs/screenshots/metrics-endpoint-editor.png)

![Metrics Scrape Config Editor](docs/screenshots/metrics-scrape-config.png)

![Grafana Open5GS Dashboard](docs/screenshots/metrics-grafana.png)

![Prometheus Targets](docs/screenshots/metrics-prometheus-targets.png)

### Traffic History
- **GTP U-Plane throughput over time** — aggregate across all subscribers per DNN, or filtered down to a single subscriber
- **Configurable resolution** — 5 minute, 15 minute, or 1 hour buckets, plus a flexible time-range picker
- **Live latest-rate readout** — current Up/Down Mbps shown alongside the chart
- **Built on the existing Prometheus, not a second time-series store** — reuses the already-deployed Prometheus stack's own `rate()` computation over raw cumulative byte counters exposed by the backend's own `/metrics` endpoint, so retention matches whatever Prometheus is already configured for

![Traffic History](docs/screenshots/traffic-history.png)

### Configuration Management
- **Dual Editor Modes** - Form-based editor with 150+ contextual tooltips OR Monaco YAML editor
- **All 17 Network Functions** - Complete coverage: NRF, SCP, AMF, SMF, UPF, AUSF, UDM, UDR, PCF, NSSF, BSF, SEPP (5G) + MME, HSS, PCRF, SGW-C, SGW-U (4G)
- **Real-Time Validation** - Zod schema validation with cross-service dependency checking
- **Safe Apply Workflow** - Automatic backups, ordered service restarts, automatic rollback on failure
- **YAML Preservation** - Maintains comments, formatting, and structure

![AMF Configuration Editor](docs/screenshots/config-amf-editor.png)

### RAN Network Monitoring
- **4G EPC section** — S1-MME (control plane) and S1-U (user plane) interface cards with live connected eNodeB IPs
- **5G NR section** — N2 (AMF ↔ gNodeB) and N3 (UPF ↔ gNodeB) interface cards with live connected gNodeB IPs
- **UE-to-radio mapping** — each radio card shows which UEs are connected to it (IMSI, UE IP, CM State) nested directly under the radio row
- **Active UE Sessions table** — combined 4G + 5G sessions with Generation, CM State, DNN/APN, Security algorithms, AMBR, and Radio IP columns
- **True 4G/5G separation** — sourced directly from Open5GS internal APIs (AMF, MME, SMF) — no packet capture needed
- All interface IPs sourced from Open5GS YAML configs — no hardcoded addresses

![RAN Network Page](docs/screenshots/ran-network-page.png)

### Network Topology Visualization
- **Interactive Diagram** - JointJS-based professional network topology
- **Real-Time Status** - Color-coded service indicators (green=active, red=inactive)
- **5G Radio Network Status box** — live N2 and N3 gNodeB IPs on the topology canvas
- **Active 5G UE Sessions box** — UE IP + IMSI pairs sourced from Open5GS AMF/SMF APIs
- **Active 4G UE Sessions box** — UE IP + IMSI pairs sourced from Open5GS MME API
- **Professional Layout** - Manual routing with 90-degree orthogonal connectors

![Network Topology Visualization](docs/screenshots/topology-network-diagram.png)

### Service Management
- **Real-Time Monitoring** — WebSocket-based live status cards for all 17 NFs plus MongoDB
- **Systemd Integration** — Start, stop, restart, enable and disable services directly from the UI
- **Bulk Operations** — Control all services at once in correct dependency order
- **MongoDB tracking** — MongoDB included as a first-class service with status indicator on topology

![Service Management](docs/screenshots/service-management.png)

### Auto-Configuration Wizard
- **One-Click Setup** — Generate all 16 NF configurations from minimal input (PLMN, host IPs, UE subnets)
- **Preview Changes** — YAML diff viewer shows exact changes before applying
- **Persistent NAT** — iptables rules saved via `netfilter-persistent` and IP forwarding via `sysctl.d` — survive reboots

![Auto-Configuration Wizard](docs/screenshots/auto-config-wizard.png)

### Backup & Restore
- **Automatic Backups** — Created before every configuration change; configurable retention policy
- **Selective Restore** — Restore config only, database only, both, or specific NFs
- **Rollback Protection** — Automatic restore on service restart failure
- **Diff Viewer** — Compare any backup against current config before restoring
- **Factory Defaults** — One-click restore to stock Open5GS configuration

![Backup & Restore](docs/screenshots/backup-restore.png)

![Backup & Restore Modal](docs/screenshots/backup-restore-modal.png)

### Femtocell Provisioning (Sercomm SCE4255W)
- **Auto-credential derivation** — derives root SSH and WebUI passwords from MAC address using the calc_f2 algorithm
- **Auto-config pull** — detects if WebUI is already enabled and pulls current config into the form automatically
- **Full provisioning** — enables WebUI via SSH if needed, applies all radio and core config, reboots device
- **CBRS Band 48 defaults** — pre-filled for dual-carrier deployment
- **MME IP auto-populated** from your Open5GS configuration
- **Browser geolocation** for SAS lat/long coordinates

![Femtocell Provisioning](docs/screenshots/femto-provisioning.png)

![Femtocell Config Loaded](docs/screenshots/femto-config-loaded.png)

### CBRS SAS Server (Citizens Broadband Radio Service)
- **Built-in SAS** — Lab-only SAS-CBSD protocol emulator for controlled testing. Not an FCC-approved SAS and not suitable for live CBRS authorization. For live CBRS operation, CBSDs must obtain grants from an FCC-approved SAS Administrator.
- **Multi-radio support** — deterministic per-CBSD channel assignment based on serial number sort order; race-condition-proof, survives re-registrations and Clear DB cycles
- **Interference coordination groups** — radios in the same group are automatically spread across non-overlapping 20 MHz slots
- **Multi-band support** — configure multiple frequency bands to serve different radio types (e.g. Baicells on 3560–3620 MHz, Sercomm on 3649–3700 MHz)
- **Band Assignment** — three-level band policy: per-CBSD override > interference group assignment > global default; pins specific radios or entire groups to specific frequency ranges
- **Unified spectrum view** — all radios and bands shown on a single 3550–3700 MHz plot alongside per-band detail charts
- **Multi-site scaling** — independent slot assignment per interference group; two sites can reuse the same frequencies without conflict
- **Spectrum chart** — visual frequency band display with color-coded slots, EARFCN labels, and per-CBSD assignment table
- **GPS delay enforcement** — configurable lock delay (default 75 s) before grants are issued, ensuring radios are GPS-locked before transmitting
- **Pause / Resume** — instantly stops all SAS responses (radios return DEREGISTER and go silent) without deleting any data
- **Clear DB** — wipes all grants and CBSDs in one click for testing; radios re-register and get fresh deterministic slot assignments on reboot
- **CBRS SAS protocol** — implements the WInnForum CBRS SAS-CBSD interface (registration, spectrumInquiry, grant, heartbeat, relinquishment, deregistration)
- **HTTPS SAS endpoint** — TLS endpoint on port 8443 with auto-generated self-signed certificate; required for Sercomm radios which mandate HTTPS
- **Sercomm SCE4255W full integration** — complete SAS parameter provisioning via GenieACS TR-069 including Method, Category, ChannelType, HeightType, ManufacturerPrefix, CPI settings, lat/long in microdegrees
- **Baicells TR-069 integration** — full SAS parameter provisioning via GenieACS ACS on the Baicells provisioning page
- **Quiet docker logs** — per-request SAS protocol noise suppressed; clean 30-second status summary printed to docker compose logs instead

![SAS Dashboard](docs/screenshots/sas-dashboard.png)

![SAS Spectrum Chart](docs/screenshots/sas-spectrum-chart.png)

![SAS CBSD Table](docs/screenshots/sas-cbsd-table.png)

![SAS Configuration](docs/screenshots/sas-config.png)

![SAS Band Assignment](docs/screenshots/sas-band-assignment.png)

### Baicells eNodeB Provisioning *(Beta)*
- **GenieACS TR-069 ACS integration** — radios register automatically via CWMP on port 7547
- **Live RF status** — per-radio status dot (green = RF on, amber = RF off, red = offline) with 30-second auto-refresh
- **Full config push** — all parameters sent in a single TR-069 session, followed by automatic reboot and RF enable
- **Editable confirm modal** — preview the exact GenieACS NBI API calls before anything is sent; edit the JSON if needed
- **Per-radio and global controls** — Enable RF, Disable RF, Reboot per radio; RF On All, RF Off All, Reboot All from the header
- **Auto-backup** — full device parameter snapshot saved to disk after every successful provision
- **Audit logging** — all provision, reboot, and RF actions logged
- **Tested on:** Baicells Nova 430i running BaiBLQ_3.0.12 firmware

![Baicells Provisioning Overview](docs/images/baicells-overview.png)

![Baicells Radio Expanded](docs/images/baicells-radio-expanded.png)

![Baicells RF Status](docs/images/baicells-rf-status.png)

![Baicells Confirm Modal](docs/images/baicells-confirm-modal.png)

![GenieACS UI](docs/images/genieacs-ui.png)

### Sercomm 5G NR Provisioning (SCE5164-B48) *(Beta)*
- **Dedicated "Sercomm 5G" tab** in the Auto-Config page, alongside Open5GS/Femto(4G)/Baicells
- **Full CU/DU split provisioning** — gNB identity, NG/F1 interface addressing, cell config (PLMN, TAC, PCI, S-NSSAI), and TDD slot pattern configuration in one push
- **SAS integration** — CBRS parameters (FCC ID, category, GPS location, band) provisioned alongside the radio config
- **Tested on:** Sercomm SCE5164-B48 running RC5607@230707 firmware

![Sercomm 5G NR Provisioning](docs/screenshots/sercomm-nr-provisioning.png)

### Security Gateway (SecGW) *(Alpha — Experimental)*

> ⚠️ **This module is in alpha.** Real IPsec tunnels are confirmed working end-to-end for both Baicells and Nokia radios simultaneously — real S1AP/GTP-U traffic verified flowing through the tunnel via packet capture (ESP wrapper + decrypted SCTP heartbeat, correlated by timestamp). Per-radio IPsec configuration on the radio's own page is manual — there is no automatic TR-069 push in this version.

- **Terminates IPsec from real RAN backhaul** — decrypts S1-MME/S1-U (4G) and N2/N3 (5G) traffic at the edge and forwards it in plaintext to the existing core NFs, the same "decrypt at the edge" pattern this project's VoWiFi ePDG already uses. Built on strongSwan/`swanctl`, source-built with a small patch so it coexists with VoWiFi's own IKEv2 daemon on the same host
- **Vendor-aware Radios tab** — separate Baicells and Nokia sub-tabs, since the two vendors' IPsec models are fundamentally different: Baicells negotiates a virtual IP dynamically via IKEv2 Configuration Payload, while Nokia has no CP support at all and instead uses static tunnel endpoints plus one or more explicit "Protect" traffic-selector policies
- **Per-radio dedicated pool addresses** — every radio gets its own unique address, never a shared range, avoiding kernel XFRM policy collisions between radios
- **Additional Protected Destinations** — extend a radio's tunnel to reach more than the core NF pair (e.g. the internal BIND DNS server), for radios whose own IPsec page can't do a plaintext bypass for that traffic
- **Full connection-info sheet per radio** — downloadable bundle (cert/PSK plus a plain-language cheat sheet) with the exact values to enter on the radio's own IPsec page, using that vendor's own field names and terminology
- **Live Sessions view** — real-time IKE/CHILD SA status, traffic selectors, and byte counters per radio, parsed straight from `swanctl --list-sas`
- **Additive by design** — adding a radio never touches its existing plaintext path; the operator manually re-points the radio at the gateway only after verifying the tunnel with the built-in Test Tunnel button
- `ENABLE_SECGW_MODULE` defaults **disabled** (opt-in)

![SecGW Setup](docs/screenshots/secgw-setup.png)

![SecGW Baicells Radios](docs/screenshots/secgw-baicells-radios.png)

![SecGW Nokia Radios](docs/screenshots/secgw-nokia-radios.png)

![SecGW Nokia Radio Details](docs/screenshots/secgw-nokia-radio-details.png)

![SecGW Live Sessions](docs/screenshots/secgw-live-sessions.png)

### SUCI Key Management (5G Privacy)
- **Keypair Generation** — Create X25519 (Profile A) or secp256r1 (Profile B) home network keys
- **Public Key Display** — Hex format ready for eSIM provisioning
- **pySIM JSON Generator** — One-click generation of correctly formatted `EF.SUCI_Calc_Info` JSON for pySIM-shell, in both pretty and single-line formats
- **Automatic Configuration** — Updates UDM config with new public key on generate/rotate
- **PKI Management** — Support for multiple PKI values (0–255) with next-ID auto-suggestion, rename without destroying keys

![SUCI Key Management](docs/screenshots/suci-keys.png)

![Generate Key Modal](docs/screenshots/suci-generate-key-modal.png)

![pySIM JSON Generator](docs/screenshots/suci-pysim-json.png)

### Subscriber Management
- **Full CRUD Operations** - Create, read, update, delete subscribers via MongoDB
- **SIM Generator** - Generate test SIM credentials with country-based MCC selection (65+ countries)
- **Auto-Provisioning** - Automatically add generated SIMs to Open5GS database
- **Multi-Slice Support** - Configure multiple network slices and sessions per subscriber
- **Search & Pagination** - Efficient browsing of large subscriber databases
- **Subscriber Groups** — organize subscribers into named, colored groups (e.g. "Field trial A", "Test devices") for easier browsing of large deployments
- **Framed Routing** — configure IPv4/IPv6 subnets routed behind a UE per session (TS 23.501 §5.6.14, e.g. an IoT gateway's LAN); optional one-click static host route management, non-blocking overlap/duplicate warnings against other subscribers and the core UE pool, and a Framed Routes Registry view listing every configured subnet across all subscribers

![Subscriber Management](docs/screenshots/subscribers-list.png)

![Subscriber Groups](docs/screenshots/subscriber-groups.png)

![SIM Generator](docs/screenshots/sim-generator-dialog.png)

### Time Server (NTP via Chrony)
- **Chrony integration** — manages Chrony NTP daemon directly from the NMS; start, stop, restart, and configure without touching the CLI
- **Live tracking status** — reference server, stratum, system offset, RMS offset, frequency, root delay, update interval, and leap status all shown live
- **NTP server & pool management** — add, remove, and reorder upstream servers and pools with iburst/noselect flags
- **Allowed client networks** — configure which subnets can query the NTP server (critical for radios and UEs)
- **Advanced options** — makestep, maxdistance, and other Chrony directives exposed in the UI
- **Save & Restart** — writes `chrony.conf` and restarts the daemon in one click

![Time Server](docs/screenshots/screenshot-time-server.png)

### FRR / L3 Routing
- **Layer 2 → Layer 3 migration wizard** — step-by-step guided migration from flat L2 service IPs to routed L3 using FRR + Virtual Service Interfaces (VSIs)
- **Multi-protocol support** — EIGRP, OSPF, and BGP; each protocol generates correct FRR config with appropriate neighbor/peer setup
- **Live Routing Status** — real-time neighbor status, EIGRP/OSPF/BGP topology table showing all prefixes, next-hops, interfaces, and metrics
- **Route Filters** — outbound and inbound prefix-list based filtering with Auto VSI filter button, preview, apply, and rollback
- **Active Configuration** — read-only summary of protocol, AS number, peer IP, and VSI mappings once migration is complete
- **Pre-flight checklist** — built-in requirements guide covering the 3 required interfaces, router-side prerequisites, and known FRR 8.4.x EIGRP limitations
- **Full rollback** — backup taken before any changes; rollback button restores previous state at any phase
- **Reinstall (Source)** — migrates FRR from the Ubuntu apt package (8.4.4, has long-standing eigrpd assertion-crash bugs) to a from-source build, with automatic backup, build, config-restore, and rollback
- **FRR log-level selector** — dropdown for FRR's 8 syslog severities (emergencies…debugging), applied via `vtysh -b` reload with no neighbor flap
- **TUN Interfaces & Dummy Interfaces** — now sub-tabs of this page (grouped alongside routing), instead of separate top-level nav items. TUN interfaces persist across reboots via systemd-networkd `.netdev`/`.network` files

![FRR / L3 Routing — Live Status](docs/screenshots/screenshot-l3-routing-status.png)

![FRR / L3 Routing — Route Filters](docs/screenshots/screenshot-l3-routing-filters.png)

![FRR / L3 Routing — Active Configuration](docs/screenshots/screenshot-l3-routing-config.png)

![FRR / L3 Routing — Reinstall from Source](docs/screenshots/frr-source-build.png)

### SEPP / 5G Roaming (N32)
- **17th core NF** — SEPP (`open5gs-seppd`) gets its own Config tab alongside the other 16 NFs, included in the standard bulk Apply Config / backup / restart flow
- **Home SEPP configuration** — SBI server/client, N32-c and N32-f identity, scheme, address, and port
- **Optional TLS/mutual-TLS on N32** — toggle between plaintext HTTP and TLS; "Generate Certs" creates a self-signed keypair for your home SEPP and displays the public cert for handing to a visited-network operator; paste their public cert back in as the trusted peer CA
- **Generate Visited PLMN Config** — builds a complete, downloadable `sepp.yaml` for the visited operator from your already-configured home SEPP values, including your public cert when TLS is enabled

![SEPP Configuration](docs/screenshots/sepp-config.png)

### DNS (BIND9) / FQDN Migration Wizard
- **BIND9 zone management** — dedicated "DNS (BIND9)" page for managing the DNS server backing your core's internal domain resolution
- **FQDN migration wizard** — converts the entire core from hardcoded IP addressing to 3GPP FQDN/DNS addressing (`5gc.mnc<mnc>.mcc<mcc>.3gppnetwork.org` for SBI, `epc.mnc<mnc>.mcc<mcc>.3gppnetwork.org` for the EPC Diameter mesh), matching carrier-grade deployment conventions and Open5GS's own roaming tutorial
- **Phased, reversible** — Phase A (DNS zones only), Phase B (EPC/Diameter mesh), Phase C (5G SBI mesh); a fresh backup is taken before B/C and rollback stays available as long as it exists
- **SEPP-aware** — includes SEPP's local SBI client in the FQDN scheme (its N32 peer to the visited PLMN is deliberately excluded — that's a different operator's DNS, not something local zone management can resolve)

![DNS / FQDN Migration Wizard](docs/screenshots/dns-migration-wizard.png)

### Real-Time Logging
- **Four log sources** — Open5GS systemd services, Docker containers, GenieACS access logs, and FRR, all streamed live via WebSocket
- **Live Log Streaming** — Tail logs from any service, with multi-select service/container filtering
- **Major Events view** — a filtered timeline of just the meaningful transitions (radio connect/disconnect, 4G attach/detach, 5G register/deregister, PDU session up/down) instead of raw DEBUG noise, across all 16 NF streams at once. Filter by event type, radio, and IMSI; click any event to open a zoomable log-context viewer showing the surrounding raw lines
- **Syslog Forwarding** — forwards all Open5GS, GenieACS, and FRR logs to a remote syslog server (e.g. Graylog) via rsyslog. Detects/installs rsyslog automatically, writes a dedicated drop-in config that never touches your existing rsyslog setup, and self-heals the AppArmor and file-permission issues that otherwise silently block it
- **Log Download & Debug Bundle** — download raw logs by service/date range, or a one-click debug bundle for bug reports

![Log Viewer](docs/screenshots/logs-viewer.png)

![Major Events Log View](docs/screenshots/major-events-view.png)

![Syslog Forwarding](docs/screenshots/syslog-forwarding-modal.png)

### IMS / VoLTE *(Beta)*

> ⚠️ **This module is in beta.** Real UE-to-UE VoLTE calling is confirmed working end-to-end on real iPhone hardware (PLMN 001-01) — dedicated QCI=1 voice bearers, RTP audio, the works. Android VoLTE support is still in progress and does not work yet. Manual configuration beyond what this page automates may still be needed for other device/carrier combinations.

- **Full IMS core integration** — P-CSCF/I-CSCF/S-CSCF (Kamailio 5.8.8, built with IMS/TLS/MySQL/extra modules), PyHSS Diameter HSS, BIND9 DNS, RTPEngine, MariaDB
- **One-click install** of every IMS component, including PyHSS ([nickvsnetworking/pyhss](https://github.com/nickvsnetworking/pyhss)), cloned and set up automatically — no separate manual install required
- **Guided configuration** — wires the P-CSCF address into SMF's PCO and per-session DNS, writes the Cx/Rx Diameter peer XML, and generates the IMS DNS zone automatically
- **Subscriber sync** — pushes IMPI/IMPU identities for your existing subscribers into PyHSS's HSS database
- **Real-phone VoLTE confirmed** — two real, registered iPhones calling each other rings and connects with full audio, including a real P-CSCF↔PCRF Rx interface for dedicated QCI=1 bearers, on PLMN 001-01
- **Known limitation** — Android VoLTE support is still in progress and not yet confirmed working

![IMS Configuration](docs/screenshots/ims-config.png)

### SMS over SGs *(Beta)*
- **Osmocom CS-fallback SMS stack** — `osmo-stp` + `osmo-hlr` + `osmo-msc`, connected to the MME via the SGs interface, for SMS delivery without any IMS/VoLTE deployment
- **One-click install** — packages, service lifecycle (start/stop/restart/enable/disable), and subscriber sync all from the UI
- **Config file editor** — Monaco-based editor for all three Osmocom `.cfg` files with per-file save and save-and-restart
- **Architecture panel** — built-in diagram explaining how SMS over SGsAP works, right on the page
- Requires a combined EPS/IMSI attach from the UE

![SMS over SGs](docs/screenshots/sms-config.png)

### MMS *(Beta)*

> ⚠️ **This module is in beta.** Real end-to-end MMS confirmed working on a real UE. `ENABLE_MMS_MODULE` defaults **disabled** (opt-in).

- **VectorCore MMSC** ([vectorcore-mobile](https://github.com/vectorcore-mobile)) — built from source (Go toolchain + embedded web UI) and installed as a host service with one click; delivery notifications ride on the existing SMS (SGs) SMPP interface, so IMS/SMS must already be configured
- **Direct links to VectorCore's own admin UI and JSON API** — this page doesn't reimplement them, it links straight out
- **Subscriber sync** — pushes MSISDNs from the Open5GS MongoDB into VectorCore so it knows which numbers can send/receive MMS
- **iPhone MMS Settings Profile generator** — iOS hides the manual APN/MMSC settings screen on most SIMs; generates a ready-to-install `.mobileconfig` with the correct MMSC URL pre-filled
- **Real upstream bugs found and patched** — VectorCore's MM1 request-path logging defaulted too quiet to diagnose delivery issues, and real phones send MMS PDUs with no usable `From` field; fixed with a small compiled-Go reverse proxy (`mm1-msisdn-proxy.go`, its own systemd unit, built during every Configure) that resolves the sender's MSISDN from the UE's Framed-Routing IP and injects the `X-MSISDN` header VectorCore expects
- Lives as a second tab on the SMS/MMS page, not a separate nav entry

![MMS Setup](docs/screenshots/mms-setup.png)

![MMS iPhone Settings Profile](docs/screenshots/mms-iphone-profile.png)

### VoWiFi *(Alpha — Experimental)*

> ⚠️ **This module is in alpha.** Real SIP signaling over VoWiFi is confirmed working end-to-end on a real phone — full IKEv2/EAP-AKA' attach, a real REGISTER → 401 Challenge → REGISTER → 200 OK → SUBSCRIBE → NOTIFY exchange, and a real iPhone-to-iPhone call with two-way audio. VoWiFi-to-VoLTE calling still has an open issue (connects with audio, drops after a few seconds). Do not rely on this for a production voice deployment yet.

- **VectorCore ePDG + VectorCore AAA** ([vectorcore-mobile](https://github.com/vectorcore-mobile)) — a native Go/eBPF ePDG (XDP/TC-BPF GTP-U dataplane) paired with an Erlang Diameter AAA stack (SWx to the HSS, SWm relay from the ePDG, S6b to the SMF), built from source and installed with one click
- **Config file editor** — Monaco-based editor for `epdg.yaml`/`aaa.config` with save and save-and-restart
- **Live Sessions page** — real-time client list (IMSI, UE IP, outer IP, APN, state) plus aggregate Clients/IKE SAs/Child SAs/Bearers counters, proxied straight from VectorCore ePDG's own admin API
- **Automatic staleness detection** — separate "reinstall available" and "reconfigure available" banners track vendored source patches and generated-config drift independently, so a deployment never silently runs stale patches after an update
- **Real upstream bugs found and patched** — including a same-host uplink GTP-U delivery bug (VectorCore's TC-BPF dataplane assumed a remote, ARP-resolvable PGW; fixed with a userspace ringbuf delivery path for the always-colocated case this project uses) and a half-open IKE SA reaper leak — both patched automatically during the vendored source build, not just live on one host

![VoWiFi Setup](docs/screenshots/vowifi-setup.png)

![VoWiFi Live Sessions](docs/screenshots/vowifi-live-sessions.png)

### UE Validation *(Beta)*
- **Simulated test UEs** — spin up a 4G (srsRAN) or 5G (UERANSIM) test UE against your live core, no physical radio needed
- **End-to-end validation** — confirms attach, PDU session establishment, and idle-mode paging/wake all the way down to actual bidirectional traffic
- **Live log tailing & raw log download**, with session state that survives an NMS backend restart
- **Known limitation** — 5G idle-mode paging is unconfirmed (UERANSIM's simulated gNB may not implement an inactivity timer the way a real eNB does); 4G is fully verified end-to-end, 5G connected-state reachability is fully verified

![UE Validation](docs/screenshots/ue-validation-main.png)

![UE Validation — Running](docs/screenshots/ue-validation.png)

---

## 🚀 Quick Start

### Prerequisites

- **Ubuntu 24.04 LTS** (or compatible Linux distribution)
- **Open5GS 2.7+** installed and configured
- **MongoDB 6.0+** running on localhost
- **Docker Engine 24.0+** and **Docker Compose v2.20+**

> Optional modules (IMS/VoLTE, SMS over SGs, FRR-from-source, Syslog Forwarding) install their own additional host packages on first use, directly from their respective pages — see **[docs/requirements.md](docs/requirements.md#software-requirements)** for the full list before enabling them.

### Installation

```bash
# Clone the repository
git clone https://github.com/paulmataruso/open5gs-nms
cd open5gs-nms

# Configure environment (required — see Authentication section below)
cp .env.example .env
nano .env

# Build and start all services
docker compose up --build -d

# Access the web interface
open http://YOUR_SERVER_IP:8888
```

For detailed installation instructions, see **[INSTALL.md](INSTALL.md)**.

---

## 🔐 Authentication

### First Login

On first startup, an admin account is created automatically.

**Option A — Set your own password (recommended):**

Add this to your `.env` before running `docker compose up`:

```bash
FIRST_RUN_PASSWORD=your-secure-password-here
```

Then log in with username `admin` and the password you set. Clear `FIRST_RUN_PASSWORD` from `.env` after your first login.

**Option B — Auto-generated password:**

Leave `FIRST_RUN_PASSWORD` empty. A random password is generated and printed once to the container logs:

```bash
docker logs open5gs-nms-backend 2>&1 | grep -A4 "FIRST RUN"
```

Expected output:
```
════════════════════════════════════════════════════
  FIRST RUN — Admin account created
  Username : admin
  Password : Xk7mQ2pL9nRv4wYa
  Change this password after first login!
════════════════════════════════════════════════════
```

> **Missed the password?** Delete the auth database and restart:
> ```bash
> docker compose down && rm -f ./data/auth.db && docker compose up -d
> ```

### Auth Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `FIRST_RUN_PASSWORD` | *(empty)* | Initial admin password. Auto-generated if empty. Clear after first login. |
| `SESSION_MAX_AGE` | `86400` | Session lifetime in seconds (default: 24 hours) |
| `COOKIE_SECURE` | `false` | Set to `true` **only** when serving over HTTPS. Setting this to `true` on plain HTTP silently breaks login. |
| `AUTH_DB_PATH` | `/app/data/auth.db` | Path to SQLite auth database inside container. Must match the `./data:/app/data` volume mount. |

### HTTPS Deployments

When running behind HTTPS (nginx + SSL), set `COOKIE_SECURE=true` in `.env`:

```bash
COOKIE_SECURE=true
```

See **[docs/deployment.md](docs/deployment.md)** for full nginx SSL configuration.

---

## 📋 System Requirements

### Minimum
- **CPU:** 2 cores
- **RAM:** 4GB
- **Disk:** 20GB free space

### Recommended
- **CPU:** 4 cores
- **RAM:** 8GB
- **Disk:** 50GB free space (for logs and backups)

### Network
- Static IP address or DHCP reservation recommended
- Port 8888 for web interface
- Internet access for Docker builds

For complete requirements, see **[docs/requirements.md](docs/requirements.md)**.

---

## 📖 Documentation

### Getting Started
- **[Installation Guide](INSTALL.md)** - Step-by-step installation instructions
- **[Configuration Guide](docs/configuration.md)** - Network function configuration reference

### User Guides
- **[Features Overview](docs/features.md)** - Detailed feature documentation
- **[Subscriber Management](docs/subscribers.md)** - Provisioning and SIM generation
- **[SUCI Key Management](docs/suci.md)** - 5G privacy configuration
- **[Backup & Restore](docs/backup.md)** - Data protection strategies

### Administration
- **[Deployment Guide](docs/deployment.md)** - Production deployment best practices
- **[Troubleshooting](docs/troubleshooting.md)** - Common issues and solutions
- **[API Reference](docs/api-reference.md)** - Backend REST API documentation

### Development
- **[Architecture](ARCHITECTURE.md)** - System design and component overview
- **[Development Guide](docs/development.md)** - Local development setup
- **[Contributing](CONTRIBUTING.md)** - How to contribute to the project

---

## 🏗️ Architecture

The Open5GS NMS follows a **Clean Architecture** pattern with clear separation of concerns:

```
┌─────────────────────────────────────────────────────────────┐
│  Browser (React 18 + TypeScript + JointJS)                  │
│  http://YOUR_SERVER:8888                                     │
└───────────────┬──────────────────┬──────────────────────────┘
                │ REST API         │ WebSocket
                ▼                  ▼
┌─────────────────────────────────────────────────────────────┐
│  nginx Reverse Proxy (Alpine)                                │
│  Proxies /api → backend:3001                                 │
│  Upgrades WebSocket → backend:3002                           │
└───────────────┬──────────────────┬──────────────────────────┘
                │                  │
                ▼                  ▼
┌─────────────────────────────────────────────────────────────┐
│  Backend (Node.js 20 + TypeScript + Express)                │
│  Clean Architecture: Domain → Application → Infrastructure   │
│  Auth: Lucia v3 sessions → SQLite (auth.db)                 │
│  Container: privileged, network_mode: host                   │
└─────┬──────────┬──────────┬───────────┬──────────────────┬─┘
      │          │          │           │                  │
      ▼          ▼          ▼           ▼                  ▼
 /etc/open5gs  systemd   MongoDB    auth.db           /var/log
 (bind mount)  (via dbus) (host:27017) (./data volume) (bind mount)
```

### Technology Stack

**Frontend:**
- React 18.2, TypeScript 5.3, Vite 5.0
- TailwindCSS 3.4, Zustand 4.4
- JointJS 3.7 (topology), Monaco Editor 4.6 (YAML)

**Backend:**
- Node.js 20 LTS, TypeScript 5.3, Express 4.18
- Lucia v3 (sessions), better-sqlite3 (auth DB), oslo (bcrypt)
- Zod 3.22 (validation), MongoDB Native Driver 6.3
- WebSocket (ws) 8.16, Pino 8.17 (logging)

**Infrastructure:**
- Docker + Docker Compose
- nginx (reverse proxy)
- systemd (service management)

For detailed architecture documentation, see **[ARCHITECTURE.md](ARCHITECTURE.md)**.

---

## 🔧 Configuration

The NMS is configured through environment variables. Copy `.env.example` to `.env` and customize:

```bash
# Authentication (review before first deploy)
FIRST_RUN_PASSWORD=your-password    # Initial admin password
SESSION_MAX_AGE=86400               # Session lifetime in seconds
COOKIE_SECURE=false                 # Set true only for HTTPS deployments

# Backend
PORT=3001
WS_PORT=3002
MONGODB_URI=mongodb://127.0.0.1:27017/open5gs
CONFIG_PATH=/etc/open5gs
LOG_LEVEL=info
HOST_SYSTEMCTL_PATH=/usr/bin/systemctl

# Simlessly eSIM API (Subscribers page — "Generate eSIM", optional)
SIMLESSLY_ACCESS_KEY=          # From your Simlessly account's Developer module
SIMLESSLY_SECRET_KEY=          # Same place — never commit real values
```

Default values work for most deployments. For production, see **[docs/deployment.md](docs/deployment.md)**.

### eSIM Generation (Simlessly)

The Subscribers page can generate real eSIM activation codes via the
[Simlessly](https://docs.simlessly.com) RSP platform's Single Generate AC API. This
requires `SIMLESSLY_ACCESS_KEY`/`SIMLESSLY_SECRET_KEY` — obtained by logging into your
own Simlessly account's Developer module. Without them, the JSON preview/copy still
works, but "Generate via Simlessly API" will return an error. See
**[docs/features.md](docs/features.md#esim-generator-simlessly-api)** for details.

---

## 🛡️ Security

### What's protected
- All API endpoints require a valid session cookie
- Login is rate-limited (10 attempts / 15 min per IP)
- Passwords are bcrypt-hashed
- Session cookies are HttpOnly (not accessible to JavaScript)
- Auth data is stored in a separate SQLite database — the Open5GS MongoDB is never touched for auth

### Production recommendations

1. **Enable HTTPS** — Configure nginx SSL termination (Let's Encrypt) and set `COOKIE_SECURE=true` in `.env`
2. **Network restrictions** — Deploy behind a VPN or firewall for internet-exposed instances
3. **Regular backups** — Automate backup jobs and store copies off-site
4. **Monitoring** — Set up external monitoring (Prometheus, Grafana)

See **[docs/deployment.md](docs/deployment.md)** for detailed hardening guidance.

---

## 🤝 Contributing

We welcome contributions! Whether it's bug reports, feature requests, or code contributions, please see our **[Contributing Guide](CONTRIBUTING.md)**.

### Development Setup

```bash
# Clone repository
git clone https://github.com/paulmataruso/open5gs-nms
cd open5gs-nms

# Backend development
cd backend
npm install
npm run dev      # Runs on http://localhost:3001

# Frontend development (separate terminal)
cd frontend
npm install
npm run dev      # Runs on http://localhost:5173
```

For detailed development instructions, see **[docs/development.md](docs/development.md)**.

---

## 📝 Changelog

See **[CHANGELOG.md](CHANGELOG.md)** for a complete version history.

### Latest Release: v2.0-beta_0.47 (2026-08-14)

**🆕 New Module: Security Gateway (SecGW)**
- IPsec termination for real RAN backhaul (S1-MME/S1-U, N2/N3) — confirmed live for
  both Baicells and Nokia radios simultaneously, real S1AP/GTP-U traffic verified
  flowing through the tunnel via packet capture
- Vendor-split Radios tab (Baicells / Nokia), since the two vendors' IPsec models are
  fundamentally different — Baicells negotiates a virtual IP dynamically via IKEv2
  Configuration Payload, Nokia uses static tunnel endpoints and explicit traffic
  selectors with no CP support at all
- Per-radio dedicated pool addresses, an "Additional Protected Destinations" field for
  radios needing to reach more than the core NF pair, and downloadable connection-info
  bundles that use each vendor's own field names and terminology
- `ENABLE_SECGW_MODULE` defaults **disabled** (opt-in)

**🛠️ Fixes**
- VoWiFi's Setup tab no longer shows a first-run "Run Install" prompt once already
  installed, matching the fix already applied to SecGW's own Setup tab — audited every
  other install-flow page in the app and confirmed none of the others had this bug
- A phantom `nms-btn-secondary` CSS class (referenced in 5 places, never actually
  defined) meant those buttons rendered with no styling at all — fixed, along with
  three more of the same class of bug (`nms-accent-hover`, `nms-surface-1`,
  `nms-text-secondary`, all referenced but undefined Tailwind color tokens) and a
  missing `nms-checkbox` style that had left every checkbox in the app as an unstyled
  native browser checkbox

See **[CHANGELOG.md](CHANGELOG.md)** for the full history.

---

## 📄 License

Copyright (C) 2026 Paul Mataruso

This project is licensed under the **GNU Affero General Public License v3.0 (AGPL-3.0)** — see the [LICENSE](LICENSE) file for details.

In plain terms:
- You are free to use, modify, and distribute this software
- If you run a modified version on a server and users interact with it over a network, you must make your modified source code available to those users under the same license
- Commercial use requires either compliance with AGPL-3.0 or a separate commercial license agreement with the copyright holder

For commercial licensing inquiries, open an issue or discussion on [GitHub](https://github.com/paulmataruso/open5gs-nms).

---

## 🙏 Acknowledgments

- **[Open5GS Project](https://open5gs.org/)** - The open-source 5G Core and EPC implementation
- **[Stacy Vinson (svinson1121)](https://github.com/svinson1121)** and the **[VectorCore Mobile](https://github.com/vectorcore-mobile)** project - VectorCore ePDG, VectorCore AAA, and VectorCore MMSC, which power this NMS's VoWiFi (ePDG/AAA) and MMS (MMSC) backends
- **[Lucia Auth](https://lucia-auth.com/)** - Session management library
- **[JointJS](https://www.jointjs.com/)** - Professional diagramming library
- **[React](https://reactjs.org/)** and **[TypeScript](https://www.typescriptlang.org/)** communities

---

## 📞 Support

- **Documentation:** [docs/](docs/)
- **Installation Issues:** [INSTALL.md](INSTALL.md) → [docs/troubleshooting.md](docs/troubleshooting.md)
- **Bug Reports:** [GitHub Issues](https://github.com/paulmataruso/open5gs-nms/issues)
- **Feature Requests:** [GitHub Issues](https://github.com/paulmataruso/open5gs-nms/issues)
- **Discussions:** [GitHub Discussions](https://github.com/paulmataruso/open5gs-nms/discussions)

---

**Built with ❤️ for the Open5GS community**
