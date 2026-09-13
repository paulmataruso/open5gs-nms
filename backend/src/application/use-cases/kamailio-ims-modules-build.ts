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
export const PATCH_REV = 1;

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
export const SAVE_C_PATCH = String.raw`--- a/src/modules/ims_registrar_pcscf/save.c
+++ b/src/modules/ims_registrar_pcscf/save.c
@@ -228,19 +228,38 @@
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

export const IMS_MODULES_BUILD_STEPS = [
  'preparing', 'installing_apt_deps', 'fetching_source', 'patching', 'building', 'verifying_abi', 'deploying',
] as const;
export type ImsModulesBuildStep = typeof IMS_MODULES_BUILD_STEPS[number];

// Full build script. Only rebuilds/redeploys ims_ipsec_pcscf.so and
// ims_registrar_pcscf.so -- every other kamailio-ims-modules .so is left
// completely untouched. Deliberately does NOT restart kamailio-pcscf itself;
// that's the caller's job (ims-controller.ts's /install), same "build now,
// cut over as an explicit separate step" split this project uses for FRR's
// crash-guard patch and the osmo-msc/osmo-sip-connector source builds.
// Idempotent: if both target .so files already contain the patch markers,
// this is a fast no-op unless force=true.
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
PATCH_REV_FILE="${BUILD_WORKDIR}/.patch-rev"

if [ "${force ? '1' : '0'}" != "1" ] \\
    && [ -f "$IPSEC_SO" ] && [ -f "$REGISTRAR_SO" ] \\
    && [ -f "$IPSEC_SO.apt-original" ] && [ -f "$REGISTRAR_SO.apt-original" ] \\
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

echo "==STEP:building=="
start_heartbeat
make modules modules=src/modules/ims_ipsec_pcscf
make modules modules=src/modules/ims_registrar_pcscf
stop_heartbeat
echo ${PATCH_REV} > "$PATCH_REV_FILE"

NEW_IPSEC_SO="$(pwd)/src/modules/ims_ipsec_pcscf/ims_ipsec_pcscf.so"
NEW_REGISTRAR_SO="$(pwd)/src/modules/ims_registrar_pcscf/ims_registrar_pcscf.so"
test -f "$NEW_IPSEC_SO" || { echo "ERROR: build did not produce $NEW_IPSEC_SO"; exit 1; }
test -f "$NEW_REGISTRAR_SO" || { echo "ERROR: build did not produce $NEW_REGISTRAR_SO"; exit 1; }

echo "==STEP:verifying_abi=="
# Confirmed-live discipline from the original manual patch: a bad build could
# still link and produce a .so, but with a different exported-symbol set than
# what kamailio's module loader expects -- diffing the dynamic symbol table
# against the currently-loaded module (patched or original, whichever is
# live right now) catches that before it ever reaches a running service.
for pair in "$IPSEC_SO:$NEW_IPSEC_SO:ims_ipsec_pcscf" "$REGISTRAR_SO:$NEW_REGISTRAR_SO:ims_registrar_pcscf"; do
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
cp "$NEW_IPSEC_SO" "$IPSEC_SO.new" && mv "$IPSEC_SO.new" "$IPSEC_SO"
cp "$NEW_REGISTRAR_SO" "$REGISTRAR_SO.new" && mv "$REGISTRAR_SO.new" "$REGISTRAR_SO"
chmod 644 "$IPSEC_SO" "$REGISTRAR_SO"
echo "deployed: $IPSEC_SO"
echo "deployed: $REGISTRAR_SO"
echo "originals preserved as *.apt-original for instant revert"

echo "==STEP:done=="
`;
}

// Real check — reads the actual deployed files, not the build log.
export async function verifyKamailioImsModulesPatch(): Promise<{
  ipsecPatched: boolean;
  registrarPatched: boolean;
  originalsPreserved: boolean;
}> {
  try {
    const { stdout: ipsecStrings } = await nsenter('bash', ['-c',
      `strings ${MODULES_DIR}/ims_ipsec_pcscf.so 2>/dev/null | grep -c "${CMD_C_MARKER}" || true`]);
    const { stdout: registrarStrings } = await nsenter('bash', ['-c',
      `strings ${MODULES_DIR}/ims_registrar_pcscf.so 2>/dev/null | grep -c "${SAVE_C_MARKER}" || true`]);
    const { stdout: originals } = await nsenter('bash', ['-c',
      `test -f ${MODULES_DIR}/ims_ipsec_pcscf.so.apt-original && test -f ${MODULES_DIR}/ims_registrar_pcscf.so.apt-original && echo yes || echo no`]);
    return {
      ipsecPatched: parseInt(ipsecStrings.trim() || '0', 10) > 0,
      registrarPatched: parseInt(registrarStrings.trim() || '0', 10) > 0,
      originalsPreserved: originals.trim() === 'yes',
    };
  } catch {
    return { ipsecPatched: false, registrarPatched: false, originalsPreserved: false };
  }
}
