// Package cshim wraps Open5GS's own compiled S1AP ASN.1 codec (the exact
// library open5gs-mmed itself links against) via cgo, so the live QCI
// hardware test can decode a real E-RABSetupRequest, swap only the QCI, and
// re-encode with every other field copied verbatim — rather than guessing
// at a hand-rolled PER encoder or relying on a fixed byte offset
// (empirically confirmed unstable across different ID magnitudes).
//
// __OPEN5GS_SRC_DIR__ below is a template token substituted at build time
// (see qci-hw-test-runner.ts) with the real path to a local Open5GS source
// + build tree — this is the one real portability caveat of this whole
// feature: it only works on a host where Open5GS was built from source with
// its dev artifacts (headers + .so files for the s1ap/asn1c/core libs)
// still present, not a packaged/stripped install. Confirmed present on this
// deployment's own host during the original live QCI investigation
// (2026-08-29/30).
package cshim

/*
#cgo CFLAGS: -I${SRCDIR} -I__OPEN5GS_SRC_DIR__/build/lib/s1ap -I__OPEN5GS_SRC_DIR__/lib/s1ap -I__OPEN5GS_SRC_DIR__/build/lib -I__OPEN5GS_SRC_DIR__/lib -I__OPEN5GS_SRC_DIR__/lib/asn1c/s1ap -I__OPEN5GS_SRC_DIR__/build/lib/asn1c/s1ap -I__OPEN5GS_SRC_DIR__/lib/asn1c/common -I__OPEN5GS_SRC_DIR__/build/lib/asn1c/common -I__OPEN5GS_SRC_DIR__/lib/core -I__OPEN5GS_SRC_DIR__/build/lib/core -I__OPEN5GS_SRC_DIR__/lib/asn1c/util -I__OPEN5GS_SRC_DIR__/build/lib/asn1c/util -D_FILE_OFFSET_BITS=64 -DOGS_S1AP_COMPILATION -std=gnu89
#cgo LDFLAGS: -L__OPEN5GS_SRC_DIR__/build/lib/s1ap -L__OPEN5GS_SRC_DIR__/build/lib/asn1c/s1ap -L__OPEN5GS_SRC_DIR__/build/lib/asn1c/common -L__OPEN5GS_SRC_DIR__/build/lib/asn1c/util -L__OPEN5GS_SRC_DIR__/build/lib/core -L__OPEN5GS_SRC_DIR__/build/lib/proto -logss1ap -logsasn1c-s1ap -logsasn1c-util -logsasn1c-common -logsproto -logscore -Wl,-rpath,__OPEN5GS_SRC_DIR__/build/lib/s1ap:__OPEN5GS_SRC_DIR__/build/lib/asn1c/s1ap:__OPEN5GS_SRC_DIR__/build/lib/asn1c/common:__OPEN5GS_SRC_DIR__/build/lib/asn1c/util:__OPEN5GS_SRC_DIR__/build/lib/core:__OPEN5GS_SRC_DIR__/build/lib/proto
#include "shim.h"
#include <stdlib.h>
*/
import "C"
import (
	"fmt"
	"sync"
	"unsafe"
)

var initOnce sync.Once

func Init() {
	initOnce.Do(func() {
		C.shim_init()
	})
}

// ErabSetupRequestFields mirrors shim_erab_setup_request_fields_t.
type ErabSetupRequestFields struct {
	IsErabSetupRequest         bool
	MmeUeS1apID                uint32
	EnbUeS1apID                uint32
	ERabID                     int64
	QCI                        int64
	ArpPriorityLevel           int64
	ArpPreemptionCapability    int
	ArpPreemptionVulnerability int
	HasGBR                     bool
	MbrDL, MbrUL, GbrDL, GbrUL uint64
	TransportIPv4              string
	GtpTeid                    uint32
	NasPdu                     []byte
}

// DecodeResult mirrors shim_decode_result_t.
type DecodeResult struct {
	Ok                  bool
	ProcedureCode       int64
	Outcome             int // 0=initiating 1=successful 2=unsuccessful
	IsErabSetupResponse bool
	NumSucceeded        int
	NumFailed           int
	FirstFailedEbi      int64
	CausePresent        bool
	CauseGroup          int64
	CauseValue          int64
}

// BuildErabSetupRequest builds a real, byte-correct S1AP E-RABSetupRequest.
func BuildErabSetupRequest(f ErabSetupRequestFields) ([]byte, error) {
	cip := C.CString(f.TransportIPv4)
	defer C.free(unsafe.Pointer(cip))

	var nasPtr *C.uint8_t
	var nasLen C.size_t
	if len(f.NasPdu) > 0 {
		nasPtr = (*C.uint8_t)(unsafe.Pointer(&f.NasPdu[0]))
		nasLen = C.size_t(len(f.NasPdu))
	}

	mbrDL, mbrUL, gbrDL, gbrUL := C.uint64_t(0), C.uint64_t(0), C.uint64_t(0), C.uint64_t(0)
	if f.HasGBR {
		mbrDL, mbrUL, gbrDL, gbrUL = C.uint64_t(f.MbrDL), C.uint64_t(f.MbrUL), C.uint64_t(f.GbrDL), C.uint64_t(f.GbrUL)
	}

	var outBuf *C.uint8_t
	var outLen C.size_t

	rc := C.shim_build_erab_setup_request(
		C.uint32_t(f.MmeUeS1apID),
		C.uint32_t(f.EnbUeS1apID),
		C.long(f.ERabID),
		C.long(f.QCI),
		C.long(f.ArpPriorityLevel),
		C.int(f.ArpPreemptionCapability),
		C.int(f.ArpPreemptionVulnerability),
		mbrDL, mbrUL, gbrDL, gbrUL,
		cip,
		C.uint32_t(f.GtpTeid),
		nasPtr, nasLen,
		&outBuf, &outLen,
	)
	if rc != 0 {
		return nil, fmt.Errorf("shim_build_erab_setup_request failed rc=%d", rc)
	}
	defer C.shim_free_buf(outBuf)

	out := make([]byte, int(outLen))
	copy(out, unsafe.Slice((*byte)(unsafe.Pointer(outBuf)), int(outLen)))
	return out, nil
}

// DecodeErabSetupRequest decodes a raw S1AP PDU and, if it's an
// E-RABSetupRequest, extracts every field needed to rebuild it with a
// different QCI.
func DecodeErabSetupRequest(buf []byte) (ErabSetupRequestFields, error) {
	var res ErabSetupRequestFields
	if len(buf) == 0 {
		return res, fmt.Errorf("empty buffer")
	}
	var cres C.shim_erab_setup_request_fields_t
	rc := C.shim_decode_erab_setup_request(
		(*C.uint8_t)(unsafe.Pointer(&buf[0])), C.size_t(len(buf)), &cres)
	if rc != 0 {
		return res, fmt.Errorf("shim_decode_erab_setup_request failed rc=%d", rc)
	}
	res.IsErabSetupRequest = cres.is_erab_setup_request != 0
	if !res.IsErabSetupRequest {
		return res, nil
	}
	res.MmeUeS1apID = uint32(cres.mme_ue_s1ap_id)
	res.EnbUeS1apID = uint32(cres.enb_ue_s1ap_id)
	res.ERabID = int64(cres.e_rab_id)
	res.QCI = int64(cres.qci)
	res.ArpPriorityLevel = int64(cres.arp_priority_level)
	res.ArpPreemptionCapability = int(cres.arp_preemption_capability)
	res.ArpPreemptionVulnerability = int(cres.arp_preemption_vulnerability)
	res.HasGBR = cres.has_gbr != 0
	res.MbrDL = uint64(cres.mbr_dl)
	res.MbrUL = uint64(cres.mbr_ul)
	res.GbrDL = uint64(cres.gbr_dl)
	res.GbrUL = uint64(cres.gbr_ul)
	res.TransportIPv4 = C.GoString(&cres.transport_ipv4[0])
	res.GtpTeid = uint32(cres.gtp_teid)
	if cres.nas_pdu_len > 0 {
		res.NasPdu = C.GoBytes(unsafe.Pointer(&cres.nas_pdu[0]), C.int(cres.nas_pdu_len))
	}
	return res, nil
}

// DecodeS1AP decodes any S1AP PDU (used on the response/inbound side).
func DecodeS1AP(buf []byte) (DecodeResult, error) {
	var res DecodeResult
	if len(buf) == 0 {
		return res, fmt.Errorf("empty buffer")
	}
	var cres C.shim_decode_result_t
	rc := C.shim_decode_s1ap(
		(*C.uint8_t)(unsafe.Pointer(&buf[0])), C.size_t(len(buf)), &cres)
	if rc != 0 {
		return res, fmt.Errorf("shim_decode_s1ap failed rc=%d", rc)
	}
	res.Ok = cres.ok != 0
	res.ProcedureCode = int64(cres.procedure_code)
	res.Outcome = int(cres.outcome)
	res.IsErabSetupResponse = cres.is_erab_setup_response != 0
	res.NumSucceeded = int(cres.num_succeeded)
	res.NumFailed = int(cres.num_failed)
	res.FirstFailedEbi = int64(cres.first_failed_ebi)
	res.CausePresent = cres.cause_present != 0
	res.CauseGroup = int64(cres.cause_group)
	res.CauseValue = int64(cres.cause_value)
	return res, nil
}
