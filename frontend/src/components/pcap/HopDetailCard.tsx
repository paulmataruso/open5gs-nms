import { CallFlow, FlowHop, SipTraceSource } from '../../api/sipTrace';

// Extracted from SipTraceTab.tsx unchanged.

const SOURCE_LABEL: Record<SipTraceSource, string> = {
  pcscf: 'P-CSCF', icscf: 'I-CSCF', scscf: 'S-CSCF', unknown: 'Unknown',
};
const fmtMs = (ms: number) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`);

// ── Detail for one selected hop ──────────────────────────────────────────────
//
// Opened by clicking an arrow in the ladder. Shows the parsed headers plus the
// verbatim message -- and, when both the sending and the receiving CSCF
// mirrored the same message, each tap's own copy. Those copies are normally
// byte-identical; where they are NOT, that difference is itself the finding
// (a proxy rewrote something in flight), so they are shown separately rather
// than silently de-duplicated here.
export function HopDetailCard({
  flow, hop, onClose,
}: { flow: CallFlow; hop: FlowHop; onClose: () => void }): JSX.Element {
  const ep = (id: string) => flow.endpoints.find(e => e.id === id);
  const observations = hop.messageRefs.map(r => flow.messages[r]).filter(Boolean);
  const identical = observations.length > 1
    && observations.every(o => o.raw === observations[0].raw);

  const facts: { k: string; v: string }[] = [
    { k: 'Message', v: hop.label },
    { k: 'From', v: `${ep(hop.from)?.label ?? hop.from}  (${hop.from})` },
    { k: 'To', v: `${ep(hop.to)?.label ?? hop.to}  (${hop.to})` },
    { k: 'Time', v: `${new Date(hop.timestamp).toLocaleTimeString()}  (${fmtMs(hop.offsetMs)} into the call)` },
    { k: 'Since previous', v: fmtMs(hop.deltaMs) },
    { k: 'CSeq', v: hop.cseqNumber !== undefined ? `${hop.cseqNumber} ${hop.cseqMethod ?? ''}`.trim() : '—' },
    { k: 'Observed by', v: hop.sources.map(x => SOURCE_LABEL[x]).join(', ') },
    { k: 'Call-ID', v: hop.callId },
  ];
  if (hop.retransmission) {
    facts.splice(1, 0, { k: 'Retransmission', v: 'yes — identical bytes sent again' });
  }

  return (
    <div className="rounded-lg border border-nms-accent/40 bg-nms-surface-2/40 p-3 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-xs font-semibold" style={{ color: `rgb(var(--nms-accent-rgb))` }}>
          {hop.label}
          <span className="text-nms-text-dim font-normal">
            {' '}· {ep(hop.from)?.label} → {ep(hop.to)?.label}
          </span>
        </h3>
        <button onClick={onClose} className="nms-btn-ghost text-[11px] px-2 py-0.5 shrink-0">Close</button>
      </div>

      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1">
        {facts.map(f => (
          <div key={f.k} className="flex gap-2 text-xs min-w-0">
            <dt className="text-nms-text-dim shrink-0 w-28">{f.k}</dt>
            <dd className="font-mono text-nms-text break-all min-w-0">{f.v}</dd>
          </div>
        ))}
      </dl>

      {observations.map((o, i) => (
        <div key={i} className="space-y-1">
          {observations.length > 1 && (
            <p className="text-[11px] text-nms-text-dim">
              As captured by {SOURCE_LABEL[o.source]}
              {i === 0 && identical && ' (all copies identical)'}
            </p>
          )}
          {(i === 0 || !identical) && (
            <pre className="text-[11px] font-mono text-nms-text whitespace-pre-wrap break-all max-h-96 overflow-y-auto bg-nms-bg/40 rounded p-2">
              {o.raw}
            </pre>
          )}
        </div>
      ))}
    </div>
  );
}
