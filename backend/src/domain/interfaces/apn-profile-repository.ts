import { ApnProfile } from '../entities/apn-profile';

export interface IApnProfileRepository {
  findAll(): Promise<ApnProfile[]>;
  findById(id: string): Promise<ApnProfile | null>;
  findByDnn(dnn: string): Promise<ApnProfile | null>;
  create(profile: ApnProfile): Promise<void>;
  update(id: string, profile: Partial<ApnProfile>): Promise<void>;
  delete(id: string): Promise<void>;
  // #30 follow-up (2026-08-25): a single, core-wide IPv6 "parent" prefix
  // (e.g. a /48 or /56) that new APN profiles carve their own /64 out of.
  // null until an operator sets one — auto-allocation is opt-in by
  // configuring this, existing IPv4-only deployments see no change.
  getIPv6ParentPrefix(): Promise<string | null>;
  setIPv6ParentPrefix(parentPrefix: string): Promise<void>;
}
