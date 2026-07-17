#!/bin/sh
# setup-sas-cert.sh
# Generates the self-signed TLS certificates nginx needs to start:
#   - sas.crt/sas.key — SAS HTTPS endpoint (port 8443, any hostname)
#   - acs.crt/acs.key — Sercomm factory-default ACS DNS-hijack relay
#                        (port 443, must be CN=acs.sc.sercomm.com — that
#                        hostname is hardcoded in nginx.conf's server_name
#                        and in every factory-reset Sercomm radio's ACS URL)
#
# Without both of these, nginx fails to start at all — it loads every
# server block in conf.d/ up front, so a missing cert for either vhost is
# fatal even if you don't own a Sercomm radio yet.
#
# Used two ways:
#   1. Automatically by the cert-init Docker service on first docker compose up
#   2. Manually on the host: cd /DOCKER/open5gs-nms && bash nginx/setup-sas-cert.sh
#      Then restart nginx: docker compose restart nginx

# Use /certs if it exists (container volume mount), otherwise nginx/certs/ on host
if [ -d /certs ]; then
  CERT_DIR="/certs"
else
  CERT_DIR="$(dirname "$0")/certs"
fi

mkdir -p "$CERT_DIR"

SERVER_IP=$(ip route get 1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if ($i=="src") print $(i+1)}' | head -1)
[ -z "$SERVER_IP" ] && SERVER_IP="127.0.0.1"
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

generate_cert "sas" "sas.local" \
  "IP:${SERVER_IP},DNS:${HOSTNAME},DNS:sas.local,DNS:localhost"

generate_cert "acs" "acs.sc.sercomm.com" \
  "IP:${SERVER_IP},DNS:${HOSTNAME},DNS:acs.sc.sercomm.com,DNS:localhost"
