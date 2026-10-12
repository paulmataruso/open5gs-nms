// ── Minimal SIP parsing, for indexing and display only ───────────────────────
//
// Deliberately NOT a general SIP stack. The raw message is always stored
// verbatim and is what the UI shows for detail; this extracts just the fields
// needed to group messages into calls, order a ladder diagram, and make the
// list searchable. Anything it cannot understand degrades to undefined rather
// than throwing -- a trace viewer that drops a malformed message is strictly
// worse than one that shows it with fewer labels, because a malformed message
// is often exactly what you are trying to find.

export interface ParsedSip {
  /** Request method, e.g. INVITE. Absent on responses. */
  method?: string;
  /** Response code, e.g. 200. Absent on requests. */
  statusCode?: number;
  /** Response reason phrase, e.g. "OK". */
  statusReason?: string;
  /** The method this response answers, taken from CSeq. */
  cseqMethod?: string;
  cseqNumber?: number;
  callId?: string;
  fromUri?: string;
  fromDisplay?: string;
  toUri?: string;
  toDisplay?: string;
  /** First line, verbatim -- handy as a compact label. */
  startLine: string;
  isRequest: boolean;
}

/** Compact header names SIP allows as aliases (RFC 3261 §20). */
const COMPACT: Record<string, string> = {
  i: 'call-id',
  f: 'from',
  t: 'to',
  v: 'via',
  m: 'contact',
  s: 'subject',
  l: 'content-length',
  c: 'content-type',
  k: 'supported',
  e: 'content-encoding',
  o: 'event',
  r: 'refer-to',
  b: 'referred-by',
  x: 'session-expires',
};

function headerName(raw: string): string {
  const n = raw.trim().toLowerCase();
  return COMPACT[n] ?? n;
}

/**
 * Pull `name` out of the header block. Returns the first occurrence, which is
 * the correct choice for the single-instance headers this reads (Call-ID,
 * From, To, CSeq) -- notably NOT correct for Via/Record-Route, which this
 * does not read.
 */
function header(lines: string[], name: string): string | undefined {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === '') break; // end of headers
    const c = line.indexOf(':');
    if (c <= 0) continue;
    if (headerName(line.slice(0, c)) !== name) continue;
    let value = line.slice(c + 1).trim();
    // Fold continuation lines (a leading space or tab continues the previous
    // header). Long Contact/From headers really do wrap in practice.
    while (i + 1 < lines.length && /^[ \t]/.test(lines[i + 1])) {
      value += ' ' + lines[++i].trim();
    }
    return value;
  }
  return undefined;
}

/** Split a name-addr like `"Bob" <sip:bob@x>;tag=1` into display + uri. */
function nameAddr(value: string | undefined): { uri?: string; display?: string } {
  if (!value) return {};
  const angle = value.match(/^(.*?)<([^>]+)>/);
  if (angle) {
    let display = angle[1].trim().replace(/^"(.*)"$/, '$1').trim();
    return { display: display || undefined, uri: angle[2].trim() };
  }
  // No angle brackets: the URI runs to the first `;` parameter.
  const bare = value.split(';')[0].trim();
  return { uri: bare || undefined };
}

export function parseSipMessage(raw: string): ParsedSip {
  // SIP is CRLF-delimited, but a capture agent or a hand-written test fixture
  // may use bare LF; normalise so neither breaks header splitting.
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const startLine = (lines[0] ?? '').trim();

  const out: ParsedSip = { startLine, isRequest: false };

  const statusMatch = startLine.match(/^SIP\/2\.0\s+(\d{3})\s*(.*)$/i);
  if (statusMatch) {
    out.statusCode = parseInt(statusMatch[1], 10);
    out.statusReason = statusMatch[2].trim() || undefined;
  } else {
    const reqMatch = startLine.match(/^([A-Za-z]+)\s+(\S+)\s+SIP\/2\.0$/);
    if (reqMatch) {
      out.method = reqMatch[1].toUpperCase();
      out.isRequest = true;
    }
  }

  const body = lines.slice(1);
  out.callId = header(body, 'call-id');

  const cseq = header(body, 'cseq');
  if (cseq) {
    const m = cseq.match(/^(\d+)\s+([A-Za-z]+)/);
    if (m) {
      out.cseqNumber = parseInt(m[1], 10);
      out.cseqMethod = m[2].toUpperCase();
    }
  }

  const from = nameAddr(header(body, 'from'));
  out.fromUri = from.uri;
  out.fromDisplay = from.display;
  const to = nameAddr(header(body, 'to'));
  out.toUri = to.uri;
  out.toDisplay = to.display;

  return out;
}

/** `sip:001010000000001@ims.mnc001.mcc001.3gppnetwork.org` -> the user part. */
export function sipUser(uri: string | undefined): string | undefined {
  if (!uri) return undefined;
  const m = uri.match(/^(?:sips?|tel):([^@;?]+)/i);
  return m ? m[1] : undefined;
}

/**
 * A short label for a message in the ladder. Responses carry the method they
 * answer, because a bare "200" tells you nothing about which transaction it
 * belongs to when REGISTER, INVITE and BYE are all in flight.
 */
export function messageLabel(p: ParsedSip): string {
  if (p.method) return p.method;
  if (p.statusCode) {
    const m = p.cseqMethod ? ` (${p.cseqMethod})` : '';
    return `${p.statusCode}${p.statusReason ? ' ' + p.statusReason : ''}${m}`;
  }
  return p.startLine.slice(0, 40) || 'malformed';
}
