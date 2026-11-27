#!/usr/bin/env bash
# Run exactly what CI runs, in CI's order, locally.
#
# WHY THIS EXISTS. CI is sound; the failures it caught were all cases of a
# branch being declared clean locally after only SOME of the gates had been
# run. That happened four times in one session, in four different shapes:
# tsc + jest run but not lint; the lint gate run against the wrong branch; a
# gate run while a `git checkout` changed the tree underneath it; and `tsc
# --noEmit -p tsconfig.json` reported clean while a test file was broken,
# because backend/tsconfig.json EXCLUDES src/**/__tests__/** and only ts-jest
# typechecks those. One entry point removes the opportunity to run a subset
# and believe it.
#
# It is not a replacement for CI: CI installs with `npm ci` into a clean tree,
# so it cannot be fooled by local node_modules drift. That is what step 0
# below is for.
#
# What neither this nor CI covers, and cannot: everything reaching the host
# through nsenter (systemd, /etc/open5gs, apt, vtysh), real radios, real
# calls. A green run means "it compiles and the logic tests pass".
set -uo pipefail
cd "$(dirname "$0")/.."

BASE="${1:-origin/main}"

# Every check runs even when an earlier one fails, and the verdict comes at the
# end. This mirrors CI deliberately: the ratchet and the changed-lines gate
# answer different questions ("did the totals rise" vs "is the new code
# clean"), and failing fast on the first means the informative one never runs.
# CI's own comment records four PRs that lost their changed-lines result that
# way.
declare -A OUTCOME
step() {
  local name="$1"; shift
  printf '\n\033[1m── %s ──\033[0m\n' "$name"
  if "$@"; then OUTCOME[$name]=pass; else OUTCOME[$name]=FAIL; fi
}

be_lint() { ( cd backend  && npm run -s lint:json > /tmp/verify-be-lint.json || true ) \
            && node scripts/lint-ratchet.mjs backend  < /tmp/verify-be-lint.json; }
fe_lint() { ( cd frontend && npm run -s lint:json > /tmp/verify-fe-lint.json || true ) \
            && node scripts/lint-ratchet.mjs frontend < /tmp/verify-fe-lint.json; }

# Step 0 is local-only. A drifted node_modules makes every number below
# meaningless, so it runs first and loudly.
step 'deps match lockfile' node scripts/check-deps-fresh.mjs backend frontend

step 'backend typecheck'  bash -c 'cd backend && npx tsc --noEmit'
# `npm test` is jest --runInBand, which is also what keeps this from
# saturating a 4-core host that is running a live 5G core. Do not swap it for
# a bare `npx jest`: the default is one worker per core, measured here at a
# load average of 18.
step 'backend tests'      bash -c 'cd backend && npm test --silent'
# `npm run build` is check-breakpoints && tsc && vite build, so this IS the
# frontend typecheck. vite/esbuild alone would transpile without checking.
step 'frontend build'     bash -c 'cd frontend && npm run -s build'
# Vitest + jsdom, matching CI's frontend job, which runs build then tests
# in that order. maxWorkers is pinned to 2 in vitest.config.ts for the same
# reason `--runInBand` is used above.
step 'frontend tests'     bash -c 'cd frontend && npm test --silent'
step 'ratchet backend'    be_lint
step 'ratchet frontend'   fe_lint
step 'changed lines'      node scripts/lint-changed-lines.mjs "$BASE"

printf '\n\033[1m── verdict ──\033[0m\n'
failed=0
for k in 'deps match lockfile' 'backend typecheck' 'backend tests' 'frontend build' \
         'frontend tests' 'ratchet backend' 'ratchet frontend' 'changed lines'; do
  printf '  %-22s %s\n' "$k" "${OUTCOME[$k]:-skipped}"
  [ "${OUTCOME[$k]:-}" = pass ] || failed=1
done
if [ "$failed" -ne 0 ]; then
  printf '\n\033[31mverify FAILED\033[0m (base for changed-lines: %s)\n' "$BASE"
  exit 1
fi
printf '\n\033[32mverify passed\033[0m (base for changed-lines: %s)\n' "$BASE"
