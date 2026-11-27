import { Collection, Db, Document, Filter, MongoClient } from 'mongodb';
import pino from 'pino';
import { ISubscriberRepository } from '../../domain/interfaces/subscriber-repository';
import { Subscriber, SubscriberListItem, FramedRouteEntry } from '../../domain/entities/subscriber';
import {
  SubscriberListDoc, str, toSubscriberListItem, framedRouteEntriesOf,
} from './subscriber-doc';

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
        { $project: { imsi: 1, nickname: 1, iccid: 1, simType: 1, msisdn: 1, slice: 1 } },
      ]).toArray();

      return this.mapToListItems(docs);
    }

    // Default: sort by imsi
    const docs = await this.collection
      .find({})
      .project({ imsi: 1, nickname: 1, iccid: 1, simType: 1, msisdn: 1, slice: 1 })
      .sort({ imsi: sortDir })
      .skip(skip)
      .limit(limit)
      .toArray();

    return this.mapToListItems(docs);
  }

  private mapToListItems(docs: SubscriberListDoc[]): SubscriberListItem[] {
    const items: SubscriberListItem[] = [];
    for (const doc of docs) {
      const item = toSubscriberListItem(doc);
      if (item === null) {
        this.logger.warn({ keys: Object.keys(doc) }, 'Skipped a subscriber document with no imsi');
        continue;
      }
      items.push(item);
    }
    return items;
  }

  async findByImsi(imsi: string): Promise<Subscriber | null> {
    const doc = await this.collection.findOne({ imsi });
    if (!doc) return null;
    return doc as unknown as Subscriber;
  }

  async create(subscriber: Subscriber): Promise<void> {
    await this.collection.insertOne(withoutId(subscriber));
  }

  async update(imsi: string, subscriber: Partial<Subscriber>): Promise<void> {
    await this.collection.updateOne({ imsi }, { $set: withoutId(subscriber) });
  }

  async delete(imsi: string): Promise<void> {
    await this.collection.deleteOne({ imsi });
  }

  async count(): Promise<number> {
    return this.collection.countDocuments();
  }

  private searchFilter(query: string): Filter<Document> {
    return {
      $or: [
        { imsi: { $regex: query, $options: 'i' } },
        { msisdn: { $regex: query, $options: 'i' } },
      ],
    };
  }

  async search(query: string, skip: number = 0, limit: number = 50): Promise<SubscriberListItem[]> {
    const docs = await this.collection
      .find(this.searchFilter(query))
      .project({ imsi: 1, nickname: 1, iccid: 1, simType: 1, msisdn: 1, slice: 1 })
      .skip(skip)
      .limit(limit)
      .toArray();

    return this.mapToListItems(docs);
  }

  // Real, confirmed-live 2026-09-30 finding (a full-session live-API verification pass):
  // SubscriberManagementUseCase.search() had no way to get a real match count — it used
  // subscribers.length (the page size actually returned, capped at `limit`) as `total`,
  // breaking "X of Y" pagination for any search matching more results than fit on one
  // page. Shares searchFilter() with search() above so the count can never drift from
  // what's actually being counted.
  async searchCount(query: string): Promise<number> {
    return this.collection.countDocuments(this.searchFilter(query));
  }

  async getNicknamesByImsi(imsis: string[]): Promise<Record<string, string>> {
    if (!imsis.length) return {};
    const docs = await this.collection
      .find({ imsi: { $in: imsis } })
      .project({ imsi: 1, nickname: 1 })
      .toArray();
    const result: Record<string, string> = {};
    for (const doc of docs) {
      const imsi = str(doc.imsi);
      const nickname = str(doc.nickname);
      // Both narrowed: the old form asserted `doc.imsi as string` into the KEY
      // of a Record<string, string>, so a document missing it wrote an entry
      // under the literal key "undefined".
      if (imsi !== undefined && nickname) result[imsi] = nickname;
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
      { arrayFilters: [{ 'sl.session.name': apn }, { 'sess.name': apn }] },
    );
    this.logger.info({ imsi, apn, ipv4 }, 'Assigned IPv4 to APN session');
  }

  async removeImsSessionFromAll(): Promise<number> {
    const result = await this.collection.updateMany(
      {},
      // The driver's $pull type cannot express an all-positional path
      // (`slice.$[].session`), so the update document is built as a plain
      // Document rather than asserted to `any` -- same effect on the wire,
      // but it keeps type checking switched on for everything around it.
      { $pull: { 'slice.$[].session': { name: 'ims' } } } as Document,
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
    for (const doc of docs) entries.push(...framedRouteEntriesOf(doc));
    return entries;
  }
}

/**
 * The document without its `_id`.
 *
 * Mongo assigns `_id` itself, and an entity loaded from one collection then
 * written back carries the old value -- so it is stripped on both the insert
 * and the `$set`. Written as an explicit Omit rather than
 * `const { _id, ...data } = doc`, which reads well but leaves an unused
 * binding the linter is right to flag.
 */
function withoutId<T extends { _id?: unknown }>(doc: T): Omit<T, '_id'> {
  const copy: Record<string, unknown> = { ...doc };
  delete copy._id;
  return copy as Omit<T, '_id'>;
}
