import { RfPlanningProject } from '../entities/rf-planning-project';

export interface IRfPlanningProjectRepository {
  findAll(): Promise<RfPlanningProject[]>;
  findById(id: string): Promise<RfPlanningProject | null>;
  create(project: RfPlanningProject): Promise<void>;
  update(id: string, project: Partial<RfPlanningProject>): Promise<void>;
  delete(id: string): Promise<void>;
}
