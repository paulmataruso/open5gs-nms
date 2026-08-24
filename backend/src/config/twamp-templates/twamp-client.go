// twamp-client — a small CLI wrapper around github.com/ncode/twamp's client
// package, adapted from that repo's own examples/client/client.go, PLUS a
// hand-rolled TWAMP-Light implementation the library doesn't provide.
//
// Two real, different wire protocols both go by "TWAMP":
//   - full TWAMP-Control (RFC 5357 main body): a TCP control connection
//     negotiates a session first, then UDP test packets flow on
//     dynamically-assigned ports. This is what github.com/ncode/twamp's
//     client package implements — that's the `-protocol full` path below.
//   - TWAMP-Light (RFC 5357 Appendix I): no control connection at all — the
//     sender just fires UDP test packets directly at a well-known port and
//     the reflector echoes them back with timestamps swapped in. Common on
//     real vendor gear (confirmed live 2026-08-24: a Nokia AirScale radio
//     does this, sending straight to UDP/862 with zero TCP handshake —
//     confirmed via packet capture, our TCP-only reflector never even saw
//     it). The library has no support for this at all, so `-protocol
//     light` below is a from-scratch implementation of RFC 5357 Appendix I.
//
// Both paths emit the exact same JSON shape to stdout — the protocol
// variant is purely an implementation detail here, invisible to the Node
// backend that spawns this binary:
//   success: {"success":true,"packetsSent":10,"packetsReceived":10,"packetsLost":0,
//             "minRttMs":1.2,"maxRttMs":3.4,"avgRttMs":2.1,"jitterMs":0.5,
//             "avgForwardDelayMs":1.0,"avgReverseDelayMs":1.1,"delayAsymmetryMs":0.9}
//   failure: {"success":false,"error":"..."}  (also a non-zero exit code)
package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"flag"
	"fmt"
	"math"
	"net"
	"os"
	"time"

	"github.com/ncode/twamp/client"
	"github.com/ncode/twamp/common"
)

type resultJSON struct {
	Success           bool    `json:"success"`
	Error             string  `json:"error,omitempty"`
	PacketsSent       uint32  `json:"packetsSent,omitempty"`
	PacketsReceived   uint32  `json:"packetsReceived,omitempty"`
	PacketsLost       uint32  `json:"packetsLost,omitempty"`
	MinRttMs          float64 `json:"minRttMs,omitempty"`
	MaxRttMs          float64 `json:"maxRttMs,omitempty"`
	AvgRttMs          float64 `json:"avgRttMs,omitempty"`
	JitterMs          float64 `json:"jitterMs,omitempty"`
	AvgForwardDelayMs float64 `json:"avgForwardDelayMs,omitempty"`
	AvgReverseDelayMs float64 `json:"avgReverseDelayMs,omitempty"`
	DelayAsymmetryMs  float64 `json:"delayAsymmetryMs,omitempty"`
}

func emit(r resultJSON) {
	json.NewEncoder(os.Stdout).Encode(r)
	if !r.Success {
		os.Exit(1)
	}
}

func fail(err error) {
	emit(resultJSON{Success: false, Error: err.Error()})
}

func durMs(d time.Duration) float64 {
	return float64(d) / float64(time.Millisecond)
}

func main() {
	addr := flag.String("addr", "", "TWAMP address, host:port (required)")
	protocol := flag.String("protocol", "full", "full (TWAMP-Control, RFC 5357) | light (TWAMP-Light, RFC 5357 Appendix I, connectionless)")
	mode := flag.String("mode", "unauthenticated", "unauthenticated | authenticated | encrypted (full protocol only — TWAMP-Light is always unauthenticated)")
	secret := flag.String("secret", "", "shared secret (authenticated/encrypted modes only)")
	keyID := flag.String("keyid", "", "key identifier (authenticated/encrypted modes only)")
	count := flag.Int("count", 10, "number of test packets to send")
	intervalMs := flag.Int("interval-ms", 1000, "milliseconds between test packets")
	timeoutMs := flag.Int("timeout-ms", 5000, "control-connection/session timeout in milliseconds (full protocol) or per-packet reply timeout (light protocol)")
	senderPort := flag.Int("sender-port", 10000, "local sender port (full protocol only)")
	receiverPort := flag.Int("receiver-port", 20000, "local receiver port (full protocol only)")
	bindIP := flag.String("bind-ip", "", "local IP to bind outbound connections to (this host is multi-homed — leave empty to let the OS pick)")
	flag.Parse()

	if *addr == "" {
		fail(fmt.Errorf("-addr is required"))
		return
	}

	if *protocol == "light" {
		emit(runLight(*addr, *bindIP, *count, *intervalMs, *timeoutMs))
		return
	}
	emit(runFull(*addr, *mode, *secret, *keyID, *bindIP, *count, *intervalMs, *timeoutMs, *senderPort, *receiverPort))
}

// ── Full TWAMP-Control (RFC 5357 main body), via github.com/ncode/twamp ────

func runFull(addr, mode, secret, keyID, bindIP string, count, intervalMs, timeoutMs, senderPort, receiverPort int) resultJSON {
	// The library's own public API has no LocalAddr-equivalent option (see
	// patch-bind-ip.py's header comment for the full why) — this env var is
	// the side channel that patch installs into the vendored source at
	// Install time, read by client.go's Connect() and test_session.go's
	// Start().
	if bindIP != "" {
		os.Setenv("TWAMP_BIND_IP", bindIP)
	}

	var preferredMode common.Mode
	switch mode {
	case "unauthenticated":
		preferredMode = common.ModeUnauthenticated
	case "authenticated":
		preferredMode = common.ModeAuthenticated
	case "encrypted":
		preferredMode = common.ModeEncrypted
	default:
		return resultJSON{Success: false, Error: fmt.Sprintf("unknown mode %q", mode)}
	}

	timeout := time.Duration(timeoutMs) * time.Millisecond
	cfg := client.ClientConfig{
		ServerAddress: addr,
		PreferredMode: preferredMode,
		SharedSecret:  secret,
		KeyID:         keyID,
		Timeout:       timeout,
	}

	twampClient := client.NewClient(cfg)
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	if err := twampClient.Connect(ctx); err != nil {
		return resultJSON{Success: false, Error: fmt.Sprintf("connect: %v", err)}
	}
	defer twampClient.Close()

	session, err := twampClient.RequestSession(client.TestSessionConfig{
		SenderPort:   uint16(senderPort),
		ReceiverPort: uint16(receiverPort),
		Timeout:      timeout,
	})
	if err != nil {
		return resultJSON{Success: false, Error: fmt.Sprintf("request session: %v", err)}
	}

	if err := twampClient.StartSessions(); err != nil {
		return resultJSON{Success: false, Error: fmt.Sprintf("start sessions: %v", err)}
	}

	session.StartReceiving(ctx)

	for i := 0; i < count; i++ {
		if err := session.SendTestPacket(); err != nil {
			return resultJSON{Success: false, Error: fmt.Sprintf("send test packet %d: %v", i, err)}
		}
		time.Sleep(time.Duration(intervalMs) * time.Millisecond)
	}

	results := session.GetResults()
	_ = twampClient.StopSessions()

	if results.PacketsReceived == 0 {
		return resultJSON{Success: false, Error: fmt.Sprintf("no packets received (sent %d, lost %d) — reflector unreachable or not responding", results.PacketsSent, results.PacketsLost)}
	}

	return resultJSON{
		Success:           true,
		PacketsSent:       results.PacketsSent,
		PacketsReceived:   results.PacketsReceived,
		PacketsLost:       results.PacketsLost,
		MinRttMs:          durMs(results.MinRTT),
		MaxRttMs:          durMs(results.MaxRTT),
		AvgRttMs:          durMs(results.AvgRTT),
		JitterMs:          durMs(results.RTTVariation),
		AvgForwardDelayMs: durMs(results.AvgForwardDelay),
		AvgReverseDelayMs: durMs(results.AvgReverseDelay),
		DelayAsymmetryMs:  results.DelayAsymmetry,
	}
}

// ── TWAMP-Light (RFC 5357 Appendix I), hand-rolled — the library has no
// support for this connectionless variant at all. ──────────────────────────
//
// Sender Unauthenticated Test packet (what we send, RFC 4656 §4.1.2):
//   Sequence Number (4B) | Timestamp (8B, NTP) | Error Estimate (2B) | padding
//
// Reflector Unauthenticated Test packet (what we parse back, RFC 5357 §4.2.1):
//   Sequence Number (4B) | Timestamp (8B) | Error Estimate (2B) | MBZ (2B)
//   | Receive Timestamp (8B) | Sender Sequence Number (4B)
//   | Sender Timestamp (8B) | Sender Error Estimate (2B) | MBZ (2B)
//   | Sender TTL (1B) | padding

const ntpEpochOffset = 2208988800 // seconds between 1900-01-01 and 1970-01-01 (Unix epoch)

func toNTP(t time.Time) (uint32, uint32) {
	sec := uint32(t.Unix() + ntpEpochOffset)
	frac := uint32((uint64(t.Nanosecond()) << 32) / 1e9)
	return sec, frac
}

func fromNTP(sec, frac uint32) time.Time {
	unixSec := int64(sec) - ntpEpochOffset
	nsec := int64((uint64(frac) * 1e9) >> 32)
	return time.Unix(unixSec, nsec)
}

func mean(v []float64) float64 {
	if len(v) == 0 {
		return 0
	}
	sum := 0.0
	for _, x := range v {
		sum += x
	}
	return sum / float64(len(v))
}

// min/max/avg/jitter (sample standard deviation of RTT — same "variation"
// framing as the full protocol's RTTVariation, just computed by hand here).
func rttStats(v []float64) (min, max, avg, jitter float64) {
	if len(v) == 0 {
		return 0, 0, 0, 0
	}
	min, max = v[0], v[0]
	sum := 0.0
	for _, x := range v {
		if x < min {
			min = x
		}
		if x > max {
			max = x
		}
		sum += x
	}
	avg = sum / float64(len(v))
	var sq float64
	for _, x := range v {
		d := x - avg
		sq += d * d
	}
	jitter = math.Sqrt(sq / float64(len(v)))
	return
}

const lightPacketSize = 64 // total sender-packet size — comfortably above the 14-byte minimum, matches typical real-world padding

func runLight(addr, bindIP string, count, intervalMs, timeoutMs int) resultJSON {
	udpAddr, err := net.ResolveUDPAddr("udp", addr)
	if err != nil {
		return resultJSON{Success: false, Error: fmt.Sprintf("resolve addr: %v", err)}
	}
	var laddr *net.UDPAddr
	if bindIP != "" {
		ip := net.ParseIP(bindIP)
		if ip == nil {
			return resultJSON{Success: false, Error: fmt.Sprintf("invalid -bind-ip %q", bindIP)}
		}
		laddr = &net.UDPAddr{IP: ip}
	}
	conn, err := net.DialUDP("udp", laddr, udpAddr)
	if err != nil {
		return resultJSON{Success: false, Error: fmt.Sprintf("dial: %v", err)}
	}
	defer conn.Close()

	var sent, received, lost uint32
	var rtts, fwdDelays, revDelays []float64
	reply := make([]byte, 512)

	for i := uint32(0); i < uint32(count); i++ {
		pkt := make([]byte, lightPacketSize)
		binary.BigEndian.PutUint32(pkt[0:4], i)
		sendTime := time.Now()
		sec, frac := toNTP(sendTime)
		binary.BigEndian.PutUint32(pkt[4:8], sec)
		binary.BigEndian.PutUint32(pkt[8:12], frac)
		binary.BigEndian.PutUint16(pkt[12:14], 0x0001) // error estimate: unsynchronized, multiplier 1 — no S-bit claim

		sent++
		if _, err := conn.Write(pkt); err != nil {
			lost++
			time.Sleep(time.Duration(intervalMs) * time.Millisecond)
			continue
		}

		conn.SetReadDeadline(time.Now().Add(time.Duration(timeoutMs) * time.Millisecond))
		n, err := conn.Read(reply)
		recvTime := time.Now()
		if err != nil || n < 41 {
			lost++
			time.Sleep(time.Duration(intervalMs) * time.Millisecond)
			continue
		}
		received++

		refSec := binary.BigEndian.Uint32(reply[4:8])
		refFrac := binary.BigEndian.Uint32(reply[8:12])
		refSendTime := fromNTP(refSec, refFrac)
		rxSec := binary.BigEndian.Uint32(reply[16:20])
		rxFrac := binary.BigEndian.Uint32(reply[20:24])
		refRecvTime := fromNTP(rxSec, rxFrac)

		rtts = append(rtts, recvTime.Sub(sendTime).Seconds()*1000)
		fwdDelays = append(fwdDelays, refRecvTime.Sub(sendTime).Seconds()*1000)
		revDelays = append(revDelays, recvTime.Sub(refSendTime).Seconds()*1000)

		time.Sleep(time.Duration(intervalMs) * time.Millisecond)
	}

	if received == 0 {
		return resultJSON{Success: false, Error: fmt.Sprintf("no packets received (sent %d, lost %d) — reflector unreachable or not responding to TWAMP-Light", sent, lost)}
	}

	minRtt, maxRtt, avgRtt, jitter := rttStats(rtts)
	avgFwd, avgRev := mean(fwdDelays), mean(revDelays)
	var asymmetry float64
	if avgRev != 0 {
		asymmetry = avgFwd / avgRev
	}

	return resultJSON{
		Success: true, PacketsSent: sent, PacketsReceived: received, PacketsLost: sent - received,
		MinRttMs: minRtt, MaxRttMs: maxRtt, AvgRttMs: avgRtt, JitterMs: jitter,
		AvgForwardDelayMs: avgFwd, AvgReverseDelayMs: avgRev, DelayAsymmetryMs: asymmetry,
	}
}
