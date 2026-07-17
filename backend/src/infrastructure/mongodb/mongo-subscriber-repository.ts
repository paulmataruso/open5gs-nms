import { Collection, Db, MongoClient } from 'mongodb';
import pino from 'pino';
import { ISubscriberRepository } from '../../domain/interfaces/subscriber-repository';
import { Subscriber, SubscriberListItem, FramedRouteEntry } from '../../domain/entities/subscriber';

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

  getDb(): Db {
    return this.db;
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
      const sessions: { apn: string; ipv4?: string; framedRoutes?: string[] }[] = Array.isArray(doc.slice)
        ? doc.slice.flatMap((s: { session?: { name?: string; ue?: { ipv4?: string }; ipv4_framed_routes?: string[] }[] }) =>
            Array.isArray(s.session)
              ? s.session.map(sess => ({ apn: sess.name ?? '', ipv4: sess.ue?.ipv4, framedRoutes: sess.ipv4_framed_routes }))
              : [])
        : [];
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
        ue_ipv4:  firstSession?.ue?.ipv4 as string | undefined,
        apn:      firstSession?.name     as string | undefined,
        sessions,
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

  async assignIPv4ByApn(imsi: string, apn: string, ipv4: string): Promise<void> {
    // Update the first session matching the given APN name within any slice
    await this.collection.updateOne(
      { imsi, 'slice.session.name': apn },
      { $set: { 'slice.$[sl].session.$[sess].ue.ipv4': ipv4 } },
      { arrayFilters: [{ 'sl.session.name': apn }, { 'sess.name': apn }] } as any,
    );
    this.logger.info({ imsi, apn, ipv4 }, 'Assigned IPv4 to APN session');
  }

  async removeImsSessionFromAll(): Promise<number> {
    const result = await this.collection.updateMany(
      {},
      { $pull: { 'slice.$[].session': { name: 'ims' } } } as any,
    );
    this.logger.info({ modified: result.modifiedCount }, 'Removed IMS sessions from subscribers');
    return result.modifiedCount;
  }

  async getAllFramedRoutes(excludeImsi?: string): Promise<FramedRouteEntry[]> {
    const filter = excludeImsi ? { imsi: { $ne: excludeImsi } } : {};
    const docs = await this.collection
      .find(filter)
      .project({ imsi: 1, nickname: 1, slice: 1 })
      .toArray();

    const entries: FramedRouteEntry[] = [];
    for (const doc of docs as any[]) {
      if (!Array.isArray(doc.slice)) continue;
      for (const slice of doc.slice) {
        if (!Array.isArray(slice.session)) continue;
        for (const sess of slice.session) {
          const ipv4 = sess.ipv4_framed_routes ?? [];
          const ipv6 = sess.ipv6_framed_routes ?? [];
          if (ipv4.length === 0 && ipv6.length === 0) continue;
          entries.push({
            imsi: doc.imsi,
            nickname: doc.nickname,
            apn: sess.name ?? '',
            ipv4,
            ipv6,
            static: !!sess.framed_routes_static,
          });
        }
      }
    }
    return entries;
  }
}
