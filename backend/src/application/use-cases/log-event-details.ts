// Extracts structured protocol details (TEID, S_NSSAI, PLMN, correlation IDs, etc.) from the
// raw log lines already fetched for a Major Events "view in context" card
// (GET /api/logs/context). Open5GS logs these consistently as `KEY[VALUE]` bracket tags
// (confirmed against real live amf/mme/smf.log output on this host, not documentation — see
// the examples at the bottom of this comment) — rather than hand-maintain a fixed field
// allowlist (which would miss anything not on the list, and go stale the moment a new
// Open5GS version logs a new tag), this scans generically for that bracket shape and returns
// whatever tags are actually present for the selected event. Two patterns that don't fit
// that shape (IMSI, SUCI) are special-cased.
//
// Scoping ("you must make sure the information is correct" — the fetched context window can
// span many unrelated UEs' activity; a busy log can have a different UE's own message cycle
// just a few lines from the selected event). Including every bracketed tag in the whole
// window would attribute another UE's TEID/S_NSSAI to the wrong event. Instead this walks
// outward from the matched line in both directions and stops each direction the moment it
// hits a line whose own IMSI or UE-context ID pair (RAN_UE_NGAP_ID/AMF_UE_NGAP_ID,
// ENB_UE_S1AP_ID/MME_UE_S1AP_ID) conflicts with what was established at the matched line —
// i.e. it collects exactly one "burst" of related lines. This is the same disambiguation
// technique used manually several times on this project to separate concurrent gNB/UE
// activity in these logs (matching IP/RAN_UE_NGAP_ID tags line-by-line) — productized here
// instead of being redone by hand each time.
//
// Real examples this was built against (all from live /var/log/open5gs/*.log on this host,
// 2026-09-29):
//   smf.log:  "SGW_S5C_TEID[0x523] SMF_N4_TEID[0xcc9]" / "SGW_S5U_TEID[0xcdd5] PGW_S5U_TEID[0x0]"
//   amf.log:  "S_NSSAI[SST:1 SD:0x19cde1]" / "RAN_UE_NGAP_ID[23] AMF_UE_NGAP_ID[767]" / "TAC[1] CellID[0x4001]"
//   mme.log:  "ENB_UE_S1AP_ID[44] MME_UE_S1AP_ID[42]" / "Cause[Group:1 Cause:20]" / "IP[10.0.2.214] ENB_ID[478]"
//
// Deliberately does NOT reach into other services' log files — every event type currently
// classified by major-event-classifier.ts has everything needed for this already inside its
// own service's log, within a tight burst around the matched line (confirmed against real
// samples for all of radio connect/disconnect, attach/detach, register/deregister, PDU
// session up/down, and bearer_setup_failure). If a future event type genuinely needs a
// different service's log to fill in a field, that's a real, concrete follow-up — don't
// speculatively build cross-file correlation before there's a proven case for it.

import { extractImsi } from './major-event-classifier';

export interface LogEventDetail {
  key: string;
  value: string;
}

// KEY[VALUE] — key must start with a letter, immediately followed by '[' (no space); value is
// anything but brackets. Confirmed safe against every real example above: no observed value
// itself contains '[' or ']'.
const BRACKET_TAG = /\b([A-Za-z][A-Za-z0-9_]*)\[([^[\]]*)\]/g;

// AMF/MME log the bare identity as e.g. "[imsi-...]"/"[suci-...]" with no preceding key — not
// a KEY[VALUE] pair. IMSI's version is handled by extractImsi (reused from the classifier,
// which already covers every in-line convention observed); SUCI has no equivalent there yet.
const SUCI_PATTERN = /\[(suci-[\w-]+)\]/;

// UE-context ID pairs that stay constant for one UE's entire signaling association within a
// service — used as the "same burst" test. Each service only ever logs its own pair.
const ID_PAIR_PATTERNS: RegExp[] = [
  /RAN_UE_NGAP_ID\[(\d+)\]\s+AMF_UE_NGAP_ID\[(\d+)\]/, // amf
  /ENB_UE_S1AP_ID\[(\d+)\]\s+MME_UE_S1AP_ID\[(\d+)\]/, // mme
];

interface LineCorrelation {
  imsi?: string;
  idPair?: string; // "23:767" composite, service-agnostic
}

function correlationOf(line: string): LineCorrelation {
  const imsi = extractImsi(line);
  for (const re of ID_PAIR_PATTERNS) {
    const m = line.match(re);
    if (m) return { imsi, idPair: `${m[1]}:${m[2]}` };
  }
  return { imsi };
}

// Does `line` belong to the same burst as the anchor correlation established at the matched
// line? A line with no correlation info of its own (e.g. a bare TEID line) never conflicts —
// it's included as long as the scan hasn't already stopped in that direction. A line naming a
// DIFFERENT IMSI or DIFFERENT ID pair than the anchor is a real conflict — that's the boundary.
function conflicts(anchor: LineCorrelation, line: string): boolean {
  const c = correlationOf(line);
  if (anchor.imsi && c.imsi && c.imsi !== anchor.imsi) return true;
  if (anchor.idPair && c.idPair && c.idPair !== anchor.idPair) return true;
  return false;
}

// Real bursts observed on this host (amf/mme registration+attach, smf PDU session) are all
// under 15 lines total. Kept tight deliberately, not just as a safety cap: a line with no
// correlation ID of its own (needed for multi-line fields like TEID/S_NSSAI, which never
// repeat the IMSI — see conflicts() above) is accepted as long as nothing conflicts, so a
// wider radius only enlarges the window where an unrelated burst's same-named tag could
// coincidentally slip in with no intervening tagged line to trip the boundary. 20 comfortably
// covers every real burst observed with margin, while keeping that window small.
const MAX_BURST_RADIUS = 20;

export function extractEventDetails(lines: string[], matchIndex: number): LogEventDetail[] {
  if (matchIndex < 0 || matchIndex >= lines.length) return [];

  // Establish the anchor from the matched line itself, falling back to a small immediate
  // window if the matched line alone doesn't carry one — e.g. bearer_setup_failure's
  // "Cause[...]" line never does (see major-event-classifier.ts's own comment on that rule);
  // its ID pair is on the line immediately before it.
  let anchor = correlationOf(lines[matchIndex]);
  for (let r = 1; r <= 5 && !anchor.imsi && !anchor.idPair; r++) {
    if (matchIndex - r >= 0) anchor = correlationOf(lines[matchIndex - r]);
    if (!anchor.imsi && !anchor.idPair && matchIndex + r < lines.length) {
      anchor = correlationOf(lines[matchIndex + r]);
    }
  }

  const burst: Array<{ line: string; distance: number }> = [{ line: lines[matchIndex], distance: 0 }];
  for (let i = matchIndex - 1, d = 1; i >= Math.max(0, matchIndex - MAX_BURST_RADIUS); i--, d++) {
    if (conflicts(anchor, lines[i])) break;
    burst.push({ line: lines[i], distance: d });
  }
  for (let i = matchIndex + 1, d = 1; i < Math.min(lines.length, matchIndex + MAX_BURST_RADIUS + 1); i++, d++) {
    if (conflicts(anchor, lines[i])) break;
    burst.push({ line: lines[i], distance: d });
  }

  // key -> closest value. The same key can repeat with a different value within a burst (a
  // handover reassigning an NGAP ID, e.g.) — keep whichever occurrence is nearest the matched
  // line, since that's most representative of the selected event itself.
  const seen = new Map<string, { value: string; distance: number }>();
  const record = (key: string, value: string, distance: number) => {
    const existing = seen.get(key);
    if (!existing || distance < existing.distance) seen.set(key, { value, distance });
  };

  for (const { line, distance } of burst) {
    BRACKET_TAG.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = BRACKET_TAG.exec(line)) !== null) {
      const [, key, value] = m;
      if (value.trim() === '') continue; // e.g. a stray "Foo[]" — nothing useful to show
      record(key, value, distance);
    }
    const suci = line.match(SUCI_PATTERN);
    if (suci) record('SUCI', suci[1], distance);
    const imsi = extractImsi(line);
    if (imsi) record('IMSI', imsi, distance);
  }

  return [...seen.entries()]
    .map(([key, { value }]) => ({ key, value }))
    .sort((a, b) => a.key.localeCompare(b.key));
}
