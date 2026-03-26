FROM node:20-bookworm-slim AS builder

# With nginx in front:
# - API calls use relative URLs (/api/...) so VITE_API_URL is empty
# - WebSocket connects to the nginx /ws path on the same host/port
ARG VITE_API_URL=
ARG VITE_WS_URL=

WORKDIR /app
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
COPY . .

ENV VITE_API_URL=$VITE_API_URL
ENV VITE_WS_URL=$VITE_WS_URL
RUN npm run build

FROM node:20-alpine

WORKDIR /app

RUN npm install -g serve && apk add --no-cache curl

COPY --from=builder /app/dist /app/dist

EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=5s --retries=3 \
  CMD curl -f http://localhost:8080/ || exit 1

CMD ["serve", "-s", "dist", "-l", "8080"]
