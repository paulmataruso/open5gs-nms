import { Collection, Db, MongoClient } from 'mongodb';
import pino from 'pino';
import { ISubscriberRepository } from '../../domain/interfaces/subscriber-repository';
import { Subscriber, SubscriberListItem } from '../../domain/entities/subscriber';

export class MongoSubscriberRepository implements ISubscriberRepository {
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
    this.collection = this.db.collection('subscribers');
    this.logger.info('Connected to MongoDB');
  }

  async disconnect(): Promise<void> {
    await this.client.close();
  }

  async findAll(skip: number = 0, limit: number = 50): Promise<SubscriberListItem[]> {
    const docs = await this.collection
      .find({})
      .project({ imsi: 1, msisdn: 1, slice: 1 })
      .skip(skip)
      .limit(limit)
      .toArray();

    return docs.map((doc) => ({
      imsi: doc.imsi as string,
      msisdn: doc.msisdn as string[] | undefined,
      slice_count: Array.isArray(doc.slice) ? doc.slice.length : 0,
      session_count: Array.isArray(doc.slice)
        ? doc.slice.reduce(
            (sum: number, s: { session?: unknown[] }) =>
              sum + (Array.isArray(s.session) ? s.session.length : 0),
            0,
          )
        : 0,
    }));
  }

  async findByImsi(imsi: string): Promise<Subscriber | null> {
    const doc = await this.collection.findOne({ imsi });
    if (!doc) return null;
    return doc as unknown as Subscriber;
  }

  async create(subscriber: Subscriber): Promise<void> {
    const { _id, ...data } = subscriber;
    await this.collection.insertOne(data);
  }

  async update(imsi: string, subscriber: Partial<Subscriber>): Promise<void> {
    const { _id, ...data } = subscriber;
    await this.collection.updateOne({ imsi }, { $set: data });
  }

  async delete(imsi: string): Promise<void> {
    await this.collection.deleteOne({ imsi });
  }

  async count(): Promise<number> {
    return this.collection.countDocuments();
  }

  async search(query: string, skip: number = 0, limit: number = 50): Promise<SubscriberListItem[]> {
    const filter = {
      $or: [
        { imsi: { $regex: query, $options: 'i' } },
        { msisdn: { $regex: query, $options: 'i' } },
      ],
    };

    const docs = await this.collection
      .find(filter)
      .project({ imsi: 1, msisdn: 1, slice: 1 })
      .skip(skip)
      .limit(limit)
      .toArray();

    return docs.map((doc) => ({
      imsi: doc.imsi as string,
      msisdn: doc.msisdn as string[] | undefined,
      slice_count: Array.isArray(doc.slice) ? doc.slice.length : 0,
      session_count: Array.isArray(doc.slice)
        ? doc.slice.reduce(
            (sum: number, s: { session?: unknown[] }) =>
              sum + (Array.isArray(s.session) ? s.session.length : 0),
            0,
          )
        : 0,
    }));
  }

  async updateSDForAll(sd: string, sst?: number): Promise<number> {
    // Build the filter - optionally match SST
    const filter = sst ? { 'slice.sst': sst } : {};

    // Update all matching slice entries
    // If SST is specified, only update slices with that SST
    // Otherwise, update all slices
    const result = await this.collection.updateMany(
      filter,
      {
        $set: {
          'slice.$[elem].sd': sd,
        },
      },
      {
        arrayFilters: sst ? [{ 'elem.sst': sst }] : [{}],
      },
    );

    this.logger.info(
      { matched: result.matchedCount, modified: result.modifiedCount, sd, sst },
      'Updated SD for subscribers',
    );

    return result.modifiedCount;
  }
}
