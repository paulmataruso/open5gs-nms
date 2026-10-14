import * as https from 'https';

// ── OpenStreetMap building footprints ───────────────────────────────────────
//
// Building footprints are what make LOS/NLOS classification, the coverage-gap
// finder and building-entry analysis mean anything: without them every
// prediction is a free-space guess. Overpass is used directly rather than via
// OSMnx so this needs no Python/geopandas dependency chain -- plain HTTPS the
// backend can already speak.
//
// LICENSING, and it is not optional: OpenStreetMap data is ODbL-1.0. That is a
// share-alike database licence and is entirely separate from A.T.O.M's own MIT
// code licence. Any pack built from it carries attribution and share-alike
// obligations, which is why the manifest records the licence per layer rather
// than lumping everything under one project-wide line.

const OSM_ATTRIBUTION = '© OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright)';
export const OSM_BUILDING_LICENSE = `ODbL-1.0 -- ${OSM_ATTRIBUTION}`;

// A plain curl with no User-Agent gets a bare Apache 406 from
// overpass-api.de -- confirmed live, and it looks nothing like a rate limit.
const USER_AGENT = 'open5gs-nms/2.0 (RF planning dataset builder)';

// Mirror list order is deliberately NOT a preference ranking any more.
//
// It used to be: "the de instance 504'd under load, kumi answered in ~67s", so
// kumi was tried first and the rest were serial fallbacks. Measured again
// 2026-10-13, that had completely inverted — kumi returned 504 after 119s,
// overpass-api.de answered the same query in 6s, private.coffee 504'd after
// 98s. Which mirror is healthy is a property of the day, not of the list.
//
// A serial fallback list is the wrong shape for that: the browser's own
// ceiling (nginx reads /api/ for 120s) got spent entirely on the first
// mirror's timeout, so the request died before the 6s mirror was ever tried.
// Hence the hedged strategy in fetchOsmBuildings() below — start the first,
// and if it hasn't answered shortly, bring the others in alongside it rather
// than waiting for it to fail.
const OVERPASS_ENDPOINTS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

// Budget, and why it is shaped this way: nginx's generic /api/ location reads
// for 120s, so ANY backend budget above that surfaces to the browser as a bare
// 504 with no reason attached rather than as our own error envelope. This
// module therefore has to stay inside a ceiling it cannot see, and the matching
// nginx location (^/api/rf-planning/buildings/import, 300s) exists so the whole
// mirror sequence below can finish without being cut off mid-flight.
//
// Three mirrors at 70s is 210s worst case, which is longer than anyone will sit
// in front of a map for, so TOTAL_BUDGET caps the whole sequence instead: each
// attempt gets whatever is left, and once it is gone we stop and report how
// long we actually waited. A real error at 150s beats an opaque 504 at 120s.
const OVERPASS_ATTEMPT_TIMEOUT_MS = 70_000;
const OVERPASS_TOTAL_BUDGET_MS = 150_000;

/** Server-side query budget, kept under the per-attempt socket cap above. */
const OVERPASS_QUERY_TIMEOUT_S = 55;

// How long to give one mirror alone before hedging onto the next. Overpass is
// donated infrastructure, so this is deliberately not a blind parallel fan-out
// to all three: a healthy mirror answers well inside this window and the other
// queries are never sent at all. They only go out once a mirror has actually
// proven slow, which is exactly when the extra load is justified.
const OVERPASS_HEDGE_STAGGER_MS = 8_000;

/**
 * Successful imports are cached, because the public Overpass instances are
 * genuinely unreliable minute to minute — measured 2026-10-13, the same query
 * answered in 6s, then returned a dispatcher-timeout 504 twenty minutes later
 * with all four of its rate-limit slots free. Nothing about that is ours to
 * fix, so the useful move is to stop depending on it for a view that was
 * already fetched: re-running a simulation on the same area must not be able
 * to lose its buildings to someone else's busy server.
 *
 * Keyed on the bbox rounded to ~1 m, which makes a nudged map pan a cache hit
 * rather than a fresh query. OSM building data changes on a timescale of days,
 * so a 30 minute TTL risks nothing an operator would notice.
 */
const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_MAX_ENTRIES = 32;

interface CacheEntry { at: number; value: OsmBuildingResult }
const cache = new Map<string, CacheEntry>();

function cacheKey(bounds: [number, number, number, number]): string {
  return bounds.map(v => v.toFixed(5)).join(',');
}

function cacheGet(bounds: [number, number, number, number]): OsmBuildingResult | null {
  const key = cacheKey(bounds);
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) { cache.delete(key); return null; }
  // Refresh insertion order so the eviction below is least-recently-USED
  // rather than least-recently-written.
  cache.delete(key);
  cache.set(key, hit);
  return hit.value;
}

function cachePut(bounds: [number, number, number, number], value: OsmBuildingResult): void {
  cache.set(cacheKey(bounds), { at: Date.now(), value });
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

/** Test seam — the cache is process-global and would otherwise leak between tests. */
export function clearOsmBuildingCache(): void {
  cache.clear();
}

// ── Demand scoring ──────────────────────────────────────────────────────────
// ATTRIBUTION: these weighting tables originate in A.T.O.M
// (github.com/Berk-Unsal/atom, MIT (c) 2026 Berk Unsal), whose MIT notice
// therefore applies to these values. Nothing downstream depends on the exact
// numbers, so they can be replaced with our own weighting at any point -- see
// docs/rf-planning-model-reference.md section 8.
const DEMAND_SHOPS: Record<string, number> = { mall: 100, supermarket: 80, department_store: 100 };
const DEMAND_AMENITIES: Record<string, number> = { cafe: 50, hospital: 70, university: 65, clinic: 50, school: 50, restaurant: 50 };
const DEMAND_BUILDING_TYPES: Record<string, number> = {
  commercial: 45, retail: 40, office: 35, school: 45, university: 60, hospital: 70, dormitory: 30, public: 20,
};
const NAME_KEYWORDS: Record<string, number> = {
  avm: 100, 'alışveriş': 90, alisveris: 90, mall: 100, hastane: 70, hospital: 70,
  'üniversite': 65, universite: 65, university: 65, okul: 50, school: 50, tower: 45, plaza: 45,
};
const RESIDENTIAL_BUILDING_TYPES: Record<string, number> = {
  apartments: 24, residential: 20, house: 12, detached: 10, semidetached_house: 10, terrace: 12, dormitory: 25,
  // DELIBERATE DEVIATION from the inherited table, which omitted these.
  //
  // `building=yes` is OSM's generic "there is a building here" value and is by
  // far the most common tag in suburban and rural mapping -- 201 of 578
  // footprints in this deployment's own area. Scoring it zero made the entire
  // demand-driven workflow inert on real data: measured live, a sector facing
  // 10 real buildings reported totalDemand = 0, so the coverage-gap percentage
  // was meaningless and the optimiser had nothing to rank against.
  //
  // It is weighted BELOW a confirmed `house` (8 vs 12) precisely because it is
  // unconfirmed: the tag asserts a structure, not a dwelling. Outbuildings are
  // listed separately and near-zero, since a detached garage or shed is a
  // structure the rays will hit but not a service target.
  yes: 8,
  detached_house: 10,
  bungalow: 10,
  static_caravan: 8,
  farm: 8,
  // Structures, not premises: they obstruct but nobody is served inside them.
  garage: 0, garages: 0, shed: 0, barn: 0, carport: 0, greenhouse: 0, roof: 0,
};

/** Upstream's geometry_area_demand(), unchanged. */
function areaDemand(areaM2: number): number {
  if (!Number.isFinite(areaM2)) return 0;
  if (areaM2 >= 20000) return 30;
  if (areaM2 >= 10000) return 20;
  if (areaM2 >= 5000) return 10;
  return 0;
}

/**
 * Radius used for the neighbour counts behind density_score. Upstream derives
 * its own counts through a spatial join whose radius is not expressed as a
 * constant; 100 m is this project's explicit choice, applied to upstream's own
 * density formula (min(100, nearby*1.4 + nearbyResidential*3.0)).
 */
const DENSITY_NEIGHBOUR_RADIUS_M = 100;

interface OverpassWay {
  type: string;
  id: number;
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
}

function overpassQuery(bounds: [number, number, number, number]): string {
  const [minLon, minLat, maxLon, maxLat] = bounds;
  // Overpass bbox order is (south, west, north, east).
  return `[out:json][timeout:${OVERPASS_QUERY_TIMEOUT_S}];(way["building"](${minLat},${minLon},${maxLat},${maxLon}););out geom;`;
}

function post(
  endpoint: string, body: string, timeoutMs: number,
  register?: (abort: () => void) => void,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint);
    const payload = `data=${encodeURIComponent(body)}`;
    let deadline: NodeJS.Timeout;
    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname,
        method: 'POST',
        timeout: timeoutMs,
        headers: {
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          clearTimeout(deadline);
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') });
        });
      },
    );
    // `timeout` above is an INACTIVITY timeout: a mirror that trickles bytes
    // back slowly resets it on every chunk and can outlive the budget entirely.
    // This hard deadline is what actually bounds the attempt.
    deadline = setTimeout(() => req.destroy(new Error(`no response within ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
    req.on('timeout', () => req.destroy(new Error(`stalled after ${Math.round(timeoutMs / 1000)}s of inactivity`)));
    req.on('error', err => { clearTimeout(deadline); reject(err); });
    // Let the caller drop this attempt once another mirror has already won,
    // so a hedged request doesn't keep a dead socket (and the remote query)
    // alive for the rest of its timeout.
    register?.(() => { clearTimeout(deadline); req.destroy(new Error('superseded by a faster mirror')); });
    req.write(payload);
    req.end();
  });
}

/** Planar area in m^2 via the shoelace formula on a local equirectangular projection. */
function ringAreaM2(ring: { lat: number; lon: number }[]): number {
  if (ring.length < 3) return 0;
  const latRef = ring.reduce((a, p) => a + p.lat, 0) / ring.length;
  const mPerDegLat = 111132.92;
  const mPerDegLon = 111320 * Math.cos((latRef * Math.PI) / 180);
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    sum += (a.lon * mPerDegLon) * (b.lat * mPerDegLat) - (b.lon * mPerDegLon) * (a.lat * mPerDegLat);
  }
  return Math.abs(sum) / 2;
}

export interface OsmBuildingResult {
  /** True when this came from the in-process cache rather than Overpass. */
  cached?: boolean;
  features: Record<string, unknown>[];
  endpoint: string;
  rawWays: number;
}

/**
 * Overpass's own error text, which it puts in the BODY of an otherwise opaque
 * 504/429. Worth extracting: "the server is probably too busy" is a far more
 * actionable thing to show an operator than "HTTP 504", and it distinguishes a
 * transient dispatcher timeout from a malformed query.
 */
function overpassErrorText(body: string): string | null {
  const html = /<strong[^>]*>Error<\/strong>:?\s*([^<]+)/i.exec(body);
  if (html) return html[1].replace(/\s+/g, ' ').trim();
  const remark = /"remark"\s*:\s*"([^"]+)"/.exec(body);
  if (remark) return remark[1].replace(/\s+/g, ' ').trim();
  return null;
}

/** Statuses worth one quick retry: the instance is busy, not the query wrong. */
const TRANSIENT_STATUSES = new Set([429, 502, 503, 504]);

type AttemptOutcome =
  | { ok: true; endpoint: string; ways: OverpassWay[] }
  | { ok: false; detail: string };

/**
 * Fetch building footprints, hedging across mirrors.
 *
 * Start one mirror. If it hasn't answered within the stagger window, bring the
 * next one in ALONGSIDE it rather than waiting for it to fail — first valid
 * response wins and the losers are dropped. Today that turns a 119s timeout
 * followed by a 6s success into a 6s success, which is the difference between
 * an nginx 504 and a map full of buildings.
 */
export async function fetchOsmBuildings(bounds: [number, number, number, number]): Promise<OsmBuildingResult> {
  const cached = cacheGet(bounds);
  if (cached) return { ...cached, cached: true };
  const query = overpassQuery(bounds);
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;
  const failures: string[] = [];
  const inFlight = new Map<Promise<AttemptOutcome>, { endpoint: string; abort: () => void }>();
  let nextEndpoint = 0;

  const launch = (): void => {
    const endpoint = OVERPASS_ENDPOINTS[nextEndpoint++];
    if (!endpoint) return;
    const remaining = OVERPASS_TOTAL_BUDGET_MS - elapsed();
    const holder: { abort: () => void } = { abort: () => {} };
    let lastDetail: string | undefined;
    const attempt: Promise<AttemptOutcome> = (async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const left = OVERPASS_TOTAL_BUDGET_MS - elapsed();
        if (left < 8_000) break;
        try {
          const res = await post(
            endpoint, query, Math.min(OVERPASS_ATTEMPT_TIMEOUT_MS, left),
            abort => { holder.abort = abort; },
          );
          const reported = overpassErrorText(res.body);
          if (res.status !== 200 || !res.body.trimStart().startsWith('{')) {
            const detail = `${hostOf(endpoint)}: HTTP ${res.status}${reported ? ` — ${reported}` : ''}`;
            // A busy instance is worth one more go; a rejected query is not.
            if (TRANSIENT_STATUSES.has(res.status) && attempt === 0) { lastDetail = detail; continue; }
            return { ok: false, detail };
          }
          const parsed = JSON.parse(res.body) as { elements?: OverpassWay[]; remark?: string };
          // CRITICAL: Overpass reports a runtime error in a `remark` while
          // still answering HTTP 200 with an EMPTY elements array. Accepting
          // that as authoritative would report "no buildings here" for what is
          // really a failed query — the one wrong answer worse than an error,
          // because it looks like a fact about the area.
          if (reported ?? parsed.remark) {
            const detail = `${hostOf(endpoint)}: ${reported ?? parsed.remark}`;
            if (attempt === 0) { lastDetail = detail; continue; }
            return { ok: false, detail };
          }
          // With no error remark, an `elements` array — even an empty one — IS
          // authoritative: this bbox genuinely has no mapped buildings. That
          // used to fall through to the next mirror and finally raise "could
          // not fetch OSM building footprints", blaming the network for an
          // empty rural bbox.
          if (!Array.isArray(parsed.elements)) {
            return { ok: false, detail: `${hostOf(endpoint)}: response carried no elements array` };
          }
          return {
            ok: true, endpoint,
            ways: parsed.elements.filter(e => e.type === 'way' && Array.isArray(e.geometry) && e.geometry!.length >= 4),
          };
        } catch (err) {
          lastDetail = `${hostOf(endpoint)}: ${err instanceof Error ? err.message : String(err)}`;
          if (attempt === 1) return { ok: false, detail: lastDetail };
        }
      }
      return { ok: false, detail: lastDetail ?? `${hostOf(endpoint)}: no attempt completed in budget` };
    })();
    // Self-pruning: this reaction is attached before Promise.race attaches its
    // own, so it always runs first and the race's continuation sees an
    // already-pruned map.
    void attempt.then(() => { inFlight.delete(attempt); }, () => { inFlight.delete(attempt); });
    inFlight.set(attempt, { endpoint, abort: () => holder.abort() });
  };

  const dropOthers = () => { for (const { abort } of inFlight.values()) abort(); inFlight.clear(); };

  while (true) {
    if (inFlight.size === 0) {
      if (nextEndpoint >= OVERPASS_ENDPOINTS.length) break;
      if (OVERPASS_TOTAL_BUDGET_MS - elapsed() < 10_000) {
        failures.push(`gave up with ${OVERPASS_ENDPOINTS.length - nextEndpoint} mirror(s) untried, ${Math.round(OVERPASS_TOTAL_BUDGET_MS / 1000)}s budget spent`);
        break;
      }
      launch();
      continue;
    }

    let staggerTimer: NodeJS.Timeout | undefined;
    const hedge = nextEndpoint < OVERPASS_ENDPOINTS.length && OVERPASS_TOTAL_BUDGET_MS - elapsed() > 10_000
      ? new Promise<'hedge'>(resolve => { staggerTimer = setTimeout(() => resolve('hedge'), OVERPASS_HEDGE_STAGGER_MS); })
      : null;

    const settled = await Promise.race<AttemptOutcome | 'hedge'>(
      hedge ? [...inFlight.keys(), hedge] : [...inFlight.keys()],
    );
    clearTimeout(staggerTimer);

    if (settled === 'hedge') { launch(); continue; }
    if (settled.ok) {
      dropOthers();
      const value: OsmBuildingResult = {
        features: toFeatures(settled.ways), endpoint: settled.endpoint, rawWays: settled.ways.length,
      };
      cachePut(bounds, value);
      return value;
    }
    failures.push(settled.detail);
  }

  dropOthers();
  throw new Error(
    `no Overpass mirror answered in ${Math.round(elapsed() / 1000)}s (${failures.join('; ')}). ` +
    'Overpass is donated public infrastructure and throttles under load — try a smaller area, or retry shortly.',
  );
}

function hostOf(endpoint: string): string {
  try { return new URL(endpoint).hostname; } catch { return endpoint; }
}

function toFeatures(ways: OverpassWay[]): Record<string, unknown>[] {
  // Centroid + area first; density needs every centroid before scoring.
  const prepared = ways.map(w => {
    const geom = w.geometry!;
    const ring = geom[0].lat === geom[geom.length - 1].lat && geom[0].lon === geom[geom.length - 1].lon ? geom : [...geom, geom[0]];
    const area = ringAreaM2(ring.slice(0, -1));
    const cLat = ring.slice(0, -1).reduce((a, p) => a + p.lat, 0) / (ring.length - 1);
    const cLon = ring.slice(0, -1).reduce((a, p) => a + p.lon, 0) / (ring.length - 1);
    const tags = w.tags ?? {};
    return { way: w, ring, area, cLat, cLon, tags, residential: (tags.building ?? '') in RESIDENTIAL_BUILDING_TYPES };
  });

  const mPerDegLat = 111132.92;
  return prepared.map(b => {
    const mPerDegLon = 111320 * Math.cos((b.cLat * Math.PI) / 180);
    let nearby = 0;
    let nearbyResidential = 0;
    for (const other of prepared) {
      if (other === b) continue;
      const dx = (other.cLon - b.cLon) * mPerDegLon;
      const dy = (other.cLat - b.cLat) * mPerDegLat;
      if (dx * dx + dy * dy <= DENSITY_NEIGHBOUR_RADIUS_M * DENSITY_NEIGHBOUR_RADIUS_M) {
        nearby++;
        if (other.residential) nearbyResidential++;
      }
    }
    const densityScore = Math.round(Math.min(100, nearby * 1.4 + nearbyResidential * 3.0) * 100) / 100;

    const t = b.tags;
    const clean = (v?: string) => (v ?? '').trim().toLowerCase();
    const building = clean(t.building);
    const amenity = clean(t.amenity);
    const shop = clean(t.shop);
    const office = clean(t.office);
    const name = clean(t.name);

    let demand = 0;
    if (shop && DEMAND_SHOPS[shop]) demand += DEMAND_SHOPS[shop];
    if (amenity && DEMAND_AMENITIES[amenity]) demand += DEMAND_AMENITIES[amenity];
    if (office) demand += 35;
    if (building && DEMAND_BUILDING_TYPES[building]) demand += DEMAND_BUILDING_TYPES[building];
    for (const [kw, score] of Object.entries(NAME_KEYWORDS)) {
      if (name.includes(kw)) { demand += score; break; }
    }
    demand += areaDemand(b.area);

    let residentialDemand = RESIDENTIAL_BUILDING_TYPES[building] ?? 0;
    if (densityScore >= 25) residentialDemand += Math.min(densityScore * 0.25, 30);

    const props: Record<string, unknown> = {
      demand_weight: Math.round(demand * 100) / 100,
      residential_demand: Math.round(residentialDemand * 100) / 100,
      density_score: densityScore,
      area_m2: Math.round(b.area),
      osm_id: b.way.id,
    };
    // Pass OSM tags through under their original keys -- the engine reads
    // `building`, `building:levels`, `height`, `name`, `amenity`, `shop` and
    // `office` directly, and derives height provenance from the first two.
    for (const key of ['building', 'building:levels', 'height', 'name', 'amenity', 'shop', 'office', 'building:material', 'roof:material']) {
      if (t[key] !== undefined) props[key] = t[key];
    }

    return {
      type: 'Feature',
      id: `osm-way-${b.way.id}`,
      properties: props,
      geometry: { type: 'Polygon', coordinates: [b.ring.map(p => [p.lon, p.lat])] },
    };
  });
}
