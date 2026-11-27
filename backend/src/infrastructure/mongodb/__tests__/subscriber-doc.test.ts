import {
  toSubscriberListItem, framedRouteEntriesOf, str, strArray, simType, field, objArray,
} from '../subscriber-doc';

/**
 * Reading a subscriber document. These were `any` member accesses through a
 * `Collection<Document>`, so nothing beneath them was checked, and two of the
 * reads ended in assertions that could put a non-string through a field
 * declared `string`.
 *
 * The fixture is the real document shape in this deployment's
 * `open5gs.subscribers`: slices holding sessions, each session with its own
 * `ue.ipv4` and optional framed routes. Two APNs per subscriber is the normal
 * case here, not an edge one — `internet` and `ims` (see CLAUDE.md on the IMS
 * APN carrying the only SIP/RTP-bearing session).
 */
const REAL_DOC = {
  imsi: '001010000053555',
  nickname: 'test handset',
  iccid: '8901010000000535559',
  simType: 'physical',
  msisdn: ['15550000001'],
  slice: [{
    sst: 1,
    session: [
      { name: 'internet', ue: { ipv4: '10.45.0.70' } },
      { name: 'ims', ue: { ipv4: '10.46.0.70' } },
    ],
  }],
};

describe('toSubscriberListItem', () => {
  it('maps a real document', () => {
    expect(toSubscriberListItem(REAL_DOC)).toEqual({
      imsi: '001010000053555',
      nickname: 'test handset',
      iccid: '8901010000000535559',
      simType: 'physical',
      msisdn: ['15550000001'],
      slice_count: 1,
      session_count: 2,
      ue_ipv4: '10.45.0.70',
      apn: 'internet',
      sessions: [
        { apn: 'internet', ipv4: '10.45.0.70', framedRoutes: undefined },
        { apn: 'ims', ipv4: '10.46.0.70', framedRoutes: undefined },
      ],
    });
  });

  it('returns null for a document with no imsi', () => {
    // The defect. `doc.imsi as string` produced a row whose imsi was
    // `undefined` through a field declared `string`: it renders blank, and
    // every per-row action (edit, delete, assign plan) keys off that imsi, so
    // the row silently acted on nothing.
    expect(toSubscriberListItem({ nickname: 'orphan' })).toBeNull();
    expect(toSubscriberListItem({ imsi: null })).toBeNull();
    expect(toSubscriberListItem({ imsi: 1010000053555 })).toBeNull();
  });

  it('counts sessions across every slice, not just the first', () => {
    const got = toSubscriberListItem({
      imsi: '1', slice: [
        { session: [{ name: 'a' }, { name: 'b' }] },
        { session: [{ name: 'c' }] },
      ],
    });
    expect(got?.slice_count).toBe(2);
    expect(got?.session_count).toBe(3);
    expect(got?.sessions?.map(s => s.apn)).toEqual(['a', 'b', 'c']);
  });

  it('reports zero counts for a subscriber with no slices', () => {
    const got = toSubscriberListItem({ imsi: '1' });
    expect(got?.slice_count).toBe(0);
    expect(got?.session_count).toBe(0);
    expect(got?.sessions).toEqual([]);
    expect(got?.ue_ipv4).toBeUndefined();
    expect(got?.apn).toBeUndefined();
  });

  it('survives slice or session being a scalar rather than an array', () => {
    // A projection returns what the document holds, and these documents are
    // also written by Open5GS's own WebUI and by hand.
    for (const slice of [null, 'x', 5, {}, true]) {
      const got = toSubscriberListItem({ imsi: '1', slice });
      expect(got?.slice_count).toBe(0);
      expect(got?.session_count).toBe(0);
    }
    const scalarSession = toSubscriberListItem({ imsi: '1', slice: [{ session: 'nope' }] });
    expect(scalarSession?.slice_count).toBe(1);
    expect(scalarSession?.session_count).toBe(0);
  });

  it('skips a null session entry without throwing', () => {
    const got = toSubscriberListItem({ imsi: '1', slice: [{ session: [null, { name: 'a' }] }] });
    expect(got?.sessions).toEqual([
      { apn: '', ipv4: undefined, framedRoutes: undefined },
      { apn: 'a', ipv4: undefined, framedRoutes: undefined },
    ]);
  });

  it('reports an unrecognised simType as absent rather than passing it through', () => {
    // SubscriberListItem declares 'esim' | 'physical' | null.
    expect(toSubscriberListItem({ imsi: '1', simType: 'esim' })?.simType).toBe('esim');
    expect(toSubscriberListItem({ imsi: '1', simType: null })?.simType).toBeNull();
    for (const v of ['eSIM', 'sim', 5, {}, true]) {
      expect(toSubscriberListItem({ imsi: '1', simType: v })?.simType).toBeUndefined();
    }
  });

  it('keeps only the real strings in msisdn', () => {
    expect(toSubscriberListItem({ imsi: '1', msisdn: ['15550000001', 15550000002, null] })?.msisdn)
      .toEqual(['15550000001']);
    expect(toSubscriberListItem({ imsi: '1', msisdn: '15550000001' })?.msisdn).toBeUndefined();
  });

  it('reports a non-string ue.ipv4 as absent', () => {
    const got = toSubscriberListItem({ imsi: '1', slice: [{ session: [{ name: 'internet', ue: { ipv4: 123 } }] }] });
    expect(got?.ue_ipv4).toBeUndefined();
  });
});

describe('framedRouteEntriesOf', () => {
  it('reports a session carrying real framed routes', () => {
    expect(framedRouteEntriesOf({
      imsi: '001010000053555', nickname: 'cpe',
      slice: [{ session: [{ name: 'internet', ipv4_framed_routes: ['192.168.90.0/24'], framed_routes_static: true }] }],
    })).toEqual([{
      imsi: '001010000053555', nickname: 'cpe', apn: 'internet',
      ipv4: ['192.168.90.0/24'], ipv6: [], static: true,
    }]);
  });

  it('skips a session with no routes on either family', () => {
    expect(framedRouteEntriesOf({ imsi: '1', slice: [{ session: [{ name: 'internet' }] }] })).toEqual([]);
    expect(framedRouteEntriesOf({
      imsi: '1', slice: [{ session: [{ name: 'internet', ipv4_framed_routes: [], ipv6_framed_routes: [] }] }],
    })).toEqual([]);
  });

  it('reports a STRING framed-routes field as no routes at all', () => {
    // The defect this closes. These entries feed subscriber-management's
    // overlap check, which iterates `ipv4` and hands each element to
    // ipv4CidrOverlaps(). A bare string passed the old `.length === 0` test —
    // a non-empty string has a length — went through a field declared
    // `string[]`, and was then iterated CHARACTER BY CHARACTER into the CIDR
    // parser, which throws on "1".
    expect(framedRouteEntriesOf({
      imsi: '1', slice: [{ session: [{ name: 'internet', ipv4_framed_routes: '192.168.90.0/24' }] }],
    })).toEqual([]);
  });

  it('keeps only the real CIDR strings out of a mixed array', () => {
    const got = framedRouteEntriesOf({
      imsi: '1', slice: [{ session: [{ name: 'internet', ipv4_framed_routes: ['10.1.0.0/24', 42, null] }] }],
    });
    expect(got[0].ipv4).toEqual(['10.1.0.0/24']);
  });

  it('treats a non-boolean framed_routes_static as false', () => {
    // It drives whether a real host route is installed on the host, so
    // "truthy" is not good enough.
    const got = framedRouteEntriesOf({
      imsi: '1', slice: [{ session: [{ name: 'a', ipv4_framed_routes: ['10.1.0.0/24'], framed_routes_static: 'yes' }] }],
    });
    expect(got[0].static).toBe(false);
  });

  it('reports every route-carrying session across every slice', () => {
    const got = framedRouteEntriesOf({
      imsi: '1', slice: [
        { session: [{ name: 'internet', ipv4_framed_routes: ['10.1.0.0/24'] }, { name: 'quiet' }] },
        { session: [{ name: 'ims', ipv6_framed_routes: ['2001:db8::/64'] }] },
      ],
    });
    expect(got.map(e => e.apn)).toEqual(['internet', 'ims']);
    expect(got[1].ipv6).toEqual(['2001:db8::/64']);
  });

  it('is empty for a document with no imsi — an entry keyed on undefined is useless', () => {
    expect(framedRouteEntriesOf({
      slice: [{ session: [{ name: 'internet', ipv4_framed_routes: ['10.1.0.0/24'] }] }],
    })).toEqual([]);
  });
});

describe('the readers', () => {
  it('str keeps only strings', () => {
    expect(str('x')).toBe('x');
    expect(str('')).toBe('');
    for (const v of [undefined, null, 0, true, {}, []]) expect(str(v)).toBeUndefined();
  });

  it('strArray is undefined for a non-array and filters within one', () => {
    expect(strArray(['a', 1, 'b'])).toEqual(['a', 'b']);
    expect(strArray('a')).toBeUndefined();
    expect(strArray(null)).toBeUndefined();
    expect(strArray([])).toEqual([]);
  });

  it('simType accepts only the declared values', () => {
    expect(simType('esim')).toBe('esim');
    expect(simType('physical')).toBe('physical');
    expect(simType(null)).toBeNull();
    expect(simType('other')).toBeUndefined();
  });

  it('field reads an own property and tolerates a non-object', () => {
    expect(field({ a: 1 }, 'a')).toBe(1);
    expect(field(null, 'a')).toBeUndefined();
    expect(field('str', 'length')).toBeUndefined();
    expect(field(5, 'a')).toBeUndefined();
  });

  it('objArray is empty for a non-array', () => {
    expect(objArray([1, 2])).toEqual([1, 2]);
    for (const v of [undefined, null, 'x', {}, 5]) expect(objArray(v)).toEqual([]);
  });
});
