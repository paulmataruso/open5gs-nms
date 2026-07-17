import { Router, Request, Response } from 'express';
import pino from 'pino';
import { IAuditLogger } from '../../domain/interfaces/audit-logger';
import { requireAdmin } from './middleware/auth-middleware';
import { backupDeviceById } from './radio-backup';

const GNB = 'Device.Services.FAPService.1.X_00C002_gNB';
const SAS = 'Device.Services.SAS';

function getVal(obj: Record<string, any>, dotPath: string): string {
  const parts = dotPath.split('.');
  let node: any = obj;
  for (const p of parts) {
    if (node == null) return '';
    node = node[p];
  }
  return node?._value != null ? String(node._value) : '';
}

function encodeId(deviceId: string): string {
  return encodeURIComponent(deviceId);
}

function toNRDevice(d: Record<string, any>) {
  const plmn      = getVal(d, `${GNB}.CU.GNBCUFunction.NRCellCU.1.plmnIdList.1.PLMNID`);
  const gnbId     = getVal(d, `${GNB}.CU.GNBCUFunction.gNBId`);
  const tac       = getVal(d, `${GNB}.CU.GNBCUFunction.NRCellCU.1.TAC`);
  const amfIp     = getVal(d, `${GNB}.CU.GNBCUFunction.EP_NgC.remoteAddress.ipv4Address`);
  const upfIp     = getVal(d, `${GNB}.CU.GNBCUFunction.EP_NgU.remoteAddress.ipv4Address`);
  const adminState  = getVal(d, `${GNB}.DU.1.GNBDUFunction.NRCellDU.1.adminState`);
  const pci         = getVal(d, `${GNB}.DU.1.GNBDUFunction.NRCellDU.1.nRPCI`);
  const encAlg      = getVal(d, `${GNB}.CU.GNBCUFunction.NRCellCU.1.encAlg`);
  const intAlg      = getVal(d, `${GNB}.CU.GNBCUFunction.NRCellCU.1.intAlg`);
  const nrPci       = getVal(d, `${GNB}.DU.1.GNBDUFunction.NRCellDU.1.nrPci`);
  const nrArfcn     = getVal(d, `${GNB}.DU.1.GNBDUFunction.NRCellDU.1.freqConfig.arfcnDL`);
  const nrBandWidth = getVal(d, `${GNB}.DU.1.GNBDUFunction.NRCellDU.1.freqConfig.nrBandWidth`);
  const nrFreqBand  = getVal(d, `${GNB}.DU.1.GNBDUFunction.NRCellDU.1.freqConfig.nrFreqBand`);
  const nrArfcn2    = getVal(d, `${GNB}.DU.1.GNBDUFunction.NRCellDU.2.freqConfig.arfcnDL`);
  const nrPci2      = getVal(d, `${GNB}.DU.1.GNBDUFunction.NRCellDU.2.nrPci`);
  const nrArfcn3    = getVal(d, `${GNB}.DU.1.GNBDUFunction.NRCellDU.3.freqConfig.arfcnDL`);
  const nrPci3      = getVal(d, `${GNB}.DU.1.GNBDUFunction.NRCellDU.3.nrPci`);
  const txPwr       = getVal(d, `${GNB}.DU.1.GNBDUFunction.NRCellDU.1.TxPwr`);
  const prachCfgIdx = getVal(d, `${GNB}.DU.1.GNBDUFunction.NRCellDU.1.prachConfig.prachCfgIdx`);
  const numDlSlot   = getVal(d, `${GNB}.CU.GNBCUFunction.TimeSlotConfiguration.numDlSlot`);
  const numUlSlot   = getVal(d, `${GNB}.CU.GNBCUFunction.TimeSlotConfiguration.numUlSlot`);
  const numDlSymbol = getVal(d, `${GNB}.CU.GNBCUFunction.TimeSlotConfiguration.numDlSymbol`);
  const numUlSymbol = getVal(d, `${GNB}.CU.GNBCUFunction.TimeSlotConfiguration.numUlSymbol`);
  // TDD pattern 2 — some named presets (verified: "8:2 FR1.30-4") require a second
  // pattern appended after pattern 1. See memory sercomm-nr-tdd-slot-patterns.
  const np2Pres      = getVal(d, `${GNB}.CU.GNBCUFunction.TimeSlotConfiguration.np2Pres`);
  const numDlSlot2   = getVal(d, `${GNB}.CU.GNBCUFunction.TimeSlotConfiguration.numDlSlot2`);
  const numUlSlot2   = getVal(d, `${GNB}.CU.GNBCUFunction.TimeSlotConfiguration.numUlSlot2`);
  const numDlSymbolP2 = getVal(d, `${GNB}.CU.GNBCUFunction.TimeSlotConfiguration.numDlSymbolP2`);
  const numUlSymbolP2 = getVal(d, `${GNB}.CU.GNBCUFunction.TimeSlotConfiguration.numUlSymbolP2`);
  const gNBCUName   = getVal(d, `${GNB}.CU.GNBCUFunction.gNBCUName`);
  const maxNumUes   = getVal(d, `${GNB}.CU.GNBCUFunction.gnbCuConfig.maxNumUes`);
  const antennaGain      = getVal(d, `${SAS}.configuration.antennaGain`);
  const antennaAzimuth   = getVal(d, `${SAS}.configuration.antennaAzimuth`);
  const antennaBeamwidth = getVal(d, `${SAS}.configuration.antennaBeamwidth`);
  const antennaDowntilt  = getVal(d, `${SAS}.configuration.antennaDowntilt`);
  const sasMaxTxPower    = getVal(d, `${SAS}.configuration.maxTxPower`);

  // sNSSAI is encoded as (sst << 24) | sd_int — decode to human-friendly parts
  const sNSSAIRaw = getVal(d, `${GNB}.CU.GNBCUFunction.NRCellCU.1.sNSSAI`);
  let snssaiSst = 1, snssaiSd = '000001';
  if (sNSSAIRaw) {
    const n = parseInt(sNSSAIRaw, 10);
    if (!isNaN(n) && n > 0) {
      snssaiSst = (n >>> 24) & 0xFF;
      snssaiSd  = (n & 0xFFFFFF).toString(16).padStart(6, '0');
    }
  }

  const sasEnable     = getVal(d, `${SAS}.Enable`);
  const sasUrl        = getVal(d, `${SAS}.configuration.serverURL`);
  const sasLat        = getVal(d, `${SAS}.locationConfiguration.latitude`);
  const sasLon        = getVal(d, `${SAS}.locationConfiguration.longitude`);
  const sasCategory   = getVal(d, `${SAS}.configuration.cbsdCategory`);
  const sasLocation   = getVal(d, `${SAS}.locationConfiguration.location`);
  const sasHeightType = getVal(d, `${SAS}.locationConfiguration.heightType`);
  const sasGroupId    = getVal(d, `${SAS}.configuration.groupParamGroupID`);
  const sasPeerVerify = getVal(d, `${SAS}.configuration.sasPeerVerifyEnable`);
  const bwAllowList   = getVal(d, `${SAS}.freqAController.bwAllowList`);
  const sasCellNum    = getVal(d, `${SAS}.configuration.cellNum`);
  const sasState      = getVal(d, `${SAS}.sasState`);
  const sasReg        = getVal(d, `${SAS}.statusInfo.sasRegistered`);
  const sasCbsdId     = getVal(d, `${SAS}.statusInfo.sasCBSDID`);
  const sasArfcn      = getVal(d, `${SAS}.statusInfo.sasGrantedEarfcnDL`);
  const sasArfcn2     = getVal(d, `${SAS}.statusInfo.sasGrantedEarfcnDL2`);
  const sasArfcn3     = getVal(d, `${SAS}.statusInfo.sasGrantedEarfcnDL3`);
  const sasStatus     = getVal(d, `${SAS}.statusInfo.sasStatus`);

  const lastInform  = d._lastInform ?? null;
  const crUrl       = getVal(d, 'Device.ManagementServer.ConnectionRequestURL');
  const ip          = crUrl ? (new URL(crUrl)).hostname : null;
  const model       = getVal(d, 'Device.DeviceInfo.ModelName') || (d._deviceId?._ProductClass ?? 'SCE5164');
  const mac         = getVal(d, 'Device.Ethernet.Interface.1.MACAddress') || null;

  return {
    id:         d._id ?? 'unknown',
    serial:     d._deviceId?._SerialNumber ?? d._id?.split('-').pop() ?? 'unknown',
    model,
    ip:         ip || null,
    mac:        mac || null,
    lastInform,
    nrConfig: {
      plmn,
      gnbId:      gnbId ? Number(gnbId) : 1,
      tac:        tac   ? Number(tac)   : 1,
      amfIp,
      upfIp,
      adminState:       adminState || 'LOCKED',
      pci:              pci || null,
      encAlg:           encAlg || null,
      intAlg:           intAlg || null,
      nrPci:            nrPci || null,
      nrArfcn:          nrArfcn || null,
      nrArfcn2:         nrArfcn2 || null,
      nrPci2:           nrPci2 || null,
      nrArfcn3:         nrArfcn3 || null,
      nrPci3:           nrPci3 || null,
      nrBandWidth:      nrBandWidth || null,
      nrFreqBand:       nrFreqBand || null,
      txPwr:            txPwr || null,
      prachCfgIdx:      prachCfgIdx || null,
      numDlSlot:        numDlSlot || null,
      numUlSlot:        numUlSlot || null,
      numDlSymbol:      numDlSymbol || null,
      numUlSymbol:      numUlSymbol || null,
      np2Pres:          np2Pres || null,
      numDlSlot2:       numDlSlot2 || null,
      numUlSlot2:       numUlSlot2 || null,
      numDlSymbolP2:    numDlSymbolP2 || null,
      numUlSymbolP2:    numUlSymbolP2 || null,
      snssaiSst,
      snssaiSd,
      gNBCUName:        gNBCUName || null,
      maxNumUes:        maxNumUes || null,
      antennaGain:      antennaGain || null,
      antennaAzimuth:   antennaAzimuth || null,
      antennaBeamwidth: antennaBeamwidth || null,
      antennaDowntilt:  antennaDowntilt || null,
      sasMaxTxPower:    sasMaxTxPower || null,
    },
    sasConfig: {
      enable:    sasEnable === 'true' || sasEnable === '1',
      url:       sasUrl,
      latitude:  sasLat  ? Number(sasLat)  / 1_000_000 : 0,
      longitude: sasLon  ? Number(sasLon)  / 1_000_000 : 0,
      category:  sasCategory   || 'A',
      location:  sasLocation   || 'indoor',
      heightType: sasHeightType || 'AGL',
      groupId:    sasGroupId    || '',
      peerVerify: sasPeerVerify === 'true',
      bwAllowList: bwAllowList || '100,40,20,10',
      cellNum:    sasCellNum ? Number(sasCellNum) : null,
    },
    sasStatus: {
      state:         sasState,
      registered:    sasReg,
      cbsdId:        sasCbsdId,
      grantedArfcn:  sasArfcn,
      grantedArfcn2: sasArfcn2,
      grantedArfcn3: sasArfcn3,
      sasStatus,
    },
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

export function createSercommNRRouter(
  nbiUrl:      string,
  logger:      pino.Logger,
  auditLogger: IAuditLogger,
  backupRoot:  string,
): Router {
  const router = Router();

  // GET /api/femto/nr/devices
  router.get('/devices', requireAdmin, async (_req: Request, res: Response) => {
    try {
      const projection = [
        '_id', '_lastInform', '_deviceId',
        'Device.DeviceInfo.ModelName',
        'Device.ManagementServer.ConnectionRequestURL',
        `${GNB}.CU.GNBCUFunction.gNBId`,
        `${GNB}.CU.GNBCUFunction.gNBIdLength`,
        `${GNB}.CU.GNBCUFunction.NRCellCU.1.plmnIdList.1.PLMNID`,
        `${GNB}.CU.GNBCUFunction.NRCellCU.1.TAC`,
        `${GNB}.CU.GNBCUFunction.NRCellCU.1.nCGI`,
        `${GNB}.CU.GNBCUFunction.NRCellCU.1.encAlg`,
        `${GNB}.CU.GNBCUFunction.NRCellCU.1.intAlg`,
        `${GNB}.CU.GNBCUFunction.NRCellCU.1.sNSSAI`,
        `${GNB}.CU.GNBCUFunction.EP_NgC.remoteAddress.ipv4Address`,
        `${GNB}.CU.GNBCUFunction.EP_NgU.remoteAddress.ipv4Address`,
        `${GNB}.CU.GNBCUFunction.gNBCUName`,
        `${GNB}.CU.GNBCUFunction.gnbCuConfig.maxNumUes`,
        `${GNB}.CU.GNBCUFunction.TimeSlotConfiguration.numDlSlot`,
        `${GNB}.CU.GNBCUFunction.TimeSlotConfiguration.numUlSlot`,
        `${GNB}.CU.GNBCUFunction.TimeSlotConfiguration.numDlSymbol`,
        `${GNB}.CU.GNBCUFunction.TimeSlotConfiguration.numUlSymbol`,
        `${GNB}.CU.GNBCUFunction.TimeSlotConfiguration.np2Pres`,
        `${GNB}.CU.GNBCUFunction.TimeSlotConfiguration.numDlSlot2`,
        `${GNB}.CU.GNBCUFunction.TimeSlotConfiguration.numUlSlot2`,
        `${GNB}.CU.GNBCUFunction.TimeSlotConfiguration.numDlSymbolP2`,
        `${GNB}.CU.GNBCUFunction.TimeSlotConfiguration.numUlSymbolP2`,
        `${GNB}.DU.1.GNBDUFunction.NRCellDU.1.adminState`,
        `${GNB}.DU.1.GNBDUFunction.NRCellDU.1.nRPCI`,
        `${GNB}.DU.1.GNBDUFunction.NRCellDU.1.nrPci`,
        `${GNB}.DU.1.GNBDUFunction.NRCellDU.1.freqConfig.arfcnDL`,
        `${GNB}.DU.1.GNBDUFunction.NRCellDU.1.freqConfig.nrBandWidth`,
        `${GNB}.DU.1.GNBDUFunction.NRCellDU.1.freqConfig.nrFreqBand`,
        `${GNB}.DU.1.GNBDUFunction.NRCellDU.2.freqConfig.arfcnDL`,
        `${GNB}.DU.1.GNBDUFunction.NRCellDU.2.nrPci`,
        `${GNB}.DU.1.GNBDUFunction.NRCellDU.3.freqConfig.arfcnDL`,
        `${GNB}.DU.1.GNBDUFunction.NRCellDU.3.nrPci`,
        `${GNB}.DU.1.GNBDUFunction.NRCellDU.1.TxPwr`,
        `${GNB}.DU.1.GNBDUFunction.NRCellDU.1.prachConfig.prachCfgIdx`,
        `${GNB}.DU.1.GNBDUFunction.NRCellDU.1.plmnIdList.1.PLMNID`,
        `${SAS}.Enable`,
        `${SAS}.configuration.serverURL`,
        `${SAS}.configuration.sasPeerVerifyEnable`,
        `${SAS}.configuration.cbsdCategory`,
        `${SAS}.configuration.groupParamGroupID`,
        `${SAS}.configuration.cellNum`,
        `${SAS}.configuration.fccID`,
        `${SAS}.freqAController.bwAllowList`,
        `${SAS}.configuration.antennaGain`,
        `${SAS}.configuration.antennaAzimuth`,
        `${SAS}.configuration.antennaBeamwidth`,
        `${SAS}.configuration.antennaDowntilt`,
        `${SAS}.configuration.maxTxPower`,
        `${SAS}.locationConfiguration.latitude`,
        `${SAS}.locationConfiguration.longitude`,
        `${SAS}.locationConfiguration.location`,
        `${SAS}.locationConfiguration.heightType`,
        `${SAS}.locationConfiguration.highAccuracyLocationEnable`,
        `${SAS}.sasState`,
        `${SAS}.statusInfo.sasRegistered`,
        `${SAS}.statusInfo.sasCBSDID`,
        `${SAS}.statusInfo.sasGrantedEarfcnDL`,
        `${SAS}.statusInfo.sasGrantedEarfcnDL2`,
        `${SAS}.statusInfo.sasGrantedEarfcnDL3`,
        `${SAS}.statusInfo.sasStatus`,
        'Device.Ethernet.Interface.1.MACAddress',
      ].join(',');

      const query = JSON.stringify({ '_deviceId._OUI': '00C002' });
      const resp  = await fetch(
        `${nbiUrl}/devices?query=${encodeURIComponent(query)}&projection=${encodeURIComponent(projection)}`,
      );
      if (!resp.ok) throw new Error(`GenieACS NBI returned HTTP ${resp.status}`);

      const devices = (await resp.json()) as Record<string, any>[];

      // Filter to NR devices — must have the X_00C002_gNB tree
      const nr = devices.filter(d => {
        const svc = d?.Device?.Services?.FAPService?.['1'];
        return svc?.X_00C002_gNB != null;
      });

      res.json({ success: true, devices: nr.map(toNRDevice) });
    } catch (err) {
      logger.error({ err: String(err) }, 'sercomm-nr: failed to list devices');
      res.status(502).json({ success: false, error: String(err), devices: [] });
    }
  });

  // POST /api/femto/nr/devices/:id/configure
  router.post('/devices/:id/configure', requireAdmin, async (req: Request, res: Response) => {
    const { id } = req.params;
    const body = req.body as {
      mcc: string; mnc: string; tac: number; gnbId: number;
      cellCount: number; amfIp: string; upfIp: string;
      sasUrl: string; sasEnable: boolean;
      sasCategory?: string; sasLocation?: string; sasLocationSource?: string;
      sasHeightType?: string; sasIcgGroupId?: string; sasPeerCertVerify?: boolean;
      sasUserId?: string;
      latitude: number; longitude: number; unlockCell: boolean;
      neaAlgorithm?: string; niaAlgorithm?: string;
      nrPci?: number; nrArfcn?: number; nrBandWidth?: number; nrFreqBand?: number;
      nrArfcn2?: number; nrPci2?: number;
      nrArfcn3?: number; nrPci3?: number;
      sasCellNum?: number;
      txPwr?: number; prachCfgIdx?: number;
      numDlSlot?: number; numUlSlot?: number; numDlSymbol?: number; numUlSymbol?: number;
      np2Pres?: number; numDlSlot2?: number; numUlSlot2?: number; numDlSymbolP2?: number; numUlSymbolP2?: number;
      snssaiSst?: number; snssaiSd?: string;
      gNBCUName?: string; maxNumUes?: number;
      antennaGain?: number; antennaAzimuth?: number; antennaBeamwidth?: number;
      antennaDowntilt?: number; sasMaxTxPower?: number;
      bwAllowList?: string;
    };

    const {
      mcc, mnc, tac, gnbId, cellCount = 1, amfIp, upfIp,
      sasUrl, sasEnable, latitude, longitude, unlockCell,
      sasCategory = 'A', sasLocation = 'indoor', sasLocationSource = '0',
      sasHeightType = 'AGL', sasIcgGroupId = '', sasPeerCertVerify = false, sasCellNum,
      sasUserId,
      neaAlgorithm, niaAlgorithm,
      nrPci, nrArfcn, nrBandWidth, nrFreqBand, txPwr, prachCfgIdx,
      nrArfcn2, nrPci2, nrArfcn3, nrPci3,
      numDlSlot, numUlSlot, numDlSymbol, numUlSymbol,
      np2Pres, numDlSlot2, numUlSlot2, numDlSymbolP2, numUlSymbolP2,
      snssaiSst, snssaiSd,
      gNBCUName, maxNumUes,
      antennaGain, antennaAzimuth, antennaBeamwidth, antennaDowntilt, sasMaxTxPower,
      bwAllowList,
    } = body;

    if (!mcc || !mnc || !amfIp) {
      return res.status(400).json({ success: false, error: 'mcc, mnc, amfIp required' });
    }

    const plmn  = `${mcc}${mnc.padStart(mnc.length >= 3 ? 3 : 2, '0')}`;
    const nCGI  = (n: number) => (gnbId << 14) | n;
    const cells  = Math.max(1, Math.min(3, cellCount));
    // Use provided sasUserId; fall back to serial extracted from GenieACS device ID
    const effectiveSasUserId = sasUserId?.trim() || decodeURIComponent(id).split('-').pop() || id;

    const params: Array<[string, string, string]> = [
      // gNB identity
      [`${GNB}.CU.GNBCUFunction.gNBId`,       String(gnbId), 'xsd:unsignedInt'],
      [`${GNB}.CU.GNBCUFunction.gNBIdLength`,  '22',          'xsd:unsignedInt'],

      // AMF / UPF endpoints
      [`${GNB}.CU.GNBCUFunction.EP_NgC.remoteAddress.ipv4Address`, amfIp, 'xsd:string'],
      ...(upfIp ? [[`${GNB}.CU.GNBCUFunction.EP_NgU.remoteAddress.ipv4Address`, upfIp, 'xsd:string']] as [string,string,string][] : []),

      // CU cells
      ...[1, 2, 3].flatMap(n => [
        [`${GNB}.CU.GNBCUFunction.NRCellCU.${n}.plmnIdList.1.PLMNID`, plmn,          'xsd:string'    ] as [string,string,string],
        [`${GNB}.CU.GNBCUFunction.NRCellCU.${n}.TAC`,                  String(tac),   'xsd:unsignedInt'] as [string,string,string],
        [`${GNB}.CU.GNBCUFunction.NRCellCU.${n}.nCGI`,                 String(nCGI(n)), 'xsd:unsignedInt'] as [string,string,string],
      ]),

      // DU cells
      ...[1, 2, 3].slice(0, cells).map(n =>
        [`${GNB}.DU.1.GNBDUFunction.NRCellDU.${n}.plmnIdList.1.PLMNID`, plmn, 'xsd:string'] as [string,string,string],
      ),

      // adminState — cell 1 always, cells 2/3 when active
      [`${GNB}.DU.1.GNBDUFunction.NRCellDU.1.adminState`, unlockCell ? 'UNLOCKED' : 'LOCKED', 'xsd:string'],
      ...(cells >= 2 ? [[`${GNB}.DU.1.GNBDUFunction.NRCellDU.2.adminState`, unlockCell ? 'UNLOCKED' : 'LOCKED', 'xsd:string']] as [string,string,string][] : []),
      ...(cells >= 3 ? [[`${GNB}.DU.1.GNBDUFunction.NRCellDU.3.adminState`, unlockCell ? 'UNLOCKED' : 'LOCKED', 'xsd:string']] as [string,string,string][] : []),

      // SAS config
      [`${SAS}.Enable`,                                            String(sasEnable),   'xsd:boolean'],
      [`${SAS}.configuration.serverURL`,                           sasUrl,              'xsd:string' ],
      [`${SAS}.configuration.cbsdCategory`,                        sasCategory,         'xsd:string' ],
      [`${SAS}.configuration.sasPeerVerifyEnable`,                 String(sasPeerCertVerify), 'xsd:boolean'],
      [`${SAS}.configuration.groupParamGroupID`,                   sasIcgGroupId,       'xsd:string' ],
      [`${SAS}.configuration.userID`,                              effectiveSasUserId,  'xsd:string' ],
      ...(sasCellNum != null ? [[`${SAS}.configuration.cellNum`, String(sasCellNum), 'xsd:unsignedInt']] as [string,string,string][] : []),
      [`${SAS}.locationConfiguration.location`,                    sasLocation,         'xsd:string' ],
      [`${SAS}.locationConfiguration.heightType`,                  sasHeightType,       'xsd:string' ],
      [`${SAS}.locationConfiguration.highAccuracyLocationEnable`,  String(sasLocationSource === '1'), 'xsd:boolean'],
      [`${SAS}.locationConfiguration.latitude`,  String(Math.round(latitude  * 1_000_000)), 'xsd:int'],
      [`${SAS}.locationConfiguration.longitude`, String(Math.round(longitude * 1_000_000)), 'xsd:int'],

      // Security algorithms (single-value per cell on Sercomm NR)
      ...(neaAlgorithm ? [1, 2, 3].map(n =>
        [`${GNB}.CU.GNBCUFunction.NRCellCU.${n}.encAlg`, neaAlgorithm, 'xsd:string'] as [string,string,string],
      ) : []),
      ...(niaAlgorithm ? [1, 2, 3].map(n =>
        [`${GNB}.CU.GNBCUFunction.NRCellCU.${n}.intAlg`, niaAlgorithm, 'xsd:string'] as [string,string,string],
      ) : []),

      // RF / DU — cell 1
      ...(nrArfcn     != null ? [
        [`${GNB}.DU.1.GNBDUFunction.NRCellDU.1.freqConfig.arfcnDL`, String(nrArfcn), 'xsd:unsignedInt'],
        [`${GNB}.DU.1.GNBDUFunction.NRCellDU.1.freqConfig.arfcnUL`, String(nrArfcn), 'xsd:unsignedInt'],
      ] as [string,string,string][] : []),
      ...(nrBandWidth != null ? [[`${GNB}.DU.1.GNBDUFunction.NRCellDU.1.freqConfig.nrBandWidth`,   String(nrBandWidth), 'xsd:unsignedInt']] as [string,string,string][] : []),
      ...(nrFreqBand  != null ? [[`${GNB}.DU.1.GNBDUFunction.NRCellDU.1.freqConfig.nrFreqBand`,    String(nrFreqBand),  'xsd:unsignedInt']] as [string,string,string][] : []),
      ...(txPwr       != null ? [[`${GNB}.DU.1.GNBDUFunction.NRCellDU.1.TxPwr`,                    String(txPwr),       'xsd:unsignedInt']] as [string,string,string][] : []),
      ...(prachCfgIdx != null ? [[`${GNB}.DU.1.GNBDUFunction.NRCellDU.1.prachConfig.prachCfgIdx`, String(prachCfgIdx), 'xsd:unsignedInt']] as [string,string,string][] : []),
      // nrPci must match on both DU and CU sides
      ...(nrPci != null ? [
        [`${GNB}.DU.1.GNBDUFunction.NRCellDU.1.nrPci`, String(nrPci), 'xsd:unsignedInt'],
        [`${GNB}.CU.GNBCUFunction.NRCellCU.1.nrPci`,   String(nrPci), 'xsd:unsignedInt'],
      ] as [string,string,string][] : []),
      // CA — cell 2
      ...(cells >= 2 && nrArfcn2 != null ? [
        [`${GNB}.DU.1.GNBDUFunction.NRCellDU.2.freqConfig.arfcnDL`, String(nrArfcn2), 'xsd:unsignedInt'],
        [`${GNB}.DU.1.GNBDUFunction.NRCellDU.2.freqConfig.arfcnUL`, String(nrArfcn2), 'xsd:unsignedInt'],
      ] as [string,string,string][] : []),
      ...(cells >= 2 && nrBandWidth != null ? [[`${GNB}.DU.1.GNBDUFunction.NRCellDU.2.freqConfig.nrBandWidth`, String(nrBandWidth), 'xsd:unsignedInt']] as [string,string,string][] : []),
      ...(cells >= 2 && nrFreqBand  != null ? [[`${GNB}.DU.1.GNBDUFunction.NRCellDU.2.freqConfig.nrFreqBand`,  String(nrFreqBand),  'xsd:unsignedInt']] as [string,string,string][] : []),
      ...(cells >= 2 && nrPci2 != null ? [
        [`${GNB}.DU.1.GNBDUFunction.NRCellDU.2.nrPci`, String(nrPci2), 'xsd:unsignedInt'],
        [`${GNB}.CU.GNBCUFunction.NRCellCU.2.nrPci`,   String(nrPci2), 'xsd:unsignedInt'],
      ] as [string,string,string][] : []),
      // CA — cell 3
      ...(cells >= 3 && nrArfcn3 != null ? [
        [`${GNB}.DU.1.GNBDUFunction.NRCellDU.3.freqConfig.arfcnDL`, String(nrArfcn3), 'xsd:unsignedInt'],
        [`${GNB}.DU.1.GNBDUFunction.NRCellDU.3.freqConfig.arfcnUL`, String(nrArfcn3), 'xsd:unsignedInt'],
      ] as [string,string,string][] : []),
      ...(cells >= 3 && nrBandWidth != null ? [[`${GNB}.DU.1.GNBDUFunction.NRCellDU.3.freqConfig.nrBandWidth`, String(nrBandWidth), 'xsd:unsignedInt']] as [string,string,string][] : []),
      ...(cells >= 3 && nrFreqBand  != null ? [[`${GNB}.DU.1.GNBDUFunction.NRCellDU.3.freqConfig.nrFreqBand`,  String(nrFreqBand),  'xsd:unsignedInt']] as [string,string,string][] : []),
      ...(cells >= 3 && nrPci3 != null ? [
        [`${GNB}.DU.1.GNBDUFunction.NRCellDU.3.nrPci`, String(nrPci3), 'xsd:unsignedInt'],
        [`${GNB}.CU.GNBCUFunction.NRCellCU.3.nrPci`,   String(nrPci3), 'xsd:unsignedInt'],
      ] as [string,string,string][] : []),

      // TDD slot configuration. Pattern 2 (np2Pres/numDlSlot2/numUlSlot2/numDlSymbolP2/
      // numUlSymbolP2) used to be hardcoded to 0/disabled here on the theory that the DU
      // firmware rejects a pure-DL pattern2 (numUlSlot2=0) as invalid — that assumption
      // was WRONG. Verified live against the radio's own local UI for the "8:2 FR1.30-4
      // (DDDSUUDDD)" preset: it uses np2Pres=1, numDlSlot2=4, numUlSlot2=0,
      // numDlSymbolP2=0, numUlSymbolP2=0 — exactly the "pure-DL pattern2" combination
      // this comment used to claim was rejected. See memory sercomm-nr-tdd-slot-patterns.
      // Now passed through from the caller instead of forced to 0, defaulting to
      // pattern-2-disabled only when the caller doesn't specify it.
      ...(numDlSlot != null ? [
        [`${GNB}.CU.GNBCUFunction.TimeSlotConfiguration.numDlSlot`,    String(numDlSlot),   'xsd:unsignedInt'],
        [`${GNB}.CU.GNBCUFunction.TimeSlotConfiguration.numUlSlot`,    String(numUlSlot ?? 2), 'xsd:unsignedInt'],
        [`${GNB}.CU.GNBCUFunction.TimeSlotConfiguration.numDlSymbol`,  String(numDlSymbol ?? 6), 'xsd:unsignedInt'],
        [`${GNB}.CU.GNBCUFunction.TimeSlotConfiguration.numUlSymbol`,  String(numUlSymbol ?? 4), 'xsd:unsignedInt'],
        [`${GNB}.CU.GNBCUFunction.TimeSlotConfiguration.np2Pres`,      String(np2Pres ?? 0),      'xsd:unsignedInt'],
        [`${GNB}.CU.GNBCUFunction.TimeSlotConfiguration.numDlSlot2`,   String(numDlSlot2 ?? 0),   'xsd:unsignedInt'],
        [`${GNB}.CU.GNBCUFunction.TimeSlotConfiguration.numUlSlot2`,   String(numUlSlot2 ?? 0),   'xsd:unsignedInt'],
        [`${GNB}.CU.GNBCUFunction.TimeSlotConfiguration.numDlSymbolP2`, String(numDlSymbolP2 ?? 0), 'xsd:unsignedInt'],
        [`${GNB}.CU.GNBCUFunction.TimeSlotConfiguration.numUlSymbolP2`, String(numUlSymbolP2 ?? 0), 'xsd:unsignedInt'],
      ] as [string,string,string][] : []),

      // S-NSSAI — encode as (sst << 24) | sd_int
      ...(snssaiSst != null && snssaiSd != null ? [1, 2, 3].map(n => {
        const sNSSAIInt = ((snssaiSst & 0xFF) << 24) | (parseInt(snssaiSd, 16) & 0xFFFFFF);
        return [`${GNB}.CU.GNBCUFunction.NRCellCU.${n}.sNSSAI`, String(sNSSAIInt), 'xsd:string'] as [string,string,string];
      }) : []),

      // CU config
      ...(gNBCUName  != null ? [[`${GNB}.CU.GNBCUFunction.gNBCUName`,                      gNBCUName,        'xsd:string'    ]] as [string,string,string][] : []),
      ...(maxNumUes  != null ? [[`${GNB}.CU.GNBCUFunction.gnbCuConfig.maxNumUes`,           String(maxNumUes), 'xsd:unsignedInt']] as [string,string,string][] : []),

      // SAS antenna
      ...(antennaGain      != null ? [[`${SAS}.configuration.antennaGain`,      String(antennaGain),      'xsd:int'        ]] as [string,string,string][] : []),
      ...(antennaAzimuth   != null ? [[`${SAS}.configuration.antennaAzimuth`,   String(antennaAzimuth),   'xsd:unsignedInt']] as [string,string,string][] : []),
      ...(antennaBeamwidth != null ? [[`${SAS}.configuration.antennaBeamwidth`, String(antennaBeamwidth), 'xsd:unsignedInt']] as [string,string,string][] : []),
      ...(antennaDowntilt  != null ? [[`${SAS}.configuration.antennaDowntilt`,  String(antennaDowntilt),  'xsd:int'        ]] as [string,string,string][] : []),
      ...(sasMaxTxPower    != null ? [[`${SAS}.configuration.maxTxPower`,       String(sasMaxTxPower),    'xsd:int'        ]] as [string,string,string][] : []),
      ...(bwAllowList      != null ? [[`${SAS}.freqAController.bwAllowList`,    bwAllowList,             'xsd:string'     ]] as [string,string,string][] : []),
    ];

    const taskUrl = `${nbiUrl}/devices/${encodeId(id)}/tasks?timeout=30000&connection_request`;

    try {
      const result = await nbiPost(taskUrl, { name: 'setParameterValues', parameterValues: params });
      if (!result.ok) {
        logger.error({ id, status: result.status, text: result.text }, 'sercomm-nr: configure task failed');
        return res.status(502).json({ success: false, error: `GenieACS NBI error: ${result.text}` });
      }

      auditLogger.log({
        action:  'nr_configure',
        user:    (req as any).user?.username ?? 'unknown',
        target:  id,
        details: `PLMN=${plmn} TAC=${tac} gNBId=${gnbId} AMF=${amfIp} unlock=${unlockCell}`,
        success: true,
      });

      // Auto-backup after successful provision
      try {
        await backupDeviceById(nbiUrl, backupRoot, id);
      } catch (backupErr) {
        logger.warn({ backupErr: String(backupErr), id }, 'Auto-backup after NR configure failed');
      }

      res.json({ success: true, message: 'Configuration task queued', taskId: result.text });
    } catch (err) {
      logger.error({ id, err: String(err) }, 'sercomm-nr: configure error');
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // POST /api/femto/nr/devices/:id/unlock
  router.post('/devices/:id/unlock', requireAdmin, async (req: Request, res: Response) => {
    const { id } = req.params;
    const taskUrl = `${nbiUrl}/devices/${encodeId(id)}/tasks?timeout=30000&connection_request`;

    const params: Array<[string, string, string]> = [
      [`${GNB}.DU.1.GNBDUFunction.NRCellDU.1.adminState`, 'UNLOCKED', 'xsd:string'],
      [`${GNB}.DU.1.GNBDUFunction.NRCellDU.2.adminState`, 'UNLOCKED', 'xsd:string'],
      [`${GNB}.DU.1.GNBDUFunction.NRCellDU.3.adminState`, 'UNLOCKED', 'xsd:string'],
    ];

    try {
      const result = await nbiPost(taskUrl, { name: 'setParameterValues', parameterValues: params });

      auditLogger.log({
        action:  'nr_unlock',
        user:    (req as any).user?.username ?? 'unknown',
        target:  id,
        details: 'adminState=UNLOCKED for all cells',
        success: result.ok,
      });

      res.json({ success: result.ok, taskId: result.text });
    } catch (err) {
      logger.error({ id, err: String(err) }, 'sercomm-nr: unlock error');
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // POST /api/femto/nr/devices/:id/lock
  router.post('/devices/:id/lock', requireAdmin, async (req: Request, res: Response) => {
    const { id } = req.params;
    const taskUrl = `${nbiUrl}/devices/${encodeId(id)}/tasks?timeout=30000&connection_request`;

    const params: Array<[string, string, string]> = [
      [`${GNB}.DU.1.GNBDUFunction.NRCellDU.1.adminState`, 'LOCKED', 'xsd:string'],
      [`${GNB}.DU.1.GNBDUFunction.NRCellDU.2.adminState`, 'LOCKED', 'xsd:string'],
      [`${GNB}.DU.1.GNBDUFunction.NRCellDU.3.adminState`, 'LOCKED', 'xsd:string'],
    ];

    try {
      const result = await nbiPost(taskUrl, { name: 'setParameterValues', parameterValues: params });

      auditLogger.log({
        action:  'nr_lock',
        user:    (req as any).user?.username ?? 'unknown',
        target:  id,
        details: 'adminState=LOCKED for all cells',
        success: result.ok,
      });

      res.json({ success: result.ok, taskId: result.text });
    } catch (err) {
      logger.error({ id, err: String(err) }, 'sercomm-nr: lock error');
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // POST /api/femto/nr/devices/:id/reboot
  router.post('/devices/:id/reboot', requireAdmin, async (req: Request, res: Response) => {
    const { id } = req.params;
    const taskUrl = `${nbiUrl}/devices/${encodeId(id)}/tasks?timeout=30000&connection_request`;

    try {
      const result = await nbiPost(taskUrl, { name: 'reboot' });

      auditLogger.log({
        action:  'nr_reboot',
        user:    (req as any).user?.username ?? 'unknown',
        target:  id,
        success: result.ok,
      });

      res.json({ success: result.ok, taskId: result.text });
    } catch (err) {
      logger.error({ id, err: String(err) }, 'sercomm-nr: reboot error');
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // POST /api/femto/nr/devices/:id/refresh — triggers GenieACS to re-fetch params
  router.post('/devices/:id/refresh', requireAdmin, async (req: Request, res: Response) => {
    const { id } = req.params;
    const taskUrl = `${nbiUrl}/devices/${encodeId(id)}/tasks?timeout=30000&connection_request`;
    try {
      await nbiPost(taskUrl, {
        name: 'getParameterValues',
        parameterNames: [
          `${GNB}.CU.GNBCUFunction`,
          `${GNB}.DU.1.GNBDUFunction`,
          `${SAS}`,
        ],
      });
    } catch { /* non-critical */ }
    res.json({ success: true });
  });

  // POST /api/femto/nr/devices/:id/sas-restart
  router.post('/devices/:id/sas-restart', requireAdmin, async (req: Request, res: Response) => {
    const { id } = req.params;
    const taskUrl = `${nbiUrl}/devices/${encodeId(id)}/tasks?timeout=30000&connection_request`;

    try {
      const disableResult = await nbiPost(taskUrl, {
        name: 'setParameterValues',
        parameterValues: [[`${SAS}.Enable`, 'false', 'xsd:boolean']],
      });
      if (!disableResult.ok) {
        return res.status(502).json({ success: false, error: 'SAS disable step failed' });
      }

      await new Promise(r => setTimeout(r, 2000));

      const enableResult = await nbiPost(taskUrl, {
        name: 'setParameterValues',
        parameterValues: [[`${SAS}.Enable`, 'true', 'xsd:boolean']],
      });

      res.json({ success: enableResult.ok, message: 'SAS client restarted' });
    } catch (err) {
      logger.error({ id, err: String(err) }, 'sercomm-nr: sas-restart error');
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  return router;
}
