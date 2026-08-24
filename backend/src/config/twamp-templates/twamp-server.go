// twamp-server — runs TWAMP reflector(s) for the case where a radio (or
// anything else) acts as the TWAMP CLIENT and tests INBOUND against this
// NMS host, the reverse direction of twamp-client.go's own tests. Unlike
// that on-demand wrapper, this is a genuinely persistent process — it's
// installed as its own systemd unit (twamp-server.service), not spawned
// per-test.
//
// Two real, different wire protocols both go by "TWAMP" — see
// twamp-client.go's header comment for the full explanation. This binary
// can run either or both, independently toggleable:
//   - full TWAMP-Control (RFC 5357 main body, TCP control + UDP test) — via
//     github.com/ncode/twamp's server package, adapted from that repo's own
//     examples/server/main.go.
//   - TWAMP-Light (RFC 5357 Appendix I, connectionless UDP) — hand-rolled,
//     the library has no support for it at all. Confirmed live 2026-08-24
//     via packet capture: a real Nokia AirScale radio speaks ONLY this
//     variant (sends straight to UDP/862, never attempts the TCP
//     handshake), so this isn't a theoretical nice-to-have.
package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/ncode/twamp/common"
	"github.com/ncode/twamp/metrics"
	"github.com/ncode/twamp/server"
	"github.com/prometheus/client_golang/prometheus"
)

func main() {
	listenAddr := flag.String("listen", ":862", "TWAMP-Control (full protocol) TCP listen address, ip:port")
	fullEnabled := flag.Bool("full-enabled", true, "run the full TWAMP-Control (TCP) reflector")
	lightEnabled := flag.Bool("light-enabled", true, "run the TWAMP-Light (connectionless UDP) reflector")
	lightListenAddr := flag.String("light-listen", "", "TWAMP-Light UDP listen address, ip:port (empty = same ip:port as -listen)")
	// TWAMP-Light is connectionless UDP — there's no OS-level "connection" to
	// query the way `ss -tn` finds real TCP peers for the full protocol (see
	// twamp-controller.ts's getServerConnections() comment). Track recently-
	// seen senders in-process instead and expose them here so the NMS
	// backend's /server/connections endpoint can merge them in — otherwise a
	// Light-only reflector (this deployment's actual live config, confirmed
	// 2026-08-24: enableFull=false) always reports zero connected clients no
	// matter how much real traffic a radio is sending.
	lightPeersAddr := flag.String("light-peers-addr", "127.0.0.1:9272", "internal HTTP address exposing recently-seen TWAMP-Light peers as JSON (empty to disable)")
	modesFlag := flag.String("modes", "unauthenticated", "comma-separated: unauthenticated,authenticated,encrypted (full protocol only — TWAMP-Light is always unauthenticated)")
	secretsFlag := flag.String("secrets", "", "comma-separated keyid:secret pairs (authenticated/encrypted modes only), e.g. user1:pass1,user2:pass2")
	allowCidrsFlag := flag.String("allow-cidrs", "", "comma-separated CIDR blocks allowed as unauthenticated test receivers (full protocol only — empty means the library's own default)")
	// Loopback-only, not exposed beyond this host — the NMS backend scrapes
	// this for the Info & Stats page (active sessions, packet/error
	// counters). Real capability the library already ships (metrics
	// package), just never wired into a runnable binary until now. Covers
	// the full-protocol reflector only — TWAMP-Light has no equivalent
	// counters from the library since it's not library code at all.
	metricsAddr := flag.String("metrics-addr", "127.0.0.1:9271", "internal Prometheus metrics listen address (empty to disable)")
	flag.Parse()

	if !*fullEnabled && !*lightEnabled {
		log.Fatal("at least one of -full-enabled or -light-enabled must be true")
	}

	// Metrics: created and started UNCONDITIONALLY (moved out of the
	// full-protocol branch it used to live in) — it used to only exist when
	// -full-enabled was true, which meant a Light-only reflector (this
	// deployment's actual live config) had NO Prometheus endpoint at all,
	// and the Info & Stats "Raw Metrics" tab had nothing to show. Both
	// protocols now register their own collectors into this one shared
	// registry, so :metrics-addr/metrics is populated regardless of which
	// protocol(s) are actually running.
	var m *metrics.Metrics
	if *metricsAddr != "" {
		m = metrics.New()
		registerLightMetrics(m.Registry())
		metricsSrv := metrics.NewServer(metrics.ServerConfig{
			Address:  *metricsAddr,
			Registry: m.Registry(),
		})
		if err := metricsSrv.Start(); err != nil {
			log.Printf("metrics server failed to start: %v (continuing without it)", err)
		} else {
			log.Printf("metrics available at http://%s/metrics", *metricsAddr)
		}
	}

	if *lightEnabled {
		addr := *lightListenAddr
		if addr == "" {
			addr = *listenAddr
		}
		if err := startLightReflector(addr); err != nil {
			log.Fatalf("failed to start TWAMP-Light reflector: %v", err)
		}
		log.Printf("TWAMP-Light reflector listening on %s/udp", addr)

		if *lightPeersAddr != "" {
			startLightPeersServer(*lightPeersAddr)
			log.Printf("TWAMP-Light peer list available at http://%s/light-peers", *lightPeersAddr)
		}
	}

	if *fullEnabled {
		var supportedModes common.Mode
		for _, m := range strings.Split(*modesFlag, ",") {
			switch strings.TrimSpace(strings.ToLower(m)) {
			case "unauthenticated":
				supportedModes |= common.ModeUnauthenticated
			case "authenticated":
				supportedModes |= common.ModeAuthenticated
			case "encrypted":
				supportedModes |= common.ModeEncrypted
			case "":
			default:
				log.Printf("unknown mode in -modes: %s (ignored)", m)
			}
		}
		if supportedModes == 0 {
			supportedModes = common.ModeUnauthenticated
		}

		secretMap := make(map[string]string)
		if *secretsFlag != "" {
			for _, pair := range strings.Split(*secretsFlag, ",") {
				parts := strings.SplitN(pair, ":", 2)
				if len(parts) == 2 && parts[0] != "" && parts[1] != "" {
					secretMap[parts[0]] = parts[1]
				}
			}
		}

		var allowCidrs []string
		if *allowCidrsFlag != "" {
			for _, c := range strings.Split(*allowCidrsFlag, ",") {
				if c = strings.TrimSpace(c); c != "" {
					allowCidrs = append(allowCidrs, c)
				}
			}
		}

		cfg := server.ServerConfig{
			ListenAddress:          *listenAddr,
			SupportedModes:         supportedModes,
			SecretMap:              secretMap,
			ReceiverAllowlistCIDRs: allowCidrs,
			Metrics:                m,
		}

		log.Printf("starting TWAMP-Control (full) server on %s (modes=%s)", *listenAddr, *modesFlag)
		twampServer, err := server.NewServer(cfg)
		if err != nil {
			log.Fatalf("failed to create server: %v", err)
		}

		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()

		if err := twampServer.Start(ctx); err != nil {
			log.Fatalf("failed to start server: %v", err)
		}
		fmt.Printf("TWAMP-Control (full) server listening on %s/tcp\n", *listenAddr)

		defer func() {
			log.Println("shutting down TWAMP-Control (full) server...")
			twampServer.Stop()
		}()
	}

	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
	<-sigChan
	log.Println("shutting down...")
}

// ── TWAMP-Light reflector (RFC 5357 Appendix I), hand-rolled — see
// twamp-client.go's matching comment for the exact wire format on both
// sides. This just does the reflector half: read a Sender packet, write
// back a Reflector packet with Receive/Reflector timestamps filled in and
// the sender's own fields echoed back verbatim.

// ── Light-peer tracking ──────────────────────────────────────────────────
// In-memory only (not persisted) — this is a live "who's testing against us
// right now" view, not a history (Prometheus/Grafana own history for the
// metrics that have it). Keyed by the sender's full addr (ip:port, since a
// TWAMP-Light client's ephemeral source port can legitimately differ between
// separate test runs from the same device).

type lightPeerStats struct {
	lastSeen    time.Time
	packetCount uint64
}

var (
	lightPeersMu sync.Mutex
	lightPeers   = make(map[string]*lightPeerStats)
	// Counter, not the map above — labeled by peer_ip only (not peer_ip:port,
	// unlike the map's key) to keep Prometheus label cardinality bounded to
	// real distinct devices rather than growing with every ephemeral source
	// port a client happens to use across separate test runs.
	lightPacketsReflectedTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "twamp_light_packets_reflected_total",
		Help: "Total TWAMP-Light test packets reflected back to each sender, by peer IP",
	}, []string{"peer_ip"})
)

// A peer that stopped sending should eventually drop off the "connected"
// view rather than linger forever from one test run hours ago.
const lightPeerStaleAfter = 5 * time.Minute

func recordLightPeer(addr *net.UDPAddr) {
	key := addr.String()
	lightPeersMu.Lock()
	defer lightPeersMu.Unlock()
	p, ok := lightPeers[key]
	if !ok {
		p = &lightPeerStats{}
		lightPeers[key] = p
	}
	p.lastSeen = time.Now()
	p.packetCount++
	lightPacketsReflectedTotal.WithLabelValues(addr.IP.String()).Inc()
}

// Shared by the /light-peers JSON handler and the Prometheus GaugeFunc below
// — one definition of "active" (seen within the staleness window) so the
// Connected Clients table and the exported metric can never disagree.
func activeLightPeerCount() int {
	cutoff := time.Now().Add(-lightPeerStaleAfter)
	lightPeersMu.Lock()
	defer lightPeersMu.Unlock()
	n := 0
	for _, p := range lightPeers {
		if !p.lastSeen.Before(cutoff) {
			n++
		}
	}
	return n
}

// Registers TWAMP-Light's own metrics into the shared registry — called
// unconditionally in main() regardless of -light-enabled, since an
// unregistered CounterVec/GaugeFunc is harmless (just always reads as
// empty/zero) and this keeps the registration call sites in one place.
func registerLightMetrics(reg *prometheus.Registry) {
	reg.MustRegister(lightPacketsReflectedTotal)
	reg.MustRegister(prometheus.NewGaugeFunc(prometheus.GaugeOpts{
		Name: "twamp_light_active_peers",
		Help: "Number of distinct TWAMP-Light peers seen within the last 5 minutes",
	}, func() float64 { return float64(activeLightPeerCount()) }))
}

type lightPeerOut struct {
	PeerIP      string `json:"peerIp"`
	PeerPort    string `json:"peerPort"`
	LastSeenMs  int64  `json:"lastSeenMs"`
	PacketCount uint64 `json:"packetCount"`
}

func startLightPeersServer(addr string) {
	mux := http.NewServeMux()
	mux.HandleFunc("/light-peers", func(w http.ResponseWriter, r *http.Request) {
		cutoff := time.Now().Add(-lightPeerStaleAfter)
		lightPeersMu.Lock()
		out := make([]lightPeerOut, 0, len(lightPeers))
		for key, p := range lightPeers {
			if p.lastSeen.Before(cutoff) {
				continue
			}
			host, port, err := net.SplitHostPort(key)
			if err != nil {
				host, port = key, ""
			}
			out = append(out, lightPeerOut{PeerIP: host, PeerPort: port, LastSeenMs: p.lastSeen.UnixMilli(), PacketCount: p.packetCount})
		}
		lightPeersMu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(out)
	})
	srv := &http.Server{Addr: addr, Handler: mux, ReadTimeout: 5 * time.Second, WriteTimeout: 5 * time.Second}
	go func() {
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Printf("light-peers HTTP server error: %v", err)
		}
	}()
}

const ntpEpochOffset = 2208988800 // seconds between 1900-01-01 and 1970-01-01 (Unix epoch)

func toNTP(t time.Time) (uint32, uint32) {
	sec := uint32(t.Unix() + ntpEpochOffset)
	frac := uint32((uint64(t.Nanosecond()) << 32) / 1e9)
	return sec, frac
}

func startLightReflector(addr string) error {
	udpAddr, err := net.ResolveUDPAddr("udp", addr)
	if err != nil {
		return fmt.Errorf("resolve %q: %w", addr, err)
	}
	conn, err := net.ListenUDP("udp", udpAddr)
	if err != nil {
		return fmt.Errorf("listen: %w", err)
	}

	go func() {
		buf := make([]byte, 65536)
		var seq uint32
		for {
			n, raddr, err := conn.ReadFromUDP(buf)
			if err != nil {
				// Listener closed (shutdown) or a transient read error —
				// either way, nothing to reflect. This process only ever
				// closes this socket on process exit, so just stop quietly.
				return
			}
			recvTime := time.Now()
			if n < 14 {
				continue // too short to be a valid Sender Unauthenticated Test packet
			}
			recordLightPeer(raddr)

			senderSeq := buf[0:4]
			senderTsSec := binary.BigEndian.Uint32(buf[4:8])
			senderTsFrac := binary.BigEndian.Uint32(buf[8:12])
			senderErrEst := buf[12:14]

			sendTime := time.Now()
			replyLen := n
			if replyLen < 41 {
				replyLen = 41 // the reflector header alone needs 41 bytes
			}
			reply := make([]byte, replyLen)
			binary.BigEndian.PutUint32(reply[0:4], seq)
			seq++
			sec, frac := toNTP(sendTime)
			binary.BigEndian.PutUint32(reply[4:8], sec)
			binary.BigEndian.PutUint32(reply[8:12], frac)
			binary.BigEndian.PutUint16(reply[12:14], 0x0001) // error estimate: unsynchronized, multiplier 1
			// reply[14:16] MBZ — already zero
			rsec, rfrac := toNTP(recvTime)
			binary.BigEndian.PutUint32(reply[16:20], rsec)
			binary.BigEndian.PutUint32(reply[20:24], rfrac)
			copy(reply[24:28], senderSeq)
			binary.BigEndian.PutUint32(reply[28:32], senderTsSec)
			binary.BigEndian.PutUint32(reply[32:36], senderTsFrac)
			copy(reply[36:38], senderErrEst)
			// reply[38:40] MBZ — already zero
			reply[40] = 255 // Sender TTL — not tracked (would need IP_RECVTTL ancillary data); informational only

			_, _ = conn.WriteToUDP(reply, raddr)
		}
	}()

	return nil
}
