import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// Same shape as osmo-msc-build.ts / osmo-sip-connector-build.ts. Quick one-off
// host commands; the multi-minute build itself runs as a detached streamed
// script (see ims-controller.ts's /install), not through this.
export const nsenter = async (
  cmd: string,
  args: string[] = [],
  timeoutMs = 20000,
): Promise<{ stdout: string; stderr: string }> =>
  execFileAsync('nsenter', ['-t', '1', '-m', '-u', '-i', '-p', cmd, ...args], {
    timeout: timeoutMs,
    encoding: 'utf-8',
    env: { ...process.env, DBUS_SYSTEM_BUS_ADDRESS: 'unix:path=/var/run/dbus/system_bus_socket' },
  });

export const BUILD_WORKDIR = '/opt/kamailio-ims-modules-build';
export const MODULES_DIR = '/usr/lib/x86_64-linux-gnu/kamailio/modules';

// Bump whenever a patch below is added/changed.
export const PATCH_REV = 2;

// Unique string only present once a file has been patched — used both as the
// source-level idempotency check (grepped against the .c file mid-build,
// before compilation strips it) and to tell "already applied" apart from a
// real patch failure, since `patch`'s own exit code conflates the two.
// Deliberately NOT checked against the compiled .so at the top-level
// short-circuit below — comments don't survive compilation, so grepping the
// binary for this string can never match; the top-level skip instead relies
// on the .apt-original + patch-rev markers, which do reflect binary state.
export const CMD_C_MARKER = 'NMS patch, confirmed live 2026-09-12 against a real iOS UE';
export const SAVE_C_MARKER = 'same fallback shape as';
export const CCR_C_MARKER = 'NMS patch, confirmed live 2026-09-17 against a real SigScale OCS';
export const ROC_C_MARKER = 'this deployment\'s own';
export const CDP_COMMON_C_MARKER = 'NMS patch 2026-10-01';
export const CDP_ACCTSM_C_MARKER = 'NMS patch 2026-10-01';
export const SECVERIFY_C_MARKER = 'IPSEC_FORWARD_ADD_SECVERIFY';
export const CDP_MOD_C_MARKER = 'NMS patch: cdp process slot';

/**
 * Revision of the C-source patch SET that the Kamailio 6.0.8 source build
 * applies. **Bump this whenever a patch is added, removed or materially
 * changed** — it is what tells a deployment its installed build predates the
 * current patches.
 *
 * Why a recorded revision rather than inspecting the built `.so`: every one of
 * these patches is identified in source by a C *comment* marker, and comments
 * do not survive compilation into the binary's string table, so `strings` can
 * never find them. (That exact mistake is already documented on
 * verifyKamailioImsModulesPatch(), which silently always returned false for
 * years because of it.) Some patches change nothing observable about the file
 * either — CDP_MOD_C_PATCH only edits two integer literals, so it shifts
 * neither the size nor any symbol. Recording the rev at build time is the only
 * reliable signal, and it is the same idiom vowifi-build.ts
 * (VECTORCORE_PATCH_REV) and secgw-build.ts (SECGW_PATCH_REV) already use.
 *
 * rev 1 — the original 7: CMD_C_PATCH_KAMAILIO6, SAVE_C_PATCH, CCR_C_PATCH,
 *         IMS_RO_C_PATCH, CDP_COMMON_C_PATCH, CDP_ACCTSM_C_PATCH,
 *         SECVERIFY_C_PATCH.
 * rev 2 — adds CDP_MOD_C_PATCH (the cdp process-slot fix, which had been lost
 *         entirely: applied by hand 2026-08-02, then silently dropped by the
 *         2026-10-03 rebuild, with a stale marker file making IMS Install skip
 *         it forever).
 */
export const KAMAILIO_PATCH_REV = 2;

// Real bug, fixed live 2026-08-02 and nearly lost again 2026-10-03: stock
// cdp_mod.c registers one fewer process slot than the module actually forks
// (`2 + workers + 2*peers`, when the timer process is a third fixed one on top
// of the two accounted for), so cdp's own timer fails to start with "Process
// limit exceeded" -- which takes out Cx/Rx Diameter, i.e. every HSS and PCRF
// interaction P/I/S-CSCF make, under load.
//
// This lived ONLY as an inline `sed` inside ims-controller.ts's Install step,
// guarded by a bare `cdp.so.patched` marker file. That combination lost the fix
// silently and completely: the Kamailio 6.0.8 source build's own `make install`
// replaced cdp.so (2026-10-03) with a build carrying CDP_COMMON_C_PATCH and
// CDP_ACCTSM_C_PATCH but NOT this one, while the Aug-2 marker file stayed
// behind -- so Install's own `[ -f "$MARKER" ] && exit 0` guaranteed it would
// never be reapplied either. Exactly the "fixing the build script doesn't
// retroactively patch an already-built module" class CLAUDE.md documents, with
// a stale marker making it permanent rather than merely stale.
//
// It is a real patch constant now so the 6.0.8 pipeline applies it like every
// other one, and Install's marker is content-hashed rather than presence-only.
// Confirmed byte-identical applicability against all three source trees on this
// host (5.8.8+ubuntu24.04, the ims-modules tree, and the 6.0.8 tree).
export const CDP_MOD_C_PATCH = String.raw`--- a/src/modules/cdp/cdp_mod.c
+++ b/src/modules/cdp/cdp_mod.c
@@ -258,8 +258,12 @@
 	}
 #endif
 
-	register_procs(2 + config->workers + 2 * config->peers_cnt);
-	cfg_register_child(2 + config->workers + 2 * config->peers_cnt);
+	/* NMS patch: cdp process slot -- cdp forks a third fixed process (the
+	 * timer) beyond the two counted here, so the stock count is one short and
+	 * the timer dies with "Process limit exceeded", taking Cx/Rx Diameter with
+	 * it under load. */
+	register_procs(3 + config->workers + 2 * config->peers_cnt);
+	cfg_register_child(3 + config->workers + 2 * config->peers_cnt);
 	return 0;
 }
 
`;

// Real bug, root-caused and fixed live 2026-09-12 against the stock (unmodified)
// ims_ipsec_pcscf Kamailio module (kamailio-ims-modules package, NOT this
// project's own code): P-CSCF failed fresh, server-initiated deliveries to a
// UE's real IPsec tunnel with "No security parameters found in contact",
// because ipsec_create() unconditionally hard-failed whenever
// pcontact->security_temp was NULL -- which is the NORMAL state for a contact
// record keyed by a UE's newly-negotiated protected port on its first
// successful registration (the 401 challenge's own ipsec_create() call
// populated security_temp on a DIFFERENT contact record, keyed by the UE's
// original unprotected port -- nothing links the two). A second, independent
// bug in the same function (found later the same night, chasing a full
// "IMS-to-IMS calling is broken" regression): fill_contact() never sets
// ci.reg_state, and ims_usrloc_pcscf/udomain.c's update_pcontact() does an
// unconditional `_c->reg_state = _ci->reg_state` (no preserve-if-unset guard,
// unlike expires) -- so ipsec_create(), which fires on every REGISTER
// challenge/re-auth cycle, silently stomped reg_state back to 0 moments after
// it was correctly promoted elsewhere, on every single UE, not just 2G-interop
// ones. See CMD_C_PATCH's own inline comments (preserved from the original
// live patch) for the full mechanism. Full incident writeup: PROJECT_STATE.md,
// Handoff Summary entries for 2026-09-11/12, and memory
// gsm_2g_osmocom_module_progress.md.
export const CMD_C_PATCH = String.raw`--- a/src/modules/ims_ipsec_pcscf/cmd.c
+++ b/src/modules/ims_ipsec_pcscf/cmd.c
@@ -837,13 +837,23 @@
 		goto cleanup;
 	}

-	// Get security parameters
-	if(pcontact->security_temp == NULL) {
-		LM_ERR("No security parameters found in contact\n");
-		goto cleanup;
-	}
-
-	if(pcontact->security_temp->type != SECURITY_IPSEC) {
+	// NMS patch, confirmed live 2026-09-12 against a real iOS UE: this used
+	// to hard-fail here unconditionally whenever security_temp was NULL --
+	// but that's the normal, expected state for a contact record keyed by a
+	// UE's newly-negotiated protected port on its very first successful
+	// registration (as opposed to a later refresh): the 401 challenge's own
+	// ipsec_create() call populated security_temp on a DIFFERENT contact
+	// record (keyed by the UE's original, unprotected port), and nothing
+	// ever links the two. The "re-registration" branch below already
+	// doesn't actually need security_temp -- it derives everything from
+	// req_sec_params (parsed fresh from the current REGISTER request) and
+	// only *optionally* touches security_temp for old_s, already guarded by
+	// a NULL check. So: stop hard-failing here: only fail where
+	// security_temp is actually dereferenced without a request-derived
+	// fallback available, exactly at that point below instead of
+	// pre-emptively here.
+	if(pcontact->security_temp != NULL
+			&& pcontact->security_temp->type != SECURITY_IPSEC) {
 		LM_ERR("Unsupported security type: %d\n",
 				pcontact->security_temp->type);
 		goto cleanup;
@@ -864,7 +874,8 @@

 	// Update contacts only for initial registration, for re-registration the existing contacts shouldn't be updated.
 	if(ci.via_port == SIP_PORT
-			|| (pcontact->security_temp->data.ipsec->port_ps == 0
+			|| (pcontact->security_temp != NULL
+					&& pcontact->security_temp->data.ipsec->port_ps == 0
 					&& pcontact->security_temp->data.ipsec->port_pc == 0)) {
 		LM_DBG("Registration for contact with AOR [%.*s], VIA [%d://%.*s:%d], "
 			   "received_host [%d://%.*s:%d]\n",
@@ -872,10 +883,20 @@
 				ci.via_host.s, ci.via_port, ci.received_proto,
 				ci.received_host.len, ci.received_host.s, ci.received_port);

-		if(req_sec_params == NULL)
+		if(req_sec_params == NULL) {
+			// NMS patch: previously an unconditional (and, per the removed
+			// check above, now possibly NULL) dereference -- guard it
+			// explicitly instead of relying on the check that used to sit
+			// above this whole if/else.
+			if(pcontact->security_temp == NULL) {
+				LM_ERR("No security parameters found in contact or "
+					   "request\n");
+				goto cleanup;
+			}
 			s = pcontact->security_temp->data.ipsec;
-		else
+		} else {
 			s = req_sec_params->data.ipsec;
+		}
 	} else {
 		LM_DBG("RE-Registration for contact with AOR [%.*s], VIA "
 			   "[%d://%.*s:%d], received_host [%d://%.*s:%d]\n",
@@ -917,6 +938,17 @@
 		}
 	}

+	// NMS patch, confirmed live 2026-09-12: fill_contact() never sets
+	// ci.reg_state, and update_pcontact() (ims_usrloc_pcscf/udomain.c)
+	// unconditionally does "_c->reg_state = _ci->reg_state" with no
+	// preserve-if-unset guard (unlike expires, which it only overwrites
+	// when > 0). Left as-is, this call -- which fires on every REGISTER's
+	// 401/challenge processing, including refresh cycles well after the
+	// contact was already promoted to PCONTACT_REGISTERED -- silently
+	// stomps reg_state back to 0 (PCONTACT_ANY). Since ipsec_create() has
+	// no business changing registration state at all, preserve whatever
+	// the contact already had.
+	ci.reg_state = pcontact->reg_state;
 	if(ul.update_pcontact(d, &ci, pcontact) != 0) {
 		LM_ERR("Error updating contact\n");
 		goto cleanup;
`;

// Kamailio 6.x-scoped variant of CMD_C_PATCH above, used by
// kamailio-source-build.ts (the 6.0.8 git-source build), NOT kamailio-ims-modules-build.ts
// itself. Confirmed live 2026-09-29: Kamailio's own upstream already fixed the second bug
// CMD_C_PATCH fixes (the reg_state stomp, hunk 4 above -- `ci.reg_state =
// pcontact->reg_state;` already exists verbatim in a pristine, unmodified 6.0.8 checkout,
// at the exact same semantic location) somewhere between 5.8.8 and 6.0.8 -- applying
// CMD_C_PATCH unmodified against 6.0.8 still "succeeds" via patch's fuzz-2 leniency, but
// silently produces a REAL duplicate-assignment bug (confirmed live: two consecutive
// `ci.reg_state = pcontact->reg_state;` lines), not just a cosmetic/harmless no-op. The
// first bug (the ipsec_create() unconditional hard-fail on NULL security_temp, hunks 1-3)
// is still genuinely present in 6.0.8 -- confirmed via a real `patch --fuzz=0` dry-run,
// those three hunks apply with only line-offset, no fuzz, meaning the surrounding code is
// byte-identical to 5.8.8 there. So: same fix, hunk 4 dropped for this target only.
export const CMD_C_PATCH_KAMAILIO6 = String.raw`--- a/src/modules/ims_ipsec_pcscf/cmd.c
+++ b/src/modules/ims_ipsec_pcscf/cmd.c
@@ -841,13 +841,23 @@
 		goto cleanup;
 	}
 
-	// Get security parameters
-	if(pcontact->security_temp == NULL) {
-		LM_ERR("No security parameters found in contact\n");
-		goto cleanup;
-	}
-
-	if(pcontact->security_temp->type != SECURITY_IPSEC) {
+	// NMS patch, confirmed live 2026-09-12 against a real iOS UE: this used
+	// to hard-fail here unconditionally whenever security_temp was NULL --
+	// but that's the normal, expected state for a contact record keyed by a
+	// UE's newly-negotiated protected port on its very first successful
+	// registration (as opposed to a later refresh): the 401 challenge's own
+	// ipsec_create() call populated security_temp on a DIFFERENT contact
+	// record (keyed by the UE's original, unprotected port), and nothing
+	// ever links the two. The "re-registration" branch below already
+	// doesn't actually need security_temp -- it derives everything from
+	// req_sec_params (parsed fresh from the current REGISTER request) and
+	// only *optionally* touches security_temp for old_s, already guarded by
+	// a NULL check. So: stop hard-failing here: only fail where
+	// security_temp is actually dereferenced without a request-derived
+	// fallback available, exactly at that point below instead of
+	// pre-emptively here.
+	if(pcontact->security_temp != NULL
+			&& pcontact->security_temp->type != SECURITY_IPSEC) {
 		LM_ERR("Unsupported security type: %d\n",
 				pcontact->security_temp->type);
 		goto cleanup;
@@ -868,7 +878,8 @@
 
 	// Update contacts only for initial registration, for re-registration the existing contacts shouldn't be updated.
 	if(ci.via_port == SIP_PORT
-			|| (pcontact->security_temp->data.ipsec->port_ps == 0
+			|| (pcontact->security_temp != NULL
+					&& pcontact->security_temp->data.ipsec->port_ps == 0
 					&& pcontact->security_temp->data.ipsec->port_pc == 0)) {
 		LM_DBG("Registration for contact with AOR [%.*s], VIA [%d://%.*s:%d], "
 			   "received_host [%d://%.*s:%d]\n",
@@ -876,10 +887,20 @@
 				ci.via_host.s, ci.via_port, ci.received_proto,
 				ci.received_host.len, ci.received_host.s, ci.received_port);
 
-		if(req_sec_params == NULL)
+		if(req_sec_params == NULL) {
+			// NMS patch: previously an unconditional (and, per the removed
+			// check above, now possibly NULL) dereference -- guard it
+			// explicitly instead of relying on the check that used to sit
+			// above this whole if/else.
+			if(pcontact->security_temp == NULL) {
+				LM_ERR("No security parameters found in contact or "
+					   "request\n");
+				goto cleanup;
+			}
 			s = pcontact->security_temp->data.ipsec;
-		else
+		} else {
 			s = req_sec_params->data.ipsec;
+		}
 	} else {
 		LM_DBG("RE-Registration for contact with AOR [%.*s], VIA "
 			   "[%d://%.*s:%d], received_host [%d://%.*s:%d]\n",
`;

// Real bug, root-caused and fixed live 2026-09-12 in the stock (unmodified)
// ims_registrar_pcscf Kamailio module: save.c's update_contacts() (fired on
// the authenticated REGISTER's 200 OK, the only place that promotes a contact
// to PCONTACT_REGISTERED) looked up the existing pending contact by the
// request's real received port -- but that 200 OK arrives over the UE's
// newly-established IPsec tunnel, on a different port than the original,
// unprotected REGISTER that created the pending row. The lookup missed, so
// the promotion silently never ran, which left every affected UE's
// reg_state stuck at 0 forever -- confirmed as the actual root cause of both
// a 2G-interop-specific report ("04 to 02 doesn't work") and a completely
// separate, general regression report ("IMS to IMS is not working"), since
// ims_usrloc_pcscf's get_pcontact_from_cache() does a strict reg_state match
// that silently treats a real, fully-matching contact as "not found" when
// its reg_state is wrong. Fixed with a via-URI-based fallback search before
// giving up -- same shape as this same module's own getContactP() /
// is_registered_fallback2ip.
// Verified live 2026-09-29 with a real `patch -p1 --forward --batch --fuzz=0` dry-run
// (this constant already applied cleanly even before this note -- regenerated via a real
// diff -u for the same blank-context-line robustness as CCR_C_PATCH/IMS_RO_C_PATCH below,
// not because this one was ever observed to fail). Also confirmed to apply unmodified
// against a pristine Kamailio 6.0.8 tree -- unlike CMD_C_PATCH, save.c has no 6.x-specific
// variant.
export const SAVE_C_PATCH = String.raw`--- a/src/modules/ims_registrar_pcscf/save.c
+++ b/src/modules/ims_registrar_pcscf/save.c
@@ -254,19 +254,38 @@
 				}
 
 				ul.lock_udomain(_d, &puri.host, port, puri.proto);
-				if(ul.get_pcontact(_d, &ci, &pcontact, 0)
-						!= 0) { //need to insert new contact
-					if((expires - local_time_now)
-							<= 0) { //remove contact - de-register
-						LM_DBG("This is a de-registration for contact <%.*s> "
-							   "but contact is not in usrloc - ignore\n",
-								c->uri.len, c->uri.s);
+				if(ul.get_pcontact(_d, &ci, &pcontact, 0) != 0) {
+					/* Not found via received-port match: the real received
+					 * port can differ from the pending contact's (recorded
+					 * before IPsec was established, eg on the initial
+					 * unprotected REGISTER) once the authenticated REGISTER
+					 * arrives over the newly-established protected tunnel on
+					 * a different port. Retry matching on the Contact URI
+					 * itself (via_host/via_port), which stays stable across
+					 * that port change - same fallback shape as
+					 * getContactP()'s is_registered_fallback2ip. */
+					int found_via_fallback;
+					ci.searchflag = SEARCH_NORMAL;
+					found_via_fallback =
+							(ul.get_pcontact(_d, &ci, &pcontact, 0) == 0);
+					ci.searchflag = SEARCH_RECEIVED;
+					if(!found_via_fallback) { //need to insert new contact
+						if((expires - local_time_now)
+								<= 0) { //remove contact - de-register
+							LM_DBG("This is a de-registration for contact <%.*s> "
+								   "but contact is not in usrloc - ignore\n",
+									c->uri.len, c->uri.s);
+							goto next_contact;
+						}
+						LM_DBG("We don't add contact from the 200OK that did not "
+							   "go through us (ie, not present in explicit "
+							   "REGISTER that went through us\n");
 						goto next_contact;
 					}
-					LM_DBG("We don't add contact from the 200OK that did not "
-						   "go through us (ie, not present in explicit "
-						   "REGISTER that went through us\n");
-				} else { //contact already exists - update
+					LM_DBG("contact found via via-based fallback search "
+						   "(received port changed since pending REGISTER)\n");
+				}
+				{ //contact already exists - update
 					LM_DBG("contact already exists and is in state (%d) : "
 						   "[%s]\n",
 							pcontact->reg_state,
`;

// Four real bugs, all in the stock (unmodified) ims_charging Kamailio module
// (kamailio-ims-modules package), root-caused and fixed live 2026-09-17 while
// wiring the first-ever Diameter Ro (voice/airtime charging) connection this
// deployment has made -- the module has shipped compiled and loaded since
// this project's own IMS install existed, but nothing ever actually
// exercised its CCR-building code path until tonight (WITH_RO stayed
// dormant behind an #!ifdef the whole time, see CLAUDE.md architectural
// pattern #13's Rx interface for the same "built, left disabled" shape).
// Each bug produced a real, reproduced rejection from a real SigScale OCS
// (Erlang/OTP, strict dictionary-based Diameter decoding) -- confirmed via
// OCS's own erlang.log, not guessed, before being patched:
//   1. Ro_write_CCR_avps() (ccr.c) manually re-added Origin-Host/
//      Origin-Realm AVPs that cdp's own AAANewMessage() (called via
//      AAACreateRequest() inside Ro_new_ccr()) already unconditionally adds
//      from the peer's own configured DiameterPeer identity -- OCS rejected
//      every CCR outright with "DIAMETER AVP too many times" (result 5009).
//      This one was config-triggered (the origin_host/origin_realm
//      modparams in kamailio_scscf.cfg's own #!ifdef WITH_RO block set the
//      values Ro_write_CCR_avps() then duplicated) -- see that template's
//      own comment for the matching config-side half of this fix; the
//      modparams are now left unset there since this module already covers
//      the identity via cdp automatically.
//   2. The same function unconditionally added Accounting-Record-Type/
//      Number AVPs to every CCR -- those belong to the Diameter Base
//      Accounting application (RFC 6733 section 9), not Credit-Control (RFC
//      4006); a real CCR has no defined slot for them. OCS rejected with
//      "DIAMETER AVP unsupported" (result 5001).
//   3. No CCR ever carried a standalone top-level Auth-Application-Id AVP,
//      which RFC 4006 section 3.1 requires -- only a copy nested inside
//      Vendor-Specific-Application-Id (Ro_add_vendor_specific_appid(), see
//      bug 4). OCS flagged the missing top-level AVP explicitly (result
//      5005, DIAMETER_MISSING_AVP).
//   4. Every CCR also carried a Vendor-Specific-Application-Id AVP
//      (Ro_add_vendor_specific_appid(), ims_ro.c, three call sites) -- that
//      AVP has no defined slot in RFC 4006's CCR either; it belongs to
//      CER/CEA capability negotiation, already completed once the peer
//      connection is open. OCS rejected with "DIAMETER AVP unsupported"
//      (result 5001) same as bug 2.
//   5. format_subscription_id() (ims_ro.c) only ever recognized a tel: URI
//      as an MSISDN identity -- this deployment's own P-Asserted-Identity is
//      a sip:<msisdn>@domain URI, which fell through to the generic
//      Subscription_Type_IMPU (SIP-URI) branch. OCS's own subscriber lookup
//      (subscriber_id/3) only checks MSISDN/IMSI Subscription-Id types by
//      default, and this deployment's OCS subscriber records are keyed by
//      bare MSISDN, not a full SIP URI string -- every CCR was rejected
//      DIAMETER_USER_UNKNOWN (result 5030) even for a correctly-provisioned
//      subscriber. Fixed by extracting the digit-only user part of a sip:
//      URI the same way a tel: URI's digits already are, falling back to
//      the original IMPU default for anything that isn't purely digits.
// Confirmed working end-to-end after all five fixes: a real test call's Ro
// result code was 2001 (DIAMETER_SUCCESS) with a real 60-second credit
// reservation granted, a clean CCA on CCR-Terminate, and -- verified
// directly against OCS's own Mnesia bucket record, not just the CCA -- a
// real 5-second debit against the subscriber's granted allowance.
// Verified live 2026-09-29 with a real `patch -p1 --forward --batch --fuzz=0` dry-run
// against a freshly cloned, unmodified Kamailio 6.0.8 tree (same file/line-numbers as
// 5.8.8 here -- this module's ccr.c was untouched upstream between versions) -- also
// reused as-is by kamailio-source-build.ts for the 6.x build path. Kept in this exact
// diff -u-produced form (blank context lines are a single space + newline, not empty --
// a previous hand-rolled version of this constant used empty context lines, which only
// ever applied via patch's fuzz-2 leniency, confirmed live to fail at --fuzz=0).
export const CCR_C_PATCH = String.raw`--- a/src/modules/ims_charging/ccr.c
+++ b/src/modules/ims_charging/ccr.c
@@ -277,11 +277,32 @@ AAAMessage *Ro_write_CCR_avps(AAAMessage *ccr, Ro_CCR_t *x)
 			goto error;
 	}
 
-	if(!cdp_avp->base.add_Accounting_Record_Type(
-			   &(ccr->avpList), x->acct_record_type))
-		goto error;
-	if(!cdp_avp->base.add_Accounting_Record_Number(
-			   &(ccr->avpList), x->acct_record_number))
+	/* NMS patch, confirmed live 2026-09-17 against a real SigScale OCS: this
+	 * used to unconditionally add Accounting-Record-Type/Number to every
+	 * CCR. Those two AVPs belong to the Diameter Base Accounting
+	 * application (RFC 6733 section 9), not Credit-Control (RFC 4006) -- a
+	 * real CCR has no defined slot for them. OCS's own diameter stack
+	 * (Erlang/OTP, strict dictionary-based decoding) rejected every CCR
+	 * outright with "DIAMETER AVP unsupported" (result 5001) once Ro was
+	 * actually exercised for the first time in this deployment's history --
+	 * a real freeDiameter-based peer may silently tolerate/ignore them, but
+	 * OCS does not. Removed rather than left conditional: nothing in this
+	 * module's own CCR construction is a real Diameter Accounting message,
+	 * so these never belonged here regardless of peer.
+	 */
+
+	/* NMS patch, confirmed live 2026-09-17: RFC 4006 section 3.1 requires a
+	 * standalone top-level Auth-Application-Id AVP on every CCR -- this
+	 * module only ever added one NESTED inside Vendor-Specific-Application-Id
+	 * (see Ro_add_vendor_specific_appid() in ims_ro.c), never a top-level
+	 * one. OCS's own diameter stack flagged the missing top-level AVP
+	 * explicitly (result 5005, DIAMETER_MISSING_AVP). IMS_Ro is the same
+	 * Application-Id constant Ro_new_ccr() already passes to
+	 * AAACreateRequest() and Ro_add_vendor_specific_appid() already uses for
+	 * the nested copy -- reusing it here rather than a separate magic number
+	 * keeps both copies guaranteed identical.
+	 */
+	if(!cdp_avp->base.add_Auth_Application_Id(&(ccr->avpList), IMS_Ro))
 		goto error;
 
 	if(x->user_name)
`;

// Verified live 2026-09-29 with a real `patch -p1 --forward --batch --fuzz=0` dry-run
// against a freshly cloned, unmodified Kamailio 6.0.8 tree (same file/line-numbers as
// 5.8.8 here -- this module's ims_ro.c was untouched upstream between versions) -- also
// reused as-is by kamailio-source-build.ts for the 6.x build path. Same diff -u-produced
// blank-context-line fix as CCR_C_PATCH above.
export const IMS_RO_C_PATCH = String.raw`--- a/src/modules/ims_charging/ims_ro.c
+++ b/src/modules/ims_charging/ims_ro.c
@@ -158,6 +158,39 @@ static void format_subscription_id(
 			subscription_id->s += 1;
 			subscription_id->len -= 1;
 		}
+	} else if(strncasecmp(subscription_id->s, "sip:", 4) == 0) {
+		/* NMS patch, confirmed live 2026-09-17: this deployment's own
+		 * P-Asserted-Identity is a sip:<msisdn>@domain URI, not a tel: URI
+		 * -- the stock code fell through to the generic Subscription_Type_
+		 * IMPU (SIP-URI) branch below unconditionally, but OCS's own
+		 * subscriber lookup (subscriber_id/3) only checks MSISDN/IMSI
+		 * Subscription-Id types by default, and this deployment's OCS
+		 * subscriber records are keyed by bare MSISDN, not a full SIP URI
+		 * string -- every CCR was rejected DIAMETER_USER_UNKNOWN (5030)
+		 * even for a correctly-provisioned subscriber. If the SIP URI's
+		 * user part is purely digits (the normal shape for a real phone
+		 * number, as opposed to a named/alphanumeric SIP identity), treat
+		 * it the same way a tel: URI already is -- extract just the digits
+		 * and mark it MSISDN type. Anything that doesn't look like a phone
+		 * number falls through to the original default unchanged.
+		 */
+		str user = {subscription_id->s + 4, subscription_id->len - 4};
+		char *at = memchr(user.s, '@', user.len);
+		int userlen = at ? (int)(at - user.s) : user.len;
+		int i, all_digits = userlen > 0;
+		for(i = 0; i < userlen; i++) {
+			if(user.s[i] < '0' || user.s[i] > '9') {
+				all_digits = 0;
+				break;
+			}
+		}
+		if(all_digits) {
+			*subscription_id_type = Subscription_Type_MSISDN;
+			subscription_id->s = user.s;
+			subscription_id->len = userlen;
+		} else {
+			*subscription_id_type = Subscription_Type_IMPU;
+		}
 	} else {
 		*subscription_id_type =
 				Subscription_Type_IMPU; //default is END_USER_SIP_URI
@@ -806,10 +839,13 @@ void send_ccr_interim(
 	if(!(ccr = Ro_new_ccr(auth, ro_ccr_data)))
 		goto error;
 
-	if(!Ro_add_vendor_specific_appid(
-			   ccr, IMS_vendor_id_3GPP, IMS_Ro, 0 /*acct id*/)) {
-		LM_ERR("Problem adding Vendor specific ID\n");
-	}
+	/* NMS patch, confirmed live 2026-09-17: Vendor-Specific-Application-Id
+	 * has no defined slot in RFC 4006's CCR command (it belongs to CER/CEA
+	 * capability negotiation, already completed once the peer connection is
+	 * open) -- OCS's own diameter stack rejected every CCR carrying it with
+	 * "DIAMETER AVP unsupported" (result 5001). See Ro_write_CCR_avps()'s
+	 * own patch comment (ccr.c) for the two sibling AVPs fixed the same way.
+	 */
 	ro_session->hop_by_hop += 1;
 	if(!Ro_add_cc_request(ccr, RO_CC_INTERIM, ro_session->hop_by_hop)) {
 		LM_ERR("Problem adding CC-Request data\n");
@@ -1131,9 +1167,9 @@ void send_ccr_stop_with_param(
 
 	LM_DBG("Created new CCR\n");
 
-	if(!Ro_add_vendor_specific_appid(ccr, IMS_vendor_id_3GPP, IMS_Ro, 0)) {
-		LM_ERR("Problem adding Vendor specific ID\n");
-	}
+	/* NMS patch, confirmed live 2026-09-17 -- see the sibling call site
+	 * above and Ro_write_CCR_avps()'s own patch comment (ccr.c).
+	 */
 
 	ro_session->hop_by_hop += 1;
 	if(!Ro_add_cc_request(ccr, RO_CC_STOP, ro_session->hop_by_hop)) {
@@ -1449,10 +1485,9 @@ int Ro_Send_CCR(struct sip_msg *msg, struct dlg_cell *dlg, int dir,
 	if(!(ccr = Ro_new_ccr(cc_acc_session, ro_ccr_data)))
 		goto error;
 
-	if(!Ro_add_vendor_specific_appid(ccr, IMS_vendor_id_3GPP, IMS_Ro, 0)) {
-		LM_ERR("Problem adding Vendor specific ID\n");
-		goto error;
-	}
+	/* NMS patch, confirmed live 2026-09-17 -- see the sibling call sites
+	 * above and Ro_write_CCR_avps()'s own patch comment (ccr.c).
+	 */

 	if(!Ro_add_cc_request(ccr, cc_event_type, cc_event_number)) {
 		LM_ERR("Problem adding CC-Request data\n");
`;

// Real bug found live 2026-10-01, a direct SIDE EFFECT of CCR_C_PATCH above (not a
// separate, unrelated regression): removing Accounting-Record-Type/Number from every
// CCR -- correct, since OCS's strict decoder rejects them -- means cdp's own GENERIC
// "cc_acc" (Credit-Control Accounting client) session state machine, which `ims_charging`
// uses for every Ro session (AAACreateCCAccSession() in ims_ro.c), can no longer tell
// what kind of CCR is being sent: cc_acc_client_stateful_sm_process() (cdp's own
// acctstatemachine.c, confirmed byte-identical between the original 5.8.8 tree and this
// 6.0.8 one -- this has always been cdp's behavior, not a 6.0.8 regression) reads
// Accounting-Record-Type specifically to decide START vs UPDATE vs TERMINATE, and with
// it gone, every CCR falls through to a `default:` branch logging "Sending CCR with
// no/incorrect accounting record type AVP" and never advances the session out of
// ACC_CC_ST_IDLE. Confirmed via full source trace (and an isolated scratch-copy
// compile/link of a patched `cdp` module in full, zero warnings/errors) that this does
// NOT block the CCR-Initial from transmitting at all (nothing on the send path actually
// checks this session state) -- but it DOES permanently block
// ims_charging/ims_ro.c's send_ccr_interim(), which explicitly requires
// state == ACC_CC_ST_OPEN before sending a mid-call CCR-Update, a state this session can
// now never reach. Net effect: once a call's initial Ro reservation window elapses
// (interim_update_credits=30 in this deployment's kamailio_scscf.cfg; OCS has been
// observed granting 60s regardless of the 30s requested, with the renewal timer armed at
// granted-minus-buffer, so in practice this needs a call longer than ~55s to surface),
// the renewal CCR-Update silently never fires and the call's own timer is abandoned
// rather than ever being correctly renewed or the dialog explicitly torn down -- a
// billing-continuity gap (the call keeps running, OCS never meters/bills any time spent
// beyond the first reservation), not a dropped-call symptom. Confirmed via this
// deployment's own OCS accounting log: across 117 historical real Ro-voice sessions,
// zero ever contain a CC-Request-Type=2 (interim) record.
//
// Fix: cdp itself gets a new, narrowly-scoped fallback -- when Accounting-Record-Type is
// entirely absent (the exact condition CCR_C_PATCH produces), re-derive the same
// "what kind of CCR is this" signal from CC-Request-Type (AVP 416, RFC 4006 section 8.3,
// mandatory on every real CCR -- confirmed ims_charging's own Ro_add_cc_request() always
// adds it on every CCR-Initial/Interim/Stop path), mapped onto the numbering the existing
// switch statements already handle. The original Accounting-Record-Type check still runs
// first and still wins whenever present, so this only ever engages in the one specific
// case this deployment's own CCR_C_PATCH created. Confirmed (via a tree-wide grep) that
// `ims_charging` is cdp's ONLY consumer anywhere of AAACreateCCAccSession/ACCT_CC_CLIENT/
// ACC_CC_ST_*/ACC_CC_EV_* -- this cannot affect VoWiFi's S6b or OCS's own SMF-side Gy
// peer, both freeDiameter-based, not cdp-based. Verified via an isolated scratch-copy
// full `make cdp.so` rebuild (not a syntax-only check) -- zero warnings (including
// -Wimplicit-function-declaration/-Wimplicit-int), zero errors, clean link, both new and
// existing symbols present via `nm -D`.
//
// NOT currently wired into this file's own buildKamailioImsModulesScript() below, since
// that script never rebuilds cdp.so at all (only ims_ipsec_pcscf/ims_registrar_pcscf/
// ims_charging, reusing the apt-installed stock cdp) -- this patch only takes effect via
// kamailio-source-build.ts's 6.0.8 pipeline, which already includes 'cdp' in
// REQUIRED_MODULES. If this project ever extends the 5.8.8 path to also rebuild cdp,
// this same patch (confirmed byte-identical applicability against both trees' cdp source)
// should be wired in there too.
export const CDP_COMMON_C_PATCH = String.raw`--- a/src/modules/cdp/common.c
+++ b/src/modules/cdp/common.c
@@ -18,6 +18,28 @@ int get_accounting_record_type(AAAMessage *msg)
 	return -1;
 }

+/**
+ * NMS patch 2026-10-01: a pure Credit-Control (RFC 4006) client has no
+ * Accounting-Record-Type AVP at all -- that AVP belongs to Diameter Base
+ * Accounting (RFC 6733 section 9), not Credit-Control, and a strict peer
+ * can reject a CCR that carries it. get_accounting_record_type() then
+ * always returns -1 for such a client, which is exactly what
+ * cc_acc_client_stateful_sm_process() (acctstatemachine.c) otherwise reads
+ * as "unknown/malformed request". CC-Request-Type (AVP 416) is the
+ * Credit-Control-native equivalent -- RFC 4006 section 8.3 requires it on
+ * every CCR -- so this is a read-only lookup callers can use as a fallback
+ * signal for the same "what kind of request is this" question, without
+ * touching the existing Accounting-Record-Type check at all.
+ */
+int get_cc_request_type(AAAMessage *msg)
+{
+	AAA_AVP *avp = AAAFindMatchingAVP(msg, 0, AVP_CC_Request_Type, 0, 0);
+	if(avp && avp->data.len == 4) {
+		return get_4bytes(avp->data.s);
+	}
+	return -1;
+}
+
 int get_result_code(AAAMessage *msg)
 {
 	AAA_AVP *avp, *avp2;
--- a/src/modules/cdp/common.h
+++ b/src/modules/cdp/common.h
@@ -14,6 +14,7 @@

 int get_result_code(AAAMessage *msg);
 int get_accounting_record_type(AAAMessage *msg);
+int get_cc_request_type(AAAMessage *msg);


 #endif /* COMMON_H_ */
`;

// See CDP_COMMON_C_PATCH's own comment above for the full rationale -- this is the other
// half of the same fix, wiring get_cc_request_type() into the 3 places
// cc_acc_client_stateful_sm_process() calls get_accounting_record_type() as a fallback
// that only engages when the latter returns -1 (AVP absent entirely). Fails closed: a
// message that HAS the AVP but with some other unrecognized value, or that lacks BOTH
// AVPs, still falls through to the original (unchanged) error path.
export const CDP_ACCTSM_C_PATCH = String.raw`--- a/src/modules/cdp/acctstatemachine.c
+++ b/src/modules/cdp/acctstatemachine.c
@@ -126,6 +126,24 @@ int cc_acc_client_stateful_sm_process(
 				case ACC_CC_EV_SEND_REQ: //were sending a message - CCR
 					//assert this is an initial request. we can't move from IDLE with anything else
 					record_type = get_accounting_record_type(msg);
+					if(record_type == -1) {
+						/* NMS patch 2026-10-01: no Accounting-Record-Type AVP
+						 * at all on this CCR (a pure Credit-Control client
+						 * that never sends Diameter Base Accounting AVPs --
+						 * see get_cc_request_type()'s own comment in
+						 * common.c). Re-derive the same "is this a START"
+						 * signal from CC-Request-Type instead, mapped onto
+						 * the Accounting-Record-Type numbering the switch
+						 * below already understands, so every existing case
+						 * runs completely unchanged. Only engages when the
+						 * AVP this code was originally written for is
+						 * missing entirely -- a message that HAS the AVP but
+						 * with some other unrecognized value still falls
+						 * through to the original error below, unchanged. */
+						if(get_cc_request_type(msg)
+								== AVP_CC_Request_Type_Initial_Request)
+							record_type = 2 /*START RECORD*/;
+					}
 					switch(record_type) {
 						case 2 /*START RECORD*/:
 							LM_DBG("sending CCR START record on session\n");
@@ -152,6 +170,22 @@ int cc_acc_client_stateful_sm_process(
 				case ACC_CC_EV_SEND_REQ: //were sending a message - CCR
 					//make sure it is either an update or a termination.
 					record_type = get_accounting_record_type(msg);
+					if(record_type == -1) {
+						/* NMS patch 2026-10-01: see the matching fallback in
+						 * the ACC_CC_ST_IDLE/ACC_CC_EV_SEND_REQ case above
+						 * for the full rationale. Same mapping, covering the
+						 * Update and Termination requests sent from OPEN. */
+						switch(get_cc_request_type(msg)) {
+							case AVP_CC_Request_Type_Update_Request:
+								record_type = 3 /*UPDATE RECORD*/;
+								break;
+							case AVP_CC_Request_Type_Termination_Request:
+								record_type = 4 /*TERMINATE RECORD*/;
+								break;
+							default:
+								break;
+						}
+					}
 					switch(record_type) {
 						case 3 /*UPDATE RECORD*/:
 							LM_DBG("sending CCR UPDATE record on session\n");
@@ -247,8 +281,11 @@ int cc_acc_client_stateful_sm_process(
 			 * In this event you would incorrectly ignore the CCR-T
 			 * Solution is to change state to change state to ACC_CC_ST_PENDING_T if CCR-T is sent while in this state  */
 			if(event == ACC_CC_EV_SEND_REQ && msg
-					&& get_accounting_record_type(msg)
-							   == 4 /*TERMINATE RECORD*/) {
+					&& (get_accounting_record_type(msg) == 4 /*TERMINATE RECORD*/
+							/* NMS patch 2026-10-01: same Accounting-Record-Type-
+							 * absent fallback as the IDLE/OPEN cases above. */
+							|| get_cc_request_type(msg)
+									   == AVP_CC_Request_Type_Termination_Request)) {
 				LM_ERR("Received CCR-T while in state ACC_CC_ST_PENDING_U, "
 					   "just going to change to ACC_CC_ST_PENDING_T\n");
 				s->u.cc_acc.state = ACC_CC_ST_PENDING_T;
`;

// Real bug found live 2026-10-01: a real Google Pixel 7 (5G-attached, Android build
// CP3A.260905.009) could neither place nor receive any IMS voice call -- confirmed via a
// live, manually-decoded packet capture (the IPsec SA uses cipher_null, so the ESP
// payload is in the clear under a thin wrapper) that the device's own IMS stack sends a
// `100 Trying` then, within the same second, a deliberate `480 Temporarily not available`
// (confirmed genuinely from the device -- `Server: Google_Pixel7_Android ...` in the
// response) for every single call-establishing INVITE delivered to it, regardless of
// caller (reproduced with a caller-agnostic test that has zero 4G/charging/N5 involvement
// on the caller side at all, isolating this to the MT/network-to-UE delivery path). The
// Pixel's own OPTIONS-keepalive 200 OK responses (unrelated to any call, always healthy)
// unconditionally declare `Require: sec-agree` / `Proxy-Require: sec-agree` (RFC 3329 IMS
// security-mechanism-agreement) -- i.e. its IMS stack treats sec-agree confirmation as
// mandatory. The actual INVITE P-CSCF forwards to it has no `Security-Verify` header at
// all. Root-caused in `ims_ipsec_pcscf/cmd.c`'s `ipsec_forward()` (the function used for
// EVERY UE's MT delivery, including this deployment's own real, already-working iPhone):
// confirmed via direct source read that it only ever adds `Require`/`Security-Verify`
// sec-agree headers on a REGISTER 200 OK reply (gated explicitly on `SIP_REPLY` + status
// 200 + the original request being a REGISTER) -- never on an INVITE in either direction.
// Confirmed this is stock, unmodified-by-this-project upstream Kamailio 6.0.8 behavior,
// not a regression introduced by CMD_C_PATCH_KAMAILIO6/SAVE_C_PATCH above (both touch
// different functions -- ipsec_create()'s REGISTER-time security_temp handling and
// save.c's contact-promotion fallback, respectively -- neither anywhere near
// ipsec_forward(); confirmed via this deployment's own `ip xfrm state`/P-CSCF logs that
// the Pixel's contact and SA were cleanly resolved with zero errors for the failing
// transaction, ruling out a stale/mismatched-contact explanation too). Most likely
// explanation for why this previously worked: the Pixel's own Android build started
// strictly enforcing sec-agree on calls via an OTA update, exposing a long-standing gap
// in this project's own P-CSCF config that real-world devices had simply tolerated until
// now -- not a server-side regression, but the correct fix regardless, since RFC
// 3329/3GPP TS 24.229-compliant behavior is to confirm sec-agree on every request over an
// IPsec-protected tunnel, not just REGISTER.
//
// Fix: a new opt-in flag bit (IPSEC_FORWARD_ADD_SECVERIFY, confirmed via a real grep that
// bits 0-9 are the only ones already in use) and a new add_security_verify_header()
// function -- byte-identical parameter syntax to this same file's own, already-working
// add_security_server_header() (3GPP TS 24.229 / RFC 3329 -- Security-Server and
// Security-Verify share an identical grammar, just at different protocol phases), reusing
// the exact same `ipsec_t *s` pointer ipsec_forward() already resolved and validated
// moments earlier for this same packet, so there's no new lookup and no new failure mode.
// Wired into ipsec_forward() gated on `SIP_REQUEST` (never fires for a reply, so it can
// never collide with the existing REGISTER-200-OK block, which is gated on SIP_REPLY --
// mutually exclusive on message type) and the new flag bit, which is deliberately opted
// into from exactly ONE call site in this project's own P-CSCF config
// (route[MT]'s initial-request ipsec_forward() call in mt.cfg) -- REGISTER processing,
// MO-direction forwarding, and in-dialog MT requests (route[MT_indialog]) are all left
// completely unchanged, matching 3GPP's own scoping of sec-agree confirmation to initial
// requests. Verified via a real, isolated `make` of just this module against a freshly
// patched copy of the real live source tree (not a syntax-only check): clean compile,
// zero warnings (including with -Wall -Wextra -Wimplicit-function-declaration added), the
// new `add_security_verify_header` symbol confirmed present via `nm -D` alongside the
// pre-existing `add_security_server_header`.
export const SECVERIFY_C_PATCH = String.raw`--- a/src/modules/ims_ipsec_pcscf/cmd.c
+++ b/src/modules/ims_ipsec_pcscf/cmd.c
@@ -100,6 +100,21 @@
 #define IPSEC_FORWARD_USEVIA (1 << 8)
 /* if set - try TCP if corresponding UDP socket is not found */
 #define IPSEC_FORWARD_TRYTCP (1 << 9)
+/* NMS patch, confirmed live 2026-10-01: if set - add Require/Security-Verify
+ * sec-agree headers (RFC 3329) to a request being forwarded into a UE's
+ * IPsec tunnel. Upstream only ever adds these on a REGISTER 200 OK reply
+ * (see the existing block in ipsec_forward() below) -- never on an INVITE,
+ * in either direction. A real device (confirmed: a Google Pixel 7 running a
+ * 2026-09 Android build) was found live to require sec-agree confirmation
+ * on every call-establishing INVITE too, not just REGISTER -- it silently
+ * rejects (480, no ring, matching a real "no mobile network" dialer error)
+ * an otherwise completely valid INVITE delivered correctly over its own
+ * already-established IPsec SA, purely because this confirmation is
+ * missing. Scoped to its own opt-in flag bit so it only applies where
+ * explicitly requested (route[MT]'s initial-request ipsec_forward() call)
+ * -- REGISTER processing, MO-direction forwarding, and in-dialog MT
+ * requests are all unaffected. */
+#define IPSEC_FORWARD_ADD_SECVERIFY (1 << 10)

 /* if set - delete unused tunnels before every registration */
 #define IPSEC_CREATE_DELETE_UNUSED_TUNNELS 0x01
@@ -809,6 +824,50 @@
 	return 0;
 }

+// NMS patch, confirmed live 2026-10-01: same parameter syntax as
+// add_security_server_header() above (3GPP TS 24.229 / RFC 3329 -- the two
+// headers share an identical grammar, just at different protocol phases),
+// used to confirm the already-negotiated IPsec SA on a request being
+// forwarded into it, gated behind IPSEC_FORWARD_ADD_SECVERIFY. See that
+// flag's own comment for the full rationale.
+int add_security_verify_header(struct sip_msg *m, ipsec_t *s)
+{
+	str *sec_header = NULL;
+	if((sec_header = pkg_malloc(sizeof(str))) == NULL) {
+		LM_ERR("Error allocating pkg memory for security-verify header\n");
+		return -1;
+	}
+	memset(sec_header, 0, sizeof(str));
+
+	char sec_hdr_buf[1024];
+	memset(sec_hdr_buf, 0, sizeof(sec_hdr_buf));
+	sec_header->len = snprintf(sec_hdr_buf, sizeof(sec_hdr_buf) - 1,
+			"Security-Verify: "
+			"ipsec-3gpp;q=0.1;prot=esp;mod=trans;spi-c=%d;spi-s=%d;port-c=%d;"
+			"port-s=%"
+			"d;alg=%.*s;ealg=%.*s\r\n",
+			s->spi_pc, s->spi_ps, s->port_pc, s->port_ps, s->r_alg.len,
+			s->r_alg.s, s->r_ealg.len, s->r_ealg.s);
+
+	if((sec_header->s = pkg_malloc(sec_header->len)) == NULL) {
+		LM_ERR("Error allocating pkg memory for security-verify payload\n");
+		pkg_free(sec_header);
+		return -1;
+	}
+	memcpy(sec_header->s, sec_hdr_buf, sec_header->len);
+
+	if(cscf_add_header(m, sec_header, HDR_OTHER_T) != 1) {
+		LM_ERR("Error adding security-verify header to request!\n");
+		pkg_free(sec_header->s);
+		pkg_free(sec_header);
+		return -1;
+	}
+
+	pkg_free(sec_header);
+
+	return 0;
+}
+
 int ipsec_create(struct sip_msg *m, udomain_t *d, int _cflags)
 {
 	pcontact_t *pcontact = NULL;
@@ -1260,6 +1319,25 @@

 	ret = IPSEC_CMD_SUCCESS; // all good, return SUCCESS

+	// NMS patch, confirmed live 2026-10-01: see IPSEC_FORWARD_ADD_SECVERIFY's
+	// own comment for the full rationale. Placed before the sibling
+	// REGISTER-200-OK block below (mirrors its own error-handling shape --
+	// a failure here still reports the already-set SUCCESS, same as that
+	// block already does) so a request that needs it gets it regardless of
+	// anything that block does, and vice versa; the two conditions
+	// (SIP_REQUEST here, SIP_REPLY there) are mutually exclusive on the
+	// very first line of this function, so they can never both fire for
+	// the same message.
+	if(m->first_line.type == SIP_REQUEST
+			&& (_cflags & IPSEC_FORWARD_ADD_SECVERIFY)) {
+		if(add_require_secagree_header(m) != 0) {
+			goto cleanup;
+		}
+		if(add_security_verify_header(m, s) != 0) {
+			goto cleanup;
+		}
+	}
+
 	if(m->first_line.type == SIP_REPLY
 			&& m->first_line.u.reply.statuscode == 200
 			&& req->first_line.u.request.method_value == METHOD_REGISTER) {
`;

export const IMS_MODULES_BUILD_STEPS = [
  'preparing', 'installing_apt_deps', 'fetching_source', 'patching', 'building', 'verifying_abi', 'deploying',
] as const;
export type ImsModulesBuildStep = typeof IMS_MODULES_BUILD_STEPS[number];

// Full build script. Rebuilds/redeploys ims_ipsec_pcscf.so,
// ims_registrar_pcscf.so, and ims_charging.so -- every other kamailio-ims-
// modules .so is left completely untouched. Deliberately does NOT restart
// kamailio-pcscf/kamailio-scscf itself; that's the caller's job
// (ims-controller.ts's /install), same "build now, cut over as an explicit
// separate step" split this project uses for FRR's crash-guard patch and the
// osmo-msc/osmo-sip-connector source builds.
// Idempotent: if all three target .so files already contain the patch
// markers, this is a fast no-op unless force=true.
export function buildKamailioImsModulesScript(force = false): string {
  return `#!/bin/bash
set -e
export DEBIAN_FRONTEND=noninteractive

start_heartbeat() {
  ( while true; do sleep 15; echo "... still working (\${SECONDS}s in this phase)"; done ) &
  echo $! > /tmp/kamailio-ims-modules-build-heartbeat.pid
}
stop_heartbeat() {
  if [ -f /tmp/kamailio-ims-modules-build-heartbeat.pid ]; then
    kill "$(cat /tmp/kamailio-ims-modules-build-heartbeat.pid)" 2>/dev/null || true
    rm -f /tmp/kamailio-ims-modules-build-heartbeat.pid
  fi
}
trap stop_heartbeat EXIT

echo "==STEP:preparing=="
IPSEC_SO="${MODULES_DIR}/ims_ipsec_pcscf.so"
REGISTRAR_SO="${MODULES_DIR}/ims_registrar_pcscf.so"
CHARGING_SO="${MODULES_DIR}/ims_charging.so"
PATCH_REV_FILE="${BUILD_WORKDIR}/.patch-rev"

if [ "${force ? '1' : '0'}" != "1" ] \\
    && [ -f "$IPSEC_SO" ] && [ -f "$REGISTRAR_SO" ] && [ -f "$CHARGING_SO" ] \\
    && [ -f "$IPSEC_SO.apt-original" ] && [ -f "$REGISTRAR_SO.apt-original" ] && [ -f "$CHARGING_SO.apt-original" ] \\
    && [ "$(cat "$PATCH_REV_FILE" 2>/dev/null || echo -1)" = "${PATCH_REV}" ]; then
  echo "kamailio-ims-modules patch rev ${PATCH_REV} already deployed -- nothing to do."
  echo "==STEP:done=="
  exit 0
fi
mkdir -p ${BUILD_WORKDIR}

if ! dpkg -s kamailio-ims-modules >/dev/null 2>&1; then
  echo "ERROR: kamailio-ims-modules is not installed yet -- install IMS first."
  exit 1
fi
KAMAILIO_TAG="$(dpkg-query -W -f='\${Version}' kamailio-ims-modules)"
echo "installed kamailio-ims-modules version: $KAMAILIO_TAG"

echo "==STEP:installing_apt_deps=="
start_heartbeat
apt-get update -qq
# Confirmed live 2026-09-12 against the real linked libs of the two already-
# built .so files (ldd): libmnl (netlink, ims_ipsec_pcscf's IPsec SA/policy
# calls) and libxml2 (ims_registrar_pcscf). bison/flex/libssl-dev/build-essential
# are kamailio's own core build requirements.
apt-get install -y \\
  build-essential dpkg-dev bison flex libssl-dev libxml2-dev libmnl-dev pkg-config
stop_heartbeat

echo "==STEP:fetching_source=="
cd ${BUILD_WORKDIR}
rm -rf kamailio-src *.dsc *.tar.* *.build *.changes
start_heartbeat
apt-get source "kamailio-ims-modules=$KAMAILIO_TAG"
stop_heartbeat
SRC_DIR="$(find . -maxdepth 1 -type d -iname 'kamailio-*' | head -1)"
if [ -z "$SRC_DIR" ]; then
  echo "ERROR: apt-get source did not produce a kamailio-* source directory."
  exit 1
fi
mv "$SRC_DIR" kamailio-src
cd kamailio-src
echo "source tree ready: $(pwd)"

echo "==STEP:patching=="
IPSEC_C=src/modules/ims_ipsec_pcscf/cmd.c
REGISTRAR_C=src/modules/ims_registrar_pcscf/save.c

if grep -q "${CMD_C_MARKER}" "$IPSEC_C"; then
  echo "  ok    $IPSEC_C (already patched)"
else
  cat > /tmp/cmd.c.patch <<'PATCHEOF'
${CMD_C_PATCH}
PATCHEOF
  patch -p1 --forward --batch < /tmp/cmd.c.patch
  grep -q "${CMD_C_MARKER}" "$IPSEC_C" || { echo "ERROR: $IPSEC_C patch marker missing after apply -- upstream source may have changed, review manually."; exit 1; }
  echo "  PATCH $IPSEC_C"
fi

if grep -q "${SAVE_C_MARKER}" "$REGISTRAR_C"; then
  echo "  ok    $REGISTRAR_C (already patched)"
else
  cat > /tmp/save.c.patch <<'PATCHEOF'
${SAVE_C_PATCH}
PATCHEOF
  patch -p1 --forward --batch < /tmp/save.c.patch
  grep -q "${SAVE_C_MARKER}" "$REGISTRAR_C" || { echo "ERROR: $REGISTRAR_C patch marker missing after apply -- upstream source may have changed, review manually."; exit 1; }
  echo "  PATCH $REGISTRAR_C"
fi

CCR_C=src/modules/ims_charging/ccr.c
IMS_RO_C=src/modules/ims_charging/ims_ro.c

if grep -q "${CCR_C_MARKER}" "$CCR_C"; then
  echo "  ok    $CCR_C (already patched)"
else
  cat > /tmp/ccr.c.patch <<'PATCHEOF'
${CCR_C_PATCH}
PATCHEOF
  patch -p1 --forward --batch < /tmp/ccr.c.patch
  grep -q "${CCR_C_MARKER}" "$CCR_C" || { echo "ERROR: $CCR_C patch marker missing after apply -- upstream source may have changed, review manually."; exit 1; }
  echo "  PATCH $CCR_C"
fi

if grep -q "${ROC_C_MARKER}" "$IMS_RO_C"; then
  echo "  ok    $IMS_RO_C (already patched)"
else
  cat > /tmp/ims_ro.c.patch <<'PATCHEOF'
${IMS_RO_C_PATCH}
PATCHEOF
  patch -p1 --forward --batch < /tmp/ims_ro.c.patch
  grep -q "${ROC_C_MARKER}" "$IMS_RO_C" || { echo "ERROR: $IMS_RO_C patch marker missing after apply -- upstream source may have changed, review manually."; exit 1; }
  echo "  PATCH $IMS_RO_C"
fi

echo "==STEP:building=="
start_heartbeat
make modules modules=src/modules/ims_ipsec_pcscf
make modules modules=src/modules/ims_registrar_pcscf
make modules modules=src/modules/ims_charging
stop_heartbeat
echo ${PATCH_REV} > "$PATCH_REV_FILE"

NEW_IPSEC_SO="$(pwd)/src/modules/ims_ipsec_pcscf/ims_ipsec_pcscf.so"
NEW_REGISTRAR_SO="$(pwd)/src/modules/ims_registrar_pcscf/ims_registrar_pcscf.so"
NEW_CHARGING_SO="$(pwd)/src/modules/ims_charging/ims_charging.so"
test -f "$NEW_IPSEC_SO" || { echo "ERROR: build did not produce $NEW_IPSEC_SO"; exit 1; }
test -f "$NEW_REGISTRAR_SO" || { echo "ERROR: build did not produce $NEW_REGISTRAR_SO"; exit 1; }
test -f "$NEW_CHARGING_SO" || { echo "ERROR: build did not produce $NEW_CHARGING_SO"; exit 1; }

echo "==STEP:verifying_abi=="
# Confirmed-live discipline from the original manual patch: a bad build could
# still link and produce a .so, but with a different exported-symbol set than
# what kamailio's module loader expects -- diffing the dynamic symbol table
# against the currently-loaded module (patched or original, whichever is
# live right now) catches that before it ever reaches a running service.
for pair in "$IPSEC_SO:$NEW_IPSEC_SO:ims_ipsec_pcscf" "$REGISTRAR_SO:$NEW_REGISTRAR_SO:ims_registrar_pcscf" "$CHARGING_SO:$NEW_CHARGING_SO:ims_charging"; do
  OLD="\${pair%%:*}"; rest="\${pair#*:}"; NEW="\${rest%%:*}"; NAME="\${rest##*:}"
  nm -D --defined-only "$OLD" 2>/dev/null | awk '{print $NF}' | sort > /tmp/"$NAME".old.symbols
  nm -D --defined-only "$NEW" 2>/dev/null | awk '{print $NF}' | sort > /tmp/"$NAME".new.symbols
  if ! diff -q /tmp/"$NAME".old.symbols /tmp/"$NAME".new.symbols > /dev/null; then
    echo "ERROR: $NAME.so exported-symbol table differs from the currently-loaded module -- refusing to deploy. Diff:"
    diff /tmp/"$NAME".old.symbols /tmp/"$NAME".new.symbols || true
    exit 1
  fi
  echo "  ABI ok: $NAME"
done

echo "==STEP:deploying=="
# Preserve the true original exactly once -- never overwrite an existing
# .apt-original with an already-patched file on a re-run.
[ -f "$IPSEC_SO.apt-original" ] || cp "$IPSEC_SO" "$IPSEC_SO.apt-original"
[ -f "$REGISTRAR_SO.apt-original" ] || cp "$REGISTRAR_SO" "$REGISTRAR_SO.apt-original"
[ -f "$CHARGING_SO.apt-original" ] || cp "$CHARGING_SO" "$CHARGING_SO.apt-original"
cp "$NEW_IPSEC_SO" "$IPSEC_SO.new" && mv "$IPSEC_SO.new" "$IPSEC_SO"
cp "$NEW_REGISTRAR_SO" "$REGISTRAR_SO.new" && mv "$REGISTRAR_SO.new" "$REGISTRAR_SO"
cp "$NEW_CHARGING_SO" "$CHARGING_SO.new" && mv "$CHARGING_SO.new" "$CHARGING_SO"
chmod 644 "$IPSEC_SO" "$REGISTRAR_SO" "$CHARGING_SO"
echo "deployed: $IPSEC_SO"
echo "deployed: $REGISTRAR_SO"
echo "deployed: $CHARGING_SO"
echo "originals preserved as *.apt-original for instant revert"

echo "==STEP:done=="
`;
}

// Real check — reads the actual deployed files, not the build log.
// Found live 2026-09-18 (chasing an unrelated reproducibility audit) that
// this had been broken since it was first written: CMD_C_MARKER/
// SAVE_C_MARKER/CCR_C_MARKER are C *comments* in the patch diffs, and
// comments never survive compilation into a .so's string table — `strings`
// can never find them, so every *Patched flag always returned false
// regardless of whether the patch was actually applied. Never caught before
// because nothing in this codebase ever calls this function (confirmed via
// a full grep) — the real deploy pipeline verifies success its own way (the
// ABI `nm -D` exported-symbol diff step already baked into the generated
// script below), so this dead diagnostic function's own bug never blocked
// anything real. Fixed to compare compiled file SIZE against the preserved
// `.apt-original` — a patched ims_charging.so is genuinely, substantially
// larger than the stock package build (confirmed live: 1,138,328 bytes vs
// 476,584 original), a real signal that survives compilation, unlike a
// comment string.
export async function verifyKamailioImsModulesPatch(): Promise<{
  ipsecPatched: boolean;
  registrarPatched: boolean;
  chargingPatched: boolean;
  originalsPreserved: boolean;
}> {
  const sizeDiffers = async (so: string): Promise<boolean> => {
    try {
      const { stdout } = await nsenter('bash', ['-c',
        `stat -c%s ${MODULES_DIR}/${so}.so 2>/dev/null; stat -c%s ${MODULES_DIR}/${so}.so.apt-original 2>/dev/null`]);
      const [current, original] = stdout.trim().split('\n').map(n => parseInt(n, 10));
      return Number.isFinite(current) && Number.isFinite(original) && current !== original;
    } catch { return false; }
  };
  try {
    const [ipsecPatched, registrarPatched, chargingPatched] = await Promise.all([
      sizeDiffers('ims_ipsec_pcscf'), sizeDiffers('ims_registrar_pcscf'), sizeDiffers('ims_charging'),
    ]);
    const { stdout: originals } = await nsenter('bash', ['-c',
      `test -f ${MODULES_DIR}/ims_ipsec_pcscf.so.apt-original && test -f ${MODULES_DIR}/ims_registrar_pcscf.so.apt-original && test -f ${MODULES_DIR}/ims_charging.so.apt-original && echo yes || echo no`]);
    return { ipsecPatched, registrarPatched, chargingPatched, originalsPreserved: originals.trim() === 'yes' };
  } catch {
    return { ipsecPatched: false, registrarPatched: false, chargingPatched: false, originalsPreserved: false };
  }
}
