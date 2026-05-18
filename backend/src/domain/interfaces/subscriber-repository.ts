import { Subscriber, SubscriberListItem } from '../entities/subscriber';

export interface ISubscriberRepository {
  findAll(skip?: number, limit?: number, sortOrder?: 'asc' | 'desc', sortBy?: 'imsi' | 'ue_ipv4' | 'apn'): Promise<SubscriberListItem[]>;
  findAllFull(): Promise<Subscriber[]>; // Get all full subscriber records
  findByImsi(imsi: string): Promise<Subscriber | null>;  
  create(subscriber: Subscriber): Promise<void>;
  update(imsi: string, subscriber: Partial<Subscriber>): Promise<void>;
  delete(imsi: string): Promise<void>;
  count(): Promise<number>;
  search(query: string, skip?: number, limit?: number): Promise<SubscriberListItem[]>;
  getNicknamesByImsi(imsis: string[]): Promise<Record<string, string>>;
  updateSDForAll(sd: string, sst?: number): Promise<number>;
  assignIPv4(imsi: string, ipv4: string): Promise<void>;
}
