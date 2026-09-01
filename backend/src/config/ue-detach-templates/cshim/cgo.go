// Package cshim wraps Open5GS's own compiled Diameter S6a stack
// (libogsdiameter-s6a / libogsdiameter-common, the exact libraries
// open5gs-mmed itself links against, on top of the same freeDiameter
// libfdcore/libfdproto) via cgo, so a real Cancel-Location-Request can be
// sent to the live MME using Open5GS's own message-building and dictionary
// code — rather than a separate Go Diameter stack that would have to
// independently prove wire compatibility.
//
// __OPEN5GS_SRC_DIR__ below is a template token substituted at build time
// (see ue-detach-runner.ts) with the real path to a local Open5GS source +
// build tree — same portability caveat as qci-hw-test-templates: only works
// where Open5GS was built from source with dev artifacts still present.
package cshim

/*
#cgo CFLAGS: -I${SRCDIR} -I__OPEN5GS_SRC_DIR__/build/lib/diameter/s6a -I__OPEN5GS_SRC_DIR__/lib/diameter/s6a -I__OPEN5GS_SRC_DIR__/build/lib/crypt -I__OPEN5GS_SRC_DIR__/lib/crypt -I__OPEN5GS_SRC_DIR__/build/lib/diameter/common -I__OPEN5GS_SRC_DIR__/lib/diameter/common -I__OPEN5GS_SRC_DIR__/build/lib -I__OPEN5GS_SRC_DIR__/lib -I__OPEN5GS_SRC_DIR__/build/lib/core -I__OPEN5GS_SRC_DIR__/lib/core -I__OPEN5GS_SRC_DIR__/build/subprojects/freeDiameter/include -I__OPEN5GS_SRC_DIR__/subprojects/freeDiameter/include -I__OPEN5GS_SRC_DIR__/build/subprojects/freeDiameter -I__OPEN5GS_SRC_DIR__/subprojects/freeDiameter -I__OPEN5GS_SRC_DIR__/build/lib/app -I__OPEN5GS_SRC_DIR__/lib/app -I__OPEN5GS_SRC_DIR__/build/lib/proto -I__OPEN5GS_SRC_DIR__/lib/proto -D_FILE_OFFSET_BITS=64 -DOGS_DIAM_COMPILATION -std=gnu89 -pthread
#cgo LDFLAGS: -L__OPEN5GS_SRC_DIR__/build/lib/diameter/s6a -L__OPEN5GS_SRC_DIR__/build/lib/diameter/common -L__OPEN5GS_SRC_DIR__/build/subprojects/freeDiameter/libfdcore -L__OPEN5GS_SRC_DIR__/build/subprojects/freeDiameter/libfdproto -L__OPEN5GS_SRC_DIR__/build/lib/core -L__OPEN5GS_SRC_DIR__/build/lib/crypt -L__OPEN5GS_SRC_DIR__/build/lib/proto -L__OPEN5GS_SRC_DIR__/build/lib/app -logsdiameter-s6a -logsdiameter-common -lfdcore -lfdproto -logscore -logscrypt -logsproto -logsapp -lpthread -Wl,-rpath,__OPEN5GS_SRC_DIR__/build/lib/diameter/s6a:__OPEN5GS_SRC_DIR__/build/lib/diameter/common:__OPEN5GS_SRC_DIR__/build/subprojects/freeDiameter/libfdcore:__OPEN5GS_SRC_DIR__/build/subprojects/freeDiameter/libfdproto:__OPEN5GS_SRC_DIR__/build/lib/core:__OPEN5GS_SRC_DIR__/build/lib/crypt:__OPEN5GS_SRC_DIR__/build/lib/proto:__OPEN5GS_SRC_DIR__/build/lib/app
#include "shim.h"
#include <stdlib.h>
*/
import "C"
import (
	"fmt"
	"unsafe"
)

// Result mirrors shim_clr_result_t.
type Result struct {
	Completed                 bool
	TimedOut                  bool
	Success                   bool
	ResultCode                uint32
	HasExperimental           bool
	ExperimentalResultCode    uint32
	Message                   string
}

// Init brings up Open5GS's diameter stack and connects to MME as a peer.
// Must be called once before SendCLR. Blocks briefly for the peer connection
// to establish.
func Init(identity, realm, localAddr, mmeIdentity, mmeAddr string, mmePort int) error {
	cIdentity := C.CString(identity)
	defer C.free(unsafe.Pointer(cIdentity))
	cRealm := C.CString(realm)
	defer C.free(unsafe.Pointer(cRealm))
	cLocalAddr := C.CString(localAddr)
	defer C.free(unsafe.Pointer(cLocalAddr))
	cMmeIdentity := C.CString(mmeIdentity)
	defer C.free(unsafe.Pointer(cMmeIdentity))
	cMmeAddr := C.CString(mmeAddr)
	defer C.free(unsafe.Pointer(cMmeAddr))

	rc := C.shim_init(cIdentity, cRealm, cLocalAddr, cMmeIdentity, cMmeAddr, C.int(mmePort))
	if rc != 0 {
		return fmt.Errorf("shim_init failed rc=%d", rc)
	}
	return nil
}

// SendCLR sends a real Cancel-Location-Request for imsiBcd and blocks until
// the Cancel-Location-Answer arrives or timeoutSec elapses.
func SendCLR(imsiBcd, destRealm, destHost string, timeoutSec int) (Result, error) {
	cImsi := C.CString(imsiBcd)
	defer C.free(unsafe.Pointer(cImsi))
	cDestRealm := C.CString(destRealm)
	defer C.free(unsafe.Pointer(cDestRealm))
	cDestHost := C.CString(destHost)
	defer C.free(unsafe.Pointer(cDestHost))

	var cres C.shim_clr_result_t
	rc := C.shim_send_clr(cImsi, cDestRealm, cDestHost, C.int(timeoutSec), &cres)
	if rc != 0 {
		return Result{}, fmt.Errorf("shim_send_clr failed rc=%d: %s", rc, C.GoString(&cres.message[0]))
	}

	return Result{
		Completed:              cres.completed != 0,
		TimedOut:               cres.timed_out != 0,
		Success:                cres.success != 0,
		ResultCode:             uint32(cres.result_code),
		HasExperimental:        cres.has_experimental != 0,
		ExperimentalResultCode: uint32(cres.experimental_result_code),
		Message:                C.GoString(&cres.message[0]),
	}, nil
}

// Final tears down the diameter stack. Best-effort, called on process exit.
func Final() {
	C.shim_final()
}
