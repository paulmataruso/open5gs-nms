// The SUCI home-network-key store.
//
// Its interest is that every action maintains the key list LOCALLY after a
// successful call rather than refetching — insert-and-sort, map-replace,
// filter-remove — so the list the operator sees is this module's arithmetic,
// not the server's. Each of those three is a different way to get it wrong,
// and getting it wrong means the UI attributes a key to the wrong hnet id,
// which is a config-fidelity problem rather than a cosmetic one.
//
// It is also the only store here that RETHROWS. That is deliberate — the
// modal needs to know the action failed so it can stay open — and it is worth
// pinning, because adding a `return` in the catch of any of these would make
// a failed key generation look successful.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HnetKey } from '../../types/suci';

const suciApi = {
  listKeys: vi.fn(),
  generateKey: vi.fn(),
  regenerateKey: vi.fn(),
  deleteKey: vi.fn(),
  getNextId: vi.fn(),
};
vi.mock('../../api/suci', () => ({ suciApi }));

const { useSuciStore } = await import('../suci');
const initial = useSuciStore.getState();

/**
 * A complete HnetKey, not a cast-through-unknown stub.
 *
 * Built field for field on purpose: `publicKeyHex` (UDM's udm.yaml format)
 * and `publicKeyUncompressed` (the pySIM/sysmoUSIM format) are two different
 * encodings of the same key, and the profile decides which lengths are
 * right — Profile A is 64 hex chars in both, Profile B is 66 compressed and
 * 130 uncompressed. A stub that collapsed those into one `publicKey` would
 * let a test pass against a shape the real UI never receives, which is the
 * failure mode this whole file exists to catch.
 */
const key = (id: number, scheme: 1 | 2 = 1): HnetKey => ({
  id,
  scheme,
  keyFile: `/etc/open5gs/hnet/curve${scheme === 1 ? '25519' : 'P256'}-${id}.key`,
  fileExists: true,
  publicKeyHex: `hex-${id}`,
  publicKeyUncompressed: `unc-${id}`,
  profile: scheme === 1 ? 'A' : 'B',
  schemeLabel: scheme === 1 ? 'Profile A (X25519)' : 'Profile B (secp256r1)',
  algorithm: scheme === 1 ? 'X25519' : 'ECIES-P256',
});

beforeEach(() => {
  vi.clearAllMocks();
  useSuciStore.setState(initial, true);
});

describe('useSuciStore', () => {
  it('starts with the real default hnet directory', () => {
    // Not cosmetic: this path is shown to the operator as where the key files
    // live, before any fetch has happened.
    expect(useSuciStore.getState().hnetDir).toBe('/etc/open5gs/hnet');
    expect(useSuciStore.getState().keys).toEqual([]);
  });

  it('fetchKeys takes BOTH the keys and the directory from the server', async () => {
    suciApi.listKeys.mockResolvedValue({ keys: [key(2), key(1)], hnetDir: '/srv/hnet' });
    await useSuciStore.getState().fetchKeys();
    expect(useSuciStore.getState().hnetDir).toBe('/srv/hnet');
    expect(useSuciStore.getState().keys.map(k => k.id)).toEqual([2, 1]);
    expect(useSuciStore.getState().loading).toBe(false);
  });

  it('fetchKeys records the error AND rethrows, so the caller can react', async () => {
    suciApi.listKeys.mockRejectedValue(new Error('udm.yaml unreadable'));
    await expect(useSuciStore.getState().fetchKeys()).rejects.toThrow('udm.yaml unreadable');
    expect(useSuciStore.getState().error).toContain('udm.yaml unreadable');
    expect(useSuciStore.getState().loading).toBe(false);
  });

  it('generateKey inserts the new key IN ID ORDER, not at the end', async () => {
    // The list is rendered in array order. Appending a lower id would show
    // hnet 1 beneath hnet 7, which reads as the key belonging to a different
    // hnet than it does.
    useSuciStore.setState({ keys: [key(1), key(7)] });
    suciApi.generateKey.mockResolvedValue(key(3));
    const created = await useSuciStore.getState().generateKey(3, 1);
    expect(created.id).toBe(3);
    expect(useSuciStore.getState().keys.map(k => k.id)).toEqual([1, 3, 7]);
  });

  it('generateKey passes id and scheme through as one object', async () => {
    suciApi.generateKey.mockResolvedValue(key(1, 2));
    await useSuciStore.getState().generateKey(1, 2);
    expect(suciApi.generateKey).toHaveBeenCalledWith({ id: 1, scheme: 2 });
  });

  it('a failed generateKey leaves the list untouched', async () => {
    useSuciStore.setState({ keys: [key(1)] });
    suciApi.generateKey.mockRejectedValue(new Error('id already in use'));
    await expect(useSuciStore.getState().generateKey(1, 1)).rejects.toThrow();
    expect(useSuciStore.getState().keys.map(k => k.id)).toEqual([1]);
    expect(useSuciStore.getState().loading).toBe(false);
  });

  it('regenerateKey REPLACES in place and keeps every other key', async () => {
    useSuciStore.setState({ keys: [key(1), key(2), key(3)] });
    const fresh: HnetKey = { ...key(2, 2), publicKeyHex: 'rotated' };
    suciApi.regenerateKey.mockResolvedValue(fresh);
    await useSuciStore.getState().regenerateKey(2, 2);
    const keys = useSuciStore.getState().keys;
    expect(keys.map(k => k.id)).toEqual([1, 2, 3]);
    expect(keys[1].publicKeyHex).toBe('rotated');
    expect(keys[0].publicKeyHex).toBe('hex-1');
  });

  it('regenerateKey takes id and scheme as POSITIONAL args, unlike generateKey', async () => {
    // The two API shapes genuinely differ. Pinned because passing an object
    // here would send `{id, scheme}` as the id and `undefined` as the scheme,
    // which is the kind of thing that only shows up against a real backend.
    suciApi.regenerateKey.mockResolvedValue(key(4));
    await useSuciStore.getState().regenerateKey(4, 1);
    expect(suciApi.regenerateKey).toHaveBeenCalledWith(4, 1);
  });

  it('deleteKey removes only that id, and forwards the deleteFile choice', async () => {
    // deleteFile decides whether the private key FILE on the host is removed
    // as well as the udm.yaml entry. Dropping that argument would silently
    // leave key material on disk.
    useSuciStore.setState({ keys: [key(1), key(2)] });
    suciApi.deleteKey.mockResolvedValue(undefined);
    await useSuciStore.getState().deleteKey(1, true);
    expect(suciApi.deleteKey).toHaveBeenCalledWith(1, true);
    expect(useSuciStore.getState().keys.map(k => k.id)).toEqual([2]);
  });

  it('a failed deleteKey does NOT remove the row', async () => {
    useSuciStore.setState({ keys: [key(1)] });
    suciApi.deleteKey.mockRejectedValue(new Error('permission denied'));
    await expect(useSuciStore.getState().deleteKey(1, false)).rejects.toThrow();
    expect(useSuciStore.getState().keys.map(k => k.id)).toEqual([1]);
  });

  it('getNextId returns the id and does not touch loading', async () => {
    suciApi.getNextId.mockResolvedValue(8);
    await expect(useSuciStore.getState().getNextId()).resolves.toBe(8);
    expect(useSuciStore.getState().loading).toBe(false);
  });

  it('getNextId records the error and rethrows', async () => {
    suciApi.getNextId.mockRejectedValue(new Error('no ids left'));
    await expect(useSuciStore.getState().getNextId()).rejects.toThrow('no ids left');
    expect(useSuciStore.getState().error).toContain('no ids left');
  });
});
