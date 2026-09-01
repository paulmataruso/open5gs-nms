// qci-hw-test: on-demand, operator-triggered QCI-admission test against a
// real, physical radio.
//
// The real MME already has (or is about to have) a working S1 association +
// real UE context with the target radio, from a real phone the operator has
// physically attached to it. We never touch that association. Instead we
// sit transparently in the existing traffic path via nftables NFQUEUE,
// scoped to exactly one radio IP for the duration of this one test:
//
//   - OUTBOUND (MME -> radio, queue 0): every real E-RABSetupRequest the MME
//     sends to this radio is decoded (Open5GS's own S1AP codec, via cgo),
//     rebuilt with the QCI swapped to the operator-requested test value
//     (everything else -- real NAS-PDU, real TEID, real transport IP, real
//     IDs -- copied verbatim), and the patched bytes replace the original
//     DATA chunk in-place before the SCTP checksum is recomputed and the
//     packet re-injected. Anything that isn't an E-RABSetupRequest, or is
//     for a UE we've already patched one for this run, passes through
//     completely untouched.
//
//   - INBOUND (radio -> MME, queue 1): purely observational. We decode every
//     E-RABSetupResponse and report the cause the radio actually sent back
//     for our patched QCI as a single JSON result line, then exit.
//
// Both nftables rules use `bypass`, so if this program isn't running (or
// crashes), traffic flows exactly as it always has -- fail-open, not
// fail-closed. On exit (normal, SIGTERM, or SIGINT) the nftables table is
// always torn down.
//
// Output: one JSON object per line on stdout ({"type":"ready"|"request_seen"
// |"result"|"error", ...}) — see the *Event structs below for exact shapes.
// Human-readable context goes to stderr only.
package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"flag"
	"fmt"
	"hash/crc32"
	"log"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"sync"
	"syscall"

	nfqueue "github.com/florianl/go-nfqueue/v2"

	"qcihwtest/cshim"
)

const (
	s1apPort      = 36412
	protoSCTP     = 132
	sctpChunkData = 0
)

var castagnoli = crc32.MakeTable(crc32.Castagnoli)

// isGbrQci reports whether q is one of the GBR-class QCIs (1-4) per 3GPP
// TS 23.203 Table 6.1.7 -- these require a GBR block in the request or any
// conformant eNB will reject the message as semantically malformed.
func isGbrQci(q int64) bool {
	switch q {
	case 1, 2, 3, 4:
		return true
	default:
		return false
	}
}

func nftTableFor(radioIP string) string {
	return fmt.Sprintf(`
table inet qci_hw_test {
	chain output {
		type filter hook output priority 0; policy accept;
		ip daddr %s sctp dport %d queue num 0 bypass
	}
	chain input {
		type filter hook input priority 0; policy accept;
		ip saddr %s sctp sport %d queue num 1 bypass
	}
}
`, radioIP, s1apPort, radioIP, s1apPort)
}

func nftApply(radioIP string) error {
	cmd := exec.Command("nft", "-f", "-")
	cmd.Stdin = strings.NewReader(nftTableFor(radioIP))
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("nft apply failed: %v: %s", err, out)
	}
	return nil
}

func nftTeardown() {
	cmd := exec.Command("nft", "delete", "table", "inet", "qci_hw_test")
	_ = cmd.Run()
}

// ---- IPv4 / SCTP helpers ----

func ip4HeaderLen(b []byte) int {
	if len(b) < 1 {
		return 0
	}
	return int(b[0]&0x0f) * 4
}

type chunkRef struct {
	offset int
	typ    byte
	length int
	actual int
}

func walkSCTPChunks(sctpPayload []byte) []chunkRef {
	var chunks []chunkRef
	pos := 12
	for pos+4 <= len(sctpPayload) {
		typ := sctpPayload[pos]
		length := int(binary.BigEndian.Uint16(sctpPayload[pos+2 : pos+4]))
		if length < 4 {
			break
		}
		actual := length
		if rem := actual % 4; rem != 0 {
			actual += 4 - rem
		}
		if pos+actual > len(sctpPayload) {
			actual = length
			if pos+actual > len(sctpPayload) {
				break
			}
		}
		chunks = append(chunks, chunkRef{offset: pos, typ: typ, length: length, actual: actual})
		pos += actual
	}
	return chunks
}

func recomputeSCTPChecksum(sctpPayload []byte) {
	binary.BigEndian.PutUint32(sctpPayload[8:12], 0)
	sum := crc32.Checksum(sctpPayload, castagnoli)
	binary.LittleEndian.PutUint32(sctpPayload[8:12], sum)
}

func recomputeIPChecksum(ipHdr []byte) {
	ipHdr[10] = 0
	ipHdr[11] = 0
	var sum uint32
	for i := 0; i+1 < len(ipHdr); i += 2 {
		sum += uint32(binary.BigEndian.Uint16(ipHdr[i : i+2]))
	}
	for sum>>16 != 0 {
		sum = (sum & 0xffff) + (sum >> 16)
	}
	binary.BigEndian.PutUint16(ipHdr[10:12], ^uint16(sum))
}

// ---- JSON event output ----

type event struct {
	Type string `json:"type"` // ready | request_seen | result | error

	// request_seen
	MmeUeS1apID uint32 `json:"mmeUeS1apId,omitempty"`
	EnbUeS1apID uint32 `json:"enbUeS1apId,omitempty"`
	ERabID      int64  `json:"erabId,omitempty"`
	OriginalQCI int64  `json:"originalQci,omitempty"`
	TestQCI     int64  `json:"testQci,omitempty"`

	// result
	Success    bool  `json:"success,omitempty"`
	CauseGroup int64 `json:"causeGroup,omitempty"`
	CauseValue int64 `json:"causeValue,omitempty"`

	// error
	Message string `json:"message,omitempty"`
}

var stdoutMu sync.Mutex

func emit(e event) {
	stdoutMu.Lock()
	defer stdoutMu.Unlock()
	b, err := json.Marshal(e)
	if err != nil {
		return
	}
	fmt.Println(string(b))
}

// ---- outbound: patch the one E-RABSetupRequest seen for this radio ----

var patchedOnce sync.Once

func handleOutbound(a nfqueue.Attribute, nf *nfqueue.Nfqueue, testQCI int64) int {
	id := *a.PacketID
	if a.Payload == nil {
		nf.SetVerdict(id, nfqueue.NfAccept)
		return 0
	}
	buf := *a.Payload

	ihl := ip4HeaderLen(buf)
	if ihl < 20 || len(buf) < ihl+12 || buf[9] != protoSCTP {
		nf.SetVerdict(id, nfqueue.NfAccept)
		return 0
	}
	sctpPayload := buf[ihl:]
	chunks := walkSCTPChunks(sctpPayload)

	patched := false
	newSctpPayload := make([]byte, 12, len(sctpPayload)+32)
	copy(newSctpPayload, sctpPayload[:12])

	for _, c := range chunks {
		raw := sctpPayload[c.offset : c.offset+c.actual]

		if c.typ != sctpChunkData || c.length < 16 {
			newSctpPayload = append(newSctpPayload, raw...)
			continue
		}
		s1apStart := c.offset + 16
		s1apEnd := c.offset + c.length
		if s1apEnd > len(sctpPayload) || s1apStart > s1apEnd {
			newSctpPayload = append(newSctpPayload, raw...)
			continue
		}
		s1apBytes := sctpPayload[s1apStart:s1apEnd]

		fields, err := cshim.DecodeErabSetupRequest(s1apBytes)
		if err != nil || !fields.IsErabSetupRequest || patched {
			newSctpPayload = append(newSctpPayload, raw...)
			continue
		}

		hasGbr := isGbrQci(testQCI)
		mbrDL, mbrUL, gbrDL, gbrUL := fields.MbrDL, fields.MbrUL, fields.GbrDL, fields.GbrUL
		if hasGbr && !fields.HasGBR {
			// Synthesize sensible GBR values (matching a real QCI=1 VoLTE bearer
			// request) when the test QCI needs a GBR block the original request
			// didn't carry, so the message stays well-formed and a FAILED verdict
			// actually means "this radio rejects this QCI", not "malformed test".
			mbrDL, mbrUL, gbrDL, gbrUL = 84000, 84000, 84000, 84000
		}

		emit(event{Type: "request_seen",
			MmeUeS1apID: fields.MmeUeS1apID, EnbUeS1apID: fields.EnbUeS1apID,
			ERabID: fields.ERabID, OriginalQCI: fields.QCI, TestQCI: testQCI})

		newFields := cshim.ErabSetupRequestFields{
			MmeUeS1apID:                fields.MmeUeS1apID,
			EnbUeS1apID:                fields.EnbUeS1apID,
			ERabID:                     fields.ERabID,
			QCI:                        testQCI,
			ArpPriorityLevel:           fields.ArpPriorityLevel,
			ArpPreemptionCapability:    fields.ArpPreemptionCapability,
			ArpPreemptionVulnerability: fields.ArpPreemptionVulnerability,
			HasGBR:                     hasGbr,
			MbrDL:                      mbrDL,
			MbrUL:                      mbrUL,
			GbrDL:                      gbrDL,
			GbrUL:                      gbrUL,
			TransportIPv4:              fields.TransportIPv4,
			GtpTeid:                    fields.GtpTeid,
			NasPdu:                     fields.NasPdu,
		}
		newBytes, err := cshim.BuildErabSetupRequest(newFields)
		if err != nil {
			log.Printf("rebuild failed, passing through unmodified: %v", err)
			newSctpPayload = append(newSctpPayload, raw...)
			continue
		}

		newChunkLen := 16 + len(newBytes)
		newChunk := make([]byte, newChunkLen)
		copy(newChunk, raw[:16])
		binary.BigEndian.PutUint16(newChunk[2:4], uint16(newChunkLen))
		copy(newChunk[16:], newBytes)
		if rem := newChunkLen % 4; rem != 0 {
			newChunk = append(newChunk, make([]byte, 4-rem)...)
		}

		newSctpPayload = append(newSctpPayload, newChunk...)
		patched = true
		log.Printf("patched EBI=%d: %d -> QCI=%d (chunk %d -> %d bytes)", fields.ERabID, fields.QCI, testQCI, c.actual, len(newChunk))
	}

	if !patched {
		nf.SetVerdict(id, nfqueue.NfAccept)
		return 0
	}

	recomputeSCTPChecksum(newSctpPayload)

	newBuf := make([]byte, ihl+len(newSctpPayload))
	copy(newBuf, buf[:ihl])
	copy(newBuf[ihl:], newSctpPayload)
	binary.BigEndian.PutUint16(newBuf[2:4], uint16(len(newBuf)))
	recomputeIPChecksum(newBuf[:ihl])

	if err := nf.SetVerdictModPacket(id, nfqueue.NfAccept, newBuf); err != nil {
		log.Printf("SetVerdictModPacket error: %v", err)
		nf.SetVerdict(id, nfqueue.NfAccept)
	}
	return 0
}

// ---- inbound: observe E-RABSetupResponse and report the definitive result ----

func handleInbound(a nfqueue.Attribute, nf *nfqueue.Nfqueue, done chan<- struct{}) int {
	id := *a.PacketID
	if a.Payload == nil {
		nf.SetVerdict(id, nfqueue.NfAccept)
		return 0
	}
	buf := *a.Payload

	ihl := ip4HeaderLen(buf)
	if ihl >= 20 && len(buf) >= ihl+12 && buf[9] == protoSCTP {
		sctpPayload := buf[ihl:]
		for _, c := range walkSCTPChunks(sctpPayload) {
			if c.typ != sctpChunkData || c.length < 16 {
				continue
			}
			s1apStart := c.offset + 16
			s1apEnd := c.offset + c.length
			if s1apEnd > len(sctpPayload) || s1apStart > s1apEnd {
				continue
			}
			res, err := cshim.DecodeS1AP(sctpPayload[s1apStart:s1apEnd])
			if err != nil || !res.Ok || !res.IsErabSetupResponse {
				continue
			}
			if res.NumSucceeded > 0 && res.NumFailed == 0 {
				emit(event{Type: "result", Success: true})
				select {
				case done <- struct{}{}:
				default:
				}
			} else if res.NumFailed > 0 {
				emit(event{Type: "result", Success: false, CauseGroup: res.CauseGroup, CauseValue: res.CauseValue})
				select {
				case done <- struct{}{}:
				default:
				}
			}
		}
	}

	nf.SetVerdict(id, nfqueue.NfAccept)
	return 0
}

func main() {
	radioIP := flag.String("radio-ip", "", "IP of the target radio (eNB) to test")
	qci := flag.Int64("qci", 1, "QCI value to test (1-9)")
	flag.Parse()

	cshim.Init()

	if os.Geteuid() != 0 {
		emit(event{Type: "error", Message: "must run as root (NFQUEUE + nftables)"})
		os.Exit(1)
	}
	if *radioIP == "" {
		emit(event{Type: "error", Message: "-radio-ip is required"})
		os.Exit(1)
	}
	if *qci < 1 || *qci > 9 {
		emit(event{Type: "error", Message: "-qci must be between 1 and 9"})
		os.Exit(1)
	}

	nftTeardown() // clean slate in case of a leftover table from a prior run
	if err := nftApply(*radioIP); err != nil {
		emit(event{Type: "error", Message: fmt.Sprintf("nft: %v", err)})
		os.Exit(1)
	}
	defer nftTeardown()

	ctx, cancel := context.WithCancel(context.Background())
	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigs
		cancel()
	}()

	cfgOut := &nfqueue.Config{NfQueue: 0, MaxPacketLen: 0xFFFF, MaxQueueLen: 64, Copymode: nfqueue.NfQnlCopyPacket, AfFamily: 2}
	nfOut, err := nfqueue.Open(cfgOut)
	if err != nil {
		emit(event{Type: "error", Message: fmt.Sprintf("open outbound queue: %v", err)})
		os.Exit(1)
	}
	defer nfOut.Close()

	cfgIn := &nfqueue.Config{NfQueue: 1, MaxPacketLen: 0xFFFF, MaxQueueLen: 64, Copymode: nfqueue.NfQnlCopyPacket, AfFamily: 2}
	nfIn, err := nfqueue.Open(cfgIn)
	if err != nil {
		emit(event{Type: "error", Message: fmt.Sprintf("open inbound queue: %v", err)})
		os.Exit(1)
	}
	defer nfIn.Close()

	done := make(chan struct{}, 1)

	if err := nfOut.Register(ctx, func(a nfqueue.Attribute) int { return handleOutbound(a, nfOut, *qci) }); err != nil {
		emit(event{Type: "error", Message: fmt.Sprintf("register outbound: %v", err)})
		os.Exit(1)
	}
	if err := nfIn.Register(ctx, func(a nfqueue.Attribute) int { return handleInbound(a, nfIn, done) }); err != nil {
		emit(event{Type: "error", Message: fmt.Sprintf("register inbound: %v", err)})
		os.Exit(1)
	}

	emit(event{Type: "ready"})
	log.Printf("qci-hw-test running against %s, testing QCI=%d. Waiting for a real call...", *radioIP, *qci)

	select {
	case <-done:
		// Definitive result already emitted by handleInbound — exit cleanly,
		// deferred nftTeardown() and queue Close() run on the way out.
	case <-ctx.Done():
		// Caller (orchestrator) sent SIGTERM, most likely a timeout — no
		// result to emit, just clean up.
	}
}
