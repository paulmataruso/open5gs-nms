import { BaseNfConfig, SbiConfig } from './base-config';

export interface SeppN32Endpoint {
  scheme?: 'http' | 'https';
  address?: string;
  port?: number;
}

export interface SeppN32Peer {
  receiver: string;
  uri: string;
  resolve?: string;
  n32f: {
    uri: string;
    resolve?: string;
  };
}

export interface SeppN32Config {
  server: {
    sender: string;
    scheme?: 'http' | 'https';
    address?: string;
    port?: number;
    n32f?: SeppN32Endpoint;
  };
  client: {
    sepp: SeppN32Peer[];
  };
}

export interface SeppTlsConfig {
  server?: {
    private_key?: string;
    cert?: string;
    verify_client?: boolean;
    verify_client_cacert?: string;
  };
  client?: {
    cacert?: string;
    client_private_key?: string;
    client_cert?: string;
  };
}

export interface SeppConfig extends BaseNfConfig {
  sbi: SbiConfig;
  n32: SeppN32Config;
  tls?: SeppTlsConfig;
}
