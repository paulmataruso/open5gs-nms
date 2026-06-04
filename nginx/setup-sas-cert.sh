#!/bin/sh
# setup-sas-cert.sh
# Generates a self-signed TLS certificate for the SAS HTTPS endpoint.
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

CERT_FILE="$CERT_DIR/sas.crt"
KEY_FILE="$CERT_DIR/sas.key"

# Skip if cert already exists
if [ -f "$CERT_FILE" ] && [ -f "$KEY_FILE" ]; then
  expiry=$(openssl x509 -in "$CERT_FILE" -noout -enddate 2>/dev/null | cut -d= -f2)
  echo "SAS cert already exists (expires: $expiry) -- skipping"
  exit 0
fi

mkdir -p "$CERT_DIR"

SERVER_IP=$(ip route get 1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if ($i=="src") print $(i+1)}' | head -1)
[ -z "$SERVER_IP" ] && SERVER_IP="127.0.0.1"
HOSTNAME=$(hostname)

echo "Generating SAS TLS certificate"
echo "  Output : $CERT_DIR"
echo "  IP     : $SERVER_IP"
echo "  Host   : $HOSTNAME"

openssl req -x509 \
  -newkey rsa:4096 \
  -keyout "$KEY_FILE" \
  -out "$CERT_FILE" \
  -days 3650 \
  -nodes \
  -subj "/C=US/ST=CBRS/L=Private/O=Open5GS NMS/CN=sas.local" \
  -addext "subjectAltName=IP:${SERVER_IP},DNS:${HOSTNAME},DNS:sas.local,DNS:localhost"

echo "Certificate generated successfully"
openssl x509 -in "$CERT_FILE" -noout -subject -dates

