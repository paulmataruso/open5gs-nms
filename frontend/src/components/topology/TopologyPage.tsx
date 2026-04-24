import { useEffect, useRef } from 'react';
import { dia, shapes } from 'jointjs';
import { useTopologyStore } from '../../stores';
import './TopologyPage.css';

/**
 * Network Topology - EXACT match to Open5GS_CUPS-01.jpg
 * Gray Control Plane box with pink SBI box inside
 * Gray User Plane box on right
 * Simple RAN nodes at bottom
 */
export function TopologyPage(): JSX.Element {
  const paperRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<dia.Graph | null>(null);
  const paperInstanceRef = useRef<dia.Paper | null>(null);
  
  const graph = useTopologyStore((s) => s.graph);
  const interfaceStatus = useTopologyStore((s) => s.interfaceStatus);
  const fetchTopology = useTopologyStore((s) => s.fetchTopology);
  const fetchInterfaceStatus = useTopologyStore((s) => s.fetchInterfaceStatus);

  useEffect(() => {
    fetchTopology();
    fetchInterfaceStatus();
    const interval = setInterval(() => {
      fetchTopology();
      fetchInterfaceStatus();
    }, 30000);
    return () => clearInterval(interval);
  }, [fetchTopology, fetchInterfaceStatus]);

  useEffect(() => {
    if (!paperRef.current || graphRef.current) return;

    const graph = new dia.Graph();
    graphRef.current = graph;

    const paper = new dia.Paper({
      el: paperRef.current,
      model: graph,
      width: 2900,  // Reduced from 3200
      height: 1600,  // Reduced from 1800
      gridSize: 100,
      drawGrid: true,
      background: { color: '#0a0f1a' },
      drawGridSize: 100,
      gridPattern: [
        { color: '#334155', thickness: 1 },
        { color: '#1e293b', thickness: 1, scaleFactor: 5 }
      ],
      interactive: false,
    });
    paperInstanceRef.current = paper;

    // Scaling is handled in CSS
    // Store paper reference so we can scale after graph is built
    // Add tooltip element to DOM
    const tooltip = document.createElement('div');
    tooltip.style.position = 'absolute';
    tooltip.style.background = 'rgba(15, 23, 42, 0.95)';
    tooltip.style.color = '#94a3b8';
    tooltip.style.padding = '8px 12px';
    tooltip.style.borderRadius = '6px';
    tooltip.style.fontSize = '12px';
    tooltip.style.pointerEvents = 'none';
    tooltip.style.display = 'none';
    tooltip.style.zIndex = '1000';
    tooltip.style.border = '1px solid #334155';
    tooltip.style.whiteSpace = 'pre-line';
    paperRef.current.appendChild(tooltip);

    // Handle hover events for eNodeB
    paper.on('element:mouseenter', (elementView) => {
      const element = elementView.model;
      if (element.id === 'enb' && element.get('tooltipData')) {
        tooltip.textContent = element.get('tooltipData');
        tooltip.style.display = 'block';
      }
    });

    paper.on('element:mouseleave', () => {
      tooltip.style.display = 'none';
    });

    paper.on('element:mousemove', (elementView, evt) => {
      const element = elementView.model;
      if (element.id === 'enb' && element.get('tooltipData')) {
        tooltip.style.left = `${evt.clientX + 10}px`;
        tooltip.style.top = `${evt.clientY + 10}px`;
      }
    });

    return () => {
      paper.remove();
      graphRef.current = null;
      paperInstanceRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!graphRef.current || !graph) return;

    const jointGraph = graphRef.current;
    jointGraph.clear();

    const nfMap = new Map(graph.nodes.map(n => [n.id, n]));
    
    // Check if S1-MME interface is active
    const s1mmeActive = interfaceStatus?.s1mme?.active || false;
    const s1mmeConnectedEnodebs = (interfaceStatus?.s1mme?.connectedEnodebs || []).map((r: any) => typeof r === 'string' ? r : r.ip);
    
    // Check if S1-U interface is active
    const s1uActive = interfaceStatus?.s1u?.active || false;
    const s1uConnectedEnodebs = (interfaceStatus?.s1u?.connectedEnodebs || []).map((r: any) => typeof r === 'string' ? r : r.ip);

    // ========================================
    // BACKGROUND BOXES
    // ========================================

    // Control Plane Box (GRAY border)
    const controlPlaneBox = new shapes.standard.Rectangle({
      position: { x: 200, y: 200 },
      size: { width: 1600, height: 750 },
      attrs: {
        body: {
          fill: 'rgba(30, 41, 59, 0.3)',
          stroke: '#64748b',
          strokeWidth: 3,
        },
        label: {
          text: 'Open5GS 4G/5G Control Plane Server',
          fill: '#94a3b8',
          fontSize: 20,
          fontWeight: 'bold',
          refX: '50%',
          refY: 10,
        },
      },
      z: 1,
    });
    controlPlaneBox.addTo(jointGraph);

    // SBI Box (PINK dashed border - INSIDE control plane box)
    const sbiBox = new shapes.standard.Rectangle({
      position: { x: 1000, y: 250 },
      size: { width: 750, height: 520 },
      attrs: {
        body: {
          fill: 'rgba(236, 72, 153, 0.05)',
          stroke: '#ec4899',
          strokeWidth: 2,
          strokeDasharray: '5,3',
        },
        label: {
          text: 'SBI Connections',
          fill: '#ec4899',
          fontSize: 16,
          fontWeight: 'bold',
          refX: '50%',
          refY: 10,
        },
      },
      z: 2,
    });
    sbiBox.addTo(jointGraph);

    // User Plane Box (GRAY border on right)
    const userPlaneBox = new shapes.standard.Rectangle({
      position: { x: 2000, y: 1050 },
      size: { width: 600, height: 500 },
      attrs: {
        body: {
          fill: 'rgba(30, 41, 59, 0.3)',
          stroke: '#64748b',
          strokeWidth: 3,
        },
        label: {
          text: 'Open5GS 4G/5G User Plane Server',
          fill: '#94a3b8',
          fontSize: 18,
          fontWeight: 'bold',
          refX: '50%',
          refY: '100%',  // Move to bottom
          refY2: -10,    // 10px from bottom edge
        },
      },
      z: 1,
    });
    userPlaneBox.addTo(jointGraph);

    // ========================================
    // NODES
    // ========================================

    const createNfNode = (id: string, x: number, y: number, label: string, generation: '4G' | '5G') => {
      const nf = nfMap.get(id);
      const isActive = nf?.active || false;
      
      const fillColor = generation === '4G' 
        ? (isActive ? '#16a34a' : '#14532d')
        : (isActive ? '#3b82f6' : '#1e3a8a');
      
      const strokeColor = generation === '4G' ? '#22c55e' : '#60a5fa';

      const node = new shapes.standard.Rectangle({
        id,
        position: { x, y },
        size: { width: 100, height: 60 },
        attrs: {
          body: {
            fill: fillColor,
            stroke: strokeColor,
            strokeWidth: 2,
            rx: 5,
            ry: 5,
          },
          label: {
            text: label,
            fill: '#e2e8f0',
            fontSize: 14,
            fontWeight: 'bold',
            textVerticalAnchor: 'middle',
          },
        },
        z: 10,
      });
      
      // Add status indicator circle in top-right corner
      const statusCircle = new shapes.standard.Circle({
        position: { x: x + 85, y: y + 5 },  // top-right corner
        size: { width: 10, height: 10 },
        attrs: {
          body: {
            fill: isActive ? '#22c55e' : '#ef4444',  // green or red
            stroke: isActive ? '#16a34a' : '#dc2626',
            strokeWidth: 1,
          },
        },
        z: 11,  // Above the node
      });
      statusCircle.addTo(jointGraph);
      
      return node;
    };

    // 4G EPC (Left side, outside SBI box) - CENTERED on coordinates
    // Box size is 100x60, so subtract 50 from x and 30 from y to center
    const hss = createNfNode('hss', 300 - 50, 400 - 30, 'HSS', '4G');      // centered at 300,400
    const mme = createNfNode('mme', 300 - 50, 700 - 30, 'MME', '4G');      // centered at 300,700
    const sgwc = createNfNode('sgwc', 600 - 50, 700 - 30, 'SGW-C', '4G');  // centered at 600,700
    const pcrf = createNfNode('pcrf', 800 - 50, 600 - 30, 'PCRF', '4G');   // centered at 800,600

    hss.addTo(jointGraph);
    mme.addTo(jointGraph);
    sgwc.addTo(jointGraph);
    pcrf.addTo(jointGraph);

    // MongoDB - CENTERED (square box like others)
    const mongodbNf = nfMap.get('mongodb');
    const mongodbActive = mongodbNf?.active || false;
    const mongodb = new shapes.standard.Rectangle({
      id: 'mongodb',
      position: { x: 800 - 50, y: 400 - 30 },  // centered at 800,400
      size: { width: 100, height: 60 },
      attrs: {
        body: {
          fill: '#7c3aed',
          stroke: '#a855f7',
          strokeWidth: 2,
          rx: 5,
          ry: 5,
        },
        label: {
          text: 'MongoDB',
          fill: '#e9d5ff',
          fontSize: 10,
          fontWeight: 'bold',
        },
      },
      z: 10,
    });
    mongodb.addTo(jointGraph);

    // Status indicator circle for MongoDB (top-right corner, same pattern as createNfNode)
    const mongodbStatusCircle = new shapes.standard.Circle({
      position: { x: 800 - 50 + 85, y: 400 - 30 + 5 },
      size: { width: 10, height: 10 },
      attrs: {
        body: {
          fill: mongodbActive ? '#22c55e' : '#ef4444',
          stroke: mongodbActive ? '#16a34a' : '#dc2626',
          strokeWidth: 1,
        },
      },
      z: 11,
    });
    mongodbStatusCircle.addTo(jointGraph);

    // SBI Box - NRF and NSSF on top border (snapped to grid) - half height, centered on border
    const nrf = new shapes.standard.Rectangle({
      id: 'nrf',
      position: { x: 1200 - 50, y: 250 - 15 },  // centered at 1200,250 with half height (30 instead of 60)
      size: { width: 100, height: 30 },
      attrs: {
        body: {
          fill: '#3b82f6',
          stroke: '#60a5fa',
          strokeWidth: 2,
          rx: 5,
          ry: 5,
        },
        label: {
          text: 'NRF',
          fill: '#e2e8f0',
          fontSize: 10,
          fontWeight: 'bold',
        },
      },
      z: 10,
    });
    
    const nssf = new shapes.standard.Rectangle({
      id: 'nssf',
      position: { x: 1600 - 50, y: 250 - 15 },  // centered at 1600,250 with half height (30 instead of 60)
      size: { width: 100, height: 30 },
      attrs: {
        body: {
          fill: '#3b82f6',
          stroke: '#60a5fa',
          strokeWidth: 2,
          rx: 5,
          ry: 5,
        },
        label: {
          text: 'NSSF',
          fill: '#e2e8f0',
          fontSize: 10,
          fontWeight: 'bold',
        },
      },
      z: 10,
    });

    nrf.addTo(jointGraph);
    nssf.addTo(jointGraph);

    // SBI Box - Inside nodes (CENTERED on coordinates)
    // UDM moved up one grid (to 300), UDR takes UDM's old position (400)
    // Then PCF, SMF evenly spaced below at 100-pixel intervals
    const udm = createNfNode('udm', 1100 - 50, 300 - 30, 'UDM', '5G');           // centered at 1100,300
    const udr = createNfNode('udr', 1100 - 50, 400 - 30, 'UDR', '5G');           // centered at 1100,400
    const pcf = createNfNode('pcf', 1100 - 50, 600 - 30, 'PCF', '5G');           // centered at 1100,600
    const smf = createNfNode('smf', 1100 - 50, 700 - 30, 'SMF\n(PGW-C)', '5G'); // centered at 1100,700
    const ausf = createNfNode('ausf', 1600 - 50, 300 - 30, 'AUSF', '5G');        // centered at 1600,300
    const amf = createNfNode('amf', 1600 - 50, 700 - 30, 'AMF', '5G');           // centered at 1600,700

    udm.addTo(jointGraph);
    udr.addTo(jointGraph);
    pcf.addTo(jointGraph);
    smf.addTo(jointGraph);
    ausf.addTo(jointGraph);
    amf.addTo(jointGraph);

    // User Plane - CENTERED
    const sgwu = createNfNode('sgwu', 2200 - 50, 1400 - 30, 'SGW-U', '4G');      // centered at 2200,1400
    const upf = createNfNode('upf', 2400 - 50, 1395 - 30, 'UPF\n(PGW-U)', '5G'); // centered at 2400,1395

    sgwu.addTo(jointGraph);
    upf.addTo(jointGraph);

    // WAN/Internet - CENTERED (circle 100x100)
    const internet = new shapes.standard.Circle({
      id: 'internet',
      position: { x: 2750 - 50, y: 1380 - 50 },  // centered at 2750,1380
      size: { width: 100, height: 100 },
      attrs: {
        body: {
          fill: '#0891b2',
          stroke: '#06b6d4',
          strokeWidth: 2,
        },
        label: {
          text: 'Internet',
          fill: '#e0f2fe',
          fontSize: 14,
          fontWeight: 'bold',
        },
      },
      z: 10,
    });
    internet.addTo(jointGraph);

    // RAN - Simple boxes at bottom - CENTERED (90x70)
    const enb = new shapes.standard.Rectangle({
      id: 'enb',
      position: { x: 500 - 45, y: 1100 - 35 },  // centered at 500,1100
      size: { width: 90, height: 70 },
      attrs: {
        body: {
          fill: '#ea580c',
          stroke: '#f97316',
          strokeWidth: 2,
          rx: 5,
          ry: 5,
        },
        label: {
          text: 'eNodeB',
          fill: '#fed7aa',
          fontSize: 11,
          fontWeight: 'bold',
        },
      },
      z: 10,
    });
    enb.addTo(jointGraph);
    
    // gNodeB - CENTERED at 2400,700 (size 90x70)
    const gnb = new shapes.standard.Rectangle({
      id: 'gnb',
      position: { x: 2400 - 45, y: 700 - 35 },  // centered at 2400,700
      size: { width: 90, height: 70 },
      attrs: {
        body: {
          fill: '#ea580c',
          stroke: '#f97316',
          strokeWidth: 2,
          rx: 5,
          ry: 5,
        },
        label: {
          text: 'gNodeB',
          fill: '#fed7aa',
          fontSize: 11,
          fontWeight: 'bold',
        },
      },
      z: 10,
    });
    gnb.addTo(jointGraph);
    
    console.log('S1-MME Status:', { s1mmeActive, s1mmeConnectedEnodebs });
    console.log('S1-U Status:', { s1uActive, s1uConnectedEnodebs });
    
    // Add status indicator and tooltip if eNodeBs are connected
    if (s1mmeActive) {
      console.log('Adding green circle to eNodeB');
      const enbStatusCircle = new shapes.standard.Circle({
        position: { x: 500 - 45 + 75, y: 1100 - 35 + 5 },  // top-right corner
        size: { width: 10, height: 10 },
        attrs: {
          body: {
            fill: '#22c55e',  // green
            stroke: '#16a34a',
            strokeWidth: 1,
          },
        },
        z: 11,
      });
      enbStatusCircle.addTo(jointGraph);
      
      // Set tooltip data
      const tooltipText = `Connected eNodeBs (${s1mmeConnectedEnodebs.length}):\n${s1mmeConnectedEnodebs.join('\n')}`;
      enb.set('tooltipData', tooltipText);
    }



    // ========================================
    // CONNECTED RADIOS BOX (S1-MME and S1-U)
    // ========================================
    
    // Main box with gradient background - SCALED UP
    // Centered at x=500 to align with eNodeB for vertical line
    // Box height is dynamic based on number of connected radios
    const s1mmeRows = Math.max(1, s1mmeConnectedEnodebs.length);
    const s1uRows   = Math.max(1, s1uConnectedEnodebs.length);
    const connectedRadiosBoxHeight = 42 + 58 + (s1mmeRows * 26) + 28 + 34 + (s1uRows * 26) + 20;
    const connectedRadiosBox = new shapes.standard.Rectangle({
      position: { x: 375, y: 1250 },  // x=500-125 (half of width 250) to center at 500
      size: { width: 250, height: connectedRadiosBoxHeight },
      attrs: {
        body: {
          fill: {
            type: 'linearGradient',
            stops: [
              { offset: '0%', color: 'rgba(30, 41, 59, 0.7)' },
              { offset: '100%', color: 'rgba(15, 23, 42, 0.7)' }
            ],
            attrs: { x1: '0%', y1: '0%', x2: '0%', y2: '100%' }
          },
          stroke: '#475569',
          strokeWidth: 2,
          rx: 8,
          ry: 8,
          filter: { name: 'dropShadow', args: { dx: 2, dy: 2, blur: 6, color: 'rgba(0,0,0,0.3)' } },
        },
        label: { text: '' },
      },
      z: 10,
    });
    connectedRadiosBox.addTo(jointGraph);
    
    // Header bar
    const radiosHeader = new shapes.standard.Rectangle({
      position: { x: 375, y: 1250 },
      size: { width: 250, height: 42 },
      attrs: {
        body: {
          fill: {
            type: 'linearGradient',
            stops: [
              { offset: '0%', color: 'rgba(100, 116, 139, 0.3)' },
              { offset: '100%', color: 'rgba(71, 85, 105, 0.3)' }
            ],
            attrs: { x1: '0%', y1: '0%', x2: '0%', y2: '100%' }
          },
          stroke: 'none',
          rx: 8,
          ry: 8,
        },
        label: { text: '' },
      },
      z: 11,
    });
    radiosHeader.addTo(jointGraph);
    
    // Title with count badge
    const totalRadios = s1mmeConnectedEnodebs.length + s1uConnectedEnodebs.length;
    const radiosTitle = new shapes.standard.TextBlock({
      position: { x: 390, y: 1258 },
      size: { width: 180, height: 30 },
      attrs: {
        body: { fill: 'transparent', stroke: 'none' },
        label: {
          text: 'Radio Network Status',
          fill: '#e2e8f0',
          fontSize: 16,
          fontWeight: 'bold',
          textAnchor: 'start',
          refX: 5,
        },
      },
      z: 12,
    });
    radiosTitle.addTo(jointGraph);
    
    // Count badge
    if (totalRadios > 0) {
      const countBadge = new shapes.standard.Circle({
        position: { x: 593, y: 1258 },
        size: { width: 30, height: 30 },
        attrs: {
          body: {
            fill: '#a855f7',
            stroke: '#7c3aed',
            strokeWidth: 1.5,
          },
          label: {
            text: String(totalRadios),
            fill: '#ffffff',
            fontSize: 14,
            fontWeight: 'bold',
          },
        },
        z: 12,
      });
      countBadge.addTo(jointGraph);
    }
    
    // Vertical line from eNodeB to Connected Radios box (purple, animated if active)
    // Single vertical line - eNodeB and box both centered at x=500
    const enbToRadiosLink = new shapes.standard.Link({
      source: { id: 'enb' },
      target: { x: 500, y: 1250 },  // Top center of Connected Radios box at x=500
      vertices: [],  // No vertices needed - straight vertical line
      attrs: {
        line: {
          stroke: '#a855f7',  // Purple
          strokeWidth: 2,
          strokeDasharray: s1mmeActive ? '10,10' : '0',  // Animate if radios connected
          targetMarker: {
            type: 'path',
            d: 'M 10 -5 0 0 10 5 z',
            fill: '#a855f7',
          },
          class: s1mmeActive ? 'interface-active' : '',
        },
      },
      z: 5,
    });
    enbToRadiosLink.addTo(jointGraph);
    
    // S1-MME Section with status badge
    const s1mmeLabel = new shapes.standard.TextBlock({
      position: { x: 390, y: 1308 },
      size: { width: 220, height: 24 },
      attrs: {
        body: { fill: 'transparent', stroke: 'none' },
        label: {
          text: 'S1-MME',
          fill: '#94a3b8',
          fontSize: 14,
          fontWeight: '600',
          textAnchor: 'start',
          refX: 5,
        },
      },
      z: 11,
    });
    s1mmeLabel.addTo(jointGraph);
    
    // Status indicator for S1-MME
    const s1mmeStatusBadge = new shapes.standard.Rectangle({
      position: { x: 577, y: 1308 },
      size: { width: 44, height: 22 },
      attrs: {
        body: {
          fill: s1mmeActive ? 'rgba(34, 197, 94, 0.2)' : 'rgba(100, 116, 139, 0.2)',
          stroke: s1mmeActive ? '#22c55e' : '#64748b',
          strokeWidth: 1,
          rx: 8,
          ry: 8,
        },
        label: {
          text: s1mmeActive ? 'ON' : 'OFF',
          fill: s1mmeActive ? '#22c55e' : '#64748b',
          fontSize: 11,
          fontWeight: 'bold',
        },
      },
      z: 11,
    });
    s1mmeStatusBadge.addTo(jointGraph);
    
    // S1-MME IP list
    if (s1mmeActive && s1mmeConnectedEnodebs.length > 0) {
      s1mmeConnectedEnodebs.forEach((ip, index) => {
        const ipText = new shapes.standard.TextBlock({
          position: { x: 395, y: 1340 + (index * 26) },
          size: { width: 220, height: 26 },
          attrs: {
            body: { fill: 'transparent', stroke: 'none' },
            label: {
              text: `◆ ${ip}`,
              fill: '#4ade80',
              fontSize: 15,
              fontFamily: 'monospace',
              textAnchor: 'start',
              refX: 5,
            },
          },
          z: 11,
        });
        ipText.addTo(jointGraph);
      });
    } else {
      const noS1mmeText = new shapes.standard.TextBlock({
        position: { x: 395, y: 1340 },
        size: { width: 220, height: 26 },
        attrs: {
          body: { fill: 'transparent', stroke: 'none' },
          label: {
            text: '— No connections',
            fill: '#475569',
            fontSize: 14,
            fontStyle: 'italic',
            textAnchor: 'start',
            refX: 5,
          },
        },
        z: 11,
      });
      noS1mmeText.addTo(jointGraph);
    }
    
    // Divider line between sections
    const s1uYStart = s1mmeActive && s1mmeConnectedEnodebs.length > 0 
      ? 1340 + (s1mmeConnectedEnodebs.length * 26) + 18
      : 1340 + 26 + 18;
    
    const dividerLine = new shapes.standard.Rectangle({
      position: { x: 390, y: s1uYStart },
      size: { width: 220, height: 1 },
      attrs: {
        body: {
          fill: '#334155',
          stroke: 'none',
        },
        label: { text: '' },
      },
      z: 11,
    });
    dividerLine.addTo(jointGraph);
    
    // S1-U Section with status badge
    const s1uLabel = new shapes.standard.TextBlock({
      position: { x: 390, y: s1uYStart + 10 },
      size: { width: 220, height: 24 },
      attrs: {
        body: { fill: 'transparent', stroke: 'none' },
        label: {
          text: 'S1-U',
          fill: '#94a3b8',
          fontSize: 14,
          fontWeight: '600',
          textAnchor: 'start',
          refX: 5,
        },
      },
      z: 11,
    });
    s1uLabel.addTo(jointGraph);
    
    // Status indicator for S1-U
    const s1uStatusBadge = new shapes.standard.Rectangle({
      position: { x: 577, y: s1uYStart + 10 },
      size: { width: 44, height: 22 },
      attrs: {
        body: {
          fill: s1uActive ? 'rgba(234, 179, 8, 0.2)' : 'rgba(100, 116, 139, 0.2)',
          stroke: s1uActive ? '#eab308' : '#64748b',
          strokeWidth: 1,
          rx: 8,
          ry: 8,
        },
        label: {
          text: s1uActive ? 'ON' : 'OFF',
          fill: s1uActive ? '#eab308' : '#64748b',
          fontSize: 11,
          fontWeight: 'bold',
        },
      },
      z: 11,
    });
    s1uStatusBadge.addTo(jointGraph);
    
    // S1-U IP list
    if (s1uActive && s1uConnectedEnodebs.length > 0) {
      s1uConnectedEnodebs.forEach((ip, index) => {
        const ipText = new shapes.standard.TextBlock({
          position: { x: 395, y: s1uYStart + 42 + (index * 26) },
          size: { width: 220, height: 26 },
          attrs: {
            body: { fill: 'transparent', stroke: 'none' },
            label: {
              text: `◆ ${ip}`,
              fill: '#fbbf24',
              fontSize: 15,
              fontFamily: 'monospace',
              textAnchor: 'start',
              refX: 5,
            },
          },
          z: 11,
        });
        ipText.addTo(jointGraph);
      });
    } else {
      const noS1uText = new shapes.standard.TextBlock({
        position: { x: 395, y: s1uYStart + 42 },
        size: { width: 220, height: 26 },
        attrs: {
          body: { fill: 'transparent', stroke: 'none' },
          label: {
            text: '— No connections',
            fill: '#475569',
            fontSize: 14,
            fontStyle: 'italic',
            textAnchor: 'start',
            refX: 5,
          },
        },
        z: 11,
      });
      noS1uText.addTo(jointGraph);
    }

    // ========================================
    // ACTIVE SESSIONS BOX (NEW - UE IP + IMSI)
    // ========================================
    
    // Get active UEs from interface status - SEPARATED BY GENERATION
    const activeUEs4G = interfaceStatus?.activeUEs4G || [];
    const activeUEs5G = interfaceStatus?.activeUEs5G || [];
    
    // Main box with gradient background - SCALED UP
    const activeSessionsBox = new shapes.standard.Rectangle({
      position: { x: 750, y: 1250 },
      size: { width: 250, height: 350 },
      attrs: {
        body: {
          fill: {
            type: 'linearGradient',
            stops: [
              { offset: '0%', color: 'rgba(30, 41, 59, 0.7)' },
              { offset: '100%', color: 'rgba(15, 23, 42, 0.7)' }
            ],
            attrs: { x1: '0%', y1: '0%', x2: '0%', y2: '100%' }
          },
          stroke: '#475569',
          strokeWidth: 2,
          rx: 8,
          ry: 8,
          filter: { name: 'dropShadow', args: { dx: 2, dy: 2, blur: 6, color: 'rgba(0,0,0,0.3)' } },
        },
        label: { text: '' },
      },
      z: 10,
    });
    activeSessionsBox.addTo(jointGraph);
    
    // Header bar
    const sessionsHeader = new shapes.standard.Rectangle({
      position: { x: 750, y: 1250 },
      size: { width: 250, height: 42 },
      attrs: {
        body: {
          fill: {
            type: 'linearGradient',
            stops: [
              { offset: '0%', color: 'rgba(6, 182, 212, 0.2)' },
              { offset: '100%', color: 'rgba(8, 145, 178, 0.2)' }
            ],
            attrs: { x1: '0%', y1: '0%', x2: '0%', y2: '100%' }
          },
          stroke: 'none',
          rx: 8,
          ry: 8,
        },
        label: { text: '' },
      },
      z: 11,
    });
    sessionsHeader.addTo(jointGraph);
    
    // Title with count badge
    const sessionsTitle = new shapes.standard.TextBlock({
      position: { x: 765, y: 1258 },
      size: { width: 180, height: 30 },
      attrs: {
        body: { fill: 'transparent', stroke: 'none' },
        label: {
          text: 'Active 4G UE Sessions',
          fill: '#e2e8f0',
          fontSize: 16,
          fontWeight: 'bold',
          textAnchor: 'start',
          refX: 5,
        },
      },
      z: 12,
    });
    sessionsTitle.addTo(jointGraph);
    
    // Count badge
    if (activeUEs4G.length > 0) {
      const ueCountBadge = new shapes.standard.Circle({
        position: { x: 968, y: 1258 },
        size: { width: 30, height: 30 },
        attrs: {
          body: {
            fill: '#06b6d4',
            stroke: '#0891b2',
            strokeWidth: 1.5,
          },
          label: {
            text: String(activeUEs4G.length),
            fill: '#ffffff',
            fontSize: 14,
            fontWeight: 'bold',
          },
        },
        z: 12,
      });
      ueCountBadge.addTo(jointGraph);
    }
    
    // Render UE list or empty state
    if (activeUEs4G.length > 0) {
      activeUEs4G.forEach((ue, index) => {
        // Session card background
        const sessionCard = new shapes.standard.Rectangle({
          position: { x: 765, y: 1308 + (index * 56) },
          size: { width: 220, height: 52 },
          attrs: {
            body: {
              fill: 'rgba(6, 182, 212, 0.05)',
              stroke: '#0e7490',
              strokeWidth: 1,
              strokeDasharray: '2,2',
              rx: 4,
              ry: 4,
            },
            label: { text: '' },
          },
          z: 11,
        });
        sessionCard.addTo(jointGraph);
        
        // IP address with icon
        const ipText = new shapes.standard.TextBlock({
          position: { x: 772, y: 1314 + (index * 56) },
          size: { width: 210, height: 22 },
          attrs: {
            body: { fill: 'transparent', stroke: 'none' },
            label: {
              text: `◆ ${ue.ip}`,
              fill: '#22d3ee',
              fontSize: 15,
              fontWeight: '600',
              fontFamily: 'monospace',
              textAnchor: 'start',
              refX: 5,
            },
          },
          z: 12,
        });
        ipText.addTo(jointGraph);
        
        // IMSI (indented, smaller font with label)
        const imsiText = new shapes.standard.TextBlock({
          position: { x: 772, y: 1337 + (index * 56) },
          size: { width: 210, height: 20 },
          attrs: {
            body: { fill: 'transparent', stroke: 'none' },
            label: {
              text: `  IMSI: ${ue.imsi}`,
              fill: '#67e8f9',
              fontSize: 12,
              fontFamily: 'monospace',
              textAnchor: 'start',
              refX: 5,
            },
          },
          z: 12,
        });
        imsiText.addTo(jointGraph);
      });
    } else {
      // Empty state with icon
      const emptyIcon = new shapes.standard.Circle({
        position: { x: 860, y: 1330 },
        size: { width: 36, height: 36 },
        attrs: {
          body: {
            fill: 'rgba(100, 116, 139, 0.1)',
            stroke: '#475569',
            strokeWidth: 2,
            strokeDasharray: '3,3',
          },
          label: {
            text: '○',
            fill: '#475569',
            fontSize: 24,
          },
        },
        z: 11,
      });
      emptyIcon.addTo(jointGraph);
      
      const noSessionsText = new shapes.standard.TextBlock({
        position: { x: 765, y: 1375 },
        size: { width: 220, height: 24 },
        attrs: {
          body: { fill: 'transparent', stroke: 'none' },
          label: {
            text: 'No active sessions',
            fill: '#475569',
            fontSize: 14,
            fontStyle: 'italic',
            textAnchor: 'middle',
            refX: '50%',
          },
        },
        z: 11,
      });
      noSessionsText.addTo(jointGraph);
    }
    
    // Purple dashed connection line from Connected Radios to Active Sessions
    const hasActiveSessions = activeUEs4G.length > 0;
    const sessionLink = new shapes.standard.Link({
      source: { x: 625, y: 1425 },  // Right edge of Connected Radios (scaled, adjusted for new x position)
      target: { x: 750, y: 1425 },  // Left edge of Active Sessions (scaled)
      vertices: [],  // Straight horizontal line
      attrs: {
        line: {
          stroke: '#a855f7',  // Purple
          strokeWidth: 2,
          strokeDasharray: hasActiveSessions ? '10,10' : '5,3',  // Animate if active
          targetMarker: {
            type: 'path',
            d: 'M 10 -5 0 0 10 5 z',
            fill: '#a855f7',
          },
          class: hasActiveSessions ? 'interface-active' : '',
        },
      },
      z: 5,
    });
    sessionLink.addTo(jointGraph);

    // ========================================
    // 5G RADIO NETWORK STATUS BOX (N2 and N3)
    // ========================================
    
    // Check if N2 interface is active
    const n2Active = interfaceStatus?.n2?.active || false;
    const n2ConnectedGnodebs = (interfaceStatus?.n2?.connectedGnodebs || []).map((r: any) => typeof r === 'string' ? r : r.ip);
    
    // Check if N3 interface is active
    const n3Active = interfaceStatus?.n3?.active || false;
    const n3ConnectedGnodebs = (interfaceStatus?.n3?.connectedGnodebs || []).map((r: any) => typeof r === 'string' ? r : r.ip);
    
    // Main box - 100px to the left of Active 5G Sessions box
    const fiveGRadioBox = new shapes.standard.Rectangle({
      position: { x: 1925, y: 150 },
      size: { width: 250, height: 350 },
      attrs: {
        body: {
          fill: {
            type: 'linearGradient',
            stops: [
              { offset: '0%', color: 'rgba(30, 41, 59, 0.7)' },
              { offset: '100%', color: 'rgba(15, 23, 42, 0.7)' }
            ],
            attrs: { x1: '0%', y1: '0%', x2: '0%', y2: '100%' }
          },
          stroke: '#475569',
          strokeWidth: 2,
          rx: 8,
          ry: 8,
          filter: { name: 'dropShadow', args: { dx: 2, dy: 2, blur: 6, color: 'rgba(0,0,0,0.3)' } },
        },
        label: { text: '' },
      },
      z: 10,
    });
    fiveGRadioBox.addTo(jointGraph);
    
    // Header bar (blue tint for 5G)
    const fiveGRadioHeader = new shapes.standard.Rectangle({
      position: { x: 1925, y: 150 },
      size: { width: 250, height: 42 },
      attrs: {
        body: {
          fill: {
            type: 'linearGradient',
            stops: [
              { offset: '0%', color: 'rgba(59, 130, 246, 0.3)' },
              { offset: '100%', color: 'rgba(37, 99, 235, 0.3)' }
            ],
            attrs: { x1: '0%', y1: '0%', x2: '0%', y2: '100%' }
          },
          stroke: 'none',
          rx: 8,
          ry: 8,
        },
        label: { text: '' },
      },
      z: 11,
    });
    fiveGRadioHeader.addTo(jointGraph);
    
    // Title
    const fiveGRadioTitle = new shapes.standard.TextBlock({
      position: { x: 1940, y: 158 },
      size: { width: 180, height: 30 },
      attrs: {
        body: { fill: 'transparent', stroke: 'none' },
        label: {
          text: '5G Radio Network Status',
          fill: '#e2e8f0',
          fontSize: 16,
          fontWeight: 'bold',
          textAnchor: 'start',
          refX: 5,
        },
      },
      z: 12,
    });
    fiveGRadioTitle.addTo(jointGraph);
    
    // Count badge
    const totalFiveGRadios = n2ConnectedGnodebs.length + n3ConnectedGnodebs.length;
    if (totalFiveGRadios > 0) {
      const fiveGCountBadge = new shapes.standard.Circle({
        position: { x: 2143, y: 158 },
        size: { width: 30, height: 30 },
        attrs: {
          body: {
            fill: '#3b82f6',
            stroke: '#2563eb',
            strokeWidth: 1.5,
          },
          label: {
            text: String(totalFiveGRadios),
            fill: '#ffffff',
            fontSize: 14,
            fontWeight: 'bold',
          },
        },
        z: 12,
      });
      fiveGCountBadge.addTo(jointGraph);
    }
    
    // N2 Section
    const n2Label = new shapes.standard.TextBlock({
      position: { x: 1940, y: 208 },
      size: { width: 220, height: 24 },
      attrs: {
        body: { fill: 'transparent', stroke: 'none' },
        label: {
          text: 'N2',
          fill: '#94a3b8',
          fontSize: 14,
          fontWeight: '600',
          textAnchor: 'start',
          refX: 5,
        },
      },
      z: 11,
    });
    n2Label.addTo(jointGraph);
    
    // Status indicator for N2
    const n2StatusBadge = new shapes.standard.Rectangle({
      position: { x: 2127, y: 208 },
      size: { width: 44, height: 22 },
      attrs: {
        body: {
          fill: n2Active ? 'rgba(96, 165, 250, 0.2)' : 'rgba(100, 116, 139, 0.2)',
          stroke: n2Active ? '#60a5fa' : '#64748b',
          strokeWidth: 1,
          rx: 8,
          ry: 8,
        },
        label: {
          text: n2Active ? 'ON' : 'OFF',
          fill: n2Active ? '#60a5fa' : '#64748b',
          fontSize: 11,
          fontWeight: 'bold',
        },
      },
      z: 11,
    });
    n2StatusBadge.addTo(jointGraph);
    
    // N2 IP list
    if (n2Active && n2ConnectedGnodebs.length > 0) {
      n2ConnectedGnodebs.forEach((ip, index) => {
        const ipText = new shapes.standard.TextBlock({
          position: { x: 1945, y: 240 + (index * 26) },
          size: { width: 220, height: 26 },
          attrs: {
            body: { fill: 'transparent', stroke: 'none' },
            label: {
              text: `◆ ${ip}`,
              fill: '#60a5fa',
              fontSize: 15,
              fontFamily: 'monospace',
              textAnchor: 'start',
              refX: 5,
            },
          },
          z: 11,
        });
        ipText.addTo(jointGraph);
      });
    } else {
      const noN2Text = new shapes.standard.TextBlock({
        position: { x: 1945, y: 240 },
        size: { width: 220, height: 26 },
        attrs: {
          body: { fill: 'transparent', stroke: 'none' },
          label: {
            text: '— No connections',
            fill: '#475569',
            fontSize: 14,
            fontStyle: 'italic',
            textAnchor: 'start',
            refX: 5,
          },
        },
        z: 11,
      });
      noN2Text.addTo(jointGraph);
    }
    
    // Divider line between N2 and N3
    const n3YStart = n2Active && n2ConnectedGnodebs.length > 0 
      ? 240 + (n2ConnectedGnodebs.length * 26) + 18
      : 240 + 26 + 18;
    
    const n2n3DividerLine = new shapes.standard.Rectangle({
      position: { x: 1940, y: n3YStart },
      size: { width: 220, height: 1 },
      attrs: {
        body: {
          fill: '#334155',
          stroke: 'none',
        },
        label: { text: '' },
      },
      z: 11,
    });
    n2n3DividerLine.addTo(jointGraph);
    
    // N3 Section
    const n3Label = new shapes.standard.TextBlock({
      position: { x: 1940, y: n3YStart + 10 },
      size: { width: 220, height: 24 },
      attrs: {
        body: { fill: 'transparent', stroke: 'none' },
        label: {
          text: 'N3',
          fill: '#94a3b8',
          fontSize: 14,
          fontWeight: '600',
          textAnchor: 'start',
          refX: 5,
        },
      },
      z: 11,
    });
    n3Label.addTo(jointGraph);
    
    // Status indicator for N3
    const n3StatusBadge = new shapes.standard.Rectangle({
      position: { x: 2127, y: n3YStart + 10 },
      size: { width: 44, height: 22 },
      attrs: {
        body: {
          fill: n3Active ? 'rgba(234, 179, 8, 0.2)' : 'rgba(100, 116, 139, 0.2)',
          stroke: n3Active ? '#eab308' : '#64748b',
          strokeWidth: 1,
          rx: 8,
          ry: 8,
        },
        label: {
          text: n3Active ? 'ON' : 'OFF',
          fill: n3Active ? '#eab308' : '#64748b',
          fontSize: 11,
          fontWeight: 'bold',
        },
      },
      z: 11,
    });
    n3StatusBadge.addTo(jointGraph);
    
    // N3 IP list
    if (n3Active && n3ConnectedGnodebs.length > 0) {
      n3ConnectedGnodebs.forEach((ip, index) => {
        const ipText = new shapes.standard.TextBlock({
          position: { x: 1945, y: n3YStart + 42 + (index * 26) },
          size: { width: 220, height: 26 },
          attrs: {
            body: { fill: 'transparent', stroke: 'none' },
            label: {
              text: `◆ ${ip}`,
              fill: '#fbbf24',
              fontSize: 15,
              fontFamily: 'monospace',
              textAnchor: 'start',
              refX: 5,
            },
          },
          z: 11,
        });
        ipText.addTo(jointGraph);
      });
    } else {
      const noN3Text = new shapes.standard.TextBlock({
        position: { x: 1945, y: n3YStart + 42 },
        size: { width: 220, height: 26 },
        attrs: {
          body: { fill: 'transparent', stroke: 'none' },
          label: {
            text: '— No connections',
            fill: '#475569',
            fontSize: 14,
            fontStyle: 'italic',
            textAnchor: 'start',
            refX: 5,
          },
        },
        z: 11,
      });
      noN3Text.addTo(jointGraph);
    }

    // ========================================
    // PURPLE LINE BETWEEN 5G BOXES
    // ========================================
    
    // Horizontal purple line connecting the two 5G boxes (centered vertically)
    const fiveGBoxesLink = new shapes.standard.Link({
      source: { x: 2175, y: 325 },  // Right edge of Radio Network box (middle)
      target: { x: 2275, y: 325 },  // Left edge of Active Sessions box (middle)
      vertices: [],  // Straight horizontal line
      attrs: {
        line: {
          stroke: '#a855f7',  // Purple
          strokeWidth: 2,
          strokeDasharray: '10,10',  // Animated dashed
          targetMarker: {
            type: 'path',
            d: 'M 10 -5 0 0 10 5 z',
            fill: '#a855f7',
          },
          class: 'interface-active',
        },
      },
      z: 5,
    });
    fiveGBoxesLink.addTo(jointGraph);

    // ========================================
    // ACTIVE 5G UE SESSIONS BOX
    // ========================================
    
    // Main box - Bottom at (2400, 500), centered on gNodeB
    const active5GSessionsBox = new shapes.standard.Rectangle({
      position: { x: 2275, y: 150 },  // Centered at x=2400, bottom at y=500 (500-350=150)
      size: { width: 250, height: 350 },
      attrs: {
        body: {
          fill: {
            type: 'linearGradient',
            stops: [
              { offset: '0%', color: 'rgba(30, 41, 59, 0.7)' },
              { offset: '100%', color: 'rgba(15, 23, 42, 0.7)' }
            ],
            attrs: { x1: '0%', y1: '0%', x2: '0%', y2: '100%' }
          },
          stroke: '#475569',
          strokeWidth: 2,
          rx: 8,
          ry: 8,
          filter: { name: 'dropShadow', args: { dx: 2, dy: 2, blur: 6, color: 'rgba(0,0,0,0.3)' } },
        },
        label: { text: '' },
      },
      z: 10,
    });
    active5GSessionsBox.addTo(jointGraph);
    
    // Header bar
    const sessions5GHeader = new shapes.standard.Rectangle({
      position: { x: 2275, y: 150 },
      size: { width: 250, height: 42 },
      attrs: {
        body: {
          fill: {
            type: 'linearGradient',
            stops: [
              { offset: '0%', color: 'rgba(6, 182, 212, 0.2)' },
              { offset: '100%', color: 'rgba(8, 145, 178, 0.2)' }
            ],
            attrs: { x1: '0%', y1: '0%', x2: '0%', y2: '100%' }
          },
          stroke: 'none',
          rx: 8,
          ry: 8,
        },
        label: { text: '' },
      },
      z: 11,
    });
    sessions5GHeader.addTo(jointGraph);
    
    // Title
    const sessions5GTitle = new shapes.standard.TextBlock({
      position: { x: 2290, y: 158 },
      size: { width: 180, height: 30 },
      attrs: {
        body: { fill: 'transparent', stroke: 'none' },
        label: {
          text: 'Active 5G UE Sessions',
          fill: '#e2e8f0',
          fontSize: 16,
          fontWeight: 'bold',
          textAnchor: 'start',
          refX: 5,
        },
      },
      z: 12,
    });
    sessions5GTitle.addTo(jointGraph);
    
    // Count badge
    if (activeUEs5G.length > 0) {
      const ue5GCountBadge = new shapes.standard.Circle({
        position: { x: 2493, y: 158 },
        size: { width: 30, height: 30 },
        attrs: {
          body: {
            fill: '#06b6d4',
            stroke: '#0891b2',
            strokeWidth: 1.5,
          },
          label: {
            text: String(activeUEs5G.length),
            fill: '#ffffff',
            fontSize: 14,
            fontWeight: 'bold',
          },
        },
        z: 12,
      });
      ue5GCountBadge.addTo(jointGraph);
    }
    
    // Render 5G UE list or empty state
    if (activeUEs5G.length > 0) {
      activeUEs5G.forEach((ue, index) => {
        const sessionCard = new shapes.standard.Rectangle({
          position: { x: 2290, y: 208 + (index * 56) },
          size: { width: 220, height: 52 },
          attrs: {
            body: {
              fill: 'rgba(6, 182, 212, 0.05)',
              stroke: '#0e7490',
              strokeWidth: 1,
              strokeDasharray: '2,2',
              rx: 4,
              ry: 4,
            },
            label: { text: '' },
          },
          z: 11,
        });
        sessionCard.addTo(jointGraph);
        
        const ipText = new shapes.standard.TextBlock({
          position: { x: 2297, y: 214 + (index * 56) },
          size: { width: 210, height: 22 },
          attrs: {
            body: { fill: 'transparent', stroke: 'none' },
            label: {
              text: `◆ ${ue.ip}`,
              fill: '#22d3ee',
              fontSize: 15,
              fontWeight: '600',
              fontFamily: 'monospace',
              textAnchor: 'start',
              refX: 5,
            },
          },
          z: 12,
        });
        ipText.addTo(jointGraph);
        
        const imsiText = new shapes.standard.TextBlock({
          position: { x: 2297, y: 237 + (index * 56) },
          size: { width: 210, height: 20 },
          attrs: {
            body: { fill: 'transparent', stroke: 'none' },
            label: {
              text: `  IMSI: ${ue.imsi}`,
              fill: '#67e8f9',
              fontSize: 12,
              fontFamily: 'monospace',
              textAnchor: 'start',
              refX: 5,
            },
          },
          z: 12,
        });
        imsiText.addTo(jointGraph);
      });
    } else {
      const emptyIcon = new shapes.standard.Circle({
        position: { x: 2385, y: 230 },
        size: { width: 36, height: 36 },
        attrs: {
          body: {
            fill: 'rgba(100, 116, 139, 0.1)',
            stroke: '#475569',
            strokeWidth: 2,
            strokeDasharray: '3,3',
          },
          label: {
            text: '○',
            fill: '#475569',
            fontSize: 24,
          },
        },
        z: 11,
      });
      emptyIcon.addTo(jointGraph);
      
      const no5GSessionsText = new shapes.standard.TextBlock({
        position: { x: 2290, y: 275 },
        size: { width: 220, height: 24 },
        attrs: {
          body: { fill: 'transparent', stroke: 'none' },
          label: {
            text: 'No active sessions',
            fill: '#475569',
            fontSize: 14,
            fontStyle: 'italic',
            textAnchor: 'middle',
            refX: '50%',
          },
        },
        z: 11,
      });
      no5GSessionsText.addTo(jointGraph);
    }

    // Purple vertical line from box to gNodeB (100% vertical at x=2400)
    const hasActive5GSessions = activeUEs5G.length > 0;
    const fiveGSessionLink = new shapes.standard.Link({
      source: { x: 2400, y: 500 },  // Bottom center of Active 5G Sessions box
      target: { id: 'gnb' },         // gNodeB (centered at x=2400)
      vertices: [],
      attrs: {
        line: {
          stroke: hasActive5GSessions ? '#a855f7' : '#475569',
          strokeWidth: 2,
          strokeDasharray: hasActive5GSessions ? '10,10' : '5,5',
          targetMarker: {
            type: 'path',
            d: 'M 10 -5 0 0 10 5 z',
            fill: hasActive5GSessions ? '#a855f7' : '#475569',
          },
          class: hasActive5GSessions ? 'interface-active' : '',
        },
      },
      z: 5,
    });
    fiveGSessionLink.addTo(jointGraph);

    // ========================================
    // CONNECTIONS - Manual routing
    // ========================================

    // Helper function to create links
    const createLink = (source: string, target: string, label: string, color: string, dashed: boolean = false, waypoints: Array<{x: number, y: number}> = []) => {
      // Check if both source and target NFs are active
      const sourceNf = nfMap.get(source);
      const targetNf = nfMap.get(target);
      const bothActive = (sourceNf?.active || false) && (targetNf?.active || false);
      
      const link = new shapes.standard.Link({
        source: { id: source },
        target: { id: target },
        vertices: waypoints,
        attrs: {
          line: {
            stroke: color,
            strokeWidth: 2,
            strokeDasharray: dashed ? '5,3' : (bothActive ? '10,10' : '0'),  // Animate if both active
            targetMarker: {
              type: 'path',
              d: 'M 10 -5 0 0 10 5 z',
              fill: color,
            },
            class: bothActive ? 'interface-active' : '',  // Add animation class
          },
        },
        labels: label ? [{
          attrs: {
            text: {
              text: label,
              fill: '#94a3b8',
              fontSize: 18,
            },
            rect: {
              fill: '#0f172a',
              stroke: 'none',
              rx: 2,
              ry: 2,
            },
          },
          position: 0.5,
        }] : [],
        z: 5,
      });
      link.addTo(jointGraph);
    };

    // HSS to MongoDB - horizontal line (grey dashed)
    createLink('hss', 'mongodb', '', '#94a3b8', true);

    // HSS to MME - vertical line (green) S6a
    createLink('hss', 'mme', 'S6a', '#22c55e');

    // MME to SGW-C - horizontal line (green) S11
    createLink('mme', 'sgwc', 'S11', '#22c55e');

    // SGW-C to SMF - horizontal line (green) S5c
    createLink('sgwc', 'smf', 'S5c', '#22c55e');

    // MongoDB to UDR - horizontal line (grey dashed)
    createLink('mongodb', 'udr', '', '#94a3b8', true);

    // MongoDB to PCRF - vertical line (grey dashed)
    createLink('mongodb', 'pcrf', '', '#94a3b8', true);

    // PCRF to SMF - down and right to top-left corner of SMF (green) Gx
    // SMF is centered at 1100,700, so top-left corner is at (1100-50, 700-30) = (1050, 670)
    // Go down from PCRF (800,600) to y=670, then right to x=1050
    const gxLink = new shapes.standard.Link({
      source: { id: 'pcrf' },
      target: { x: 1050, y: 670 },  // top-left corner of SMF
      vertices: [
        { x: 800, y: 670 },  // down to same y as SMF top edge
      ],
      attrs: {
        line: {
          stroke: '#22c55e',
          strokeWidth: 2,
          targetMarker: {
            type: 'path',
            d: 'M 10 -5 0 0 10 5 z',
            fill: '#22c55e',
          },
        },
      },
      labels: [{
        attrs: {
          text: {
            text: 'Gx',
            fill: '#94a3b8',
            fontSize: 18,
          },
          rect: {
            fill: '#0f172a',
            stroke: 'none',
            rx: 2,
            ry: 2,
          },
        },
        position: 0.5,
      }],
      z: 5,
    });
    gxLink.addTo(jointGraph);

    // S1-MME - Green - with interface status
    // MME to eNodeB - down to y=1100, then horizontal to eNodeB (green)
    // MME is at (300,700), go down to (300,1100), then right to eNodeB at (500,1100)
    const mmeActive = nfMap.get('mme')?.active || false;
    const s1mmeLineActive = mmeActive && s1mmeActive;
    
    const s1mmeLink = new shapes.standard.Link({
      source: { id: 'mme' },
      target: { id: 'enb' },
      vertices: [
        { x: 300, y: 1100 },  // down to same y as eNodeB
      ],
      attrs: {
        line: {
          stroke: '#22c55e',
          strokeWidth: 2,
          strokeDasharray: s1mmeLineActive ? '10,10' : '0',  // Animate if both active
          targetMarker: {
            type: 'path',
            d: 'M 10 -5 0 0 10 5 z',
            fill: '#22c55e',
          },
          class: s1mmeLineActive ? 'interface-active' : '',
        },
      },
      labels: [{
        attrs: {
          text: {
            text: 'S1-MME',
            fill: '#94a3b8',
            fontSize: 18,
          },
          rect: {
            fill: '#0f172a',
            stroke: 'none',
            rx: 2,
            ry: 2,
          },
        },
        position: 0.5,
      }],
      z: 5,
    });
    s1mmeLink.addTo(jointGraph);

    // Sxa is already correct - Green dashed - UPDATE to connect to SGW-U top-RIGHT
    // SGW-C to SGW-U - Sxa interface (green dashed)
    // From SGW-C (600,700) down to (600,900), then right to (2200,900), then down to SGW-U top-RIGHT (2240,1370)
    // SGW-U is centered at 2200,1400, so top edge is at y=1370 (1400-30)
    // Top-right connection: x=2240 (right side, offset from corner)
    const sgwcActive = nfMap.get('sgwc')?.active || false;
    const sgwuActive = nfMap.get('sgwu')?.active || false;
    const sxaActive = sgwcActive && sgwuActive;
    
    const sxaLink = new shapes.standard.Link({
      source: { id: 'sgwc' },
      target: { x: 2240, y: 1370 },  // top-RIGHT of SGW-U
      vertices: [
        { x: 600, y: 900 },   // down from SGW-C
        { x: 2240, y: 900 },  // right to x=2240 (same x as target)
      ],
      attrs: {
        line: {
          stroke: '#22c55e',  // Green
          strokeWidth: 2,
          strokeDasharray: sxaActive ? '10,10' : '5,3',  // Animate if both active, otherwise just dashed
          targetMarker: {
            type: 'path',
            d: 'M 10 -5 0 0 10 5 z',
            fill: '#22c55e',
          },
          class: sxaActive ? 'interface-active' : '',
        },
      },
      labels: [{
        attrs: {
          text: {
            text: 'Sxa',
            fill: '#94a3b8',
            fontSize: 18,
          },
          rect: {
            fill: '#0f172a',
            stroke: 'none',
            rx: 2,
            ry: 2,
          },
        },
        position: 0.5,
      }],
      z: 5,
    });
    sxaLink.addTo(jointGraph);

    // SGW-U to eNodeB - S1-U interface (YELLOW)
    // Connect to SGW-U top-LEFT (2160,1370), up to y=1000, left to x=500, then up to eNodeB
    // SGW-U is centered at 2200,1400, so top edge is at y=1370 (1400-30)
    // Top-left connection: x=2160 (left side, offset from corner)
    // Check if S1-U interface is active (from backend conntrack check)
    const s1uLineActive = sgwuActive && s1uActive;  // SGW-U NF active AND S1-U interface has connections
    
    const s1uLink = new shapes.standard.Link({
      source: { x: 2160, y: 1370 },  // top-LEFT of SGW-U
      target: { id: 'enb' },
      vertices: [
        { x: 2160, y: 1100 },  // up to y=1100
        { x: 545, y: 1100 },   // left to eNodeB right side
      ],
      attrs: {
        line: {
          stroke: '#eab308',  // YELLOW
          strokeWidth: 2,
          strokeDasharray: s1uLineActive ? '10,10' : '0',  // Animate if both active
          targetMarker: {
            type: 'path',
            d: 'M 10 -5 0 0 10 5 z',
            fill: '#eab308',  // YELLOW
          },
          class: s1uLineActive ? 'interface-active' : '',
        },
      },
      labels: [{
        attrs: {
          text: {
            text: 'S1-U',
            fill: '#94a3b8',
            fontSize: 12,
          },
          rect: {
            fill: '#0f172a',
            stroke: 'none',
            rx: 2,
            ry: 2,
          },
        },
        position: 0.5,
      }],
      z: 5,
    });
    s1uLink.addTo(jointGraph);



    // N3 interface - gNodeB to UPF (YELLOW)
    // From gNodeB right side (2445,700) straight down to UPF top-RIGHT (2440,1365)
    // gNodeB is centered at 2400,700, right side at x=2445
    // UPF top-right connection at x=2440 (offset from right edge at 2450)
    const n3Link = new shapes.standard.Link({
      source: { x: 2445, y: 700 },  // right side of gNodeB
      target: { x: 2440, y: 1365 },  // top-RIGHT of UPF (offset from right edge)
      vertices: [
        { x: 2440, y: 700 },   // move slightly left to x=2440
      ],
      attrs: {
        line: {
          stroke: '#eab308',  // YELLOW
          strokeWidth: 2,
          strokeDasharray: n3Active ? '10,10' : '0',  // Animate if N3 active
          targetMarker: {
            type: 'path',
            d: 'M 10 -5 0 0 10 5 z',
            fill: '#eab308',
          },
          class: n3Active ? 'interface-active' : '',
        },
      },
      labels: [{
        attrs: {
          text: {
            text: 'N3',
            fill: '#94a3b8',
            fontSize: 16,
          },
          rect: {
            fill: '#0f172a',
            stroke: 'none',
            rx: 2,
            ry: 2,
          },
        },
        position: 0.5,
      }],
      z: 5,
    });
    n3Link.addTo(jointGraph);

    // UPF to Internet - N6 (Sgi) interface (PURPLE) - straight horizontal
    const n6Link = new shapes.standard.Link({
      source: { id: 'upf' },
      target: { id: 'internet' },
      vertices: [
        { x: 2450, y: 1395 },  // right from UPF center
        { x: 2700, y: 1395 },  // same y level
      ],
      attrs: {
        line: {
          stroke: '#a855f7',  // PURPLE
          strokeWidth: 2,
          targetMarker: {
            type: 'path',
            d: 'M 10 -5 0 0 10 5 z',
            fill: '#a855f7',
          },
        },
      },
      labels: [{
        attrs: {
          text: {
            text: 'N6 (Sgi)',
            fill: '#94a3b8',
            fontSize: 16,
          },
          rect: {
            fill: '#0f172a',
            stroke: 'none',
            rx: 2,
            ry: 2,
          },
        },
        position: 0.5,
      }],
      z: 5,
    });
    n6Link.addTo(jointGraph);

    // SMF to UPF - TWO SEPARATE LINES (orange dashed)
    // N4u is the TOP line, N4 is BELOW it (they DON'T CROSS)
    // Increased vertical spacing between the horizontal segments
    // N4u connects to RIGHT side of UPF top, N4 connects to CENTER of UPF top (leaving LEFT side open)
    const smfActive = nfMap.get('smf')?.active || false;
    const upfActive = nfMap.get('upf')?.active || false;
    const n4Active = smfActive && upfActive;
    
    // Line 1: N4u (Sxu) - TOP line - connects to UPF TOP-CENTER - YELLOW dashed
    // From SMF bottom-RIGHT (1140,730) → down to y=800 → right to x=2400 → straight down to UPF top-CENTER (2400,1365)
    const n4uSxuLink = new shapes.standard.Link({
      source: { x: 1140, y: 730 },  // bottom-right of SMF
      target: { x: 2400, y: 1365 },  // top-CENTER of UPF (center)
      vertices: [
        { x: 1140, y: 800 },   // down to y=800 (TOP line)
        { x: 2400, y: 800 },   // right to x=2400 (center)
      ],
      attrs: {
        line: {
          stroke: '#eab308',  // YELLOW
          strokeWidth: 2,
          strokeDasharray: n4Active ? '10,10' : '5,3',  // Animate if both active
          targetMarker: {
            type: 'path',
            d: 'M 10 -5 0 0 10 5 z',
            fill: '#eab308',  // YELLOW
          },
          class: n4Active ? 'interface-active' : '',
        },
      },
      labels: [{
        attrs: {
          text: {
            text: 'N4u (Sxu)',
            fill: '#94a3b8',
            fontSize: 12,
          },
          rect: {
            fill: '#0f172a',
            stroke: 'none',
            rx: 2,
            ry: 2,
          },
        },
        position: 0.5,
      }],
      z: 5,
    });
    n4uSxuLink.addTo(jointGraph);

    // Line 2: N4 (Sxb) - BOTTOM line - connects to UPF TOP-LEFT - PINK dashed
    // From SMF bottom-LEFT (1060,730) → down to y=830 → right to x=2360 → straight down to UPF top-LEFT (2360,1365)
    const n4SxbLink = new shapes.standard.Link({
      source: { x: 1060, y: 730 },  // bottom-left of SMF
      target: { x: 2360, y: 1365 },  // top-LEFT of UPF (offset from left edge)
      vertices: [
        { x: 1060, y: 830 },   // down to y=830 (30px BELOW N4u - more spacing)
        { x: 2360, y: 830 },   // right to x=2360 (left offset)
      ],
      attrs: {
        line: {
          stroke: '#ec4899',  // PINK
          strokeWidth: 2,
          strokeDasharray: n4Active ? '10,10' : '5,3',  // Animate if both active
          targetMarker: {
            type: 'path',
            d: 'M 10 -5 0 0 10 5 z',
            fill: '#ec4899',  // PINK
          },
          class: n4Active ? 'interface-active' : '',
        },
      },
      labels: [{
        attrs: {
          text: {
            text: 'N4 (Sxb)',
            fill: '#94a3b8',
            fontSize: 12,
          },
          rect: {
            fill: '#0f172a',
            stroke: 'none',
            rx: 2,
            ry: 2,
          },
        },
        position: 0.5,
      }],
      z: 5,
    });
    n4SxbLink.addTo(jointGraph);

    // SGW-U to UPF - S5u interface (YELLOW solid) - straight horizontal line
    const s5uLink = new shapes.standard.Link({
      source: { id: 'sgwu' },
      target: { id: 'upf' },
      attrs: {
        line: {
          stroke: '#eab308',  // YELLOW
          strokeWidth: 2,
          targetMarker: {
            type: 'path',
            d: 'M 10 -5 0 0 10 5 z',
            fill: '#eab308',  // YELLOW
          },
        },
      },
      labels: [{
        attrs: {
          text: {
            text: 'S5u',
            fill: '#94a3b8',
            fontSize: 12,
          },
          rect: {
            fill: '#0f172a',
            stroke: 'none',
            rx: 2,
            ry: 2,
          },
        },
        position: 0.5,
      }],
      z: 5,
    });
    s5uLink.addTo(jointGraph);

    // N2 interface - AMF to gNodeB (pink) - horizontal line at y=700
    // From AMF's right side (1650,700) straight to gNodeB (2355,700)
    // AMF is centered at 1600,700, so right side is at x=1650 (1600+50)
    // gNodeB is centered at 2400,700, so left side is at x=2355 (2400-45)
    const n2Link = new shapes.standard.Link({
      source: { x: 1650, y: 700 },  // right side of AMF
      target: { x: 2355, y: 700 },  // left side of gNodeB
      attrs: {
        line: {
          stroke: '#ec4899',  // pink
          strokeWidth: 2.5,
          strokeDasharray: n2Active ? '10,10' : '0',  // Animate if N2 active
          targetMarker: {
            type: 'path',
            d: 'M 10 -5 0 0 10 5 z',
            fill: '#ec4899',
          },
          class: n2Active ? 'interface-active' : '',
        },
      },
      labels: [{
        attrs: {
          text: {
            text: 'N2',
            fill: '#94a3b8',
            fontSize: 16,
          },
          rect: {
            fill: '#0f172a',
            stroke: 'none',
            rx: 2,
            ry: 2,
          },
        },
        position: 0.5,
      }],
      z: 5,
    });
    n2Link.addTo(jointGraph);

    // === SBI Connections (pink vertical and horizontal lines) ===
    
    // UDM to UDR - vertical line (pink) N35
    createLink('udm', 'udr', 'N35', '#ec4899');
    
    // UDR to PCF - vertical line (pink) N36
    createLink('udr', 'pcf', 'N36', '#ec4899');
    
    // PCF to SMF - vertical line (pink) N7
    createLink('pcf', 'smf', 'N7', '#ec4899');
    
    // SMF to AMF - horizontal line (pink) N11
    createLink('smf', 'amf', 'N11', '#ec4899');
    
    // UDM to AUSF - horizontal line (pink) N13
    createLink('udm', 'ausf', 'N13', '#ec4899');
    
    // AUSF to AMF - vertical line (pink) N12
    createLink('ausf', 'amf', 'N12', '#ec4899');
    
    // PCF to AMF - diagonal line (pink) N15
    createLink('pcf', 'amf', 'N15', '#ec4899');
    
    // UDM to AMF - diagonal line (pink) N8
    createLink('udm', 'amf', 'N8', '#ec4899');



    console.log('Topology created:', jointGraph.getCells().length, 'elements');

    // Scale the entire map to fit the container on load
    if (paperRef.current) {
      paperInstanceRef.current?.scaleContentToFit({ padding: 20 });
    }
    
  }, [graph, interfaceStatus]);

  return (
    <div className="p-6 h-full flex flex-col">
      <div className="mb-4">
        <h1 className="text-2xl font-semibold font-display text-nms-text">Network Topology</h1>
        <p className="text-sm text-nms-text-dim mt-1">
          Open5GS 4G/5G CUPS Architecture
        </p>
      </div>

      <div
        ref={(el) => {
          // Attach ResizeObserver so the map re-fits when the window is resized
          if (el && paperInstanceRef.current) {
            const ro = new ResizeObserver(() => {
              paperInstanceRef.current?.scaleContentToFit({ padding: 20 });
            });
            ro.observe(el);
            (el as any)._ro = ro;
          }
        }}
        className="flex-1 rounded-lg border border-nms-border bg-[#0a0f1a]"
        style={{ maxWidth: '1450px', minHeight: 0 }}
      >
        <div ref={paperRef} />
      </div>
    </div>
  );
}
