// Pulled out of MobileKit.tsx: a module that exports anything other than
// components turns Fast Refresh off for that whole module, so editing any of
// MobileKit's ~18 components forced a full page reload instead of a hot
// update. These three are plain formatters with no React in them.
//
// Shared by the mobile pages and by CallDebugCard.

export function fmtBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function fmtMbps(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  if (n >= 1000) return `${(n / 1000).toFixed(1)} Gbps`;
  return `${n < 10 ? n.toFixed(2) : n.toFixed(1)} Mbps`;
}

/** Short relative time — "4m", "2h", "3d". Phones have no room for prose. */
export function fmtAgo(when: string | number | Date | null | undefined): string {
  if (when === null || when === undefined) return '—';
  const t = new Date(when).getTime();
  if (!Number.isFinite(t)) return '—';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
