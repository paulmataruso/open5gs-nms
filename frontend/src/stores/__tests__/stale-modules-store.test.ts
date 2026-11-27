// Backs the global StaleModulesModal, which is non-dismissible while
// auto-fixable staleness remains (the one deliberate exception to the
// Escape-closes-every-overlay rule). That makes the empty case the one that
// matters: anything that leaves `modules` populated when it should not blocks
// the whole UI behind a modal nobody can close.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const modulesApi = { getStaleStatus: vi.fn() };
vi.mock('../../api/modules', () => ({ modulesApi, ModuleStaleStatus: {} }));

const { useStaleModulesStore } = await import('../staleModules');
const initial = useStaleModulesStore.getState();

beforeEach(() => {
  vi.clearAllMocks();
  useStaleModulesStore.setState(initial, true);
});

describe('useStaleModulesStore', () => {
  it('starts empty, so no modal shows before the first fetch', () => {
    expect(useStaleModulesStore.getState().modules).toEqual([]);
    expect(useStaleModulesStore.getState().loading).toBe(false);
  });

  it('stores what the backend reports', async () => {
    modulesApi.getStaleStatus.mockResolvedValue([{ module: 'ims', stale: true }]);
    await useStaleModulesStore.getState().fetchStaleModules();
    expect(useStaleModulesStore.getState().modules).toHaveLength(1);
    expect(useStaleModulesStore.getState().loading).toBe(false);
  });

  it('CLEARS the list when the backend reports nothing stale', async () => {
    modulesApi.getStaleStatus.mockResolvedValueOnce([{ module: 'ims', stale: true }]);
    await useStaleModulesStore.getState().fetchStaleModules();
    modulesApi.getStaleStatus.mockResolvedValueOnce([]);
    await useStaleModulesStore.getState().fetchStaleModules();
    // After a fix-all, the refetch is what dismisses the modal. Merging
    // instead of replacing would leave it up forever with nothing to fix.
    expect(useStaleModulesStore.getState().modules).toEqual([]);
  });

  it('a failed fetch clears loading and does not invent staleness', async () => {
    modulesApi.getStaleStatus.mockRejectedValue(new Error('backend restarting'));
    await useStaleModulesStore.getState().fetchStaleModules();
    expect(useStaleModulesStore.getState().loading).toBe(false);
    // Swallowed on purpose: this runs on login, and a transient failure must
    // not put an unclosable modal in front of someone who just signed in.
    expect(useStaleModulesStore.getState().modules).toEqual([]);
  });
});
