import { AmfYamlDocument } from './open5gs-yaml';
import { BaseNfConfig, SbiConfig } from './base-config';

/** The `amf:` section of a parsed amf.yaml. */
type AmfSection = NonNullable<AmfYamlDocument['amf']>;

/**
 * AMF config as the loader produces it: a few endpoints normalised out of the
 * document, and the rest taken straight from the document's own types.
 *
 * guami/tai/plmn_support/security/network_name are aliases of the document
 * types rather than hand-written interfaces (AmfGuamiEntry, AmfTaiEntry,
 * AmfPlmnEntry, AmfSecurityConfig, AmfNetworkNameConfig -- all five removed
 * 2026-11-26, none of which had a single user outside this file). They each
 * declared `plmn_id` as REQUIRED where a real file can omit it, which forced
 * loadAmf() to assert past its own declared type; nothing read these fields,
 * so the lie never surfaced at runtime.
 */
export interface AmfConfig extends BaseNfConfig<AmfYamlDocument> {
  sbi: SbiConfig;
  ngap: {
    addr: string | string[];
    port?: number;
  };
  guami: NonNullable<AmfSection['guami']>;
  tai: NonNullable<AmfSection['tai']>;
  plmn_support: NonNullable<AmfSection['plmn_support']>;
  security?: AmfSection['security'];
  network_name?: AmfSection['network_name'];
  amf_name?: string;
  nrf?: {
    sbi: {
      addr: string | string[];
      port?: number;
    };
  };
}
