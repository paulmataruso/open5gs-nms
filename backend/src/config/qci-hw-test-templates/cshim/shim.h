#ifndef QCIPROBE_SHIM_H
#define QCIPROBE_SHIM_H

#include <stdint.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Must be called once before any other shim_* function. */
void shim_init(void);

/* Builds a real S1AP E-RABSetupRequest (InitiatingMessage), byte-identical in
 * structure to what open5gs-mmed's own s1ap_build_e_rab_setup_request()
 * produces, using the real asn1c-generated Open5GS S1AP codec. Caller frees
 * *out_buf with shim_free_buf(). Returns 0 on success, -1 on failure. */
int shim_build_erab_setup_request(
    uint32_t mme_ue_s1ap_id,
    uint32_t enb_ue_s1ap_id,
    long e_rab_id,
    long qci,
    long arp_priority_level,
    int arp_preemption_capability,   /* 0=may-trigger-pre-emption, 1=shall-not-trigger */
    int arp_preemption_vulnerability,/* 0=pre-emptable, 1=not-pre-emptable */
    uint64_t mbr_dl, uint64_t mbr_ul, uint64_t gbr_dl, uint64_t gbr_ul, /* 0 => omit GBR block */
    const char *transport_ipv4,      /* dotted quad, e.g. "10.0.1.176" */
    uint32_t gtp_teid,
    const uint8_t *nas_pdu, size_t nas_pdu_len, /* may be NULL/0 to omit */
    uint8_t **out_buf, size_t *out_len);

/* Result of decoding an S1AP PDU we intercepted from the Nokia eNB. */
typedef struct {
    int ok;                 /* 1 if decode succeeded */
    long procedure_code;
    int outcome;             /* 0=initiating 1=successful 2=unsuccessful */
    int is_erab_setup_response;
    int num_succeeded;
    int num_failed;
    long first_failed_ebi;
    int cause_present;       /* 1 if a cause was found on the first failed item */
    long cause_group;        /* S1AP_Cause_PR_* */
    long cause_value;        /* value within that group's enum */
} shim_decode_result_t;

int shim_decode_s1ap(const uint8_t *buf, size_t len, shim_decode_result_t *out);

/* Full field extraction from a real, intercepted E-RABSetupRequest — used so
 * the live relay can decode a genuine MME-built request, swap only the QCI,
 * and re-encode via shim_build_erab_setup_request() with everything else
 * copied verbatim (real NAS-PDU, real TEID, real transport IP, real IDs),
 * rather than relying on a fixed byte offset (which this codec's own PER
 * encoding does NOT guarantee across different ID magnitudes — confirmed
 * empirically, offset is not stable). */
#define SHIM_MAX_NAS_PDU 1024

typedef struct {
    int is_erab_setup_request;
    uint32_t mme_ue_s1ap_id;
    uint32_t enb_ue_s1ap_id;
    long e_rab_id;
    long qci;
    long arp_priority_level;
    int arp_preemption_capability;
    int arp_preemption_vulnerability;
    int has_gbr;
    uint64_t mbr_dl, mbr_ul, gbr_dl, gbr_ul;
    char transport_ipv4[16];
    uint32_t gtp_teid;
    uint8_t nas_pdu[SHIM_MAX_NAS_PDU];
    size_t nas_pdu_len;
} shim_erab_setup_request_fields_t;

int shim_decode_erab_setup_request(
    const uint8_t *buf, size_t len, shim_erab_setup_request_fields_t *out);

void shim_free_buf(uint8_t *buf);

#ifdef __cplusplus
}
#endif

#endif
