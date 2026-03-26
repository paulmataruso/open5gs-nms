import React from 'react';

interface DiffViewerProps {
  diff: string;
}

export const DiffViewer: React.FC<DiffViewerProps> = ({ diff }) => {
  if (!diff || diff.trim() === '') {
    return (
      <div className="text-xs text-nms-text-dim p-3 bg-nms-surface-2 rounded">
        No changes detected
      </div>
    );
  }

  // Simple diff viewer using pre-formatted text with syntax highlighting
  const lines = diff.split('\n');

  return (
    <div className="diff-viewer bg-nms-bg border border-nms-border rounded overflow-hidden">
      <pre className="text-xs font-mono p-4 overflow-x-auto max-h-96 overflow-y-auto">
        {lines.map((line, idx) => {
          let className = 'text-nms-text-dim';
          
          if (line.startsWith('+') && !line.startsWith('+++')) {
            className = 'text-green-400 bg-green-500/10';
          } else if (line.startsWith('-') && !line.startsWith('---')) {
            className = 'text-red-400 bg-red-500/10';
          } else if (line.startsWith('@@')) {
            className = 'text-cyan-400 font-semibold';
          } else if (line.startsWith('diff') || line.startsWith('index') || line.startsWith('---') || line.startsWith('+++')) {
            className = 'text-nms-text-dim opacity-60';
          }

          return (
            <div key={idx} className={className}>
              {line || ' '}
            </div>
          );
        })}
      </pre>
    </div>
  );
};
