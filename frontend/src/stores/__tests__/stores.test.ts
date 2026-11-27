// The four core zustand stores, executed against a stubbed api layer.
//
// Worth testing rather than reading: these are the only place in the frontend
// where a failed request decides what the UI shows, and each store answers
// that question differently on purpose (one records an error, two swallow it,
// one logs it). Those differences are invisible in a read-through and
// load-bearing at runtime.
//
// Mocking '../api' rather than fetch: the stores' contract is with the api
// client, not with HTTP, and stubbing fetch would also be asserting on
// api/index.ts's URL building — which belongs to that module's own test, not
// to these.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const configApi = {
  getAll: vi.fn(),
  validate: vi.fn(),
  getTopology: vi.fn(),
};
const serviceApi = { getAll: vi.fn() };
const subscriberApi = { list: vi.fn() };
const interfaceApi = { getStatus: vi.fn() };

vi.mock('../../api', () => ({ configApi, serviceApi, subscriberApi, interfaceApi }));

const { useConfigStore, useServiceStore, useTopologyStore, useSubscriberStore } =
  await import('../index');

// Captured once, so each test starts from the store's real initial state
// rather than from whatever the previous test left behind.
const initial = {
  config: useConfigStore.getState(),
  service: useServiceStore.getState(),
  topology: useTopologyStore.getState(),
  subscriber: useSubscriberStore.getState(),
};

beforeEach(() => {
  vi.clearAllMocks();
  useConfigStore.setState(initial.config, true);
  useServiceStore.setState(initial.service, true);
  useTopologyStore.setState(initial.topology, true);
  useSubscriberStore.setState(initial.subscriber, true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useConfigStore', () => {
  it('loads configs and clears dirty, because a fresh load is by definition unedited', () => {
    expect(useConfigStore.getState().configs).toBeNull();
    expect(useConfigStore.getState().dirty).toBe(false);
  });

  it('fetchConfigs records the configs and leaves loading false', async () => {
    configApi.getAll.mockResolvedValue({ amf: { rawYaml: {} } });
    useConfigStore.setState({ dirty: true });
    await useConfigStore.getState().fetchConfigs();
    const s = useConfigStore.getState();
    expect(s.configs).toEqual({ amf: { rawYaml: {} } });
    expect(s.loading).toBe(false);
    // A reload replaces what the editor was holding, so unsaved-changes state
    // must not survive it — otherwise the UI offers to save edits that are gone.
    expect(s.dirty).toBe(false);
  });

  it('fetchConfigs records the error and does NOT leave loading stuck on', async () => {
    configApi.getAll.mockRejectedValue(new Error('502 Bad Gateway'));
    await useConfigStore.getState().fetchConfigs();
    const s = useConfigStore.getState();
    expect(s.error).toContain('502 Bad Gateway');
    expect(s.loading).toBe(false);
    // Deliberately asserted: a failed load must not leave a stale config on
    // screen as though it were current.
    expect(s.configs).toBeNull();
  });

  it('updateConfigs marks dirty — this is what drives the unsaved-changes guard', () => {
    useConfigStore.getState().updateConfigs({ amf: {} } as never);
    expect(useConfigStore.getState().dirty).toBe(true);
  });

  it('validate throws rather than calling the API with nothing loaded', async () => {
    await expect(useConfigStore.getState().validate()).rejects.toThrow('No configs loaded');
    expect(configApi.validate).not.toHaveBeenCalled();
  });

  it('validate stores the result and returns it', async () => {
    const result = { valid: false, errors: ['amf: missing plmn'] };
    configApi.validate.mockResolvedValue(result);
    useConfigStore.setState({ configs: { amf: {} } as never });
    await expect(useConfigStore.getState().validate()).resolves.toBe(result);
    expect(useConfigStore.getState().validation).toBe(result);
  });

  it('validate does NOT swallow a rejection — a failed validation must not read as valid', async () => {
    configApi.validate.mockRejectedValue(new Error('timeout'));
    useConfigStore.setState({ configs: { amf: {} } as never });
    await expect(useConfigStore.getState().validate()).rejects.toThrow('timeout');
    expect(useConfigStore.getState().validation).toBeNull();
  });
});

describe('useServiceStore', () => {
  it('fetchStatuses stores the statuses', async () => {
    serviceApi.getAll.mockResolvedValue([{ name: 'open5gs-amfd', active: true }]);
    await useServiceStore.getState().fetchStatuses();
    expect(useServiceStore.getState().statuses).toHaveLength(1);
    expect(useServiceStore.getState().loading).toBe(false);
  });

  it('keeps the LAST KNOWN statuses when a poll fails, rather than blanking the dashboard', async () => {
    serviceApi.getAll.mockResolvedValueOnce([{ name: 'open5gs-amfd', active: true }]);
    await useServiceStore.getState().fetchStatuses();
    serviceApi.getAll.mockRejectedValueOnce(new Error('network'));
    await useServiceStore.getState().fetchStatuses();
    // This store polls. Clearing on a single failed poll would make every NF
    // flash to "unknown" on one dropped request, which reads as an outage.
    expect(useServiceStore.getState().statuses).toHaveLength(1);
    expect(useServiceStore.getState().loading).toBe(false);
  });
});

describe('useTopologyStore', () => {
  it('fetchTopology stores the graph', async () => {
    configApi.getTopology.mockResolvedValue({ nodes: [], edges: [] });
    await useTopologyStore.getState().fetchTopology();
    expect(useTopologyStore.getState().graph).toEqual({ nodes: [], edges: [] });
  });

  it('a failed topology fetch logs and clears loading', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    configApi.getTopology.mockRejectedValue(new Error('nope'));
    await useTopologyStore.getState().fetchTopology();
    expect(useTopologyStore.getState().loading).toBe(false);
    expect(err).toHaveBeenCalled();
  });

  it('a failed interface-status fetch leaves the previous status in place', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    interfaceApi.getStatus.mockResolvedValueOnce({ activeUEs4G: [{ imsi: '001010000000001' }] });
    await useTopologyStore.getState().fetchInterfaceStatus();
    interfaceApi.getStatus.mockRejectedValueOnce(new Error('network'));
    await useTopologyStore.getState().fetchInterfaceStatus();
    // Same reasoning as the service poll: this feeds the live RAN/UE panels.
    expect(useTopologyStore.getState().interfaceStatus).not.toBeNull();
    expect(err).toHaveBeenCalled();
  });
});

describe('useSubscriberStore', () => {
  it('fetches the first page with the default window', async () => {
    subscriberApi.list.mockResolvedValue({ subscribers: [], total: 0 });
    await useSubscriberStore.getState().fetchSubscribers();
    expect(subscriberApi.list).toHaveBeenCalledWith(0, 50, undefined);
  });

  it('turns an empty search string into undefined, not an empty filter', async () => {
    subscriberApi.list.mockResolvedValue({ subscribers: [], total: 0 });
    useSubscriberStore.setState({ search: '' });
    await useSubscriberStore.getState().fetchSubscribers();
    // `''` as a query parameter is a filter for the empty string on some
    // backends; `undefined` omits it. These are not the same request.
    expect(subscriberApi.list).toHaveBeenCalledWith(0, 50, undefined);
  });

  it('offsets by page * 50', async () => {
    subscriberApi.list.mockResolvedValue({ subscribers: [], total: 0 });
    useSubscriberStore.setState({ page: 3, search: '0010100' });
    await useSubscriberStore.getState().fetchSubscribers();
    expect(subscriberApi.list).toHaveBeenCalledWith(150, 50, '0010100');
  });

  it('setSearch resets to page 0 — otherwise a new search starts on page 4', () => {
    subscriberApi.list.mockResolvedValue({ subscribers: [], total: 0 });
    useSubscriberStore.setState({ page: 4 });
    useSubscriberStore.getState().setSearch('555');
    expect(useSubscriberStore.getState().page).toBe(0);
    expect(useSubscriberStore.getState().search).toBe('555');
  });

  it('the sort setters do NOT refetch, because sorting is client-side', () => {
    useSubscriberStore.getState().setSortBy('ue_ipv4');
    useSubscriberStore.getState().setSortOrder('desc');
    useSubscriberStore.getState().setSort('apn', 'asc');
    expect(subscriberApi.list).not.toHaveBeenCalled();
    expect(useSubscriberStore.getState().sortBy).toBe('apn');
    expect(useSubscriberStore.getState().sortOrder).toBe('asc');
  });

  it('a late reply from a SUPERSEDED search does not overwrite the current one', async () => {
    // The real bug this found. Typing in the search box calls setSearch per
    // keystroke, each firing its own request, and nothing ordered the
    // replies: a slow earlier request landing after a fast later one replaced
    // the correct results with stale ones, and the table then disagreed with
    // the box above it until the next keystroke.
    const slow = { subscribers: [{ imsi: 'stale-55' }], total: 1 };
    const fast = { subscribers: [{ imsi: 'current-555' }], total: 1 };
    let releaseSlow!: () => void;
    subscriberApi.list
      .mockImplementationOnce(() => new Promise((r) => { releaseSlow = () => r(slow); }))
      .mockImplementationOnce(() => Promise.resolve(fast));

    useSubscriberStore.getState().setSearch('55');
    useSubscriberStore.getState().setSearch('555');
    await new Promise((r) => setTimeout(r, 0));
    releaseSlow();
    await new Promise((r) => setTimeout(r, 0));

    expect(useSubscriberStore.getState().search).toBe('555');
    expect(useSubscriberStore.getState().subscribers).toEqual(fast.subscribers);
  });

  it('a late reply also does not clear loading while a newer request is in flight', async () => {
    const fast = { subscribers: [], total: 0 };
    let releaseSlow!: () => void;
    subscriberApi.list
      .mockImplementationOnce(() => new Promise((r) => { releaseSlow = () => r(fast); }))
      .mockImplementationOnce(() => new Promise(() => { /* never settles */ }));

    useSubscriberStore.getState().setSearch('55');
    useSubscriberStore.getState().setSearch('555');
    await new Promise((r) => setTimeout(r, 0));
    releaseSlow();
    await new Promise((r) => setTimeout(r, 0));

    // The second request is still running, so the spinner must stay up.
    expect(useSubscriberStore.getState().loading).toBe(true);
  });
});
