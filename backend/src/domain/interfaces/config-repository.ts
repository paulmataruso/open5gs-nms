import { NrfConfig } from '../entities/nrf-config';
import { AmfConfig } from '../entities/amf-config';
import { SmfConfig } from '../entities/smf-config';
import { UpfConfig } from '../entities/upf-config';
import { AusfConfig } from '../entities/ausf-config';
import { ScpConfig } from '../entities/scp-config';
import { UdmConfig } from '../entities/udm-config';
import { UdrConfig } from '../entities/udr-config';
import { PcfConfig } from '../entities/pcf-config';
import { NssfConfig } from '../entities/nssf-config';
import { BsfConfig } from '../entities/bsf-config';
import { MmeConfig } from '../entities/mme-config';
import { HssConfig } from '../entities/hss-config';
import { PcrfConfig } from '../entities/pcrf-config';
import { SgwcConfig } from '../entities/sgwc-config';
import { SgwuConfig } from '../entities/sgwu-config';

export interface AllConfigs {
  // 5G Core
  nrf: NrfConfig;
  scp?: ScpConfig;
  amf: AmfConfig;
  smf: SmfConfig;
  upf: UpfConfig;
  ausf: AusfConfig;
  udm?: UdmConfig;
  udr?: UdrConfig;
  pcf?: PcfConfig;
  nssf?: NssfConfig;
  bsf?: BsfConfig;
  // 4G EPC
  mme?: MmeConfig;
  hss?: HssConfig;
  pcrf?: PcrfConfig;
  sgwc?: SgwcConfig;
  sgwu?: SgwuConfig;
}

export interface IConfigRepository {
  loadNrf(): Promise<NrfConfig>;
  loadAmf(): Promise<AmfConfig>;
  loadSmf(): Promise<SmfConfig>;
  loadUpf(): Promise<UpfConfig>;
  loadAusf(): Promise<AusfConfig>;
  loadScp(): Promise<ScpConfig>;
  loadUdm(): Promise<UdmConfig>;
  loadUdr(): Promise<UdrConfig>;
  loadPcf(): Promise<PcfConfig>;
  loadNssf(): Promise<NssfConfig>;
  loadBsf(): Promise<BsfConfig>;
  loadMme(): Promise<MmeConfig>;
  loadHss(): Promise<HssConfig>;
  loadPcrf(): Promise<PcrfConfig>;
  loadSgwc(): Promise<SgwcConfig>;
  loadSgwu(): Promise<SgwuConfig>;
  loadAll(): Promise<AllConfigs>;
  
  saveNrf(config: NrfConfig): Promise<void>;
  saveAmf(config: AmfConfig): Promise<void>;
  saveSmf(config: SmfConfig): Promise<void>;
  saveUpf(config: UpfConfig): Promise<void>;
  saveAusf(config: AusfConfig): Promise<void>;
  saveScp(config: ScpConfig): Promise<void>;
  saveUdm(config: UdmConfig): Promise<void>;
  saveUdr(config: UdrConfig): Promise<void>;
  savePcf(config: PcfConfig): Promise<void>;
  saveNssf(config: NssfConfig): Promise<void>;
  saveBsf(config: BsfConfig): Promise<void>;
  saveMme(config: MmeConfig): Promise<void>;
  saveHss(config: HssConfig): Promise<void>;
  savePcrf(config: PcrfConfig): Promise<void>;
  saveSgwc(config: SgwcConfig): Promise<void>;
  saveSgwu(config: SgwuConfig): Promise<void>;
  
  backupAll(backupDir: string): Promise<void>;
  restoreBackup(backupDir: string): Promise<void>;
  getRawYaml(service: string): Promise<string>;
}
