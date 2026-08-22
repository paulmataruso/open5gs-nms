import { Collection, Db, MongoClient } from 'mongodb';
import pino from 'pino';
import { IRfPlanningProjectRepository } from '../../domain/interfaces/rf-planning-project-repository';
import { RfPlanningProject } from '../../domain/entities/rf-planning-project';

export class MongoRfPlanningProjectRepository implements IRfPlanningProjectRepository {
  private collection!: Collection;
  private client: MongoClient;
  private db!: Db;

  constructor(
    private readonly uri: string,
    private readonly logger: pino.Logger,
  ) {
    this.client = new MongoClient(uri);
  }

  async connect(): Promise<void> {
    await this.client.connect();
    this.db = this.client.db('open5gs');
    this.collection = this.db.collection('rf_planning_projects');
    await this.collection.createIndex({ id: 1 }, { unique: true });
    this.logger.info('Connected to MongoDB (RF planning projects)');
  }

  async disconnect(): Promise<void> {
    await this.client.close();
  }

  async findAll(): Promise<RfPlanningProject[]> {
    const docs = await this.collection.find().sort({ updatedAt: -1 }).toArray();
    return docs.map(d => this.strip(d));
  }

  async findById(id: string): Promise<RfPlanningProject | null> {
    const doc = await this.collection.findOne({ id });
    return doc ? this.strip(doc) : null;
  }

  async create(project: RfPlanningProject): Promise<void> {
    await this.collection.insertOne(project as unknown as Record<string, unknown>);
  }

  async update(id: string, project: Partial<RfPlanningProject>): Promise<void> {
    await this.collection.updateOne({ id }, { $set: project });
  }

  async delete(id: string): Promise<void> {
    await this.collection.deleteOne({ id });
  }

  private strip(doc: Record<string, unknown>): RfPlanningProject {
    const { _id, ...rest } = doc;
    void _id;
    return rest as unknown as RfPlanningProject;
  }
}
