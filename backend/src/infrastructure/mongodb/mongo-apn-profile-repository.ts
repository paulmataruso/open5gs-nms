import { Collection, Db, MongoClient } from 'mongodb';
import pino from 'pino';
import { IApnProfileRepository } from '../../domain/interfaces/apn-profile-repository';
import { ApnProfile } from '../../domain/entities/apn-profile';

export class MongoApnProfileRepository implements IApnProfileRepository {
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
    this.collection = this.db.collection('apn_profiles');
    await this.collection.createIndex({ id: 1 }, { unique: true });
    await this.collection.createIndex({ dnn: 1 }, { unique: true });
    this.logger.info('Connected to MongoDB (APN profiles)');
  }

  async disconnect(): Promise<void> {
    await this.client.close();
  }

  async findAll(): Promise<ApnProfile[]> {
    const docs = await this.collection.find().sort({ dnn: 1 }).toArray();
    return docs.map((d) => this.strip(d));
  }

  async findById(id: string): Promise<ApnProfile | null> {
    const doc = await this.collection.findOne({ id });
    return doc ? this.strip(doc) : null;
  }

  async findByDnn(dnn: string): Promise<ApnProfile | null> {
    const doc = await this.collection.findOne({ dnn });
    return doc ? this.strip(doc) : null;
  }

  async create(profile: ApnProfile): Promise<void> {
    await this.collection.insertOne(profile as unknown as Record<string, unknown>);
  }

  async update(id: string, profile: Partial<ApnProfile>): Promise<void> {
    await this.collection.updateOne({ id }, { $set: profile });
  }

  async delete(id: string): Promise<void> {
    await this.collection.deleteOne({ id });
  }

  private strip(doc: Record<string, unknown>): ApnProfile {
    const { _id, ...rest } = doc;
    void _id;
    return rest as unknown as ApnProfile;
  }
}
