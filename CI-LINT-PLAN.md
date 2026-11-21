# CI + lint cleanup plan

Engineering worklist, same voice as `TODO.md` — "we should" belongs here, not in
`README.md`/`docs/*.md`. Branch: **`ci-and-lint-cleanup`**. Nothing here lands on
`main` except through a PR with CI already green on it.

**Goal:** every check green, zero errors, and `main` protected so it stays that
way.

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

### Phase 0 — branch and lockfiles · ~1h · IN PROGRESS

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
- [x] CI `lint` job wiring all three.

**Changed LINES, not changed files.** The plan originally said changed files;
that would have been a nuisance gate. The backend has 303 affected files with a
median of 2 findings each, so a one-line edit to almost any file would fail on
findings the author never touched — and the pressure that creates is to put the
edit in a new file to dodge the gate, which is worse code for a greener build.
The script parses `git diff -U0` hunk headers for genuinely added line numbers
and reports only findings on those lines. A finding whose line the diff merely
shifted is not yours.

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

### Phase 4 — unblock test-file linting · ~2h

All 120 backend test files currently **fatal** under type-aware lint:
`tsconfig.json` excludes `src/**/__tests__/**` and `src/**/*.test.ts`, so the
parser has no type information for them. ESLint lints zero test files today.

- [ ] Add `backend/tsconfig.eslint.json` extending `tsconfig.json` with the test
      excludes removed, and point `parserOptions.project` at it.
- [ ] Re-baseline.

**Expect the backend count to RISE here** — 120 files of previously invisible
findings, mostly `no-unsafe-*` on mocks. That is the ratchet working as designed,
not a regression: re-baseline with `--update` and say why in the commit message.
The 120 fatals in `lint-baseline.json` are exactly those files, so that number
should go to **0** in the same change — and the ratchet checks fatals
separately, so it will notice if it does not.

### Phase 5 — boundary typing: the collapse · days, the bulk of the work

Where 82% of the backend count actually dies. Type the boundary once, and every
downstream `no-unsafe-*` resolves itself.

- [ ] **HTTP input.** Typed request-body/params validation at each controller
      edge, replacing `any` reads of `req.body`. Biggest single win:
      `ims-controller.ts` (400), `secgw-controller.ts` (344),
      `frr-controller.ts` (224), `gsm-controller.ts` (220).
- [ ] **`JSON.parse`.** A typed parse helper returning `unknown` plus a narrowing
      check, instead of an implicit `any` fanning out.
- [ ] **YAML.** `yaml-config-repository.ts` (185) — the `rawYaml` preservation path
      is inherently untyped; give it a declared shape at the edge. **Do not change
      round-trip behaviour while typing it** (CLAUDE.md pattern #2).
- [ ] **Command output.** `executeCommand()` returns a typed `CommandResult`
      already; the unsafe accesses are on parsed stdout. Type each parser's output.
- [ ] **Then** sweep the 512 `no-misused-promises` and the floating promises.
      Treat every one as a possible real bug before silencing it — this is the
      highest-value rule in the whole set.

**Exit:** backend `no-unsafe-*` near zero; `no-explicit-any` is what remains.

**Rule for this phase: no behaviour changes.** A typing change that alters runtime
behaviour is a separate commit with its own test. The 1,652 existing tests are the
safety net and must stay green at every step.

### Phase 6 — the long tail · days, parallelisable

210 affected files have ≤10 issues each — mechanical, low-risk, easy to split
across sessions. Worth a per-directory sweep so a reviewer sees coherent diffs
rather than one 300-file commit.

- [ ] Then raise the frontend to variant B and repeat Phase 5's boundary work there
      (~4,692 at today's measurement, expected far lower once A's `no-explicit-any`
      work is done, since `no-unsafe-*` largely stems from those same `any`s).

### Phase 7 — zero tolerance · ~1h

- [ ] Flip lint from ratchet to **gate** (`--max-warnings 0`) on both workspaces.
- [ ] Enable branch protection on `main`: require backend, frontend and lint
      checks; no direct pushes.
- [ ] Add `npm run lint` to the local pre-commit path so it fails before CI does.

**Exit:** the stated goal — zero errors, 100% pass rate, enforced.

### Phase 8 — optional extras

- [ ] `docker compose build` smoke job. Works in CI: SASBench's build context is a
      public pinned remote git URL, so it resolves with nothing cloned.
- [ ] Dependabot. Only useful once lockfiles are tracked (Phase 0).
- [ ] A release workflow on `v2.0-beta_*` tags.
- [ ] Claude Code GitHub App for PR review — after Phase 1, so it has green checks
      to reason against.

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
