// Coverage heatmap rasteriser.
//
// Turns the backend's flat value grid into a smoothed PNG data URL for
// L.imageOverlay. The grid is row-major with row 0 at the NORTH edge, which is
// exactly how Leaflet draws an image overlay (top edge at maxLat), so no flip
// is needed — see the ordering test in coverage-heatmap.test.ts, which exists
// because a vertically mirrored raster is a completely plausible-looking bug.

export type HeatmapMetric = 'rsrp' | 'sinr';

export interface LegendStop {
  /** Lower bound of the band, in dBm or dB. */
  from: number;
  label: string;
  color: string;
}

/**
 * The band boundaries, which are both the legend and the ramp's anchor points.
 *
 * Five discrete colours answer "is this usable" faster than a gradient, which
 * is why the bands exist and why the raster can still be drawn in them (see
 * RasterInput.smooth). They are no longer the DEFAULT for the raster, because
 * quantising a continuous field into flat plateaus draws contour edges that
 * the propagation does not have. The RSRP breakpoints match
 * the ray colouring in ray-trace.ts's signalColorRgb so the raster and the
 * rays read as one picture, and the SINR bands follow the usual
 * excellent/good/fair/poor/unusable split around the 0 dB service threshold.
 */
export const RSRP_LEGEND: LegendStop[] = [
  { from: -80, label: '≥ -80 dBm · excellent', color: '#059669' },
  { from: -90, label: '-90 to -80 · good', color: '#22c55e' },
  { from: -100, label: '-100 to -90 · fair', color: '#f59e0b' },
  { from: -110, label: '-110 to -100 · poor', color: '#e11d48' },
  { from: -Infinity, label: '< -110 dBm · unusable', color: '#7e22ce' },
];

export const SINR_LEGEND: LegendStop[] = [
  { from: 20, label: '≥ 20 dB · excellent', color: '#059669' },
  { from: 13, label: '13 to 20 · good', color: '#22c55e' },
  { from: 0, label: '0 to 13 · fair', color: '#f59e0b' },
  { from: -6, label: '-6 to 0 · poor', color: '#e11d48' },
  { from: -Infinity, label: '< -6 dB · unusable', color: '#7e22ce' },
];

export function legendFor(metric: HeatmapMetric): LegendStop[] {
  return metric === 'sinr' ? SINR_LEGEND : RSRP_LEGEND;
}

export function colorForValue(value: number, legend: LegendStop[]): string {
  for (const stop of legend) if (value >= stop.from) return stop.color;
  return legend[legend.length - 1].color;
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// ── continuous ramp ────────────────────────────────────────────────────────
//
// The bands above are a reading aid, but applying them to the raster quantises
// a smooth field into five flat plateaus with hard edges at -80/-90/-100/-110,
// which is not what propagation looks like: path loss falls off continuously,
// so the picture should too. The value under every pixel was ALREADY
// interpolated bilinearly between real samples — the sharp edges came purely
// from snapping that smooth number to the nearest band colour.
//
// So the ramp anchors the same colours at the same dB boundaries (the legend
// keeps meaning exactly what it did) and blends between them instead of
// stepping. Nothing about the underlying numbers changes; only how a value
// between two anchors is coloured.

/**
 * Blend in Oklab rather than sRGB.
 *
 * Mixing this palette channel-wise in sRGB runs green -> amber through a
 * desaturated khaki and red -> purple through a muddy brown, which reads as
 * dirt on the map rather than a gradient. Oklab is perceptually uniform, so
 * the midpoint between two anchors looks like the midpoint.
 */
function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
}

function rgbToOklab([r, g, b]: [number, number, number]): [number, number, number] {
  const lr = srgbToLinear(r / 255);
  const lg = srgbToLinear(g / 255);
  const lb = srgbToLinear(b / 255);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}

function oklabToRgb([L, A, B]: [number, number, number]): [number, number, number] {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.2914855480 * B) ** 3;
  const lr = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const lg = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const lb = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
  const clamp = (x: number) => Math.max(0, Math.min(255, Math.round(linearToSrgb(x) * 255)));
  return [clamp(lr), clamp(lg), clamp(lb)];
}

export interface RampAnchor {
  value: number;
  rgb: [number, number, number];
}

/**
 * Turn the legend's bands into ramp anchors, ascending by value.
 *
 * Each band's colour is anchored at its own lower bound, so a value sitting
 * exactly on a boundary still renders as that band's colour and the legend
 * stays literally true. The bottom band is open-ended (-Infinity), so it is
 * anchored one band-width below the lowest finite boundary — using the width
 * of the lowest finite band, since these palettes are not evenly spaced
 * (SINR's bands are 7, 13 and 6 dB wide).
 */
export function rampAnchors(legend: LegendStop[]): RampAnchor[] {
  const finite = legend.filter(stop => Number.isFinite(stop.from)).slice().sort((a, b) => a.from - b.from);
  const anchors: RampAnchor[] = finite.map(stop => ({ value: stop.from, rgb: hexToRgb(stop.color) }));
  const openEnded = legend.find(stop => !Number.isFinite(stop.from));
  if (openEnded && finite.length >= 2) {
    const width = finite[1].from - finite[0].from;
    anchors.unshift({ value: finite[0].from - width, rgb: hexToRgb(openEnded.color) });
  } else if (openEnded && finite.length === 1) {
    anchors.unshift({ value: finite[0].from - 10, rgb: hexToRgb(openEnded.color) });
  }
  return anchors;
}

/** Colour for a value on the continuous ramp, clamped at both ends. */
export function rampRgbForValue(value: number, anchors: RampAnchor[]): [number, number, number] {
  if (anchors.length === 0) return [0, 0, 0];
  if (value <= anchors[0].value) return anchors[0].rgb;
  const last = anchors[anchors.length - 1];
  if (value >= last.value) return last.rgb;
  for (let i = 0; i < anchors.length - 1; i++) {
    const lo = anchors[i];
    const hi = anchors[i + 1];
    if (value > hi.value) continue;
    const span = hi.value - lo.value;
    const t = span === 0 ? 0 : (value - lo.value) / span;
    const a = rgbToOklab(lo.rgb);
    const b = rgbToOklab(hi.rgb);
    return oklabToRgb([
      a[0] + (b[0] - a[0]) * t,
      a[1] + (b[1] - a[1]) * t,
      a[2] + (b[2] - a[2]) * t,
    ]);
  }
  return last.rgb;
}

/**
 * The same ramp as a CSS gradient, so the legend shows the continuum it is
 * labelling instead of five swatches that imply steps the raster no longer has.
 */
export function gradientCssFor(metric: HeatmapMetric): string {
  const anchors = rampAnchors(legendFor(metric));
  const lo = anchors[0].value;
  const hi = anchors[anchors.length - 1].value;
  const span = hi - lo || 1;
  const stops = anchors.map(anchor => {
    const pct = Math.round(((anchor.value - lo) / span) * 100);
    return `rgb(${anchor.rgb[0]} ${anchor.rgb[1]} ${anchor.rgb[2]}) ${pct}%`;
  });
  // Bottom of the scale at the bottom of the bar.
  return `linear-gradient(to top, ${stops.join(', ')})`;
}

/** Output pixels per source grid cell, per axis. */
const UPSCALE = 6;
const MAX_DIMENSION_PX = 1400;
/** Raster opacity. Low enough to read street names and footprints underneath. */
const FILL_ALPHA = 0.55;

export interface RasterInput {
  values: (number | null)[];
  cols: number;
  rows: number;
  metric: HeatmapMetric;
  /** Full opacity, for a PDF where there is no basemap to see through. */
  opaque?: boolean;
  /**
   * Blend continuously between band colours (default), or snap to the five
   * discrete bands. Smooth matches how the field actually behaves; banded is
   * easier to read a pass/fail boundary off.
   */
  smooth?: boolean;
}

/**
 * Bilinear interpolation between real computed samples.
 *
 * The four corners behind every output pixel are always real backend results;
 * this only fills the gradient BETWEEN them, which is what commercial tools do
 * when the display is finer than the sample grid. Any pixel whose four corners
 * are not all real stays fully transparent — a point the engine declined, or
 * one outside every cell's radius, is never papered over with a guess.
 */
export function buildHeatmapDataUrl(input: RasterInput): string | null {
  const { values, cols, rows, metric } = input;
  if (rows < 2 || cols < 2) return null;
  const legend = legendFor(metric);
  const smooth = input.smooth !== false;
  const anchors = rampAnchors(legend);
  const alpha = Math.round((input.opaque ? 1 : FILL_ALPHA) * 255);

  const outW = Math.min(cols * UPSCALE, MAX_DIMENSION_PX);
  const outH = Math.min(rows * UPSCALE, MAX_DIMENSION_PX);
  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const image = ctx.createImageData(outW, outH);

  const at = (row: number, col: number): number | null => values[row * cols + col] ?? null;

  for (let py = 0; py < outH; py++) {
    const gy = (py / (outH - 1)) * (rows - 1);
    const row0 = Math.max(0, Math.min(rows - 2, Math.floor(gy)));
    const ty = gy - row0;
    for (let px = 0; px < outW; px++) {
      const gx = (px / (outW - 1)) * (cols - 1);
      const col0 = Math.max(0, Math.min(cols - 2, Math.floor(gx)));
      const tx = gx - col0;

      const q11 = at(row0, col0);
      const q21 = at(row0, col0 + 1);
      const q12 = at(row0 + 1, col0);
      const q22 = at(row0 + 1, col0 + 1);
      const index = (py * outW + px) * 4;
      if (q11 === null || q21 === null || q12 === null || q22 === null) {
        image.data[index + 3] = 0;
        continue;
      }
      const value =
        q11 * (1 - tx) * (1 - ty) + q21 * tx * (1 - ty) +
        q12 * (1 - tx) * ty + q22 * tx * ty;
      const [r, g, b] = smooth ? rampRgbForValue(value, anchors) : hexToRgb(colorForValue(value, legend));
      image.data[index] = r;
      image.data[index + 1] = g;
      image.data[index + 2] = b;
      image.data[index + 3] = alpha;
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas.toDataURL('image/png');
}
