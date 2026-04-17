import { IConfigRepository } from '../../domain/interfaces/config-repository';
import { ISubscriberRepository } from '../../domain/interfaces/subscriber-repository';
import pino from 'pino';

export interface SyncSDResult {
  success: boolean;
  updated: {
    smf_slices: number;
    subscribers: number;
  };
  error?: string;
}

/**
 * Sync SD (Slice Differentiator) across SMF config and subscriber database
 * Updates all matching slices to have the same SD value as AMF
 */
export class SyncSDUseCase {
  constructor(
    private readonly configRepo: IConfigRepository,
    private readonly subscriberRepo: ISubscriberRepository,
    private readonly logger: pino.Logger,
  ) {}

  async execute(sd: string, sst?: number): Promise<SyncSDResult> {
    this.logger.info({ sd, sst }, 'Starting SD sync operation');

    try {
      // Step 1: Update SMF YAML configuration
      const smfSlicesUpdated = await this.updateSmfSlices(sd, sst);
      this.logger.info({ smfSlicesUpdated }, 'SMF slices updated');

      // Step 2: Update all subscribers in MongoDB
      const subscribersUpdated = await this.updateSubscribers(sd, sst);
      this.logger.info({ subscribersUpdated }, 'Subscribers updated');

      return {
        success: true,
        updated: {
          smf_slices: smfSlicesUpdated,
          subscribers: subscribersUpdated,
        },
      };
    } catch (error) {
      this.logger.error({ error: String(error) }, 'SD sync failed');
      return {
        success: false,
        updated: {
          smf_slices: 0,
          subscribers: 0,
        },
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async updateSmfSlices(sd: string, sst?: number): Promise<number> {
    // Load current SMF configuration
    const smfConfig = await this.configRepo.loadSmf();
    const smf = (smfConfig as any).smf;

    if (!smf?.s_nssai || !Array.isArray(smf.s_nssai)) {
      this.logger.warn('No s_nssai array found in SMF config');
      return 0;
    }

    // Count how many slices we'll update
    let updateCount = 0;

    // Update all matching s_nssai entries
    smf.s_nssai.forEach((slice: any) => {
      // If SST filter is provided, only update matching SST
      if (!sst || slice.sst === sst) {
        slice.sd = sd;
        updateCount++;
      }
    });

    // Save updated SMF configuration
    if (updateCount > 0) {
      await this.configRepo.saveSmf(smfConfig as any);
      this.logger.info({ updateCount }, 'SMF config saved with updated SD values');
    }

    return updateCount;
  }

  private async updateSubscribers(sd: string, sst?: number): Promise<number> {
    // Update all subscribers' slice SD values
    const count = await this.subscriberRepo.updateSDForAll(sd, sst);
    this.logger.info({ count }, 'Subscribers updated with new SD');
    return count;
  }
}
