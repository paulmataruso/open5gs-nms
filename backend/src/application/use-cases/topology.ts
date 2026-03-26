import pino from 'pino';
import { IConfigRepository } from '../../domain/interfaces/config-repository';
import { TopologyBuilder } from '../../domain/services/topology-builder';
import { TopologyGraph } from '../../domain/entities/topology';
import { ServiceStatus } from '../../domain/entities/service-status';

export class TopologyUseCase {
  private readonly builder = new TopologyBuilder();

  constructor(
    private readonly configRepo: IConfigRepository,
    private readonly logger: pino.Logger,
  ) {}

  async getTopology(statuses?: Record<string, ServiceStatus>): Promise<TopologyGraph> {
    const configs = await this.configRepo.loadAll();
    return this.builder.build(configs, statuses);
  }
}
