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

  async findAll(
    skip: number = 0,
    limit: number = 50,
    sortOrder: 'asc' | 'desc' = 'asc',
    sortBy: 'imsi' | 'ue_ipv4' | 'apn' = 'imsi',
  ): Promise<SubscriberListItem[]> {
    const sortDir = sortOrder === 'desc' ? -1 : 1;

    // Map sortBy to MongoDB field paths
    // ue_ipv4 and apn live inside the nested slice/session array.
    // MongoDB can't sort on nested array fields directly, so we use
    // aggregation with $addFields to extract the first value for sorting.
    const needsAgg = sortBy === 'ue_ipv4' || sortBy === 'apn';

    if (needsAgg) {
      const sortField = sortBy === 'ue_ipv4'
        ? 'slice.0.session.0.ue.ipv4'
        : 'slice.0.session.0.name';

      const docs = await this.collection.aggregate([
        { $addFields: { _sortKey: { $ifNull: [`${sortField}`, ''] } } },
        { $sort: { _sortKey: sortDir, imsi: 1 } },
        { $skip: skip },
        { $limit: limit },
        { $project: { imsi: 1, nickname: 1, iccid: 1, msisdn: 1, slice: 1 } },
      ]).toArray();

      return this.mapToListItems(docs);
    }

    // Default: sort by imsi
    const docs = await this.collection
      .find({})
      .project({ imsi: 1, nickname: 1, iccid: 1, msisdn: 1, slice: 1 })
      .sort({ imsi: sortDir })
      .skip(skip)
      .limit(limit)
      .toArray();

    return this.mapToListItems(docs);
  }

  private mapToListItems(docs: any[]): SubscriberListItem[] {
    return docs.map((doc) => {
      const firstSlice   = Array.isArray(doc.slice)   ? doc.slice[0]            : undefined;
      const firstSession = Array.isArray(firstSlice?.session) ? firstSlice.session[0] : undefined;
      return {
        imsi:          doc.imsi     as string,
        nickname:      doc.nickname as string | undefined,
        iccid:         doc.iccid   as string | undefined,
        msisdn:        doc.msisdn  as string[] | undefined,
        slice_count:   Array.isArray(doc.slice) ? doc.slice.length : 0,
        session_count: Array.isArray(doc.slice)
          ? doc.slice.reduce(
              (sum: number, s: { session?: unknown[] }) =>
                sum + (Array.isArray(s.session) ? s.session.length : 0),
              0,
            )
          : 0,
        ue_ipv4: firstSession?.ue?.ipv4 as string | undefined,
        apn:     firstSession?.name     as string | undefined,
      };
    });
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
      .project({ imsi: 1, nickname: 1, iccid: 1, msisdn: 1, slice: 1 })
      .skip(skip)
      .limit(limit)
      .toArray();

    return this.mapToListItems(docs);
  }

  async getNicknamesByImsi(imsis: string[]): Promise<Record<string, string>> {
    if (!imsis.length) return {};
    const docs = await this.collection
      .find({ imsi: { $in: imsis } })
      .project({ imsi: 1, nickname: 1 })
      .toArray();
    const result: Record<string, string> = {};
    for (const doc of docs) {
      if (doc.nickname) result[doc.imsi as string] = doc.nickname as string;
    }
    return result;
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

  async findAllFull(): Promise<Subscriber[]> {
    const docs = await this.collection.find({}).toArray();
    return docs as unknown as Subscriber[];
  }

  async assignIPv4(imsi: string, ipv4: string): Promise<void> {
    // Assign IPv4 to the first session of the first slice
    await this.collection.updateOne(
      { imsi },
      {
        $set: {
          'slice.0.session.0.ue.ipv4': ipv4,
        },
      },
    );
    this.logger.info({ imsi, ipv4 }, 'Assigned IPv4 to subscriber');
  }
}
