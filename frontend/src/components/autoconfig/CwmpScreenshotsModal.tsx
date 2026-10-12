import React, { useState } from 'react';
import { X, ChevronLeft, ChevronRight, Monitor } from 'lucide-react';
import { useEscapeKey } from '../../hooks/useKeyboardA11y';

interface Props {
  acsUrl: string;
  onClose: () => void;
}

const SLIDES = [
  {
    img:     '/images/cwmp-1.png',
    title:   'Step 1 — Enable CWMP & set ACS URL',
    caption: 'Check EnableCWMP and InitCwmp_KeepAlive. Paste the ACS URL into both the URL and X_000E8F_InitURL fields.',
  },
  {
    img:     '/images/cwmp-2.png',
    title:   'Step 2 — Configure Periodic Inform',
    caption: 'Check PeriodicInformEnable and InitPeriodicInformEnable. Set PeriodicInformInterval to 5 seconds.',
  },
  {
    img:     '/images/cwmp-3.png',
    title:   'Step 3 — Custom Inform SN (optional)',
    caption: 'X_000E8F_CustomInformSN can be left as "%s". The CWMPIPAddressRef fields should point to Device.IP.Interface.1.',
  },
];

export const CwmpScreenshotsModal: React.FC<Props> = ({ acsUrl, onClose }) => {
  // Escape closes this dialog. Its backdrop already closes on click, which
  // has no keyboard equivalent -- and a focusable backdrop would be worse.
  useEscapeKey(onClose);

  const [slide, setSlide] = useState(0);
  const current = SLIDES[slide];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-nms-surface border border-nms-border rounded-xl shadow-2xl w-full max-w-2xl flex flex-col">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-nms-border flex-shrink-0">
          <div className="flex items-center gap-3">
            <Monitor className="w-5 h-5 text-nms-accent" />
            <div>
              <h2 className="text-base font-semibold text-nms-text">WebUI — Configure ACS (TR-069)</h2>
              <p className="text-xs text-nms-text-dim mt-0.5">
                Navigate to <span className="text-nms-text font-mono">Management → TR-069 / MgntServer</span>
              </p>
            </div>
          </div>
          <button aria-label="Close" onClick={onClose} className="p-1 rounded hover:bg-nms-surface-2 text-nms-text-dim">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* ACS URL reminder */}
        <div className="px-6 pt-4 pb-2">
          <p className="text-xs text-nms-text-dim mb-1">ACS URL to enter:</p>
          <p className="font-mono text-sm text-nms-accent bg-nms-bg border border-nms-border rounded px-3 py-1.5 select-all">
            {acsUrl}
          </p>
        </div>

        {/* Slide image */}
        <div className="px-6 py-3 flex-1">
          <div className="bg-nms-bg border border-nms-border rounded-lg overflow-hidden">
            <img
              src={current.img}
              alt={current.title}
              className="w-full object-contain max-h-56"
            />
          </div>
        </div>

        {/* Slide caption */}
        <div className="px-6 pb-2 space-y-1">
          <p className="text-sm font-semibold text-nms-text">{current.title}</p>
          <p className="text-xs text-nms-text-dim">{current.caption}</p>
        </div>

        {/* Navigation */}
        <div className="px-6 py-4 border-t border-nms-border flex items-center justify-between flex-shrink-0">
          <button
            onClick={() => setSlide(s => Math.max(0, s - 1))}
            disabled={slide === 0}
            className="nms-btn border border-nms-border text-nms-text-dim hover:text-nms-text flex items-center gap-1 text-sm disabled:opacity-30"
          >
            <ChevronLeft className="w-4 h-4" />
            Previous
          </button>

          {/* Dots */}
          <div className="flex items-center gap-2">
            {SLIDES.map((_, i) => (
              <button
                key={i}
                onClick={() => setSlide(i)}
                className={`w-2 h-2 rounded-full transition-colors ${
                  i === slide ? 'bg-nms-accent' : 'bg-nms-border hover:bg-nms-text-dim'
                }`}
              />
            ))}
          </div>

          {slide < SLIDES.length - 1 ? (
            <button
              onClick={() => setSlide(s => Math.min(SLIDES.length - 1, s + 1))}
              className="nms-btn border border-nms-accent/40 text-nms-accent hover:bg-nms-accent/10 flex items-center gap-1 text-sm"
            >
              Next
              <ChevronRight className="w-4 h-4" />
            </button>
          ) : (
            <button
              onClick={onClose}
              className="nms-btn border border-nms-accent/40 text-nms-accent hover:bg-nms-accent/10 text-sm"
            >
              Done
            </button>
          )}
        </div>

      </div>
    </div>
  );
};
