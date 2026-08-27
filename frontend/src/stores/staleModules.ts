import { create } from 'zustand';
import { modulesApi, ModuleStaleStatus } from '../api/modules';

// Backs the global StaleModulesModal popup — modeled directly on useServiceStore
// (stores/index.ts): no self-polling, kept fresh by whatever mounts the modal
// calling fetchStaleModules() once (on login/reload, see StaleModulesModal.tsx).
interface StaleModulesState {
  modules: ModuleStaleStatus[];
  loading: boolean;
  fetchStaleModules: () => Promise<void>;
}

export const useStaleModulesStore = create<StaleModulesState>((set) => ({
  modules: [],
  loading: false,
  fetchStaleModules: async () => {
    set({ loading: true });
    try {
      const modules = await modulesApi.getStaleStatus();
      set({ modules, loading: false });
    } catch {
      set({ loading: false });
    }
  },
}));
