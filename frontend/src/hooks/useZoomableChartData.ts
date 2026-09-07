import { useEffect, useState } from 'react';

// Recharts doesn't ship a built-in "drag to select a range, then zoom"
// interaction — this is their own documented pattern (ReferenceArea +
// onMouseDown/onMouseMove/onMouseUp), generalized here once so every chart
// that wants Grafana-style click-and-drag zoom doesn't reimplement the same
// index-tracking/reset logic. Index-based (not label-string-based) so it
// stays correct even when two points share a displayed label — e.g. the
// same HH:MM repeated across different days at a resolution where the date
// isn't shown.
export interface ZoomableChartData<T> {
  /** The slice of `data` currently in view — feed this to the chart's `data` prop. */
  displayData: T[];
  isZoomed: boolean;
  /** Live drag-in-progress selection, in terms of the x-axis `label` field — feed to a <ReferenceArea x1={selection.x1} x2={selection.x2} />. */
  selection: { x1: string; x2: string } | null;
  onMouseDown: (e: any) => void;
  onMouseMove: (e: any) => void;
  onMouseUp: () => void;
  resetZoom: () => void;
}

export function useZoomableChartData<T extends { label: string }>(data: T[]): ZoomableChartData<T> {
  const [zoomRange, setZoomRange] = useState<[number, number] | null>(null);
  const [dragStart, setDragStart] = useState<number | null>(null);
  const [dragEnd, setDragEnd] = useState<number | null>(null);

  // A fresh fetch (new time range, resolution, or filter) invalidates any
  // index-based zoom from the previous dataset — reapplying it to a
  // different dataset would silently show a nonsensical slice.
  useEffect(() => {
    setZoomRange(null);
    setDragStart(null);
    setDragEnd(null);
  }, [data]);

  const onMouseDown = (e: any) => {
    if (e?.activeTooltipIndex == null) return;
    setDragStart(e.activeTooltipIndex);
    setDragEnd(e.activeTooltipIndex);
  };
  const onMouseMove = (e: any) => {
    if (dragStart == null || e?.activeTooltipIndex == null) return;
    setDragEnd(e.activeTooltipIndex);
  };
  const onMouseUp = () => {
    if (dragStart != null && dragEnd != null && dragStart !== dragEnd) {
      setZoomRange([Math.min(dragStart, dragEnd), Math.max(dragStart, dragEnd)]);
    }
    setDragStart(null);
    setDragEnd(null);
  };
  const resetZoom = () => setZoomRange(null);

  const displayData = zoomRange ? data.slice(zoomRange[0], zoomRange[1] + 1) : data;
  const selection = dragStart != null && dragEnd != null && dragStart !== dragEnd && data.length > 0
    ? { x1: data[Math.min(dragStart, dragEnd)].label, x2: data[Math.max(dragStart, dragEnd)].label }
    : null;

  return { displayData, isZoomed: zoomRange != null, selection, onMouseDown, onMouseMove, onMouseUp, resetZoom };
}
