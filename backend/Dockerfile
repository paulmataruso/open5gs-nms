FROM node:20-bookworm-slim AS builder

WORKDIR /app
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

FROM node:20-bookworm-slim

# Install nsenter, ca-certificates, Docker CLI, and MongoDB database tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    util-linux \
    curl \
    gnupg \
    ca-certificates \
    docker.io \
    && curl -fsSL https://www.mongodb.org/static/pgp/server-7.0.asc | gpg --dearmor -o /usr/share/keyrings/mongodb-server-7.0.gpg \
    && echo "deb [ signed-by=/usr/share/keyrings/mongodb-server-7.0.gpg ] https://repo.mongodb.org/apt/debian bookworm/mongodb-org/7.0 main" > /etc/apt/sources.list.d/mongodb-org-7.0.list \
    && apt-get update && apt-get install -y --no-install-recommends \
    mongodb-database-tools \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi
COPY --from=builder /app/dist ./dist
# Copy default config YAMLs into dist (tsc doesn't copy non-TS files)
COPY src/config/defaults ./dist/config/defaults

RUN mkdir -p /var/log/open5gs-nms

ENV NODE_ENV=production
EXPOSE 3001 3002

CMD ["node", "dist/index.js"]
