import { SubscriberManagementUseCase } from '../subscriber-management';

/**
 * Static framed routes used to be keyed `${dnn}::${cidr}` and the CIDR was
 * recovered with `key.split('::')[1]`. `::` is IPv6 zero-compression, so every
 * IPv6 framed route was handed to `ip route add/del` as a truncated prefix:
 *
 *   internet::10.45.0.0/24       -> "10.45.0.0/24"   (fine)
 *   internet::2001:db8::/64      -> "2001:db8"       (wrong)
 *   internet::fd00::1/128        -> "fd00"           (wrong)
 *
 * `ip route` then failed, into a catch that only logs a warning, so the route
 * silently never appeared. IPv4 was unaffected, which is why it survived.
 * Found 2026-11-26 while typing this file's `any[]` slice parameters.
 */
interface RouteCall { cidr: string; dev: string }

function makeUseCase(added: RouteCall[], removed: RouteCall[]): SubscriberManagementUseCase {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  const tunUseCase = {
    addRoute: jest.fn((cidr: string, dev: string) => { added.push({ cidr, dev }); return Promise.resolve(); }),
    removeRoute: jest.fn((cidr: string, dev: string) => { removed.push({ cidr, dev }); return Promise.resolve(); }),
  };
  // resolveDnnDevMap reads smf/upf session lists to map dnn -> dev.
  const configRepo = {
    loadSmf: () => Promise.resolve({ session: [{ dnn: 'internet', subnet: '10.45.0.0/16' }] }),
    loadUpf: () => Promise.resolve({ session: [{ dnn: 'internet', subnet: '10.45.0.0/16', dev: 'ogstun' }] }),
  };
  return new SubscriberManagementUseCase(
    {} as never, {} as never, logger as never, tunUseCase as never, configRepo as never, {} as never,
  );
}

type Slices = Array<{ session?: Array<Record<string, unknown>> }>;

function sync(uc: SubscriberManagementUseCase, oldS: Slices | undefined, newS: Slices | undefined): Promise<void> {
  return (uc as unknown as {
    syncStaticRoutes(a: Slices | undefined, b: Slices | undefined): Promise<void>;
  }).syncStaticRoutes(oldS, newS);
}

const slicesWith = (routes: { v4?: string[]; v6?: string[] }): Slices => [{
  session: [{
    name: 'internet',
    framed_routes_static: true,
    ipv4_framed_routes: routes.v4 ?? [],
    ipv6_framed_routes: routes.v6 ?? [],
  }],
}];

describe('syncStaticRoutes CIDR integrity', () => {
  it('passes an IPv6 prefix through intact', async () => {
    const added: RouteCall[] = [], removed: RouteCall[] = [];
    await sync(makeUseCase(added, removed), [], slicesWith({ v6: ['2001:db8::/64'] }));
    expect(added).toEqual([{ cidr: '2001:db8::/64', dev: 'ogstun' }]);
  });

  it('passes a host-length IPv6 address through intact', async () => {
    const added: RouteCall[] = [], removed: RouteCall[] = [];
    await sync(makeUseCase(added, removed), [], slicesWith({ v6: ['fd00::1/128'] }));
    expect(added).toEqual([{ cidr: 'fd00::1/128', dev: 'ogstun' }]);
  });

  it('passes an IPv6 prefix with interior groups through intact', async () => {
    const added: RouteCall[] = [], removed: RouteCall[] = [];
    await sync(makeUseCase(added, removed), [], slicesWith({ v6: ['2001:db8:1:2::/64'] }));
    expect(added).toEqual([{ cidr: '2001:db8:1:2::/64', dev: 'ogstun' }]);
  });

  it('still handles IPv4, which never broke', async () => {
    const added: RouteCall[] = [], removed: RouteCall[] = [];
    await sync(makeUseCase(added, removed), [], slicesWith({ v4: ['10.45.0.0/24'] }));
    expect(added).toEqual([{ cidr: '10.45.0.0/24', dev: 'ogstun' }]);
  });

  it('removes an IPv6 route intact when it is dropped from the slice', async () => {
    const added: RouteCall[] = [], removed: RouteCall[] = [];
    await sync(makeUseCase(added, removed), slicesWith({ v6: ['2001:db8::/64'] }), []);
    expect(removed).toEqual([{ cidr: '2001:db8::/64', dev: 'ogstun' }]);
  });

  it('adds and removes a mixed v4/v6 change without corrupting either', async () => {
    const added: RouteCall[] = [], removed: RouteCall[] = [];
    await sync(
      makeUseCase(added, removed),
      slicesWith({ v4: ['10.45.0.0/24'], v6: ['2001:db8::/64'] }),
      slicesWith({ v4: ['10.46.0.0/24'], v6: ['2001:db8:9::/64'] }),
    );
    expect(added.map(r => r.cidr).sort()).toEqual(['10.46.0.0/24', '2001:db8:9::/64']);
    expect(removed.map(r => r.cidr).sort()).toEqual(['10.45.0.0/24', '2001:db8::/64']);
  });

  it('does nothing when the route set is unchanged', async () => {
    const added: RouteCall[] = [], removed: RouteCall[] = [];
    const same = slicesWith({ v4: ['10.45.0.0/24'], v6: ['2001:db8::/64'] });
    await sync(makeUseCase(added, removed), same, slicesWith({ v4: ['10.45.0.0/24'], v6: ['2001:db8::/64'] }));
    expect(added).toEqual([]);
    expect(removed).toEqual([]);
  });

  it('ignores a session that has not opted into static routes', async () => {
    const added: RouteCall[] = [], removed: RouteCall[] = [];
    await sync(makeUseCase(added, removed), [], [{
      session: [{ name: 'internet', framed_routes_static: false, ipv6_framed_routes: ['2001:db8::/64'] }],
    }]);
    expect(added).toEqual([]);
  });
});
