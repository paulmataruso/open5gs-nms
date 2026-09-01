// Sends a real 3GPP S6a Cancel-Location-Request to open5gs-mmed for a given
// IMSI, forcing a genuine NAS Detach Request (or paging-then-detach, if the
// UE is idle) and S1/GTP context teardown — see cshim/shim.c's own header
// comment for the full mechanism and why Cancellation-Type is hardcoded to
// SUBSCRIPTION_WITHDRAWAL. Single-shot CLI tool: one IMSI in, one JSON result
// out, matching qci-hw-test-templates/main.go's own shape (emit() writes
// JSON events to stdout, log.Printf is for human-readable stderr only).
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"sync"

	"ue-detach-tool/cshim"
)

type event struct {
	Type string `json:"type"` // ready | result | error

	// result
	Success                bool   `json:"success,omitempty"`
	TimedOut               bool   `json:"timedOut,omitempty"`
	ResultCode             uint32 `json:"resultCode,omitempty"`
	HasExperimental        bool   `json:"hasExperimental,omitempty"`
	ExperimentalResultCode uint32 `json:"experimentalResultCode,omitempty"`

	// error / message
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

func main() {
	imsi := flag.String("imsi", "", "IMSI (BCD digits) of the UE to detach")
	localIdentity := flag.String("local-identity", "", "This tool's own Diameter identity (FQDN)")
	realm := flag.String("realm", "", "Diameter realm shared with MME (e.g. epc.mnc001.mcc001.3gppnetwork.org)")
	localAddr := flag.String("local-addr", "127.0.0.20", "Local loopback alias this tool binds its Diameter node to")
	mmeIdentity := flag.String("mme-identity", "", "MME's own Diameter identity (FQDN)")
	mmeAddr := flag.String("mme-addr", "127.0.0.2", "MME's Diameter listen address")
	mmePort := flag.Int("mme-port", 3868, "MME's Diameter listen port")
	timeoutSec := flag.Int("timeout", 10, "Seconds to wait for the Cancel-Location-Answer")
	flag.Parse()

	if *imsi == "" || *localIdentity == "" || *realm == "" || *mmeIdentity == "" {
		log.Printf("missing required flag(s)")
		emit(event{Type: "error", Message: "missing required flag(s): -imsi -local-identity -realm -mme-identity"})
		os.Exit(1)
	}

	if err := cshim.Init(*localIdentity, *realm, *localAddr, *mmeIdentity, *mmeAddr, *mmePort); err != nil {
		log.Printf("cshim.Init failed: %v", err)
		emit(event{Type: "error", Message: fmt.Sprintf("failed to connect to MME as a Diameter peer: %v", err)})
		os.Exit(1)
	}
	emit(event{Type: "ready"})

	res, err := cshim.SendCLR(*imsi, *realm, *mmeIdentity, *timeoutSec)
	if err != nil {
		log.Printf("cshim.SendCLR failed: %v", err)
		emit(event{Type: "error", Message: err.Error()})
		cshim.Final()
		os.Exit(1)
	}

	emit(event{
		Type:                   "result",
		Success:                res.Success,
		TimedOut:               res.TimedOut,
		ResultCode:             res.ResultCode,
		HasExperimental:        res.HasExperimental,
		ExperimentalResultCode: res.ExperimentalResultCode,
		Message:                res.Message,
	})

	cshim.Final()
	if !res.Success {
		os.Exit(1)
	}
}
