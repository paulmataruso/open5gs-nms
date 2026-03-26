import { AllConfigs } from '../../domain/interfaces/config-repository';
import { NrfConfig } from '../../domain/entities/nrf-config';
import { AmfConfig } from '../../domain/entities/amf-config';
import { SmfConfig } from '../../domain/entities/smf-config';
import { UpfConfig } from '../../domain/entities/upf-config';
import { AusfConfig } from '../../domain/entities/ausf-config';
import {
  AllConfigsDto,
  NrfConfigDto,
  AmfConfigDto,
  SmfConfigDto,
  UpfConfigDto,
  AusfConfigDto,
} from '../dto';

export class ConfigMapper {
  // Just pass through the raw YAML object - no extraction, no processing
  static toAllDto(configs: AllConfigs): AllConfigsDto {
    return {
      nrf: (configs.nrf as any).rawYaml || {},
      scp: (configs.scp as any)?.rawYaml || {},
      amf: (configs.amf as any).rawYaml || {},
      smf: (configs.smf as any).rawYaml || {},
      upf: (configs.upf as any).rawYaml || {},
      ausf: (configs.ausf as any).rawYaml || {},
      udm: (configs.udm as any)?.rawYaml || {},
      udr: (configs.udr as any)?.rawYaml || {},
      pcf: (configs.pcf as any)?.rawYaml || {},
      nssf: (configs.nssf as any)?.rawYaml || {},
      bsf: (configs.bsf as any)?.rawYaml || {},
      mme: (configs.mme as any)?.rawYaml || {},
      hss: (configs.hss as any)?.rawYaml || {},
      pcrf: (configs.pcrf as any)?.rawYaml || {},
      sgwc: (configs.sgwc as any)?.rawYaml || {},
      sgwu: (configs.sgwu as any)?.rawYaml || {},
    };
  }

  // Just pass through the DTO as rawYaml - no merging, no processing
  static dtoToNrf(dto: NrfConfigDto, existing: NrfConfig): NrfConfig {
    return { ...existing, rawYaml: dto as any };
  }

  static dtoToAmf(dto: AmfConfigDto, existing: AmfConfig): AmfConfig {
    return { ...existing, rawYaml: dto as any };
  }

  static dtoToSmf(dto: SmfConfigDto, existing: SmfConfig): SmfConfig {
    return { ...existing, rawYaml: dto as any };
  }

  static dtoToUpf(dto: UpfConfigDto, existing: UpfConfig): UpfConfig {
    return { ...existing, rawYaml: dto as any };
  }

  static dtoToAusf(dto: AusfConfigDto, existing: AusfConfig): AusfConfig {
    return { ...existing, rawYaml: dto as any };
  }

  // Legacy compatibility
  static nrfToDto(config: NrfConfig): NrfConfigDto {
    return (config as any).rawYaml || {};
  }

  static amfToDto(config: AmfConfig): AmfConfigDto {
    return (config as any).rawYaml || {};
  }

  static smfToDto(config: SmfConfig): SmfConfigDto {
    return (config as any).rawYaml || {};
  }

  static upfToDto(config: UpfConfig): UpfConfigDto {
    return (config as any).rawYaml || {};
  }

  static ausfToDto(config: AusfConfig): AusfConfigDto {
    return (config as any).rawYaml || {};
  }
}
