import { useMemo } from 'react';
import clsx from 'clsx';
import { CallFlow, FlowHop, HopClass } from '../../api/sipTrace';

// ── End-to-end call flow ladder ──────────────────────────────────────────────
//
// The sngrep-style view: one column per endpoint, one row per real SIP message
// in time order, an arrow in the direction it travelled. This is the view that
// answers "what happened on this call"; the raw message table beside it
// answers "what exactly did we capture", and both are kept.
//
// Built as HTML rather than SVG specifically so each arrow is a real <button>:
// the whole point is that a hop is clickable and openable, which in SVG means
// hand-rolling focus, keyboard activation and hit targets. Here the browser
// gives all three, and the keyboard order follows the call.

const COL_W = 164;
const GUTTER = 92;         // left column: time offset
const RIGHT_GUTTER = 96;   // right column: CSeq -- its own lane, so it can
                           // never sit on top of the last endpoint's arrows
const ROW_H = 46;

/** Theme-token colour per SIP response class. Never a literal colour. */
const CLS_VAR: Record<HopClass, string> = {
  request: '--nms-accent-rgb',
  provisional: '--nms-amber-rgb',
  success: '--nms-green-rgb',
  redirect: '--nms-amber-rgb',
  'client-error': '--nms-red-rgb',
  'server-error': '--nms-red-rgb',
  'global-error': '--nms-red-rgb',
};

function fmtOffset(ms: number): string {
  if (ms < 1000) return `+${ms}ms`;
  const s = ms / 1000;
  return s < 60 ? `+${s.toFixed(2)}s` : `+${Math.floor(s / 60)}m${String(Math.floor(s % 60)).padStart(2, '0')}s`;
}

export function CallFlowLadder({
  flow,
  selected,
  onSelect,
}: {
  flow: CallFlow;
  selected: number | null;
  onSelect: (hop: FlowHop) => void;
}): JSX.Element {
  const xOf = useMemo(() => {
    const idx = new Map(flow.endpoints.map((e, i) => [e.id, i]));
    return (id: string) => GUTTER + (idx.get(id) ?? 0) * COL_W + COL_W / 2;
  }, [flow.endpoints]);

  if (flow.endpoints.length === 0 || flow.hops.length === 0) {
    return <p className="text-xs text-nms-text-dim py-4">No messages to draw a flow from.</p>;
  }

  const width = GUTTER + flow.endpoints.length * COL_W + RIGHT_GUTTER;
  const bodyH = flow.hops.length * ROW_H;

  return (
    <div className="overflow-x-auto">
      <div style={{ width, minWidth: width }} className="relative">
        {/* Column headers */}
        <div className="relative" style={{ height: 46 }}>
          {flow.endpoints.map(e => (
            <div
              key={e.id}
              className="absolute text-center"
              style={{ left: xOf(e.id) - COL_W / 2, width: COL_W, top: 0 }}
              title={e.address}
            >
              <div
                className={clsx(
                  'text-[11px] font-semibold truncate px-1',
                  e.role === 'ue' ? 'text-nms-text' : 'text-nms-accent',
                )}
              >
                {e.label}
              </div>
              <div className="text-[10px] font-mono text-nms-text-dim truncate px-1">{e.address}</div>
            </div>
          ))}
        </div>

        {/* Lifelines, behind the rows */}
        <div className="relative" style={{ height: bodyH }}>
          {flow.endpoints.map(e => (
            <div
              key={e.id}
              aria-hidden="true"
              className="absolute top-0 bg-nms-border-strong"
              style={{ left: xOf(e.id), width: 1, height: bodyH }}
            />
          ))}

          {flow.hops.map(hop => {
            const x1 = xOf(hop.from);
            const x2 = xOf(hop.to);
            const self = x1 === x2;
            const left = Math.min(x1, x2);
            const w = Math.max(Math.abs(x2 - x1), 26);
            const rightward = x2 >= x1;
            const colour = `rgb(var(${CLS_VAR[hop.cls]}))`;
            const isSel = selected === hop.index;

            return (
              <button
                key={hop.index}
                type="button"
                onClick={() => onSelect(hop)}
                aria-pressed={isSel}
                aria-label={
                  `${fmtOffset(hop.offsetMs)}: ${hop.label} from ` +
                  `${flow.endpoints.find(e => e.id === hop.from)?.label ?? hop.from} to ` +
                  `${flow.endpoints.find(e => e.id === hop.to)?.label ?? hop.to}` +
                  `${hop.retransmission ? ', retransmission' : ''}. Show details.`
                }
                className={clsx(
                  'absolute left-0 w-full text-left transition-colors',
                  isSel ? 'bg-nms-accent/10' : 'hover:bg-nms-surface-2/60',
                )}
                style={{ top: hop.index * ROW_H, height: ROW_H }}
              >
                {/* Time offset */}
                <span
                  className="absolute text-[10px] font-mono text-nms-text-dim"
                  style={{ left: 6, top: ROW_H / 2 - 6, width: GUTTER - 12 }}
                >
                  {fmtOffset(hop.offsetMs)}
                </span>

                {/* Arrow label, sitting above the line */}
                <span
                  className="absolute text-[11px] font-medium text-center truncate"
                  style={{
                    left: self ? x1 : left,
                    width: self ? COL_W / 2 : w,
                    top: ROW_H / 2 - 17,
                    color: colour,
                  }}
                >
                  {hop.label}
                  {hop.retransmission && <span className="text-nms-text-dim"> (retx)</span>}
                </span>

                {/* The line */}
                <span
                  aria-hidden="true"
                  className="absolute"
                  style={{
                    left,
                    width: w,
                    top: ROW_H / 2,
                    height: 0,
                    borderTopWidth: 2,
                    borderTopStyle: hop.retransmission ? 'dashed' : 'solid',
                    borderTopColor: colour,
                  }}
                />

                {/* Arrowhead at the destination */}
                <span
                  aria-hidden="true"
                  className="absolute"
                  style={{
                    left: (rightward ? left + w : left) - 5,
                    top: ROW_H / 2 - 4,
                    width: 0,
                    height: 0,
                    borderTop: '5px solid transparent',
                    borderBottom: '5px solid transparent',
                    ...(rightward
                      ? { borderLeft: `7px solid ${colour}` }
                      : { borderRight: `7px solid ${colour}`, left: left - 2 }),
                  }}
                />

                {/* CSeq + which taps saw it, on the right */}
                <span
                  className="absolute text-[10px] font-mono text-nms-text-dim truncate"
                  style={{
                    left: GUTTER + flow.endpoints.length * COL_W + 8,
                    top: ROW_H / 2 - 5,
                    width: RIGHT_GUTTER - 14,
                  }}
                >
                  {hop.cseqNumber !== undefined ? `${hop.cseqNumber} ${hop.cseqMethod ?? ''}` : ''}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
