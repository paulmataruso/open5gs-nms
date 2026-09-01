// Classifies open5gs NF log lines into "major events" (radio connect/disconnect, UE
// attach/detach, PDU session up/down) for the Major Events log view — everything else is
// DEBUG-level noise that this deliberately filters out.
//
// Patterns below are taken verbatim from real log lines observed on a live host
// (/var/log/open5gs/{mme,amf,smf}.log), not from documentation — open5gs logs are
// unstructured free text and the exact conventions vary per NF. See the plan doc for the
// original examples this was built against.

export type MajorEventType =
  | 'radio_connect' | 'radio_disconnect'
  | 'ue_attach' | 'ue_detach'
  | 'ue_register' | 'ue_deregister'
  | 'pdu_session_up' | 'pdu_session_down'
  | 'bearer_setup_failure';

export interface MajorEvent {
  type: MajorEventType;
  imsi?: string;
  radioIp?: string;
  apn?: string;
  // bearer_setup_failure only — raw S1AP Cause IE (see S1AP_Cause.h/
  // S1AP_CauseRadioNetwork.h). causeGroup 1 = radioNetwork (37 =
  // not-supported-QCI-value, the real Nokia VoLTE bug this category exists
  // to catch; 27 = invalid-qos-combination). Frontend maps known values to
  // human-readable labels.
  causeGroup?: number;
  causeValue?: number;
}

// Same timestamp convention as log-streaming.ts's parseLogLine (open5gs writes these in the
// HOST's local time, not UTC — no "Z" suffix here, see that file's comment for why) —
// duplicated here rather than imported since that method is private to LogStreamingUseCase
// and this needs to run against raw grep output that never goes through that class.
export function parseOpen5gsTimestamp(line: string): string | null {
  const m = line.match(/^(\d{2})\/(\d{2})\s+(\d{2}:\d{2}:\d{2}\.\d{3}):/);
  if (!m) return null;
  const year = new Date().getFullYear();
  try {
    return new Date(`${year}-${m[1]}-${m[2]}T${m[3]}`).toISOString();
  } catch {
    return null;
  }
}

// Reverse of the above — used to reconstruct the exact "MM/DD HH:MM:SS.mmm" prefix a raw log
// line would have, so a specific line can be located again (e.g. for the "show me this line
// in context" feature). Reads LOCAL time getters deliberately, not UTC ones — the container's
// TZ is set to match the host (see docker-compose.yml), so this round-trips correctly with
// parseOpen5gsTimestamp above.
export function formatOpen5gsTimestamp(isoString: string): string | null {
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return null;
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${mm}/${dd} ${hh}:${mi}:${ss}.${ms}`;
}

interface EventRule {
  type: MajorEventType;
  // Restrict to specific NF log files — the same event keywords can mean different things
  // (or not appear at all) in other services' logs, and scoping avoids false positives.
  serviceScope: string[];
  test: RegExp;
}

const RULES: EventRule[] = [
  // Radio (eNodeB/gNodeB) SCTP association up/down
  { type: 'radio_connect',    serviceScope: ['mme'], test: /eNB-S1 accepted\[/ },
  { type: 'radio_connect',    serviceScope: ['amf'], test: /gNB-N2 accepted\[/ },
  { type: 'radio_disconnect', serviceScope: ['mme'], test: /eNB-S1\[[\d.]+\] connection refused/ },
  { type: 'radio_disconnect', serviceScope: ['amf'], test: /gNB-N2\[[\d.]+\] connection refused/ },

  // 4G attach/detach (MME)
  { type: 'ue_attach', serviceScope: ['mme'], test: /\bAttach complete\b/ },
  { type: 'ue_detach', serviceScope: ['mme'], test: /\bDetach request\b/ },

  // 5G registration/deregistration (AMF)
  { type: 'ue_register',   serviceScope: ['amf'], test: /\bRegistration complete\b/ },
  { type: 'ue_deregister', serviceScope: ['amf'], test: /\bDeregistration request\b/ },

  // PDU session establish/release (SMF) — "up" and "down" use different line shapes
  { type: 'pdu_session_up',   serviceScope: ['smf'], test: /UE IMSI\[\d+\] APN\[/ },
  { type: 'pdu_session_down', serviceScope: ['smf'], test: /Removed Session: UE IMSI:/ },

  // Dedicated/default E-RAB (bearer) setup rejected by the eNB — this is the exact log
  // shape produced by MME's s1ap_handle_e_rab_setup_response() when
  // E_RABFailedToSetupListBearerSURes is present (src/mme/s1ap-handler.c in the open5gs
  // repo, not this one): one "RAB_ID: %x" line per failed bearer immediately followed by
  // "    Cause[Group:%d Cause:%d]" — both at ogs_warn level, both inside the same loop
  // iteration. This rule matches the Cause[...] line specifically (not RAB_ID) because the
  // cause code is the actually-actionable data (e.g. radioNetwork cause 37 =
  // not-supported-QCI-value, the real bug behind the Nokia VoLTE investigation this
  // category was added for) — the E-RAB ID on the preceding line is not recoverable here
  // since classifyMajorEvent only ever sees one line at a time; use "click to view in
  // context" in the Major Events view to see it alongside the raw RAB_ID line.
  // InitialContextSetupFailure's own Cause (the very first/default bearer, at attach time)
  // is deliberately NOT covered — open5gs only logs it at ogs_debug, which won't appear in
  // this deployment's actual mme.log at its normal run-time log level.
  { type: 'bearer_setup_failure', serviceScope: ['mme'], test: /Cause\[Group:\d+ Cause:\d+\]/ },
];

// Derived from RULES — which services can ever produce a given event type. Lets callers skip
// grepping/tailing a log file entirely when the active event-type filter can't match it (e.g.
// filtering to just "PDU session up/down" never needs mme.log or amf.log).
export const EVENT_TYPE_SERVICES: Record<MajorEventType, string[]> = RULES.reduce((acc, rule) => {
  acc[rule.type] = [...(acc[rule.type] ?? []), ...rule.serviceScope];
  return acc;
}, {} as Record<MajorEventType, string[]>);

// grep -E patterns per service, hand-written in POSIX ERE (not derived from the JS RegExps
// above — \d isn't portable to grep -E, and these must stay simple/literal) — used to pull
// candidate lines directly out of multi-GB log files without tailing/parsing every line.
// Keep in sync with RULES above if event patterns change.
export const MAJOR_EVENT_GREP_PATTERNS: Record<string, string> = {
  mme: 'eNB-S1 accepted\\[|eNB-S1\\[[0-9.]+\\] connection refused|Attach complete|Detach request|Cause\\[Group:[0-9]+ Cause:[0-9]+\\]',
  amf: 'gNB-N2 accepted\\[|gNB-N2\\[[0-9.]+\\] connection refused|Registration complete|Deregistration request',
  smf: 'UE IMSI\\[[0-9]+\\] APN\\[|Removed Session: UE IMSI:',
};

// IMSI appears in five different in-line conventions across NFs — tried in priority order,
// normalized to the bare digit string so filtering works regardless of which NF logged it.
const IMSI_PATTERNS: RegExp[] = [
  /IMSI:\[imsi-(\d+)\]/,   // SMF "Removed Session: UE IMSI:[imsi-...]"
  /UE IMSI\[(\d+)\]/,      // SMF "UE IMSI[...] APN[...]"
  /SUPI:imsi-(\d+)/,       // SMF "[SUPI:imsi-...,PDU Session identity:...]"
  /\[imsi-(\d+)\]/,        // AMF "[imsi-...]"
  /\[(\d{15})\]/,          // MME bare "[999704281565023]" — exactly 15 digits to avoid false positives
];

function extractImsi(line: string): string | undefined {
  for (const re of IMSI_PATTERNS) {
    const m = line.match(re);
    if (m) return m[1];
  }
  return undefined;
}

const RADIO_IP_PATTERNS: RegExp[] = [
  /eNB-S1 accepted\[([\d.]+)\]/,
  /gNB-N2 accepted\[([\d.]+)\]/,
  /eNB-S1\[([\d.]+)\] connection refused/,
  /gNB-N2\[([\d.]+)\] connection refused/,
];

function extractRadioIp(line: string): string | undefined {
  for (const re of RADIO_IP_PATTERNS) {
    const m = line.match(re);
    if (m) return m[1];
  }
  return undefined;
}

function extractApn(line: string): string | undefined {
  const up = line.match(/APN\[([^\]]*)\]/);
  if (up) return up[1] || undefined;
  const down = line.match(/DNN:\[([^:\]]*)/);
  if (down) return down[1] || undefined;
  return undefined;
}

function extractBearerCause(line: string): { group: number; value: number } | undefined {
  const m = line.match(/Cause\[Group:(\d+) Cause:(\d+)\]/);
  if (!m) return undefined;
  return { group: Number(m[1]), value: Number(m[2]) };
}

// Human-readable label for a bearer_setup_failure's cause — only the values actually
// seen/documented on this deployment (see CLAUDE.md pattern #13 / the Nokia VoLTE
// investigation) are named; everything else falls back to the raw numbers. Used by
// qci-validation-controller.ts to explain a failed dedicated-bearer test; mirrored
// (independently, frontend/backend don't share code) in MajorEventsView.tsx for display.
const RADIO_NETWORK_CAUSE_LABELS: Record<number, string> = {
  27: 'invalid QoS combination',
  37: 'not supported QCI value',
};

export function describeBearerCause(causeGroup: number, causeValue: number): string {
  if (causeGroup === 1 && RADIO_NETWORK_CAUSE_LABELS[causeValue]) {
    return RADIO_NETWORK_CAUSE_LABELS[causeValue];
  }
  return `Group:${causeGroup} Cause:${causeValue}`;
}

export function classifyMajorEvent(line: string, service: string): MajorEvent | null {
  for (const rule of RULES) {
    if (!rule.serviceScope.includes(service)) continue;
    if (!rule.test.test(line)) continue;

    const event: MajorEvent = { type: rule.type };
    const imsi = extractImsi(line);
    if (imsi) event.imsi = imsi;
    const radioIp = extractRadioIp(line);
    if (radioIp) event.radioIp = radioIp;
    if (rule.type === 'pdu_session_up' || rule.type === 'pdu_session_down') {
      const apn = extractApn(line);
      if (apn) event.apn = apn;
    }
    if (rule.type === 'bearer_setup_failure') {
      const cause = extractBearerCause(line);
      if (cause) {
        event.causeGroup = cause.group;
        event.causeValue = cause.value;
      }
    }
    return event;
  }
  return null;
}
