import * as fs from 'fs';
import * as path from 'path';

const REPO = path.resolve(__dirname, '../../../../..');
const script = fs.readFileSync(path.join(REPO, 'backup-restore/bootstrap-fresh-host.sh'), 'utf-8');

/**
 * Real failure on a clean Ubuntu 24.04 cloud image, 2026-11-08: the bootstrap
 * died on its first step with
 *
 *   debconf: DbDriver "config": /var/cache/debconf/config.dat is locked by
 *   another process: Resource temporarily unavailable
 *
 * because a freshly booted cloud image is still running cloud-init and
 * unattended-upgrades. This script's entire purpose is a fresh host, so that
 * race is the normal case rather than an edge one.
 */
describe('bootstrap waits for apt locks', () => {
  it('defines a wait and calls it before the first apt step', () => {
    expect(script).toMatch(/wait_for_apt\(\)\s*\{/);
    const defIdx = script.indexOf('wait_for_apt() {');
    const callIdx = script.indexOf('\nwait_for_apt\n');
    const step1Idx = script.indexOf('1/10 — System packages');
    expect(callIdx).toBeGreaterThan(defIdx);
    expect(callIdx).toBeLessThan(step1Idx);
  });

  it('checks debconf\'s own lock, not just dpkg\'s', () => {
    // These are taken separately: the observed failure was debconf's
    // config.dat while dpkg's frontend lock was already free.
    expect(script).toContain('/var/cache/debconf/config.dat');
    expect(script).toContain('/var/lib/dpkg/lock-frontend');
    expect(script).toContain('/var/lib/apt/lists/lock');
  });

  it('gives up eventually rather than hanging forever', () => {
    // An unattended run must not block indefinitely on a stuck lock.
    expect(script).toMatch(/limit=\d+/);
    expect(script).toMatch(/still held after .*continuing anyway/);
  });

  it('warns rather than dying when it gives up', () => {
    // Proceeding and failing with apt's own message beats exiting with ours.
    const fn = /wait_for_apt\(\) \{[\s\S]*?\n\}/.exec(script);
    expect(fn).not.toBeNull();
    expect(fn![0]).not.toMatch(/\bdie\b|exit 1/);
  });
});
