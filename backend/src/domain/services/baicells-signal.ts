export interface RadioMeasurement {
  ueId: string;
  imsi?: string;
  rsrp?: number; rsrq?: number; rssi?: number; sinr?: number; snr?: number;
  dlMcs?: number; ulMcs?: number; bler?: number; dlMbps?: number; ulMbps?: number;
  txPower?: number; pathLoss?: number; primaryDlCqi?: number; secondaryDlCqi?: number;
  sampledAt?: number;
  details?: Record<string, string | number>;
}

export function signalNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  if (typeof value === 'string' && !value.trim()) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

// Field positions verified against the Baicells UE page (BaiBLQ firmware).
// This endpoint reports UL SINR, not RSSI/RSRP/RSRQ. Never infer those from TX power.
export function parseBaicellsUes(text: string, sampledAt = Date.now()): RadioMeasurement[] {
  const results: RadioMeasurement[] = [];
  const pattern = /FAP\.\d+\.FAP_LTE\.(\d+):\s*LTE_UE_SPEED_STATISTICS\s*:=\s*"([^"]*)"/g;
  for (const match of text.matchAll(pattern)) {
    if (!match[2] || match[2] === 'NULL') continue;
    for (const entry of match[2].split(';').filter(Boolean)) {
      const parsed = entry.trim().match(/^([^[]+)\[([^\]]*)\]$/);
      if (!parsed) continue;
      const f = parsed[2].split(':').map(v => v.trim());
      if (f.length < 7 || !parsed[1].trim()) continue;
      const details: Record<string, string | number> = { cellIndex: Number(match[1]), radioUeId: parsed[1].trim() };
      const labels: Record<number, string> = {
        1: 'virtualMac', 4: 'reportedIp', 5: 'port', 6: 'ulSinrReported',
        11: 'secondaryDlMcs', 14: 'primaryDlBlerTb1', 15: 'primaryDlBlerTb2',
        16: 'secondaryDlBlerTb1', 17: 'secondaryDlBlerTb2',
      };
      for (const [index, label] of Object.entries(labels)) {
        const value = f[Number(index)];
        if (value && value !== 'NULL' && value !== 'N/A') details[label] = value;
      }
      // Cell-local UE IDs are not unique across the two cells on a radio.
      results.push({
        ueId: match[1] + '/' + parsed[1].trim(),
        imsi: /^\d{14,16}$/.test(f[0] ?? '') ? f[0] : undefined,
        dlMbps: signalNumber(f[2]), ulMbps: signalNumber(f[3]),
        sinr: signalNumber(f[6]), primaryDlCqi: signalNumber(f[7]),
        secondaryDlCqi: signalNumber(f[8]), ulMcs: signalNumber(f[9]),
        dlMcs: signalNumber(f[10]), txPower: signalNumber(f[12]),
        bler: signalNumber(f[13]), pathLoss: signalNumber(f[18]),
        sampledAt, details,
      });
    }
  }
  if (!text.includes('LTE_UE_SPEED_STATISTICS')) throw new Error('Radio returned an unrecognized UE response');
  return results;
}
