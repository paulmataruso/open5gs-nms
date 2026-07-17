import { useEffect, useMemo, useRef, useState } from 'react';
import { X, RotateCw, AlertTriangle, ZoomIn, ZoomOut } from 'lucide-react';
import axios from 'axios';

interface Props {
  service: string;
  timestamp: string;
  message: string;
  onClose: () => void;
}

// Discrete zoom steps (lines shown on each side of the matched line). Fetched once at the
// max level, then zoom in/out just re-slices the already-fetched window client-side — no
// re-fetch per click, so zooming feels instant.
const ZOOM_LEVELS = [5, 10, 25, 50, 100, 200, 300];
const DEFAULT_ZOOM_INDEX = ZOOM_LEVELS.indexOf(50);
const FETCH_RADIUS = ZOOM_LEVELS[ZOOM_LEVELS.length - 1];

// Shows the raw log file around one Major Events line, with the selected line highlighted —
// so a user can see the full surrounding context (other DEBUG lines, related signaling) that
// the classifier deliberately filtered out. Zoom in/out narrows or widens how many of the
// already-fetched context lines are shown.
export function LogContextModal({ service, timestamp, message, onClose }: Props) {
  const [lines, setLines] = useState<string[] | null>(null);
  const [matchIndex, setMatchIndex] = useState(-1);
  const [error, setError] = useState<string | null>(null);
  const [zoomIndex, setZoomIndex] = useState(DEFAULT_ZOOM_INDEX);
  const matchRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const API_URL = import.meta.env.VITE_API_URL || '/api';
    let cancelled = false;
    axios.get(`${API_URL}/logs/context`, {
      params: { service, ts: timestamp, message, before: FETCH_RADIUS, after: FETCH_RADIUS },
    }).then(r => {
      if (cancelled) return;
      setLines(r.data.lines);
      setMatchIndex(r.data.matchIndex);
    }).catch(err => {
      if (cancelled) return;
      setError(err?.response?.data?.error ?? 'Failed to load log context');
    });
    return () => { cancelled = true; };
  }, [service, timestamp, message]);

  const radius = ZOOM_LEVELS[zoomIndex];
  const { visible, visibleMatchIndex, hitStart, hitEnd } = useMemo(() => {
    if (!lines || matchIndex < 0) return { visible: [] as string[], visibleMatchIndex: -1, hitStart: false, hitEnd: false };
    const start = Math.max(0, matchIndex - radius);
    const end = Math.min(lines.length, matchIndex + radius + 1);
    return {
      visible: lines.slice(start, end),
      visibleMatchIndex: matchIndex - start,
      hitStart: start === 0,
      hitEnd: end === lines.length,
    };
  }, [lines, matchIndex, radius]);

  const canZoomIn = zoomIndex > 0;
  const canZoomOut = zoomIndex < ZOOM_LEVELS.length - 1 && !(hitStart && hitEnd);

  useEffect(() => {
    matchRef.current?.scrollIntoView({ block: 'center' });
  }, [visible]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === '+' || e.key === '=') setZoomIndex(z => Math.min(ZOOM_LEVELS.length - 1, z + 1));
      if (e.key === '-' || e.key === '_') setZoomIndex(z => Math.max(0, z - 1));
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 p-6 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.7)' }}
      onClick={onClose}
    >
      <div
        className="nms-card max-w-5xl w-full max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3 shrink-0 gap-3">
          <div>
            <h2 className="text-base font-semibold font-display">
              <span className="font-mono text-nms-accent">{service}.log</span>
            </h2>
            <p className="text-xs text-nms-text-dim mt-0.5">
              Context around the selected line — ±{radius} line{radius === 1 ? '' : 's'}
            </p>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={() => setZoomIndex(z => Math.max(0, z - 1))}
              disabled={!canZoomIn}
              className="nms-btn-ghost p-1.5 disabled:opacity-30 disabled:cursor-not-allowed"
              title="Zoom in — fewer lines on each side"
            >
              <ZoomIn className="w-4 h-4" />
            </button>
            <button
              onClick={() => setZoomIndex(z => Math.min(ZOOM_LEVELS.length - 1, z + 1))}
              disabled={!canZoomOut}
              className="nms-btn-ghost p-1.5 disabled:opacity-30 disabled:cursor-not-allowed"
              title="Zoom out — more lines on each side"
            >
              <ZoomOut className="w-4 h-4" />
            </button>
            <button onClick={onClose} className="nms-btn-ghost p-1.5 ml-1" title="Close (Esc)">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {error && (
          <div className="flex items-start gap-2 text-sm text-nms-red bg-nms-red/5 border border-nms-red/20 rounded p-3">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> {error}
          </div>
        )}

        {!lines && !error && (
          <div className="flex items-center justify-center gap-2 text-sm text-nms-text-dim py-16">
            <RotateCw className="w-4 h-4 animate-spin" /> Loading context...
          </div>
        )}

        {lines && (
          <div className="flex-1 overflow-y-auto bg-nms-bg border border-nms-border rounded-lg">
            <pre className="text-xs font-mono leading-relaxed py-2">
              {visible.map((line, i) => (
                <div
                  key={i}
                  ref={i === visibleMatchIndex ? matchRef : undefined}
                  className={
                    i === visibleMatchIndex
                      ? 'bg-nms-accent/20 border-l-2 border-nms-accent px-3 py-0.5 text-nms-text whitespace-pre-wrap break-all'
                      : 'border-l-2 border-transparent px-3 py-0.5 text-nms-text-dim whitespace-pre-wrap break-all'
                  }
                >
                  {line}
                </div>
              ))}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
