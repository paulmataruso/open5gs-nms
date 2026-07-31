import { Router, Request, Response } from 'express';
import { exec, execFile, spawn } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as crypto from 'crypto';
import pino from 'pino';
import { IAuditLogger } from '../../domain/interfaces/audit-logger';
import { ISubscriberRepository } from '../../domain/interfaces/subscriber-repository';
import { requireAdmin } from './middleware/auth-middleware';
import { getAppVersion } from '../../infrastructure/system/app-version';
import { readCurrentSmsConfig, upsertSmppEsme, isSmppEsmeActive, removeSmppEsme } from './sms-controller';

// ── MMS (VectorCore MMSC) ───────────────────────────────────────────────────
//
// Multimedia Messaging (MMS) via VectorCore MMSC (github.com/vectorcore-mobile/
// vectorcore-mmsc), a Go-based MMSC built from source and run as a host
// systemd service — same nsenter pattern as every other add-on module.
//
// Delivery path: real MMS delivery notification (M-Notification.ind) is a
// binary/UDH WAP Push SMS. VectorCore builds that PDU itself (WSP-wrapped,
// port 2948/9200, segmented) and submits it over SMPP to an upstream SMSC —
// it never talks to the radio/SGs/IMS layer directly. This module wires that
// SMPP link to osmo-msc's own SMPP ESME interface (see sms-controller.ts's
// upsertSmppEsme/isSmppEsmeActive/removeSmppEsme) — the "SGs delivery path".
// A `deliveryPath` field is kept in the saved state (currently always 'sgs')
// so a future IMS-based delivery path can be added later without a rewrite,
// per explicit user request — not implemented, just left open.
//
// IMPORTANT, confirmed live the hard way this session: osmo-msc's SMPP ESME
// password can ONLY ever be set interactively via VTY — it does not persist
// across an osmo-msc restart (osmo-msc FATAL-errors if a `password` line is
// written into its static config file). That means the ESME can silently go
// stale any time osmo-msc restarts for any reason (a plain SMS/PLMN
// reconfigure, a host reboot, a manual restart) — /status below self-heals
// this on every poll rather than assuming a one-time Configure-time apply is
// enough forever.

const execFileAsync = promisify(execFile);

const nsenter = async (cmd: string, args: string[] = [], timeoutMs = 20000): Promise<{ stdout: string; stderr: string }> =>
  execFileAsync('nsenter', ['-t', '1', '-m', '-u', '-i', '-p', cmd, ...args], {
    timeout: timeoutMs,
    encoding: 'utf-8',
    env: { ...process.env, DBUS_SYSTEM_BUS_ADDRESS: 'unix:path=/var/run/dbus/system_bus_socket' },
  });

const HOST_ROOT       = '/proc/1/root';
const HOST_MMS_STATE  = `${HOST_ROOT}/etc/open5gs/.mms-config.json`;
// Same file ims-controller.ts itself writes/reads (HOST_IMS_STATE there) —
// read directly here rather than importing from ims-controller.ts, matching
// pstn-controller.ts's existing convention (its own HOST_IMS_STATE const +
// readImsState()) for the same cross-module dependency check.
const HOST_IMS_STATE  = `${HOST_ROOT}/etc/open5gs/.ims-config.json`;

// IMS gating: MMS's WAP Push delivery notification rides on osmo-msc's SMPP
// interface (the existing readCurrentSmsConfig() check below already covers
// that hard technical dependency) — MMS itself never touches Kamailio/IMS.
// But "SMS over IMS" is this project's default/primary delivery path for
// *regular* texting (see CLAUDE.md's SMS feature row) — a deployment with
// MMS working but IMS never installed would have working MMS and silently
// broken regular SMS (the SMS Delivery Mode toggle defaults to 'ims' on
// fresh deployments). To keep a fresh install matching this dev host's
// actual working baseline (both IMS and Osmocom/SMS installed+configured),
// gate Install on IMS being installed (cheap to check, avoids a wasted
// multi-minute VectorCore build for a deployment that isn't going to work
// end-to-end anyway) and gate Configure on IMS being configured, same
// two-tier pattern as pstn-controller.ts.
async function isImsInstalled(): Promise<boolean> {
  try {
    const { stdout } = await nsenter('which', ['kamailio']);
    return stdout.trim().length > 0;
  } catch { return false; }
}
function isImsConfigured(): boolean {
  return fs.existsSync(HOST_IMS_STATE);
}

// Host-real paths (as used by nsenter'd commands, not /proc/1/root-prefixed).
const VC_DIR    = '/opt/vectorcore';
const VC_BIN    = `${VC_DIR}/bin/mmsc`;
const VC_ETC    = `${VC_DIR}/etc`;
const VC_CFG    = `${VC_ETC}/mmsc.yaml`;
const VC_DATA   = `${VC_DIR}/data`;
const VC_DB     = `${VC_DATA}/vectorcore-mmsc.db`;
const VC_LOG      = `${VC_DIR}/log`;
const VC_LOG_FILE = `${VC_LOG}/mmsc.log`;
const SYSTEMD_UNIT      = 'vectorcore-smsc'; // real unit name shipped by the repo — installed as-is, not renamed
const SYSTEMD_UNIT_PATH = `/etc/systemd/system/${SYSTEMD_UNIT}.service`;

const MM1_PORT  = 8002;
// VectorCore itself binds MM1 to loopback only on this internal port — the
// real public :8002 is owned by mm1-msisdn-proxy.go (see below), which is
// the only thing that ever needs to see the UE's real source IP.
const MM1_INTERNAL_PORT = 18002;
const MM3_PORT  = 2026;
const MM4_PORT  = 2025;
const MM7_PORT  = 8007;
// 8080 (VectorCore's own documented default) is already bound by PyHSS's own
// HSS API on this project's hosts (confirmed live: a real port collision —
// curl to :8080/healthz returned a 404 from PyHSS's Werkzeug/Flask app, not
// VectorCore, even though systemd reported vectorcore-smsc as running —
// VectorCore's own admin listener had silently failed to bind, logged only
// to its own log file, not journal). 8090 is confirmed free on this host.
const API_PORT  = 8090;
const SMPP_PORT = 2775; // osmo-msc's SMPP listener (confirmed live default)

const ESME_NAME = 'vectorcore-mmsc';
const GO_VERSION = '1.24.5'; // matches vectorcore-mmsc's go.mod `toolchain` directive exactly — avoids Go's automatic-toolchain-download reaching out to proxy.golang.org mid-build on a host with restricted egress

// ─── MM1 MSISDN header-injection proxy ─────────────────────────────────────
//
// Real bug found live 2026-07-30: a real iPhone's M-Send.req PDU has no
// usable From field (either absent, or the WAP "insert-address-token" that
// means "network, please fill this in"). VectorCore's own fallback for that
// case is to check for an X-WAP-Network-Client-MSISDN / X-MSISDN /
// X-Nokia-MSISDN HTTP header — the standard mechanism a real GGSN/PGW uses
// (HTTP header enrichment) to tell the MMSC who's sending. Open5GS's UPF
// doesn't do header enrichment, and nothing did this — every real MO MMS
// silently 400'd ("missing from: header missing"), which is invisible at the
// zap Debug log level VectorCore ships at by default and looked exactly like
// nothing was reaching the server at all.
//
// Fixed with a tiny dependency-free reverse proxy that owns the real public
// :8002 the phone connects to, looks up the sender's MSISDN from the UE's
// source IP (Framed Routing gives every subscriber here a stable static IP,
// same assumption subscriber-ip-accounting.ts already relies on), and
// forwards to VectorCore itself rebound to loopback-only :18002. Strips any
// client-supplied MSISDN headers first — don't let a UE spoof its own X-MSISDN.
//
// Written in Go, not Node: a Go toolchain is already a hard, verified
// prerequisite of this exact install flow (see the Go version check further
// down), whereas Node.js is NOT a documented prerequisite anywhere in this
// project — VectorCore's own web-UI build step only needs Node transiently
// at *build* time (falls back to apt's own nodejs/npm if genuinely absent),
// never at runtime, since the shipped binary is compiled Go. A Node-based
// proxy would have quietly made Node.js a new permanent *runtime*
// dependency of this module on a fresh host that might not have it at all —
// confirmed live this dev host's Node only exists from an undocumented,
// out-of-band manual install, not from anything this project's install flow
// actually guarantees. Compiled the same way as VectorCore itself: no
// go.mod needed (stdlib-only, confirmed live), so no module/network
// resolution at build time either.
const MM1_PROXY_SRC        = `${VC_DIR}/mm1-msisdn-proxy.go`;
const MM1_PROXY_BIN        = `${VC_DIR}/mm1-msisdn-proxy`;
const MM1_PROXY_UNIT       = 'vectorcore-mm1-proxy';
const MM1_PROXY_UNIT_PATH  = `/etc/systemd/system/${MM1_PROXY_UNIT}.service`;
const IP_MSISDN_MAP_FILE   = `${VC_ETC}/ip-msisdn-map.json`;

function mm1MsisdnProxyGo(): string {
  return `// Generated by open5gs-nms — do not edit by hand, regenerated on every MMS Configure.
package main

import (
	"encoding/json"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"sync"
	"time"
)

const (
	listenAddr   = "0.0.0.0:${MM1_PORT}"
	upstreamAddr = "127.0.0.1:${MM1_INTERNAL_PORT}"
	mapFile      = "${IP_MSISDN_MAP_FILE}"
)

var spoofableHeaders = []string{"X-Wap-Network-Client-Msisdn", "X-Msisdn", "X-Nokia-Msisdn"}

type mapCache struct {
	mu    sync.RWMutex
	data  map[string]string
	mtime time.Time
}

func (c *mapCache) load() map[string]string {
	st, err := os.Stat(mapFile)
	if err != nil {
		c.mu.RLock()
		defer c.mu.RUnlock()
		return c.data
	}
	c.mu.RLock()
	stale := !st.ModTime().Equal(c.mtime)
	c.mu.RUnlock()
	if stale {
		if raw, err := os.ReadFile(mapFile); err == nil {
			var m map[string]string
			if json.Unmarshal(raw, &m) == nil {
				c.mu.Lock()
				c.data = m
				c.mtime = st.ModTime()
				c.mu.Unlock()
			}
		}
	}
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.data
}

func main() {
	cache := &mapCache{data: map[string]string{}}

	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		remoteIP := r.RemoteAddr
		if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
			remoteIP = host
		}
		msisdn := cache.load()[remoteIP]

		for _, h := range spoofableHeaders {
			r.Header.Del(h)
		}
		if msisdn != "" {
			r.Header.Set("X-MSISDN", msisdn)
		}

		upstreamReq, err := http.NewRequest(r.Method, "http://"+upstreamAddr+r.URL.RequestURI(), r.Body)
		if err != nil {
			http.Error(w, "bad gateway", http.StatusBadGateway)
			return
		}
		upstreamReq.Header = r.Header
		upstreamReq.ContentLength = r.ContentLength

		resp, err := http.DefaultClient.Do(upstreamReq)
		if err != nil {
			http.Error(w, "bad gateway", http.StatusBadGateway)
			return
		}
		defer resp.Body.Close()

		for k, vals := range resp.Header {
			for _, v := range vals {
				w.Header().Add(k, v)
			}
		}
		w.WriteHeader(resp.StatusCode)
		io.Copy(w, resp.Body)
	})

	log.Printf("mm1-msisdn-proxy listening on %s -> %s", listenAddr, upstreamAddr)
	log.Fatal(http.ListenAndServe(listenAddr, nil))
}
`;
}

function mm1ProxySystemdUnit(): string {
  return `[Unit]
Description=VectorCore MM1 MSISDN Header Injection Proxy
After=network.target ${SYSTEMD_UNIT}.service
Requires=${SYSTEMD_UNIT}.service
PartOf=${SYSTEMD_UNIT}.service

[Service]
Type=simple
ExecStart=${MM1_PROXY_BIN}
Restart=always
RestartSec=2
User=root

[Install]
WantedBy=multi-user.target
`;
}

// Rebuilds the UE-IP -> MSISDN map the proxy reads. Only meaningful once MMS
// is installed+configured; cheap no-op otherwise. Uses the same "static
// per-subscriber IP via Framed Routing" field subscriber-ip-accounting.ts
// already relies on (session.ue.ipv4) — not a live SMF session query.
export async function writeMmsIpMsisdnMap(subscriberRepo: ISubscriberRepository): Promise<void> {
  if (!fs.existsSync(`${HOST_ROOT}${VC_ETC}`)) return;
  const allSubs = await subscriberRepo.findAllFull();
  const map: Record<string, string> = {};
  for (const sub of allSubs) {
    const msisdn = sub.msisdn?.[0];
    if (!msisdn || !/^\d+$/.test(msisdn)) continue;
    for (const slice of sub.slice ?? []) {
      for (const session of slice.session ?? []) {
        const ip = session.ue?.ipv4;
        if (ip) map[ip] = msisdn;
      }
    }
  }
  fs.writeFileSync(`${HOST_ROOT}${IP_MSISDN_MAP_FILE}`, JSON.stringify(map, null, 2), 'utf-8');
}

// Periodic refresher — mirrors SubscriberIpAccounting's start()/stop() shape.
// A new subscriber or a reassigned Framed Route IP shouldn't require a manual
// MMS Configure re-run to start working.
export class MmsMsisdnMapRefresher {
  private timer: NodeJS.Timeout | null = null;
  constructor(private readonly subscriberRepo: ISubscriberRepository, private readonly logger: pino.Logger) {}

  start(intervalMs: number = 30_000): void {
    if (this.timer) return;
    writeMmsIpMsisdnMap(this.subscriberRepo).catch(err => this.logger.warn({ err: String(err) }, 'mms: initial ip-msisdn map write failed'));
    this.timer = setInterval(() => {
      writeMmsIpMsisdnMap(this.subscriberRepo).catch(err => this.logger.warn({ err: String(err) }, 'mms: ip-msisdn map refresh failed'));
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
}

interface MmsState {
  deliveryPath: 'sgs'; // 'ims' reserved for a future delivery path — not implemented yet
  mm1PublicIp: string; // IP real UEs can reach this host on, for the MM1 retrieve URL and MM4 hostname
  esmeName: string;
  esmePassword: string;
  configuredWithVersion?: string;
}

function readMmsState(): MmsState | null {
  if (!fs.existsSync(HOST_MMS_STATE)) return null;
  try { return JSON.parse(fs.readFileSync(HOST_MMS_STATE, 'utf-8')); } catch { return null; }
}

function writeMmsState(state: MmsState): void {
  fs.mkdirSync(`${HOST_ROOT}/etc/open5gs`, { recursive: true });
  fs.writeFileSync(HOST_MMS_STATE, JSON.stringify(state, null, 2), 'utf-8');
}

// ─── Apple .mobileconfig (APN/MMS cellular settings profile) ───────────────
//
// iOS hides the manual APN/MMSC settings UI behind carrier-bundle gating on
// most real SIMs — a Configuration Profile is the only reliable way to set
// MMSCURL/MMSProxy/etc. on a real iPhone for this private test network.
// Same structure/settings confirmed working live on a real iPhone
// (2026-07-30, see memory: mms-mm1-msisdn-header-injection-fix) — this just
// parameterizes the APN name and MMSC URL that were hardcoded that first
// time, defaulting to the same values, so a real user isn't left generating
// one by hand.
function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function mmsMobileConfigPlist(apn: string, mmscUrl: string): string {
  const apnX = escapeXml(apn);
  const mmscUrlX = escapeXml(mmscUrl);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>PayloadContent</key>
	<array>
		<dict>
			<key>PayloadType</key>
			<string>com.apple.cellular</string>
			<key>PayloadVersion</key>
			<integer>1</integer>
			<key>PayloadIdentifier</key>
			<string>com.open5gs-nms.cellular.apn-mms</string>
			<key>PayloadUUID</key>
			<string>AD07E27A-5EC9-45F8-9ADB-E4D2E7DAB11A</string>
			<key>PayloadDisplayName</key>
			<string>Open5GS NMS APN + MMS Settings</string>
			<key>AttachAPN</key>
			<dict>
				<key>Name</key>
				<string>${apnX}</string>
			</dict>
			<key>APNs</key>
			<array>
				<dict>
					<key>Name</key>
					<string>${apnX}</string>
					<key>MMSCURL</key>
					<string>${mmscUrlX}</string>
					<key>MMSProxy</key>
					<string></string>
					<key>MMSProxyPort</key>
					<string>80</string>
					<key>MMSMaxMessageSize</key>
					<string>5242880</string>
					<key>MMSUAgent</key>
					<string>Apple-iPhone/iOS</string>
					<key>MMSUAProfURL</key>
					<string></string>
				</dict>
			</array>
		</dict>
	</array>
	<key>PayloadDisplayName</key>
	<string>Open5GS NMS Cellular/MMS Profile</string>
	<key>PayloadIdentifier</key>
	<string>com.open5gs-nms.cellular.profile</string>
	<key>PayloadOrganization</key>
	<string>open5gs-nms lab</string>
	<key>PayloadDescription</key>
	<string>Sets the APN's MMSC/proxy settings for MMS over the private open5gs-nms test network. Safe to remove at any time (Settings &gt; General &gt; VPN &amp; Device Management).</string>
	<key>PayloadRemovalDisallowed</key>
	<false/>
	<key>PayloadType</key>
	<string>Configuration</string>
	<key>PayloadUUID</key>
	<string>35735C0D-6A8D-4883-B7AB-962D28F602FF</string>
	<key>PayloadVersion</key>
	<integer>1</integer>
</dict>
</plist>
`;
}

// ─── Config template ────────────────────────────────────────────────────────
// Deliberately ABSOLUTE paths throughout (dsn/store root/log file) — the
// shipped systemd/vectorcore-smsc.service has no WorkingDirectory= set (we
// install it as-is, per plan, rather than editing it), so relative paths in
// the upstream example config.yaml would resolve against systemd's default
// cwd ("/") and scatter files across the filesystem. Absolute paths sidestep
// that entirely regardless of cwd.
function mmscYamlCfg(mm1PublicIp: string, mm4Hostname: string): string {
  return `database:
  driver: sqlite
  dsn: "${VC_DATA}/vectorcore-mmsc.db"
  max_open_conns: 10
  max_idle_conns: 5
  runtime_reload_interval: 5s

mm1:
  listen: "127.0.0.1:${MM1_INTERNAL_PORT}"
  retrieve_base_url: "http://${mm1PublicIp}:${MM1_PORT}/mms/retrieve"
  max_body_size_bytes: 10485760

mm3:
  inbound_listen: ":${MM3_PORT}"
  max_message_size_bytes: 10485760

mm4:
  inbound_listen: ":${MM4_PORT}"
  hostname: "${mm4Hostname}"
  max_message_size_bytes: 10485760

mm7:
  listen: ":${MM7_PORT}"
  path: "/mm7"
  eaif_path: "/eaif"
  version: "5.3.0"
  eaif_version: "3.0"
  namespace: "http://www.3gpp.org/ftp/Specs/archive/23_series/23.140/schema/REL-5-MM7-1-0"

api:
  listen: ":${API_PORT}"

store:
  backend: filesystem
  filesystem:
    root: "${VC_DATA}/store"

adapt:
  enabled: false

limits:
  max_message_size_bytes: 5242880
  default_message_expiry: 168h
  max_message_retention: 720h

billing:
  enabled: false

log:
  # 'info' is VectorCore's own shipped default, but every line on its MM1
  # request path (including the ones that would explain a rejected message)
  # is logged at Debug — 'info' makes a fully-processed, actively-rejected
  # request leave zero trace in this log file. Confirmed live 2026-07-30:
  # looked exactly like requests weren't reaching the app at all. See
  # memory: mms-mm1-msisdn-header-injection-fix.
  level: debug
  format: json
  file: "${VC_LOG}/mmsc.log"
`;
}

// Polls VectorCore's own /healthz until it responds or the timeout elapses —
// its admin API (and hence /api/v1/smpp/upstreams) isn't up the instant
// systemctl returns, since the Go process still has to open its sqlite DB
// and bind its listeners.
async function waitForVectorCoreApi(timeoutMs = 15000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await nsenter('curl', ['-fsS', '-o', '/dev/null', `http://127.0.0.1:${API_PORT}/healthz`], 3000);
      return true;
    } catch {
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  return false;
}

// Registers (or updates — the repo's own POST handler calls the same upsert
// as PUT, confirmed by reading api/rest/router.go, so this is safe to call
// on every Configure re-run) the osmo-msc SMPP link as a VectorCore SMPP
// upstream. Field names are the db.SMPPUpstream Go struct's own field names
// verbatim (no json tags in that struct, confirmed by reading
// internal/db/repository.go — Go's default encoding/json uses them as-is).
async function registerSmppUpstream(esmeName: string, esmePassword: string): Promise<void> {
  const payload = JSON.stringify({
    Name: esmeName,
    Host: '127.0.0.1',
    Port: SMPP_PORT,
    SystemID: esmeName,
    Password: esmePassword,
    SystemType: '',
    BindMode: 'transceiver',
    EnquireLink: 30,
    ReconnectWait: 5,
    RegisteredDelivery: 0,
    // huma's generated schema marks these *int fields required even though
    // they're nullable at the DB layer (no huma/json tags in the Go struct
    // to say otherwise) — confirmed live via a real 422 ("expected required
    // property DestAddrNPI to be present") until they're sent explicitly as
    // null rather than omitted.
    SourceAddrTON: null,
    SourceAddrNPI: null,
    DestAddrTON: null,
    DestAddrNPI: null,
    Active: true,
  });
  const tmpPath = `/tmp/vectorcore-smpp-upstream-${Date.now()}.json`;
  fs.writeFileSync(`${HOST_ROOT}${tmpPath}`, payload, 'utf-8');
  try {
    await nsenter('curl', [
      '-fsS', '-X', 'POST',
      `http://127.0.0.1:${API_PORT}/api/v1/smpp/upstreams`,
      '-H', 'Content-Type: application/json',
      '--data', `@${tmpPath}`,
    ]);
  } finally {
    await nsenter('rm', ['-f', tmpPath]).catch(() => {});
  }
}

export function createMmsRouter(subscriberRepo: ISubscriberRepository, logger: pino.Logger, auditLogger: IAuditLogger): Router {
  const router = Router();

  // GET /api/mms/status
  router.get('/status', async (_req: Request, res: Response) => {
    try {
      const installed = fs.existsSync(`${HOST_ROOT}${VC_BIN}`);
      const [svcRes, proxyRes] = await Promise.allSettled([
        nsenter('systemctl', ['is-active', SYSTEMD_UNIT]),
        nsenter('systemctl', ['is-active', MM1_PROXY_UNIT]),
      ]);
      const serviceActive = svcRes.status === 'fulfilled' && svcRes.value.stdout.trim() === 'active';
      const proxyActive = proxyRes.status === 'fulfilled' && proxyRes.value.stdout.trim() === 'active';

      let healthy = false;
      if (serviceActive) {
        try {
          await nsenter('curl', ['-fsS', '-o', '/dev/null', `http://127.0.0.1:${API_PORT}/healthz`], 3000);
          healthy = true;
        } catch { /* not up yet or crashed — reported via serviceActive/healthy separately */ }
      }

      const state = readMmsState();
      let esmeActive = false;
      if (state && serviceActive) {
        esmeActive = await isSmppEsmeActive(state.esmeName);
        if (!esmeActive) {
          // Self-heal: the password never survives an osmo-msc restart (see
          // module header comment) — silently re-apply rather than surfacing
          // a permanently-broken state that only a manual Configure would fix.
          try {
            const r = await upsertSmppEsme(state.esmeName, state.esmePassword);
            esmeActive = r.success;
            if (r.success) logger.info({ esmeName: state.esmeName }, 'mms: re-applied SMPP ESME after detecting it was missing from osmo-msc');
          } catch (err) {
            logger.warn({ err: String(err) }, 'mms: failed to re-apply SMPP ESME');
          }
        }
      }

      const appVersion = getAppVersion();
      const configStale = !!state && state.configuredWithVersion !== appVersion;

      res.json({
        success: true,
        installed,
        serviceActive,
        healthy,
        proxyActive,
        hasSavedConfig: !!state,
        esmeActive,
        smsConfigured: !!readCurrentSmsConfig(),
        imsInstalled: await isImsInstalled(),
        imsConfigured: isImsConfigured(),
        currentConfig: state ? { deliveryPath: state.deliveryPath, mm1PublicIp: state.mm1PublicIp } : undefined,
        appVersion,
        configuredWithVersion: state?.configuredWithVersion,
        configStale,
      });
    } catch (err) {
      logger.error({ err: String(err) }, 'mms status error');
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // POST /api/mms/install — streaming: Go toolchain + build deps, clone,
  // build (embeds the web UI first), deploy the systemd unit as-is.
  router.post('/install', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    if (!(await isImsInstalled())) {
      return res.status(400).json({ success: false, error: 'IMS is not installed yet — install IMS on the IMS page first. MMS relies on IMS being the default SMS delivery path for a working deployment (see CLAUDE.md).' });
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();
    const write = (s: string) => { res.write(s.endsWith('\n') ? s : s + '\n'); };

    const spawnStream = (bashScript: string): Promise<number> =>
      new Promise(resolve => {
        const child = spawn('nsenter', ['-t', '1', '-m', '-u', '-i', '-p', '--', 'bash', '-c', bashScript], { stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.on('data', (d: Buffer) => write(d.toString()));
        child.stderr.on('data', (d: Buffer) => write(d.toString()));
        child.on('close', (code) => resolve(code ?? 1));
      });

    try {
      write('=== Installing build dependencies (build-essential, make, git, sqlite3) ===');
      // Deliberately does NOT apt-get install npm: this host's Node.js comes
      // from NodeSource (deb.nodesource.com), which bundles its own npm —
      // confirmed live that Ubuntu's distro `npm` package then conflicts
      // (wants a completely separate `node-*` transitive dependency tree
      // that was never installed alongside a NodeSource Node.js, apt refuses
      // the whole install with "unmet dependencies"/"held broken packages").
      // Only install npm via apt if this host genuinely has neither.
      const depsExit = await spawnStream(
        `set -e\n` +
        `DEBIAN_FRONTEND=noninteractive apt-get update -q\n` +
        `DEBIAN_FRONTEND=noninteractive apt-get install -y build-essential make git sqlite3\n` +
        `if command -v npm >/dev/null 2>&1; then\n` +
        `  echo "npm already present ($(npm --version)) — skipping apt npm package."\n` +
        `else\n` +
        `  DEBIAN_FRONTEND=noninteractive apt-get install -y npm\n` +
        `fi`
      );
      if (depsExit !== 0) {
        write(`\n❌ apt-get install failed (exit ${depsExit}).`);
        await auditLogger.log({ action: 'mms_install', user, details: `apt exit ${depsExit}`, success: false });
        return res.end();
      }

      write(`\n=== Ensuring Go ${GO_VERSION}+ toolchain ===`);
      const goExit = await spawnStream(
        `set -e\n` +
        `NEED_GO=1\n` +
        `if [ -x /usr/local/go/bin/go ]; then\n` +
        `  CURVER=$(/usr/local/go/bin/go version | grep -oE 'go[0-9]+\\.[0-9]+(\\.[0-9]+)?' | sed 's/^go//')\n` +
        `  TOPVER=$(printf '%s\\n%s\\n' "${GO_VERSION}" "$CURVER" | sort -V | tail -1)\n` +
        `  if [ "$TOPVER" = "$CURVER" ]; then NEED_GO=0; fi\n` +
        `fi\n` +
        `if [ "$NEED_GO" = "1" ]; then\n` +
        `  ARCH=$(uname -m)\n` +
        `  case $ARCH in x86_64) GOARCH=amd64 ;; aarch64) GOARCH=arm64 ;; *) GOARCH=amd64 ;; esac\n` +
        `  echo "Downloading go${GO_VERSION}.linux-$GOARCH.tar.gz..."\n` +
        `  curl -fsSL -o /tmp/go.tar.gz "https://go.dev/dl/go${GO_VERSION}.linux-$GOARCH.tar.gz"\n` +
        `  rm -rf /usr/local/go\n` +
        `  tar -C /usr/local -xzf /tmp/go.tar.gz\n` +
        `  rm -f /tmp/go.tar.gz\n` +
        `  echo "Installed: $(/usr/local/go/bin/go version)"\n` +
        `else\n` +
        `  echo "Already have: $(/usr/local/go/bin/go version)"\n` +
        `fi`
      );
      if (goExit !== 0) {
        write(`\n❌ Go toolchain setup failed (exit ${goExit}).`);
        await auditLogger.log({ action: 'mms_install', user, details: `go setup exit ${goExit}`, success: false });
        return res.end();
      }

      write('\n=== Cloning VectorCore MMSC ===');
      await spawnStream(`[ -d ${VC_DIR}/.git ] && echo "Already cloned — skipping." || git clone https://github.com/vectorcore-mobile/vectorcore-mmsc.git ${VC_DIR}`);

      write('\n=== Building (web UI + Go binary) ===');
      const buildExit = await spawnStream(
        `set -e\n` +
        `export PATH=/usr/local/go/bin:$PATH\n` +
        `export GOCACHE=${VC_DIR}/.gocache\n` +
        `export GOMODCACHE=${VC_DIR}/.gomodcache\n` +
        `cd ${VC_DIR}\n` +
        // --include=dev: this host runs with NODE_ENV=production set globally
        // (for the NMS's own Node processes) — confirmed live that a plain
        // `npm install` then silently skips devDependencies, which is where
        // vite (the actual build tool) lives, failing "vite: not found" at
        // build time with no earlier warning. --include=dev forces them in
        // regardless of NODE_ENV.
        `npm install --include=dev --prefix web\n` +
        `make build`
      );
      if (buildExit !== 0) {
        write(`\n❌ Build failed (exit ${buildExit}).`);
        await auditLogger.log({ action: 'mms_install', user, details: `build exit ${buildExit}`, success: false });
        return res.end();
      }

      write('\n=== Installing systemd unit (as shipped) ===');
      await spawnStream(`cp ${VC_DIR}/systemd/${SYSTEMD_UNIT}.service ${SYSTEMD_UNIT_PATH} && systemctl daemon-reload`);

      await auditLogger.log({ action: 'mms_install', user, details: 'success', success: true });
      write('\n✅ VectorCore MMSC installed. Run Configure next.');
      res.end();
    } catch (err) {
      write(`\n❌ Install error: ${String(err)}`);
      await auditLogger.log({ action: 'mms_install', user, details: String(err), success: false });
      res.end();
    }
  });

  // POST /api/mms/configure — body: { mm1PublicIp }
  router.post('/configure', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      const { mm1PublicIp } = req.body as { mm1PublicIp?: string };
      if (!mm1PublicIp || !/^\d{1,3}(\.\d{1,3}){3}$/.test(mm1PublicIp)) {
        return res.status(400).json({ success: false, error: 'mm1PublicIp is required and must be an IPv4 address reachable from real UEs' });
      }

      if (!isImsConfigured()) {
        return res.status(400).json({ success: false, error: 'IMS is not configured yet — configure IMS on the IMS page first.' });
      }
      const smsConfig = readCurrentSmsConfig();
      if (!smsConfig) {
        return res.status(400).json({ success: false, error: 'SMS (SGs) is not configured yet — configure SMS on the SMS/MMS page first (MMS delivery notifications ride on its SMPP interface).' });
      }
      if (!fs.existsSync(`${HOST_ROOT}${VC_BIN}`)) {
        return res.status(400).json({ success: false, error: 'VectorCore MMSC is not installed yet — run Install first.' });
      }

      // Reuse a previously-generated ESME password across re-Configure calls
      // rather than rotating it every time — avoids a spurious mismatch
      // between what's registered on osmo-msc and what's in VectorCore's own
      // smpp_upstream row if one half of this sequence fails partway.
      //
      // 4 bytes -> 8 hex chars: SMPP 3.4's bind PDU password field is capped
      // at 8 characters by the protocol spec itself (confirmed live: osmo-msc
      // rejected a longer one at the wire level — "smpp34_unpack(): password:
      // Data length is invalid" — even though its own VTY happily accepted
      // setting a longer password with no complaint, since VTY parsing
      // doesn't enforce SMPP PDU limits, only the real bind path does).
      const existing = readMmsState();
      const esmePassword = existing?.esmePassword ?? crypto.randomBytes(4).toString('hex');

      await nsenter('mkdir', ['-p', VC_ETC, VC_DATA, `${VC_DATA}/store`, VC_LOG]);
      const mm4Hostname = `mmsc.${mm1PublicIp}`;
      fs.writeFileSync(`${HOST_ROOT}${VC_CFG}`, mmscYamlCfg(mm1PublicIp, mm4Hostname), 'utf-8');

      const wasActive = (await nsenter('systemctl', ['is-active', SYSTEMD_UNIT]).catch(() => ({ stdout: '', stderr: '' }))).stdout.trim() === 'active';
      if (wasActive) {
        await nsenter('systemctl', ['restart', SYSTEMD_UNIT]);
      } else {
        await nsenter('systemctl', ['enable', '--now', SYSTEMD_UNIT]);
      }

      // Deploy/refresh the MM1 MSISDN header-injection proxy (see block
      // comment near MM1_PROXY_SRC above) — source + binary regenerated on
      // every Configure so a change to the generated source always takes
      // effect, same as VectorCore's own config file above.
      fs.writeFileSync(`${HOST_ROOT}${MM1_PROXY_SRC}`, mm1MsisdnProxyGo(), 'utf-8');
      const proxyBuild = await nsenter('bash', ['-c',
        `export PATH=/usr/local/go/bin:$PATH && export GOCACHE=${VC_DIR}/.gocache && ` +
        `cd ${VC_DIR} && go build -o ${MM1_PROXY_BIN} ${MM1_PROXY_SRC}`,
      ]).catch(err => ({ stdout: '', stderr: String(err) }));
      if (!fs.existsSync(`${HOST_ROOT}${MM1_PROXY_BIN}`)) {
        return res.status(500).json({ success: false, error: `Failed to compile MM1 MSISDN proxy: ${proxyBuild.stderr}` });
      }
      fs.writeFileSync(`${HOST_ROOT}${MM1_PROXY_UNIT_PATH}`, mm1ProxySystemdUnit(), 'utf-8');
      await writeMmsIpMsisdnMap(subscriberRepo);
      await nsenter('systemctl', ['daemon-reload']);
      const proxyWasActive = (await nsenter('systemctl', ['is-active', MM1_PROXY_UNIT]).catch(() => ({ stdout: '', stderr: '' }))).stdout.trim() === 'active';
      if (proxyWasActive) {
        await nsenter('systemctl', ['restart', MM1_PROXY_UNIT]);
      } else {
        await nsenter('systemctl', ['enable', '--now', MM1_PROXY_UNIT]);
      }

      const apiUp = await waitForVectorCoreApi();
      if (!apiUp) {
        // VectorCore logs to its own file (log.file in mmsc.yaml), NOT
        // journal — confirmed live: systemd reports the unit as running even
        // when its admin listener failed to bind (e.g. a port collision with
        // another already-running service), because only the *admin*
        // listener goroutine errors out, the process itself doesn't exit.
        // journalctl would show nothing useful here; surface the real log instead.
        let tail = '';
        try {
          const { stdout } = await nsenter('tail', ['-n', '15', VC_LOG_FILE]);
          tail = stdout;
        } catch { /* log file may not exist yet */ }
        return res.status(500).json({
          success: false,
          error: `VectorCore MMSC did not come up (healthz never responded on :${API_PORT}). Last lines of ${VC_LOG_FILE}:\n${tail}`,
        });
      }

      const esmeResult = await upsertSmppEsme(ESME_NAME, esmePassword);
      if (!esmeResult.success) {
        return res.status(500).json({ success: false, error: `Failed to register SMPP ESME on osmo-msc: ${esmeResult.output}` });
      }

      await registerSmppUpstream(ESME_NAME, esmePassword);

      writeMmsState({ deliveryPath: 'sgs', mm1PublicIp, esmeName: ESME_NAME, esmePassword, configuredWithVersion: getAppVersion() });

      await auditLogger.log({ action: 'mms_configure', user, details: `mm1PublicIp=${mm1PublicIp}`, success: true });
      res.json({ success: true, message: 'VectorCore MMSC configured and wired to osmo-msc via SMPP.' });
    } catch (err) {
      await auditLogger.log({ action: 'mms_configure', user, details: String(err), success: false });
      logger.error({ err: String(err) }, 'mms configure error');
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // POST /api/mms/sync-subscribers — VectorCore has no REST endpoint for
  // subscriber provisioning (confirmed by reading its api/rest/router.go: the
  // full route table is messages/peers/mm4-routes/mm3-relay/vasps/
  // smpp-upstreams/adaptation-classes/runtime/status, nothing subscriber-
  // shaped), so this writes directly into its `subscribers` sqlite table —
  // same direct-sqlite3-CLI approach as SMS's OsmoHLR sync. Unlike OsmoHLR's
  // table, VectorCore's has no IMSI concept at all (its `subscribers` table
  // is msisdn-only, unique) — MM1 identifies senders purely by MSISDN (the
  // X-MSISDN-family headers), so that's the only field that needs syncing.
  // Same insert/update + orphan-reconciliation pattern as sms-controller.ts's
  // /sync-subscribers (CLAUDE.md gotcha #10) — a subscriber deleted or
  // MSISDN-cleared in Open5GS must not orphan forever in VectorCore's table.
  router.post('/sync-subscribers', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      const allSubs = await subscriberRepo.findAllFull();
      const msisdns = [...new Set(
        allSubs.map(s => s.msisdn?.[0]).filter((m): m is string => !!m && /^\d+$/.test(m))
      )];

      if (msisdns.length === 0) {
        return res.json({ success: true, synced: 0, removed: 0, message: 'No subscribers with MSISDN found.' });
      }

      // VectorCore's sqlite driver isn't known to run in WAL mode (checked
      // its own source — no PRAGMA journal_mode anywhere), so a concurrent
      // external sqlite3 CLI write risks "database is locked" the same way
      // OsmoHLR's did — stop the service around the bulk write, same as SMS.
      const wasActive = (await nsenter('systemctl', ['is-active', SYSTEMD_UNIT]).catch(() => ({ stdout: '', stderr: '' }))).stdout.trim() === 'active';
      if (wasActive) await nsenter('systemctl', ['stop', SYSTEMD_UNIT]).catch(() => {});

      let synced = 0;
      let removed = 0;
      const failed: string[] = [];
      try {
        for (const msisdn of msisdns) {
          try {
            await nsenter('sqlite3', [VC_DB, `INSERT OR IGNORE INTO subscribers (msisdn) VALUES ('${msisdn}');`]);
            synced++;
          } catch (e) {
            failed.push(msisdn);
            logger.warn({ msisdn, err: String(e) }, 'MMS subscriber sync failed for one MSISDN');
          }
        }

        // Reconciliation: remove rows whose MSISDN is no longer eligible —
        // the loop above only ever inserts, so a subscriber later deleted or
        // MSISDN-cleared would otherwise orphan in VectorCore's table forever.
        try {
          const eligible = new Set(msisdns);
          const { stdout } = await nsenter('sqlite3', [VC_DB, 'SELECT msisdn FROM subscribers;']);
          const dbMsisdns = stdout.split('\n').map(l => l.trim()).filter(Boolean);
          const stale = dbMsisdns.filter(m => !eligible.has(m));
          for (const staleMsisdn of stale) {
            try {
              await nsenter('sqlite3', [VC_DB, `DELETE FROM subscribers WHERE msisdn='${staleMsisdn}';`]);
              removed++;
            } catch (e) {
              logger.warn({ msisdn: staleMsisdn, err: String(e) }, 'MMS stale subscriber cleanup failed');
            }
          }
        } catch (e) {
          logger.warn({ err: String(e) }, 'Could not query VectorCore subscriber list for cleanup — skipping');
        }

        await writeMmsIpMsisdnMap(subscriberRepo).catch(err => logger.warn({ err: String(err) }, 'mms: ip-msisdn map refresh after sync failed'));

        await auditLogger.log({ action: 'mms_sync_subscribers', user, details: `synced=${synced} failed=${failed.length} removed=${removed}`, success: true });
        res.json({ success: true, synced, failed, removed });
      } finally {
        if (wasActive) await nsenter('systemctl', ['start', SYSTEMD_UNIT]).catch(() => {});
      }
    } catch (err) {
      await auditLogger.log({ action: 'mms_sync_subscribers', user, details: String(err), success: false });
      logger.error({ err: String(err) }, 'mms sync-subscribers error');
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  router.post('/start', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      await nsenter('systemctl', ['start', SYSTEMD_UNIT]);
      await auditLogger.log({ action: 'mms_start', user, details: 'started', success: true });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  router.post('/stop', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      await nsenter('systemctl', ['stop', SYSTEMD_UNIT]);
      await auditLogger.log({ action: 'mms_stop', user, details: 'stopped', success: true });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  router.post('/restart', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      await nsenter('systemctl', ['restart', SYSTEMD_UNIT]);
      const state = readMmsState();
      if (state) {
        // osmo-msc itself wasn't restarted, but re-apply defensively anyway —
        // cheap, idempotent, and covers the case where this restart is
        // happening *because* something upstream (incl. osmo-msc) also bounced.
        await upsertSmppEsme(state.esmeName, state.esmePassword).catch(() => {});
      }
      await auditLogger.log({ action: 'mms_restart', user, details: 'restarted', success: true });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // POST /api/mms/uninstall — streaming: full teardown, incl. deleting
  // VectorCore's own database/media store (matches this project's existing
  // SMS/PSTN uninstall convention of a full clean removal — the frontend
  // gates this behind an explicit confirmation dialog, same as those).
  router.post('/uninstall', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();
    const write = (s: string) => { res.write(s.endsWith('\n') ? s : s + '\n'); };

    try {
      write('=== Stopping and disabling VectorCore MMSC ===');
      await nsenter('systemctl', ['disable', '--now', SYSTEMD_UNIT]).catch(() => {});

      write('\n=== Stopping and removing MM1 MSISDN header-injection proxy ===');
      await nsenter('systemctl', ['disable', '--now', MM1_PROXY_UNIT]).catch(() => {});
      if (fs.existsSync(`${HOST_ROOT}${MM1_PROXY_UNIT_PATH}`)) {
        await nsenter('rm', ['-f', MM1_PROXY_UNIT_PATH]);
        await nsenter('systemctl', ['daemon-reload']);
        write(`Removed: ${MM1_PROXY_UNIT_PATH}`);
      }

      const state = readMmsState();
      if (state) {
        write('\n=== Removing SMPP ESME from osmo-msc ===');
        await removeSmppEsme(state.esmeName).catch(err => write(`(non-fatal) ${String(err)}`));
      }

      write('\n=== Removing systemd unit ===');
      if (fs.existsSync(`${HOST_ROOT}${SYSTEMD_UNIT_PATH}`)) {
        await nsenter('rm', ['-f', SYSTEMD_UNIT_PATH]);
        await nsenter('systemctl', ['daemon-reload']);
        write(`Removed: ${SYSTEMD_UNIT_PATH}`);
      }

      write('\n=== Removing VectorCore MMSC (binary, database, media store) ===');
      await nsenter('rm', ['-rf', VC_DIR]);
      write(`Removed: ${VC_DIR}`);

      if (fs.existsSync(HOST_MMS_STATE)) { fs.unlinkSync(HOST_MMS_STATE); write(`Removed: ${HOST_MMS_STATE}`); }

      await auditLogger.log({ action: 'mms_uninstall', user, details: 'success', success: true });
      write('\n✅ MMS fully removed.');
      res.end();
    } catch (err) {
      await auditLogger.log({ action: 'mms_uninstall', user, details: String(err), success: false });
      write(`\n❌ Uninstall error: ${String(err)}`);
      res.end();
    }
  });

  // GET /api/mms/mobileconfig — requireAdmin like everything else here: this
  // project's global `app.use('/api', authMiddleware)` hard-401s any
  // unauthenticated request before it'd even reach a route-level exemption,
  // so a real subscriber's phone can never fetch this URL directly anyway
  // (confirmed by reading index.ts). The admin downloads it via their own
  // authenticated browser session and hands the file to the subscriber by
  // whatever means (AirDrop/email/Messages all trigger iOS's same "Review
  // Profile" install flow as a direct Safari download — this isn't a
  // meaningfully worse UX, just a different transfer step). Stateless
  // generator either way — apn/mmscUrl are only ever embedded as-is
  // (XML-escaped), never written anywhere. Defaults mmscUrl from the last
  // Configure's mm1PublicIp when the caller doesn't override it, so the
  // common case ("just give me a working profile") needs zero query params.
  router.get('/mobileconfig', requireAdmin, (req: Request, res: Response) => {
    const state = readMmsState();
    const apn = typeof req.query.apn === 'string' && req.query.apn.trim() ? req.query.apn.trim() : 'internet';
    const mmscUrlDefault = state ? `http://${state.mm1PublicIp}:${MM1_PORT}/mms/retrieve` : undefined;
    const mmscUrl = typeof req.query.mmscUrl === 'string' && req.query.mmscUrl.trim() ? req.query.mmscUrl.trim() : mmscUrlDefault;
    if (!mmscUrl) {
      return res.status(400).json({ success: false, error: 'No mmscUrl given and MMS has not been configured yet (no mm1PublicIp to default to) — pass ?mmscUrl=... explicitly or configure MMS first.' });
    }
    const plist = mmsMobileConfigPlist(apn, mmscUrl);
    res.setHeader('Content-Type', 'application/x-apple-aspen-config; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="open5gs-nms-mms.mobileconfig"');
    res.send(plist);
  });

  // GET /api/mms/admin/* — read-only proxy into VectorCore's own admin API
  // (:8080 has zero auth of its own, confirmed by reading api/rest/router.go —
  // never expose it directly). Frontend calls e.g. /api/mms/admin/api/v1/messages.
  router.get('/admin/*', requireAdmin, async (req: Request, res: Response) => {
    const subPath = (req.params as any)[0] as string;
    const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    try {
      const { stdout } = await nsenter('curl', ['-fsS', `http://127.0.0.1:${API_PORT}/${subPath}${qs}`], 10000);
      res.type('application/json').send(stdout);
    } catch (err) {
      res.status(502).json({ success: false, error: String(err) });
    }
  });

  return router;
}
