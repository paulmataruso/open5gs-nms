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

### Phase 1 — CI on what is already green · ~1h

One workflow, `.github/workflows/ci.yml`, on pushes to `main` and all PRs. Two
parallel jobs, Node 20, npm cache keyed on the lockfiles:

- **backend** — `npm ci` (23s) → `tsc --noEmit` (39s) → `jest --runInBand` (71s)
  ≈ **2m15s**
- **frontend** — `npm ci` (18s) → `npm run build` (tsc 1m38s + vite 51s)
  ≈ **2m50s**

Wall clock ~3 min since they run in parallel. Note `jest` runs `--runInBand`
(serial) per the existing npm script; leave it, since the suite is only 71s and
serial avoids any shared-state surprise on a 2-core runner. Neither job needs a secret, which
matters on a public repo: fork PRs get no secrets by default, and these jobs want
none.

**Exit:** both jobs green on a PR from this branch.

**This phase is worth doing even if every later phase is abandoned.** It covers
the 1,652 tests that pin real, previously-shipped defects.

### Phase 2 — frontend lint config + the real bugs · ~4h

- [x] Add `frontend/.eslintrc.cjs` (variant A). All required plugins are already
      in `devDependencies` (`@typescript-eslint` 6.17, `react-hooks` 4.6,
      `react-refresh` 0.4.5) — only the config file was ever missing, which is why
      `npm run lint` has failed since the script was written.
- [ ] Fix the 2 `rules-of-hooks` violations. These are real — conditional or
      nested hook calls break React's own invariants.
- [ ] Review all 23 `exhaustive-deps`. **Hand-review each, never autofix**: adding
      a missing dep can introduce a re-render loop, so each one is either a real
      stale-closure bug or a deliberate omission that earns a disable + reason.
- [ ] Review the 20 `no-constant-condition` — each is either dead code or an
      inverted test.
- [ ] Fix the 7 `no-unused-vars` and 9 `react-refresh` (mechanical).

**Exit:** frontend lint reports only `no-explicit-any`.

### Phase 3 — make lint measurable and ratcheted · ~1h

Lint cannot gate yet, but it must stop getting worse.

- [ ] Commit a baseline count per workspace.
- [ ] Add a non-blocking `lint` CI job that fails **only if the count rises** above
      baseline. A ratchet, not a gate.
- [ ] Separately, lint **changed files only** as a blocking check, so new code is
      held to the full rule set from day one without touching the 5,660 legacy
      findings.

**Exit:** no new lint errors can merge, and the baseline only moves down.

This is the phase that makes the rest optional rather than urgent.

### Phase 4 — unblock test-file linting · ~2h

All 120 backend test files currently **fatal** under type-aware lint:
`tsconfig.json` excludes `src/**/__tests__/**` and `src/**/*.test.ts`, so the
parser has no type information for them. ESLint lints zero test files today.

- [ ] Add `backend/tsconfig.eslint.json` extending `tsconfig.json` with the test
      excludes removed, and point `parserOptions.project` at it.
- [ ] Re-baseline.

**Expect the backend count to RISE here** — ~120 files of previously invisible
findings, mostly `no-unsafe-*` on mocks. That is the ratchet working as designed,
not a regression. Record the new baseline and move on.

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
