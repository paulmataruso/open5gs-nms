// Shared NMS logo mark — used on login page and sidebar
// size prop controls overall dimensions; showWordmark adds "Open5GS NMS" text

interface NmsLogoProps {
  size?: number;        // icon size in px (default 40)
  showWordmark?: boolean;
  className?: string;
}

export function NmsLogoMark({ size = 40, className = '' }: { size?: number; className?: string }) {
  const s = size;
  const cx = s / 2;
  const cy = s / 2;
  const r1 = s * 0.48;  // outer hex radius
  const r2 = s * 0.33;  // inner hex radius

  const hex = (r: number) => {
    const pts = [];
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 180) * (60 * i - 90);
      pts.push(`${cx + r * Math.cos(a)},${cy + r * Math.sin(a)}`);
    }
    return pts.join(' ');
  };

  // tower mast top y, bottom y
  const mastTop = cy - r2 * 0.92;
  const mastBot = cy + r2 * 0.88;
  const armY    = cy - r2 * 0.18;
  const armX    = r2 * 0.52;

  // signal arc radii
  const arc1 = r2 * 0.55;
  const arc2 = r2 * 0.82;

  return (
    <svg
      width={s} height={s}
      viewBox={`0 0 ${s} ${s}`}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      {/* outer hex */}
      <polygon points={hex(r1)} stroke="#00b8a0" strokeWidth={s * 0.055} fill="none" strokeLinejoin="round" />
      {/* inner hex */}
      <polygon points={hex(r2)} stroke="#00b8a0" strokeWidth={s * 0.025} fill="none" strokeLinejoin="round" opacity="0.35" />
      {/* corner connectors */}
      {Array.from({ length: 6 }).map((_, i) => {
        const a = (Math.PI / 180) * (60 * i - 90);
        const x1 = cx + r1 * Math.cos(a);
        const y1 = cy + r1 * Math.sin(a);
        const x2 = cx + r2 * Math.cos(a);
        const y2 = cy + r2 * Math.sin(a);
        return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="#00b8a0" strokeWidth={s * 0.03} opacity="0.45" />;
      })}
      {/* tower mast */}
      <line x1={cx} y1={mastTop} x2={cx} y2={mastBot} stroke="#00b8a0" strokeWidth={s * 0.045} strokeLinecap="round" />
      {/* arms */}
      <line x1={cx} y1={armY} x2={cx - armX} y2={mastTop + (armY - mastTop) * 0.3} stroke="#00b8a0" strokeWidth={s * 0.035} strokeLinecap="round" />
      <line x1={cx} y1={armY} x2={cx + armX} y2={mastTop + (armY - mastTop) * 0.3} stroke="#00b8a0" strokeWidth={s * 0.035} strokeLinecap="round" />
      {/* base dot */}
      <circle cx={cx} cy={mastBot} r={s * 0.07} fill="#00b8a0" />
      {/* signal arcs */}
      <path d={`M${cx - arc1},${armY + arc1 * 0.15} Q${cx - arc1 * 0.3},${armY - arc1} ${cx},${armY - arc1 * 0.9} Q${cx + arc1 * 0.3},${armY - arc1} ${cx + arc1},${armY + arc1 * 0.15}`}
        stroke="#00b8a0" strokeWidth={s * 0.032} strokeLinecap="round" opacity="0.75" />
      <path d={`M${cx - arc2},${armY + arc2 * 0.1} Q${cx - arc2 * 0.3},${armY - arc2} ${cx},${armY - arc2 * 0.88} Q${cx + arc2 * 0.3},${armY - arc2} ${cx + arc2},${armY + arc2 * 0.1}`}
        stroke="#00b8a0" strokeWidth={s * 0.025} strokeLinecap="round" opacity="0.4" />
    </svg>
  );
}

export function NmsLogo({ size = 40, showWordmark = false, className = '' }: NmsLogoProps) {
  if (!showWordmark) return <NmsLogoMark size={size} className={className} />;

  return (
    <div className={`flex items-center gap-3 ${className}`}>
      <NmsLogoMark size={size} />
      <div>
        <div className="text-sm font-semibold text-nms-text font-display tracking-tight leading-tight">
          Open5GS
        </div>
        <div className="text-[10px] text-nms-accent uppercase tracking-widest leading-tight">NMS</div>
      </div>
    </div>
  );
}
