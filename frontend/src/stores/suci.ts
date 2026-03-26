import { create } from 'zustand';
import type { HnetKey, SuciKeysResult } from '../types/suci';
import { suciApi } from '../api/suci';

interface SuciState {
  keys: HnetKey[];
  hnetDir: string;
  loading: boolean;
  error: string | null;
  
  fetchKeys: () => Promise<void>;
  generateKey: (id: number, scheme: 1 | 2) => Promise<HnetKey>;
  regenerateKey: (id: number, scheme: 1 | 2) => Promise<HnetKey>;
  deleteKey: (id: number, deleteFile: boolean) => Promise<void>;
  getNextId: () => Promise<number>;
}

export const useSuciStore = create<SuciState>((set, get) => ({
  keys: [],
  hnetDir: '/etc/open5gs/hnet',
  loading: false,
  error: null,

  fetchKeys: async () => {
    set({ loading: true, error: null });
    try {
      const result: SuciKeysResult = await suciApi.listKeys();
      set({ keys: result.keys, hnetDir: result.hnetDir, loading: false });
    } catch (error) {
      set({ error: String(error), loading: false });
      throw error;
    }
  },

  generateKey: async (id: number, scheme: 1 | 2) => {
    set({ loading: true, error: null });
    try {
      const key = await suciApi.generateKey({ id, scheme });
      const currentKeys = get().keys;
      set({ 
        keys: [...currentKeys, key].sort((a, b) => a.id - b.id),
        loading: false 
      });
      return key;
    } catch (error) {
      set({ error: String(error), loading: false });
      throw error;
    }
  },

  regenerateKey: async (id: number, scheme: 1 | 2) => {
    set({ loading: true, error: null });
    try {
      const key = await suciApi.regenerateKey(id, scheme);
      const currentKeys = get().keys;
      set({ 
        keys: currentKeys.map(k => k.id === id ? key : k),
        loading: false 
      });
      return key;
    } catch (error) {
      set({ error: String(error), loading: false });
      throw error;
    }
  },

  deleteKey: async (id: number, deleteFile: boolean) => {
    set({ loading: true, error: null });
    try {
      await suciApi.deleteKey(id, deleteFile);
      const currentKeys = get().keys;
      set({ 
        keys: currentKeys.filter(k => k.id !== id),
        loading: false 
      });
    } catch (error) {
      set({ error: String(error), loading: false });
      throw error;
    }
  },

  getNextId: async () => {
    try {
      return await suciApi.getNextId();
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },
}));
