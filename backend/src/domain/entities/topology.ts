export interface TopologyNode {
  id: string;
  type: 'nrf' | 'amf' | 'smf' | 'upf' | 'ausf';
  label: string;
  address: string;
  port: number;
  active: boolean;
}

export type EdgeType = 'sbi' | 'n11' | 'n4' | 'pfcp' | 'ngap' | 'gtpu';

export interface TopologyEdge {
  id: string;
  source: string;
  target: string;
  type: EdgeType;
  label: string;
  valid: boolean;
  errorMessage?: string;
}

export interface TopologyGraph {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
}
