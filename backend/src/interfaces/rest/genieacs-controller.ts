import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import pino from 'pino';
import { IAuditLogger } from '../../domain/interfaces/audit-logger';
import { requireAdmin } from './middleware/auth-middleware';
import { radioBackupDir, backupDeviceById } from './radio-backup';
import { parseMccMncFromMmeYaml, isPlmnMismatch } from '../../domain/services/read-plmn';

const HOST_MME_YAML = '/proc/1/root/etc/open5gs/mme.yaml';

// Single source of truth for "what PLMN is the core actually running" — same
// mme.yaml this project already treats as authoritative everywhere else (see
// plmn-migration-usecase.ts). Read fresh on every /devices call rather than
// cached, since an operator could run the PLMN Migration Wizard at any time.
function readCoreMccMnc(): { mcc: string; mnc: string } {
  try {
    return parseMccMncFromMmeYaml(fs.readFileSync(HOST_MME_YAML, 'utf-8'));
  } catch {
    return { mcc: '001', mnc: '01' };
  }
}

// ─── Bandwidth MHz → LTE resource blocks ────────────────────────────────────
// BaiBLQ_3.x expects integer resource blocks as xsd:int
const BW_MHZ_TO_RB: Record<number, number> = { 5: 25, 10: 50, 15: 75, 20: 100 };
const RB_TO_MHZ: Record<string, string>    = { '25': '5', '50': '10', '75': '15', '100': '20' };

// ─── FAPService base path ────────────────────────────────────────────────────
const FAP = 'Device.Services.FAPService.1.';

// ─── Types ───────────────────────────────────────────────────────────────────
interface BaicellsProvisionInput {
  mcc: string; mnc: string; tac: number; mmeIp: string;
  bandwidthMhz: number; earfcn: number; cellId: number; pci: number; band: number;
  txPower: number;
  // SAS
  sasEnableMode: string;
  sasServerUrl: string;
  sasUserId: string;
  sasFccId: string;
  sasCallSign: string;
  sasGroupType: string;
  sasGroupId: string;
  sasLegacyMode: boolean;
  sasRegistrationType: string;
  sasReqLowFrequency: string;
  sasReqHighFrequency: string;
  sasPreferredFrequency: string;
  sasPreferredBandwidth: string;
  sasPreferredPower: string;
  sasFrequencySelectionLogic: string;
  sasMaxEIRP: string;
  sasEirpCapability: string;
}

export interface NbiTask {
  url:  string;
  body: Record<string, any>;
}

// ─── LTE Freq/Cell neighbor tables ────────────────────────────────────────────
// Field mappings confirmed live against a real Baicells radio (2026-08-16) —
// see backend git history / PROJECT_STATE.md for the investigation. Each map
// is UI-property → TR-069 leaf name under its own base path; used symmetrically
// for both reading (toRadio()) and writing (the /neighbor-tables endpoint), so
// there is exactly one place that knows these names.
const NEIGHBOR_FREQ_BASE = (n: number) => `${FAP}CellConfig.LTE.RAN.Mobility.IdleMode.InterFreq.Carrier.${n}.`;
const NEIGHBOR_FREQ_FIELD_MAP: Record<string, string> = {
  earfcn:                 'EUTRACarrierARFCN',
  qRxLevMin:               'QRxLevMinSIB5',
  qOffsetRange:            'QOffsetFreq',
  reselectionTimer:        'TReselectionEUTRA',
  reselectionPrior:        'CellReselectionPriority',
  reselectionThreshHigh:   'ThreshXHigh',
  reselectionThreshLow:    'ThreshXLow',
  pMax:                    'PMax',
};

const NEIGHBOR_CELL_BASE = (n: number) => `${FAP}CellConfig.LTE.RAN.NeighborList.LTECell.${n}.`;
const NEIGHBOR_CELL_FIELD_MAP: Record<string, string> = {
  plmn:    'PLMNID',
  cellId:  'CID',
  earfcn:  'EUTRACarrierARFCN',
  pci:     'PhyCellID',
  qOffset: 'QOffset',
  cio:     'CIO',
  tac:     'X_COM_TAC',
  enbType: 'NeighCellEnbType',
  x2Flag:  'X2Status',
};

interface NeighborFreqEntry {
  index: number; // 1-8, which Carrier.{n} instance this row is bound to
  earfcn: string;
  qRxLevMin: string;
  qOffsetRange: string;
  reselectionTimer: string;
  reselectionPrior: string;
  reselectionThreshHigh: string;
  reselectionThreshLow: string;
  pMax: string;
}

interface NeighborCellEntry {
  index: number; // 1-8, which LTECell.{n} instance this row is bound to
  plmn: string;
  cellId: string;
  earfcn: string;
  pci: string;
  qOffset: string;
  cio: string;
  tac: string;
  enbType: string;
  x2Flag: string;
}

// ─── Sercomm types & param builder ──────────────────────────────────────────────────────────
const SFAP = 'Device.Services.FAPService.1.';

interface SercommProvisionInput {
  mcc: string; mnc: string; tac: string;
  mmeIp: string; mmeCfgIdList: string;
  earfcn: string;
  earfcn2: string;
  pci: string;
  cellIdentity: string;
  cellIdentity2: string;
  txPower: string;
  bandwidth: string;
  freqBand: string;
  syncSource: string;
  carrierNumber: string;
  caEnable: boolean;
  contiguousCC: boolean;
  sasEnable: boolean;
  sasMethod: string;            // '0'=Direct SAS, '1'=Domain Proxy
  sasManufacturerPrefix: boolean;
  sasInstallMethod: string;     // '0'=Single-Step, '1'=Multi-Step
  sasCpiEnable: boolean;
  sasCategory: string;          // 'A' or 'B'
  sasChannelType: string;       // 'GAA' or 'PAL'
  sasLocation: string;
  sasLocationSource: string;    // '0'=Manual, '1'=GPS
  sasHeightType: string;        // 'AGL' or 'AMSL'
  sasUserId: string;
  sasIcgGroupId: string;
  sasPeerCertVerify: boolean;
  sasGrantMethod: string;        // 'FREQ_GRANT_BY_CARRIER' | 'FREQ_GRANT_BY_BLOCKS'
  latitude: string;
  longitude: string;
  enable256QAM: boolean;
}

function buildSercommTasks(taskUrl: string, input: SercommProvisionInput, sasServerUrl?: string): NbiTask[] {
  // All tasks use connection_request so GenieACS delivers them reliably.
  // The radio informs every 5s so extra connection_request attempts are harmless.
  // Using queueUrl (no connection_request) caused Tasks 2+3 to silently not deliver.
  const plmn = `${input.mcc}${input.mnc}`;
  // Magma: calc_bandwidth_rbs = str(int(5 * bandwidth_mhz)) → '100' as xsd:string
  const bwRbs = String(parseInt(input.bandwidth) * 5);
  // Boolean helpers
  const bool  = (v: boolean) => v ? '1'    : '0';     // xsd:boolean as int (most params)
  const boolT = (v: boolean) => v ? 'True' : 'False'; // xsd:boolean as True/False (SAS params)

  const params: Array<[string, string, string]> = [
    // ── Management server (configuration_init._set_management_server) ────────────
    // PERIODIC_INFORM_ENABLE → xsd:boolean → '1'
    ['Device.ManagementServer.PeriodicInformEnable',                              '1',          'xsd:boolean'     ],
    // PERIODIC_INFORM_INTERVAL → xsd:int → '5'
    ['Device.ManagementServer.PeriodicInformInterval',                            '5',          'xsd:int'         ],

    // ── Misc static params (configuration_init._set_misc_static_params) ──────────
    // GPS_ENABLE = Device.FAP.GPS.ScanOnBoot → xsd:boolean → '1'
    ['Device.FAP.GPS.ScanOnBoot',                                                 '1',          'xsd:boolean'     ],

    // ── Performance management (configuration_init._set_perf_mgmt) ────────────
    // PERF_MGMT_ENABLE → xsd:boolean → '1'
    ['Device.FAP.PerfMgmt.Config.1.Enable',                                       '1',          'xsd:boolean'     ],
    // PERF_MGMT_UPLOAD_INTERVAL → xsd:int → 300 (Magma uses 300, not 60)
    ['Device.FAP.PerfMgmt.Config.1.PeriodicUploadInterval',                       '300',        'xsd:int'         ],
    // PERF_MGMT_UPLOAD_URL → xsd:string (can be blank for our use case)
    ['Device.FAP.PerfMgmt.Config.1.URL',                                          '',           'xsd:string'      ],

    // ── Core network (configuration_init._set_plmnids_tac) ──────────────────
    // TAC → xsd:int
    [`${SFAP}CellConfig.LTE.EPC.TAC`,                                             input.tac,    'xsd:int'         ],
    // X_000E8F_TAC2 → xsd:int (Sercomm dual carrier TAC)
    [`${SFAP}CellConfig.LTE.EPC.X_000E8F_TAC2`,                                  input.tac,    'xsd:int'         ],
    // PLMN_N_PLMNID → xsd:string
    [`${SFAP}CellConfig.LTE.EPC.PLMNList.1.PLMNID`,                              plmn,         'xsd:string'      ],
    // PLMN_N_ENABLE → xsd:boolean → '1'
    [`${SFAP}CellConfig.LTE.EPC.PLMNList.1.Enable`,                              '1',          'xsd:boolean'     ],
    // PLMN_N_PRIMARY → xsd:boolean → '1'
    [`${SFAP}CellConfig.LTE.EPC.PLMNList.1.IsPrimary`,                           '1',          'xsd:boolean'     ],
    // PLMN_N_CELL_RESERVED: postprocessor sets to True to workaround Sercomm firmware bug
    // xsd:boolean → '1'
    [`${SFAP}CellConfig.LTE.EPC.PLMNList.1.CellReservedForOperatorUse`,          '1',          'xsd:boolean'     ],
    // Extra Sercomm vendor params not in Magma but confirmed from live device
    [`${SFAP}CellConfig.LTE.EPC.PLMNList.1.Alias`,                               'Primary PLMNID', 'xsd:string'  ],
    [`${SFAP}CellConfig.LTE.EPC.PLMNList.1.X_000E8F_CFG_MMEIdList`,             input.mmeCfgIdList || '{1}', 'xsd:string'],
    [`${SFAP}CellConfig.LTE.EPC.PLMNList.1.X_000E8F_PLMNID_Priority`,           '6',          'xsd:unsignedInt' ],
    [`${SFAP}CellConfig.LTE.EPC.PLMNList.1.X_000E8F_Selected_MME_ByPriority`,   '1',          'xsd:boolean'     ],

    // ── Gateway / S1 (configuration_init._set_s1_connection) ────────────────
    // MME_IP → xsd:string
    [`${SFAP}FAPControl.LTE.Gateway.S1SigLinkServerList`,                        input.mmeIp,  'xsd:string'      ],
    // MME_PORT = DEFAULT_S1_PORT = 36412 → xsd:int
    [`${SFAP}FAPControl.LTE.Gateway.S1SigLinkPort`,                              '36412',      'xsd:int'         ],
    // Extra Sercomm vendor params confirmed from live device
    [`${SFAP}FAPControl.LTE.Gateway.S1ConnectionMode`,                           'One',        'xsd:string'      ],
    [`${SFAP}FAPControl.LTE.Gateway.X_000E8F_eNodeBS1SigLinkPort`,              '36412',      'xsd:unsignedInt' ],

    // ── RF / Carrier (configuration_init._set_earfcn_freq_band_mode) ─────────
    // NOTE: For TDD mode Magma does NOT set EARFCNUL ('Not setting EARFCNUL - duplex mode is not FDD')
    // We set it anyway for the second carrier since Sercomm is dual carrier
    // EARFCNDL → xsd:int
    [`${SFAP}CellConfig.LTE.RAN.RF.EARFCNDL`,                                    input.earfcn, 'xsd:int'         ],
    // EARFCNUL: NOT set by Magma for TDD, but set here for dual carrier
    [`${SFAP}CellConfig.LTE.RAN.RF.EARFCNUL`,                                    input.earfcn, 'xsd:int'         ],
    // Carrier 2 EARFCNs — always push to prevent factory leftovers (e.g. 55546) from
    // causing RF mismatch. In CA mode set to earfcn2; in single-carrier mode mirror
    // the primary so the RF layer doesn't try to bring up a ghost second carrier.
    [`${SFAP}CellConfig.LTE.RAN.RF.X_000E8F_EARFCNDL2`,  input.earfcn2 || input.earfcn, 'xsd:int'],
    [`${SFAP}CellConfig.LTE.RAN.RF.X_000E8F_EARFCNUL2`,  input.earfcn2 || input.earfcn, 'xsd:int'],
    // EARFCNDLConfigList / EARFCNULConfigList: comma-separated list matching EarfcnList
    // Must match EARFCNDL,EARFCNDL2 exactly or radio rejects the CA config
    [`${SFAP}CellConfig.LTE.RAN.RF.X_000E8F_EARFCNDLConfigList`,                input.earfcn2 ? `${input.earfcn},${input.earfcn2}` : input.earfcn, 'xsd:string'],
    [`${SFAP}CellConfig.LTE.RAN.RF.X_000E8F_EARFCNULConfigList`,                input.earfcn2 ? `${input.earfcn},${input.earfcn2}` : input.earfcn, 'xsd:string'],

    // ── Bandwidth (configuration_init._set_bandwidth) ───────────────────────
    // DL/UL_BANDWIDTH: TrParameterType.STRING → xsd:string
    // Magma: calc_bandwidth_rbs(20) = str(int(5*20)) = '100'
    [`${SFAP}CellConfig.LTE.RAN.RF.DLBandwidth`,                                 bwRbs,        'xsd:string'      ],
    [`${SFAP}CellConfig.LTE.RAN.RF.ULBandwidth`,                                 bwRbs,        'xsd:string'      ],
    // Carrier 2 bandwidths — only push in CA mode
    ...(input.earfcn2 ? [
      [`${SFAP}CellConfig.LTE.RAN.RF.X_000E8F_DLBandwidth2`, bwRbs, 'xsd:string'] as [string,string,string],
      [`${SFAP}CellConfig.LTE.RAN.RF.X_000E8F_ULBandwidth2`, bwRbs, 'xsd:string'] as [string,string,string],
    ] : []),

    // PCI → xsd:string (comma-separated '361,362')
    [`${SFAP}CellConfig.LTE.RAN.RF.PhyCellID`,                                   input.pci,    'xsd:string'      ],
    // BAND → xsd:unsignedInt (NOTE: postprocessor deletes BAND in DP mode, but sets it in non-DP)
    [`${SFAP}CellConfig.LTE.RAN.RF.FreqBandIndicator`,                           input.freqBand.split(',')[0] || '48', 'xsd:unsignedInt'],
    // FreqBandIndicator2 — only push in CA mode
    ...(input.earfcn2 ? [
      [`${SFAP}CellConfig.LTE.RAN.RF.X_000E8F_FreqBandIndicator2`, input.freqBand.split(',')[1] || input.freqBand.split(',')[0] || '48', 'xsd:unsignedInt'] as [string,string,string],
    ] : []),
    // TX power (Sercomm vendor extension) → xsd:string
    // NOTE: Radio accepts a single value '13' even for CA — NOT comma-separated
    [`${SFAP}CellConfig.LTE.RAN.RF.X_000E8F_TxPowerConfig`,                     input.txPower.split(',')[0],'xsd:string'],
    // CELL_ID → xsd:unsignedInt (DEFAULT_CELL_IDENTITY = 138777000)
    [`${SFAP}CellConfig.LTE.RAN.Common.CellIdentity`,                            input.cellIdentity,  'xsd:unsignedInt'],
  ];

  // CA_CELL_ID = cell_id + 1 → xsd:unsignedInt (Sercomm vendor extension)
  // Only push if we have a valid value to avoid 9002 internal error
  if (input.cellIdentity2) {
    params.push([`${SFAP}CellConfig.LTE.RAN.Common.X_000E8F_CellIdentity2`, input.cellIdentity2, 'xsd:unsignedInt']);
  }

  params.push(
    [`${SFAP}CellConfig.LTE.RAN.PHY.TDDFrame.SubFrameAssignment`,                '2',          'xsd:boolean'     ],
    // SPECIAL_SUBFRAME_PATTERN: TrParameterType.INT → xsd:int
    [`${SFAP}CellConfig.LTE.RAN.PHY.TDDFrame.SpecialSubframePatterns`,           '7',          'xsd:int'         ],
    // 256QAM downlink modulation (PDSCH)
    [`${SFAP}CellConfig.LTE.RAN.PHY.PDSCH.X_000E8F_Enable256QAM`,               bool(input.enable256QAM), 'xsd:boolean'],

    // ── Misc (FreedomFiOneMiscParameters) ────────────────────────────────
    // WEB_UI_ENABLE: default=False → xsd:boolean → '0'
    // (We set True since we need WebUI for management)
    ['Device.X_000E8F_DeviceFeature.X_000E8F_WebServerEnable',                   '1',          'xsd:boolean'     ],
    // CONTIGUOUS_CC: default=0 → xsd:int
    [`${SFAP}FAPControl.LTE.X_000E8F_RRMConfig.X_000E8F_CELL_Freq_Contiguous`,  input.contiguousCC ? '1' : '0',    'xsd:int'    ],
    // TUNNEL_REF: hardcoded to IPv4 → xsd:string
    [`${SFAP}CellConfig.LTE.Tunnel.1.TunnelRef`,                                 'Device.IP.Interface.1.IPv4Address.1.', 'xsd:string'],
    // PRIM_SOURCE → xsd:string
    [`${SFAP}REM.X_000E8F_tfcsManagerConfig.primSrc`,                            input.syncSource,                 'xsd:string' ],
    // Extra sync params
    [`${SFAP}REM.X_000E8F_tfcsManagerConfig.srcSwitchFreeRunning`,               '1',                              'xsd:boolean'],
    // ntpSyncEnable MUST be False — NTP timeout eats into the eNodeB 120s watchdog window
    // causing a crash loop before SAS can grant. FREE_RUNNING sync is stable.
    [`${SFAP}REM.X_000E8F_tfcsManagerConfig.ntpSyncEnable`,                      '0',                              'xsd:boolean'],

    // ── CA (CarrierAggregationParameters) ─────────────────────────────────
    // NOTE: CA_Enable and Cell_Number are intentionally NOT set here.
    // They are sent in postRebootParams (Task 2) after the self-reboot
    // so they are committed to flash correctly.

    // ── SAS ExtendFreqA (CA mode — auto-select channel and bandwidth per carrier) ─
    // Must always be True for the radio to work correctly, regardless of CA setting
    [`${SFAP}FAPControl.LTE.X_000E8F_SAS.ExtendFreqA.Enable`,                  'True',                            'xsd:boolean'],
    [`${SFAP}FAPControl.LTE.X_000E8F_SAS.ExtendFreqA.AutoSelectChannelAndBandwidth`, 'True',                       'xsd:boolean'],
    [`${SFAP}FAPControl.LTE.X_000E8F_SAS.ExtendFreqA.GrantMethod`,             input.sasGrantMethod || 'FREQ_GRANT_BY_CARRIER', 'xsd:string'],

    // ── SAS (SASParameters) ─────────────────────────────────────────────
    // SAS_ENABLE → xsd:boolean (Sercomm uses True/False not 1/0)
    [`${SFAP}FAPControl.LTE.X_000E8F_SAS.Enable`,                               boolT(input.sasEnable),                            'xsd:boolean'],
    // SAS_METHOD: 0=Direct SAS, 1=Domain Proxy → xsd:int NOT xsd:boolean
    [`${SFAP}FAPControl.LTE.X_000E8F_SAS.Method`,                               input.sasMethod,                                   'xsd:int'    ],
    // SAS_SERVER_URL — HTTPS on port 8443 for Sercomm radios
    [`${SFAP}FAPControl.LTE.X_000E8F_SAS.Server`,                               sasServerUrl || '',                                'xsd:string' ],
    // SAS_PEER_CERT_VERIFY — configurable, default disabled for self-signed certs
    [`${SFAP}FAPControl.LTE.X_000E8F_SAS.PeerCertVerifyEnable`,                 boolT(input.sasPeerCertVerify),                    'xsd:boolean'],
    // SAS_USER_ID → xsd:string (UserContactInformation)
    [`${SFAP}FAPControl.LTE.X_000E8F_SAS.UserContactInformation`,               input.sasUserId || '',                             'xsd:string' ],
    [`${SFAP}FAPControl.LTE.X_000E8F_SAS.ICGGroupId`,                           input.sasIcgGroupId || '',                         'xsd:string' ],
    // SAS_FCC_ID → xsd:string
    [`${SFAP}FAPControl.LTE.X_000E8F_SAS.FCCIdentificationNumber`,              'P27-SCE4255W',                                    'xsd:string' ],
    // SAS_CATEGORY: A or B
    [`${SFAP}FAPControl.LTE.X_000E8F_SAS.Category`,                             input.sasCategory,                                 'xsd:string' ],
    // SAS_CHANNEL_TYPE (ProtectionLevel): GAA or PAL
    [`${SFAP}FAPControl.LTE.X_000E8F_SAS.ProtectionLevel`,                      input.sasChannelType,                              'xsd:string' ],
    // SAS_CERT_SUBJECT → xsd:string
    [`${SFAP}FAPControl.LTE.X_000E8F_SAS.CertSubject`,                          '/C=TW/O=Sercomm/OU=WInnForum CBSD Certificate/CN=P27-SCE4255W:%s', 'xsd:string'],
    // SAS_LOCATION: indoor or outdoor
    [`${SFAP}FAPControl.LTE.X_000E8F_SAS.Location`,                             input.sasLocation,                                 'xsd:string' ],
    // SAS_MANUFACTURER_PREFIX_ENABLE → prepends 'Sercomm-' to serial
    [`${SFAP}FAPControl.LTE.X_000E8F_SAS.ManufacturerPrefixEnable`,             boolT(input.sasManufacturerPrefix),                'xsd:boolean'],
    // SAS_USER_ID_SELECT_METHOD: 0=Manual server URL
    [`${SFAP}FAPControl.LTE.X_000E8F_SAS.UserIDSelectMethod`,                   '0',                                               'xsd:int'    ],
    // SAS_EARFCN_LIST: comma-separated EARFCNs the radio will request grants for
    // This is what drives the SAS frequency request — NOT EARFCNDL
    // Format: 'earfcn1,earfcn2' for CA, 'earfcn1' for single carrier
    // Must be set or Sercomm falls back to a default (often 3690-3700 MHz)
    [`${SFAP}FAPControl.LTE.X_000E8F_SAS.EarfcnList`,                           input.earfcn2 ? `${input.earfcn},${input.earfcn2}` : input.earfcn, 'xsd:string'],
    // SAS_EARFCN_SELECT_METHOD: 1=SAS picks from EarfcnList
    [`${SFAP}FAPControl.LTE.X_000E8F_SAS.EarfcnSelectMethod`,                   '1',                                               'xsd:int'    ],
    // SAS_HEIGHT_TYPE: AGL or AMSL
    [`${SFAP}FAPControl.LTE.X_000E8F_SAS.HeightType`,                           input.sasHeightType,                               'xsd:string' ],
    // SAS_HIGH_ACCURACY_LAT/LONG: microdegrees as xsd:string
    [`${SFAP}FAPControl.LTE.X_000E8F_SAS.HighAccuracyLatitude`,                 input.latitude,                                    'xsd:string' ],
    [`${SFAP}FAPControl.LTE.X_000E8F_SAS.HighAccuracyLongitude`,                input.longitude,                                   'xsd:string' ],
    // SAS_LOCATION_SOURCE: 0=Manual, 1=GPS (HighAccuracyLocationEnable)
    [`${SFAP}FAPControl.LTE.X_000E8F_SAS.HighAccuracyLocationEnable`,           'True',                                            'xsd:boolean'],
    // CPI = Certified Professional Installer (required for Cat B outdoor, not Cat A indoor)
    [`${SFAP}FAPControl.LTE.X_000E8F_SAS.CPIEnable`,                            boolT(input.sasCpiEnable),                         'xsd:boolean'],
    // Single-Step vs Multi-Step: false=Single-Step (REG-Conditional in request), true=Multi-Step (pre-loaded in SAS)
    [`${SFAP}FAPControl.LTE.X_000E8F_SAS.CPIInstallParamSuppliedEnable`,        boolT(input.sasInstallMethod === '1'),             'xsd:boolean'],
    // SAS_ANTENNA_GAIN → xsd:int (is_invasive=True in Magma)
    [`${SFAP}FAPControl.LTE.X_000E8F_SAS.AntennaGain`,                          '5',                               'xsd:int'    ],
    // SAS_MAX_EIRP (Carrier 1 & 2) → xsd:int (set by SAS/DP in Magma, we use max -137 = unset)
    [`${SFAP}FAPControl.LTE.X_000E8F_SAS.MaxEirpMHz_Carrier1`,                  '-137',                            'xsd:int'    ],
    [`${SFAP}FAPControl.LTE.X_000E8F_SAS.MaxEirpMHz_Carrier2`,                  '-137',                            'xsd:int'    ],

    // ── Location ────────────────────────────────────────────────────────────
    // FAP.GPS.LockedLatitude/Longitude ARE writable on DG3934v3 firmware.
    // Must be non-zero or SAS client refuses to start (GPS-not-locked guard in firmware).
    // ScanOnBoot=false prevents the GPS scan from blocking LTE cell startup on radios
    // that have no antenna/view of sky — SAS uses HighAccuracyLatitude/Longitude instead.
    ['Device.FAP.GPS.LockedLatitude',                                             input.latitude,                    'xsd:int'    ],
    ['Device.FAP.GPS.LockedLongitude',                                            input.longitude,                   'xsd:int'    ],
    ['Device.FAP.GPS.ScanOnBoot',                                                 'false',                           'xsd:boolean'],
    ['Device.FAP.Location.X_000E8F_LocationInfoSourceSavedFile_Enable',          '1',                               'xsd:boolean'],
    ['Device.FAP.GPS.X_000E8F_Elevation',                                        '0',                               'xsd:int'    ],

  );

  // Params that must survive the invasive self-reboot — sent AFTER reboot
  const postRebootParams: Array<[string, string, string]> = [
    [`${SFAP}FAPControl.LTE.X_000E8F_RRMConfig.X_000E8F_CA_Enable`,   boolT(input.caEnable),   'xsd:boolean'],
    [`${SFAP}FAPControl.LTE.X_000E8F_RRMConfig.X_000E8F_Cell_Number`, input.carrierNumber,     'xsd:int'    ],
    [`${SFAP}FAPControl.LTE.AdminState`,                               '1',                     'xsd:boolean'],
  ];

  return [
    // Task 1 — all params
    { url: taskUrl, body: { name: 'setParameterValues', parameterValues: params } },
    // Task 2 — CA + AdminState, fires after self-reboot on first connection_request response
    { url: taskUrl, body: { name: 'setParameterValues', parameterValues: postRebootParams } },
    // Task 3 — force GenieACS to re-walk RRMConfig so cache reflects new CA_Enable value
    { url: taskUrl, body: { name: 'refreshObject', objectName: `${SFAP}FAPControl.LTE.X_000E8F_RRMConfig` } },
  ];
}

// ─── Build the three NBI tasks for a full provision ──────────────────────────
export function buildProvisionTasks(nbiUrl: string, encodedId: string, input: BaicellsProvisionInput): NbiTask[] {
  const plmn    = `${input.mcc}${input.mnc}`;
  const rb      = BW_MHZ_TO_RB[input.bandwidthMhz] ?? 100;
  const taskUrl = `${nbiUrl}/devices/${encodedId}/tasks?timeout=30000&connection_request`;

  const params: Array<[string, string, string]> = [
    // ── User-supplied ────────────────────────────────────────────────────────
    [`${FAP}CellConfig.LTE.EPC.TAC`,                                        String(input.tac),         'xsd:unsignedInt'],
    [`${FAP}CellConfig.LTE.EPC.PLMNList.1.PLMNID`,                          plmn,                      'xsd:string'     ],
    [`${FAP}FAPControl.LTE.Gateway.MmeIpPlmnList`,                          `${input.mmeIp}+${plmn}`,  'xsd:string'     ],
    [`${FAP}FAPControl.LTE.Gateway.S1SigLinkServerList`,                    input.mmeIp,               'xsd:string'     ],
    [`${FAP}FAPControl.LTE.Gateway.ExistPlmnidList`,                        plmn,                      'xsd:string'     ],
    // In SAS mode 2, EARFCN is assigned by the SAS grant — radio rejects TR-069 writes
    // to EARFCNDL/EARFCNUL when SAS is active, so skip them entirely in that mode.
    ...(input.sasEnableMode !== '2' ? [
      [`${FAP}CellConfig.LTE.RAN.RF.EARFCNDL`, String(input.earfcn), 'xsd:int'] as [string, string, string],
      [`${FAP}CellConfig.LTE.RAN.RF.EARFCNUL`, String(input.earfcn), 'xsd:int'] as [string, string, string],
    ] : []),
    [`${FAP}CellConfig.LTE.RAN.RF.DLBandwidth`,                             String(rb),                'xsd:int'        ],
    [`${FAP}CellConfig.LTE.RAN.RF.ULBandwidth`,                             String(rb),                'xsd:int'        ],
    [`${FAP}CellConfig.LTE.RAN.RF.PhyCellID`,                               String(input.pci),         'xsd:string'     ],
    [`${FAP}CellConfig.LTE.RAN.RF.FreqBandIndicator`,                       String(input.band),        'xsd:unsignedInt'],
    [`${FAP}CellConfig.LTE.RAN.Common.CellIdentity`,                        String(input.cellId),      'xsd:unsignedInt'],
    [`${FAP}Capabilities.MaxTxPower`,                                       String(input.txPower),     'xsd:unsignedInt'],
    // ── Hardcoded — required for radio to come up correctly ──────────────────
    // AdminState: BaiBLQ_3.x expects xsd:boolean true/false (maps to 0/1 internally)
    [`${FAP}FAPControl.LTE.AdminState`,                                     'true',  'xsd:boolean'     ],
    [`${FAP}FAPControl.LTE.Gateway.S1SigLinkPort`,                          '36412', 'xsd:unsignedInt' ],
    [`${FAP}FAPControl.LTE.Gateway.S1ConnectionMode`,                       'All',   'xsd:string'      ],
    [`${FAP}FAPControl.X_RADISYS_COM_AUTO_START_ENABLE`,                    '1',     'xsd:unsignedInt' ],
    [`${FAP}CellConfig.LTE.EPC.PLMNList.1.Enable`,                          'true',  'xsd:boolean'     ],
    [`${FAP}CellConfig.LTE.EPC.PLMNList.1.IsPrimary`,                       'true',  'xsd:boolean'     ],
    [`${FAP}CellConfig.LTE.EPC.PLMNList.1.CellReservedForOperatorUse`,      'true',  'xsd:boolean'     ],
    [`${FAP}CellConfig.LTE.RAN.CellRestriction.CellBarred`,                 'true',  'xsd:boolean'     ],
    [`${FAP}CellConfig.LTE.RAN.CellRestriction.CellReservedForOperatorUse`, 'true',  'xsd:boolean'     ],
    [`${FAP}CellConfig.LTE.RAN.PHY.TDDFrame.SubFrameAssignment`,            '2',     'xsd:unsignedInt' ],
    [`${FAP}CellConfig.LTE.RAN.PHY.TDDFrame.SpecialSubframePatterns`,       '5',     'xsd:unsignedInt' ],
    [`${FAP}X_COM.LTE.startPci`,                                            '0',     'xsd:unsignedInt' ],
    [`${FAP}X_COM.LTE.SelfConfig.EARFCNEnable`,                             'false', 'xsd:boolean'     ],
    [`${FAP}X_COM.LTE.SelfConfig.PhyCellIdEnable`,                          'false', 'xsd:boolean'     ],
    // ── REM scan — disable on boot ─────────────────────────────────────────
    // The radio scans Band 7 (2600 MHz) by default on boot. In SAS mode 2 the OAM
    // state machine requires remScanDone=1 before it will allow SAS_RADIO_ENABLE
    // to stick. Since Band 7 is never found in CBRS deployments the scan stays
    // Indeterminate forever, remScanDone never becomes 1, and SAS_RADIO_ENABLE
    // gets reset to 0 every time. Disabling REM scan on boot fixes this.
    [`${FAP}REM.LTE.InServiceHandling`,                                     'Disabled', 'xsd:string'  ],
    ['Device.DeviceInfo.X_COM_GpsSyncEnable',                               'true',  'xsd:boolean'     ],
    ['Device.ManagementServer.PeriodicInformEnable',                        'true',  'xsd:boolean'     ],
    ['Device.ManagementServer.PeriodicInformInterval',                      '3600',  'xsd:unsignedInt' ],
    // ── SAS (Device.DeviceInfo.SAS.*) ──────────────────────────────────────────
    ['Device.DeviceInfo.SAS.enableMode',              input.sasEnableMode,                              'xsd:unsignedInt'],
    ['Device.DeviceInfo.SAS.RadioEnable',             input.sasEnableMode !== '0' ? 'true' : 'false',   'xsd:boolean'  ],
    ['Device.DeviceInfo.SAS.ServerUrl',               input.sasServerUrl,                               'xsd:string'   ],
    ['Device.DeviceInfo.SAS.UserId',                  input.sasUserId,                                  'xsd:string'   ],
    ['Device.DeviceInfo.SAS.CallSign',                input.sasCallSign || input.sasUserId,             'xsd:string'   ],
    ['Device.DeviceInfo.SAS.FccId',                   input.sasFccId,                                   'xsd:string'   ],
    ['Device.DeviceInfo.SAS.groupType',               input.sasGroupType,                               'xsd:string'   ],
    ['Device.DeviceInfo.SAS.groupId',                 input.sasGroupId,                                 'xsd:string'   ],
    ['Device.DeviceInfo.SAS.LegacyMode',              String(input.sasLegacyMode),                      'xsd:boolean'  ],
    ['Device.DeviceInfo.SAS.RegistrationType',        input.sasRegistrationType,                        'xsd:string'   ],
    // reqLowFrequency/reqHighFrequency/MaxEIRP: BaiBLQ's own data model declares these
    // xsd:string (not unsignedInt) despite holding numeric values — confirmed live
    // 2026-08-16 by reading the device's own GetParameterValues type back. PreferredPower
    // is the opposite mismatch (device declares xsd:unsignedInt, not xsd:int). These were
    // real bugs (a mismatched type here would also abort the whole batch on Baicells —
    // same all-or-nothing enforcement as the cwmp.9005 bug in sync-genieacs-provisions.ts),
    // but were NOT the actual cause of the TAC/PCI/CellIdentity/MaxTxPower revert also
    // found live the same day — see the X_COM_RadioEnable removal below for that one.
    ['Device.DeviceInfo.SAS.reqLowFrequency',         input.sasReqLowFrequency,                         'xsd:string'   ],
    ['Device.DeviceInfo.SAS.reqHighFrequency',        input.sasReqHighFrequency,                        'xsd:string'   ],
    ['Device.DeviceInfo.SAS.PreferredBandwidth',      input.sasPreferredBandwidth,                      'xsd:string'   ],
    ['Device.DeviceInfo.SAS.PreferredPower',          input.sasPreferredPower,                          'xsd:unsignedInt'],
    ['Device.DeviceInfo.SAS.FrequencySelectionLogic', input.sasFrequencySelectionLogic,                 'xsd:string'   ],
    ['Device.DeviceInfo.SAS.MaxEIRP',                 input.sasMaxEIRP,                                 'xsd:string'   ],
    ['Device.DeviceInfo.SAS.EirpCapability',          input.sasEirpCapability,                          'xsd:int'      ],
    // PreferredFrequency: real bug found live (2026-08-16), same class as the other 4
    // SAS type mismatches above — device declares this xsd:string (it holds a
    // colon-separated "primary:secondary" value like "3570:3570", never a bare int),
    // not xsd:unsignedInt. Found during the full field-by-field sweep, since this
    // field is optional and hadn't been exercised by earlier single-field tests.
    ...(input.sasPreferredFrequency ? [['Device.DeviceInfo.SAS.PreferredFrequency', input.sasPreferredFrequency, 'xsd:string'] as [string, string, string]] : []),
  ];

  return [
    { url: taskUrl, body: { name: 'setParameterValues', parameterValues: params } },
    { url: taskUrl, body: { name: 'reboot' } },
    // Real bug found live (2026-08-16), full field-by-field verification on
    // 48BF74-FAP/pBS3101S/SC-1202000463221SY0360 (10.0.2.100): X_COM_RadioEnable=true
    // was UNCONDITIONALLY rejected by this radio's firmware (cwmp.9003 batch fault →
    // per-parameter fault 9007 "Invalid Value" on this exact path), in every tested
    // configuration — isolated single-parameter writes, both "true" and "1" encodings,
    // before AND after the SAS grant was confirmed active and the device's own SAS
    // heartbeat reported operationState=AUTHORIZED. Only writing back its current value
    // (false, a no-op) ever succeeded. Meanwhile the device's own real operational-state
    // parameters (FAPControl.LTE.OpState, FAPControl.LTE.RFTxStatus) already read `true`
    // the entire time — this radio's actual RF/cell state is not gated by
    // X_COM_RadioEnable at all on this firmware. Because Baicells hard-faults the ENTIRE
    // SetParameterValues batch on any single per-parameter fault, this one permanently-
    // rejected parameter was silently killing every other field in both the main batch
    // and this post-reboot batch (TAC/PCI/CellIdentity/MaxTxPower/PLMN/SAS-config, etc.)
    // on every single provision — removed entirely rather than "fixed", since no value
    // for it is accepted except a no-op. SAS.RadioEnable (a different parameter, under
    // Device.DeviceInfo.SAS, not FAPService) is unaffected and still resets on boot —
    // keep re-setting it here.
    // MaxTxPower: also confirmed live (2026-08-16) to reset to its hardware-default
    // capability value on every boot, same as SAS.RadioEnable — a real value (not the
    // radio-enable false/true class of bug) that genuinely needs re-applying post-reboot.
    // Unlike X_COM_RadioEnable it writes successfully every time; it just doesn't
    // survive the reboot on its own, so it must always be included here (not gated by
    // sasEnableMode), which also means this task is never empty and doesn't need the
    // conditional-omission Baicells' empty-setParameterValues 9003 case would otherwise
    // require.
    {
      url:  taskUrl,
      body: {
        name: 'setParameterValues',
        parameterValues: [
          [`${FAP}Capabilities.MaxTxPower`, String(input.txPower), 'xsd:unsignedInt'] as [string, string, string],
          ...(input.sasEnableMode !== '0' ? [['Device.DeviceInfo.SAS.RadioEnable', 'true', 'xsd:boolean'] as [string, string, string]] : []),
        ],
      },
    },
  ];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function encodeDeviceId(deviceId: string): string {
  return encodeURIComponent(deviceId).replace(/%2F/gi, '%252F');
}

function getParam(device: Record<string, any>, dotPath: string): string {
  const parts = dotPath.split('.');
  let node: any = device;
  for (const part of parts) {
    if (node == null) return '';
    node = node[part];
  }
  return node?._value != null ? String(node._value) : '';
}

// ─── MME Pool table (PLMN + MME IP pairs) ────────────────────────────────────
// Schema confirmed against the real Baicells TR-069 data model (2026-08-19):
// exactly 3 fields per slot — PLMNID (string(5:6)), MMEIp1 (string, IPv4),
// MME1Status (device-reported connection status, read-only in practice). No
// Enable field exists for this object (unlike PLMNList/neighbor tables) — an
// "empty" slot is represented by the device's own observed blank values,
// PLMNID="000000"/MMEIp1="0.0.0.0", confirmed live by direct observation
// before this feature ever wrote anything here. Max 16 slots, matching the
// same cap this device uses for its other multi-instance FAP objects.
const MME_POOL_BASE = (n: number) => `${FAP}CellConfig.LTE.MmePoolConfigParam.${n}.`;
const MME_POOL_MAX_ENTRIES = 16;
const MME_POOL_BLANK_PLMN = '000000';
const MME_POOL_BLANK_IP   = '0.0.0.0';

interface MmePoolEntry {
  index: number; // 1-16, which MmePoolConfigParam.{n} instance this row is bound to
  plmn: string;
  mmeIp: string;
  mmeStatus: string; // device-reported, read-only — not part of the write payload
}

function getMmePoolTable(device: Record<string, any>): MmePoolEntry[] {
  const table: MmePoolEntry[] = [];
  for (let n = 1; n <= MME_POOL_MAX_ENTRIES; n++) {
    const base = MME_POOL_BASE(n);
    const plmn = getParam(device, `${base}PLMNID`);
    if (!plmn || plmn === MME_POOL_BLANK_PLMN) continue;
    table.push({
      index: n,
      plmn,
      mmeIp: getParam(device, `${base}MMEIp1`),
      mmeStatus: getParam(device, `${base}MME1Status`),
    });
  }
  return table;
}

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
function isValidIpv4(v: string): boolean {
  const m = IPV4_RE.exec(v);
  return !!m && m.slice(1).every(octet => Number(octet) <= 255);
}

// The gate the user explicitly asked for (2026-08-19), after finding the same
// PLMN+MME-IP pair independently duplicated in two slots on two real radios,
// confusing both the radio's own GUI and its MME-selection logic. The SAME
// PLMN with a DIFFERENT MME IP is a legitimate multi-MME pool (redundancy/
// load-balancing) and must remain allowed — only an exact (plmn, mmeIp) pair
// repeated across slots is rejected.
function validateMmePoolTable(entries: MmePoolEntry[]): string[] {
  const errors: string[] = [];
  const seenCombos = new Map<string, number>();
  for (const e of entries) {
    const label = `Row #${e.index}`;
    if (!/^\d{5,6}$/.test(e.plmn)) errors.push(`${label}: PLMN must be 5-6 digits`);
    if (!isValidIpv4(e.mmeIp)) errors.push(`${label}: MME IP must be a valid IPv4 address`);
    const combo = `${e.plmn}|${e.mmeIp}`;
    const firstIndex = seenCombos.get(combo);
    if (firstIndex !== undefined) {
      errors.push(`${label}: PLMN ${e.plmn} + MME IP ${e.mmeIp} is already used in row #${firstIndex} — the same PLMN+MME-IP combination cannot be added twice`);
    } else {
      seenCombos.set(combo, e.index);
    }
  }
  return errors;
}

// ─── MME Pool Config (IPsec tunnel binding) — a DIFFERENT object from the
// MME Pool table above, despite the confusingly similar name. This is a
// SINGLETON (no numbered instances) that binds an MME pool LIST (not an
// individual MME entry) to a named IPsec tunnel — user's own description,
// 2026-08-19: "how you bind the MME to tunnel1 for ipsec." Confirmed live
// against real hardware: `MmePoolListMapIpsecTunnel` holds a string like
// "tunnel1:LTE_POOL_MME_LIST1", pairing a tunnel name with a pool-list
// identifier (LTE_POOL_MME_LIST1 = MmePool1List, presumably LTE_POOL_MME_LIST2
// = MmePool2List by the same naming convention, though only pool 1 has ever
// been observed live). An empty pool list reads back as the literal string
// "|" on this firmware (confirmed live), not a blank string — treated as
// "unset" here rather than guessed at further. The real device also exposes
// MmeList1UpITF/MmeList2UpITF/MmePool1IpsecAddr/MmePool2IpsecAddr under this
// same object — deliberately NOT exposed here, since no live value or
// documentation for any of them has ever been observed (same "don't guess"
// rule as the X2 Manual IP field above); add them once their real format is
// confirmed, not before.
const MME_POOL_CONFIG_BASE = `${FAP}FAPControl.LTE.Gateway.X_COM_MmePool.`;
const MME_POOL_CONFIG_BLANK_LIST = '|';

interface MmePoolConfig {
  enable: string;      // 'true' | 'false'
  pool1List: string;
  pool2List: string;
  ipsecTunnelMap: string;
  pool1Status: string; // device-reported, read-only
  pool2Status: string; // device-reported, read-only
}

function getMmePoolConfig(device: Record<string, any>): MmePoolConfig {
  const pool1List = getParam(device, `${MME_POOL_CONFIG_BASE}MmePool1List`);
  const pool2List = getParam(device, `${MME_POOL_CONFIG_BASE}MmePool2List`);
  return {
    enable:         getParam(device, `${MME_POOL_CONFIG_BASE}Enable`),
    pool1List:      pool1List === MME_POOL_CONFIG_BLANK_LIST ? '' : pool1List,
    pool2List:      pool2List === MME_POOL_CONFIG_BLANK_LIST ? '' : pool2List,
    ipsecTunnelMap: getParam(device, `${MME_POOL_CONFIG_BASE}MmePoolListMapIpsecTunnel`),
    pool1Status:    getParam(device, `${MME_POOL_CONFIG_BASE}MmePool1Status`),
    pool2Status:    getParam(device, `${MME_POOL_CONFIG_BASE}MmePool2Status`),
  };
}

// Loose on purpose — the exact valid syntax for multiple tunnel:list pairs
// (if this firmware even supports more than one) has never been observed
// live, only the single-pair "tunnel1:LTE_POOL_MME_LIST1" form. Only rejects
// clearly malformed input rather than inventing a stricter grammar.
function validateMmePoolConfig(cfg: MmePoolConfig): string[] {
  const errors: string[] = [];
  if (cfg.ipsecTunnelMap && !/^\w+:LTE_POOL_MME_LIST\d+(,\w+:LTE_POOL_MME_LIST\d+)*$/.test(cfg.ipsecTunnelMap)) {
    errors.push(`IPsec tunnel map must look like "tunnel1:LTE_POOL_MME_LIST1" (comma-separated if binding more than one pool)`);
  }
  return errors;
}

// Only rows with Enable=true are surfaced to the UI as "configured" — an
// index with Enable=false (the device's own default/cleared state, or a row
// this NMS explicitly cleared on removal) is treated as an empty slot, not a
// row with stale leftover field values.
function getNeighborTables(device: Record<string, any>): { neighborFreqTable: NeighborFreqEntry[]; neighborCellTable: NeighborCellEntry[] } {
  const neighborFreqTable: NeighborFreqEntry[] = [];
  for (let n = 1; n <= 8; n++) {
    const base = NEIGHBOR_FREQ_BASE(n);
    if (getParam(device, `${base}Enable`) !== 'true') continue;
    const entry = { index: n } as NeighborFreqEntry;
    for (const [prop, field] of Object.entries(NEIGHBOR_FREQ_FIELD_MAP)) {
      (entry as any)[prop] = getParam(device, `${base}${field}`);
    }
    neighborFreqTable.push(entry);
  }

  const neighborCellTable: NeighborCellEntry[] = [];
  for (let n = 1; n <= 8; n++) {
    const base = NEIGHBOR_CELL_BASE(n);
    if (getParam(device, `${base}Enable`) !== 'true') continue;
    const entry = { index: n } as NeighborCellEntry;
    for (const [prop, field] of Object.entries(NEIGHBOR_CELL_FIELD_MAP)) {
      (entry as any)[prop] = getParam(device, `${base}${field}`);
    }
    neighborCellTable.push(entry);
  }

  return { neighborFreqTable, neighborCellTable };
}

// Scans the PLMNList and MmePoolConfigParam multi-instance object tables
// (slots 1-6, matching PLMNList's own documented range) for duplicate
// broadcast entries. Real bug found live (2026-08-19, radios 10.0.2.101/.102):
// the same PLMN was independently enabled in two different PLMNList slots at
// once, and separately the same PLMN+MME-IP pair was populated in two
// different MmePoolConfigParam slots — both invisible to a check that only
// ever reads slot 1 (which is all this project's own PLMN-mismatch detection
// did before this), and both visibly duplicated on the radio's own native
// GUI with no warning from it either. PLMNList has a real Enable flag, so an
// entry only counts if Enable=true; MmePoolConfigParam has no Enable field,
// so an entry counts as "populated" whenever its PLMNID isn't the device's
// own observed blank-slot value ('000000').
function findDuplicatePlmnEntries(device: Record<string, any>): string[] {
  const issues: string[] = [];

  const enabledPlmns: string[] = [];
  for (let n = 1; n <= 6; n++) {
    const base = `${FAP}CellConfig.LTE.EPC.PLMNList.${n}.`;
    if (getParam(device, `${base}Enable`) !== 'true') continue;
    const plmn = getParam(device, `${base}PLMNID`);
    if (plmn) enabledPlmns.push(plmn);
  }
  const dupPlmns = [...new Set(enabledPlmns.filter((v, i) => enabledPlmns.indexOf(v) !== i))];
  if (dupPlmns.length > 0) {
    issues.push(`PLMN ${dupPlmns.join(', ')} enabled in more than one PLMNList slot`);
  }

  const poolPairs = getMmePoolTable(device).map(e => `${e.plmn}|${e.mmeIp}`);
  const dupPairs = [...new Set(poolPairs.filter((v, i) => poolPairs.indexOf(v) !== i))];
  if (dupPairs.length > 0) {
    issues.push(`MME pool entry ${dupPairs.map(p => p.replace('|', ' + ')).join(', ')} configured in more than one MmePoolConfigParam slot`);
  }

  return issues;
}

function toRadio(device: Record<string, any>, coreMcc: string, coreMnc: string) {
  const serial     = device._id ?? 'unknown';
  const plmn       = getParam(device, `${FAP}CellConfig.LTE.EPC.PLMNList.1.PLMNID`);
  const mcc        = plmn.length >= 3 ? plmn.slice(0, 3) : '';
  const mnc        = plmn.length >  3 ? plmn.slice(3)    : '';
  const plmnMismatch = isPlmnMismatch(mcc, mnc, coreMcc, coreMnc);
  const duplicatePlmnEntries = findDuplicatePlmnEntries(device);
  const mmePoolTable = getMmePoolTable(device);
  const mmePoolConfig = getMmePoolConfig(device);
  const lastInform = device._lastInform ?? null;
  const opState    = getParam(device, `${FAP}FAPControl.LTE.OpState`);
  const rfTxStatus = getParam(device, `${FAP}FAPControl.LTE.RFTxStatus`);
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const isOnline   = lastInform && lastInform > fiveMinAgo;

  // Deliberately NOT X_COM_RadioEnable — confirmed live (2026-08-16, see the
  // provisioning-task comment above buildProvisionTasks) that this parameter
  // can get permanently stuck (firmware rejects every write except a no-op)
  // and does not reflect the radio's actual RF state at all. OpState +
  // RFTxStatus are the device's own real operational-state parameters and
  // were confirmed reading `true` the whole time X_COM_RadioEnable sat stuck
  // `false` — using them here instead is what actually matches reality.
  const rfStatus: 'on' | 'off' | 'offline' =
    !isOnline                                     ? 'offline' :
    rfTxStatus === 'true' && opState === 'true'   ? 'on'      : 'off';

  const directIp = getParam(device, 'Device.IP.Interface.1.IPv4Address.1.IPAddress');
  const crUrl    = getParam(device, 'Device.ManagementServer.ConnectionRequestURL');
  const parsedIp = !directIp && crUrl ? (crUrl.match(/https?:\/\/([^:/]+)/)?.[1] ?? '') : directIp;

  // GPS coordinates stored as integer 1e-7 degrees (e.g. 43375198 → 43.375198°)
  const latRaw = getParam(device, 'Device.DeviceInfo.cpiLatitude');
  const lonRaw = getParam(device, 'Device.DeviceInfo.cpiLongitude');
  const latitude  = latRaw ? String(parseInt(latRaw) / 1e7) : '';
  const longitude = lonRaw ? String(parseInt(lonRaw) / 1e7) : '';

  // UE count — prefer the per-cell field, fall back to DeviceInfo aggregate
  const ueCountFap  = getParam(device, `${FAP}X_COM.LTE.LteUECount`);
  const ueCountInfo = getParam(device, 'Device.DeviceInfo.X_COM_UE_Count');
  const ueCount = ueCountFap || ueCountInfo;

  return {
    id:           serial,
    serial,
    lastInform,
    ip:           parsedIp,
    rfStatus,
    plmnMismatch,
    duplicatePlmnEntries,
    mmePoolTable,
    mmePoolConfig,
    mcc,
    mnc,
    tac:          getParam(device, `${FAP}CellConfig.LTE.EPC.TAC`),
    mmeIp:        getParam(device, `${FAP}FAPControl.LTE.Gateway.S1SigLinkServerList`),
    bandwidthMhz: RB_TO_MHZ[getParam(device, `${FAP}CellConfig.LTE.RAN.RF.DLBandwidth`)] ?? '',
    earfcn:       getParam(device, `${FAP}CellConfig.LTE.RAN.RF.EARFCNDL`),
    cellId:       getParam(device, `${FAP}CellConfig.LTE.RAN.Common.CellIdentity`),
    pci:          getParam(device, `${FAP}CellConfig.LTE.RAN.RF.PhyCellID`),
    band:         getParam(device, `${FAP}CellConfig.LTE.RAN.RF.FreqBandIndicator`),
    txPower:      getParam(device, `${FAP}Capabilities.MaxTxPower`),
    // Live status — from newly discovered full parameter tree
    mmeStatus:    getParam(device, 'Device.DeviceInfo.X_COM_MME_Status'),
    ueCount,
    gpsStatus:    getParam(device, 'Device.DeviceInfo.X_COM_GPS_Status'),
    gpsSatCount:  getParam(device, 'Device.DeviceInfo.X_COM_GPS_Satellite_count'),
    uptime:       getParam(device, 'Device.DeviceInfo.X_COM_STATION_RUN_Time'),
    latitude,
    longitude,
    hwVersion:    getParam(device, 'Device.DeviceInfo.HardwareVersion'),
    swVersion:    getParam(device, 'Device.DeviceInfo.SoftwareVersion'),
    // SAS
    sasEnable:    getParam(device, 'Device.DeviceInfo.SAS.RadioEnable'),
    sasServerUrl: getParam(device, 'Device.DeviceInfo.SAS.ServerUrl'),
    sasUserId:    getParam(device, 'Device.DeviceInfo.SAS.UserId'),
    sasFccId:     getParam(device, 'Device.DeviceInfo.SAS.FccId'),
    sasCallSign:  getParam(device, 'Device.DeviceInfo.SAS.CallSign'),
    sasGroupType: getParam(device, 'Device.DeviceInfo.SAS.groupType'),
    sasGroupId:   getParam(device, 'Device.DeviceInfo.SAS.groupId'),
    sasLegacyMode:              getParam(device, 'Device.DeviceInfo.SAS.LegacyMode'),
    sasRegistrationType:        getParam(device, 'Device.DeviceInfo.SAS.RegistrationType'),
    sasReqLowFrequency:         getParam(device, 'Device.DeviceInfo.SAS.reqLowFrequency'),
    sasReqHighFrequency:        getParam(device, 'Device.DeviceInfo.SAS.reqHighFrequency'),
    sasPreferredFrequency:      getParam(device, 'Device.DeviceInfo.SAS.PreferredFrequency'),
    sasPreferredBandwidth:      getParam(device, 'Device.DeviceInfo.SAS.PreferredBandwidth'),
    sasPreferredPower:          getParam(device, 'Device.DeviceInfo.SAS.PreferredPower'),
    sasFrequencySelectionLogic: getParam(device, 'Device.DeviceInfo.SAS.FrequencySelectionLogic'),
    sasMaxEIRP:                 getParam(device, 'Device.DeviceInfo.SAS.MaxEIRP'),
    sasEirpCapability:          getParam(device, 'Device.DeviceInfo.SAS.EirpCapability'),
    sasEnableMode:              getParam(device, 'Device.DeviceInfo.SAS.enableMode'),
    ...getNeighborTables(device),
  };
}

async function nbiPost(url: string, body: Record<string, any>): Promise<{ ok: boolean; status: number; text: string }> {
  const resp = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  const text = await resp.text().catch(() => '');
  return { ok: resp.ok, status: resp.status, text };
}

// Refreshes the Baicells "LTE Freq/Cell" neighbor tables — Cell Neighbor Freq
// Table (Mobility.IdleMode.InterFreq.Carrier.{1-8}) and Cell Neighbor Cell
// Table (CellConfig.LTE.RAN.NeighborList.LTECell.{1-8}), 8 instances each.
// Deliberately NOT awaited by the /refresh route — three real bugs found live
// (2026-08-16) mean this can take upwards of a minute, which would make the
// Summon button hang if this blocked the HTTP response:
//   1. GenieACS's own "too_many_commits" error is a PER-SESSION cap on total
//      commit iterations across every task the device processes in one
//      connection, not a per-task cap. A single getParameterValues spanning
//      2+ numbered instances always faults, so each instance's fields are
//      requested as its own task — but even several single-instance tasks
//      all queued for the same session still exceed the cap (confirmed live:
//      only ~2 of 16 completed in one session, the rest faulted).
//   2. Firing many of these task-creation POSTs at GenieACS's NBI
//      concurrently (Promise.all) gets most of them rejected outright with a
//      plain HTTP 503 before they even reach the device — confirmed live via
//      the identical symptom on the cleanup DELETEs below (only ~5 of 26
//      succeeded when fired at once). Sequential submission avoids this.
//   3. A faulted task stays queued and GenieACS retries it automatically on
//      the device's next connection — but a naive re-run of this function
//      used to just pile 16 more tasks on top of whatever was still stuck
//      from the last run (confirmed live: 14 stuck tasks became 28, then 26,
//      after repeated calls). Clearing our own still-pending
//      getParameterValues tasks before resubmitting keeps each call additive
//      progress instead of an ever-growing queue — safe, these are read-only
//      requests with no side effect on the device if deleted mid-flight.
// Net effect: there is no way to force all 16 instances through in one
// Summon click on this firmware — full convergence takes however many
// natural reconnects/Summon clicks it takes, a few instances per session.
async function refreshBaicellsNeighborTables(nbiUrl: string, deviceId: string, gpvUrl: string, logger: pino.Logger): Promise<void> {
  const staleTasksResp = await fetch(
    `${nbiUrl}/tasks?query=${encodeURIComponent(JSON.stringify({ device: deviceId, name: 'getParameterValues' }))}`
  );
  if (staleTasksResp.ok) {
    const staleTasks = await staleTasksResp.json().catch(() => [] as Array<{ _id: string }>);
    for (const t of staleTasks as Array<{ _id: string }>) {
      await fetch(`${nbiUrl}/tasks/${t._id}`, { method: 'DELETE' }).catch(() => {});
    }
  }

  // 'Enable' is fetched alongside each table's own fields — it's what
  // getNeighborTables() filters on to decide whether a row is "configured"
  // at all, so it must stay in sync just like every other field here.
  const neighborBatches: Array<{ base: string; fields: string[] }> = [
    ...Array.from({ length: 8 }, (_, i) => i + 1).map(n => ({
      base: NEIGHBOR_FREQ_BASE(n),
      fields: [...Object.values(NEIGHBOR_FREQ_FIELD_MAP), 'Enable'],
    })),
    ...Array.from({ length: 8 }, (_, i) => i + 1).map(n => ({
      base: NEIGHBOR_CELL_BASE(n),
      fields: [...Object.values(NEIGHBOR_CELL_FIELD_MAP), 'Enable'],
    })),
  ];
  let neighborFailCount = 0;
  for (const { base, fields } of neighborBatches) {
    const result = await nbiPost(gpvUrl, {
      name: 'getParameterValues',
      parameterNames: fields.map(f => `${base}${f}`),
    }).catch(() => null);
    if (!result || (result.status !== 202 && !result.ok)) neighborFailCount++;
  }
  if (neighborFailCount > 0) {
    logger.warn({ deviceId, neighborFailCount }, 'Some neighbor-table getParameterValues refreshes failed — those entries may stay stale until a later Summon');
  }
}

// ─── Router factory ───────────────────────────────────────────────────────────
export function createGenieacsRouter(
  nbiUrl:      string,
  logger:      pino.Logger,
  auditLogger: IAuditLogger,
  backupRoot:  string,
): Router {
  const router = Router();

  // ── GET /api/genieacs/tasks/:deviceId ───────────────────────────────────
  // Proxies GenieACS NBI /tasks endpoint for a specific device
  router.get('/tasks/:deviceId', async (req: Request, res: Response) => {
    const { deviceId } = req.params;
    try {
      const resp = await fetch(
        `${nbiUrl}/tasks?query=${encodeURIComponent(JSON.stringify({ device: deviceId }))}&sort=${encodeURIComponent(JSON.stringify({ timestamp: -1 }))}`
      );
      if (!resp.ok) throw new Error(`GenieACS NBI returned HTTP ${resp.status}`);
      const tasks = await resp.json();
      res.json({ success: true, tasks: Array.isArray(tasks) ? tasks : [] });
    } catch (err) {
      logger.error({ err: String(err), deviceId }, 'Failed to fetch tasks');
      res.status(502).json({ success: false, error: String(err), tasks: [] });
    }
  });

  // ── GET /api/genieacs/devices/sercomm ───────────────────────────────────
  // Returns only Sercomm/FreedomFi devices filtered by Manufacturer field
  router.get('/devices/sercomm', async (_req: Request, res: Response) => {
    try {
      const SERCOMM_FAP = 'Device.Services.FAPService.1.';
      const projection = [
        '_id', '_lastInform',
        'Device.DeviceInfo.Manufacturer',
        `${SERCOMM_FAP}FAPControl.LTE.AdminState`,
        `${SERCOMM_FAP}FAPControl.LTE.X_000E8F_CellState`,
        `${SERCOMM_FAP}FAPControl.LTE.Gateway.S1SigLinkServerList`,
        `${SERCOMM_FAP}CellConfig.LTE.EPC.TAC`,
        `${SERCOMM_FAP}CellConfig.LTE.EPC.PLMNList.1.PLMNID`,
        `${SERCOMM_FAP}CellConfig.LTE.RAN.RF.EARFCNDL`,
        `${SERCOMM_FAP}CellConfig.LTE.RAN.RF.X_000E8F_EARFCNDL2`,
        `${SERCOMM_FAP}CellConfig.LTE.RAN.RF.DLBandwidth`,
        `${SERCOMM_FAP}CellConfig.LTE.RAN.RF.PhyCellID`,
        `${SERCOMM_FAP}CellConfig.LTE.RAN.RF.FreqBandIndicator`,
        `${SERCOMM_FAP}CellConfig.LTE.RAN.Common.CellIdentity`,
        `${SERCOMM_FAP}CellConfig.LTE.RAN.Common.X_000E8F_CellIdentity2`,
        `${SERCOMM_FAP}CellConfig.LTE.RAN.RF.X_000E8F_TxPowerConfig`,
        `${SERCOMM_FAP}CellConfig.LTE.EPC.X_000E8F_TAC2`,
        `${SERCOMM_FAP}FAPControl.LTE.X_000E8F_RRMConfig.X_000E8F_CA_Enable`,
        `${SERCOMM_FAP}FAPControl.LTE.X_000E8F_RRMConfig.X_000E8F_Cell_Number`,
        `${SERCOMM_FAP}FAPControl.LTE.X_000E8F_RRMConfig.X_000E8F_CELL_Freq_Contiguous`,
        `${SERCOMM_FAP}FAPControl.LTE.X_000E8F_SAS.Enable`,
        `${SERCOMM_FAP}FAPControl.LTE.X_000E8F_SAS.Location`,
        `${SERCOMM_FAP}FAPControl.LTE.X_000E8F_SAS.UserContactInformation`,
        `${SERCOMM_FAP}FAPControl.LTE.X_000E8F_SAS.ICGGroupId`,
        `${SERCOMM_FAP}REM.X_000E8F_tfcsManagerConfig.primSrc`,
        `${SERCOMM_FAP}CellConfig.LTE.RAN.PHY.PDSCH.X_000E8F_Enable256QAM`,
        `${SERCOMM_FAP}CellConfig.LTE.RAN.PHY.PUSCH.Enable64QAM`,
        'Device.FAP.GPS.LockedLatitude',
        'Device.FAP.GPS.LockedLongitude',
        'Device.X_000E8F_DeviceFeature.X_000E8F_NEStatus.X_000E8F_eNB_Status',
        'Device.X_000E8F_DeviceFeature.X_000E8F_NEStatus.X_000E8F_S1_Status',
        `${SERCOMM_FAP}FAPControl.LTE.X_000E8F_CurrentUENum`,
        'Device.IP.Interface.1.IPv4Address.1.IPAddress',
      ].join(',');

      const resp = await fetch(`${nbiUrl}/devices?projection=${encodeURIComponent(projection)}`);
      if (!resp.ok) throw new Error(`GenieACS NBI returned HTTP ${resp.status}`);

      const devices = (await resp.json()) as Record<string, any>[];

      // Filter to Sercomm/FreedomFi 4G by OUI from _deviceId (000E8F)
      // Exclude OUI 00C002 = Sercomm NR (SCE5164 5G) which shares the "Sercomm" manufacturer string
      const sercommDevices = devices.filter(d => {
        const oui = (d._deviceId?._OUI ?? d._id?.split('-')[0] ?? '').toUpperCase();
        const mfr = (d._deviceId?._Manufacturer ?? getParam(d, 'Device.DeviceInfo.Manufacturer')).toLowerCase();
        return (oui === '000E8F' || mfr.includes('sercomm') || mfr.includes('freedomfi') || mfr.includes('moso'))
          && oui !== '00C002';
      });

      const { mcc: coreMcc, mnc: coreMnc } = readCoreMccMnc();
      const radios = sercommDevices.map(d => {
        const serial   = d._id ?? 'unknown';
        const plmn     = getParam(d, `${SERCOMM_FAP}CellConfig.LTE.EPC.PLMNList.1.PLMNID`);
        const mcc      = plmn.length >= 3 ? plmn.slice(0, 3) : '';
        const mnc      = plmn.length >  3 ? plmn.slice(3)    : '';
        const plmnMismatch = isPlmnMismatch(mcc, mnc, coreMcc, coreMnc);
        const lastInform = d._lastInform ?? null;
        const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
        const isOnline   = lastInform && lastInform > fiveMinAgo;
        const enbStatus  = getParam(d, 'Device.X_000E8F_DeviceFeature.X_000E8F_NEStatus.X_000E8F_eNB_Status');
        const rfStatus: 'on' | 'off' | 'offline' =
          !isOnline ? 'offline' : enbStatus.toUpperCase() === 'SUCCESS' ? 'on' : 'off';

        return {
          id: serial, serial, lastInform, rfStatus, plmnMismatch,
          ip:           getParam(d, 'Device.IP.Interface.1.IPv4Address.1.IPAddress'),
          mcc, mnc,
          tac:          getParam(d, `${SERCOMM_FAP}CellConfig.LTE.EPC.TAC`),
          mmeIp:        getParam(d, `${SERCOMM_FAP}FAPControl.LTE.Gateway.S1SigLinkServerList`),
          mmeCfgIdList: getParam(d, `${SERCOMM_FAP}CellConfig.LTE.EPC.PLMNList.1.X_000E8F_CFG_MMEIdList`) || '{1}',
          earfcn:       getParam(d, `${SERCOMM_FAP}CellConfig.LTE.RAN.RF.EARFCNDL`),
          earfcn2:      getParam(d, `${SERCOMM_FAP}CellConfig.LTE.RAN.RF.X_000E8F_EARFCNDL2`),
          bandwidth:    getParam(d, `${SERCOMM_FAP}CellConfig.LTE.RAN.RF.DLBandwidth`),
          pci:          getParam(d, `${SERCOMM_FAP}CellConfig.LTE.RAN.RF.PhyCellID`),
          band:         getParam(d, `${SERCOMM_FAP}CellConfig.LTE.RAN.RF.FreqBandIndicator`),
          cellIdentity: getParam(d, `${SERCOMM_FAP}CellConfig.LTE.RAN.Common.CellIdentity`),
          cellIdentity2:getParam(d, `${SERCOMM_FAP}CellConfig.LTE.RAN.Common.X_000E8F_CellIdentity2`),
          txPower:      getParam(d, `${SERCOMM_FAP}CellConfig.LTE.RAN.RF.X_000E8F_TxPowerConfig`),
          syncSource:   getParam(d, `${SERCOMM_FAP}REM.X_000E8F_tfcsManagerConfig.primSrc`) || 'FREE_RUNNING',
          caEnable:     getParam(d, `${SERCOMM_FAP}FAPControl.LTE.X_000E8F_RRMConfig.X_000E8F_CA_Enable`),
          cellNumber:   getParam(d, `${SERCOMM_FAP}FAPControl.LTE.X_000E8F_RRMConfig.X_000E8F_Cell_Number`),
          contiguousCC: getParam(d, `${SERCOMM_FAP}FAPControl.LTE.X_000E8F_RRMConfig.X_000E8F_CELL_Freq_Contiguous`),
          sasEnable:    getParam(d, `${SERCOMM_FAP}FAPControl.LTE.X_000E8F_SAS.Enable`),
          sasLocation:  getParam(d, `${SERCOMM_FAP}FAPControl.LTE.X_000E8F_SAS.Location`) || 'indoor',
          sasUserId:    getParam(d, `${SERCOMM_FAP}FAPControl.LTE.X_000E8F_SAS.UserContactInformation`),
          icgGroupId:   getParam(d, `${SERCOMM_FAP}FAPControl.LTE.X_000E8F_SAS.ICGGroupId`),
          latitude:     getParam(d, 'Device.FAP.GPS.LockedLatitude'),
          longitude:    getParam(d, 'Device.FAP.GPS.LockedLongitude'),
          enable256QAM: getParam(d, `${SERCOMM_FAP}CellConfig.LTE.RAN.PHY.PDSCH.X_000E8F_Enable256QAM`),
          enable64QAM:  getParam(d, `${SERCOMM_FAP}CellConfig.LTE.RAN.PHY.PUSCH.Enable64QAM`),
          s1Status:     getParam(d, 'Device.X_000E8F_DeviceFeature.X_000E8F_NEStatus.X_000E8F_S1_Status'),
          ueCount:      getParam(d, `${SERCOMM_FAP}FAPControl.LTE.X_000E8F_CurrentUENum`),
        };
      });

      res.json({ success: true, devices: radios });
    } catch (err) {
      logger.error({ err: String(err) }, 'Failed to fetch Sercomm devices');
      res.status(502).json({ success: false, error: `GenieACS NBI unreachable: ${String(err)}` });
    }
  });

  // ── POST /api/genieacs/preview-sercomm/:deviceId ───────────────────────────
  // Returns the two NBI task bodies for Sercomm provisioning without sending them.
  router.post('/preview-sercomm/:deviceId', requireAdmin, (req: Request, res: Response) => {
    const { deviceId } = req.params;
    const input        = req.body as SercommProvisionInput;
    const sasServerUrl = req.body.sasServerUrl as string | undefined;
    logger.info({ sasUserId: input.sasUserId, sasEnable: input.sasEnable }, 'Sercomm preview-sercomm received');
    const encodedId    = encodeDeviceId(deviceId);
    const taskUrl      = `${nbiUrl}/devices/${encodedId}/tasks?timeout=30000&connection_request`;
    const tasks        = buildSercommTasks(taskUrl, input, sasServerUrl);
    res.json({ success: true, deviceId, tasks });
  });

  // ── GET /api/genieacs/devices ─────────────────────────────────────────────
  router.get('/devices', async (_req: Request, res: Response) => {
    try {
      const projection = [
        '_id', '_lastInform',
        'Device.DeviceInfo.Manufacturer',
        `${FAP}CellConfig.LTE.EPC.TAC`,
        // Parent paths, not just slot 1 — real bug found live (2026-08-19):
        // a radio can have the SAME PLMN independently enabled in a second
        // PLMNList slot, or the same PLMN+MME-IP pair populated in a second
        // MmePoolConfigParam slot, invisible to any check reading only slot
        // 1. See findDuplicatePlmnEntries().
        `${FAP}CellConfig.LTE.EPC.PLMNList`,
        `${FAP}CellConfig.LTE.MmePoolConfigParam`,
        `${FAP}FAPControl.LTE.Gateway.X_COM_MmePool`,
        `${FAP}FAPControl.LTE.Gateway.S1SigLinkServerList`,
        `${FAP}FAPControl.LTE.OpState`,
        `${FAP}FAPControl.LTE.RFTxStatus`,
        `${FAP}CellConfig.LTE.RAN.RF.EARFCNDL`,
        `${FAP}CellConfig.LTE.RAN.RF.DLBandwidth`,
        `${FAP}CellConfig.LTE.RAN.RF.PhyCellID`,
        `${FAP}CellConfig.LTE.RAN.RF.FreqBandIndicator`,
        `${FAP}CellConfig.LTE.RAN.RF.X_COM_RadioEnable`,
        `${FAP}CellConfig.LTE.RAN.Common.CellIdentity`,
        `${FAP}Capabilities.MaxTxPower`,
        'Device.IP.Interface.1.IPv4Address.1.IPAddress',
        'Device.ManagementServer.ConnectionRequestURL',
        // Live status fields — from full parameter tree (available after clean bootstrap)
        'Device.DeviceInfo.X_COM_MME_Status',
        'Device.DeviceInfo.X_COM_UE_Count',
        `${FAP}X_COM.LTE.LteUECount`,
        'Device.DeviceInfo.X_COM_GPS_Status',
        'Device.DeviceInfo.X_COM_GPS_Satellite_count',
        'Device.DeviceInfo.cpiLatitude',
        'Device.DeviceInfo.cpiLongitude',
        'Device.DeviceInfo.X_COM_STATION_RUN_Time',
        'Device.DeviceInfo.HardwareVersion',
        'Device.DeviceInfo.SoftwareVersion',
        'Device.DeviceInfo.SAS.RadioEnable',
        'Device.DeviceInfo.SAS.ServerUrl',
        'Device.DeviceInfo.SAS.UserId',
        'Device.DeviceInfo.SAS.FccId',
        'Device.DeviceInfo.SAS.CallSign',
        'Device.DeviceInfo.SAS.groupType',
        'Device.DeviceInfo.SAS.groupId',
        'Device.DeviceInfo.SAS.LegacyMode',
        'Device.DeviceInfo.SAS.RegistrationType',
        'Device.DeviceInfo.SAS.reqLowFrequency',
        'Device.DeviceInfo.SAS.reqHighFrequency',
        'Device.DeviceInfo.SAS.PreferredFrequency',
        'Device.DeviceInfo.SAS.PreferredBandwidth',
        'Device.DeviceInfo.SAS.PreferredPower',
        'Device.DeviceInfo.SAS.FrequencySelectionLogic',
        'Device.DeviceInfo.SAS.MaxEIRP',
        'Device.DeviceInfo.SAS.EirpCapability',
        'Device.DeviceInfo.SAS.enableMode',
        // LTE Freq/Cell neighbor tables — real bug found live (2026-08-16):
        // this projection is a MongoDB-style field whitelist, so without these
        // two parent paths GenieACS strips the whole Carrier.{1-8}/LTECell.{1-8}
        // subtree before toRadio() ever sees it, regardless of what's actually
        // cached — getNeighborTables() silently returned empty arrays even
        // right after a fresh refresh had populated the real data. A parent
        // path here projects its entire subtree, no need to enumerate every leaf.
        `${FAP}CellConfig.LTE.RAN.Mobility.IdleMode.InterFreq`,
        `${FAP}CellConfig.LTE.RAN.NeighborList`,
      ].join(',');

      const resp = await fetch(`${nbiUrl}/devices?projection=${encodeURIComponent(projection)}`);
      if (!resp.ok) throw new Error(`GenieACS NBI returned HTTP ${resp.status}`);
      const devices = (await resp.json()) as Record<string, any>[];

      // Filter to Baicells only by OUI from _deviceId (48BF74)
      // Device.DeviceInfo.Manufacturer is empty for Baicells — they don't populate it via TR-069
      const baicellsDevices = devices.filter(d => {
        const oui = (d._deviceId?._OUI ?? d._id?.split('-')[0] ?? '').toUpperCase();
        const mfr = (d._deviceId?._Manufacturer ?? getParam(d, 'Device.DeviceInfo.Manufacturer')).toLowerCase();
        return oui === '48BF74' || mfr.includes('baicells');
      });

      const { mcc: coreMcc, mnc: coreMnc } = readCoreMccMnc();
      res.json({ success: true, devices: baicellsDevices.map(d => toRadio(d, coreMcc, coreMnc)) });
    } catch (err) {
      logger.error({ err: String(err) }, 'Failed to fetch GenieACS devices');
      res.status(502).json({ success: false, error: `GenieACS NBI unreachable: ${String(err)}` });
    }
  });

  // ── POST /api/genieacs/preview/:deviceId ─────────────────────────────────
  // Returns the three NBI task bodies that would be sent — without sending them.
  router.post('/preview/:deviceId', requireAdmin, (req: Request, res: Response) => {
    const { deviceId } = req.params;
    const input: BaicellsProvisionInput = req.body;

    const missing = (['mcc','mnc','tac','mmeIp','bandwidthMhz','earfcn','cellId','pci','band','txPower'] as const)
      .filter(k => input[k] == null || input[k] === '');
    if (missing.length) {
      return res.status(400).json({ success: false, error: `Missing fields: ${missing.join(', ')}` });
    }

    const encodedId = encodeDeviceId(deviceId);
    const tasks     = buildProvisionTasks(nbiUrl, encodedId, input);
    res.json({ success: true, deviceId, tasks });
  });

  // ── POST /api/genieacs/execute-tasks ─────────────────────────────────────
  // Fires an ordered array of NBI tasks — used by the confirm modal after user review/edit.
  // Security: caller supplies task bodies only — URLs are constructed server-side
  // from deviceId to prevent SSRF (fix for bug report 3.5).
  router.post('/execute-tasks', requireAdmin, async (req: Request, res: Response) => {
    const { deviceId, tasks } = req.body as { deviceId: string; tasks: Array<{ body: Record<string, any> }> };
    const user = (req as any).user?.username ?? 'unknown';

    if (!deviceId || !Array.isArray(tasks) || tasks.length === 0) {
      return res.status(400).json({ success: false, error: 'deviceId and tasks array required' });
    }

    // Construct task URL server-side — never trust a caller-supplied URL
    const encodedId = encodeDeviceId(deviceId);
    const taskUrl   = `${nbiUrl}/devices/${encodedId}/tasks?timeout=30000&connection_request`;

    const results: { task: number; ok: boolean; status: number; response: string }[] = [];

    try {
      for (let i = 0; i < tasks.length; i++) {
        const { body } = tasks[i];
        const r = await nbiPost(taskUrl, body);
        results.push({ task: i + 1, ok: r.ok, status: r.status, response: r.text });
        if (!r.ok) throw new Error(`Task ${i + 1} failed (${r.status}): ${r.text}`);
      }

      await auditLogger.log({
        action:  'radio_provision',
        user,
        target:  deviceId,
        details: `Executed ${tasks.length} NBI tasks via confirm modal`,
        success: true,
      });

      // Auto-backup after successful provision
      try {
        await backupDeviceById(nbiUrl, backupRoot, deviceId);
      } catch (backupErr) {
        logger.warn({ backupErr: String(backupErr), deviceId }, 'Auto-backup after provision failed');
      }

      res.json({ success: true, results });
    } catch (err) {
      await auditLogger.log({
        action:  'radio_provision',
        user,
        target:  deviceId,
        details: String(err),
        success: false,
      });
      res.status(502).json({ success: false, error: String(err), results });
    }
  });

  // ── POST /api/genieacs/refresh/:deviceId ─────────────────────────────────
  // Triggers a connection request, re-runs the inform provision, AND explicitly
  // fetches the config/SAS parameters the edit form needs but that GenieACS
  // never queries on its own (Baicells only reports a small fixed parameter
  // set on periodic Inform — see memory baicells-genieacs-9005-fix).
  //
  // IMPORTANT: this parameterNames list must only ever contain paths already
  // proven to exist on this radio model — every one of them is also written
  // by buildProvisionTasks()'s setParameterValues (Push Config), so a prior
  // successful push is what actually creates them in the device's data model.
  // Baicells (BaiBLQ_3.0.12) hard-faults (9005) a getParameterValues call if
  // ANY listed name doesn't exist on the device, aborting the whole RPC — do
  // not add a path here unless it's also in buildProvisionTasks's params list.
  router.post('/refresh/:deviceId', requireAdmin, async (req: Request, res: Response) => {
    const { deviceId } = req.params;
    const encodedId    = encodeDeviceId(deviceId);
    const taskUrl      = `${nbiUrl}/devices/${encodedId}/tasks?connection_request`;

    try {
      const r = await nbiPost(taskUrl, {
        name: 'provisions',
        provisions: [['baicells']],
      });
      if (!r.ok) throw new Error(`connection_request failed (${r.status}): ${r.text}`);

      const gpvUrl = `${nbiUrl}/devices/${encodedId}/tasks?timeout=30000&connection_request`;
      const gpv = await nbiPost(gpvUrl, {
        name: 'getParameterValues',
        parameterNames: [
          `${FAP}CellConfig.LTE.EPC.TAC`,
          // Real bug found live (2026-08-16): this list omitted PLMNID
          // entirely — buildProvisionTasks() writes it (it's the only source
          // of the mcc/mnc fields toRadio() derives), but nothing ever
          // refreshed it back, so the Auto Config UI's MCC/MNC fields showed
          // permanently blank after every refresh even when PLMN was
          // correctly configured on the radio (confirmed live: device
          // reported PLMNID="00101" via a direct getParameterValues call
          // that succeeded with no fault, proving this was a read-back gap,
          // not a write-side bug).
          `${FAP}CellConfig.LTE.EPC.PLMNList.1.PLMNID`,
          // Real gap found live (2026-08-20): none of these were ever
          // refreshed either, so findDuplicatePlmnEntries()/getMmePoolTable()/
          // getMmePoolConfig() only ever showed real data for radios someone
          // had manually forced a live read against — every other radio read
          // back blank/stale on page load even after hitting Refresh, despite
          // the write paths themselves working fine. Confirmed live (multiple
          // MmePoolConfigParam instances in one getParameterValues call) that
          // this table doesn't have the same multi-instance fragility
          // Carrier/LTECell do, so a plain bulk read across several slots is
          // safe here — this is a read-only GetParameterValues, not a
          // provision-triggered SetParameterValues reconciliation loop, so it
          // isn't subject to the commit-iteration limits that class of
          // problem came from anyway.
          ...[1, 2, 3, 4, 5, 6].flatMap(n => [
            `${FAP}CellConfig.LTE.EPC.PLMNList.${n}.PLMNID`,
            `${FAP}CellConfig.LTE.EPC.PLMNList.${n}.Enable`,
            `${FAP}CellConfig.LTE.MmePoolConfigParam.${n}.PLMNID`,
            `${FAP}CellConfig.LTE.MmePoolConfigParam.${n}.MMEIp1`,
            `${FAP}CellConfig.LTE.MmePoolConfigParam.${n}.MME1Status`,
          ]),
          `${FAP}FAPControl.LTE.Gateway.X_COM_MmePool.Enable`,
          `${FAP}FAPControl.LTE.Gateway.X_COM_MmePool.MmePool1List`,
          `${FAP}FAPControl.LTE.Gateway.X_COM_MmePool.MmePool2List`,
          `${FAP}FAPControl.LTE.Gateway.X_COM_MmePool.MmePoolListMapIpsecTunnel`,
          `${FAP}FAPControl.LTE.Gateway.X_COM_MmePool.MmePool1Status`,
          `${FAP}FAPControl.LTE.Gateway.X_COM_MmePool.MmePool2Status`,
          `${FAP}FAPControl.LTE.Gateway.S1SigLinkServerList`,
          `${FAP}CellConfig.LTE.RAN.RF.EARFCNDL`,
          `${FAP}CellConfig.LTE.RAN.RF.DLBandwidth`,
          `${FAP}CellConfig.LTE.RAN.RF.PhyCellID`,
          `${FAP}CellConfig.LTE.RAN.RF.FreqBandIndicator`,
          `${FAP}CellConfig.LTE.RAN.Common.CellIdentity`,
          `${FAP}Capabilities.MaxTxPower`,
          'Device.DeviceInfo.SAS.ServerUrl',
          'Device.DeviceInfo.SAS.UserId',
          'Device.DeviceInfo.SAS.FccId',
          'Device.DeviceInfo.SAS.CallSign',
          'Device.DeviceInfo.SAS.groupType',
          'Device.DeviceInfo.SAS.groupId',
          'Device.DeviceInfo.SAS.LegacyMode',
          'Device.DeviceInfo.SAS.RegistrationType',
          'Device.DeviceInfo.SAS.reqLowFrequency',
          'Device.DeviceInfo.SAS.reqHighFrequency',
          'Device.DeviceInfo.SAS.PreferredFrequency',
          'Device.DeviceInfo.SAS.PreferredBandwidth',
          'Device.DeviceInfo.SAS.PreferredPower',
          'Device.DeviceInfo.SAS.FrequencySelectionLogic',
          'Device.DeviceInfo.SAS.MaxEIRP',
          'Device.DeviceInfo.SAS.EirpCapability',
          'Device.DeviceInfo.SAS.enableMode',
        ],
      });
      // 202 = queued (delivered on next inform) — not a failure. Only a hard
      // non-2xx/non-202 status means the NBI itself rejected the task.
      if (gpv.status !== 202 && !gpv.ok) {
        logger.warn({ deviceId, status: gpv.status, text: gpv.text }, 'Baicells getParameterValues refresh returned non-ok — config fields may stay stale');
      }

      // LTE Freq/Cell neighbor tables (2026-08-16): each holds up to 8 UI rows,
      // backed by 8 numbered TR-069 object instances. Fired in the background
      // (not awaited) — see refreshBaicellsNeighborTables()'s own comment for
      // why this can take tens of seconds and must never block this response.
      refreshBaicellsNeighborTables(nbiUrl, deviceId, gpvUrl, logger).catch(err =>
        logger.error({ deviceId, err: String(err) }, 'Neighbor-table background refresh crashed')
      );

      res.json({ success: true, message: 'Connection request sent — device will inform shortly.' });
    } catch (err) {
      logger.error({ deviceId, err: String(err) }, 'Force refresh failed');
      res.status(502).json({ success: false, error: String(err) });
    }
  });

  // ── POST /api/genieacs/refresh-sercomm/:deviceId ─────────────────────────
  // Summons a Sercomm radio via connection_request + getParameterValues so
  // GenieACS fetches the latest param values from the radio immediately.
  // timeout=30000 makes GenieACS wait up to 30s for the radio to inform and
  // pick up the task, even if the connection_request itself fails (some radios
  // reset their CR password on reboot and the CPE-generated password is unknown).
  router.post('/refresh-sercomm/:deviceId', requireAdmin, async (req: Request, res: Response) => {
    const { deviceId } = req.params;
    const encodedId    = encodeDeviceId(deviceId);
    const SFAP_        = 'Device.Services.FAPService.1.';
    const taskUrl      = `${nbiUrl}/devices/${encodedId}/tasks?connection_request&timeout=30000`;
    try {
      const r = await nbiPost(taskUrl, {
        name: 'getParameterValues',
        parameterNames: [
          `${SFAP_}CellConfig.LTE.EPC.TAC`,
          `${SFAP_}CellConfig.LTE.EPC.PLMNList.1.PLMNID`,
          `${SFAP_}FAPControl.LTE.Gateway.S1SigLinkServerList`,
          `${SFAP_}CellConfig.LTE.RAN.RF.EARFCNDL`,
          `${SFAP_}CellConfig.LTE.RAN.RF.X_000E8F_EARFCNDL2`,
          `${SFAP_}CellConfig.LTE.RAN.RF.DLBandwidth`,
          `${SFAP_}CellConfig.LTE.RAN.RF.PhyCellID`,
          `${SFAP_}CellConfig.LTE.RAN.RF.FreqBandIndicator`,
          `${SFAP_}CellConfig.LTE.RAN.RF.X_000E8F_TxPowerConfig`,
          `${SFAP_}CellConfig.LTE.RAN.Common.CellIdentity`,
          `${SFAP_}CellConfig.LTE.RAN.Common.X_000E8F_CellIdentity2`,
          `${SFAP_}FAPControl.LTE.X_000E8F_RRMConfig.X_000E8F_CA_Enable`,
          `${SFAP_}FAPControl.LTE.X_000E8F_RRMConfig.X_000E8F_Cell_Number`,
          `${SFAP_}FAPControl.LTE.X_000E8F_SAS.Enable`,
          `${SFAP_}FAPControl.LTE.X_000E8F_SAS.Location`,
          `${SFAP_}FAPControl.LTE.X_000E8F_SAS.UserContactInformation`,
          `${SFAP_}REM.X_000E8F_tfcsManagerConfig.primSrc`,
          `${SFAP_}CellConfig.LTE.RAN.PHY.PDSCH.X_000E8F_Enable256QAM`,
          `${SFAP_}CellConfig.LTE.RAN.PHY.PUSCH.Enable64QAM`,
          'Device.FAP.GPS.LockedLatitude',
          'Device.FAP.GPS.LockedLongitude',
          'Device.IP.Interface.1.IPv4Address.1.IPAddress',
          'Device.X_000E8F_DeviceFeature.X_000E8F_NEStatus.X_000E8F_eNB_Status',
        ],
      });
      // 202 = task queued (success), even when status line says "Connection request error"
      // (some radios reset their CR password on reboot; tasks still deliver via periodic inform)
      if (r.status !== 202 && !r.ok) throw new Error(`refresh failed (${r.status}): ${r.text}`);
      res.json({ success: true, message: 'Sercomm parameters refreshed.' });
    } catch (err) {
      logger.error({ deviceId, err: String(err) }, 'Sercomm refresh failed');
      res.status(502).json({ success: false, error: String(err) });
    }
  });

  // ── POST /api/genieacs/reboot/:deviceId ──────────────────────────────────
  router.post('/reboot/:deviceId', requireAdmin, async (req: Request, res: Response) => {
    const { deviceId } = req.params;
    const user         = (req as any).user?.username ?? 'unknown';
    const encodedId    = encodeDeviceId(deviceId);
    const taskUrl      = `${nbiUrl}/devices/${encodedId}/tasks?timeout=30000&connection_request`;

    logger.info({ deviceId }, 'Rebooting radio');

    try {
      const r = await nbiPost(taskUrl, { name: 'reboot' });
      if (!r.ok) throw new Error(`Reboot failed (${r.status}): ${r.text}`);
      await auditLogger.log({ action: 'radio_reboot', user, target: deviceId, details: 'Single radio reboot', success: true });
      res.json({ success: true, message: 'Reboot task queued.' });
    } catch (err) {
      await auditLogger.log({ action: 'radio_reboot', user, target: deviceId, details: String(err), success: false });
      res.status(502).json({ success: false, error: String(err) });
    }
  });

  // ── POST /api/genieacs/mme-pool/:deviceId ────────────────────────────────
  // Saves the MME Pool table (PLMN + MME IP pairs, up to 16 rows). Unlike the
  // Carrier/LTECell neighbor tables, live writes to MmePoolConfigParam are
  // confirmed working with zero faults (2026-08-19) — this is a genuinely
  // different, much simpler object with no observed GenieACS session-limit
  // fragility, so a real write path is safe here. Body is the full desired
  // state; any of the 16 numbered instances not present in the submitted
  // array is cleared back to the device's own observed blank state
  // (PLMNID="000000", MMEIp1="0.0.0.0" — there's no Enable field on this
  // object, unlike PLMNList/neighbor tables). Diffs against the caller-
  // supplied original state and only writes indices that actually changed,
  // same pattern the neighbor-table save endpoint used before it was removed.
  router.post('/mme-pool/:deviceId', requireAdmin, async (req: Request, res: Response) => {
    const { deviceId } = req.params;
    const user         = (req as any).user?.username ?? 'unknown';
    const encodedId    = encodeDeviceId(deviceId);
    const taskUrl       = `${nbiUrl}/devices/${encodedId}/tasks?timeout=30000&connection_request`;
    const { entries, originalEntries } = req.body as { entries: MmePoolEntry[]; originalEntries?: MmePoolEntry[] };

    const validationErrors = validateMmePoolTable(entries ?? []);
    if (validationErrors.length > 0) {
      res.status(400).json({ success: false, error: `Validation failed: ${validationErrors.join('; ')}` });
      return;
    }

    const byIndex         = new Map<number, MmePoolEntry>((entries ?? []).map(e => [e.index, e]));
    const byIndexOriginal = new Map<number, MmePoolEntry>((originalEntries ?? []).map(e => [e.index, e]));

    try {
      const results: Array<{ index: number; ok: boolean; error?: string; skipped?: boolean }> = [];
      for (let n = 1; n <= MME_POOL_MAX_ENTRIES; n++) {
        const entry    = byIndex.get(n);
        const original = byIndexOriginal.get(n);
        const unchanged = (entry && original && entry.plmn === original.plmn && entry.mmeIp === original.mmeIp)
          || (!entry && !original);
        if (unchanged) {
          results.push({ index: n, ok: true, skipped: true });
          continue;
        }

        const base = MME_POOL_BASE(n);
        const parameterValues: [string, string, string][] = entry
          ? [[`${base}PLMNID`, entry.plmn, 'xsd:string'], [`${base}MMEIp1`, entry.mmeIp, 'xsd:string']]
          : [[`${base}PLMNID`, MME_POOL_BLANK_PLMN, 'xsd:string'], [`${base}MMEIp1`, MME_POOL_BLANK_IP, 'xsd:string']];
        const result = await nbiPost(taskUrl, { name: 'setParameterValues', parameterValues }).catch(() => null);
        const ok = !!result && (result.status === 202 || result.ok);
        results.push({ index: n, ok, error: ok ? undefined : (result?.text ?? 'request failed') });
      }

      const failed  = results.filter(r => !r.ok);
      const skipped = results.filter(r => r.skipped).length;
      const written = results.length - skipped;
      await auditLogger.log({
        action:  'radio_mme_pool',
        user,
        target:  deviceId,
        details: `Saved MME pool table (${entries?.length ?? 0} row(s)). ${written} instance write(s), ${skipped} unchanged/skipped, ${failed.length} failed.`,
        success: failed.length === 0,
      });
      res.json({ success: failed.length === 0, results });
    } catch (err) {
      await auditLogger.log({ action: 'radio_mme_pool', user, target: deviceId, details: String(err), success: false });
      res.status(502).json({ success: false, error: String(err) });
    }
  });

  // ── POST /api/genieacs/mme-pool-config/:deviceId ─────────────────────────
  // Saves MME Pool Config (X_COM_MmePool) — the IPsec-tunnel-binding
  // singleton, distinct from the MME Pool table above. Only 4 real
  // writable fields exist here (see MmePoolConfig / the comment above
  // getMmePoolConfig()); a blank pool list is written back as the device's
  // own observed blank sentinel "|", not an empty string, matching what was
  // directly observed on real hardware.
  router.post('/mme-pool-config/:deviceId', requireAdmin, async (req: Request, res: Response) => {
    const { deviceId } = req.params;
    const user         = (req as any).user?.username ?? 'unknown';
    const encodedId    = encodeDeviceId(deviceId);
    const taskUrl       = `${nbiUrl}/devices/${encodedId}/tasks?timeout=30000&connection_request`;
    const cfg = req.body as MmePoolConfig;

    const validationErrors = validateMmePoolConfig(cfg);
    if (validationErrors.length > 0) {
      res.status(400).json({ success: false, error: `Validation failed: ${validationErrors.join('; ')}` });
      return;
    }

    try {
      const parameterValues: [string, string, string][] = [
        [`${MME_POOL_CONFIG_BASE}Enable`,                     String(cfg.enable === 'true'),                          'xsd:boolean'],
        [`${MME_POOL_CONFIG_BASE}MmePool1List`,                cfg.pool1List || MME_POOL_CONFIG_BLANK_LIST,           'xsd:string'],
        [`${MME_POOL_CONFIG_BASE}MmePool2List`,                cfg.pool2List || MME_POOL_CONFIG_BLANK_LIST,           'xsd:string'],
        [`${MME_POOL_CONFIG_BASE}MmePoolListMapIpsecTunnel`,   cfg.ipsecTunnelMap,                                     'xsd:string'],
      ];
      const result = await nbiPost(taskUrl, { name: 'setParameterValues', parameterValues }).catch(() => null);
      const ok = !!result && (result.status === 202 || result.ok);

      await auditLogger.log({
        action:  'radio_mme_pool_config',
        user,
        target:  deviceId,
        details: `Saved MME Pool Config: enable=${cfg.enable}, pool1="${cfg.pool1List}", pool2="${cfg.pool2List}", ipsecMap="${cfg.ipsecTunnelMap}". ${ok ? 'ok' : (result?.text ?? 'request failed')}`,
        success: ok,
      });
      res.json({ success: ok, error: ok ? undefined : (result?.text ?? 'request failed') });
    } catch (err) {
      await auditLogger.log({ action: 'radio_mme_pool_config', user, target: deviceId, details: String(err), success: false });
      res.status(502).json({ success: false, error: String(err) });
    }
  });

  // NOTE: there is deliberately no write/save endpoint for the LTE Freq/Cell
  // neighbor tables — read-only by design. Every write attempt against
  // Carrier.{n}/LTECell.{n} on this device hit GenieACS-internal session
  // limits (`too_many_commits`, then `too_many_rpcs` after raising the first
  // one) regardless of how few fields were sent, tracing back to something
  // structural in how GenieACS reconciles this specific object tree with
  // this device — the same object tree where `deleteObject` and
  // `getParameterNames` also failed outright (see PROJECT_STATE.md,
  // 2026-08-17/19, for the full investigation). Reintroducing a write path
  // here should start from that history, not from scratch.

  // ── POST /api/genieacs/reboot-all ────────────────────────────────────────
  router.post('/reboot-all', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';

    try {
      const listResp = await fetch(`${nbiUrl}/devices?projection=_id`);
      if (!listResp.ok) throw new Error(`Failed to list devices: ${listResp.status}`);
      const devices = (await listResp.json()) as Record<string, any>[];

      const results = await Promise.allSettled(
        devices.map(async (d) => {
          const id        = d._id as string;
          const encodedId = encodeDeviceId(id);
          const taskUrl   = `${nbiUrl}/devices/${encodedId}/tasks?timeout=30000&connection_request`;
          const r         = await nbiPost(taskUrl, { name: 'reboot' });
          if (!r.ok) throw new Error(`${id}: reboot failed (${r.status})`);
          return id;
        }),
      );

      const failed  = results.filter(r => r.status === 'rejected').map(r => (r as PromiseRejectedResult).reason);
      const success = failed.length === 0;

      await auditLogger.log({
        action:  'radio_reboot_all',
        user,
        details: `Rebooted ${devices.length} radios. Failures: ${failed.length}`,
        success,
      });

      res.json({ success, rebooted: devices.length, failures: failed });
    } catch (err) {
      await auditLogger.log({ action: 'radio_reboot_all', user, details: String(err), success: false });
      res.status(502).json({ success: false, error: String(err) });
    }
  });

  // ── POST /api/genieacs/rf/:deviceId ──────────────────────────────────────
  router.post('/rf/:deviceId', requireAdmin, async (req: Request, res: Response) => {
    const { deviceId }       = req.params;
    const { enable }         = req.body as { enable: boolean };
    const user               = (req as any).user?.username ?? 'unknown';
    const encodedId          = encodeDeviceId(deviceId);
    const taskUrl            = `${nbiUrl}/devices/${encodedId}/tasks?timeout=30000&connection_request`;
    const action             = enable ? 'radio_rf_enable' : 'radio_rf_disable';

    logger.info({ deviceId, enable }, 'Setting RF on radio');

    try {
      // Check if SAS is enabled on this radio before deciding what to set
      const devResp = await fetch(`${nbiUrl}/devices?query=${encodeURIComponent(JSON.stringify({ _id: deviceId }))}&projection=${encodeURIComponent('Device.DeviceInfo.SAS.enableMode')}`);
      const devData = devResp.ok ? (await devResp.json()) as Record<string,any>[] : [];
      const sasEnableMode = devData[0]?.Device?.DeviceInfo?.SAS?.enableMode?._value;
      const sasEnabled = sasEnableMode != null && String(sasEnableMode) !== '0';

      const parameterValues: [string, string, string][] = [
        [`${FAP}CellConfig.LTE.RAN.RF.X_COM_RadioEnable`, String(enable), 'xsd:boolean'],
      ];
      if (sasEnabled) {
        parameterValues.push(['Device.DeviceInfo.SAS.RadioEnable', String(enable), 'xsd:boolean']);
      }

      const r = await nbiPost(taskUrl, { name: 'setParameterValues', parameterValues });
      if (!r.ok) throw new Error(`RF set failed (${r.status}): ${r.text}`);
      await auditLogger.log({ action, user, target: deviceId, details: `RF ${enable ? 'enabled' : 'disabled'}${sasEnabled ? ' (+ SAS.RadioEnable)' : ''}`, success: true });
      res.json({ success: true, message: `RF ${enable ? 'enabled' : 'disabled'}.` });
    } catch (err) {
      await auditLogger.log({ action, user, target: deviceId, details: String(err), success: false });
      res.status(502).json({ success: false, error: String(err) });
    }
  });

  // ── POST /api/genieacs/rf-all ─────────────────────────────────────────────
  router.post('/rf-all', requireAdmin, async (req: Request, res: Response) => {
    const { enable } = req.body as { enable: boolean };
    const user       = (req as any).user?.username ?? 'unknown';

    try {
      const listResp = await fetch(`${nbiUrl}/devices?projection=${encodeURIComponent('_id,_deviceId,Device.DeviceInfo.SAS.enableMode')}`);
      if (!listResp.ok) throw new Error(`Failed to list devices: ${listResp.status}`);
      const allDevices = (await listResp.json()) as Record<string, any>[];

      // Filter to Baicells only (OUI 48BF74) — Sercomm uses AdminState not X_COM_RadioEnable
      const baicellsDevices = allDevices.filter(d => {
        const oui = (d._deviceId?._OUI ?? d._id?.split('-')[0] ?? '').toUpperCase();
        const mfr = (d._deviceId?._Manufacturer ?? '').toLowerCase();
        return oui === '48BF74' || mfr.includes('baicells');
      });

      logger.info({ count: baicellsDevices.length, enable }, 'RF all — Baicells only');

      const results = await Promise.allSettled(
        baicellsDevices.map(async (d) => {
          const id          = d._id as string;
          const encodedId   = encodeDeviceId(id);
          const taskUrl     = `${nbiUrl}/devices/${encodedId}/tasks?timeout=30000&connection_request`;
          // Check SAS enableMode from the device data we already have
          const sasEnableMode = d?.Device?.DeviceInfo?.SAS?.enableMode?._value;
          const sasEnabled    = sasEnableMode != null && String(sasEnableMode) !== '0';
          const parameterValues: [string, string, string][] = [
            [`${FAP}CellConfig.LTE.RAN.RF.X_COM_RadioEnable`, String(enable), 'xsd:boolean'],
          ];
          if (sasEnabled) {
            parameterValues.push(['Device.DeviceInfo.SAS.RadioEnable', String(enable), 'xsd:boolean']);
          }
          const r = await nbiPost(taskUrl, { name: 'setParameterValues', parameterValues });
          if (!r.ok) throw new Error(`${id}: RF set failed (${r.status}): ${r.text}`);
          logger.info({ id, enable, sasEnabled, status: r.status }, 'RF set on Baicells radio');
          return id;
        }),
      );

      const failed  = results.filter(r => r.status === 'rejected').map(r => (r as PromiseRejectedResult).reason);
      const success = failed.length === 0;

      await auditLogger.log({
        action:  'radio_rf_all',
        user,
        details: `RF ${enable ? 'enabled' : 'disabled'} on ${baicellsDevices.length} Baicells radios. Failures: ${failed.length}`,
        success,
      });

      res.json({ success, affected: baicellsDevices.length, failures: failed });
    } catch (err) {
      await auditLogger.log({ action: 'radio_rf_all', user, details: String(err), success: false });
      res.status(502).json({ success: false, error: String(err) });
    }
  });

  // ── POST /api/genieacs/rf-sercomm/:deviceId ─────────────────────────────
  // Sercomm RF on/off via AdminState (not X_COM_RadioEnable)
  router.post('/rf-sercomm/:deviceId', requireAdmin, async (req: Request, res: Response) => {
    const { deviceId } = req.params;
    const { enable }   = req.body as { enable: boolean };
    const user         = (req as any).user?.username ?? 'unknown';
    const encodedId    = encodeDeviceId(deviceId);
    const taskUrl      = `${nbiUrl}/devices/${encodedId}/tasks?timeout=30000&connection_request`;
    const action       = enable ? 'radio_rf_enable' : 'radio_rf_disable';
    try {
      const r = await nbiPost(taskUrl, {
        name: 'setParameterValues',
        parameterValues: [[`${SFAP}FAPControl.LTE.AdminState`, enable ? '1' : '0', 'xsd:boolean']],
      });
      if (!r.ok) throw new Error(`RF set failed (${r.status}): ${r.text}`);
      await auditLogger.log({ action, user, target: deviceId, details: `Sercomm AdminState ${enable ? '1' : '0'}`, success: true });
      res.json({ success: true, message: `RF ${enable ? 'enabled' : 'disabled'}.` });
    } catch (err) {
      await auditLogger.log({ action, user, target: deviceId, details: String(err), success: false });
      res.status(502).json({ success: false, error: String(err) });
    }
  });

  // ── POST /api/genieacs/rf-sercomm-all ────────────────────────────────────
  // RF on/off for all Sercomm devices via AdminState
  router.post('/rf-sercomm-all', requireAdmin, async (req: Request, res: Response) => {
    const { enable } = req.body as { enable: boolean };
    const user       = (req as any).user?.username ?? 'unknown';
    try {
      const listResp = await fetch(`${nbiUrl}/devices?projection=_id,_deviceId`);
      if (!listResp.ok) throw new Error(`Failed to list devices: ${listResp.status}`);
      const allDevices = (await listResp.json()) as Record<string, any>[];
      const sercommDevices = allDevices.filter(d => {
        const oui = (d._deviceId?._OUI ?? d._id?.split('-')[0] ?? '').toUpperCase();
        const mfr = (d._deviceId?._Manufacturer ?? '').toLowerCase();
        return (oui === '000E8F' || mfr.includes('sercomm') || mfr.includes('freedomfi'))
          && oui !== '00C002';
      });
      const results = await Promise.allSettled(
        sercommDevices.map(async (d) => {
          const id        = d._id as string;
          const encodedId = encodeDeviceId(id);
          const taskUrl   = `${nbiUrl}/devices/${encodedId}/tasks?timeout=30000&connection_request`;
          const r         = await nbiPost(taskUrl, {
            name: 'setParameterValues',
            parameterValues: [[`${SFAP}FAPControl.LTE.AdminState`, enable ? '1' : '0', 'xsd:boolean']],
          });
          if (!r.ok) throw new Error(`${id}: RF set failed (${r.status})`);
          return id;
        }),
      );
      const failed  = results.filter(r => r.status === 'rejected').map(r => (r as PromiseRejectedResult).reason);
      const success = failed.length === 0;
      await auditLogger.log({ action: 'radio_rf_all', user, details: `Sercomm RF ${enable ? 'on' : 'off'} on ${sercommDevices.length} radios. Failures: ${failed.length}`, success });
      res.json({ success, affected: sercommDevices.length, failures: failed });
    } catch (err) {
      await auditLogger.log({ action: 'radio_rf_all', user, details: String(err), success: false });
      res.status(502).json({ success: false, error: String(err) });
    }
  });

  // ── GET /api/genieacs/backups/:deviceId ───────────────────────────────────
  router.get('/backups/:deviceId', (req: Request, res: Response) => {
    const { deviceId } = req.params;
    const dir          = radioBackupDir(backupRoot, deviceId);

    try {
      if (!fs.existsSync(dir)) return res.json({ success: true, backups: [] });
      const files = fs.readdirSync(dir)
        .filter(f => f.endsWith('.json'))
        .sort()
        .reverse()
        .map(f => ({ filename: f, deviceId }));
      res.json({ success: true, backups: files });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // ── GET /api/genieacs/backups/:deviceId/:filename ─────────────────────────
  router.get('/backups/:deviceId/:filename', (req: Request, res: Response) => {
    const { deviceId, filename } = req.params;
    if (!filename.endsWith('.json') || filename.includes('..') || filename.includes('/')) {
      return res.status(400).json({ success: false, error: 'Invalid filename' });
    }
    const filePath = path.join(radioBackupDir(backupRoot, deviceId), filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ success: false, error: 'Backup not found' });

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    fs.createReadStream(filePath).pipe(res);
  });

  // ── POST /api/genieacs/backup/:deviceId ───────────────────────────────────
  router.post('/backup/:deviceId', requireAdmin, async (req: Request, res: Response) => {
    const { deviceId } = req.params;
    try {
      const filename = await backupDeviceById(nbiUrl, backupRoot, deviceId);
      res.json({ success: true, filename });
    } catch (err) {
      res.status(502).json({ success: false, error: String(err) });
    }
  });

  return router;
}
