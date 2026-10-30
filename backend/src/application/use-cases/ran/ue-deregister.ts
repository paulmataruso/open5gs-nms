import pino from 'pino';
import { ActiveSessionsUseCase, ActiveUE } from '../active-sessions';
import { isUeDetachToolBuilt, runUeDetach } from './ue-detach-runner';

// ── "Bounce" a UE: force it off and let it come straight back ───────────────
//
// This is deliberately NOT blocking. Blocking (ue-block-service.ts) detaches a
// UE and then installs a persistent nftables blackhole so it cannot return;
// this sends the same real S6a Cancel-Location-Request but with CLR-Flags
// REATTACH_REQUIRED set, so the MME's NAS Detach Request tells the handset to
// re-attach immediately. It is the operator-side equivalent of toggling
// airplane mode on the device, which is the use case it exists for.
//
// The two actions therefore share one mechanism and differ by one bit, and
// that bit is threaded per-call rather than being a default — see
// ue-detach-runner.ts's UeDetachOptions.reattach.
//
// 4G and 5G are NOT symmetric here, and the asymmetry is upstream, not ours:
// see the `5g` branch in deregisterUe() for why a 5G bounce is refused rather
// than attempted.

export type UeDeregisterStatus =
  /** The core sent the UE a real NAS Detach Request. NOT a claim the handset obeyed. */
  | 'detached-sent'
  /** The core accepted the request but had no attached context to notify. */
  | 'not-attached'
  /** 5G, UE idle: the AMF would answer 204 without telling the UE anything. */
  | 'not-reachable-idle'
  /** 4G, UE already EMM-deregistered: the MME would answer SUCCESS and send no NAS Detach. */
  | 'not-reachable-deregistered'
  /** We could not tell which generation this IMSI is on. */
  | 'lookup-failed'
  /** The core answered, and said no. */
  | 'rejected'
  /** No answer inside the deadline. The request may still have been acted on. */
  | 'timeout'
  /** This generation (or this host) has no working path for the action. */
  | 'unsupported'
  | 'error';

export interface UeDeregisterResult {
  imsi: string;
  generation: '2g' | '4g' | '5g' | 'unknown';
  status: UeDeregisterStatus;
  /** True only when CLR-Flags REATTACH_REQUIRED was actually put on the wire. */
  reattachRequested: boolean;
  message: string;
  /** Raw Diameter codes, when there were any — kept for the audit trail. */
  resultCode?: number;
  experimentalResultCode?: number;
}

/** Diameter Experimental-Result-Code for USER_UNKNOWN. The MME answers with
 *  this when it holds no context for the IMSI, which is information ("that UE
 *  is not attached"), not a failure — so it is mapped before `rejected`. */
const DIAMETER_ERROR_USER_UNKNOWN = 5001;

const DETACH_TIMEOUT_MS = 15_000;

export class UeDeregisterUseCase {
  constructor(
    private readonly activeSessions: ActiveSessionsUseCase,
    private readonly logger: pino.Logger,
  ) {}

  /**
   * Which generation is this IMSI actually on right now?
   *
   * Detected rather than taken from the caller. The UE table the button lives
   * in merges 4G, 5G and 2G rows, so letting the frontend declare the
   * generation would mean a mislabelled row produces a confusing
   * "not attached" against the wrong core. Resolving it here also means the
   * answer comes from the same source the table itself renders from.
   */
  private async resolveGeneration(
    imsi: string,
  ): Promise<{ generation: '4g' | '5g' | 'unknown'; ue?: ActiveUE }> {
    const [ues5g, ues4g] = await Promise.all([
      this.activeSessions.getActive5GUEs(),
      // Passing an empty set rather than omitting it: the 4G list dedups
      // against 5G internally, and we want the raw 4G membership here, not a
      // list that has already had this IMSI removed for being on 5G.
      this.activeSessions.getActive4GUEs(new Set<string>()),
    ]);
    const on5g = ues5g.find(u => u.imsi === imsi && !u.metricsOnly);
    if (on5g) return { generation: '5g', ue: on5g };
    const on4g = ues4g.find(u => u.imsi === imsi && !u.metricsOnly);
    if (on4g) return { generation: '4g', ue: on4g };
    return { generation: 'unknown' };
  }

  async deregister(imsi: string): Promise<UeDeregisterResult> {
    let generation: '4g' | '5g' | 'unknown';
    let ue: ActiveUE | undefined;
    try {
      ({ generation, ue } = await this.resolveGeneration(imsi));
    } catch (err) {
      this.logger.warn({ err: String(err), imsi }, 'ue-deregister: generation lookup failed');
      return {
        imsi, generation: 'unknown', status: 'lookup-failed', reattachRequested: false,
        message: 'Could not read the live UE list to work out whether this IMSI is on 4G or 5G, so nothing was sent.',
      };
    }

    if (generation === 'unknown') {
      return {
        imsi, generation: 'unknown', status: 'not-attached', reattachRequested: false,
        message: 'This IMSI is not in the live 4G or 5G UE list, so there is no attached context to detach.',
      };
    }

    if (generation === '5g') {
      // Refused, not attempted — and this is a deliberate product decision,
      // so do not "fix" it by calling the AMF.
      //
      // Open5GS's AMF handles a UDM deregistration notification at
      // namf-handler.c:694-712. For a CONNECTED UE it sends a real NAS
      // De-registration Request. For an IDLE one it logs
      //   "Not implemented : Use Implicit De-registration"
      // and sends the handset NOTHING — while still answering 204 No Content.
      // The follow-on SDM unsubscribe path then calls
      // amf_sbi_send_release_all_sessions(), so the network tears the PDU
      // sessions down anyway. Net effect on an idle 5G UE: it sits in
      // 5GMM-REGISTERED believing it is fine, with no working data, until its
      // next Service Request is rejected. That is strictly worse than doing
      // nothing, and a 204 means we could not even report it honestly.
      //
      // 4G does the opposite and correctly: on ECM_IDLE the MME stores
      // MME_PAGING_TYPE_DETACH_TO_UE and pages the UE first
      // (mme-s6a-handler.c:324-330).
      //
      // A handset on a desk is idle most of the time, which is precisely when
      // someone reaches for this button — so the common case is the broken
      // one. The connected case would work, but is also unverified on real
      // hardware: that same handler hardcodes the 5GMM cause to
      // 5GS_SERVICES_NOT_ALLOWED (namf-handler.c:695-698) alongside the
      // re-registration bit, and whether a real handset honours the bit or
      // treats the cause as barring the PLMN is TS 24.501/UE-implementation
      // behaviour we have not tested. Shipping it could leave a phone with the
      // PLMN forbidden until reboot — the opposite of a convenience.
      //
      // Making 5G work properly means implementing the AMF's missing idle
      // paging branch, i.e. owning a fork across upgrades. Not justified by a
      // convenience button; revisit if 5G bouncing becomes important.
      const idle = ue?.cmState !== 'connected';
      return {
        imsi, generation: '5g', reattachRequested: false,
        status: idle ? 'not-reachable-idle' : 'unsupported',
        message: idle
          ? 'This 5G UE is idle. Open5GS’s AMF cannot page an idle UE for de-registration — it would drop the UE’s sessions without ever telling the handset, and still report success. Nothing was sent. Toggle airplane mode on the device instead.'
          : 'Bouncing a 5G UE is not supported. The AMF sends its de-registration with a hardcoded “5GS services not allowed” cause, which on a real handset may bar the network rather than trigger a re-attach. Nothing was sent. Toggle airplane mode on the device instead.',
      };
    }

    // ── 4G: the real path ───────────────────────────────────────────────────

    // Refuse up front if the MME already considers this UE EMM-deregistered.
    //
    // This is a real, reachable false-success and not a theoretical one — one
    // UE on this deployment sits in exactly this state while still appearing
    // in the live list. mme-fd-path.c:2274 sends the Cancel-Location-Answer
    // with DIAMETER_SUCCESS *before* queueing the event to the MME, and
    // mme_s6a_handle_clr() then takes its emm_state_de_registered early return
    // (mme-s6a-handler.c:285-290): it removes the UE context and sends no NAS
    // Detach Request at all. So the tool would report a clean success, the
    // handset would hear nothing, and it would not re-attach — the one outcome
    // this action exists to avoid. Checking the state we can already see beats
    // reporting a success we know to be hollow.
    if (ue?.mmState === 'deregistered') {
      return {
        imsi, generation: '4g', status: 'not-reachable-deregistered', reattachRequested: false,
        message: 'The MME already considers this UE de-registered, so a detach would be accepted but no message would reach the handset — it would not re-attach. Nothing was sent. Toggle airplane mode on the device instead.',
      };
    }

    if (!isUeDetachToolBuilt()) {
      return {
        imsi, generation: '4g', status: 'unsupported', reattachRequested: false,
        message: 'The UE detach tool is not built on this host yet. Install it from the RAN page (UE blocking setup) and try again.',
      };
    }

    let outcome;
    try {
      outcome = await runUeDetach(imsi, { timeoutMs: DETACH_TIMEOUT_MS, reattach: true });
    } catch (err) {
      this.logger.error({ err: String(err), imsi }, 'ue-deregister: detach tool threw');
      return {
        imsi, generation: '4g', status: 'error', reattachRequested: false,
        message: `Could not run the detach tool: ${String(err)}`,
      };
    }

    const base = {
      imsi,
      generation: '4g' as const,
      resultCode: outcome.resultCode,
      experimentalResultCode: outcome.experimentalResultCode,
    };

    if (outcome.status === 'success') {
      return {
        ...base, status: 'detached-sent',
        // Report what WE asked for, and cross-check it against what the tool
        // says it sent. A mismatch means the deployed binary predates the
        // -reattach flag, which is exactly the stale-artifact class of bug
        // this project keeps rediscovering — so say so rather than claim a
        // bounce that went out as a plain detach.
        reattachRequested: outcome.reattach === true,
        message: outcome.reattach === true
          ? 'The core sent this UE a NAS Detach Request with "re-attach required". The handset should come back on its own within a few seconds. (Note: the network sent the message — it cannot confirm the handset acted on it.)'
          : 'The detach was accepted, but the tool did not confirm it set the re-attach flag — the binary on this host is probably older than that flag. The UE has been detached and may NOT re-attach by itself. Rebuild the detach tool from the RAN page.',
      };
    }

    if (outcome.status === 'rejected') {
      if (outcome.experimentalResultCode === DIAMETER_ERROR_USER_UNKNOWN) {
        return {
          ...base, status: 'not-attached', reattachRequested: false,
          message: 'The MME holds no context for this IMSI, so there was nothing to detach.',
        };
      }
      return {
        ...base, status: 'rejected', reattachRequested: false,
        message: outcome.message
          ? `The MME rejected the request: ${outcome.message}`
          : `The MME rejected the request (Result-Code ${outcome.resultCode ?? 'none'}, Experimental-Result-Code ${outcome.experimentalResultCode ?? 'none'}).`,
      };
    }

    if (outcome.status === 'timeout') {
      // Deliberately not retried, here or by the caller. mme-s6a-handler.c:338
      // wraps sgsap_send_detach_indication() in an ogs_assert(), and that
      // function really can return OGS_ERROR — an assert on an error return is
      // an abort(), i.e. the MME dies and 4G goes down. The window is narrow
      // (an SGs-registered UE plus a failing SCTP write) but this deployment
      // genuinely runs SGs to osmo-msc, so a retry loop against a timing-out
      // MME is not a safe thing to build.
      return {
        ...base, status: 'timeout', reattachRequested: false,
        message: 'No Cancel-Location-Answer arrived before the deadline. The MME may still have acted on it — check the UE list before trying again rather than retrying immediately.',
      };
    }

    return {
      ...base, status: 'error', reattachRequested: false,
      message: outcome.message ?? 'The detach tool failed without a reason.',
    };
  }
}
