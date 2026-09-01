// Common tooltips used across multiple NFs
export const COMMON_TOOLTIPS = {
  sbi_address: "Service-Based Interface bind address — the IP this NF listens on for HTTP/2 connections from every other 5G core NF (registration with NRF, discovery queries, and direct NF-to-NF API calls like SMF↔PCF or AMF↔SMF). Use a dedicated loopback alias (e.g. 127.0.0.x) per NF when everything runs on one host — Open5GS's convention throughout this project — so no two NFs ever collide on the same port. Only use a real routable IP if NFs on other hosts need to reach this one directly.",
  sbi_port: "Service-Based Interface port. Default: 7777 for essentially every 5G NF in this stack — safe to leave identical across NFs precisely because each one gets its own bind address instead of sharing an IP. If you do change it, remember any other NF's static peer config (SCP URI, direct NF references) pointing at this NF must be updated to match.",
  sbi_advertise: "Optional hostname/FQDN this NF announces to the NRF instead of its raw bind address (e.g. nrf.5gc.mnc001.mcc001.3gppnetwork.org:7777). Other NFs doing dynamic NRF/SCP-based discovery will connect to this name rather than the literal IP — useful when the advertised name needs to resolve differently for different callers (e.g. across a roaming/SEPP boundary), or simply to make discovery output more readable. Leave blank to advertise the bind address as-is, which is correct for the overwhelming majority of single-host deployments. Gotcha: whatever FQDN you put here must actually resolve wherever it's used — 3GPP NFs perform synchronous DNS resolution of their own advertised FQDN at startup and abort fatally if it doesn't resolve (see this project's DNS/BIND9 troubleshooting notes).",
  scp_uri: "Service Communication Proxy URI. When set, this NF routes its outbound SBI calls through the SCP for indirect communication mode instead of resolving each peer directly via NRF — useful for centralized routing/load-balancing/mTLS termination in larger deployments. Leave empty for direct NRF discovery mode, which is simpler, has one fewer moving part to debug, and is what most deployments (including small/single-site ones) should default to unless there's a specific reason to run an SCP.",
  nrf_uri: "URI of the Network Repository Function this NF registers with and queries for discovering other NFs. Format: http://ip:port (matching the NRF's own sbi_address/sbi_port). This is the entry point into the whole 5G service-discovery mesh — if it's wrong or the NRF is down, this NF can still start but will fail to register itself and won't be able to discover any peer NF it needs to talk to.",
  log_path: "Full filesystem path to this NF's log file. The parent directory must already exist and be writable by the systemd service user this NF runs as — Open5GS NFs fail to start (not silently skip logging) if the log path is invalid, so this is worth checking first whenever an NF won't come up after a config change.",
  log_level: "Logging verbosity: fatal, error, warn, info, debug, trace (each level includes everything more severe than it). trace/debug show essentially every protocol message this NF sends/receives — extremely useful when actively diagnosing a specific failure, but high-volume and not meant for steady-state operation. info is the right default for a working deployment. warn/error strip logging down to genuine problems once you've confirmed things are healthy.",
  mongodb_uri: "MongoDB connection string this NF uses for persistent storage (subscriber profiles, policy data, or binding state depending on which NF). Format: mongodb://host:port/database. Every core NF that touches subscriber-related state shares the same open5gs database — pointing different NFs at different databases/hosts by mistake is a real, hard-to-spot misconfiguration since each NF will individually connect fine but see inconsistent data.",
  mcc: "Mobile Country Code — a 3-digit country identifier per ITU-T E.212, the first component of every PLMN ID in this deployment. Examples: 001 = test networks (this deployment's current PLMN), 310 = USA, 234 = UK, 262 = Germany. Every core NF's MCC must agree with each other and with what the RAN actually broadcasts — a mismatch anywhere in the chain causes UEs to see this as a foreign/forbidden network and refuse to attach.",
  mnc: "Mobile Network Code — a 2 or 3-digit operator identifier that, combined with MCC, forms the complete PLMN ID subscribers' SIMs match against. Must be identical across every NF's own configuration and match what subscriber SIM/eSIM profiles expect as their home network.",
  metrics_address: "Bind address for this NF's Prometheus metrics HTTP endpoint, exposing internal counters/gauges (session counts, message rates, error counts depending on the NF) for scraping. This project's existing Prometheus instance (open5gs-prometheus, already deployed) scrapes every NF's own :9090/metrics via sync-prometheus-config.ts — this address is what gets registered as that scrape target.",
  metrics_port: "Port the metrics server listens on. Default: 9090 across every NF in this stack (again safe because each NF has its own bind address) — this is the port Prometheus's scrape config expects, so changing it requires updating the scrape target too or this NF's metrics silently stop appearing in Grafana.",
};

// UPF (User Plane Function) Tooltips
export const UPF_TOOLTIPS = {
  pfcp_address: "Bind address for the UPF's PFCP (N4) server — the control-plane channel the SMF uses to install, modify, and delete packet-forwarding and QoS rules for each active PDU session. Must exactly match the address the SMF is configured to reach this UPF at (SMF's upf_address); a mismatch here is the classic 'registration succeeds but no data session ever comes up' failure mode, since the PFCP association between SMF and UPF simply never forms.",
  pfcp_port: "PFCP protocol port. Default: 8805 — PFCP (Packet Forwarding Control Protocol) is the 3GPP N4 protocol carrying every session-establishment/modification/deletion rule from SMF to UPF. Must match the port the SMF is configured to send PFCP requests to.",
  gtpu_address: "GTP-U tunnel endpoint address — where this UPF receives encapsulated user-plane traffic from the RAN over N3 (5G, from gNodeB) or S1-U (4G, from eNodeB via SGW-U). This is the address radios actually send subscriber data packets to; if it's not reachable from the RAN (wrong IP, firewall, missing IPsec/SecGW route), UEs can register and even get a PDU session established at the control-plane level while all their actual data traffic silently goes nowhere.",
  gtpu_port: "GTP-U port for the data plane. Default: 2152 — GTP-U (GPRS Tunneling Protocol, User plane) is the tunnel encapsulation every generation of 3GPP RAN uses to deliver subscriber IP packets to the core. Radios connect to this exact port; changing it requires the radio's own S1-U/N3 configuration to match, which most CBRS/femtocell TR-069 provisioning flows in this project don't expose as an editable field, so leaving this at the default is strongly recommended.",
  session_subnet: "IPv4 address pool (CIDR notation) this UPF assigns to UE data sessions. Size it for your actual expected concurrent-session peak with real headroom — exhausting this pool causes new PDU session requests to fail even though the rest of the network is completely healthy. Must not overlap with any other DNN's pool, the host's own LAN, or any VPN/tunnel address space already in use.",
  session_gateway: "Gateway IP for UE traffic within this session pool — the default route every UE in this pool sees for its PDU session, and where the UPF terminates the corresponding TUN interface locally. Conventionally the first usable address in session_subnet.",
  advertise: "External IP address this UPF advertises during PFCP session setup if it sits behind NAT (i.e., its real routable address differs from what it sees as its own local address). Leave empty if the UPF is directly reachable at its configured address — setting this incorrectly when it isn't actually needed can break PFCP F-TEID negotiation in subtle ways, so only populate it when you've confirmed NAT is genuinely in the path.",
  log_path: "UPF log file path — packet-forwarding rule installs/removals, PFCP session events, and throughput statistics land here. Parent directory must exist and be writable by open5gs-upfd.",
  log_level: "UPF log verbosity. trace shows per-packet forwarding decisions — extremely detailed and a real performance cost under load, so reserve it for short diagnostic windows only. info is sufficient for production and is the right default once the data plane is confirmed working.",
};

// AUSF (Authentication Server Function) Tooltips
export const AUSF_TOOLTIPS = {
  ...COMMON_TOOLTIPS,
  ausf_specific: "The AUSF's job is 5G-AKA (Authentication and Key Agreement) — it sits between AMF and UDM during registration, requesting authentication vectors from UDM and running the actual challenge/response exchange with the UE via AMF. If AUSF can't reach UDM (SBI misconfiguration, UDM down) every UE registration on this core fails at the authentication step, well before it would ever reach SMF/PDU-session logic — a useful fact when narrowing down where an attach failure is actually happening.",
};

// UDM (Unified Data Management) Tooltips
export const UDM_TOOLTIPS = {
  ...COMMON_TOOLTIPS,
  hnet_id: "Home Network Public Key Identifier (1-255) — tells the UDM which of its provisioned private keys to use when decrypting a UE's SUCI (Subscription Concealed Identifier) back into a real IMSI/SUPI. This value must exactly match the Home Network Public Key ID baked into the subscriber's SIM/eSIM during provisioning (see the SIM Generator / SUCI Key Management pages) — a mismatch causes SUCI decryption to fail, which manifests as the UE never successfully completing 5G-AKA even though its credentials are otherwise correct.",
  hnet_scheme: "SUCI protection scheme this key pair implements: 1 = Profile A (X25519/Curve25519 elliptic curve), 2 = Profile B (secp256r1/prime256v1). Must match the scheme the SIM/eSIM was provisioned with — the two profiles are cryptographically incompatible, so a mismatch is a hard failure, not a degraded one.",
  hnet_key: "Filesystem path to the private key file used for SUCI decryption, paired with the public key provisioned onto subscriber SIMs during personalization. Format: /etc/open5gs/hnet/curve25519-{id}.key (Profile A) or secp256r1-{id}.key (Profile B). This file is genuinely security-sensitive — anyone with read access to it can decrypt any SUCI encrypted against the matching public key, i.e. recover any subscriber's real IMSI from an intercepted attach.",
};

// UDR (Unified Data Repository) Tooltips
export const UDR_TOOLTIPS = {
  ...COMMON_TOOLTIPS,
  mongodb_uri: "MongoDB connection used for subscriber data, authentication vectors, and policy/session-management subscription data — this is the actual system-of-record database that UDM, PCF, and BSF all read through the UDR rather than querying MongoDB directly themselves (UDR is the 3GPP-defined data-repository abstraction layer in front of it). Every NF that needs this data must point at the same MongoDB instance/database, or they'll each see a different, inconsistent view of subscribers.",
};

// PCF (Policy Control Function) Tooltips
export const PCF_TOOLTIPS = {
  ...COMMON_TOOLTIPS,
  mongodb_uri: "MongoDB connection for policy rules, charging rules, and QoS policy templates the PCF applies to sessions. Can point at the same database/instance as UDR's — this project's default deployment shares one MongoDB across every NF that needs persistent state, rather than running a separate database per NF.",
  policy_specific: "The PCF is the 5G core's dynamic policy brain — it decides QoS treatment, charging behavior, and access control on a per-session basis, communicating with SMF over N7 (to push session/QoS rules) and with an Application Function over N5 (for AF-requested dynamic policy, e.g. an IMS/VoLTE call needing a dedicated QCI=1 bearer). If PCF is unreachable or misconfigured, SMF typically falls back to static/default policy rather than failing sessions outright — but any feature depending on dynamic policy (like VoLTE's dedicated bearer request) won't work correctly.",
};

// NSSF (Network Slice Selection Function) Tooltips
export const NSSF_TOOLTIPS = {
  ...COMMON_TOOLTIPS,
  nsi: "Network Slice Instance ID — maps a specific S-NSSAI (the SST+SD slice identifier a UE requests) to the actual set of AMF/SMF instances that serve that slice. In a deployment with only one instance of each core NF, this mapping is trivially one-to-one; it becomes meaningful once you're running genuinely separate NF instances per slice for isolation or scaling reasons.",
  nsi_sst: "Slice Service Type this slice instance serves (1-255, standard values: 1=eMBB, 2=URLLC, 3=MIoT). Must match the SST a subscriber's own slice subscription data (and their URSP/route-selection policy) actually requests, or NSSF has nothing to route their request to.",
  nsi_sd: "Slice Differentiator (optional, 24-bit hex) for this slice instance — only needed when running more than one slice instance that shares the same SST and needs to be told apart (e.g. per-tenant isolation within one eMBB category).",
  nsi_nrf: "NRF Group ID or full URI that NSSF directs a UE toward for this specific slice — in deployments where different slices are served by entirely separate NRF instances (rather than one shared NRF for the whole core), this is how NSSF tells the UE/AMF which NRF's registered NFs actually belong to the requested slice.",
};

// BSF (Binding Support Function) Tooltips
export const BSF_TOOLTIPS = {
  ...COMMON_TOOLTIPS,
  mongodb_uri: "MongoDB connection storing PCF binding records — which PCF instance is currently handling policy for which UE/session. Only becomes operationally significant once more than one PCF instance is running; with a single PCF, BSF's bindings are trivial (everything maps to that one instance).",
  bsf_specific: "BSF exists to solve session continuity in multi-PCF deployments: when SMF or another NF needs to find 'the PCF already handling this UE's session' (rather than any arbitrary PCF), it queries BSF for the binding rather than guessing. With a single PCF instance in this deployment, BSF adds a lookup step but no real ambiguity to resolve — it becomes essential once PCF is horizontally scaled.",
};

// SCP (Service Communication Proxy) Tooltips
export const SCP_TOOLTIPS = {
  ...COMMON_TOOLTIPS,
  scp_port: "Port the SCP's HTTP/2 proxy listens on. When any NF is configured to use this SCP (via its own scp_uri field) instead of direct NRF discovery, all of that NF's outbound SBI traffic to other NFs routes through this port on the SCP rather than connecting to peers directly — centralizing NF-to-NF routing, which is useful for load-balancing and consistent mTLS termination in larger deployments but adds a hop (and a single point of failure) that a direct-discovery setup doesn't have.",
  info_port_http: "HTTP port for the SCP's own configuration/status API, used to inspect and manage the SCP itself (distinct from the proxy port above, which carries actual NF-to-NF traffic). Only relevant if you're actively operating/monitoring the SCP process directly.",
  info_port_https: "HTTPS variant of the SCP's management/status API, for deployments that require TLS on the management interface itself. Use this instead of info_port_http when the SCP's admin API needs to be reachable over an untrusted network segment.",
  domain_name: "Fully qualified domain name identifying this SCP instance, used in service-routing decisions and, in multi-SCP deployments, for load-balancing between SCP instances. In a single-SCP deployment this is mostly informational/logging value.",
  domain_fqdn: "The FQDN form of this SCP's identity in full — must actually resolve to this SCP's real address wherever it's used for routing, or NFs relying on it for indirect discovery will fail to reach it despite the SCP itself running fine.",
};
