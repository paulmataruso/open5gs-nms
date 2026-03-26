import { AllConfigs } from '../interfaces/config-repository';
import { TopologyGraph, TopologyNode, TopologyEdge } from '../entities/topology';
import { ServiceStatus } from '../entities/service-status';

function resolveAddr(addr: string | string[] | undefined): string {
  if (!addr) return '0.0.0.0';
  if (Array.isArray(addr)) return addr[0] || '0.0.0.0';
  return addr;
}

export class TopologyBuilder {
  build(configs: AllConfigs, statuses?: Record<string, ServiceStatus>): TopologyGraph {
    const nodes = this.buildNodes(configs, statuses);
    const edges = this.buildEdges(configs);
    return { nodes, edges };
  }

  private buildNodes(
    configs: AllConfigs,
    statuses?: Record<string, ServiceStatus>,
  ): TopologyNode[] {
    return [
      {
        id: 'nrf',
        type: 'nrf',
        label: 'NRF',
        address: resolveAddr(configs.nrf.sbi.addr),
        port: configs.nrf.sbi.port || 7777,
        active: statuses?.nrf?.active ?? false,
      },
      {
        id: 'amf',
        type: 'amf',
        label: 'AMF',
        address: resolveAddr(configs.amf.sbi.addr),
        port: configs.amf.sbi.port || 7777,
        active: statuses?.amf?.active ?? false,
      },
      {
        id: 'smf',
        type: 'smf',
        label: 'SMF',
        address: resolveAddr(configs.smf.sbi.addr),
        port: configs.smf.sbi.port || 7777,
        active: statuses?.smf?.active ?? false,
      },
      {
        id: 'upf',
        type: 'upf',
        label: 'UPF',
        address: configs.upf.pfcp.addr || '0.0.0.0',
        port: configs.upf.pfcp.port || 8805,
        active: statuses?.upf?.active ?? false,
      },
      {
        id: 'ausf',
        type: 'ausf',
        label: 'AUSF',
        address: resolveAddr(configs.ausf.sbi.addr),
        port: configs.ausf.sbi.port || 7777,
        active: statuses?.ausf?.active ?? false,
      },
    ];
  }

  private buildEdges(configs: AllConfigs): TopologyEdge[] {
    const edges: TopologyEdge[] = [];
    const nrfAddr = resolveAddr(configs.nrf.sbi.addr);
    const nrfPort = configs.nrf.sbi.port || 7777;

    const checkNrfEdge = (
      source: string,
      nrfRef: { sbi: { addr: string | string[]; port?: number } } | undefined,
    ): void => {
      const refAddr = nrfRef ? resolveAddr(nrfRef.sbi.addr) : null;
      const refPort = nrfRef?.sbi.port || 7777;
      const valid = !!nrfRef && refAddr === nrfAddr && refPort === nrfPort;

      edges.push({
        id: `${source}-nrf-sbi`,
        source,
        target: 'nrf',
        type: 'sbi',
        label: 'SBI',
        valid,
        errorMessage: valid ? undefined : `${source.toUpperCase()} NRF reference mismatch`,
      });
    };

    checkNrfEdge('amf', configs.amf.nrf);
    checkNrfEdge('smf', configs.smf.nrf);
    checkNrfEdge('ausf', configs.ausf.nrf);

    // N11: AMF <-> SMF (via NRF discovery, logical)
    edges.push({
      id: 'amf-smf-n11',
      source: 'amf',
      target: 'smf',
      type: 'n11',
      label: 'N11',
      valid: true,
    });

    // N4: SMF <-> UPF (PFCP)
    const smfPfcpAddr = configs.smf.pfcp.addr;
    const upfPfcpAddr = configs.upf.pfcp.addr;
    const pfcpValid = !!smfPfcpAddr && !!upfPfcpAddr;

    edges.push({
      id: 'smf-upf-n4',
      source: 'smf',
      target: 'upf',
      type: 'n4',
      label: 'N4 (PFCP)',
      valid: pfcpValid,
      errorMessage: pfcpValid ? undefined : 'PFCP addresses not configured',
    });

    return edges;
  }
}
