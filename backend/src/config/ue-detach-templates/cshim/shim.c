/* Sends a real 3GPP S6a Cancel-Location-Request to Open5GS's own open5gs-mmed,
 * using Open5GS's own compiled Diameter libraries (libogsdiameter-common,
 * libogsdiameter-s6a) linked against the same freeDiameter (libfdcore/
 * libfdproto) MME itself runs — not a separate Diameter stack implementation
 * that has to independently prove interop. The init sequence and message-
 * building shape below are copied as closely as possible from Open5GS's own
 * code: the struct-only (no .conf file) peer setup is Open5GS's own test
 * harness pattern (tests/volte/test-fd-path.c's test_fd_init/test_diam_config
 * — confirmed real and maintained, not something we invented), and the
 * Cancel-Location-Request AVP set / Result-Code parsing mirror
 * src/mme/mme-fd-path.c's _mme_s6a_send_air (for building a fresh outgoing
 * S6a request) and its AIA answer handler (for parsing Result-Code /
 * Experimental-Result-Code out of the reply).
 *
 * Cancellation-Type is hardcoded to SUBSCRIPTION_WITHDRAWAL (2) — confirmed
 * live in src/mme/mme-s6a-handler.c's clr handling switch as the one case
 * that makes MME actually send a real NAS Detach Request / paging-then-
 * detach to the UE and tear down its S1/GTP context, rather than the
 * MME_UPDATE_PROCEDURE/SGSN_UPDATE_PROCEDURE cases (which only mean "the UE
 * moved to a different MME" and skip UE-facing signaling entirely). CLR-Flags
 * is deliberately omitted (defaults to 0), which per that same switch means
 * "re-attach not required" — the correct choice for a block/detach action.
 */

#include "shim.h"

#include <string.h>
#include <stdio.h>
#include <unistd.h>
#include <pthread.h>
#include <time.h>

#include "ogs-core.h"
#include "ogs-app.h"
#include "ogs-diameter-common.h"
#include "ogs-diameter-s6a.h"

static ogs_diam_config_t diam_config;
static int g_initialized = 0;

static struct session_handler *g_sess_hdl = NULL;

static pthread_mutex_t g_clr_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t g_clr_cond = PTHREAD_COND_INITIALIZER;
static shim_clr_result_t *g_pending = NULL;
static int g_pending_done = 0;

static void state_cleanup(struct sess_state *sess_data, os0_t sid, void *opaque)
{
    /* We don't store any session state (no fd_sess_state_store call below) —
     * nothing to free here. Required by fd_sess_handler_create's signature. */
    (void)sess_data; (void)sid; (void)opaque;
}

int shim_init(const char *identity, const char *realm, const char *local_addr,
              const char *mme_identity, const char *mme_addr, int mme_port)
{
    int ret;

    static const char *argv0[] = { "ue-detach-tool", NULL };

    if (g_initialized) return 0;

    /* ogs_app_initialize (not just ogs_core_initialize) is required: it also
     * creates the timer manager and pollset (lib/app/ogs-init.c) that
     * ogs_diam_stats_init() — called from inside ogs_diam_init() below —
     * asserts already exist (confirmed live 2026-08-31: ogs_timer_add
     * aborted with "Assertion `manager' failed" without this). */
    /* Trivial placeholder YAML — ogs_app_initialize() asserts a config file
     * was successfully opened (confirmed live 2026-08-31: "Assertion
     * `ogs_app()->file' failed" with NULL), but nothing in this tool's own
     * init path actually reads config values back out of it. Written once
     * at install time (see ue-detach-runner.ts) alongside the compiled
     * binary. */
    if (ogs_app_initialize("1.0.0", "/opt/open5gs-nms/ue-detach/ue-detach.yaml", argv0) != OGS_OK) {
        ogs_error("ogs_app_initialize failed");
        return -1;
    }
    /* Open5GS's diameter-common code logs via the "diam" domain but never
     * registers it itself (ogs_diam_init() has no ogs_log_install_domain
     * call anywhere in lib/diameter/common/init.c) — every real NF installs
     * it once in its own context-init (confirmed in src/mme/mme-context.c),
     * which a standalone tool has to replicate or every ogs_error/ogs_debug
     * call inside the diameter libs crashes with "No LogDomain[id:0]"
     * (confirmed live 2026-08-31). */
    ogs_log_install_domain(&__ogs_diam_domain, "diam", ogs_core()->log.level);

    memset(&diam_config, 0, sizeof(diam_config));
    diam_config.cnf_diamid = identity;
    diam_config.cnf_diamrlm = realm;
    diam_config.cnf_addr = local_addr;
    diam_config.cnf_port = 3868;
    diam_config.cnf_port_tls = 5868;
    diam_config.cnf_flags.no_sctp = 1; /* TCP only — simpler, matches the
                                          Open5GS test harness's own choice */
    diam_config.cnf_flags.no_fwd = 1;  /* this tool never relays */

    /* These are real, required dependencies, not optional mirroring of
     * MME's own config: ogs_diam_message_init() (called inside
     * ogs_diam_init() below) calls ogs_dict_common_entry(), which
     * freeDiameter's own EXTENSION_ENTRY macro declares as depending on
     * "dict_dcca_3gpp" (lib/diameter/common/dict.c) — it registers the 3GPP
     * vendor ID (10415) that ogs_diam_message_init() searches for
     * immediately after. dict_dcca_3gpp itself depends on dict_dcca, which
     * in turn depends on dict_nasreq — freeDiameter's own
     * check_dependencies() hard-fails the whole load if any of this chain
     * is loaded out of order, so all four (plus rfc5777, loaded first in
     * every one of this deployment's own freeDiameter configs) are loaded
     * here in the exact same order as mme.conf/hss.conf/pcrf.conf/smf.conf,
     * even though this single-purpose tool never otherwise touches most of
     * those interfaces (confirmed live 2026-08-31, two real dependency
     * failures fixed to get here). */
    diam_config.ext[diam_config.num_of_ext].module =
        "/usr/lib/x86_64-linux-gnu/freeDiameter/dict_rfc5777.fdx";
    diam_config.num_of_ext++;
    diam_config.ext[diam_config.num_of_ext].module =
        "/usr/lib/x86_64-linux-gnu/freeDiameter/dict_mip6i.fdx";
    diam_config.num_of_ext++;
    diam_config.ext[diam_config.num_of_ext].module =
        "/usr/lib/x86_64-linux-gnu/freeDiameter/dict_nasreq.fdx";
    diam_config.num_of_ext++;
    diam_config.ext[diam_config.num_of_ext].module =
        "/usr/lib/x86_64-linux-gnu/freeDiameter/dict_nas_mipv6.fdx";
    diam_config.num_of_ext++;
    diam_config.ext[diam_config.num_of_ext].module =
        "/usr/lib/x86_64-linux-gnu/freeDiameter/dict_dcca.fdx";
    diam_config.num_of_ext++;
    diam_config.ext[diam_config.num_of_ext].module =
        "/usr/lib/x86_64-linux-gnu/freeDiameter/dict_dcca_3gpp.fdx";
    diam_config.num_of_ext++;

    diam_config.conn[diam_config.num_of_conn].identity = mme_identity;
    diam_config.conn[diam_config.num_of_conn].addr = mme_addr;
    diam_config.conn[diam_config.num_of_conn].port = (uint16_t)mme_port;
    diam_config.num_of_conn++;

    ret = ogs_diam_init(FD_MODE_CLIENT, NULL, &diam_config);
    if (ret != 0) {
        ogs_error("ogs_diam_init failed: %d", ret);
        return -1;
    }

    ret = ogs_diam_s6a_init();
    if (ret != OGS_OK) {
        ogs_error("ogs_diam_s6a_init failed: %d", ret);
        return -1;
    }

    ret = fd_sess_handler_create(&g_sess_hdl, &state_cleanup, NULL, NULL);
    if (ret != 0) {
        ogs_error("fd_sess_handler_create failed: %d", ret);
        return -1;
    }

    ret = fd_disp_app_support(ogs_diam_s6a_application, ogs_diam_vendor, 1, 0);
    if (ret != 0) {
        ogs_error("fd_disp_app_support failed: %d", ret);
        return -1;
    }

    ret = ogs_diam_start();
    if (ret != 0) {
        ogs_error("ogs_diam_start failed: %d", ret);
        return -1;
    }

    /* Give freeDiameter's connection thread a moment to establish the peer
     * (CER/CEA) before the caller tries to send anything — a fixed short
     * sleep rather than a real "peer is UP" callback/poll, acceptable for a
     * one-shot CLI tool run interactively from the NMS, not a long-lived
     * daemon. */
    sleep(2);

    g_initialized = 1;
    return 0;
}

static void clr_answer_cb(void *data, struct msg **msg)
{
    int ret;
    struct avp *avp = NULL, *avpch = NULL;
    struct avp_hdr *hdr = NULL;
    shim_clr_result_t *out = (shim_clr_result_t *)data;

    pthread_mutex_lock(&g_clr_mutex);

    if (!out) goto signal;

    if (!msg || !*msg) {
        snprintf(out->message, sizeof(out->message), "no answer message");
        goto signal;
    }

    ret = fd_msg_search_avp(*msg, ogs_diam_result_code, &avp);
    if (ret == 0 && avp) {
        fd_msg_avp_hdr(avp, &hdr);
        out->result_code = (uint32_t)hdr->avp_value->i32;
        out->success = (out->result_code == 2001); /* DIAMETER_SUCCESS */
        snprintf(out->message, sizeof(out->message),
            "Result-Code=%u", out->result_code);
    } else {
        ret = fd_msg_search_avp(*msg, ogs_diam_experimental_result, &avp);
        if (ret == 0 && avp) {
            ret = fd_avp_search_avp(
                    avp, ogs_diam_experimental_result_code, &avpch);
            if (ret == 0 && avpch) {
                fd_msg_avp_hdr(avpch, &hdr);
                out->has_experimental = 1;
                out->experimental_result_code = (uint32_t)hdr->avp_value->i32;
                out->success = 0;
                snprintf(out->message, sizeof(out->message),
                    "Experimental-Result-Code=%u", out->experimental_result_code);
            } else {
                snprintf(out->message, sizeof(out->message),
                    "Experimental-Result AVP present but no code found");
            }
        } else {
            snprintf(out->message, sizeof(out->message),
                "no Result-Code AVP in answer");
        }
    }

signal:
    if (out) out->completed = 1;
    if (msg && *msg) {
        fd_msg_free(*msg);
        *msg = NULL;
    }
    g_pending_done = 1;
    pthread_cond_signal(&g_clr_cond);
    pthread_mutex_unlock(&g_clr_mutex);
}

int shim_send_clr(const char *imsi_bcd, const char *dest_realm,
                   const char *dest_host, int timeout_sec,
                   shim_clr_result_t *out)
{
    int ret;
    struct msg *req = NULL;
    struct avp *avp = NULL;
    union avp_value val;
    struct session *session = NULL;

    if (!g_initialized) return -1;
    memset(out, 0, sizeof(*out));

    ret = fd_msg_new(ogs_diam_s6a_cmd_clr, MSGFL_ALLOC_ETEID, &req);
    if (ret != 0) { snprintf(out->message, sizeof(out->message), "fd_msg_new failed: %d", ret); return -1; }

#define UE_DETACH_APP_SID_OPT "app_ue_detach"
    ret = fd_msg_new_session(req, (os0_t)UE_DETACH_APP_SID_OPT,
            CONSTSTRLEN(UE_DETACH_APP_SID_OPT));
    if (ret != 0) { snprintf(out->message, sizeof(out->message), "fd_msg_new_session failed: %d", ret); return -1; }
    ret = fd_msg_sess_get(fd_g_config->cnf_dict, req, &session, NULL);
    if (ret != 0) { snprintf(out->message, sizeof(out->message), "fd_msg_sess_get failed: %d", ret); return -1; }

    /* Auth-Session-State */
    ret = fd_msg_avp_new(ogs_diam_auth_session_state, 0, &avp);
    if (ret != 0) return -1;
    val.i32 = OGS_DIAM_AUTH_SESSION_NO_STATE_MAINTAINED;
    fd_msg_avp_setvalue(avp, &val);
    fd_msg_avp_add(req, MSG_BRW_LAST_CHILD, avp);

    /* Origin-Host / Origin-Realm (from our own peer identity) */
    ret = fd_msg_add_origin(req, 0);
    if (ret != 0) { snprintf(out->message, sizeof(out->message), "fd_msg_add_origin failed: %d", ret); return -1; }

    /* Destination-Realm */
    ret = fd_msg_avp_new(ogs_diam_destination_realm, 0, &avp);
    if (ret != 0) return -1;
    val.os.data = (uint8_t *)dest_realm;
    val.os.len = strlen(dest_realm);
    fd_msg_avp_setvalue(avp, &val);
    fd_msg_avp_add(req, MSG_BRW_LAST_CHILD, avp);

    /* Destination-Host */
    ret = fd_msg_avp_new(ogs_diam_destination_host, 0, &avp);
    if (ret != 0) return -1;
    val.os.data = (uint8_t *)dest_host;
    val.os.len = strlen(dest_host);
    fd_msg_avp_setvalue(avp, &val);
    fd_msg_avp_add(req, MSG_BRW_LAST_CHILD, avp);

    /* User-Name (IMSI, ASCII digits) — this is what MME's mme_ue_find_by_imsi_bcd
     * looks up to find the target UE context (mme-s6a-handler.c / mme-fd-path.c). */
    ret = fd_msg_avp_new(ogs_diam_user_name, 0, &avp);
    if (ret != 0) return -1;
    val.os.data = (uint8_t *)imsi_bcd;
    val.os.len = strlen(imsi_bcd);
    fd_msg_avp_setvalue(avp, &val);
    fd_msg_avp_add(req, MSG_BRW_LAST_CHILD, avp);

    /* Cancellation-Type = SUBSCRIPTION_WITHDRAWAL (2) — see file header. */
    ret = fd_msg_avp_new(ogs_diam_s6a_cancellation_type, 0, &avp);
    if (ret != 0) return -1;
    val.i32 = 2; /* OGS_DIAM_S6A_CT_SUBSCRIPTION_WITHDRAWAL */
    fd_msg_avp_setvalue(avp, &val);
    fd_msg_avp_add(req, MSG_BRW_LAST_CHILD, avp);

    /* Vendor-Specific-Application-Id */
    ret = ogs_diam_message_vendor_specific_appid_set(req, OGS_DIAM_S6A_APPLICATION_ID);
    if (ret != 0) { snprintf(out->message, sizeof(out->message), "vendor_specific_appid_set failed: %d", ret); return -1; }

    pthread_mutex_lock(&g_clr_mutex);
    g_pending = out;
    g_pending_done = 0;
    pthread_mutex_unlock(&g_clr_mutex);

    ret = fd_msg_send(&req, clr_answer_cb, out);
    if (ret != 0) {
        snprintf(out->message, sizeof(out->message), "fd_msg_send failed: %d", ret);
        return -1;
    }

    struct timespec deadline;
    clock_gettime(CLOCK_REALTIME, &deadline);
    deadline.tv_sec += timeout_sec;

    pthread_mutex_lock(&g_clr_mutex);
    while (!g_pending_done) {
        ret = pthread_cond_timedwait(&g_clr_cond, &g_clr_mutex, &deadline);
        if (ret == ETIMEDOUT) {
            out->timed_out = 1;
            snprintf(out->message, sizeof(out->message),
                "timed out waiting for Cancel-Location-Answer");
            break;
        }
    }
    g_pending = NULL;
    pthread_mutex_unlock(&g_clr_mutex);

    return 0;
}

void shim_final(void)
{
    if (!g_initialized) return;
    if (g_sess_hdl) fd_sess_handler_destroy(&g_sess_hdl, NULL);
    ogs_diam_final();
    g_initialized = 0;
}
