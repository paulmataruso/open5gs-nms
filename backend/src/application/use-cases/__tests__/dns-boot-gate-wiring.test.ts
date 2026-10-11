import * as fs from 'fs';
import * as path from 'path';

// Wiring guard for the DNS boot-race gate (added 2026-10-06 after a power loss
// left 9 of the 17 core NFs permanently down).
//
// The gate itself is generated from code by installDnsBootGate() in
// bind-controller.ts and is deliberately NOT captured in backups, so its
// correctness on a fresh host depends entirely on that function still being
// CALLED from each path that can produce a vulnerable host. If any of those
// call sites is removed or refactored away, nothing fails loudly -- the host
// simply goes back to being one slow boot away from a dead core, which is
// exactly how this went unnoticed before.
//
// There is no REST surface for the gate, and asserting against the live host
// would make this test environment-dependent, so this guards the wiring
// statically instead. Cheap, and it fails the moment someone drops a call site.

const SRC = path.resolve(__dirname, '../../..');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf-8');

describe('DNS boot-race gate wiring', () => {
  it('bind-controller still exports the installer and the rev check', () => {
    const s = read('interfaces/rest/bind-controller.ts');
    expect(s).toMatch(/export async function installDnsBootGate\s*\(/);
    expect(s).toMatch(/export function checkDnsBootGate\s*\(/);
    expect(s).toMatch(/export const DNS_BOOT_GATE_REV\s*=/);
  });

  it('derives the NF unit list from SERVICE_UNIT_MAP rather than a parallel hardcoded list', () => {
    // A hardcoded list silently misses any NF added later, which is the whole
    // reason this derives from the canonical map.
    const s = read('interfaces/rest/bind-controller.ts');
    expect(s).toMatch(/SERVICE_UNIT_MAP/);
    expect(s).toMatch(/startsWith\(['"]open5gs-['"]\)/);
  });

  it('is called on a genuinely fresh host (fresh-host bootstrap)', () => {
    const s = read('application/use-cases/fresh-host-bootstrap-usecase.ts');
    expect(s).toMatch(/installDnsBootGate/);
  });

  it('is called when a deployment moves onto FQDNs (DNS migration Phase C)', () => {
    // Phase C is the point at which an NF starts resolving its own advertise
    // FQDN at startup, i.e. the point it becomes vulnerable at all.
    const s = read('application/use-cases/dns-migration-usecase.ts');
    expect(s).toMatch(/installDnsBootGate/);
  });

  it('is called on a restore onto a new host (backup restart/reapply)', () => {
    // This is the path the 2026-09-23 occurrence actually happened on.
    const s = read('application/use-cases/backup-restart-usecase.ts');
    expect(s).toMatch(/installDnsBootGate/);
  });

  it('keeps the gate fail-open so it can never permanently wedge the core', () => {
    const s = read('interfaces/rest/bind-controller.ts');
    // The generated script must exit 0 on timeout, not 1 -- otherwise a broken
    // DNS could hold every NF down indefinitely, which is worse than the bug.
    expect(s).toMatch(/releasing gate/);
    expect(s).toMatch(/exit 0/);
  });

  it('gives the per-NF drop-in a patient restart budget, not systemd defaults', () => {
    // The stock units pair RestartSec=100ms with StartLimitBurst=5, so all five
    // attempts burn inside one second -- that is what turned a 13s DNS delay
    // into a permanent outage.
    const s = read('interfaces/rest/bind-controller.ts');
    expect(s).toMatch(/RestartSec=5/);
    expect(s).toMatch(/StartLimitBurst=60/);
  });
});
