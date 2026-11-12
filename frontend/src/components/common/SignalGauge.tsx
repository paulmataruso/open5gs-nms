export function SignalGauge({ value, label = 'RSSI', unit = 'dBm', min = -120, max = -50 }: { value?: number | null; label?: string; unit?: 'dBm' | 'dB'; min?: number; max?: number }): JSX.Element {
  const valid = value != null && Number.isFinite(value);
  const fraction = valid ? Math.max(0, Math.min(1, (value - min) / (max - min))) : null;
  const point = (t: number, radius = 108) => [150 - Math.cos(Math.PI * t) * radius, 145 - Math.sin(Math.PI * t) * radius];
  const segment = (a: number, b: number) => {
    const start = point(a), end = point(b);
    return 'M ' + start.join(' ') + ' A 108 108 0 0 1 ' + end.join(' ');
  };
  const tip = fraction == null ? null : point(fraction, 88);
  return <div className="rounded-2xl border border-nms-border bg-nms-surface-2/40 p-4">
    <div className="text-xs uppercase tracking-widest text-nms-text-dim">{label} · {unit === 'dB' ? 'signal quality' : 'received signal'}</div>
    <svg viewBox="0 0 300 195" className="w-full max-w-sm mx-auto" role="img" aria-label={label + ': ' + (valid ? value + ' ' + unit : 'unavailable') + ', scale ' + min + ' to ' + max + ' ' + unit}>
      {[[0, 20 / 70, '#f87171'], [20 / 70, 40 / 70, '#fbbf24'], [40 / 70, 1, '#34d399']].map(([a,b,color]) =>
        <path key={String(a)} d={segment(Number(a),Number(b))} fill="none" stroke={String(color)} strokeWidth="12" opacity={valid ? 0.9 : 0.18} />)}
      {Array.from({ length: Math.floor((max - min) / 10) + 1 }, (_, i) => min + i * 10).map(tick => {
        const p = point((tick - min) / (max - min), 129);
        return <text key={tick} x={p[0]} y={p[1] + 4} textAnchor="middle" fill="currentColor" className="text-nms-text-dim" fontSize="10">{tick}</text>;
      })}
      {tip && <><line x1="150" y1="145" x2={tip[0]} y2={tip[1]} stroke="currentColor" className="text-nms-accent" strokeWidth="3" strokeLinecap="round" /><circle cx="150" cy="145" r="6" fill="currentColor" className="text-nms-accent" /></>}
      <text x="150" y="180" textAnchor="middle" fill="currentColor" className="text-nms-text" fontSize="24" fontWeight="600">{valid ? value.toFixed(value % 1 ? 1 : 0) + ' ' + unit : 'Unavailable'}</text>
    </svg>
    <div className="flex justify-between text-[10px] text-nms-text-dim"><span>Low · {min} {unit}</span><span>High · {max} {unit}</span></div>
    {!valid && <p className="mt-3 text-xs text-nms-text-dim">No {label} measurement reported by this source.</p>}
  </div>;
}
