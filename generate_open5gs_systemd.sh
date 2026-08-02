#!/bin/bash
# generate_open5gs_systemd_fixed.sh
# Generates systemd service files for all Open5GS components
# Corrects for configs with no "open5gs-" prefix

# Map of service -> config file
declare -A service_config=(
    [open5gs-pcrfd]=pcrf.yaml
    [open5gs-amfd]=amf.yaml
    [open5gs-pcfd]=pcf.yaml
    [open5gs-nrfd]=nrf.yaml
    [open5gs-upfd]=upf.yaml
    [open5gs-udrd]=udr.yaml
    [open5gs-hssd]=hss.yaml
    [open5gs-bsfd]=bsf.yaml
    [open5gs-scpd]=scp.yaml
    [open5gs-smfd]=smf.yaml
    [open5gs-seppd]=sepp1.yaml
    [open5gs-sgwud]=sgwu.yaml
    [open5gs-ausfd]=ausf.yaml
    [open5gs-mmed]=mme.yaml
    [open5gs-sgwcd]=sgwc.yaml
    [open5gs-nssfd]=nssf.yaml
    [open5gs-udmd]=udm.yaml
)

systemd_dir="/etc/systemd/system"

echo "Generating Open5GS systemd service files in $systemd_dir"

for svc in "${!service_config[@]}"; do
    config_file="${service_config[$svc]}"
    unit_file="$systemd_dir/$svc.service"
    cat <<EOF | sudo tee "$unit_file" > /dev/null
[Unit]
Description=Open5GS $svc daemon
After=network.target

[Service]
ExecStart=/usr/bin/$svc -c /etc/open5gs/$config_file
Restart=on-failure
User=root
Group=root
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF

    echo "Created $unit_file -> /etc/open5gs/$config_file"
done

# Reload systemd daemon
sudo systemctl daemon-reload

# Enable all Open5GS services
for svc in "${!service_config[@]}"; do
    sudo systemctl enable "$svc"
done

echo "All Open5GS services generated and enabled."
echo "Start individual services with: sudo systemctl start <service>"
