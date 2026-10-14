import type PDFDocument from 'pdfkit';

// PDF report for a simulate run.
//
// Distinct from the older projects report (rf-planning-reports-controller.ts),
// which renders a SAVED project's stored sites from the legacy schema. This one
// renders what is on screen right now, including the coverage raster, because
// the thing an operator wants to hand to someone else is the picture plus the
// numbers that produced it.
//
// The map image is rendered by the CLIENT and posted here as a PNG. That is
// deliberate: embedding a server-rendered raster would need either the native
// `canvas` package or a headless browser in the image, and the browser has
// already drawn exactly this picture. The older report's header comment flags
// its own missing map as a known fidelity gap — this is that gap closed, at the
// cost of trusting the client for one decorative image (its bytes are
// magic-byte checked and size-capped before they reach pdfkit).

export interface ReportRadio {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  azimuthDeg: number;
  beamWidthDeg: number;
  technology: string;
  frequencyGhz: number;
  bandwidthMhz: number;
  txPowerDbm: number;
  antennaHeightM: number;
  mechanicalDowntiltDeg: number;
  sectorOf?: string | null;
}

export interface ReportInput {
  title: string;
  generatedAt: Date;
  model: { id: string; label: string; source: string; blurb: string };
  settings: { radiusM: number; rays: number; buildingsConsidered: number };
  warnings: string[];
  radios: ReportRadio[];
  cells: {
    cellId: string; name: string | null; azimuthDeg: number;
    stats: {
      avgReachM: number; minReachM: number; maxReachM: number; blockedRayPct: number;
      wallEventTotal: number; declinedSamples: number; raysEvaluated: number;
    };
  }[];
  quality: { qualityClass: string; interferenceLimited: boolean }[];
  resourceGrid: { resourceBlocks: number; subcarrierSpacingKhz: number; measurementFamily: string; bandwidthMhz: number } | null;
  gaps: {
    cellId: string;
    summary: { candidateBuildings: number; gapBuildings: number; demandServedPct: number; serviceThresholdDbm: number };
    gaps: { buildingId: string; combinedDemand: number; bestRxDbm: number | null; distanceM: number }[];
  }[] | null;
  heatmap?: {
    png: Buffer;
    metric: string;
    legend: { label: string; color: string }[];
    coveredPct: number;
    cellSizeM: number;
  };
  attribution: string | null;
  notes: string | null;
}

const MARGIN = 50;
const INK = '#111827';
const DIM = '#6b7280';
const RULE = '#d1d5db';

/**
 * Reset the text cursor to the left margin and full content width.
 *
 * pdfkit keeps a cursor, and a positional `doc.text(str, x, y)` — which is how
 * table() draws every cell — leaves it parked at that cell's x with that
 * cell's width. Everything written afterwards then inherits a narrow column on
 * the right-hand side of the page. Every block-level writer below therefore
 * re-asserts the margin first rather than trusting the cursor it inherited.
 */
function resetCursor(doc: PDFKit.PDFDocument): void {
  doc.x = MARGIN;
}

function contentWidth(doc: PDFKit.PDFDocument): number {
  return doc.page.width - MARGIN * 2;
}

function heading(doc: PDFKit.PDFDocument, text: string): void {
  resetCursor(doc);
  doc.moveDown(0.8);
  doc.fillColor(INK).fontSize(13).text(text, MARGIN, doc.y, { width: contentWidth(doc) });
  const y = doc.y + 2;
  doc.moveTo(MARGIN, y).lineTo(doc.page.width - MARGIN, y).strokeColor(RULE).lineWidth(0.5).stroke();
  doc.moveDown(0.5);
  doc.fontSize(9);
}

function keyValues(doc: PDFKit.PDFDocument, rows: [string, string][]): void {
  resetCursor(doc);
  doc.fontSize(9);
  for (const [key, value] of rows) {
    doc.fillColor(DIM).text(`${key}: `, { continued: true });
    doc.fillColor(INK).text(value);
  }
}

/**
 * Fixed-width table. pdfkit has no table primitive, so columns are drawn at
 * explicit x offsets — which is also why every column width here is sized for
 * its real content rather than split evenly.
 */
const COLUMN_GUTTER = 6;

function table(
  doc: PDFKit.PDFDocument,
  columns: { label: string; width: number; align?: 'left' | 'right' }[],
  rows: string[][],
): void {
  const startX = MARGIN;
  const drawRow = (cells: string[], bold: boolean) => {
    // Page-break before a row that would overflow, so a table never runs off
    // the bottom edge mid-plan.
    if (doc.y > doc.page.height - MARGIN - 24) doc.addPage();
    const y = doc.y;
    let x = startX;
    doc.fontSize(8.5).fillColor(bold ? DIM : INK);
    columns.forEach((column, index) => {
      // height clamps the cell to one line so an over-long value is ellipsised
      // rather than wrapping and shoving the rest of the table down a row.
      doc.text(cells[index] ?? '', x, y, {
        width: Math.max(column.width - COLUMN_GUTTER, 8),
        align: column.align ?? 'left',
        ellipsis: true, lineBreak: false, height: 11,
      });
      x += column.width;
    });
    doc.y = y + 13;
    resetCursor(doc);
  };
  drawRow(columns.map(c => c.label), true);
  doc.moveTo(startX, doc.y - 3).lineTo(startX + columns.reduce((a, c) => a + c.width, 0), doc.y - 3)
    .strokeColor(RULE).lineWidth(0.5).stroke();
  for (const row of rows) drawRow(row, false);
  resetCursor(doc);
}


// ── text encoding ───────────────────────────────────────────────────────────
//
// pdfkit's built-in fonts are WinAnsi-encoded, and a codepoint outside that
// encoding does not error — it renders as mojibake. Confirmed live: a legend
// label reading "≥ -80 dBm" came out as '"e -80 dBm', because U+2265 has no
// WinAnsi slot (the en/em dashes and middle dot in the same string were fine,
// since those DO have slots, which is exactly why the problem is easy to miss).
//
// Every string reaching the page is therefore normalised first. This is not
// just about our own prose: site names, sector names, operator notes and the
// legend labels all originate outside this module, so sanitising at the call
// sites would leave the user-supplied ones unprotected.

/** Codepoints above U+00FF that WinAnsi does encode, so they can pass through. */
const WIN_ANSI_EXTRAS = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160,
  0x2039, 0x0152, 0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178,
]);

/** Readable ASCII for the symbols an RF tool actually tends to emit. */
const TRANSLITERATIONS: Record<string, string> = {
  '\u2265': '>=', '\u2264': '<=', '\u2260': '!=', '\u2248': '~',
  '\u2212': '-', '\u00b1': '+/-', '\u2192': '->', '\u2190': '<-',
  '\u03c3': 'sigma', '\u03bc': 'u', '\u03bb': 'lambda', '\u0394': 'delta',
  '\u2032': "'", '\u2033': '"', '\u00d7': 'x',
};

export function winAnsi(value: string): string {
  let out = '';
  for (const character of value) {
    const replacement = TRANSLITERATIONS[character];
    if (replacement !== undefined) { out += replacement; continue; }
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0xff || WIN_ANSI_EXTRAS.has(code)) { out += character; continue; }
    // Anything else would render as mojibake; a space is a cleaner failure than
    // a wrong glyph, and dropping it entirely would run words together.
    out += ' ';
  }
  return out;
}

/** Normalise every string in the report input before any of it is drawn. */
function sanitiseInput(input: ReportInput): ReportInput {
  const text = (value: string | null) => (value === null ? null : winAnsi(value));
  return {
    ...input,
    title: winAnsi(input.title),
    model: {
      ...input.model,
      label: winAnsi(input.model.label),
      source: winAnsi(input.model.source),
      blurb: winAnsi(input.model.blurb),
    },
    warnings: input.warnings.map(winAnsi),
    radios: input.radios.map(r => ({ ...r, name: winAnsi(r.name), technology: winAnsi(r.technology) })),
    cells: input.cells.map(c => ({ ...c, cellId: winAnsi(c.cellId), name: text(c.name) })),
    gaps: input.gaps?.map(g => ({
      ...g,
      cellId: winAnsi(g.cellId),
      gaps: g.gaps.map(e => ({ ...e, buildingId: winAnsi(e.buildingId) })),
    })) ?? null,
    heatmap: input.heatmap
      ? {
          ...input.heatmap,
          metric: winAnsi(input.heatmap.metric),
          legend: input.heatmap.legend.map(l => ({ ...l, label: winAnsi(l.label) })),
        }
      : undefined,
    attribution: text(input.attribution),
    notes: text(input.notes),
  };
}

export function writeSimulationReport(doc: PDFKit.PDFDocument, input: ReportInput): void {
  input = sanitiseInput(input);
  // ── cover ────────────────────────────────────────────────────────────────
  doc.fillColor(INK).fontSize(22).text(input.title);
  doc.fillColor(DIM).fontSize(10).text(`RF coverage plan · generated ${input.generatedAt.toISOString().replace('T', ' ').slice(0, 19)} UTC`);
  doc.moveDown(0.6);

  keyValues(doc, [
    ['Propagation model', `${input.model.label} (${input.model.source})`],
    ['Radios', String(input.radios.length)],
    ['Simulation radius', `${input.settings.radiusM} m`],
    ['Rays per sector', String(input.settings.rays)],
    ['Building footprints', input.settings.buildingsConsidered > 0 ? String(input.settings.buildingsConsidered) : 'none imported'],
  ]);

  if (input.warnings.length > 0) {
    heading(doc, 'Applicability warnings');
    doc.fillColor('#b45309').fontSize(9);
    for (const warning of input.warnings) doc.text(`• ${warning}`, MARGIN, doc.y, { width: contentWidth(doc) });
    doc.fillColor(INK);
  }

  // ── coverage map ─────────────────────────────────────────────────────────
  if (input.heatmap) {
    heading(doc, `Coverage map — ${input.heatmap.metric}`);
    const width = doc.page.width - MARGIN * 2;
    try {
      doc.image(input.heatmap.png, MARGIN, doc.y, { fit: [width, 300], align: 'center' });
      doc.y += 308;
    } catch {
      // A corrupt image must not cost the whole report.
      doc.fillColor('#b91c1c').fontSize(9).text('Coverage raster could not be embedded.').fillColor(INK);
    }
    doc.fontSize(8).fillColor(DIM);
    doc.text(
      `${input.heatmap.coveredPct}% of the sampled area has usable signal · ` +
      `${input.heatmap.cellSizeM} m grid · legend: ${input.heatmap.legend.map(l => l.label).join(' / ')}`,
      { width },
    );
    doc.fillColor(INK);
  }

  // ── radio configuration ──────────────────────────────────────────────────
  heading(doc, 'Radio configuration');
  table(
    doc,
    [
      { label: 'Radio', width: 96 },
      { label: 'Latitude', width: 60, align: 'right' },
      { label: 'Longitude', width: 64, align: 'right' },
      { label: 'Az', width: 32, align: 'right' },
      { label: 'BW', width: 32, align: 'right' },
      { label: 'Tilt', width: 30, align: 'right' },
      { label: 'Height', width: 44, align: 'right' },
      { label: 'Power', width: 46, align: 'right' },
      { label: 'Band', width: 50, align: 'right' },
      { label: 'Channel', width: 58, align: 'right' },
    ],
    input.radios.map(r => [
      r.name,
      r.latitude.toFixed(5),
      r.longitude.toFixed(5),
      `${r.azimuthDeg}°`,
      `${r.beamWidthDeg}°`,
      `${r.mechanicalDowntiltDeg}°`,
      `${r.antennaHeightM} m`,
      `${r.txPowerDbm} dBm`,
      `${r.frequencyGhz} GHz`,
      `${r.technology.toUpperCase()} ${r.bandwidthMhz}M`,
    ]),
  );

  // ── per-sector results ───────────────────────────────────────────────────
  if (input.cells.length > 0) {
    heading(doc, 'Ray-trace results per sector');
    table(
      doc,
      [
        { label: 'Sector', width: 130 },
        { label: 'Azimuth', width: 50, align: 'right' },
        { label: 'Avg reach', width: 60, align: 'right' },
        { label: 'Min', width: 48, align: 'right' },
        { label: 'Max', width: 48, align: 'right' },
        { label: 'Blocked', width: 52, align: 'right' },
        { label: 'Wall events', width: 62, align: 'right' },
        { label: 'Unevaluated', width: 62, align: 'right' },
      ],
      input.cells.map(c => [
        c.name ?? c.cellId,
        `${c.azimuthDeg}°`,
        `${c.stats.avgReachM} m`,
        `${c.stats.minReachM} m`,
        `${c.stats.maxReachM} m`,
        `${c.stats.blockedRayPct}%`,
        String(c.stats.wallEventTotal),
        c.stats.declinedSamples > 0 ? String(c.stats.declinedSamples) : '—',
      ]),
    );
    doc.moveDown(0.3);
    resetCursor(doc);
    doc.fontSize(8).fillColor(DIM).text(
      'Reach is the distance at which a ray falls below the configured receiver sensitivity. ' +
      '"Blocked" counts rays terminated by building penetration rather than by range alone. ' +
      '"Unevaluated" counts samples the propagation model declined as outside its published validity.',
      { width: doc.page.width - MARGIN * 2 },
    );
    doc.fillColor(INK);
  }

  // ── served quality ───────────────────────────────────────────────────────
  if (input.quality.length > 0) {
    heading(doc, 'Served building quality');
    const counts = new Map<string, number>();
    for (const entry of input.quality) counts.set(entry.qualityClass, (counts.get(entry.qualityClass) ?? 0) + 1);
    const limited = input.quality.filter(q => q.interferenceLimited).length;
    keyValues(doc, [
      ['Buildings evaluated', String(input.quality.length)],
      ...(['good', 'fair', 'poor', 'unusable'] as const).map(
        cls => [`  ${cls}`, String(counts.get(cls) ?? 0)] as [string, string],
      ),
      ['Interference-limited', `${limited} (signal adequate, SINR or RSRQ is not)`],
      ...(input.resourceGrid
        ? [[
            'Resource grid',
            `${input.resourceGrid.resourceBlocks} RB at ${input.resourceGrid.subcarrierSpacingKhz} kHz SCS ` +
            `(${input.resourceGrid.bandwidthMhz} MHz, ${input.resourceGrid.measurementFamily})`,
          ] as [string, string]]
        : []),
    ]);
  }

  // ── gaps ─────────────────────────────────────────────────────────────────
  if (input.gaps && input.gaps.length > 0) {
    heading(doc, 'Coverage gaps by demand');
    for (const gap of input.gaps) {
      if (doc.y > doc.page.height - MARGIN - 90) doc.addPage();
      resetCursor(doc);
      doc.fontSize(9.5).fillColor(INK).text(gap.cellId);
      doc.fontSize(8.5).fillColor(DIM).text(
        `${gap.summary.gapBuildings} of ${gap.summary.candidateBuildings} in-beam buildings below ` +
        `${gap.summary.serviceThresholdDbm} dBm · ${gap.summary.demandServedPct}% of demand served`,
      );
      doc.fillColor(INK).moveDown(0.2);
      if (gap.gaps.length > 0) {
        table(
          doc,
          [
            { label: 'Building', width: 180 },
            { label: 'Demand', width: 60, align: 'right' },
            { label: 'Best signal', width: 70, align: 'right' },
            { label: 'Distance', width: 60, align: 'right' },
          ],
          gap.gaps.slice(0, 10).map(entry => [
            entry.buildingId,
            entry.combinedDemand.toFixed(0),
            entry.bestRxDbm === null ? 'never illuminated' : `${entry.bestRxDbm.toFixed(0)} dBm`,
            `${entry.distanceM.toFixed(0)} m`,
          ]),
        );
      }
      doc.moveDown(0.4);
    }
  }

  if (input.notes) {
    heading(doc, 'Notes');
    doc.fontSize(9).fillColor(INK).text(input.notes, MARGIN, doc.y, { width: contentWidth(doc) });
  }

  // ── methodology ──────────────────────────────────────────────────────────
  heading(doc, 'Method and limitations');
  doc.fontSize(8.5).fillColor(INK);
  const width = contentWidth(doc);
  doc.text(`Model: ${input.model.blurb}`, MARGIN, doc.y, { width });
  doc.moveDown(0.3);
  resetCursor(doc);
  doc.text(
    'These are planning estimates computed from static geometry — antenna patterns, building footprints and a ' +
    'published propagation model. They are not drive-test, UE or PHY measurements, and they model neither ' +
    'scheduler behaviour nor indoor layouts beyond a facade penetration allowance. Building heights, where not ' +
    'carried by the source data, are inferred; obstruction resting only on an inferred height is reported as ' +
    'unknown rather than as a blockage. Validate against real measurements before committing to a build.',
    { width },
  );
  if (input.attribution) {
    doc.moveDown(0.3);
    doc.fillColor(DIM).text(`Building footprints: ${input.attribution}`, { width });
  }
}

/** PNG magic bytes. A client-supplied image is never trusted on extension. */
export function isPng(buffer: Buffer): boolean {
  return buffer.length > 8
    && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47
    && buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a;
}
