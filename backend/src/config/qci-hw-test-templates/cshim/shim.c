/*
 * Thin shim reusing Open5GS's own real, already-battle-tested S1AP ASN.1
 * codec (the exact same library open5gs-mmed links against) to build a
 * standalone E-RABSetupRequest and decode whatever the eNB sends back —
 * without needing the full mme_ue_t/enb_ue_t/bearer runtime context that
 * s1ap_build_e_rab_setup_request() normally requires. This mirrors that
 * function's own IE construction (src/mme/s1ap-build.c) field-for-field.
 */
#include "shim.h"

#include <string.h>
#include <stdio.h>

#include "ogs-s1ap.h"

static int initialized = 0;

void shim_init(void)
{
    if (initialized) return;
    ogs_core_initialize();
    ogs_log_install_domain(&__ogs_s1ap_domain, "s1ap", OGS_LOG_ERROR);
    initialized = 1;
}

int shim_build_erab_setup_request(
    uint32_t mme_ue_s1ap_id,
    uint32_t enb_ue_s1ap_id,
    long e_rab_id,
    long qci,
    long arp_priority_level,
    int arp_preemption_capability,
    int arp_preemption_vulnerability,
    uint64_t mbr_dl, uint64_t mbr_ul, uint64_t gbr_dl, uint64_t gbr_ul,
    const char *transport_ipv4,
    uint32_t gtp_teid,
    const uint8_t *nas_pdu, size_t nas_pdu_len,
    uint8_t **out_buf, size_t *out_len)
{
    S1AP_S1AP_PDU_t pdu;
    S1AP_InitiatingMessage_t *initiatingMessage = NULL;
    S1AP_E_RABSetupRequest_t *E_RABSetupRequest = NULL;

    S1AP_E_RABSetupRequestIEs_t *ie = NULL;
    S1AP_MME_UE_S1AP_ID_t *MME_UE_S1AP_ID = NULL;
    S1AP_ENB_UE_S1AP_ID_t *ENB_UE_S1AP_ID = NULL;
    S1AP_E_RABToBeSetupListBearerSUReq_t *E_RABToBeSetupListBearerSUReq = NULL;

    S1AP_E_RABToBeSetupItemBearerSUReqIEs_t *item = NULL;
    S1AP_E_RABToBeSetupItemBearerSUReq_t *e_rab = NULL;
    S1AP_GBR_QosInformation_t *gbrQosInformation = NULL;
    S1AP_NAS_PDU_t *nasPdu = NULL;

    ogs_ip_t ip;
    ogs_pkbuf_t *pkbuf = NULL;
    int rv;

    if (!out_buf || !out_len) return -1;
    *out_buf = NULL;
    *out_len = 0;

    memset(&pdu, 0, sizeof(pdu));
    pdu.present = S1AP_S1AP_PDU_PR_initiatingMessage;
    pdu.choice.initiatingMessage = CALLOC(1, sizeof(*initiatingMessage));
    if (!pdu.choice.initiatingMessage) return -1;

    initiatingMessage = pdu.choice.initiatingMessage;
    initiatingMessage->procedureCode = S1AP_ProcedureCode_id_E_RABSetup;
    initiatingMessage->criticality = S1AP_Criticality_reject;
    initiatingMessage->value.present =
        S1AP_InitiatingMessage__value_PR_E_RABSetupRequest;

    initiatingMessage->value.choice.E_RABSetupRequest =
        CALLOC(1, sizeof(*E_RABSetupRequest));
    E_RABSetupRequest = initiatingMessage->value.choice.E_RABSetupRequest;

    E_RABSetupRequest->protocolIEs =
        ogs_asn_calloc_protocol_ies(&asn_DEF_S1AP_E_RABSetupRequest);

    /* MME-UE-S1AP-ID */
    ie = CALLOC(1, sizeof(*ie));
    ASN_SEQUENCE_ADD(E_RABSetupRequest->protocolIEs, ie);
    ie->id = S1AP_ProtocolIE_ID_id_MME_UE_S1AP_ID;
    ie->criticality = S1AP_Criticality_reject;
    ie->value.present = S1AP_E_RABSetupRequestIEs__value_PR_MME_UE_S1AP_ID;
    ie->value.choice.MME_UE_S1AP_ID = CALLOC(1, sizeof(*MME_UE_S1AP_ID));
    MME_UE_S1AP_ID = ie->value.choice.MME_UE_S1AP_ID;

    /* eNB-UE-S1AP-ID */
    ie = CALLOC(1, sizeof(*ie));
    ASN_SEQUENCE_ADD(E_RABSetupRequest->protocolIEs, ie);
    ie->id = S1AP_ProtocolIE_ID_id_eNB_UE_S1AP_ID;
    ie->criticality = S1AP_Criticality_reject;
    ie->value.present = S1AP_E_RABSetupRequestIEs__value_PR_ENB_UE_S1AP_ID;
    ie->value.choice.ENB_UE_S1AP_ID = CALLOC(1, sizeof(*ENB_UE_S1AP_ID));
    ENB_UE_S1AP_ID = ie->value.choice.ENB_UE_S1AP_ID;

    /* E-RABToBeSetupListBearerSUReq */
    ie = CALLOC(1, sizeof(*ie));
    ASN_SEQUENCE_ADD(E_RABSetupRequest->protocolIEs, ie);
    ie->id = S1AP_ProtocolIE_ID_id_E_RABToBeSetupListBearerSUReq;
    ie->criticality = S1AP_Criticality_reject;
    ie->value.present =
        S1AP_E_RABSetupRequestIEs__value_PR_E_RABToBeSetupListBearerSUReq;
    ie->value.choice.E_RABToBeSetupListBearerSUReq =
        CALLOC(1, sizeof(*E_RABToBeSetupListBearerSUReq));
    E_RABToBeSetupListBearerSUReq =
        ie->value.choice.E_RABToBeSetupListBearerSUReq;

    *MME_UE_S1AP_ID = mme_ue_s1ap_id;
    *ENB_UE_S1AP_ID = enb_ue_s1ap_id;

    item = CALLOC(1, sizeof(*item));
    ASN_SEQUENCE_ADD(E_RABToBeSetupListBearerSUReq, item);
    item->id = S1AP_ProtocolIE_ID_id_E_RABToBeSetupItemBearerSUReq;
    item->criticality = S1AP_Criticality_reject;
    item->value.present =
        S1AP_E_RABToBeSetupItemBearerSUReqIEs__value_PR_E_RABToBeSetupItemBearerSUReq;
    item->value.choice.E_RABToBeSetupItemBearerSUReq = CALLOC(1, sizeof(*e_rab));
    e_rab = item->value.choice.E_RABToBeSetupItemBearerSUReq;

    e_rab->e_RAB_ID = e_rab_id;
    e_rab->e_RABlevelQoSParameters =
        CALLOC(1, sizeof(*e_rab->e_RABlevelQoSParameters));
    e_rab->e_RABlevelQoSParameters->qCI = qci;
    e_rab->e_RABlevelQoSParameters->allocationRetentionPriority =
        CALLOC(1, sizeof(*e_rab->e_RABlevelQoSParameters->allocationRetentionPriority));
    e_rab->e_RABlevelQoSParameters->allocationRetentionPriority->priorityLevel =
        arp_priority_level;
    e_rab->e_RABlevelQoSParameters->allocationRetentionPriority->pre_emptionCapability =
        arp_preemption_capability;
    e_rab->e_RABlevelQoSParameters->allocationRetentionPriority->pre_emptionVulnerability =
        arp_preemption_vulnerability;

    if (mbr_dl || mbr_ul || gbr_dl || gbr_ul) {
        gbrQosInformation = CALLOC(1, sizeof(*gbrQosInformation));
        asn_uint642INTEGER(&gbrQosInformation->e_RAB_MaximumBitrateDL, mbr_dl);
        asn_uint642INTEGER(&gbrQosInformation->e_RAB_MaximumBitrateUL, mbr_ul);
        asn_uint642INTEGER(&gbrQosInformation->e_RAB_GuaranteedBitrateDL, gbr_dl);
        asn_uint642INTEGER(&gbrQosInformation->e_RAB_GuaranteedBitrateUL, gbr_ul);
        e_rab->e_RABlevelQoSParameters->gbrQosInformation = gbrQosInformation;
    }

    memset(&ip, 0, sizeof(ip));
    ip.ipv4 = 1;
    if (ogs_ipv4_from_string(&ip.addr, transport_ipv4) != OGS_OK) {
        return -1;
    }
    rv = ogs_asn_ip_to_BIT_STRING(&ip, &e_rab->transportLayerAddress);
    if (rv != OGS_OK) return -1;
    ogs_asn_uint32_to_OCTET_STRING(gtp_teid, &e_rab->gTP_TEID);

    if (nas_pdu && nas_pdu_len > 0) {
        nasPdu = &e_rab->nAS_PDU;
        nasPdu->size = nas_pdu_len;
        nasPdu->buf = CALLOC(nasPdu->size, sizeof(uint8_t));
        memcpy(nasPdu->buf, nas_pdu, nasPdu->size);
    }

    /* Deliberately not calling ogs_asn_free() here — matches
     * s1ap_build_e_rab_setup_request()'s own convention of never freeing
     * the source struct after encoding (freeing it crashes: talloc's
     * free chain expects a context this ad-hoc CALLOC tree doesn't
     * fully satisfy). Fine for a short-lived diagnostic tool. */
    pkbuf = ogs_s1ap_encode(&pdu);
    if (!pkbuf) return -1;

    *out_buf = CALLOC(pkbuf->len, sizeof(uint8_t));
    memcpy(*out_buf, pkbuf->data, pkbuf->len);
    *out_len = pkbuf->len;
    ogs_pkbuf_free(pkbuf);

    return 0;
}

void shim_free_buf(uint8_t *buf)
{
    if (buf) ogs_free(buf);
}

static void extract_cause(S1AP_Cause_t *cause, shim_decode_result_t *out)
{
    if (!cause) return;
    out->cause_present = 1;
    out->cause_group = cause->present;
    switch (cause->present) {
    case S1AP_Cause_PR_radioNetwork:
        out->cause_value = cause->choice.radioNetwork;
        break;
    case S1AP_Cause_PR_transport:
        out->cause_value = cause->choice.transport;
        break;
    case S1AP_Cause_PR_nas:
        out->cause_value = cause->choice.nas;
        break;
    case S1AP_Cause_PR_protocol:
        out->cause_value = cause->choice.protocol;
        break;
    case S1AP_Cause_PR_misc:
        out->cause_value = cause->choice.misc;
        break;
    default:
        out->cause_value = -1;
        break;
    }
}

int shim_decode_s1ap(const uint8_t *buf, size_t len, shim_decode_result_t *out)
{
    S1AP_S1AP_PDU_t pdu;
    ogs_pkbuf_t *pkbuf = NULL;
    int rv;
    size_t i;

    if (!out) return -1;
    memset(out, 0, sizeof(*out));
    out->first_failed_ebi = -1;

    pkbuf = ogs_pkbuf_alloc(NULL, len);
    if (!pkbuf) return -1;
    ogs_pkbuf_put(pkbuf, len);
    memcpy(pkbuf->data, buf, len);

    memset(&pdu, 0, sizeof(pdu));
    rv = ogs_asn_decode(&asn_DEF_S1AP_S1AP_PDU, &pdu, sizeof(pdu), pkbuf);
    if (rv != OGS_OK) {
        ogs_pkbuf_free(pkbuf);
        return -1;
    }

    out->ok = 1;

    switch (pdu.present) {
    case S1AP_S1AP_PDU_PR_initiatingMessage:
        out->outcome = 0;
        if (pdu.choice.initiatingMessage) {
            out->procedure_code = pdu.choice.initiatingMessage->procedureCode;
        }
        break;
    case S1AP_S1AP_PDU_PR_successfulOutcome: {
        S1AP_SuccessfulOutcome_t *so = pdu.choice.successfulOutcome;
        out->outcome = 1;
        if (!so) break;
        out->procedure_code = so->procedureCode;
        if (so->procedureCode != S1AP_ProcedureCode_id_E_RABSetup) break;
        if (so->value.present != S1AP_SuccessfulOutcome__value_PR_E_RABSetupResponse) break;

        out->is_erab_setup_response = 1;
        {
            S1AP_E_RABSetupResponse_t *resp =
                so->value.choice.E_RABSetupResponse;
            if (!resp || !resp->protocolIEs) break;

            for (i = 0; i < OGS_ASN_LIST_COUNT(resp->protocolIEs); i++) {
                S1AP_E_RABSetupResponseIEs_t *ie =
                    OGS_ASN_LIST_GET(resp->protocolIEs, i);
                if (!ie) continue;

                if (ie->id == S1AP_ProtocolIE_ID_id_E_RABSetupListBearerSURes &&
                    ie->value.choice.E_RABSetupListBearerSURes) {
                    out->num_succeeded = (int)OGS_ASN_LIST_COUNT(
                        ie->value.choice.E_RABSetupListBearerSURes);
                } else if (ie->id ==
                        S1AP_ProtocolIE_ID_id_E_RABFailedToSetupListBearerSURes &&
                        ie->value.choice.E_RABList) {
                    S1AP_E_RABList_t *flist = ie->value.choice.E_RABList;
                    size_t j;
                    out->num_failed = (int)OGS_ASN_LIST_COUNT(flist);
                    for (j = 0; j < OGS_ASN_LIST_COUNT(flist); j++) {
                        S1AP_E_RABItemIEs_t *fitem = OGS_ASN_LIST_GET(flist, j);
                        S1AP_E_RABItem_t *e_rab;
                        if (!fitem) continue;
                        e_rab = fitem->value.choice.E_RABItem;
                        if (!e_rab) continue;
                        if (j == 0) {
                            out->first_failed_ebi = e_rab->e_RAB_ID;
                            extract_cause(e_rab->cause, out);
                        }
                    }
                }
            }
        }
        break;
    }
    case S1AP_S1AP_PDU_PR_unsuccessfulOutcome:
        out->outcome = 2;
        if (pdu.choice.unsuccessfulOutcome)
            out->procedure_code = pdu.choice.unsuccessfulOutcome->procedureCode;
        break;
    default:
        break;
    }

    ogs_asn_free(&asn_DEF_S1AP_S1AP_PDU, &pdu);
    return 0;
}

int shim_decode_erab_setup_request(
    const uint8_t *buf, size_t len, shim_erab_setup_request_fields_t *out)
{
    S1AP_S1AP_PDU_t pdu;
    ogs_pkbuf_t *pkbuf = NULL;
    int rv;
    size_t i;

    if (!out) return -1;
    memset(out, 0, sizeof(*out));

    pkbuf = ogs_pkbuf_alloc(NULL, len);
    if (!pkbuf) return -1;
    ogs_pkbuf_put(pkbuf, len);
    memcpy(pkbuf->data, buf, len);

    memset(&pdu, 0, sizeof(pdu));
    rv = ogs_asn_decode(&asn_DEF_S1AP_S1AP_PDU, &pdu, sizeof(pdu), pkbuf);
    if (rv != OGS_OK) return -1;

    if (pdu.present != S1AP_S1AP_PDU_PR_initiatingMessage ||
        !pdu.choice.initiatingMessage ||
        pdu.choice.initiatingMessage->procedureCode != S1AP_ProcedureCode_id_E_RABSetup ||
        pdu.choice.initiatingMessage->value.present !=
            S1AP_InitiatingMessage__value_PR_E_RABSetupRequest) {
        ogs_asn_free(&asn_DEF_S1AP_S1AP_PDU, &pdu);
        return 0; /* decoded fine, just isn't the message type we want */
    }

    {
        S1AP_E_RABSetupRequest_t *req =
            pdu.choice.initiatingMessage->value.choice.E_RABSetupRequest;
        if (!req || !req->protocolIEs) {
            ogs_asn_free(&asn_DEF_S1AP_S1AP_PDU, &pdu);
            return 0;
        }

        out->is_erab_setup_request = 1;

        for (i = 0; i < OGS_ASN_LIST_COUNT(req->protocolIEs); i++) {
            S1AP_E_RABSetupRequestIEs_t *ie = OGS_ASN_LIST_GET(req->protocolIEs, i);
            if (!ie) continue;

            switch (ie->id) {
            case S1AP_ProtocolIE_ID_id_MME_UE_S1AP_ID:
                if (ie->value.choice.MME_UE_S1AP_ID)
                    out->mme_ue_s1ap_id = *ie->value.choice.MME_UE_S1AP_ID;
                break;
            case S1AP_ProtocolIE_ID_id_eNB_UE_S1AP_ID:
                if (ie->value.choice.ENB_UE_S1AP_ID)
                    out->enb_ue_s1ap_id = *ie->value.choice.ENB_UE_S1AP_ID;
                break;
            case S1AP_ProtocolIE_ID_id_E_RABToBeSetupListBearerSUReq: {
                S1AP_E_RABToBeSetupListBearerSUReq_t *reqlist =
                    ie->value.choice.E_RABToBeSetupListBearerSUReq;
                size_t j;
                if (!reqlist) break;
                for (j = 0; j < OGS_ASN_LIST_COUNT(reqlist); j++) {
                    S1AP_E_RABToBeSetupItemBearerSUReqIEs_t *item =
                        OGS_ASN_LIST_GET(reqlist, j);
                    S1AP_E_RABToBeSetupItemBearerSUReq_t *e_rab;
                    ogs_ip_t ip;

                    if (!item) continue;
                    e_rab = item->value.choice.E_RABToBeSetupItemBearerSUReq;
                    if (!e_rab) continue;

                    out->e_rab_id = e_rab->e_RAB_ID;

                    if (e_rab->e_RABlevelQoSParameters) {
                        S1AP_E_RABLevelQoSParameters_t *qos =
                            e_rab->e_RABlevelQoSParameters;
                        out->qci = qos->qCI;
                        if (qos->allocationRetentionPriority) {
                            out->arp_priority_level =
                                qos->allocationRetentionPriority->priorityLevel;
                            out->arp_preemption_capability =
                                qos->allocationRetentionPriority->pre_emptionCapability;
                            out->arp_preemption_vulnerability =
                                qos->allocationRetentionPriority->pre_emptionVulnerability;
                        }
                        if (qos->gbrQosInformation) {
                            out->has_gbr = 1;
                            /* asn_INTEGER2ulong covers our real-world range fine */
                            asn_INTEGER2ulong(
                                &qos->gbrQosInformation->e_RAB_MaximumBitrateDL,
                                (unsigned long *)&out->mbr_dl);
                            asn_INTEGER2ulong(
                                &qos->gbrQosInformation->e_RAB_MaximumBitrateUL,
                                (unsigned long *)&out->mbr_ul);
                            asn_INTEGER2ulong(
                                &qos->gbrQosInformation->e_RAB_GuaranteedBitrateDL,
                                (unsigned long *)&out->gbr_dl);
                            asn_INTEGER2ulong(
                                &qos->gbrQosInformation->e_RAB_GuaranteedBitrateUL,
                                (unsigned long *)&out->gbr_ul);
                        }
                    }

                    memset(&ip, 0, sizeof(ip));
                    if (ogs_asn_BIT_STRING_to_ip(
                            &e_rab->transportLayerAddress, &ip) == OGS_OK && ip.ipv4) {
                        snprintf(out->transport_ipv4, sizeof(out->transport_ipv4),
                            "%d.%d.%d.%d",
                            (ip.addr) & 0xff,
                            (ip.addr >> 8) & 0xff,
                            (ip.addr >> 16) & 0xff,
                            (ip.addr >> 24) & 0xff);
                    }

                    ogs_asn_OCTET_STRING_to_uint32(&e_rab->gTP_TEID, &out->gtp_teid);

                    if (e_rab->nAS_PDU.size > 0 &&
                            e_rab->nAS_PDU.size <= SHIM_MAX_NAS_PDU) {
                        memcpy(out->nas_pdu, e_rab->nAS_PDU.buf, e_rab->nAS_PDU.size);
                        out->nas_pdu_len = e_rab->nAS_PDU.size;
                    }
                }
                break;
            }
            default:
                break;
            }
        }
    }

    ogs_asn_free(&asn_DEF_S1AP_S1AP_PDU, &pdu);
    return 0;
}
