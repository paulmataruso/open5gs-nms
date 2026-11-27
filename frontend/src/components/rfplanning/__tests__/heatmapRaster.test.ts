import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  RSRP_LEGEND,
  SINR_LEGEND,
  legendFor,
  colorForValue,
  rampAnchors,
  rampRgbForValue,
  gradientCssFor,
  buildHeatmapDataUrl,
} from '../heatmapRaster';

/**
 * The client half of the coverage heatmap.
 *
 * Three things in this file are called load-bearing in CLAUDE.md and none of
 * them were checked on this side: the grid is row-major with ROW 0 AT THE
 * NORTH edge, a pixel is interpolated bilinearly between real samples but
 * NEVER across a null, and anchors are blended in Oklab because mixing this
 * palette channel-wise in sRGB runs green->amber through khaki. The backend's
 * coverage-heatmap.test.ts pins the ordering it produces; nothing pinned that
 * the browser then blits it the same way up.
 *
 * `buildHeatmapDataUrl` needs a canvas, which jsdom does not implement, so the
 * raster tests install a fake 2d context and read the ImageData it is handed.
 * That is the real assertion surface anyway — the PNG encoding is the
 * browser's job, the pixel values are ours.
 */

interface FakeCtx {
  createImageData: (w: number, h: number) => { data: Uint8ClampedArray; width: number; height: number };
  putImageData: (img: { data: Uint8ClampedArray }) => void;
}

/** Captures the ImageData the module fills, keyed by output pixel. */
function withFakeCanvas(): { pixels: () => { data: Uint8ClampedArray; width: number; height: number } } {
  let captured: { data: Uint8ClampedArray; width: number; height: number } | null = null;
  const real = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
    if (tag !== 'canvas') return real(tag as 'div');
    const canvas = {
      width: 0,
      height: 0,
      getContext: (): FakeCtx => ({
        createImageData: (w: number, h: number) => ({
          data: new Uint8ClampedArray(w * h * 4),
          width: w,
          height: h,
        }),
        putImageData: (img) => { captured = img as typeof captured; },
      }),
      toDataURL: () => 'data:image/png;base64,FAKE',
    };
    return canvas as unknown as HTMLElement;
  }) as typeof document.createElement);
  return {
    pixels: () => {
      if (!captured) throw new Error('putImageData was never called');
      return captured;
    },
  };
}

function px(
  img: { data: Uint8ClampedArray; width: number },
  x: number,
  y: number,
): [number, number, number, number] {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
}

afterEach(() => { vi.restoreAllMocks(); });

describe('legend bands', () => {
  it('picks the band a value falls in, by lower bound', () => {
    expect(colorForValue(-70, RSRP_LEGEND)).toBe('#059669');
    expect(colorForValue(-85, RSRP_LEGEND)).toBe('#22c55e');
    expect(colorForValue(-95, RSRP_LEGEND)).toBe('#f59e0b');
    expect(colorForValue(-105, RSRP_LEGEND)).toBe('#e11d48');
    expect(colorForValue(-140, RSRP_LEGEND)).toBe('#7e22ce');
  });

  it('a value exactly on a boundary belongs to the band above it', () => {
    // The legend reads "-90 to -80 · good", so -80 must be the band ABOVE,
    // and -90 the "good" band itself. Off-by-one here makes the printed
    // legend a lie at exactly the values an operator checks.
    expect(colorForValue(-80, RSRP_LEGEND)).toBe('#059669');
    expect(colorForValue(-90, RSRP_LEGEND)).toBe('#22c55e');
    expect(colorForValue(0, SINR_LEGEND)).toBe('#f59e0b');
  });

  it('selects the metric legend', () => {
    expect(legendFor('sinr')).toBe(SINR_LEGEND);
    expect(legendFor('rsrp')).toBe(RSRP_LEGEND);
  });

  it('both legends are ordered high to low and end open', () => {
    for (const legend of [RSRP_LEGEND, SINR_LEGEND]) {
      const bounds = legend.map(s => s.from);
      expect(bounds).toEqual([...bounds].sort((a, b) => b - a));
      expect(bounds[bounds.length - 1]).toBe(-Infinity);
      // colorForValue walks top-down and returns the first band a value
      // clears, so an unordered legend would silently mis-colour everything.
    }
  });
});

describe('ramp anchors', () => {
  it('anchors each band at its own lower bound, ascending', () => {
    const anchors = rampAnchors(RSRP_LEGEND);
    expect(anchors.map(a => a.value)).toEqual([-120, -110, -100, -90, -80]);
    expect(anchors[anchors.length - 1].rgb).toEqual([5, 150, 105]);
  });

  it('places the open-ended band one band-width below the lowest finite bound', () => {
    // Using the lowest FINITE band's width matters because these palettes are
    // not evenly spaced: SINR's bands are 6, 13 and 7 dB wide, so a fixed
    // step would put the bottom anchor in the wrong place on one of them.
    expect(rampAnchors(SINR_LEGEND).map(a => a.value)).toEqual([-12, -6, 0, 13, 20]);
  });

  it('falls back to a 10-unit step when there is only one finite band', () => {
    const anchors = rampAnchors([
      { from: 5, label: 'hi', color: '#ffffff' },
      { from: -Infinity, label: 'lo', color: '#000000' },
    ]);
    expect(anchors.map(a => a.value)).toEqual([-5, 5]);
  });

  it('a legend with no open-ended band gets no synthetic anchor', () => {
    const anchors = rampAnchors([
      { from: 10, label: 'a', color: '#ffffff' },
      { from: 0, label: 'b', color: '#000000' },
    ]);
    expect(anchors.map(a => a.value)).toEqual([0, 10]);
  });
});

describe('the continuous ramp', () => {
  const anchors = rampAnchors(RSRP_LEGEND);

  it('clamps at both ends rather than extrapolating', () => {
    expect(rampRgbForValue(-10, anchors)).toEqual(anchors[anchors.length - 1].rgb);
    expect(rampRgbForValue(-200, anchors)).toEqual(anchors[0].rgb);
  });

  it('returns an anchor colour exactly on that anchor', () => {
    for (const anchor of anchors) {
      expect(rampRgbForValue(anchor.value, anchors)).toEqual(anchor.rgb);
    }
  });

  it('blends perceptually, NOT channel-wise in sRGB', () => {
    // The whole reason Oklab is in this file. Halfway between the "fair"
    // amber (#f59e0b) and the "good" green (#22c55e), a plain sRGB average
    // gives (139, 174, 54) — a desaturated khaki that reads as dirt on the
    // map. Oklab keeps the midpoint saturated, so assert it is NOT the
    // arithmetic mean and is meaningfully greener.
    const mid = rampRgbForValue(-95, anchors);
    const srgbMean: [number, number, number] = [
      Math.round((0xf5 + 0x22) / 2), Math.round((0x9e + 0xc5) / 2), Math.round((0x0b + 0x5e) / 2),
    ];
    expect(mid).not.toEqual(srgbMean);
    expect(mid[1]).toBeGreaterThan(srgbMean[1]);
    // And it must stay inside the byte range after the round trip through
    // linear light, which is what the clamp in oklabToRgb is for.
    for (const c of mid) {
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(255);
    }
  });

  it('is monotonic in the channel that separates two neighbouring anchors', () => {
    // Red falls from the amber anchor to the green one, so sampling across
    // that span must never step back up. A non-monotonic ramp would show
    // banding that looks like real structure in the propagation.
    const reds: number[] = [];
    for (let v = -100; v <= -90; v += 0.5) reds.push(rampRgbForValue(v, anchors)[0]);
    for (let i = 1; i < reds.length; i++) expect(reds[i]).toBeLessThanOrEqual(reds[i - 1]);
  });

  it('has no colour for an empty anchor list', () => {
    expect(rampRgbForValue(-90, [])).toEqual([0, 0, 0]);
  });

  it('handles a zero-width span between two anchors without dividing by zero', () => {
    const dup = [
      { value: 0, rgb: [0, 0, 0] as [number, number, number] },
      { value: 0, rgb: [255, 255, 255] as [number, number, number] },
      { value: 10, rgb: [255, 0, 0] as [number, number, number] },
    ];
    for (const c of rampRgbForValue(5, dup)) expect(Number.isFinite(c)).toBe(true);
  });
});

describe('the legend gradient', () => {
  it('runs bottom-to-top with a stop per anchor at its real position', () => {
    const css = gradientCssFor('rsrp');
    // `to top` so the bottom of the scale is at the bottom of the bar — the
    // opposite reads as an inverted legend while every colour is correct.
    expect(css.startsWith('linear-gradient(to top, ')).toBe(true);
    expect(css.match(/rgb\(/g)).toHaveLength(5);
    expect(css).toContain('0%');
    expect(css).toContain('100%');
  });

  it('positions anchors proportionally, not evenly', () => {
    // SINR's anchors are -12,-6,0,13,20 — so the stops are NOT 0/25/50/75/100.
    const pcts = Array.from(gradientCssFor('sinr').matchAll(/ (\d+)%/g), m => Number(m[1]));
    expect(pcts).toEqual([0, 19, 38, 78, 100]);
  });
});

describe('the raster', () => {
  const grid = (values: (number | null)[], cols: number, rows: number) =>
    ({ values, cols, rows, metric: 'rsrp' as const });

  it('refuses a grid too small to interpolate', () => {
    expect(buildHeatmapDataUrl(grid([1], 1, 1))).toBeNull();
    expect(buildHeatmapDataUrl(grid([1, 2], 2, 1))).toBeNull();
  });

  it('returns null when there is no 2d context rather than throwing', () => {
    // The real-browser failure mode this guards: a canvas whose context is
    // unavailable or blocked. Stubbed explicitly rather than leaning on
    // jsdom's unimplemented getContext, which returns undefined while
    // printing a page of "Not implemented" noise -- a test that passes for a
    // reason it did not state is a test that stops holding when the
    // environment changes.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    expect(buildHeatmapDataUrl(grid([1, 2, 3, 4], 2, 2))).toBeNull();
  });

  it('puts grid row 0 at the NORTH edge of the image', () => {
    // The invariant CLAUDE.md flags as "a completely plausible-looking bug" if
    // flipped. Strong north value, weak south: the TOP of the raster must be
    // the excellent green, not the unusable purple.
    const canvas = withFakeCanvas();
    buildHeatmapDataUrl(grid([-70, -70, -140, -140], 2, 2));
    const img = canvas.pixels();
    const top = px(img, 0, 0);
    const bottom = px(img, 0, img.height - 1);
    expect(top.slice(0, 3)).toEqual([5, 150, 105]);
    expect(bottom.slice(0, 3)).toEqual([126, 34, 206]);
    // Not merely different — specifically green on top.
    expect(top[1]).toBeGreaterThan(bottom[1]);
  });

  it('never interpolates across a null — those pixels stay fully transparent', () => {
    // A point the engine declined, or one outside every cell's radius, must
    // not be papered over with a guess. One null corner blanks every pixel
    // whose bilinear footprint touches it.
    const canvas = withFakeCanvas();
    buildHeatmapDataUrl(grid([-70, -70, -70, null], 2, 2));
    const img = canvas.pixels();
    let transparent = 0;
    let opaque = 0;
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        if (px(img, x, y)[3] === 0) transparent++; else opaque++;
      }
    }
    // With a 2x2 grid every output pixel sits in the single cell that has the
    // null corner, so the whole raster is blank — and that is correct: there
    // is no quad with four real corners anywhere in it.
    expect(opaque).toBe(0);
    expect(transparent).toBe(img.width * img.height);
  });

  it('keeps a region whose own four corners are all real', () => {
    const canvas = withFakeCanvas();
    // 3x2: the left cell is complete, the right cell has a null corner.
    buildHeatmapDataUrl(grid([-70, -70, null, -70, -70, -70], 3, 2));
    const img = canvas.pixels();
    expect(px(img, 0, 0)[3]).toBeGreaterThan(0);
    expect(px(img, img.width - 1, 0)[3]).toBe(0);
  });

  it('treats a missing array entry as a null, not as zero', () => {
    // `values[i] ?? null` is doing real work: a short array would otherwise
    // read as 0 dBm, which is off the top of the scale and would paint a
    // bright green patch where there is no data at all.
    const canvas = withFakeCanvas();
    buildHeatmapDataUrl(grid([-70, -70, -70], 2, 2));
    expect(px(canvas.pixels(), 0, 0)[3]).toBe(0);
  });

  it('is translucent by default and opaque on request', () => {
    // The default has to read through to street names and footprints; the PDF
    // has no basemap under it, so there it is full strength.
    const a = withFakeCanvas();
    buildHeatmapDataUrl(grid([-70, -70, -70, -70], 2, 2));
    expect(px(a.pixels(), 0, 0)[3]).toBe(140);
    vi.restoreAllMocks();
    const b = withFakeCanvas();
    buildHeatmapDataUrl({ ...grid([-70, -70, -70, -70], 2, 2), opaque: true });
    expect(px(b.pixels(), 0, 0)[3]).toBe(255);
  });

  it('banded mode snaps to the five legend colours; smooth mode does not', () => {
    const values = [-80, -100, -80, -100];
    const banded = withFakeCanvas();
    buildHeatmapDataUrl({ ...grid(values, 2, 2), smooth: false });
    const bandedColors = new Set<string>();
    const bi = banded.pixels();
    for (let x = 0; x < bi.width; x++) bandedColors.add(px(bi, x, 0).slice(0, 3).join(','));
    vi.restoreAllMocks();

    const smooth = withFakeCanvas();
    buildHeatmapDataUrl(grid(values, 2, 2));
    const smoothColors = new Set<string>();
    const si = smooth.pixels();
    for (let x = 0; x < si.width; x++) smoothColors.add(px(si, x, 0).slice(0, 3).join(','));

    // Banded can only ever emit legend colours; smooth emits a continuum, so
    // across one row it must produce strictly more distinct colours.
    const legendColors = new Set(RSRP_LEGEND.map(s => {
      const n = parseInt(s.color.slice(1), 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255].join(',');
    }));
    for (const c of bandedColors) expect(legendColors.has(c)).toBe(true);
    expect(smoothColors.size).toBeGreaterThan(bandedColors.size);
  });

  it('caps the output dimensions so a large grid cannot build a huge canvas', () => {
    // 6 output pixels per cell, capped at 1400 per axis. A 400-column grid
    // would otherwise ask for 2400px and a 23 MB ImageData.
    const canvas = withFakeCanvas();
    const cols = 400;
    const rows = 3;
    buildHeatmapDataUrl(grid(new Array<number>(cols * rows).fill(-90), cols, rows));
    const img = canvas.pixels();
    expect(img.width).toBe(1400);
    expect(img.height).toBe(rows * 6);
  });

  it('returns a data URL on success', () => {
    withFakeCanvas();
    expect(buildHeatmapDataUrl(grid([-70, -70, -70, -70], 2, 2))).toBe('data:image/png;base64,FAKE');
  });
});
