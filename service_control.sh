#!/usr/bin/env bash

set -e

# Validate argument
if [[ $# -ne 1 ]]; then
    echo "Usage: $0 {start|stop|restart}"
    exit 1
fi

ACTION="$1"

if [[ "$ACTION" != "start" && "$ACTION" != "stop" && "$ACTION" != "restart" ]]; then
    echo "Invalid action: $ACTION"
    echo "Usage: $0 {start|stop|restart}"
    exit 1
fi

# Services in required order
SERVICES=(
    open5gs-pcrfd
    open5gs-amfd
    open5gs-pcfd
    open5gs-nrfd
    open5gs-upfd
    open5gs-udrd
    open5gs-hssd
    open5gs-bsfd
    open5gs-scpd
    open5gs-smfd
    open5gs-seppd
    open5gs-sgwud
    open5gs-ausfd
    open5gs-mmed
    open5gs-sgwcd
    open5gs-nssfd
    open5gs-udmd
)

echo "Running action: $ACTION"
echo "----------------------------------"

for SERVICE in "${SERVICES[@]}"; do
    echo "$ACTION $SERVICE..."
    systemctl "$ACTION" "$SERVICE"
done

echo "----------------------------------"
echo "Completed: $ACTION"
