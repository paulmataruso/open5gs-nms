#!/bin/bash
# Script to add tooltips to remaining SMF, UPF, and AUSF sections in ConfigPage.tsx
# Run this after you've replaced ConfigPage.tsx with the version containing AMF tooltips

FILE="frontend/src/components/config/ConfigPage.tsx"

echo "🔧 Adding tooltips to SMF Editor..."

# SMF SBI Server
sed -i 's|<Field label="Address" value={sbiServer\.address} onChange={(v) => updateSmf|<FieldWithTooltip label="Address" value={sbiServer.address} tooltip={SMF_TOOLTIPS.sbi_address} onChange={(v) => updateSmf|g' "$FILE"
sed -i 's|<Field label="Port" type="number" value={sbiServer\.port} onChange={(v) => updateSmf|<FieldWithTooltip label="Port" type="number" value={sbiServer.port} tooltip={SMF_TOOLTIPS.sbi_port} onChange={(v) => updateSmf|g' "$FILE"

# SMF SCP Client
sed -i 's|<Field label="SCP URI" value={scpUri} onChange={(v) => updateSmf({ sbi: { \.\.\.smf\.sbi, client:|<FieldWithTooltip label="SCP URI" value={scpUri} tooltip={SMF_TOOLTIPS.scp_uri} onChange={(v) => updateSmf({ sbi: { ...smf.sbi, client:|g' "$FILE"

# SMF PFCP
sed -i 's|<Field label="Server Address" value={pfcpServer\.address}|<FieldWithTooltip label="Server Address" value={pfcpServer.address} tooltip={SMF_TOOLTIPS.pfcp_server}|g' "$FILE"
sed -i 's|<Field label="UPF Client Address" value={upfAddress}|<FieldWithTooltip label="UPF Client Address" value={upfAddress} tooltip={SMF_TOOLTIPS.upf_address}|g' "$FILE"

# SMF GTP-C/GTP-U
sed -i 's|<Field label="GTP-C Address" value={gtpcServer}|<FieldWithTooltip label="GTP-C Address" value={gtpcServer} tooltip={SMF_TOOLTIPS.gtpc_address}|g' "$FILE"
sed -i 's|<Field label="GTP-U Address" value={gtpuServer}|<FieldWithTooltip label="GTP-U Address" value={gtpuServer} tooltip={SMF_TOOLTIPS.gtpu_address}|g' "$FILE"

# SMF Session Pools
sed -i 's|<Field label="Subnet" value={sess\.subnet}|<FieldWithTooltip label="Subnet" value={sess.subnet} tooltip={SMF_TOOLTIPS.session_subnet}|g' "$FILE"
sed -i 's|<Field label="Gateway" value={sess\.gateway}|<FieldWithTooltip label="Gateway" value={sess.gateway} tooltip={SMF_TOOLTIPS.session_gateway}|g' "$FILE"

# SMF DNS
sed -i 's|<Field key={i} label={`DNS \${i \+ 1}`} value={dns}|<FieldWithTooltip key={i} label={`DNS ${i + 1}`} value={dns} tooltip={i === 0 ? SMF_TOOLTIPS.dns_primary : SMF_TOOLTIPS.dns_secondary}|g' "$FILE"

# SMF MTU
sed -i 's|<Field label="MTU" type="number" value={smf\.mtu|<FieldWithTooltip label="MTU" type="number" value={smf.mtu tooltip={SMF_TOOLTIPS.mtu}|g' "$FILE"

echo "🔧 Adding tooltips to UPF Editor..."

# UPF PFCP
sed -i 's|<Field label="Address" value={pfcpServer\.address} onChange={(v) => updateUpf({ pfcp:|<FieldWithTooltip label="Address" value={pfcpServer.address} tooltip={UPF_TOOLTIPS.pfcp_address} onChange={(v) => updateUpf({ pfcp:|g' "$FILE"
sed -i 's|<Field label="Port" type="number" value={pfcpServer\.port|<FieldWithTooltip label="Port" type="number" value={pfcpServer.port tooltip={UPF_TOOLTIPS.pfcp_port}|g' "$FILE"

# UPF GTP-U
sed -i 's|<Field label="Address" value={gtpuServer\.address} onChange={(v) => updateUpf({ gtpu:|<FieldWithTooltip label="Address" value={gtpuServer.address} tooltip={UPF_TOOLTIPS.gtpu_address} onChange={(v) => updateUpf({ gtpu:|g' "$FILE"
sed -i 's|<Field label="Port" type="number" value={gtpuServer\.port|<FieldWithTooltip label="Port" type="number" value={gtpuServer.port tooltip={UPF_TOOLTIPS.gtpu_port}|g' "$FILE"

echo "🔧 Adding tooltips to AUSF Editor..."

# AUSF SBI
sed -i 's|<Field label="Address" value={server\.address} onChange={(v) => updateAusf|<FieldWithTooltip label="Address" value={server.address} tooltip={COMMON_TOOLTIPS.sbi_address} onChange={(v) => updateAusf|g' "$FILE"
sed -i 's|<Field label="Port" type="number" value={server\.port} onChange={(v) => updateAusf|<FieldWithTooltip label="Port" type="number" value={server.port} tooltip={COMMON_TOOLTIPS.sbi_port} onChange={(v) => updateAusf|g' "$FILE"

# AUSF SCP
sed -i 's|<Field label="SCP URI" value={scpUri} onChange={(v) => updateAusf|<FieldWithTooltip label="SCP URI" value={scpUri} tooltip={COMMON_TOOLTIPS.scp_uri} onChange={(v) => updateAusf|g' "$FILE"

echo "✅ Tooltips added to ConfigPage.tsx!"
echo "📝 Next: Add tooltips to individual editor files in frontend/src/components/config/editors/"
