import { IConfigRepository } from '../../domain/interfaces/config-repository';
import { IAuditLogger } from '../../domain/interfaces/audit-logger';
import { AllConfigsDto } from '../dto';
import { ConfigMapper } from './config-mapper';
import pino from 'pino';

export class LoadConfigUseCase {
  constructor(
    private readonly configRepo: IConfigRepository,
    private readonly auditLogger: IAuditLogger,
    private readonly logger: pino.Logger,
  ) {}

  async execute(): Promise<AllConfigsDto> {
    this.logger.info('Loading all configurations');

    const configs = await this.configRepo.loadAll();

    await this.auditLogger.log({
      action: 'config_load',
      user: 'system',
      target: 'all',
      success: true,
    });

    return ConfigMapper.toAllDto(configs);
  }

  async executeForService(
    service: 'nrf' | 'amf' | 'smf' | 'upf' | 'ausf',
  ): Promise<unknown> {
    this.logger.info({ service }, 'Loading configuration for service');

    switch (service) {
      case 'nrf':
        return ConfigMapper.nrfToDto(await this.configRepo.loadNrf());
      case 'amf':
        return ConfigMapper.amfToDto(await this.configRepo.loadAmf());
      case 'smf':
        return ConfigMapper.smfToDto(await this.configRepo.loadSmf());
      case 'upf':
        return ConfigMapper.upfToDto(await this.configRepo.loadUpf());
      case 'ausf':
        return ConfigMapper.ausfToDto(await this.configRepo.loadAusf());
    }
  }
}
