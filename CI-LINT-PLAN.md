# CI + lint cleanup plan

Engineering worklist, same voice as `TODO.md` — "we should" belongs here, not in
`README.md`/`docs/*.md`. Branch: **`ci-and-lint-cleanup`**. Nothing here lands on
`main` except through a PR with CI already green on it.

**Goal:** every check green, zero errors, and `main` protected so it stays that
way.

**Status, 2026-11-21.** Phases 0-4 and the Dependabot half of 8 are done.
Phases 5-6 — the boundary typing and the long tail — are the multi-week bulk and
have not started; Phase 5 now carries a measured note on where to begin and
which part is risky. Phase 7 is blocked on them by definition. Two items need
the user rather than code: branch protection, and installing the PR-review app.
Nothing is on `main` yet — this branch has not been pushed.

**Created:** 2026-11-21. Every number below was measured on this host on that
date, not estimated — re-measure before trusting them after any dependency bump.

---

## 1. Measured baseline

| | Backend | Frontend |
|---|---|---|
| Source files / lines | 432 / 112,026 | 204 / 69,893 |
| `tsc --noEmit` | **39s, clean** | **1m38s, clean** |
| Tests | **119 suites / 1652 tests, 71s, all pass** | **none exist** |
| Production build | (tsc only) | **2m30s, exit 0** |
| ESLint config | `.eslintrc.json`, type-aware tier | **never existed in git history** |
| ESLint errors | **5,660** + 277 warnings, 303/432 files | **488** + 32 warnings, 79/205 files |
| Auto-fixable | 39 (0.7%) | 0 |
| Test files linted | **0 of 120** — fatal parse errors | n/a |
| Lint runtime | 4m05s | 37s |

Both sides are on ESLint 8.x (`.eslintrc.*`, not flat config). Node 20 is the pin
(`engines: >=20`, both Dockerfiles `node:20`).

> **Four corrections to the table above, found by actually running the work.**
> Kept here rather than silently edited, because each one was a wrong assumption
> and the reason matters more than the number.
>
> 1. **`npm ci` backend is ~291s on Node 20, not 23s.** The 23s was measured on
>    this host, which runs **Node 18**. better-sqlite3 12.11.1 ships no prebuild
>    for Node 20's ABI, so every uncached install compiles it from source. Phase
>    1 has the detail.
> 2. **`jest` is ~135s, not 71s**, on a 2-core-class machine. Still comfortable.
> 3. **The frontend's 488 was measured without `--report-unused-disable-directives`**,
>    which the real `npm run lint` script includes. With it, 11 dead disable
>    directives also surfaced.
> 4. **Two of the three rule groups Phase 2 predicted were mischaracterised.**
>    `no-constant-condition` was not dead code and `no-unused-vars` was not
>    unused variables; both were correct idioms that the config, not the code,
>    needed to account for. Phase 2 has the detail. The lesson for Phases 5-6:
>    **read a sample of the findings before budgeting for a rule** — a rule name
>    is not a diagnosis, and 27 of these "fixes" turned out to be two config
>    lines.
>
> Live counts are in `lint-baseline.json`, which the CI ratchet reads. Treat that
> file as current and this table as the 2026-11-21 starting point.

**ESLint 8.57.1 is end-of-life upstream** — `npm ci` warns on it. That does not
block anything here and migrating to ESLint 9 flat config mid-cleanup would mean
re-baselining every count in this document, so it is deliberately deferred to
after Phase 7. Do it as its own change, against a green tree, never bundled with
rule work.

The repo is **public**, so GitHub Actions runs free with unlimited standard-runner
minutes. Cost is not a constraint anywhere in this plan.

### Two facts that drive the whole plan

**The backend's errors are concentrated, not spread.** Four rules are 82.3% of
everything:

| Count | % | Rule |
|---|---|---|
| 1,865 | 31.4% | `no-unsafe-member-access` |
| 1,727 | 29.1% | `no-unsafe-assignment` |
| 784 | 13.2% | `no-explicit-any` |
| 512 | 8.6% | `no-misused-promises` |

And the file distribution is heavily skewed: **median 2 issues per affected file,
p90 of 54, max 400.** The worst 12 files hold 2,511 issues — **42% of the total**:

```
400  src/interfaces/rest/ims-controller.ts
344  src/interfaces/rest/secgw-controller.ts
339  src/application/use-cases/auto-config.ts
224  src/interfaces/rest/frr-controller.ts
220  src/interfaces/rest/gsm-controller.ts
185  src/infrastructure/yaml/yaml-config-repository.ts
174  src/interfaces/rest/genieacs-controller.ts
158  src/interfaces/rest/pstn-controller.ts
154  src/interfaces/rest/validation-controller.ts
108  src/application/use-cases/pcap.ts
106  src/application/use-cases/subscriber-management.ts
 99  src/interfaces/rest/sms-controller.ts
```

210 of the 303 affected files have **10 or fewer** issues.

**The `no-unsafe-*` family is one root cause, not 3,886 problems.** Every one is an
untyped value crossing an I/O boundary: `req.body`/`req.params`, `JSON.parse()`,
`yaml.parse()`, and `executeCommand()` stdout. Typing a handful of boundary helpers
collapses thousands of individual errors at once. **Do not fix these one call site
at a time** — that is the difference between this plan taking weeks and taking
months.

### Frontend: pick the target deliberately

The frontend has no config, so the target is a choice. Both variants measured:

| Variant | Extends | Errors | Files |
|---|---|---|---|
| **A — standard** | `eslint:recommended` + `@typescript-eslint/recommended` + `react-hooks` | **488** | 79/205 |
| **B — type-aware** | A + `recommended-requiring-type-checking` (mirrors backend) | **4,692** | 138/205 |

Variant A's breakdown is overwhelmingly one mechanical rule, plus a short tail that
is worth real attention:

```
459  @typescript-eslint/no-explicit-any      <- mechanical, 94% of the total
 23  react-hooks/exhaustive-deps             <- REAL bug candidates
 20  no-constant-condition                   <- REAL bug candidates
  9  react-refresh/only-export-components
  7  @typescript-eslint/no-unused-vars
  2  react-hooks/rules-of-hooks              <- REAL bugs
```

**Adopt A now, B at Phase 5.** Starting at B means 4,692 errors before anything is
green, which stalls the whole effort; and A already surfaces the 25 items with
actual bug potential, which is most of the near-term value. The frontend tsconfig
is already `strict: true` with `noUnusedLocals`/`noUnusedParameters` and typechecks
clean, so B is reachable later rather than hypothetical.

---

## 2. Ordering principle

Fix in order of **what a rule actually catches**, not how many hits it has:

1. **Rules that catch real bugs** — `rules-of-hooks`, `exhaustive-deps`,
   `no-constant-condition`, `no-misused-promises` (512), `no-floating-promises`
   (11 backend). These find unhandled rejections and fire-and-forget async, which
   is *this project's own recurring defect class* — `executeCommand()` resolving on
   failure instead of throwing, restarts reported as successful while the unit was
   dead, `systemctl` results discarded. CLAUDE.md's "Verify, don't trust success"
   rule exists because of exactly these. **665 findings here are worth more than
   the other 5,000 combined.**
2. **Structural typing** — the `no-unsafe-*` family, fixed at the boundary.
3. **Cosmetic** — `explicit-function-return-type` (277 warnings), formatting.

---

## 3. Phases

### Phase 0 — branch and lockfiles · DONE

- [x] Branch `ci-and-lint-cleanup` off `main`.
- [x] Remove `package-lock.json` from `.gitignore` (line 6), with a comment saying
      why it is now tracked.
- [x] Commit both lockfiles (backend 678 packages, frontend 391, both
      `lockfileVersion: 3`).
- [x] **Verified** `npm ci` succeeds from each lockfile in a clean directory — a
      tracked-but-stale lockfile fails *only* in CI, which is the worst place.
      Backend: 652 packages, 23s. Frontend: 343 packages, 18s. Both exit 0.

**Exit:** reached — `npm ci` reproduces both trees from a clean checkout.

**Why this is first:** without a lockfile `npm ci` cannot run at all, and
`npm install` re-resolves every dependency per run — so a transitive release can
turn the build red on a commit that changed nothing, with no way to reproduce the
failing tree locally.

### Phase 1 — CI on what is already green · DONE

`.github/workflows/ci.yml`, on pushes to `main` and all PRs. Two parallel jobs,
Node 20 (matching `engines` and both Dockerfiles), with `node_modules` cached on
the lockfile hash. Neither job needs a secret, which matters on a public repo:
fork PRs get no secrets by default, and these jobs want none.

**Both jobs were run end-to-end before being committed**, in a `node:20`
container against a `git archive HEAD` checkout — not assumed from the host.
Results:

| | Result |
|---|---|
| backend `npm ci` | exit 0 |
| backend `tsc --noEmit` | exit 0, 36s |
| backend `jest --runInBand` | exit 0, **119/119 suites, 1652/1652 tests**, 135s |
| frontend `npm ci` | exit 0 |
| frontend `npm run build` | exit 0, 210s |

`jest` stays `--runInBand` per the existing npm script: serial avoids any
shared-state surprise on a 2-core runner.

**Finding — `npm ci` is far slower than the host suggested, and structurally so.**
It took **291s** in the container, against 23s measured on this host. Cause, read
off the upstream release rather than guessed: **better-sqlite3 12.11.1 publishes
node prebuilds for ABI v127/v137/v141/v147 only. Node 20 is ABI 115 and is not
among them**, so `prebuild-install` 404s and `node-gyp` compiles from source on
every uncached install. It works at all only because the runner ships python3 and
g++ — the backend Dockerfile installs exactly those three packages, with a
comment saying why. The host measured 23s because it runs **Node 18**, which has
a prebuild. (That host/Node mismatch is itself worth knowing: `engines` says
`>=20` and both Dockerfiles use `node:20`, so local `npm test` runs on a different
major than production.)

Hence `node_modules` is cached, not just `~/.npm`. The key is the lockfile hash,
so a dependency change always misses and re-runs `npm ci` in full — lockfile
drift cannot hide behind a stale cache. **If install time ever becomes the
bottleneck, the real lever is Node 22 (ABI v127), which has a prebuild** — but
that changes the runtime this project ships on and is a deployment decision, not
a CI one.

Container timings here are upper bounds: this host is a 2009-era Xeon under load,
and a GitHub runner is faster.

**This phase is worth doing even if every later phase is abandoned.** It covers
the 1,652 tests that pin real, previously-shipped defects.

### Phase 2 — frontend lint config + the real bugs · DONE

**Exit criterion met: `npm run lint` reports 459 errors, every one
`no-explicit-any`, and zero warnings.**

- [x] Add `frontend/.eslintrc.cjs` (variant A). All required plugins were already
      in `devDependencies` (`@typescript-eslint` 6.17, `react-hooks` 4.6,
      `react-refresh` 0.4.5) — only the config file was ever missing, which is why
      `npm run lint` had failed since the script was written.
- [x] `rules-of-hooks` (2) — **one real latent crash.** `SgwcEditor.tsx` called
      `useState` twice *after* an early return. React identifies a hook by call
      order, so `sgwc.gtpc.server` appearing or vanishing while that tab stays
      mounted throws *"Rendered more/fewer hooks than during the previous
      render"* and takes the config page down. Both hooks hoisted above the
      return; the initialisers are constants, so nothing else changed.
- [x] `exhaustive-deps` (23) — hand-reviewed, never autofixed. **Four were real
      bugs:**
      - `FRRPage.tsx` — the unmount cleanup read `neighborTimer` from a
        `useState` captured by a mount-only effect, so it was always `null` and
        **the 5s `validateNeighbor()` poll was never cleared**; leaving the page
        mid-poll leaked it for the rest of the session. Now cleared via a ref.
      - `RadioSignalPage.tsx` — the 15s interval's closure held `selectedKey`
        from when `search`/`hours` last changed, i.e. `''` on mount, so
        `!selectedKey` stayed true forever and **every poll re-selected the first
        UE, overwriting the operator's own selection every 15 seconds.** Fixed
        with the functional `setSelectedKey(prev => prev || …)` form.
      - `RANPage.tsx` — a memo read `gsm2g.btsEntries` but listed only
        `gsm2g.samples`. The two arrive from separate fetches, so a
        `btsEntries`-only change left **every 2G row's Radio column blank**, and
        those rows bypassing the band/IP filter as "no known radio", until the
        next samples poll happened to recompute it.
      - `MobileNavSheet.tsx` — focus-return read `returnFocusTo.current` inside
        the cleanup, i.e. at close time rather than open time. Resolved at setup
        instead, which both silences the rule and matches what the comment says
        the code does.
      Two more were pure performance (`RANPage`'s `|| []` producing a fresh array
      identity every render; a redundant `band` dep in `BandOccupancy` that
      defeated its own memo). The remaining 17 are deliberate omissions and each
      now carries a **line-scoped disable with a specific reason** — no blanket
      disables. The four `TwampPage` ones are worth singling out: `reloadKey` is
      unused inside the callback *by design*, as bumping it changes the
      callback's identity and that is what makes the Refresh control refetch.
      "Fixing" the rule's complaint there would have silently broken Refresh.
- [x] `no-constant-condition` (20) — **the plan's assumption here was wrong.**
      These were not dead code or inverted tests: **all 20 were `while (true)`
      loops draining a `ReadableStream` reader**, which is how this app streams
      `apt-get` output into an install log. ESLint 9 changed this rule's own
      default to stop flagging them, via `checkLoops: "allExceptWhileTrue"`;
      8.57 accepts only a boolean and rejects that string as a schema error, so
      both workspaces now set `checkLoops: false`. The useful half of the rule is
      intact — a constant condition in an `if`, ternary or `&&` is still an error.
      Applied to the backend too (2 sites: an Overpass endpoint scheduler and a
      Mongo pagination loop) so there is one policy, not two.
- [x] `no-unused-vars` (7) — **also not what the plan assumed.** All 7 were the
      `const { sd, ...rest } = x` idiom this codebase uses to drop an optional
      key, so the omitted binding is deliberately never read. `ignoreRestSiblings`
      covers exactly that case: **zero code changes, config only.** A genuinely
      unused variable is still an error.
- [x] `react-refresh` (9) — HMR quality only, no production effect, but
      `--max-warnings 0` is already in the lint script so they had to reach zero.
      `RADIO_LAYOUTS`, `siteToRadio` and `radioToSite` simply had no importers
      and no longer carry `export`. The three `MobileKit` formatters moved to
      `src/mobile/format.ts`. Both contexts were split — `auth-context.ts` and
      `theme-context.ts` now hold the context object, its types and its hook,
      with only the provider left in the `.tsx` — and 13 consumer imports were
      repointed. This one is a real DX win rather than box-ticking: a
      non-component export disables Fast Refresh for the whole module, so
      editing `AuthContext.tsx` forced a full reload, and a full reload of this
      app re-checks the session and drops you back through the auth gate.
- [x] Removed **11 dead `eslint-disable` directives** that
      `--report-unused-disable-directives` surfaced: 8 per-site
      `no-constant-condition` disables made redundant by the config above, and 3
      `exhaustive-deps` disables on hooks that no longer report anything. One
      more in `DhcpPage.tsx` was *misplaced* — a `disable-next-line` sitting
      inside the effect body, one line below the reported line, suppressing
      nothing. **The plan's 488-error frontend figure did not include these**,
      because it was measured without that flag; the real `npm run lint` has it.

Verified after the fact: `tsc --noEmit` clean, production build exit 0, container
rebuilt and restarted, and the served bundle confirmed to carry both new context
modules.

**Exit:** reached.

### Phase 3 — make lint measurable and ratcheted · DONE

Lint cannot gate yet, but it must stop getting worse.

- [x] `lint-baseline.json` at the repo root holds the per-workspace count.
      Numbers live there, not in this document, so the two cannot drift.
- [x] `scripts/lint-ratchet.mjs` — fails when a workspace's count **rises**, and
      prints the exact `--update` command when it falls. Reads ESLint JSON on
      stdin, fed by a new `lint:json` npm script in each workspace, so the rule
      set stays single-sourced in the config the humans already use.
- [x] `scripts/lint-changed-lines.mjs` — the blocking half.
- [x] CI `lint` job wiring all three. **All three now run even when one fails**
      (#64), with a verdict step deciding the job from their outcomes. They
      failed fast until then, so a ratchet failure meant the changed-lines gate
      never executed — losing the half of the job with per-line attribution,
      which is exactly what made four PRs undiagnosable from their logs.

**Changed LINES, not changed files.** The plan originally said changed files;
that would have been a nuisance gate. The backend has 303 affected files with a
median of 2 findings each, so a one-line edit to almost any file would fail on
findings the author never touched — and the pressure that creates is to put the
edit in a new file to dodge the gate, which is worse code for a greener build.
The script reads the **body** of `git diff -U0` for genuinely added line
numbers and reports only findings on those lines. A finding whose line the diff
merely shifted is not yours.

**It read the hunk HEADERS until 2026-11-21, and that was wrong twice over.**
Both were found by running real contributions through it, not by reading it.
(1) Git's hunk alignment routinely emits a byte-identical line as a `-`/`+`
pair, and a header-only reader counts it as added — so the gate failed a line
nobody had edited. Fixed in #62 by matching added content against the content
the same hunk removed, as a multiset so a genuine duplicate still counts.
(2) The CI step passed `github.event.pull_request.base.sha`, which is the base
as it stood when the PR was **opened**, while the job checks out
`refs/pull/N/merge` — so `merge-base` resolved to that old commit and every
commit `main` had landed since got diffed into the PR. On a one-file PR that
reported 46 changed files, with the blocking findings sitting in `main`'s own
test files. Fixed in #63 by comparing against the base branch's current tip,
and the gate now prints the base and merge-base it resolved, because a wrong
base is the one failure mode here that produces a credible-looking red build
rather than an obvious error.

**The ratchet's guards were tested, not assumed** — a ratchet that fails open is
worse than none, because it reports success. All five paths confirmed: empty
stdin → exit 2; non-JSON (eslint crashed) → exit 2; JSON that is not an array →
exit 2; count risen → exit 1; count fallen → exit 0 with the re-baseline command.
Without the first three, a crashed eslint would parse as "no findings", pass the
job, and with `--update` would overwrite the baseline with zeros.

`fatals` is tracked as its own number and ratcheted separately, because a fatal
is a **parse** failure — the file was not linted at all — and counting it as one
finding understates it badly.

The changed-lines gate exits 0 rather than failing when the base commit is
unusable (an all-zero SHA on a branch's first push, or a force-pushed SHA that no
longer exists). Neither is a defect in the change under test.

**Exit:** reached — no new lint findings can merge on an added line, and the
totals only move down.

**With one honest caveat about what "reached" meant.** The first six real pull
requests to meet this gate all failed it, and every one of those failures was
the gate's own two bugs above, not the contributions. Ratchets, typechecks and
tests passed on all six. A gate's exit criterion is not met when it is merged;
it is met when it has judged real changes correctly, and that took two more
fixes after this phase was marked done. Worth remembering before marking a
later phase complete on the strength of its own test suite.

### Phase 4 — unblock test-file linting · DONE

All 120 backend test files **fataled** under type-aware lint: `tsconfig.json`
excludes `src/**/__tests__/**` and `src/**/*.test.ts`, and a file outside
`parserOptions.project` is a fatal parse error rather than a skipped file — so
ESLint linted zero test files, while the count showed 120 findings that looked
like ordinary ones.

- [x] `backend/tsconfig.eslint.json` extends `tsconfig.json` and overrides only
      `exclude`, dropping the two test patterns. It never emits. The production
      `tsconfig.json` is untouched — its exclusion of test files is deliberate
      and documented on the `exclude` itself.
- [x] `parserOptions.project` repointed at it.
- [x] Re-baselined.

Result:

| | before | after |
|---|---|---|
| errors | 5,658 | **6,293** (+635) |
| warnings | 277 | **408** (+131) |
| **fatals** | **120** | **0** |
| files with findings | 303 | 246 |

The rise is the ratchet working as designed. The fall in "files with findings"
is not a contradiction: each of the 120 fatals counted as a file with a
finding, and 57 of those test files turn out to be completely clean.

Newly visible: 215 `no-unsafe-member-access`, 158 `no-unsafe-assignment`, 131
`explicit-function-return-type`, 110 `no-explicit-any`, 106 `require-await` —
mostly mocks, as predicted.

One thing worth knowing for Phase 5: `src/__tests__/ran-radio-grouping.test.ts`
imports the RAN page's pure grouping module out of `frontend/src`. TypeScript
pulls an imported file into the program whether `include` names it or not, and
that module deliberately has no imports of its own, so no extra config was
needed — but it is the reason the production `tsconfig.json` cannot simply stop
excluding tests (`rootDir` would reject it).

**Expect the backend count to RISE here** — 120 files of previously invisible
findings, mostly `no-unsafe-*` on mocks. That is the ratchet working as designed,
not a regression: re-baseline with `--update` and say why in the commit message.
The 120 fatals in `lint-baseline.json` are exactly those files, so that number
should go to **0** in the same change — and the ratchet checks fatals
separately, so it will notice if it does not.

### Phase 5 — boundary typing: the collapse · days, the bulk of the work · NOT STARTED

Where 82% of the backend count actually dies. Type the boundary once, and every
downstream `no-unsafe-*` resolves itself.

**Measured 2026-11-21, to say where to start.** The 3,986 `no-unsafe-*` findings
are concentrated the same way everything else here is: **121 files carry all of
them, and the top 15 hold 51.7%.**

```
328  interfaces/rest/ims-controller.ts
302  interfaces/rest/secgw-controller.ts
284  application/use-cases/auto-config.ts
146  interfaces/rest/gsm-controller.ts
136  interfaces/rest/frr-controller.ts
122  interfaces/rest/genieacs-controller.ts
110  interfaces/rest/validation-controller.ts
101  interfaces/rest/pstn-controller.ts
 97  infrastructure/yaml/yaml-config-repository.ts
 82  application/use-cases/pcap.ts
```

A first attempt to classify them by the line each sits on was **not conclusive
and should not be repeated** — it put only ~7% on a visible `req.body` /
`JSON.parse` / `yaml.parse` / `stdout` expression and 59% in an
unattributable bucket, which looks like a refutation of the premise above and
is not one. Reading an actual sample settled it: those lines are things like
`raw.nrf`, `config.gtpc.port`, `upf.gtpu.addr`, `seppRaw?.n32?.server?.[0]`,
`sample.sampled_at`, `r.maxSessions`, `body.espDhGroup` — genuinely boundary
values, reached through two or three intervening assignments, which a
line-level regex cannot see. **The premise holds; measuring it needs dataflow,
not grep.**

What the sample does establish is the ORDER. The single largest untyped
boundary is **the parsed YAML config object**, which `yaml-config-repository.ts`
hands out and which then spreads through `auto-config.ts`, `pcap.ts`,
`config-controller.ts`, `ip-plan-controller.ts`, `dns-migration-usecase.ts` and
`validation-controller.ts`. Giving that one value a declared shape is the
highest-leverage change available — and the riskiest, because **CLAUDE.md
pattern #2 is non-negotiable: never mutate a parsed config object and expect it
to round-trip; everything goes through `rawYaml`.** So that work needs its own
session and its own careful reading of the round-trip path, not a quick pass.
Second is DB/SQLite row shapes (`radio-signal-controller.ts`,
`twamp-reflector-history.ts`), which are self-contained and much safer, and a
better place to prove the pattern first.

**Progress: 6293 -> 3778 errors (40%) in eleven merged passes, 2026-11-21/22.**
Every pass kept `tsc` clean and the full suite green. The baseline in
`lint-baseline.json` is lowered in each commit and its `_comment` carries the
running history, so trust those numbers over this prose.

- [x] **HTTP input.** Done. `asRecord()`
      (`domain/services/json-shape.ts`, tested) narrows `req.body` at the edge;
      secgw (#69), gsm (#70), frr (#71), ims (#74) and others follow it.
      **The single biggest win in the whole phase was not new typing at all:**
      `req.user` was already declared on `Express.Request` by
      `auth-middleware.ts` and was being thrown away by
      `(req as any).user?.username` in 46 files — 268 identical casts, 1,254
      errors, removed mechanically in #67.
- [x] **`JSON.parse`.** Done, as per-boundary declared shapes rather than one
      helper: PyHSS's REST responses behind a generic `pyhssApiCall<T = unknown>`
      (#74), the `.ims-config.json` state file across its 23 parse sites (#75),
      SASBench's REST API behind a generic `sasbench<T = unknown>` and Kea's
      config JSON (#76), GenieACS device documents (#68), SQLite rows (#66).
      The `unknown` DEFAULT on those generics is the load-bearing part: a call
      site that does not say what it expects has to narrow, instead of
      inheriting `any` the way `Promise<any>` handed it out.
- [ ] **YAML — recon done and the first file typed; the rest is mechanical.**
      Typed document shapes now live in `domain/entities/open5gs-yaml.ts` and
      `auto-config.ts` is done (339 -> 93), taking the backend 3778 -> 3533
      (#78). Remaining, measured 2026-11-26: `yaml-config-repository.ts` (185),
      `validation-controller.ts` (154), `pcap.ts` (108),
      `subscriber-management.ts` (106), `yaml-config-repository.test.ts` (91),
      `auto-assign-ips-usecase.ts` (80), `config-mapper.ts` (76),
      `apn-profile-usecase.ts` (74), `plmn-migration-usecase.ts` (66).
      **Two things the recon established that change how to do this work.**
      First, the reason this phase feared YAML was wrong: comments do NOT
      survive a save for any of the 17 NFs, so there is no comment-preserving
      round trip to break. See CLAUDE.md pattern #2's 2026-11-26 correction for
      the evidence. The real invariant is unknown-KEY preservation via
      `deepMerge`, which a type cannot break at runtime — only a caller that
      REBUILDS a document instead of cloning it can.
      Second, do not reuse `AllConfigsDto`/the frontend's `AllConfigs` as the
      shape. Verified against the live API: `GET /api/config` returns
      `data.amf` with keys `['amf','global','logger']`, while `AmfConfigDto`
      declares that NF's inner fields at its top level — it is off by one
      nesting level and additionally carries document-level `logger`/`global`
      as if they were AMF fields. Both sides cast around it (`as any` in
      `config-mapper.ts`, `configs.amf as any` in `ConfigPage.tsx`). Correcting
      those is an API-contract change touching the frontend, tracked
      separately.
- [x] **Command output.** Done (#71). The framing was right: `executeCommand()`
      already returned a typed `CommandResult`, so every unsafe access was on
      the parsed stdout. The declared parser shapes double as documentation,
      because these are positional parses of human-readable `vtysh` tables and
      the field names are now the only record of what column N meant.
- [x] **`no-misused-promises`, the real half.** Done (#72, #73), and this is
      the clearest vindication of the "treat every one as a possible real bug"
      rule. Of **496** async route handlers, **445 carry their own try/catch
      and 51 did not** — and a handler can *have* a try/catch yet still `await`
      before it opens, which caught **7 more**. Those **58** were genuine
      request hangs: Express holds a Promise it never awaits, so a throw became
      an unhandled rejection with **no response ever written**, and the client
      waited for its own timeout. All 58 now answer 500 and log, via a tested
      `asyncRoute()`. Where there was nothing to await, removing `async` was
      the better repair — a sync throw is caught by Express itself.
- [ ] **`no-misused-promises`, the lint-only half.** The remaining ~438 guarded
      handlers have no defect behind them and can be wrapped mechanically
      whenever Phase 7 wants the count. Blanket-wrapping all 496 at the start
      would have fixed the same 58 while burying them in a diff nobody could
      review.

**Exit:** backend `no-unsafe-*` near zero; `no-explicit-any` is what remains.

### What to carry into the rest of this work

**Rank candidates by findings-per-untyped-VALUE, not by raw count.**
`secgw-controller.ts` had 261 findings from three lines of
`const body = req.body ?? {}`; `genieacs-controller.ts` had 129 from one
device-document type. Raw count points at the biggest file; this points at the
cheapest fix.

**Check whether a type already exists before writing one.** The `req.user`
case was 1,254 errors from casting away a declaration that was already
correct, and `ImsStateConfig` was invented before noticing the state's `config`
block simply *is* the `ImsConfigureInput` that produced it.

**A high finding count does not mean careless code.** `secgw-controller.ts`
validates carefully and its helpers already took `unknown` with real type
predicates. Its 261 findings existed because one entry-point value was `any`.

**Typing a boundary surfaces latent bugs, and that is the real return.** Every
pass found at least one, none of them visible as a lint finding: a `ues` array
holding two shapes; `FRR_LOG_LEVELS.includes()` looking like validation while
narrowing nothing; `failures:` returning `[{}]` because Errors do not
JSON-serialise; an APN id of `undefined` sent on as an id; the literal string
`"undefined"` written into PyHSS's own config YAML; `.padStart()` on a
possibly-absent MNC throwing from inside a domain helper.

**Rule for this phase: no behaviour changes.** A typing change that alters runtime
behaviour is a separate commit with its own test. The 1,652 existing tests are the
safety net and must stay green at every step.

### Phase 6 — the long tail · days, parallelisable · NOT STARTED

210 affected files have ≤10 issues each — mechanical, low-risk, easy to split
across sessions. Worth a per-directory sweep so a reviewer sees coherent diffs
rather than one 300-file commit.

- [ ] Then raise the frontend to variant B and repeat Phase 5's boundary work there
      (~4,692 at today's measurement, expected far lower once A's `no-explicit-any`
      work is done, since `no-unsafe-*` largely stems from those same `any`s).

### Phase 7 — zero tolerance · BLOCKED on 5 and 6

- [ ] Flip lint from ratchet to **gate** (`--max-warnings 0`) on both workspaces.
      Cannot happen before Phases 5-6 land: doing it now makes CI permanently
      red, which is exactly the state the ratchet exists to avoid.
- [x] **Enable branch protection on `main`** — done 2026-11-21. Requires all
      three checks by their exact job names; force-pushes and branch deletion
      blocked; no required reviews (a solo-maintainer repo would deadlock on
      one); `strict`/up-to-date deliberately **off**, since it only creates
      rebase churn on Dependabot PRs for no safety gain here.
      **`enforce_admins` is deliberately off**, which means protection stops
      accidents rather than a determined push: an admin can still push
      directly. That is a considered trade, not an oversight — this repo is one
      revert away from a live LTE/5G core, and keeping a manual override is
      worth more than the stricter posture. Flip it to `true` for a binding
      rule.
- [ ] ~~Add `npm run lint` to the local pre-commit path~~ — **reconsider this
      one.** Backend lint is ~2 min at best and ~4 min under load. A pre-commit
      hook of that length gets `--no-verify`'d within a day, and a hook everyone
      bypasses is worse than none because it creates a false sense of coverage.
      If something local is wanted, the honest options are a `pre-push` hook
      (fires far less often) or a hook that runs only
      `scripts/lint-changed-lines.mjs` — but note that still pays the full
      eslint startup cost, because the type-aware rules need the whole program.
      Leaving this to CI is a defensible answer.

**Exit:** the stated goal — zero errors, 100% pass rate, enforced.

### Phase 8 — optional extras

- [x] **Dependabot** (`.github/dependabot.yml`). Only useful once the lockfiles
      were tracked (Phase 0) and CI existed to validate a bump (Phase 1).
      Deliberately conservative for a repo that deploys a live core: weekly, a
      5-PR cap per workspace, minor+patch grouped into one PR so routine churn
      is one review, majors left separate. **It reached the default branch on
      2026-11-21 and immediately opened 13 PRs** (3 actions, 5 backend, 5
      frontend — the per-workspace caps held). The three `actions/*` majors are
      merged (#47, #48, #50), which also cleared the Node-20-runtime
      deprecation annotation. `mongodb` majors are now in an `ignore` block
      (#60): server 5.0+ needs AVX, this CPU has none, so the server is pinned
      at `mongo:4.4`. Note the reasoning carefully — driver 7 *does* still
      support 4.4, so 4.4 is not itself the blocker; the point is that it is
      the oldest release any current driver supports, which makes every future
      driver major a gamble on the subscriber and SAS-grant store.
- [ ] `docker compose build` smoke job. **Deliberately not added yet, and not
      because of SASBench** — that part is fine, its context is a public pinned
      remote git URL that resolves with nothing cloned. The problem is that the
      backend image's build pulls from `download.docker.com`, `repo.mongodb.org`
      and pypi at build time, so as a per-PR required check it would go red on
      someone else's outage. The right shape is a **scheduled weekly job**, not
      a PR gate — and it should be written and verified in its own change
      rather than committed unrun. The failure class it would catch is real:
      see the 2026-10-30 SASBench entry in CLAUDE.md, where an unresolvable
      build context meant not one service started.
- [ ] A release workflow on `v2.0-beta_*` tags.
- [ ] Claude Code GitHub App for PR review — **needs the user** to install the
      app on the repo.

---

## 4. Risks and rules of engagement

- **A green CI proves almost nothing about this deployment.** Everything through
  `nsenter`/systemd, the 181-endpoint sweep, the clean-host deploy test, real call
  tests and live radios stays manual. CI covers "it compiles and the logic tests
  pass". The unit tests work in CI precisely because they mock `IHostExecutor`.
  Do not let a green badge substitute for the live verification this project
  actually depends on.
- **No blanket `eslint-disable`.** A file- or rule-wide disable converts this whole
  effort into theatre. Every disable is line-scoped and carries a reason comment.
  This matters most for `no-misused-promises`, where a disable can hide the exact
  defect class that has caused real outages here.
- **`exhaustive-deps` is never autofixed.** Hand-review each.
- **The count will go up twice before it goes down** — Phase 4 (test files) and the
  frontend's move to variant B. Both are expected; re-baseline rather than treating
  them as regressions.
- **Re-measure after any dependency bump.** Every number here has a date on it.
- **Read a sample of a rule's findings before budgeting for it.** A rule name is
  not a diagnosis. 27 findings this plan had scheduled as code fixes were two
  config lines, because `no-constant-condition` meant "idiomatic `while (true)`"
  and `no-unused-vars` meant "deliberate rest-destructuring". Conversely, a
  grep-level classification of `no-unsafe-*` looked like it refuted this plan's
  central premise and did not — see Phase 5.
- **A gate that cannot fail is theatre.** Both new scripts were tested against
  their failure paths before being trusted: the ratchet exits 2 on absent or
  malformed eslint output (otherwise a crashed eslint reads as "no findings" and
  `--update` would zero the baseline), and the changed-lines gate was
  mutation-checked by committing a deliberate `any` on a new line and confirming
  exit 1. Do the same to anything added in Phases 5-8.
- **CI timings measured on this host are not CI timings.** It is a 2009-era Xeon
  and was under concurrent load for most of these runs; one backend lint took
  118s on a quiet host and ~4 minutes on a busy one. Treat local numbers as
  upper bounds and re-measure on the runner.
