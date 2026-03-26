import { Subscriber, SubscriberListItem } from '../entities/subscriber';

export interface ISubscriberRepository {
  findAll(skip?: number, limit?: number): Promise<SubscriberListItem[]>;
  findByImsi(imsi: string): Promise<Subscriber | null>;
  create(subscriber: Subscriber): Promise<void>;
  update(imsi: string, subscriber: Partial<Subscriber>): Promise<void>;
  delete(imsi: string): Promise<void>;
  count(): Promise<number>;
  search(query: string, skip?: number, limit?: number): Promise<SubscriberListItem[]>;
}
