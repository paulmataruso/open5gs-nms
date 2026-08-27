import { useEffect, useRef } from 'react';

// Promoted out of PlmnMigrationTab.tsx (its original, still-only-other call site)
// so StaleModulesModal.tsx can reuse the exact same streamed-log rendering
// instead of a third hand-rolled copy of this pattern.
export function LogBlock({ lines }: { lines: string[] }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [lines]);
  return (
    <pre ref={ref} className="bg-nms-bg rounded p-3 text-xs font-mono text-green-300 max-h-64 overflow-y-auto whitespace-pre-wrap border border-nms-border mt-3">
      {lines.join('\n')}
    </pre>
  );
}
