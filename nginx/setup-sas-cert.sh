#!/bin/sh
# setup-sas-cert.sh
# Generates the self-signed TLS certificates nginx needs to start:
#   - sas.crt/sas.key/sas.pem — SAS root CA (self-signed, CA:TRUE). This is
#                        what a radio's own "install CBRS vendor chain" flow
#                        should be pointed at (downloadable at /sas-cert/) —
#                        it's a real root CA, not a bare leaf cert, so
#                        firmware that validates chain structure (Nokia
#                        AirScale confirmed live 2026-09-27, see git log)
#                        accepts it instead of rejecting it as an invalid
#                        chain with a missing root/intermediate CA.
#   - sas-leaf.crt/sas-leaf.key — the actual TLS server identity, signed BY
#                        the root above (not self-signed). nginx presents
#                        this (via sas-fullchain.crt, leaf+root concatenated)
#                        during the real HTTPS handshake on port 8443.
#   - acs.crt/acs.key — Sercomm factory-default ACS DNS-hijack relay
#                        (port 443, must be CN=acs.sc.sercomm.com — that
#                        hostname is hardcoded in nginx.conf's server_name
#                        and in every factory-reset Sercomm radio's ACS URL).
#                        Deliberately left as a single flat self-signed cert
#                        — this vhost is a DNS-hijack trick a radio never
#                        explicitly installs as a trust anchor, so it has
#                        none of the chain-validation requirements above.
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

# Real host IPs only -- excludes loopback and this project's own internal-
# only interfaces (dummy-* per-NF loopback aliases, ogstun*/apn-* UE data
# plane TUNs, docker0) since a radio would never actually reach the SAS
# endpoint through any of those. Almost every deployment has multiple real
# NICs (management + RAN-facing, confirmed live 2026-09-27 on a host with
# both ens18 and ens20 in real use) and "almost all users connect by IP,
# not FQDN" -- so the seeded cert includes ALL of them in its SAN rather
# than guessing at just the one the default route happens to prefer, which
# is what silently broke a real radio's TLS handshake the first time this
# was tried (its SAS client used the RAN-facing IP, the old cert only had
# the default-route one). First one becomes SERVER_IP for the CN/legacy
# single-IP call sites below; the full list feeds the actual SAN.
SERVER_IPS=$(ip -4 -o addr show 2>/dev/null | awk '{print $2, $4}' \
  | grep -Ev '^(lo|docker[0-9]*|br-|veth|ogstun|apn-|dummy-)' \
  | cut -d/ -f1 | awk '{print $2}')
SERVER_IP=$(echo "$SERVER_IPS" | head -1)
[ -z "$SERVER_IP" ] && SERVER_IP="127.0.0.1"
SAN_IPS=$(echo "$SERVER_IPS" | awk '{printf "IP:%s,", $1}')
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

# Two-tier SAS PKI (root CA + leaf server cert signed by it) instead of a
# single flat self-signed cert -- see header comment for why. Checks all
# FOUR files (root cert/key + leaf cert/key), not just the root pair, so a
# pre-existing flat-cert deployment (root files present, leaf files not)
# correctly falls through to regeneration instead of being mistaken for an
# already-migrated one.
setup_sas_pki() {
  root_key="$CERT_DIR/sas.key"
  root_cert="$CERT_DIR/sas.crt"
  leaf_key="$CERT_DIR/sas-leaf.key"
  leaf_cert="$CERT_DIR/sas-leaf.crt"
  leaf_csr="$CERT_DIR/sas-leaf.csr"
  extfile="$CERT_DIR/.sas-leaf-ext.cnf"

  if [ -f "$root_cert" ] && [ -f "$root_key" ] && [ -f "$leaf_cert" ] && [ -f "$leaf_key" ]; then
    expiry=$(openssl x509 -in "$root_cert" -noout -enddate 2>/dev/null | cut -d= -f2)
    echo "sas root CA + leaf already exist (root expires: $expiry) -- skipping"
  else
    echo "Generating sas root CA + leaf server certificate (2-tier PKI)"
    echo "  Output : $CERT_DIR"

    openssl req -x509 \
      -newkey rsa:4096 \
      -keyout "$root_key" \
      -out "$root_cert" \
      -days 3650 \
      -nodes \
      -subj "/C=US/ST=CBRS/L=Private/O=Open5GS NMS/CN=Open5GS NMS SAS Root CA" \
      -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
      -addext "keyUsage=critical,keyCertSign,cRLSign"

    openssl req \
      -newkey rsa:4096 \
      -keyout "$leaf_key" \
      -out "$leaf_csr" \
      -nodes \
      -subj "/C=US/ST=CBRS/L=Private/O=Open5GS NMS/CN=sas.local"

    printf 'subjectAltName=%sDNS:%s,DNS:sas.local,DNS:localhost\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n' \
      "$SAN_IPS" "$HOSTNAME" > "$extfile"

    openssl x509 -req \
      -in "$leaf_csr" \
      -CA "$root_cert" -CAkey "$root_key" -CAcreateserial \
      -out "$leaf_cert" \
      -days 3650 \
      -extfile "$extfile"

    rm -f "$leaf_csr" "$extfile" "$CERT_DIR/sas.srl"

    echo "sas root CA + leaf server certificate generated successfully"
    echo "  Root CA:"
    openssl x509 -in "$root_cert" -noout -subject -dates
    echo "  Leaf:"
    openssl x509 -in "$leaf_cert" -noout -subject -dates
  fi

  # Runs unconditionally (even when generation above was skipped) so a
  # deployment that already has root+leaf but is missing the fullchain/pem
  # copies (e.g. upgrading from an even older layout) self-heals too.
  cat "$leaf_cert" "$root_cert" > "$CERT_DIR/sas-fullchain.crt"
  cp "$root_cert" "$CERT_DIR/sas.pem"
}

setup_sas_pki

generate_cert "acs" "acs.sc.sercomm.com" \
  "IP:${SERVER_IP},DNS:${HOSTNAME},DNS:acs.sc.sercomm.com,DNS:localhost"
