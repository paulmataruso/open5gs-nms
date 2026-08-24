import { ApnProfile } from '../entities/apn-profile';

export interface IApnProfileRepository {
  findAll(): Promise<ApnProfile[]>;
  findById(id: string): Promise<ApnProfile | null>;
  findByDnn(dnn: string): Promise<ApnProfile | null>;
  create(profile: ApnProfile): Promise<void>;
  update(id: string, profile: Partial<ApnProfile>): Promise<void>;
  delete(id: string): Promise<void>;
}
