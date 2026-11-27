import { describeConfigFidelity } from '../../../__tests__/helpers/config-fidelity';
import {
  scscfIncludeCfg, icscfIncludeCfg, smscIncludeCfg, pcscfIncludeCfg,
  scscfDiameterXml, pcscfDiameterXml, icscfDiameterXml,
} from '../ims-controller';

/**
 * Fidelity specs for the IMS config generators.
 *
 * One spec per generated file. The harness derives, for every field: that
 * changing it changes the file, that the old value is gone rather than merely
 * joined by the new one, and that the new value is present. See
 * `__tests__/helpers/config-fidelity.ts` for what those checks catch and --
 * importantly -- what they cannot.
 *
 * The baselines are this deployment's real values, so a spec doubles as a
 * readable record of what the running network is configured with.
 */

const IMS = 'ims.mnc001.mcc001.3gppnetwork.org';
const EPC = 'epc.mnc001.mcc001.3gppnetwork.org';
const IMS_ALT = 'ims.mnc410.mcc310.3gppnetwork.org';
const EPC_ALT = 'epc.mnc410.mcc310.3gppnetwork.org';

// Varying mcc/mnc alone cannot use the verbatim leak check: `imsDomain` is a
// SEPARATE parameter derived from the same PLMN, so changing mcc while holding
// imsDomain fixed legitimately leaves the old digits in the domain. The PLMN is
// leak-checked properly in ims-config-plmn-substitution.test.ts, which varies
// the whole PLMN at once and matches composed tokens (`mcc001`) rather than
// bare digits. The inert check still applies and is what proves the Ro fields
// follow the parameter.
const PLMN_NOT_VERBATIM = {
  mcc: 'imsDomain is derived from the same PLMN and varied separately; see ims-config-plmn-substitution',
  mnc: 'imsDomain is derived from the same PLMN and varied separately; see ims-config-plmn-substitution',
} as const;

describeConfigFidelity({
  name: 'ims/scscf.cfg',
  generate: scscfIncludeCfg,
  baseline: {
    scscfIp: '127.0.1.2', scscfPort: 6060, imsDomain: IMS, mcc: '001', mnc: '01',
    additionalDomains: [] as string[],
    routeSmsToVectorcore: { ip: '127.0.1.5', port: 5060 },
    voiceCharging: { ocsOriginHost: `ocs.${EPC}` },
    cdrAccounting: true, sipTracing: true, blockImsSms: false,
  },
  variants: {
    scscfIp: '198.51.100.7', scscfPort: 6070, imsDomain: IMS_ALT,
    mcc: '310', mnc: '410',
    additionalDomains: ['ims.mnc093.mcc505.3gppnetwork.org'],
    routeSmsToVectorcore: { ip: '203.0.113.9', port: 5080 },
    voiceCharging: { ocsOriginHost: `ocs.${EPC_ALT}` },
    cdrAccounting: false, sipTracing: false, blockImsSms: true,
  },
  notVerbatim: {
    ...PLMN_NOT_VERBATIM,
    cdrAccounting: 'a boolean that only gates a #!define block',
    sipTracing: 'a boolean that only gates a #!define block',
    blockImsSms: 'a boolean that only gates a #!define block',
  },
});

describeConfigFidelity({
  name: 'ims/pcscf.cfg',
  generate: pcscfIncludeCfg,
  baseline: {
    pcscfIp: '10.0.1.178', pcscfPort: 5060, imsDomain: IMS, epcDomain: EPC,
    additionalDomains: [] as string[], http2N5Available: true, sipTracing: true,
  },
  variants: {
    pcscfIp: '198.51.100.7', pcscfPort: 5070, imsDomain: IMS_ALT, epcDomain: EPC_ALT,
    additionalDomains: ['ims.mnc093.mcc505.3gppnetwork.org'],
    http2N5Available: false, sipTracing: false,
  },
  notVerbatim: {
    http2N5Available: 'a boolean gating the WITH_N5 define; see the Kamailio 6.0 gate',
    sipTracing: 'a boolean that only gates a #!define block',
  },
});

describeConfigFidelity({
  name: 'ims/icscf.cfg',
  generate: icscfIncludeCfg,
  baseline: {
    icscfIp: '127.0.1.1', icscfPort: 4060, imsDomain: IMS,
    additionalDomains: [] as string[], sipTracing: true,
  },
  variants: {
    icscfIp: '198.51.100.7', icscfPort: 4070, imsDomain: IMS_ALT,
    additionalDomains: ['ims.mnc093.mcc505.3gppnetwork.org'], sipTracing: false,
  },
  notVerbatim: { sipTracing: 'a boolean that only gates a #!define block' },
});

describeConfigFidelity({
  name: 'ims/smsc.cfg',
  generate: smscIncludeCfg,
  baseline: { smscIp: '10.0.1.178', imsDomain: IMS },
  variants: { smscIp: '198.51.100.7', imsDomain: IMS_ALT },
});

describeConfigFidelity({
  name: 'ims/scscf.xml',
  generate: scscfDiameterXml,
  baseline: { scscfIp: '127.0.1.2', imsDomain: IMS, ocsPeer: { fqdn: `ocs.${EPC}`, port: 3868 } },
  variants: {
    scscfIp: '198.51.100.7', imsDomain: IMS_ALT,
    ocsPeer: { fqdn: `ocs.${EPC_ALT}`, port: 3870 },
  },
});

describeConfigFidelity({
  name: 'ims/pcscf.xml',
  generate: pcscfDiameterXml,
  baseline: { pcscfIp: '10.0.1.178', imsDomain: IMS, pcrfFqdn: `pcrf.${EPC}`, pcrfPort: 3868 },
  variants: {
    pcscfIp: '198.51.100.7', imsDomain: IMS_ALT,
    pcrfFqdn: `pcrf.${EPC_ALT}`, pcrfPort: 3870,
  },
});

describeConfigFidelity({
  name: 'ims/icscf.xml',
  generate: icscfDiameterXml,
  baseline: { icscfIp: '127.0.1.1', imsDomain: IMS },
  variants: { icscfIp: '198.51.100.7', imsDomain: IMS_ALT },
});
