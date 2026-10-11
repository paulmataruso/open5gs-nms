FROM node:20-bookworm-slim AS builder

# Build tools needed to compile better-sqlite3 native bindings
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
# Always use npm install — avoids lock file sync issues when package.json changes
RUN npm install
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc
# Prune dev dependencies after build - leaves prod deps including compiled better-sqlite3
RUN npm prune --omit=dev

FROM node:20-bookworm-slim

# Runtime deps: nsenter, iproute2 (ip command), Docker CLI, MongoDB tools, tshark, Python3 (for suci-keytool)
# sqlite3: the CLI binary (distinct from the bundled better-sqlite3 Node
# library above) — backup-restore.ts shells out to its online `.backup`
# command for auth.db/hlr.db/astdb.sqlite3, since that's safe against a
# concurrently-open connection from the owning process, unlike a raw file
# copy. Real gap found live 2026-09-22: this was missing entirely, so every
# SQLite-based backup category silently failed with `spawn sqlite3 ENOENT`,
# logged only as a warning — easy to miss without a live end-to-end test.
RUN apt-get update && apt-get install -y --no-install-recommends \
    util-linux \
    iproute2 \
    curl \
    gnupg \
    ca-certificates \
    lsb-release \
    python3 \
    python3-pip \
    sqlite3 \
    python3-paramiko \
    python3-requests \
    python3-pycryptodome \
    && apt-get install -y --no-install-recommends \
       -o Dpkg::Options::="--force-overwrite" \
       tshark \
    # Python deps come from Debian, not pypi, so the image builds on a host with
    # no route to pypi.org (issue #36 — a real report: pypi timed out and the
    # whole build failed, blocking the entire product over two optional
    # features). Debian's python3-pycryptodome already provides the `Cryptodome`
    # namespace suci-keytool.py imports, and paramiko 2.12 / requests 2.28 are
    # far newer than femto_provision.py's trivial usage needs.
    #
    # One capability does need a newer pycryptodome than Debian ships (3.11):
    # SUCI ECIES Profile A (curve25519) needs >= 3.21, confirmed by testing both
    # — on 3.11 secp256r1 works and curve25519 raises KeyError, exactly as
    # suci-keytool.py's own comment predicts. So try to layer the newer wheel
    # from pypi, but NEVER fail the build over it: pip installs into
    # /usr/local/lib/.../dist-packages, which precedes Debian's path, so when
    # pypi is reachable the newer version simply wins (verified: 3.11 -> 3.24,
    # both curves OK). When it is not, the image still builds and everything
    # except Profile A key generation works. suci-management.ts turns the
    # remaining gap into an explicit, actionable error rather than a raw
    # KeyError.
    && (pip3 install --no-input --break-system-packages 'pycryptodomex>=3.21' \
        || echo 'WARNING: could not reach pypi to install pycryptodomex>=3.21 — SUCI ECIES Profile A (curve25519) key generation will be unavailable; Profile B (secp256r1) and everything else still work.') \
    && mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian $(lsb_release -cs) stable" > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends docker-ce-cli \
    && curl -fsSL https://www.mongodb.org/static/pgp/server-7.0.asc | gpg --dearmor -o /usr/share/keyrings/mongodb-server-7.0.gpg \
    && echo "deb [ signed-by=/usr/share/keyrings/mongodb-server-7.0.gpg ] https://repo.mongodb.org/apt/debian bookworm/mongodb-org/7.0 main" > /etc/apt/sources.list.d/mongodb-org-7.0.list \
    && apt-get update && apt-get install -y --no-install-recommends \
    mongodb-database-tools \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy pruned node_modules from builder (includes compiled better-sqlite3 .node binary)
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./

# Copy suci-keytool and other bundled tools
COPY tools/ ./tools/

# Copy default config YAMLs into dist (tsc doesn't copy non-TS files)
COPY src/config/defaults ./dist/config/defaults

# Copy IMS Kamailio main-config templates (P/I/S-CSCF routing scripts) into dist
COPY src/config/ims-templates ./dist/config/ims-templates

# Copy the TWAMP client wrapper source (written to the host and compiled at
# Install time — see twamp-controller.ts) into dist
COPY src/config/twamp-templates ./dist/config/twamp-templates

# Copy the QCI hardware test tool source (Go + cgo shim, written to the host
# and compiled at Install time — see qci-hw-test-controller.ts) into dist
COPY src/config/qci-hw-test-templates ./dist/config/qci-hw-test-templates

# Copy the UE detach tool source (Go + cgo shim bridging Open5GS's own
# compiled Diameter S6a stack, written to the host and compiled at Install
# time — see ue-detach-runner.ts) into dist
COPY src/config/ue-detach-templates ./dist/config/ue-detach-templates

# Copy the FRR eigrpd crash-guard patch (pattern #7, FRRouting/frr#943) —
# written to the host and applied by frr-source-build.ts's build script, see
# docs/frr-eigrpd-crash-guard-patch.md
COPY src/config/frr-patches ./dist/config/frr-patches

# Copy the pre-compiled ITM (Longley-Rice) WASM module into dist — built
# once via backend/vendor/itm-src/build-wasm.sh (Docker + Emscripten, never
# needed on this image), loaded at runtime by itm-model.ts
COPY src/domain/rf/wasm ./dist/domain/rf/wasm

RUN mkdir -p /var/log/open5gs-nms && mkdir -p /app/data

ENV NODE_ENV=production
EXPOSE 3001 3002

CMD ["node", "dist/index.js"]
