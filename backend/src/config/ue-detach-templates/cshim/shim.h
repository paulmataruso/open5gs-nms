#ifndef UE_DETACH_SHIM_H
#define UE_DETACH_SHIM_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    int completed;                      /* 1 once a real CLA (or timeout) was observed */
    int timed_out;                      /* 1 if no CLA arrived within the deadline */
    int success;                        /* 1 if Result-Code == DIAMETER_SUCCESS (2001) */
    uint32_t result_code;               /* raw Result-Code, 0 if absent */
    int has_experimental;
    uint32_t experimental_result_code;  /* raw Experimental-Result-Code, e.g. 5001 USER_UNKNOWN */
    char message[256];
} shim_clr_result_t;

/* Brings up Open5GS's core + diameter-common + s6a subsystems and connects
 * to the target MME as a Diameter peer. Call once per process. Blocks
 * briefly while freeDiameter's own threads start; returns 0 on success. */
int shim_init(const char *identity, const char *realm, const char *local_addr,
              const char *mme_identity, const char *mme_addr, int mme_port);

/* Sends a real Cancel-Location-Request (Cancellation-Type=SUBSCRIPTION_WITHDRAWAL)
 * for imsi_bcd to the connected MME and blocks until the Cancel-Location-Answer
 * arrives or timeout_sec elapses. Safe to call multiple times on the same
 * initialized peer connection.
 *
 * clr_flags goes into the CLR-Flags AVP and decides what the MME tells the UE
 * in its NAS Detach Request. It is a per-CALL argument, not a build-time
 * constant, because the two callers want opposite things from the same message
 * (see shim.c's file header):
 *
 *   0                                        -> "re-attach not required" (Block)
 *   OGS_DIAM_S6A_CLR_FLAGS_REATTACH_REQUIRED -> "re-attach required"     (Bounce)
 *
 * Passing 0 omits the AVP entirely, which is byte-for-byte what this tool sent
 * before the flag existed — so Block's wire format is unchanged. */
int shim_send_clr(const char *imsi_bcd, const char *dest_realm,
                   const char *dest_host, int timeout_sec, int clr_flags,
                   shim_clr_result_t *out);

void shim_final(void);

#ifdef __cplusplus
}
#endif

#endif /* UE_DETACH_SHIM_H */
