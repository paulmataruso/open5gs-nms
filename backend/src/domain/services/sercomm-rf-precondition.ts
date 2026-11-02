// Whether a Sercomm femto can actually bring its cell up, as opposed to
// whether it accepted the write that asked it to.
//
// Why this exists. "RF On" for a Sercomm writes
// `FAPControl.LTE.AdminState = 1` and used to report success the moment
// GenieACS accepted the task. That is not the same thing, and the gap is not
// theoretical — measured live on 2112CW5000195, 2026-11-01:
//
//   18:32:23  AdminState = True    (the write landed)
//   18:46:19  AdminState = False   (the radio put it back, no task, no fault)
//
// With SAS enabled the firmware will not hold a cell in service without a
// grant, so it reverts AdminState on its own. The radio had not contacted the
// SAS at all since its last grant 5 days earlier: `SAS_Status` empty, and a
// six-minute packet capture that did catch its CWMP inform and its NTP showed
// ZERO packets to the SAS ports. The cause was its GPS lock reading 0/0 —
// `buildSercommProvisionTasks()` already documents that guard ("Must be
// non-zero or SAS client refuses to start"), and the sibling radio that was up
// at that same moment differed in exactly that respect.
//
// So the point of this module is that an operator pressing RF On is told the
// precondition is unmet, immediately, instead of watching a successful-looking
// button quietly undo itself a few minutes later.

export const SERCOMM_FAP_PREFIX = 'Device.Services.FAPService.1.';
export const SERCOMM_NE_STATUS_PREFIX = 'Device.X_000E8F_DeviceFeature.X_000E8F_NEStatus.';

/** Everything this assessment reads, for the GPV that refreshes it. */
export const SERCOMM_RF_PRECONDITION_PARAMS = [
  `${SERCOMM_FAP_PREFIX}FAPControl.LTE.AdminState`,
  `${SERCOMM_FAP_PREFIX}FAPControl.LTE.X_000E8F_SAS.Enable`,
  `${SERCOMM_NE_STATUS_PREFIX}X_000E8F_SAS_Status`,
  `${SERCOMM_NE_STATUS_PREFIX}X_000E8F_eNB_Status`,
  'Device.FAP.GPS.LockedLatitude',
  'Device.FAP.GPS.LockedLongitude',
];

export interface SercommRfPrecondition {
  /** True when the cell cannot come up however many times RF On is sent. */
  blocked: boolean;
  /** Operator-facing explanations, most specific first. Empty when not blocked. */
  reasons: string[];
  sasEnabled: boolean;
  /** The radio's own SAS client state. Empty string means it is not reporting. */
  sasStatus: string;
  enbStatus: string;
  adminState: boolean | null;
  gpsLocked: boolean;
}

function raw(device: Record<string, any>, dotPath: string): string | null {
  let node: any = device;
  for (const part of dotPath.split('.')) {
    if (node == null) return null;
    node = node[part];
  }
  return node?._value != null ? String(node._value).trim() : null;
}

function asBool(v: string | null): boolean | null {
  if (v == null || v === '') return null;
  return /^(1|true)$/i.test(v);
}

/**
 * A GPS coordinate the firmware treats as "locked".
 *
 * Both parameters are integer millionths of a degree, and 0 is the firmware's
 * own not-locked sentinel rather than the equator — a radio genuinely sitting
 * on 0,0 is not a case worth distinguishing, since the SAS would reject the
 * location anyway.
 */
function gpsIsLocked(lat: string | null, lon: string | null): boolean {
  const a = Number(lat), b = Number(lon);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return a !== 0 && b !== 0;
}

export function assessSercommRfPrecondition(device: Record<string, any>): SercommRfPrecondition {
  const adminState = asBool(raw(device, `${SERCOMM_FAP_PREFIX}FAPControl.LTE.AdminState`));
  const sasEnabled = asBool(raw(device, `${SERCOMM_FAP_PREFIX}FAPControl.LTE.X_000E8F_SAS.Enable`)) === true;
  const sasStatus = raw(device, `${SERCOMM_NE_STATUS_PREFIX}X_000E8F_SAS_Status`) ?? '';
  const enbStatus = raw(device, `${SERCOMM_NE_STATUS_PREFIX}X_000E8F_eNB_Status`) ?? '';
  const lat = raw(device, 'Device.FAP.GPS.LockedLatitude');
  const lon = raw(device, 'Device.FAP.GPS.LockedLongitude');
  const gpsLocked = gpsIsLocked(lat, lon);

  const reasons: string[] = [];
  if (sasEnabled) {
    // Ordered most-actionable first: the GPS gate is upstream of everything
    // else, so reporting "no grant" without it sends an operator to the SAS
    // when the radio never spoke to it.
    if (!gpsLocked) {
      reasons.push(
        'SAS is enabled but the radio’s GPS lock reads 0 — its SAS client will not start, so it can never be granted spectrum. Re-provision it with real coordinates (this writes Device.FAP.GPS.LockedLatitude/LockedLongitude).',
      );
    }
    if (sasStatus === '') {
      reasons.push('The radio is not reporting any SAS client status, so it is not currently talking to the SAS.');
    } else if (sasStatus.toUpperCase() !== 'SUCCESS') {
      reasons.push(`The radio’s SAS client reports "${sasStatus}" rather than SUCCESS, so it holds no grant.`);
    }
  }

  return {
    blocked: reasons.length > 0,
    reasons,
    sasEnabled,
    sasStatus,
    enbStatus,
    adminState,
    gpsLocked,
  };
}
