# RF Planning — model reference

Engineering reference for the RF Planning module's propagation, link-budget,
interference and demand models. Written so the module can be implemented and
re-verified without re-deriving anything from scratch.

## Provenance, and why this matters

Almost everything below is **3GPP TR 38.901** (and a little ITU-R P.1411 /
P.526). Those are published standards. Implementing a standard's formula is not
copying anybody's code, so this module is an independent implementation with no
third-party code licence attached.

Two things here are **not** from a standard and are called out individually
where they appear:

- The **demand-weight tables** (shop/amenity/building-type scores and the
  density formula). These originate in A.T.O.M (`github.com/Berk-Unsal/atom`,
  MIT © 2026 Berk Ünsal). If we keep the exact numbers, the MIT notice must
  travel with them; if we'd rather not carry that, they are easy to replace
  with our own weighting since nothing downstream depends on the specific
  values.
- The **planning thresholds** (RSRP/SINR/RSRQ service limits). These are
  policy choices, not conformance limits. Ours to set.

Everything else — UMa path loss, antenna patterns, thermal noise, RSRQ/RSSI
reconstruction, O2I entry loss — is spec-derived.

---

## 1. Geometry

Slant (3D) distance from ground distance:

```
d_3D = hypot(max(d_2D, 0), h_tx − h_rx)
```

All path-loss formulas below take `d_3D`, not `d_2D`. Using `d_2D` understates
loss at short range, which is exactly where a small-cell plan lives.

## 2. Propagation models

### 2.1 Urban short range — 3GPP TR 38.901 UMa (the default)

Reference: TR 38.901 Table 7.4.1-1. Applicability: `0.5 < f_c < 100 GHz`,
`10 m ≤ d_2D ≤ 5000 m`, outdoor-to-outdoor, known Tx/Rx heights.
**CBRS 3.55–3.7 GHz sits inside this envelope** — verified.

Breakpoint distance:

```
h'_tx = h_tx − 1          # effective heights, metres
h'_rx = h_rx − 1
d_BP  = 4 · h'_tx · h'_rx · f_c_Hz / c        # c = 3e8
```

LOS:

```
PL_1 = 28 + 22·log10(d_3D) + 20·log10(f_GHz)
PL_2 = 28 + 40·log10(d_3D) + 20·log10(f_GHz)
       − 9·log10( d_BP² + (h_tx − h_rx)² )

PL_LOS = PL_1   if d_2D ≤ d_BP
         PL_2   if d_2D >  d_BP
```

NLOS:

```
PL'_NLOS = 13.54 + 39.08·log10(d_3D) + 20·log10(f_GHz) − 0.6·(h_rx − 1.5)
PL_NLOS  = max(PL_LOS, PL'_NLOS)
```

The `max()` is mandatory: without it NLOS can come out *lower* than LOS at
short range, which is physically nonsense and shows up as a coverage bubble
right next to the site.

`log10` is taken on `max(d_3D, 1)` to keep `d → 0` finite.

### 2.2 Legacy FSPL + wall events (keep selectable)

```
FSPL = 20·log10(max(d_3D,1)) + 20·log10(f_GHz) + 32.45
wall_loss = wall_event_count · penetration_loss(f_GHz)

penetration_loss(f) = 8 dB   if f < LTE_max
                      30 dB  if f < NR_max
                      80 dB  otherwise
```

Simpler and more pessimistic through clutter. Worth keeping as an explicit
alternative so a user can see how much of a result is model choice.

### 2.3 LOS / NLOS classification

Not a random draw — deterministic from building footprints: trace the Tx→Rx
segment, and if it crosses a footprint whose height obstructs the straight
line, the link is NLOS. Three states must be representable: `los`, `nlos`,
`unknown` (no height evidence). `unknown` should be treated conservatively
(assume NLOS) and labelled, never silently treated as LOS.

### 2.4 Model selection, and which models this band can actually use

`domain/rf/propagation-select.ts` is the single synchronous dispatcher used by
both the ray tracer and the coverage heatmap, so the two layers drawn on the
same map can never disagree about what a model means. It holds no physics —
every branch calls the same model module the legacy link-budget and
coverage-grid tools call. `site-signal.ts`'s async `computeBasePathLossDb()`
delegates to it for every model they share and keeps only its ITM branch.

**ITM is deliberately not selectable here.** Its algorithm is profile-shaped,
so it is meaningless without per-point terrain; it stays on the legacy
`/point-analysis` and `/coverage-grid` paths, which do resolve real profiles.

A model returning `null` is a real answer, not an error — it means the model
declines that input. Callers must propagate the gap: the ray tracer counts
`declinedSamples`, the heatmap leaves the cell `null`, and neither substitutes
another model. Relabelling one model's output as another's is the most
misleading thing a planning tool can do.

Published validity, and the verdict at **CBRS n48 (3.6 GHz, 25 m pole)**:

| Model | Frequency | Tx height | Distance | At 3.6 GHz / 25 m |
|---|---|---|---|---|
| UMa (TR 38.901) | 0.5–100 GHz | — | 10–5000 m | **valid — the default** |
| FSPL | any | — | any | valid (best-case bound only) |
| Close-in (UMi SC) | 2–73.5 GHz | — | — | **valid** |
| Log-distance | any | — | — | valid (needs a measured exponent to mean much) |
| Hata | 0.15–1.5 GHz | 30–200 m | 1–10 km | **out of band, and the pole is too short** |
| COST-231-Hata | 1.5–2.0 GHz | 30–200 m | 1–20 km | **out of band** |
| Walfisch-Ikegami | 0.8–2.0 GHz | 4–50 m | 20–5000 m | **out of band** |

Those last three **hard-reject** out-of-range inputs rather than extrapolating
(see `hata-model.ts`'s own `rangeCheck`). So selecting one on this deployment
would previously have produced a technically-successful run with a completely
empty map and no stated reason. `modelApplicability()` therefore gates the run
up front, reports the real published numbers, and names the models that do
cover the scenario. Two details worth keeping:

- A radius **below** a model's minimum is **blocking** (every sample would be
  declined); a radius **above** its maximum is only a **warning** (just the far
  edge is lost).
- Suggestions are computed with a separate non-recursive helper. Computing them
  by recursing into `modelApplicability()` deadlocks the stack the moment two
  models are mutually inapplicable — which is the normal case here, since three
  are out of band simultaneously.

Hata ends at 1.5 GHz and COST-231 begins at 1.5 GHz, so **1.5 GHz is the only
frequency where all seven models are simultaneously in range** — useful to know
when writing a test that needs one input every model accepts.

## 2.5 Coverage heatmap

`domain/rf/coverage-heatmap.ts` is the continuous raster the ray tracer
deliberately is not: the raster answers "how good is it here", the rays answer
"why". Both belong on the map, and they share `receivedPowerAtPoint()` so
identical geometry cannot produce two different answers.

It is multi-cell by construction, because the useful version of this layer is
**best-server**: every grid point is evaluated against every cell, the
strongest becomes the serving cell and the rest become interference. Drawing a
per-cell heatmap independently would overpaint neighbours and show coverage the
network does not deliver.

- Grid is **row-major with row 0 at the NORTH edge**, matching how Leaflet
  draws an image overlay (top edge at `maxLat`), so the client can blit it
  straight into an `ImageData` with no flip. A vertically mirrored raster is a
  completely plausible-looking bug, so there is a test asserting the ordering
  using the antenna pattern as a compass.
- Sample ceiling is 25,600 points; a finer request is **reduced to fit** rather
  than refused, and the result reports the resolution actually used.
- Rendering interpolates bilinearly between real samples but **never across a
  `null`** — a declined or out-of-range point stays transparent rather than
  being papered over with a guess.

## 3. Link budget

```
Rx_dBm = Tx_conducted_dBm
       + Tx_antenna_gain_dBi
       + Rx_antenna_gain_dBi
       + calibration_offset_dB
       − PL_total_dB                 # from §2
       − pattern_attenuation_dB      # §4, RELATIVE, not the absolute gain
       − system_loss_dB
       − polarization_loss_dB
       − building_entry_loss_dB       # §6, only when evaluating indoors
```

EIRP (report it; users ask for it and SAS grants are expressed in it):

```
EIRP_dBm = Tx_conducted_dBm + Tx_antenna_gain_dBi − system_loss_dB
```

Keep conducted power, absolute gain and *relative* pattern attenuation as three
separate reported terms. Collapsing them is the single easiest way to double-
count antenna gain.

## 4. Antenna patterns

The shared 3GPP quadratic form (TR 38.901 Table 7.3-1):

```
A(θ) = min( cap_dB, 12 · (|θ| / θ_3dB)² )
```

| Pattern | Horizontal | Vertical |
|---|---|---|
| `omni` / `ideal-sector` | 0 dB (flat) | 0 dB |
| `cosine-sector` | `A(θ, θ_3dB = max(beamwidth/2, 1), cap 30)` | analytic, below |
| `3gpp-single-element` | `A(θ, θ_3dB = 65°, cap 30)` | `A(φ, 65°, cap 30)` |

Vertical analytic patterns: `panel-10deg` → θ_3dB = 10°, `panel-20deg` → 20°,
cap 30 dB; anything else flat.

For `3gpp-single-element` the two terms are summed and then capped **once** at
30 dB total (per Table 7.3-1's 3D element definition) — not capped
independently at 30 dB each, which would allow 60 dB of sidelobe suppression.

Vertical offset angle comes from geometry: downtilt (mechanical + electrical)
versus the elevation angle to the receiver at that ground distance.

## 5. Receiver threshold

Two modes, and the distinction must stay visible in the output — a configured
number must never be presented as if a noise model produced it.

**Manual**: the sensitivity is the configured dBm. No noise/SNR/margin terms.

**Derived** (thermal-noise-limited):

```
N_0        = −174 dBm/Hz                      # rounded 290 K convention
thermal    = N_0 + 10·log10(T/290) + 10·log10(B_Hz)
noise_floor= thermal + NF_dB
sensitivity= noise_floor + required_SNR_dB + margin_dB
```

`B_Hz` is a noise-equivalent bandwidth, **not** the interference
subcarrier/resource-element bandwidth. Mixing them up is a real trap.

Usability is strict: `usable ⇔ Rx_dBm > sensitivity_dBm` (equality is not
usable). Link margin = `Rx_dBm − sensitivity_dBm`.

Interference is deliberately **excluded** from sensitivity; it is evaluated
separately in §7.

## 6. Building entry (indoor-just-inside-facade)

Reference: TR 38.901 §7.4.3.1, Table 7.4.3-1 material losses, valid
0.6–100 GHz. Per-material loss is linear in frequency:

| Material | L(f) dB, f in GHz |
|---|---|
| standard multi-pane glass | `2.0 + 0.2·f` |
| IRR glass | `25.4 + 0.11·f` |
| concrete | `5.0 + 4.0·f` |

Composition (low-loss = 30% standard glass / 70% concrete; high-loss = 70% IRR
glass / 30% concrete), with `PL_npi = 5 dB`:

```
T   = p_glass·10^(−L_glass/10) + p_concrete·10^(−L_concrete/10)
PL_tw = PL_npi − 10·log10(T)
PL_in = 0.5 · d_2D_in            # d_2D_in = 0 for just-inside-facade
L_building = PL_tw + PL_in
```

Reference shadow sigma: 4.4 dB low-loss, 6.5 dB high-loss — report it, but do
**not** sample a random draw; the model stays deterministic.

Sanity values at 3.6 GHz: low-loss ≈ **12.7 dB**. A single flat 20 dB is the
TR 38.901 Table 7.4.3-3 backward-compatible value for 2.6 GHz only — don't
apply it across the band.

## 7. Interference and radio quality

Work in milliwatts, convert once at the end.

```
mW   = 10^(dBm/10)
dBm  = 10·log10(mW)
```

Per-resource-element thermal noise:

```
N_RE_dBm = thermal_noise(B = SCS_kHz·1000, NF_dB, 290 K)      # §5 formula
```

Given desired power, aggregate co-channel interference power and noise power
(all mW) and `N_RB` resource blocks:

```
occupied_subcarriers = 12 · N_RB
SINR_dB = 10·log10( P_desired / (P_noise + P_interference) )
RSSI_mW = occupied_subcarriers · (P_desired + P_interference + P_noise)
RSRQ_dB = 10·log10( N_RB · P_desired / RSSI_mW )
```

Interference power should be scaled by each interferer's load factor and
frequency-reuse relationship before summing.

Resource-block tables:

| 4G LTE (SCS 15 kHz, `lte_crs`) | 1.4 | 3 | 5 | 10 | 15 | 20 MHz |
|---|---|---|---|---|---|---|
| N_RB | 6 | 15 | 25 | 50 | 75 | 100 |

| 5G NR (SCS 120 kHz, `nr_ss`) | 50 | 100 | 200 | 400 MHz |
|---|---|---|---|---|
| N_RB | 32 | 66 | 132 | 264 |

**These NR values assume 120 kHz SCS (mmWave numerology).** For CBRS n48 the
realistic numerology is **30 kHz SCS**, which gives different RB counts
(≈ 51 RB @ 20 MHz, 273 RB @ 100 MHz). This must be corrected for our bands
rather than inherited.

Planning thresholds (ours to set; these are the inherited defaults):

```
RSRP ≥ −110 dBm      SINR ≥ 0 dB      RSRQ ≥ −20 dB
```

A point is *interference-limited* when RSRP is adequate but SINR or RSRQ fails
— that distinction is what makes an interference map actionable rather than
just another coverage map.

## 8. Demand weighting  (⚠ A.T.O.M-origin values — see Provenance)

Per-building demand score, additive:

| Source | Score |
|---|---|
| `shop` | mall 100, department_store 100, supermarket 80 |
| `amenity` | hospital 70, university 65, cafe/clinic/school/restaurant 50 |
| `office` present | 35 |
| `building` | hospital 70, university 60, commercial 45, school 45, retail 40, office 35, dormitory 30, public 20 |
| name keyword | mall 100, hospital 70, university 65, school 50, tower/plaza 45 |
| footprint area | ≥20 000 m² → 30, ≥10 000 → 20, ≥5 000 → 10 |

Residential demand by `building`: dormitory 25, apartments 24, residential 20,
house 12, terrace 12, detached 10, semidetached_house 10; plus
`min(density_score · 0.25, 30)` when `density_score ≥ 25`.

Density (neighbours within a chosen radius — 100 m is a reasonable choice):

```
density_score = min(100, nearby_buildings·1.4 + nearby_residential·3.0)
```

## 9. Coverage, optimization and validation

- **Coverage surface**: evaluate §2–§5 on a regular lat/lon grid; emit the grid
  plus isolines. Sample spacing is the cost/precision dial.
- **Coverage gap**: demand-weighted buildings inside the served beam whose raw
  Rx power fails a *separate* building-service threshold (−100 dBm is the
  inherited value). Keep it distinct from receiver sensitivity and from the
  interference criteria — three different questions.
- **Optimization**: score candidate azimuth/site sets on covered demand,
  propagation reach and overlap penalty; normalise 0–100; keep the Pareto set
  rather than one winner, and report per-cell contribution so a result can be
  argued with.
- **Measurement validation**: against real RSRP samples compute
  `MAE`, `RMSE`, `bias = mean(predicted − measured)`. Validate on *spatially
  blocked* folds, not random splits — nearby samples are correlated, and random
  splits flatter the model badly. A global dB correction may be offered only
  when it is holdout-checked, and must be labelled as a fitted correction.

## 10. Reporting discipline

Every result should carry: the model id actually applied, its applicability
verdict and reason, the LOS/NLOS state with its height-evidence provenance, and
the limitations that apply. These are planning estimates from static geometry —
not drive-test, UE or PHY measurements — and the output should say so.

---

## 11. Feature parity target

What we already had before this exercise, what A.T.O.M had, and therefore what
is actually missing. Our existing engine is ~4,100 LOC and already carries
**more propagation models than A.T.O.M did**, so the gap is narrower than the
line count suggests.

### Already implemented (no work needed)

| Capability | Where |
|---|---|
| FSPL, Hata, Walfisch-Ikegami, close-in (UMi SC), log-distance, ITM/Longley-Rice | `domain/rf/*-model.ts` |
| Antenna patterns: horizontal, vertical, combined, directional gain | `antenna-pattern.ts` |
| EIRP, link budget, noise floor | `eirp.ts`, `linkbudget.ts`, `noise.ts` |
| Knife-edge diffraction, Fresnel-Kirchhoff, Fresnel zone, earth curvature | `diffraction.ts`, `fresnel-zone.ts`, `earth-curvature.ts` |
| Terrain profile + elevation/landcover providers | `terrain-profile.ts`, `*-provider.ts` |
| Coverage grid, interference grid with SINR, point analysis | `coverage-grid.ts`, `interference.ts`, `point-analysis.ts` |
| Projects, sites, survey points, calibration, PDF report | `rf-planning-projects-controller.ts`, `rf-planning-reports-controller.ts` |
| LTE band table | `lte-bands.ts` |

### Gap — to build for parity

| # | Capability | Notes |
|---|---|---|
| 1 | **3GPP TR 38.901 UMa** model | §2.1. We have UMi street-canyon, not UMa. Add as a selectable model. |
| 2 | **Building-footprint LOS/NLOS** | §2.3. We classify LOS from *terrain*; A.T.O.M used building polygons. Needs the OSM import (`domain/rf/osm-buildings.ts`, already written). |
| 3 | **RSRP / RSRQ / RSSI** | §7. We compute SINR only. Needs the RB-count reconstruction — and the **30 kHz SCS correction** for CBRS n48. |
| 4 | **Building entry (O2I)** | §6. Material-composition entry loss at the facade. |
| 5 | **Coverage gap finder** | §9. Demand-weighted buildings failing a separate building-service threshold. |
| 6 | **Demand model** | §8. Per-building demand/residential/density from OSM tags. |
| 7 | **Network optimization + Pareto** | §9. Azimuth/site scoring, 0–100 normalised, feasible set, per-cell explanation. |
| 8 | **Candidate site recommendation** | §9. Rank unselected candidate positions by marginal coverage and demand. |
| 9 | **Measurement validation** | §9. MAE/RMSE/bias vs real RSRP, spatially blocked folds. Feeds from the UE Signal module's real RSRP history. |
| 10 | **OSM building import** | Fetcher exists; needs wiring to project storage. |

### Explicitly out of scope

A.T.O.M's sub-THz / 6G research workflows (140 GHz atmospheric, P.1411
reference, specular reflection reference) are omitted deliberately. This is a
CBRS 3.5 GHz network; those paths were applicability-gated research diagnostics
that never fed canonical results, and carrying them would mean maintaining
physics we cannot validate against anything we operate.

### Workflow requirement (the reason for the rewrite)

A.T.O.M's four-stage Plan/Simulate/Analyze/Review workspace was rejected as too
complex. The target is: **drop a radio on the map → fill in its parameters →
simulate.** Everything above must be reachable from that one flow, with
advanced controls progressively disclosed rather than presented up front.
