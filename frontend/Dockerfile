FROM node:20-bookworm-slim AS builder

# With nginx in front:
# - API calls use relative URLs (/api/...) so VITE_API_URL is empty
# - WebSocket connects to the nginx /ws path on the same host/port
ARG VITE_API_URL=
ARG VITE_WS_URL=
ARG VITE_PROMETHEUS_PORT=9099
ARG VITE_GRAFANA_PORT=3000
# UI module toggles — see FEATURES in src/config/features.ts
ARG VITE_ENABLE_SMS=true
ARG VITE_ENABLE_IMS=true
ARG VITE_ENABLE_VALIDATION=true
ARG VITE_ENABLE_VOWIFI=true
ARG VITE_ENABLE_DNS_MIGRATION=true
ARG VITE_ENABLE_PCAP=true

WORKDIR /app
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
COPY . .

ENV VITE_API_URL=$VITE_API_URL
ENV VITE_WS_URL=$VITE_WS_URL
ENV VITE_PROMETHEUS_PORT=$VITE_PROMETHEUS_PORT
ENV VITE_GRAFANA_PORT=$VITE_GRAFANA_PORT
ENV VITE_ENABLE_SMS=$VITE_ENABLE_SMS
ENV VITE_ENABLE_IMS=$VITE_ENABLE_IMS
ENV VITE_ENABLE_VALIDATION=$VITE_ENABLE_VALIDATION
ENV VITE_ENABLE_VOWIFI=$VITE_ENABLE_VOWIFI
ENV VITE_ENABLE_DNS_MIGRATION=$VITE_ENABLE_DNS_MIGRATION
ENV VITE_ENABLE_PCAP=$VITE_ENABLE_PCAP
RUN npm run build

FROM node:20-alpine

WORKDIR /app

RUN npm install -g serve && apk add --no-cache curl

COPY --from=builder /app/dist /app/dist

EXPOSE 8081

HEALTHCHECK --interval=15s --timeout=5s --retries=5 --start-period=30s \
  CMD curl -f http://localhost:8081/ || exit 1

CMD ["serve", "-s", "dist", "-l", "8081"]
