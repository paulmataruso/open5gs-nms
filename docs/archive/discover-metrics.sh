#!/bin/bash
# ─────────────────────────────────────────────────────────────
# discover-metrics.sh
# Queries Prometheus for all active targets, then scrapes each
# target's /metrics endpoint and prints the unique metric names.
# ─────────────────────────────────────────────────────────────

PROMETHEUS_URL="http://172.16.1.83:9099"

echo "=============================================="
echo " Open5GS Prometheus Metrics Discovery"
echo " Source: ${PROMETHEUS_URL}"
echo "=============================================="
echo ""

# Fetch all targets from Prometheus API
TARGETS_JSON=$(curl -sf "${PROMETHEUS_URL}/api/v1/targets" 2>/dev/null)
if [ $? -ne 0 ] || [ -z "$TARGETS_JSON" ]; then
  echo "ERROR: Could not reach Prometheus at ${PROMETHEUS_URL}"
  echo "       Make sure the container is running and the port is accessible."
  exit 1
fi

# Extract active target scrape URLs using grep/sed (no jq dependency)
TARGETS=$(echo "$TARGETS_JSON" \
  | grep -o '"scrapeUrl":"[^"]*"' \
  | sed 's/"scrapeUrl":"//;s/"//')

if [ -z "$TARGETS" ]; then
  echo "No active targets found. Check ${PROMETHEUS_URL}/targets in your browser."
  exit 1
fi

TARGET_COUNT=$(echo "$TARGETS" | wc -l)
echo "Found ${TARGET_COUNT} target(s)"
echo ""

# Process each target
for TARGET_URL in $TARGETS; do
  echo "----------------------------------------------"
  echo "TARGET: ${TARGET_URL}"
  echo "----------------------------------------------"

  # Fetch the raw metrics
  METRICS_RAW=$(curl -sf "${TARGET_URL}" 2>/dev/null)
  if [ $? -ne 0 ]; then
    echo "  WARNING: Could not reach this target (DOWN or unreachable)"
    echo ""
    continue
  fi

  # Extract metric names from HELP lines (most reliable source)
  # HELP lines look like:  # HELP metric_name Description here
  METRIC_NAMES=$(echo "$METRICS_RAW" \
    | grep "^# HELP" \
    | awk '{print $3}' \
    | sort)

  METRIC_COUNT=$(echo "$METRIC_NAMES" | grep -c .)

  echo "  ${METRIC_COUNT} metrics exposed:"
  echo ""

  # Print each metric name with its description
  while IFS= read -r METRIC_NAME; do
    [ -z "$METRIC_NAME" ] && continue
    DESCRIPTION=$(echo "$METRICS_RAW" \
      | grep "^# HELP ${METRIC_NAME} " \
      | sed "s/^# HELP ${METRIC_NAME} //")
    printf "  %-50s %s\n" "${METRIC_NAME}" "${DESCRIPTION}"
  done <<< "$METRIC_NAMES"

  echo ""
done

echo "=============================================="
echo " Done"
echo "=============================================="
