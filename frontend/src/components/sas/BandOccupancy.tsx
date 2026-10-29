import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import type {
  SasProtection, SasPpa, SasSpectrumGrant, SasSpectrumCbsd,
} from '../../api/sas';

// ── Band occupancy ──────────────────────────────────────────────────────────
// The CBRS band as a frequency axis, with GAA availability, PAL channels,
// protections and every live grant packed into lanes — a recreation of
// SASBench's own band plan, in this NMS's theme, from the same
// /api/v1/spectrum data so the two cannot disagree about one band.
//
// Read-only, like the rest of the SAS page: grants are changed in SASBench.
//
// Why a hand-rolled SVG rather than a charting library: every row here is a
// range on a shared axis, not a series of points. The recharts-based pages in
// this project draw time series, which is a different shape — a BarChart with
// a numeric x domain can be coerced into looking like this, but hit-testing a
// range and packing overlapping ranges into lanes both end up hand-written
// anyway, and the library then only costs layout control and bundle size.

/**
 * Per-radio identity colours. Deliberately literal hex, which is otherwise
 * against this project's theme-token rule (CLAUDE.md) — the exception is
 * narrow and intentional: this is DATA identity, not UI chrome. A radio must
 * keep the same colour when the operator switches theme, or the chart and its
 * legend stop meaning the same thing from one moment to the next. All five
 * themes are dark, so one palette is legible on every surface. Same reasoning
 * and the same kind of palette as SubscriberPage's GROUP_COLORS.
 */
const CBSD_COLORS = [
  '#60a5fa', '#f472b6', '#fbbf24', '#34d399',
  '#a78bfa', '#fb923c', '#22d3ee', '#e879f9',
  '#4ade80', '#f87171', '#818cf8', '#2dd4bf',
];

/** Stable colour for a radio: index by first appearance, not by hash. */
function colorMap(ids: string[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const id of ids) {
    if (!m.has(id)) m.set(id, CBSD_COLORS[m.size % CBSD_COLORS.length]);
  }
  return m;
}

/**
 * Pack ranges into as few rows as possible without two of them touching.
 * Overlapping grants are the normal case on GAA, and stacking every grant on
 * its own row would make a 9-grant band nine rows tall for no reason.
 */
function packLanes<T extends { low: number; high: number }>(items: T[]): T[][] {
  const lanes: T[][] = [];
  const ends: number[] = [];
  for (const it of [...items].sort((a, b) => a.low - b.low || a.high - b.high)) {
    let i = ends.findIndex(e => e <= it.low);
    if (i < 0) { i = lanes.length; lanes.push([]); ends.push(0); }
    lanes[i].push(it);
    ends[i] = it.high;
  }
  return lanes;
}

function useWidth<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(e => setW(Math.floor(e[0].contentRect.width)));
    ro.observe(el);
    setW(Math.floor(el.getBoundingClientRect().width));
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

const mhz = (hz: number) => hz / 1e6;
/** Trim trailing zeros so 3550 reads as "3550", not "3550.0". */
const fmtMhz = (hz: number) => {
  const v = mhz(hz);
  return (Number.isInteger(v) ? v.toFixed(0) : v.toFixed(1));
};

const PROT_LABEL: Record<string, string> = {
  DPA: 'DPA', ESC: 'ESC', FSS_GWBL: 'FSS+GWBL', GWPZ: 'GWPZ',
  EXCLUSION_ZONE: 'Excl. zone', EXCLUSION: 'Exclusion', FSS: 'FSS', ADMIN: 'Admin',
};
const PROT_ORDER = ['DPA', 'ESC', 'FSS_GWBL', 'GWPZ', 'EXCLUSION_ZONE', 'EXCLUSION', 'FSS', 'ADMIN'];
const protRank = (k: string) => {
  const i = PROT_ORDER.indexOf(k);
  return i < 0 ? PROT_ORDER.length : i;
};

/** Sub-ranges a protection currently blocks; empty while it is inactive. */
function protRanges(p: SasProtection): Array<{ low: number; high: number }> {
  if (!p.active) return [];
  if (p.channels && p.channels.length) return p.channels.map(c => ({ low: c[0], high: c[1] }));
  return [{ low: p.low, high: p.high }];
}

type Hover =
  | { t: 'grant'; g: SasSpectrumGrant }
  | { t: 'prot'; kind: string; names: string[]; low: number; high: number; action: string }
  | { t: 'pal'; name: string; palId: string | null; low: number; high: number }
  | null;

const AXIS_H = 26;
const ROW_H = 18;
const ROW_GAP = 5;
const SECTION_GAP = 12;

export function BandOccupancy({
  band, gaaRanges, protections, ppas, grants, cbsds,
}: {
  band: { low: number; high: number };
  gaaRanges: Array<{ low: number; high: number }>;
  protections: SasProtection[];
  ppas: SasPpa[];
  grants: SasSpectrumGrant[];
  cbsds: SasSpectrumCbsd[];
}): JSX.Element {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<Hover>(null);

  const bLow = band.low;
  const bHigh = band.high;
  const span = Math.max(1, bHigh - bLow);

  // Narrow viewports get a smaller label gutter; below ~520px the chart
  // scrolls horizontally rather than compressing 150 MHz into a phone width.
  const gutter = width < 560 ? 64 : 96;
  const plotW = Math.max(120, width - gutter - 12);
  const x = (f: number) => gutter + ((Math.min(Math.max(f, bLow), bHigh) - bLow) / span) * plotW;
  const wOf = (lo: number, hi: number) => Math.max(1, x(hi) - x(lo));

  const byId = useMemo(() => new Map(cbsds.map(c => [c.cbsdId, c])), [cbsds]);
  const colors = useMemo(
    () => colorMap([...grants].sort((a, b) => a.low - b.low).map(g => g.cbsdId)),
    [grants],
  );

  const model = useMemo(() => {
    const clip = <T extends { low: number; high: number }>(r: T): T | null => {
      const low = Math.max(r.low, bLow);
      const high = Math.min(r.high, bHigh);
      return high > low ? { ...r, low, high } : null;
    };

    const pal = ppas.flatMap(p =>
      p.channels.map(c => clip({ low: c.low, high: c.high, name: p.name, palId: c.palId })),
    ).filter(Boolean) as Array<{ low: number; high: number; name: string; palId: string | null }>;

    const kinds = [...new Set(protections.map(p => p.kind))]
      .sort((a, b) => protRank(a) - protRank(b) || a.localeCompare(b));
    const prot = kinds.map(kind => {
      const list = protections.filter(p => p.kind === kind);
      // Collapse protections blocking the identical range into one block, so
      // 30 DPAs over one range draw once and name all 30 on hover.
      const groups = new Map<string, { low: number; high: number; action: string; names: string[] }>();
      for (const p of list) {
        for (const r of protRanges(p)) {
          const c = clip(r);
          if (!c) continue;
          const key = `${c.low}-${c.high}-${p.action}`;
          const g = groups.get(key) ?? { low: c.low, high: c.high, action: p.action, names: [] };
          g.names.push(p.name);
          groups.set(key, g);
        }
      }
      return {
        kind,
        total: list.length,
        active: list.filter(p => p.active).length,
        blocks: [...groups.values()],
      };
    });

    const gaa = gaaRanges.map(r => clip(r)).filter(Boolean) as Array<{ low: number; high: number }>;
    const live = grants.map(g => clip(g)).filter(Boolean) as SasSpectrumGrant[];
    return { pal, palLanes: packLanes(pal), prot, gaa, grantLanes: packLanes(live) };
  }, [band, bLow, bHigh, gaaRanges, protections, ppas, grants]);

  // Vertical layout: one pass, so every row's y is decided in one place.
  let y = AXIS_H + 4;
  const row = () => { const v = y; y += ROW_H + ROW_GAP; return v; };
  const gaaY = row();
  y += SECTION_GAP - ROW_GAP;
  const palYs = model.palLanes.length ? model.palLanes.map(() => row()) : [];
  if (palYs.length) y += SECTION_GAP - ROW_GAP;
  const protYs = model.prot.length ? model.prot.map(() => row()) : [];
  if (protYs.length) y += SECTION_GAP - ROW_GAP;
  const grantYs = (model.grantLanes.length ? model.grantLanes : [[]]).map(() => row());
  const height = y + 4;

  // Axis ticks: aim for ~8, snapped to a round MHz step.
  const ticks = useMemo(() => {
    const target = width < 560 ? 4 : 8;
    const stepMhz = [5, 10, 20, 25, 50, 100].find(s => mhz(span) / s <= target) ?? 100;
    const step = stepMhz * 1e6;
    const out: number[] = [];
    for (let f = Math.ceil(bLow / step) * step; f <= bHigh; f += step) out.push(f);
    if (out[0] !== bLow) out.unshift(bLow);
    if (out[out.length - 1] !== bHigh) out.push(bHigh);
    return out;
  }, [bLow, bHigh, span, width]);

  const label = (
    `CBRS band ${fmtMhz(bLow)} to ${fmtMhz(bHigh)} MHz. `
    + `${grants.length} live grant${grants.length === 1 ? '' : 's'}`
    + `${model.prot.length ? `, ${model.prot.reduce((n, p) => n + p.active, 0)} active protections` : ''}`
    + `. Every grant is also listed in the table below.`
  );

  return (
    <div ref={ref} className="w-full">
      {width > 0 && (
        <div className="relative">
          <svg
            width={width}
            height={height}
            role="img"
            aria-label={label}
            className="overflow-visible"
          >
            <defs>
              {/* Hatch for spectrum that is not GAA-available. */}
              <pattern id="sas-nogaa" width="6" height="6" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
                <rect width="6" height="6" className="fill-nms-surface-2" />
                <line x1="0" y1="0" x2="0" y2="6" className="stroke-nms-border-strong" strokeWidth="2" />
              </pattern>
              {/* Hatch for a protection that blocks by terminating grants. */}
              <pattern id="sas-term" width="5" height="5" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
                <rect width="5" height="5" className="fill-nms-red/20" />
                <line x1="0" y1="0" x2="0" y2="5" className="stroke-nms-red" strokeWidth="1.5" />
              </pattern>
            </defs>

            {/* Axis */}
            {ticks.map(f => (
              <g key={f}>
                <line
                  x1={x(f)} y1={AXIS_H - 6} x2={x(f)} y2={height}
                  className="stroke-nms-border" strokeWidth="1"
                />
                <text
                  x={x(f)} y={AXIS_H - 10}
                  textAnchor={f === bLow ? 'start' : f === bHigh ? 'end' : 'middle'}
                  className="fill-nms-text-dim text-[10px] font-mono"
                >
                  {fmtMhz(f)}
                </text>
              </g>
            ))}

            {/* GAA availability: hatched track, with available ranges filled over it */}
            <text x={gutter - 8} y={gaaY + 13} textAnchor="end" className="fill-nms-text-dim text-[10px]">
              GAA
            </text>
            <rect
              x={gutter} y={gaaY} width={plotW} height={ROW_H}
              fill="url(#sas-nogaa)" rx="2"
            />
            {model.gaa.map(r => (
              <rect
                key={`${r.low}-${r.high}`}
                x={x(r.low)} y={gaaY} width={wOf(r.low, r.high)} height={ROW_H}
                className="fill-nms-surface-2 stroke-nms-border-strong" strokeWidth="1" rx="2"
              />
            ))}

            {/* PAL / PPA channels */}
            {model.palLanes.map((lane, i) => (
              <g key={`pal-${i}`}>
                {i === 0 && (
                  <text x={gutter - 8} y={palYs[0] + 13} textAnchor="end" className="fill-nms-text-dim text-[10px]">
                    PAL
                  </text>
                )}
                {lane.map(p => (
                  <rect
                    key={`${p.name}-${p.low}-${p.high}`}
                    x={x(p.low)} y={palYs[i]} width={wOf(p.low, p.high)} height={ROW_H}
                    className="fill-nms-amber/30 stroke-nms-amber cursor-pointer" strokeWidth="1" rx="2"
                    onMouseEnter={() => setHover({ t: 'pal', name: p.name, palId: p.palId, low: p.low, high: p.high })}
                    onMouseLeave={() => setHover(null)}
                  />
                ))}
              </g>
            ))}

            {/* Protections, one row per kind */}
            {model.prot.map((p, i) => (
              <g key={p.kind}>
                <text x={gutter - 8} y={protYs[i] + 13} textAnchor="end" className="fill-nms-text-dim text-[10px]">
                  {PROT_LABEL[p.kind] ?? p.kind}
                </text>
                {p.blocks.length === 0 && (
                  <text x={gutter + 4} y={protYs[i] + 13} className="fill-nms-text-dim text-[10px]">
                    {p.total} defined, none active
                  </text>
                )}
                {p.blocks.map(b => (
                  <rect
                    key={`${b.low}-${b.high}-${b.action}`}
                    x={x(b.low)} y={protYs[i]} width={wOf(b.low, b.high)} height={ROW_H}
                    fill={b.action === 'terminate' ? 'url(#sas-term)' : undefined}
                    className={`cursor-pointer ${b.action === 'terminate' ? 'stroke-nms-red' : 'fill-nms-amber/25 stroke-nms-amber'}`}
                    strokeWidth="1" rx="2"
                    onMouseEnter={() => setHover({ t: 'prot', kind: p.kind, names: b.names, low: b.low, high: b.high, action: b.action })}
                    onMouseLeave={() => setHover(null)}
                  />
                ))}
              </g>
            ))}

            {/* Live grants, packed into lanes and coloured per radio */}
            {model.grantLanes.map((lane, i) => (
              <g key={`gl-${i}`}>
                {i === 0 && (
                  <text x={gutter - 8} y={grantYs[0] + 13} textAnchor="end" className="fill-nms-text-dim text-[10px]">
                    Grants
                  </text>
                )}
                {lane.map(g => {
                  const c = colors.get(g.cbsdId) ?? CBSD_COLORS[0];
                  const w = wOf(g.low, g.high);
                  const cb = byId.get(g.cbsdId);
                  return (
                    <g key={g.grantId}>
                      <rect
                        x={x(g.low)} y={grantYs[i]} width={w} height={ROW_H}
                        rx="2"
                        fill={c}
                        fillOpacity={g.suspended ? 0.2 : 0.55}
                        stroke={c}
                        strokeWidth="1"
                        strokeDasharray={g.state === 'GRANTED' ? '3 2' : undefined}
                        className="cursor-pointer"
                        onMouseEnter={() => setHover({ t: 'grant', g })}
                        onMouseLeave={() => setHover(null)}
                      />
                      {/* Only label a block wide enough to hold the text. */}
                      {w > 54 && (
                        <text
                          x={x(g.low) + 4} y={grantYs[i] + 13}
                          className="fill-nms-text text-[10px] font-mono pointer-events-none"
                        >
                          {cb?.serial ? cb.serial.slice(-6) : `${fmtMhz(g.high - g.low)}M`}
                        </text>
                      )}
                    </g>
                  );
                })}
              </g>
            ))}
            {model.grantLanes.length === 0 && (
              <text x={gutter + 4} y={grantYs[0] + 13} className="fill-nms-text-dim text-[10px]">
                No live grants
              </text>
            )}
          </svg>

          {/* Hover detail. Rendered under the chart rather than as a floating
              tooltip: it never covers the ranges being compared, and it needs
              no positioning maths that could push it off-screen. */}
          <div className="mt-2 min-h-[2.25rem] text-xs">
            {hover === null && (
              <p className="text-nms-text-dim">
                Hover a block for detail. A dashed edge is a grant not yet authorized;
                a faded one is suspended.
              </p>
            )}
            {hover?.t === 'grant' && (() => {
              const cb = byId.get(hover.g.cbsdId);
              return (
                <p className="text-nms-text">
                  <span
                    className="inline-block w-2.5 h-2.5 rounded-sm align-middle mr-1.5"
                    style={{ backgroundColor: colors.get(hover.g.cbsdId) }}
                  />
                  <span className="font-mono">{cb?.serial ?? hover.g.cbsdId}</span>
                  {cb?.fccId && <span className="text-nms-text-dim"> · {cb.fccId}</span>}
                  <span className="text-nms-text-dim"> · </span>
                  <span className="font-mono">
                    {fmtMhz(hover.g.low)}–{fmtMhz(hover.g.high)} MHz
                  </span>
                  <span className="text-nms-text-dim"> ({fmtMhz(hover.g.high - hover.g.low)} MHz wide)</span>
                  <span className="text-nms-text-dim"> · </span>
                  <span className="font-mono">{hover.g.maxEirp} dBm/MHz</span>
                  <span className="text-nms-text-dim"> · {hover.g.channelType} · {hover.g.state}</span>
                  {hover.g.suspended && <span className="text-nms-amber"> · suspended</span>}
                </p>
              );
            })()}
            {hover?.t === 'prot' && (
              <p className="text-nms-text">
                <span className={hover.action === 'terminate' ? 'text-nms-red' : 'text-nms-amber'}>
                  {PROT_LABEL[hover.kind] ?? hover.kind}
                </span>
                <span className="text-nms-text-dim"> · </span>
                <span className="font-mono">{fmtMhz(hover.low)}–{fmtMhz(hover.high)} MHz</span>
                <span className="text-nms-text-dim">
                  {' · '}{hover.action === 'terminate' ? 'terminates' : 'suspends'} overlapping grants
                </span>
                <span className="text-nms-text-dim block mt-0.5 break-words">
                  {hover.names.slice(0, 6).join(', ')}
                  {hover.names.length > 6 && ` +${hover.names.length - 6} more`}
                </span>
              </p>
            )}
            {hover?.t === 'pal' && (
              <p className="text-nms-text">
                <span className="text-nms-amber">PAL</span>
                <span className="text-nms-text-dim"> · </span>
                <span className="font-mono">{fmtMhz(hover.low)}–{fmtMhz(hover.high)} MHz</span>
                <span className="text-nms-text-dim"> · {hover.name}</span>
                {hover.palId && <span className="text-nms-text-dim"> · {hover.palId}</span>}
              </p>
            )}
          </div>

          {/* Legend: which colour is which radio. */}
          {colors.size > 0 && (
            <ul className="mt-3 pt-3 border-t border-nms-border flex flex-wrap gap-x-4 gap-y-1.5">
              {[...colors.entries()].map(([id, c]) => {
                const cb = byId.get(id);
                return (
                  <li key={id} className="flex items-center gap-1.5 text-xs">
                    <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: c }} />
                    <span className="font-mono text-nms-text">{cb?.serial ?? id.slice(0, 10)}</span>
                    {cb?.category && <span className="text-nms-text-dim">Cat {cb.category}</span>}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
