import { useState } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';
import { clsx } from 'clsx';
import { PacketTreeNode } from '../../api/pcap';

// One row of the tree — collapsed by default, exactly like Wireshark's own Packet
// Details pane when a packet is first selected (Frame/Ethernet II/Internet
// Protocol/... all start collapsed; clicking one reveals its fields, which can
// themselves have further sub-fields, e.g. a flags byte's individual bits).
function TreeNode({ node, depth }: { node: PacketTreeNode; depth: number }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const hasChildren = node.children.length > 0;

  return (
    <div>
      <div
        className={clsx(
          'flex items-start gap-1.5 py-1 rounded',
          hasChildren ? 'cursor-pointer hover:bg-nms-surface-2/50' : '',
        )}
        style={{ paddingLeft: `${depth * 18}px` }}
        onClick={() => hasChildren && setExpanded(e => !e)}
      >
        {hasChildren ? (
          expanded
            ? <ChevronDown className="w-3.5 h-3.5 shrink-0 mt-0.5 text-nms-text-dim" />
            : <ChevronRight className="w-3.5 h-3.5 shrink-0 mt-0.5 text-nms-text-dim" />
        ) : (
          <span className="w-3.5 h-3.5 shrink-0" />
        )}
        <span className={clsx('text-sm font-mono leading-snug', depth === 0 && 'text-nms-accent font-semibold')}>
          {node.label}
        </span>
      </div>
      {expanded && hasChildren && (
        <div>
          {node.children.map((child, i) => <TreeNode key={i} node={child} depth={depth + 1} />)}
        </div>
      )}
    </div>
  );
}

export function PacketDetailTree({ tree }: { tree: PacketTreeNode[] }): JSX.Element {
  if (tree.length === 0) {
    return <p className="text-sm text-nms-text-dim">No protocol detail available for this frame.</p>;
  }
  return (
    <div>
      {tree.map((node, i) => <TreeNode key={i} node={node} depth={0} />)}
    </div>
  );
}
