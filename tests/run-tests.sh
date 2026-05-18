#!/bin/bash
# run-tests.sh — Run all NMS tests inside the backend container
# Usage: ./tests/run-tests.sh [test-file]
#
# Examples:
#   ./tests/run-tests.sh                          # run all tests
#   ./tests/run-tests.sh yaml-round-trip.test.ts  # run specific test

set -e

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
CONTAINER="open5gs-nms-backend"

# Check container is running
if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
  echo "Error: container '${CONTAINER}' is not running"
  echo "Start it with: docker compose up -d backend"
  exit 1
fi

# Copy tests into container
echo "Copying tests to container..."
docker cp "$TESTS_DIR" "${CONTAINER}:/tests"

# Determine which tests to run
if [ -n "$1" ]; then
  TEST_FILES=("$1")
else
  # Find all .test.ts files
  mapfile -t TEST_FILES < <(ls "$TESTS_DIR"/*.test.ts 2>/dev/null | xargs -I{} basename {})
fi

if [ ${#TEST_FILES[@]} -eq 0 ]; then
  echo "No test files found in $TESTS_DIR"
  exit 0
fi

PASS=0
FAIL=0

for test_file in "${TEST_FILES[@]}"; do
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "Running: $test_file"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  if docker exec "$CONTAINER" \
    sh -c "cd /app && ./node_modules/.bin/ts-node /tests/$test_file"; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
  fi
done

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Test suites: $PASS passed, $FAIL failed"

if [ $FAIL -gt 0 ]; then
  exit 1
fi
