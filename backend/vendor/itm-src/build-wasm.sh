#!/usr/bin/env bash
# One-time build: compiles the vendored NTIA ITM C++ source (see
# VENDOR_NOTES.md for the exact pinned commit and the two portability
# patches already applied to the vendored .cpp files) plus this project's
# own wrapper.cpp into a WASM module + JS loader, using the official
# Emscripten Docker image — no Emscripten install needed on the host, ever.
# Run this from anywhere; output lands in backend/src/domain/rf/wasm/itm/
# and IS committed (build-time only, not a runtime dependency of the
# deployed backend).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

mkdir -p "$BACKEND_DIR/src/domain/rf/wasm/itm"

# Mount the whole backend/ directory so the vendored source (backend/vendor/
# itm-src) and the output destination (backend/src/domain/rf/wasm/itm) are
# both reachable from the same, unambiguous absolute path inside the
# container — avoids relative-path confusion across the mount boundary.
docker run --rm -v "$BACKEND_DIR":/backend -u "$(id -u):$(id -g)" -w /backend/vendor/itm-src emscripten/emsdk \
  em++ -fdeclspec -O2 \
  src/*.cpp wrapper.cpp \
  -o /backend/src/domain/rf/wasm/itm/itm.js \
  -s MODULARIZE=1 -s EXPORT_NAME=createItmModule -s ENVIRONMENT=node \
  -s ALLOW_MEMORY_GROWTH=1 \
  --bind

echo "Built: backend/src/domain/rf/wasm/itm/itm.js + itm.wasm"
