import { create } from 'zustand';
import type {
  AllConfigs,
  ServiceStatus,
  TopologyGraph,
  SubscriberListItem,
  ValidationResult,
} from '../types';
import { configApi, serviceApi, subscriberApi, interfaceApi } from '../api';

// Interface status types
export interface ConnectedRadio {
  ip: string;
  numConnectedUes: number;
  setupSuccess: boolean;
  plmn?: string;
}

export interface ActiveUE {
  ip: string;
  imsi: string;
  cmState?: string;
  dnn?: string;
  apn?: string;
  sliceSst?: number;
  sliceSd?: string;
  securityEnc?: string;
  securityInt?: string;
  ambrDownlink?: number;
  ambrUplink?: number;
}

export interface InterfaceStatus {
  // 4G Interfaces
  s1mme: {
    active: boolean;
    connectedEnodebs: ConnectedRadio[];
  };
  s1u: {
    active: boolean;
    connectedEnodebs: ConnectedRadio[];
  };
  // 5G Interfaces
  n2: {
    active: boolean;
    connectedGnodebs: ConnectedRadio[];
  };
  n3: {
    active: boolean;
    connectedGnodebs: ConnectedRadio[];
  };
  activeUEs4G: ActiveUE[];
  activeUEs5G: ActiveUE[];
}

// ── Config Store ──
interface ConfigState {
  configs: AllConfigs | null;
  loading: boolean;
  error: string | null;
  validation: ValidationResult | null;
  dirty: boolean;
  fetchConfigs: () => Promise<void>;
  updateConfigs: (configs: AllConfigs) => void;
  validate: () => Promise<ValidationResult>;
  setDirty: (dirty: boolean) => void;
}

export const useConfigStore = create<ConfigState>((set, get) => ({
  configs: null,
  loading: false,
  error: null,
  validation: null,
  dirty: false,
  fetchConfigs: async () => {
    set({ loading: true, error: null });
    try {
      const configs = await configApi.getAll();
      set({ configs, loading: false, dirty: false });
    } catch (err) {
      set({ error: String(err), loading: false });
    }
  },
  updateConfigs: (configs) => set({ configs, dirty: true }),
  validate: async () => {
    const { configs } = get();
    if (!configs) throw new Error('No configs loaded');
    const result = await configApi.validate(configs);
    set({ validation: result });
    return result;
  },
  setDirty: (dirty) => set({ dirty }),
}));

// ── Service Store ──
interface ServiceState {
  statuses: ServiceStatus[];
  loading: boolean;
  fetchStatuses: () => Promise<void>;
  setStatuses: (statuses: ServiceStatus[]) => void;
}

export const useServiceStore = create<ServiceState>((set) => ({
  statuses: [],
  loading: false,
  fetchStatuses: async () => {
    set({ loading: true });
    try {
      const statuses = await serviceApi.getAll();
      set({ statuses, loading: false });
    } catch {
      set({ loading: false });
    }
  },
  setStatuses: (statuses) => set({ statuses }),
}));

// ── Topology Store ──
interface TopologyState {
  graph: TopologyGraph | null;
  interfaceStatus: InterfaceStatus | null;
  loading: boolean;
  fetchTopology: () => Promise<void>;
  fetchInterfaceStatus: () => Promise<void>;
  setGraph: (graph: TopologyGraph) => void;
}

export const useTopologyStore = create<TopologyState>((set) => ({
  graph: null,
  interfaceStatus: null,
  loading: false,
  fetchTopology: async () => {
    set({ loading: true });
    try {
      const graph = await configApi.getTopology();
      set({ graph, loading: false });
    } catch (err) {
      console.error('Failed to fetch topology:', err);
      set({ loading: false });
    }
  },
  fetchInterfaceStatus: async () => {
    try {
      const interfaceStatus = await interfaceApi.getStatus();
      set({ interfaceStatus });
    } catch (err) {
      console.error('Failed to fetch interface status:', err);
    }
  },
  setGraph: (graph) => set({ graph }),
}));

// ── Subscriber Store ──
interface SubscriberState {
  subscribers: SubscriberListItem[];
  total: number;
  loading: boolean;
  page: number;
  search: string;
  fetchSubscribers: () => Promise<void>;
  setPage: (page: number) => void;
  setSearch: (search: string) => void;
}

export const useSubscriberStore = create<SubscriberState>((set, get) => ({
  subscribers: [],
  total: 0,
  loading: false,
  page: 0,
  search: '',
  fetchSubscribers: async () => {
    set({ loading: true });
    try {
      const { page, search } = get();
      const result = await subscriberApi.list(page * 50, 50, search || undefined);
      set({ subscribers: result.subscribers, total: result.total, loading: false });
    } catch {
      set({ loading: false });
    }
  },
  setPage: (page) => {
    set({ page });
    get().fetchSubscribers();
  },
  setSearch: (search) => {
    set({ search, page: 0 });
    get().fetchSubscribers();
  },
}));

// Export SUCI store
export { useSuciStore } from './suci';
