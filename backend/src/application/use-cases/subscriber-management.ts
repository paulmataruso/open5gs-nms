import pino from 'pino';
import { ISubscriberRepository } from '../../domain/interfaces/subscriber-repository';
import { IAuditLogger } from '../../domain/interfaces/audit-logger';
import { subscriberSchema } from '../../domain/services/validation-schemas';
import { SubscriberDto } from '../dto';
import { Subscriber, SubscriberListItem } from '../../domain/entities/subscriber';

export class SubscriberManagementUseCase {
  constructor(
    private readonly subscriberRepo: ISubscriberRepository,
    private readonly auditLogger: IAuditLogger,
    private readonly logger: pino.Logger,
  ) {}

  async list(skip: number = 0, limit: number = 50): Promise<{
    subscribers: SubscriberListItem[];
    total: number;
  }> {
    const [subscribers, total] = await Promise.all([
      this.subscriberRepo.findAll(skip, limit),
      this.subscriberRepo.count(),
    ]);
    return { subscribers, total };
  }

  async search(query: string, skip: number = 0, limit: number = 50): Promise<{
    subscribers: SubscriberListItem[];
    total: number;
  }> {
    const subscribers = await this.subscriberRepo.search(query, skip, limit);
    return { subscribers, total: subscribers.length };
  }

  async getByImsi(imsi: string): Promise<Subscriber | null> {
    return this.subscriberRepo.findByImsi(imsi);
  }

  async create(dto: SubscriberDto): Promise<void> {
    const parsed = subscriberSchema.safeParse(dto);
    if (!parsed.success) {
      const errors = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
      throw new Error(`Validation failed: ${errors.join(', ')}`);
    }

    const existing = await this.subscriberRepo.findByImsi(dto.imsi);
    if (existing) {
      throw new Error(`Subscriber with IMSI ${dto.imsi} already exists`);
    }

    const subscriber: Subscriber = {
      ...dto,
      schema_version: 1,
      __v: 0,
    };

    await this.subscriberRepo.create(subscriber);

    this.logger.info({ imsi: dto.imsi }, 'Subscriber created');
    await this.auditLogger.log({
      action: 'subscriber_create',
      user: 'admin',
      target: dto.imsi,
      success: true,
    });
  }

  async update(imsi: string, dto: Partial<SubscriberDto>): Promise<void> {
    const existing = await this.subscriberRepo.findByImsi(imsi);
    if (!existing) {
      throw new Error(`Subscriber with IMSI ${imsi} not found`);
    }

    if (dto.imsi && dto.imsi !== imsi) {
      const conflict = await this.subscriberRepo.findByImsi(dto.imsi);
      if (conflict) {
        throw new Error(`Subscriber with IMSI ${dto.imsi} already exists`);
      }
    }

    await this.subscriberRepo.update(imsi, dto);

    this.logger.info({ imsi }, 'Subscriber updated');
    await this.auditLogger.log({
      action: 'subscriber_update',
      user: 'admin',
      target: imsi,
      success: true,
    });
  }

  async delete(imsi: string): Promise<void> {
    const existing = await this.subscriberRepo.findByImsi(imsi);
    if (!existing) {
      throw new Error(`Subscriber with IMSI ${imsi} not found`);
    }

    await this.subscriberRepo.delete(imsi);

    this.logger.info({ imsi }, 'Subscriber deleted');
    await this.auditLogger.log({
      action: 'subscriber_delete',
      user: 'admin',
      target: imsi,
      success: true,
    });
  }
}
