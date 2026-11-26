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

/**
 * Entity -> wire DTO for the 17 core NF configs.
 *
 * Every method here is a pass-through of `rawYaml`, the whole parsed YAML
 * document. That is the API's real payload shape, and since the DTOs are now
 * aliases of the document types in domain/entities/open5gs-yaml.ts, it is also
 * the DECLARED shape -- so none of these need a cast any more. They used to
 * carry `as any`, which is precisely what hid the fact that the DTOs described
 * the NF's inner fields at their top level.
 *
 * `rawYaml` is optional on every entity (loadRaw() returns `{}` on a parse
 * error), hence the `?? {}` rather than a non-null assertion.
 */
export class ConfigMapper {
  static toAllDto(configs: AllConfigs): AllConfigsDto {
    return {
      nrf: configs.nrf?.rawYaml ?? {},
      scp: configs.scp?.rawYaml ?? {},
      amf: configs.amf?.rawYaml ?? {},
      smf: configs.smf?.rawYaml ?? {},
      upf: configs.upf?.rawYaml ?? {},
      ausf: configs.ausf?.rawYaml ?? {},
      udm: configs.udm?.rawYaml ?? {},
      udr: configs.udr?.rawYaml ?? {},
      pcf: configs.pcf?.rawYaml ?? {},
      nssf: configs.nssf?.rawYaml ?? {},
      bsf: configs.bsf?.rawYaml ?? {},
      sepp1: configs.sepp1?.rawYaml ?? {},
      mme: configs.mme?.rawYaml ?? {},
      hss: configs.hss?.rawYaml ?? {},
      pcrf: configs.pcrf?.rawYaml ?? {},
      sgwc: configs.sgwc?.rawYaml ?? {},
      sgwu: configs.sgwu?.rawYaml ?? {},
    };
  }

  static nrfToDto(config: NrfConfig): NrfConfigDto {
    return config.rawYaml ?? {};
  }

  static amfToDto(config: AmfConfig): AmfConfigDto {
    return config.rawYaml ?? {};
  }

  static smfToDto(config: SmfConfig): SmfConfigDto {
    return config.rawYaml ?? {};
  }

  static upfToDto(config: UpfConfig): UpfConfigDto {
    return config.rawYaml ?? {};
  }

  static ausfToDto(config: AusfConfig): AusfConfigDto {
    return config.rawYaml ?? {};
  }
}
