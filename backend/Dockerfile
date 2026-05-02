FROM node:20-bookworm-slim AS builder

# Build tools needed to compile better-sqlite3 native bindings
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
# Install ALL deps (including dev) for compilation + TypeScript build
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc
# Prune dev dependencies after build - leaves prod deps including compiled better-sqlite3
RUN npm prune --omit=dev

FROM node:20-bookworm-slim

# Runtime deps: nsenter, Docker CLI, MongoDB tools, tshark, Python3 (for suci-keytool)
RUN apt-get update && apt-get install -y --no-install-recommends \
    util-linux \
    curl \
    gnupg \
    ca-certificates \
    lsb-release \
    tshark \
    python3 \
    python3-pip \
    && pip3 install pycryptodomex --break-system-packages \
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

RUN mkdir -p /var/log/open5gs-nms && mkdir -p /app/data

ENV NODE_ENV=production
EXPOSE 3001 3002

CMD ["node", "dist/index.js"]
