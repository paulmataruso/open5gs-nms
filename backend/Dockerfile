FROM node:20-bookworm-slim AS builder

WORKDIR /app
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

FROM node:20-bookworm-slim

# Install nsenter, ca-certificates, Docker CLI (latest), and MongoDB database tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    util-linux \
    curl \
    gnupg \
    ca-certificates \
    lsb-release \
    # Install Docker CLI from official Docker repository
    && mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian $(lsb_release -cs) stable" > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends docker-ce-cli \
    # Install MongoDB tools
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
