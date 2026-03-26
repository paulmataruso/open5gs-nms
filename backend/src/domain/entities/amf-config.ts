import { BaseNfConfig, PlmnId, SbiConfig, Snssai } from './base-config';

export interface AmfTaiEntry {
  plmn_id: PlmnId;
  tac: number | number[];
}

export interface AmfPlmnEntry {
  plmn_id: PlmnId;
  s_nssai: Snssai[];
}

export interface AmfSecurityConfig {
  integrity_order?: string[];
  ciphering_order?: string[];
}

export interface AmfNetworkNameConfig {
  full?: string;
  short?: string;
}

export interface AmfGuamiEntry {
  plmn_id: PlmnId;
  amf_id: {
    region: number;
    set: number;
    pointer: number;
  };
}

export interface AmfConfig extends BaseNfConfig {
  sbi: SbiConfig;
  ngap: {
    addr: string | string[];
    port?: number;
  };
  guami: AmfGuamiEntry[];
  tai: AmfTaiEntry[];
  plmn_support: AmfPlmnEntry[];
  security?: AmfSecurityConfig;
  network_name?: AmfNetworkNameConfig;
  amf_name?: string;
  nrf?: {
    sbi: {
      addr: string | string[];
      port?: number;
    };
  };
}
