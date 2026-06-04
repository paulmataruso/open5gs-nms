import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import pino from 'pino';
import { IAuditLogger } from '../../domain/interfaces/audit-logger';

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

// ─── Sercomm types & param builder ──────────────────────────────────────────────────────────
const SFAP = 'Device.Services.FAPService.1.';

interface SercommProvisionInput {
  mcc: string; mnc: string; tac: string;
  mmeIp: string;
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
  sasPeerCertVerify: boolean;
  latitude: string;
  longitude: string;
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
    [`${SFAP}CellConfig.LTE.EPC.PLMNList.1.X_000E8F_CFG_MMEIdList`,             '{1}',        'xsd:string'      ],
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
    // Carrier 2 EARFCNs — only push when earfcn2 is set (CA mode)
    // Empty string as xsd:int causes faultCode 9007 and aborts the entire task
    ...(input.earfcn2 ? [
      [`${SFAP}CellConfig.LTE.RAN.RF.X_000E8F_EARFCNDL2`,  input.earfcn2, 'xsd:int'] as [string,string,string],
      [`${SFAP}CellConfig.LTE.RAN.RF.X_000E8F_EARFCNUL2`,  input.earfcn2, 'xsd:int'] as [string,string,string],
    ] : []),
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
    [`${SFAP}REM.X_000E8F_tfcsManagerConfig.ntpSyncEnable`,                      '1',                              'xsd:boolean'],

    // ── CA (CarrierAggregationParameters) ─────────────────────────────────
    // NOTE: CA_Enable and Cell_Number are intentionally NOT set here.
    // They are sent in postRebootParams (Task 2) after the self-reboot
    // so they are committed to flash correctly.

    // ── SAS ExtendFreqA (CA mode — auto-select channel and bandwidth per carrier) ─
    // Must always be True for the radio to work correctly, regardless of CA setting
    [`${SFAP}FAPControl.LTE.X_000E8F_SAS.ExtendFreqA.Enable`,                  'True',                            'xsd:boolean'],
    [`${SFAP}FAPControl.LTE.X_000E8F_SAS.ExtendFreqA.AutoSelectChannelAndBandwidth`, 'True',                       'xsd:boolean'],

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
    // NOTE: Device.FAP.GPS.LockedLatitude/Longitude and LocationInfoInUse_Lat/Long
    // are read-only status fields — do NOT write to them (9002 Internal error)
    // Location is set via X_000E8F_SAS.HighAccuracyLatitude/Longitude above
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
    [`${FAP}CellConfig.LTE.RAN.RF.X_COM_RadioEnable`,                       'true',  'xsd:boolean'     ],
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
    ['Device.ManagementServer.PeriodicInformInterval',                      '5',     'xsd:unsignedInt' ],
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
    ['Device.DeviceInfo.SAS.reqLowFrequency',         input.sasReqLowFrequency,                         'xsd:unsignedInt'],
    ['Device.DeviceInfo.SAS.reqHighFrequency',        input.sasReqHighFrequency,                        'xsd:unsignedInt'],
    ['Device.DeviceInfo.SAS.PreferredBandwidth',      input.sasPreferredBandwidth,                      'xsd:string'   ],
    ['Device.DeviceInfo.SAS.PreferredPower',          input.sasPreferredPower,                          'xsd:int'      ],
    ['Device.DeviceInfo.SAS.FrequencySelectionLogic', input.sasFrequencySelectionLogic,                 'xsd:string'   ],
    ['Device.DeviceInfo.SAS.MaxEIRP',                 input.sasMaxEIRP,                                 'xsd:unsignedInt'],
    ['Device.DeviceInfo.SAS.EirpCapability',          input.sasEirpCapability,                          'xsd:int'      ],
    ...(input.sasPreferredFrequency ? [['Device.DeviceInfo.SAS.PreferredFrequency', input.sasPreferredFrequency, 'xsd:unsignedInt'] as [string, string, string]] : []),
  ];

  return [
    { url: taskUrl, body: { name: 'setParameterValues', parameterValues: params } },
    { url: taskUrl, body: { name: 'reboot' } },
    // X_COM_RadioEnable resets to false on every boot — must be re-set after reboot
    // SAS.RadioEnable also resets — only set it if SAS is enabled
    {
      url:  taskUrl,
      body: {
        name: 'setParameterValues',
        parameterValues: [
          [`${FAP}CellConfig.LTE.RAN.RF.X_COM_RadioEnable`, 'true', 'xsd:boolean'],
          ...(input.sasEnableMode !== '0' ? [['Device.DeviceInfo.SAS.RadioEnable', 'true', 'xsd:boolean'] as [string,string,string]] : []),
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

function toRadio(device: Record<string, any>) {
  const serial     = device._id ?? 'unknown';
  const plmn       = getParam(device, `${FAP}CellConfig.LTE.EPC.PLMNList.1.PLMNID`);
  const mcc        = plmn.length >= 3 ? plmn.slice(0, 3) : '';
  const mnc        = plmn.length >  3 ? plmn.slice(3)    : '';
  const lastInform = device._lastInform ?? null;
  const opState    = getParam(device, `${FAP}FAPControl.LTE.OpState`);
  const rfEnable   = getParam(device, `${FAP}CellConfig.LTE.RAN.RF.X_COM_RadioEnable`);
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const isOnline   = lastInform && lastInform > fiveMinAgo;

  const rfStatus: 'on' | 'off' | 'offline' =
    !isOnline                                   ? 'offline' :
    rfEnable === 'true' && opState === 'true'   ? 'on'      : 'off';

  return {
    id:           serial,
    serial,
    lastInform,
    ip:           getParam(device, 'Device.IP.Interface.1.IPv4Address.1.IPAddress'),
    rfStatus,
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

// ─── Radio backup helpers ─────────────────────────────────────────────────────
function radioBackupDir(backupRoot: string, deviceId: string): string {
  const safe = deviceId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(backupRoot, 'radio-backups', safe);
}

async function saveRadioBackup(backupRoot: string, deviceId: string, data: Record<string, any>): Promise<string> {
  const dir      = radioBackupDir(backupRoot, deviceId);
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(data, null, 2));
  return filename;
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
        `${SERCOMM_FAP}REM.X_000E8F_tfcsManagerConfig.primSrc`,
        'Device.FAP.GPS.LockedLatitude',
        'Device.FAP.GPS.LockedLongitude',
        'Device.X_000E8F_DeviceFeature.X_000E8F_NEStatus.X_000E8F_eNB_Status',
        'Device.X_000E8F_DeviceFeature.X_000E8F_NEStatus.X_000E8F_S1_Status',
        'Device.IP.Interface.1.IPv4Address.1.IPAddress',
      ].join(',');

      const resp = await fetch(`${nbiUrl}/devices?projection=${encodeURIComponent(projection)}`);
      if (!resp.ok) throw new Error(`GenieACS NBI returned HTTP ${resp.status}`);

      const devices = (await resp.json()) as Record<string, any>[];

      // Filter to Sercomm/FreedomFi by OUI from _deviceId (000E8F)
      // Can't rely on Device.DeviceInfo.Manufacturer — Baicells doesn't populate it
      const sercommDevices = devices.filter(d => {
        const oui = (d._deviceId?._OUI ?? d._id?.split('-')[0] ?? '').toUpperCase();
        const mfr = (d._deviceId?._Manufacturer ?? getParam(d, 'Device.DeviceInfo.Manufacturer')).toLowerCase();
        return oui === '000E8F' || mfr.includes('sercomm') || mfr.includes('freedomfi') || mfr.includes('moso');
      });

      const radios = sercommDevices.map(d => {
        const serial   = d._id ?? 'unknown';
        const plmn     = getParam(d, `${SERCOMM_FAP}CellConfig.LTE.EPC.PLMNList.1.PLMNID`);
        const mcc      = plmn.length >= 3 ? plmn.slice(0, 3) : '';
        const mnc      = plmn.length >  3 ? plmn.slice(3)    : '';
        const lastInform = d._lastInform ?? null;
        const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
        const isOnline   = lastInform && lastInform > fiveMinAgo;
        const enbStatus  = getParam(d, 'Device.X_000E8F_DeviceFeature.X_000E8F_NEStatus.X_000E8F_eNB_Status');
        const rfStatus: 'on' | 'off' | 'offline' =
          !isOnline ? 'offline' : enbStatus.toUpperCase() === 'SUCCESS' ? 'on' : 'off';

        return {
          id: serial, serial, lastInform, rfStatus,
          ip:           getParam(d, 'Device.IP.Interface.1.IPv4Address.1.IPAddress'),
          mcc, mnc,
          tac:          getParam(d, `${SERCOMM_FAP}CellConfig.LTE.EPC.TAC`),
          mmeIp:        getParam(d, `${SERCOMM_FAP}FAPControl.LTE.Gateway.S1SigLinkServerList`),
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
          latitude:     getParam(d, 'Device.FAP.GPS.LockedLatitude'),
          longitude:    getParam(d, 'Device.FAP.GPS.LockedLongitude'),
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
  router.post('/preview-sercomm/:deviceId', (req: Request, res: Response) => {
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
        `${FAP}CellConfig.LTE.EPC.PLMNList.1.PLMNID`,
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

      res.json({ success: true, devices: baicellsDevices.map(toRadio) });
    } catch (err) {
      logger.error({ err: String(err) }, 'Failed to fetch GenieACS devices');
      res.status(502).json({ success: false, error: `GenieACS NBI unreachable: ${String(err)}` });
    }
  });

  // ── POST /api/genieacs/preview/:deviceId ─────────────────────────────────
  // Returns the three NBI task bodies that would be sent — without sending them.
  router.post('/preview/:deviceId', (req: Request, res: Response) => {
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
  router.post('/execute-tasks', async (req: Request, res: Response) => {
    const { deviceId, tasks } = req.body as { deviceId: string; tasks: NbiTask[] };
    const user = (req as any).user?.username ?? 'unknown';

    if (!deviceId || !Array.isArray(tasks) || tasks.length === 0) {
      return res.status(400).json({ success: false, error: 'deviceId and tasks array required' });
    }

    const results: { task: number; ok: boolean; status: number; response: string }[] = [];

    try {
      for (let i = 0; i < tasks.length; i++) {
        const { url, body } = tasks[i];
        const r = await nbiPost(url, body);
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
        const backupResp = await fetch(`${nbiUrl}/devices?query=${encodeURIComponent(JSON.stringify({ _id: deviceId }))}`)
        if (backupResp.ok) {
          const devices = (await backupResp.json()) as Record<string, any>[];
          if (devices && devices.length > 0) {
            await saveRadioBackup(backupRoot, deviceId, devices[0]);
          }
        }
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
  router.post('/refresh/:deviceId', async (req: Request, res: Response) => {
    const { deviceId } = req.params;
    const encodedId    = encodeDeviceId(deviceId);
    const taskUrl      = `${nbiUrl}/devices/${encodedId}/tasks?connection_request`;

    try {
      const r = await nbiPost(taskUrl, {
        name: 'getParameterValues',
        parameterNames: [
          `${FAP}CellConfig.LTE.EPC.TAC`,
          `${FAP}CellConfig.LTE.EPC.PLMNList.1.PLMNID`,
          `${FAP}FAPControl.LTE.Gateway.S1SigLinkServerList`,
          `${FAP}FAPControl.LTE.Gateway.MmeIpPlmnList`,
          `${FAP}FAPControl.LTE.Gateway.ExistPlmnidList`,
          `${FAP}FAPControl.LTE.OpState`,
          `${FAP}FAPControl.LTE.RFTxStatus`,
          `${FAP}CellConfig.LTE.RAN.RF.EARFCNDL`,
          `${FAP}CellConfig.LTE.RAN.RF.EARFCNUL`,
          `${FAP}CellConfig.LTE.RAN.RF.DLBandwidth`,
          `${FAP}CellConfig.LTE.RAN.RF.ULBandwidth`,
          `${FAP}CellConfig.LTE.RAN.RF.PhyCellID`,
          `${FAP}CellConfig.LTE.RAN.RF.FreqBandIndicator`,
          `${FAP}CellConfig.LTE.RAN.RF.X_COM_RadioEnable`,
          `${FAP}CellConfig.LTE.RAN.Common.CellIdentity`,
          `${FAP}Capabilities.MaxTxPower`,
          'Device.IP.Interface.1.IPv4Address.1.IPAddress',
          'Device.DeviceInfo.SoftwareVersion',
          'Device.DeviceInfo.X_COM_MME_Status',
        ],
      });
      if (!r.ok) throw new Error(`connection_request failed (${r.status}): ${r.text}`);
      res.json({ success: true, message: 'Connection request sent — device will inform shortly.' });
    } catch (err) {
      logger.error({ deviceId, err: String(err) }, 'Force refresh failed');
      res.status(502).json({ success: false, error: String(err) });
    }
  });

  // ── POST /api/genieacs/reboot/:deviceId ──────────────────────────────────
  router.post('/reboot/:deviceId', async (req: Request, res: Response) => {
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

  // ── POST /api/genieacs/reboot-all ────────────────────────────────────────
  router.post('/reboot-all', async (req: Request, res: Response) => {
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
  router.post('/rf/:deviceId', async (req: Request, res: Response) => {
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
  router.post('/rf-all', async (req: Request, res: Response) => {
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
  router.post('/rf-sercomm/:deviceId', async (req: Request, res: Response) => {
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
  router.post('/rf-sercomm-all', async (req: Request, res: Response) => {
    const { enable } = req.body as { enable: boolean };
    const user       = (req as any).user?.username ?? 'unknown';
    try {
      const listResp = await fetch(`${nbiUrl}/devices?projection=_id,_deviceId`);
      if (!listResp.ok) throw new Error(`Failed to list devices: ${listResp.status}`);
      const allDevices = (await listResp.json()) as Record<string, any>[];
      const sercommDevices = allDevices.filter(d => {
        const oui = (d._deviceId?._OUI ?? d._id?.split('-')[0] ?? '').toUpperCase();
        const mfr = (d._deviceId?._Manufacturer ?? '').toLowerCase();
        return oui === '000E8F' || mfr.includes('sercomm') || mfr.includes('freedomfi');
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
  router.post('/backup/:deviceId', async (req: Request, res: Response) => {
    const { deviceId } = req.params;
    try {
      // Use the NBI devices list with a query filter to avoid ID encoding issues
      const resp = await fetch(`${nbiUrl}/devices?query=${encodeURIComponent(JSON.stringify({ _id: deviceId }))}`)
      if (!resp.ok) throw new Error(`NBI returned ${resp.status}`);
      const devices = (await resp.json()) as Record<string, any>[];
      if (!devices || devices.length === 0) throw new Error(`Device not found: ${deviceId}`);
      const filename = await saveRadioBackup(backupRoot, deviceId, devices[0]);
      res.json({ success: true, filename });
    } catch (err) {
      res.status(502).json({ success: false, error: String(err) });
    }
  });

  return router;
}
