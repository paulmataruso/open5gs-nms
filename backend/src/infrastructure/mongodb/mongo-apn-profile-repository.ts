import { Collection, Db, MongoClient } from 'mongodb';
import pino from 'pino';
import { IApnProfileRepository } from '../../domain/interfaces/apn-profile-repository';
import { ApnProfile } from '../../domain/entities/apn-profile';

const IPV6_SETTINGS_ID = 'global';

export class MongoApnProfileRepository implements IApnProfileRepository {
  private collection!: Collection;
  // Single-document settings collection (`_id: 'global'`) — same lightweight
  // pattern as TWAMP's history-retention settings elsewhere in this app,
  // rather than a whole new repository class for one string field.
  private ipv6SettingsCollection!: Collection;
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
    this.ipv6SettingsCollection = this.db.collection('apn_ipv6_pool_settings');
    this.logger.info('Connected to MongoDB (APN profiles)');
  }

  async getIPv6ParentPrefix(): Promise<string | null> {
    const doc = await this.ipv6SettingsCollection.findOne({ _id: IPV6_SETTINGS_ID as any });
    return (doc?.parentPrefix as string | undefined) ?? null;
  }

  async setIPv6ParentPrefix(parentPrefix: string): Promise<void> {
    await this.ipv6SettingsCollection.updateOne(
      { _id: IPV6_SETTINGS_ID as any },
      { $set: { parentPrefix, updatedAt: new Date().toISOString() } },
      { upsert: true },
    );
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
