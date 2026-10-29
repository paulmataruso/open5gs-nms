#!/bin/sh
# setup-nginx-certs.sh
# Generates the self-signed TLS certificate nginx needs to start:
#   - acs.crt/acs.key — Sercomm factory-default ACS DNS-hijack relay
#                        (port 443, must be CN=acs.sc.sercomm.com — that
#                        hostname is hardcoded in nginx.conf's server_name
#                        and in every factory-reset Sercomm radio's ACS URL).
#                        A single flat self-signed cert is correct here: this
#                        vhost is a DNS-hijack trick a radio never explicitly
#                        installs as a trust anchor, so it has none of the
#                        chain-validation requirements a real SAS cert has.
#
# Without this, nginx fails to start at all — it loads every server block in
# conf.d/ up front, so a missing cert is fatal even if you don't own a
# Sercomm radio yet.
#
# The CBRS SAS does NOT appear here any more. SASBench is the SAS; it runs as
# its own container, binds the SAS-CBSD protocol ports itself, and builds and
# manages its own PKI on first start. nginx is not in that path, terminates no
# SAS TLS, and needs no SAS certificate. Radios fetch their trust anchor from
# SASBench (GET /api/v1/trust-bundle) or its Certificates page.
#
# Used two ways:
#   1. Automatically by the cert-init Docker service on first docker compose up
#   2. Manually on the host: cd /DOCKER/open5gs-nms && bash nginx/setup-nginx-certs.sh
#      Then restart nginx: docker compose restart nginx

# Use /certs if it exists (container volume mount), otherwise nginx/certs/ on host
if [ -d /certs ]; then
  CERT_DIR=/certs
else
  CERT_DIR="$(dirname "$0")/certs"
  mkdir -p "$CERT_DIR"
fi

# Real host IPs only -- excludes loopback and this project's own internal-
# only interfaces (dummy-* per-NF loopback aliases, ogstun*/apn-* UE data
# plane TUNs, docker0) since a radio would never actually reach this
# endpoint through any of those.
SERVER_IPS=$(ip -4 -o addr show 2>/dev/null | awk '{print $2, $4}' \
  | grep -vE '^(lo|dummy-|ogstun|apn-|docker0)' \
  | awk '{split($2, a, "/"); print a[1]}' \
  | grep -v '^127\.')
SERVER_IP=$(echo "$SERVER_IPS" | head -1)
HOSTNAME=$(hostname)

generate_cert() {
  name="$1"
  cn="$2"
  san="$3"
  cert_file="$CERT_DIR/$name.crt"
  key_file="$CERT_DIR/$name.key"

  if [ -f "$cert_file" ] && [ -f "$key_file" ]; then
    expiry=$(openssl x509 -in "$cert_file" -noout -enddate 2>/dev/null | cut -d= -f2)
    echo "$name cert already exists (expires: $expiry) -- skipping"
    return 0
  fi

  echo "Generating $name TLS certificate"
  echo "  Output : $CERT_DIR"
  echo "  CN     : $cn"

  openssl req -x509 \
    -newkey rsa:4096 \
    -keyout "$key_file" \
    -out "$cert_file" \
    -days 3650 \
    -nodes \
    -subj "/C=US/ST=CBRS/L=Private/O=Open5GS NMS/CN=$cn" \
    -addext "subjectAltName=$san"

  echo "$name certificate generated successfully"
  openssl x509 -in "$cert_file" -noout -subject -dates
}

generate_cert "acs" "acs.sc.sercomm.com" \
  "IP:${SERVER_IP},DNS:${HOSTNAME},DNS:acs.sc.sercomm.com,DNS:localhost"
