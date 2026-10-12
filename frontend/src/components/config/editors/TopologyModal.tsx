import { X } from 'lucide-react';

// ── SVG topology diagram (inline — no external file dependency) ───────────────
// Shows central site (AMF, MME, SMF, SGW-C) ↔ edge site (UPF, SGW-U) with
// all interface IPs and connection types labeled.
const TOPOLOGY_SVG = `<svg width="100%" viewBox="0 0 1200 1160" xmlns="http://www.w3.org/2000/svg">
  <title>Open5GS central and edge site topology</title>
  <defs>
    <marker id="ta" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M2 1L8 5L2 9" fill="none" stroke="context-stroke" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </marker>
    <style>
      text { font-family: Arial, Helvetica, sans-serif; fill: #1a1a1a; }
      .th  { font-size: 14px; font-weight: 600; }
      .ts  { font-size: 12px; font-weight: 400; fill: #444; }
    </style>
  </defs>
  <rect x="150" y="30" width="280" height="620" rx="14" fill="#f1efe8" stroke="#888780" stroke-width="0.5"/>
  <text class="th" x="290" y="56" text-anchor="middle">Central site</text>
  <rect x="170" y="72" width="240" height="78" rx="8" fill="#eeedfe" stroke="#534ab7" stroke-width="0.5"/>
  <text class="th" x="290" y="98"  text-anchor="middle" dominant-baseline="central" fill="#26215c">AMF</text>
  <text class="ts" x="290" y="116" text-anchor="middle" dominant-baseline="central" fill="#3c3489">N2 / NGAP  ·  10.0.1.10</text>
  <text class="ts" x="290" y="134" text-anchor="middle" dominant-baseline="central" fill="#3c3489">SBI  ·  127.0.0.5</text>
  <rect x="170" y="172" width="240" height="78" rx="8" fill="#eeedfe" stroke="#534ab7" stroke-width="0.5"/>
  <text class="th" x="290" y="198" text-anchor="middle" dominant-baseline="central" fill="#26215c">MME</text>
  <text class="ts" x="290" y="216" text-anchor="middle" dominant-baseline="central" fill="#3c3489">S1-MME  ·  10.0.1.11</text>
  <text class="ts" x="290" y="234" text-anchor="middle" dominant-baseline="central" fill="#3c3489">GTPv2-C  ·  127.0.0.2</text>
  <rect x="170" y="272" width="240" height="78" rx="8" fill="#e1f5ee" stroke="#0f6e56" stroke-width="0.5"/>
  <text class="th" x="290" y="298" text-anchor="middle" dominant-baseline="central" fill="#04342c">SMF</text>
  <text class="ts" x="290" y="316" text-anchor="middle" dominant-baseline="central" fill="#085041">N4 PFCP  ·  10.0.1.155</text>
  <text class="ts" x="290" y="334" text-anchor="middle" dominant-baseline="central" fill="#085041">SBI  ·  127.0.0.4</text>
  <rect x="170" y="372" width="240" height="78" rx="8" fill="#e1f5ee" stroke="#0f6e56" stroke-width="0.5"/>
  <text class="th" x="290" y="398" text-anchor="middle" dominant-baseline="central" fill="#04342c">SGW-C</text>
  <text class="ts" x="290" y="416" text-anchor="middle" dominant-baseline="central" fill="#085041">Gxc PFCP  ·  10.0.1.156</text>
  <text class="ts" x="290" y="434" text-anchor="middle" dominant-baseline="central" fill="#085041">GTPv2-C  ·  127.0.0.3</text>
  <rect x="170" y="472" width="240" height="158" rx="6" fill="#e8e6df" stroke="#888780" stroke-width="0.5"/>
  <text class="ts" x="290" y="502" text-anchor="middle" dominant-baseline="central">NRF  ·  127.0.0.10</text>
  <text class="ts" x="290" y="524" text-anchor="middle" dominant-baseline="central">AUSF  ·  127.0.0.11</text>
  <text class="ts" x="290" y="546" text-anchor="middle" dominant-baseline="central">UDM  ·  127.0.0.12</text>
  <text class="ts" x="290" y="568" text-anchor="middle" dominant-baseline="central">PCF  ·  127.0.0.13</text>
  <text class="ts" x="290" y="600" text-anchor="middle" dominant-baseline="central">loopback — not routable</text>
  <rect x="770" y="30" width="280" height="460" rx="14" fill="#e6f1fb" stroke="#185fa5" stroke-width="0.5"/>
  <text class="th" x="910" y="56" text-anchor="middle">Edge site</text>
  <text class="ts" x="910" y="72" text-anchor="middle">4G + 5G user plane</text>
  <rect x="790" y="88" width="240" height="114" rx="8" fill="#b5d4f4" stroke="#185fa5" stroke-width="0.5"/>
  <text class="th" x="910" y="114" text-anchor="middle" dominant-baseline="central" fill="#042c53">UPF  (5G)</text>
  <text class="ts" x="910" y="132" text-anchor="middle" dominant-baseline="central" fill="#0c447c">N4 PFCP  ·  10.0.1.157</text>
  <text class="ts" x="910" y="150" text-anchor="middle" dominant-baseline="central" fill="#0c447c">N3 GTP-U  ·  10.0.1.157</text>
  <text class="ts" x="910" y="168" text-anchor="middle" dominant-baseline="central" fill="#0c447c">N6  →  internet</text>
  <rect x="790" y="224" width="240" height="114" rx="8" fill="#b5d4f4" stroke="#185fa5" stroke-width="0.5"/>
  <text class="th" x="910" y="250" text-anchor="middle" dominant-baseline="central" fill="#042c53">SGW-U  (4G)</text>
  <text class="ts" x="910" y="268" text-anchor="middle" dominant-baseline="central" fill="#0c447c">Gxc PFCP  ·  10.0.1.158</text>
  <text class="ts" x="910" y="286" text-anchor="middle" dominant-baseline="central" fill="#0c447c">S1-U GTP-U  ·  10.0.1.158</text>
  <text class="ts" x="910" y="304" text-anchor="middle" dominant-baseline="central" fill="#0c447c">SGi  →  internet</text>
  <rect x="790" y="358" width="240" height="110" rx="6" fill="#faeeda" stroke="#ba7517" stroke-width="0.5"/>
  <text class="th" x="910" y="386" text-anchor="middle" fill="#412402">IPs on this server</text>
  <text class="ts" x="910" y="408" text-anchor="middle" fill="#633806">10.0.1.157  —  UPF</text>
  <text class="ts" x="910" y="430" text-anchor="middle" fill="#633806">10.0.1.158  —  SGW-U</text>
  <text class="ts" x="600" y="200" text-anchor="middle">WAN</text>
  <line x1="450" y1="206" x2="760" y2="206" stroke="#888" stroke-width="0.5" stroke-dasharray="4 4"/>
  <path d="M410 311 L515 311 L515 145 L790 145" fill="none" stroke="#1d9e75" stroke-width="1.5" marker-end="url(#ta)"/>
  <text class="ts" x="505" y="327" text-anchor="middle" fill="#1d9e75">N4 PFCP</text>
  <text class="ts" x="505" y="343" text-anchor="middle" fill="#1d9e75">10.0.1.155 → 10.0.1.157</text>
  <path d="M410 411 L600 411 L600 281 L790 281" fill="none" stroke="#0f6e56" stroke-width="1.5" marker-end="url(#ta)"/>
  <text class="ts" x="505" y="427" text-anchor="middle" fill="#0f6e56">Gxc PFCP</text>
  <text class="ts" x="505" y="443" text-anchor="middle" fill="#0f6e56">10.0.1.156 → 10.0.1.158</text>
  <rect x="470" y="780" width="260" height="80" rx="8" fill="#faece7" stroke="#993c1d" stroke-width="0.5"/>
  <text class="th" x="600" y="806" text-anchor="middle" dominant-baseline="central" fill="#4a1b0c">eNodeB  (4G)</text>
  <text class="ts" x="600" y="824" text-anchor="middle" dominant-baseline="central" fill="#712b13">S1-MME  →  10.0.1.11</text>
  <text class="ts" x="600" y="842" text-anchor="middle" dominant-baseline="central" fill="#712b13">S1-U     →  10.0.1.158</text>
  <rect x="470" y="900" width="260" height="80" rx="8" fill="#faece7" stroke="#993c1d" stroke-width="0.5"/>
  <text class="th" x="600" y="926" text-anchor="middle" dominant-baseline="central" fill="#4a1b0c">gNodeB  (5G)</text>
  <text class="ts" x="600" y="944" text-anchor="middle" dominant-baseline="central" fill="#712b13">N2  →  10.0.1.10</text>
  <text class="ts" x="600" y="962" text-anchor="middle" dominant-baseline="central" fill="#712b13">N3  →  10.0.1.157</text>
  <path d="M470 820 L100 820 L100 211 L150 211" fill="none" stroke="#534ab7" stroke-width="1.5" stroke-dasharray="5 3" marker-end="url(#ta)"/>
  <text class="ts" x="128" y="802" text-anchor="start" fill="#534ab7">S1-MME → MME  10.0.1.11</text>
  <path d="M470 940 L70 940 L70 111 L150 111" fill="none" stroke="#7f77dd" stroke-width="1.5" stroke-dasharray="5 3" marker-end="url(#ta)"/>
  <text class="ts" x="98" y="922" text-anchor="start" fill="#7f77dd">N2 → AMF  10.0.1.10</text>
  <path d="M730 820 L1100 820 L1100 281 L1030 281" fill="none" stroke="#185fa5" stroke-width="1.5" stroke-dasharray="6 3" marker-end="url(#ta)"/>
  <text class="ts" x="1072" y="802" text-anchor="end" fill="#185fa5">S1-U GTP-U → 10.0.1.158</text>
  <path d="M730 940 L1130 940 L1130 145 L1030 145" fill="none" stroke="#185fa5" stroke-width="1.5" marker-end="url(#ta)"/>
  <text class="ts" x="1102" y="922" text-anchor="end" fill="#185fa5">N3 GTP-U → 10.0.1.157</text>
  <rect x="20" y="1020" width="1160" height="118" rx="10" fill="none" stroke="#aaa" stroke-width="0.5"/>
  <text class="th" x="600" y="1044" text-anchor="middle">Connection key</text>
  <line x1="50" y1="1068" x2="100" y2="1068" stroke="#7f77dd" stroke-width="1.5" stroke-dasharray="5 3" marker-end="url(#ta)"/>
  <text class="ts" x="114" y="1072">Control plane (N2 / S1-MME) — dashed — travels all the way back to central site</text>
  <line x1="50" y1="1092" x2="100" y2="1092" stroke="#1d9e75" stroke-width="1.5" marker-end="url(#ta)"/>
  <text class="ts" x="114" y="1096">PFCP (N4 / Gxc) — SMF and SGW-C program the edge UPF and SGW-U across the WAN</text>
  <line x1="50" y1="1116" x2="100" y2="1116" stroke="#185fa5" stroke-width="1.5" marker-end="url(#ta)"/>
  <text class="ts" x="114" y="1120">User plane (N3 / S1-U) — data stays at edge site, never travels back to central</text>
</svg>`;

// ── Modal ─────────────────────────────────────────────────────────────────────

interface Props {
  onClose: () => void;
  focus: 'upf' | 'sgwu';
}

export function TopologyModal({ onClose, focus }: Props): JSX.Element {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />

      {/* Modal panel */}
      <div
        className="relative z-10 bg-nms-surface border border-nms-border rounded-2xl shadow-2xl w-full max-w-5xl max-h-[92vh] flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-nms-border shrink-0">
          <div>
            <h2 className="text-base font-semibold font-display text-nms-text">
              How Remote {focus === 'upf' ? 'UPF (5G)' : 'SGW-U (4G)'} Works
            </h2>
            <p className="text-xs text-nms-text-dim mt-0.5">
              User plane traffic stays at the edge site — only control plane travels back to central.
            </p>
          </div>
          <button aria-label="Close"
            onClick={onClose}
            className="text-nms-text-dim hover:text-nms-text transition-colors p-1 rounded"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Scrollable body */}
        <div className="overflow-y-auto flex-1 px-6 py-5 space-y-5">

          {/* Key points */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="p-3 rounded-lg border border-nms-border bg-nms-surface-2/40 space-y-1">
              <p className="text-xs font-semibold text-nms-text">
                {focus === 'upf' ? '🔵 Control plane (N2)' : '🔵 Control plane (S1-MME)'}
              </p>
              <p className="text-xs text-nms-text-dim">
                {focus === 'upf'
                  ? 'gNodeB → AMF at the central site. Every UE attach, detach, and handover goes back to central.'
                  : 'eNodeB → MME at the central site. Every UE attach, detach, and handover goes back to central.'}
              </p>
            </div>
            <div className="p-3 rounded-lg border border-green-500/20 bg-green-500/5 space-y-1">
              <p className="text-xs font-semibold text-nms-text">
                {focus === 'upf' ? '🟢 PFCP (N4)' : '🟢 PFCP (Gxc)'}
              </p>
              <p className="text-xs text-nms-text-dim">
                {focus === 'upf'
                  ? 'SMF → remote UPF over WAN. The central SMF programs session rules into the edge UPF. This is why SMF needs a routable IP.'
                  : 'SGW-C → remote SGW-U over WAN. The central SGW-C programs session rules into the edge SGW-U. This is why SGW-C needs a routable IP.'}
              </p>
            </div>
            <div className="p-3 rounded-lg border border-blue-500/20 bg-blue-500/5 space-y-1">
              <p className="text-xs font-semibold text-nms-text">
                {focus === 'upf' ? '🔵 User plane (N3)' : '🔵 User plane (S1-U)'}
              </p>
              <p className="text-xs text-nms-text-dim">
                {focus === 'upf'
                  ? 'gNodeB → remote UPF directly. UE data never travels back to the central site — it goes out to the internet from the edge.'
                  : 'eNodeB → remote SGW-U directly. UE data never travels back to the central site — it goes out to the internet from the edge.'}
              </p>
            </div>
          </div>

          {/* IPs needed callout */}
          <div className="p-3 rounded-lg border border-amber-500/20 bg-amber-500/5 text-xs">
            <p className="font-semibold text-amber-300 mb-2">IPs required for this configuration</p>
            <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-nms-text-dim">
              {focus === 'upf' ? (
                <>
                  <p><span className="font-mono text-nms-accent">10.0.1.155</span> — SMF PFCP server (central)</p>
                  <p><span className="font-mono text-nms-accent">10.0.1.157</span> — UPF PFCP + N3 GTP-U (edge)</p>
                </>
              ) : (
                <>
                  <p><span className="font-mono text-nms-accent">10.0.1.156</span> — SGW-C PFCP server (central)</p>
                  <p><span className="font-mono text-nms-accent">10.0.1.158</span> — SGW-U PFCP + S1-U GTP-U (edge)</p>
                </>
              )}
              <p className="col-span-2 text-nms-text-dim/70 mt-1">
                Both must be routable between the central and edge sites. Loopback addresses (127.x.x.x) will not work for remote deployments.
              </p>
            </div>
          </div>

          {/* Topology diagram */}
          <div className="rounded-lg border border-nms-border overflow-hidden bg-white">
            <div
              className="w-full"
              dangerouslySetInnerHTML={{ __html: TOPOLOGY_SVG }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
