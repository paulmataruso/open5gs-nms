/**
 * Pre-flight checks for the Auto-Configuration wizard.
 *
 * Why this exists — a real failure, reproduced on a clean host 2026-11-07:
 * the wizard happily wrote `10.0.9.155` into amf.yaml, `10.0.9.156` into
 * upf.yaml and so on, for a host that had none of those addresses. Every NF
 * then died at startup on
 *
 *   socket bind(2) [10.0.9.156]:2152 failed (99:Cannot assign requested address)
 *   Open5GS initialization failed. Aborted
 *
 * leaving 4 of 6 restarted NFs dead — while the apply reported success. The
 * success-reporting half of that is fixed separately (the restart loop now
 * checks each exit code); this half stops the config from being written at
 * all, because a bind address that does not exist on the host cannot become
 * a working configuration later by itself.
 *
 * NOT checked here, deliberately:
 *  - `remoteSgwus[]` addresses, which are by definition on another host.
 *  - session-pool gateways, which auto-config assigns to the tun device
 *    itself as part of the same apply — they are an output, not an input.
 *  - `*Dev` fields (`s1mmeDev`, `amfNgapDev`), which bind by interface name
 *    and so never name an address at all.
 */

/** Addresses that are always bindable regardless of what `ip addr` reports. */
function isAlwaysBindable(ip: string): boolean {
  const v = ip.trim();
  if (v === '' ) return true;              // nothing requested
  if (v === '0.0.0.0' || v === '::') return true;   // wildcard
  if (v === '::1') return true;
  // The kernel routes the whole of 127/8 to `lo`, so 127.0.0.7 binds fine
  // without ever appearing in `ip addr` — which is exactly why this project
  // hands the loopback-only PFCP endpoints addresses in that range.
  if (/^127\./.test(v)) return true;
  return false;
}

/**
 * Parses `ip -4 -o addr show` / `ip -6 -o addr show` output into the bare
 * addresses the host holds.
 *
 * Example line:
 *   2: eth0    inet 172.16.0.171/24 brd ... scope global eth0\       valid_lft ...
 */
export function parseHostAddresses(ipOutput: string): string[] {
  const out: string[] = [];
  for (const line of ipOutput.split('\n')) {
    const m = line.match(/\binet6?\s+([0-9a-fA-F.:]+)(?:\/\d+)?/);
    if (m) out.push(m[1]);
  }
  return [...new Set(out)];
}

/** One requested address that the host cannot bind. */
export interface UnbindableAddress {
  /** Which wizard field asked for it, in the wording the UI uses. */
  field: string;
  address: string;
}

export interface PreflightInput {
  applyInterfaces?: boolean;
  applyPfcp?: boolean;
  s1mmeIP?: string;
  sgwuGtpIP?: string;
  amfNgapIP?: string;
  upfGtpIP?: string;
  smfPfcpIP?: string;
  localUpfPfcpIP?: string;
  sgwcPfcpIP?: string;
}

/**
 * Returns every requested bind address that is neither always-bindable nor
 * present on the host. An empty array means the config is safe to write.
 *
 * Each toggle gates its own fields, so unchecking a card on the page also
 * removes its addresses from this check — the same scoping the apply itself
 * uses, so the two can never disagree about what is being configured.
 */
export function findUnbindableAddresses(
  input: PreflightInput,
  hostAddresses: string[],
): UnbindableAddress[] {
  const have = new Set(hostAddresses.map(a => a.trim()));
  const bad: UnbindableAddress[] = [];

  const check = (field: string, ip: string | undefined) => {
    if (!ip || isAlwaysBindable(ip)) return;
    if (!have.has(ip.trim())) bad.push({ field, address: ip.trim() });
  };

  // Defaults mirror AutoConfigInput's own: a toggle left undefined is applied.
  if (input.applyInterfaces !== false) {
    check('S1-MME (MME)', input.s1mmeIP);
    check('SGW-U GTP-U', input.sgwuGtpIP);
    check('NGAP (AMF)', input.amfNgapIP);
    check('UPF GTP-U', input.upfGtpIP);
  }
  if (input.applyPfcp !== false) {
    check('SMF PFCP', input.smfPfcpIP);
    check('Local UPF PFCP', input.localUpfPfcpIP);
    check('SGW-C PFCP', input.sgwcPfcpIP);
  }
  return bad;
}

/**
 * Human-readable refusal naming what is missing and what the host does have,
 * so the operator can either fix the entry or go and create the interface.
 */
export function unbindableAddressMessage(
  bad: UnbindableAddress[],
  hostAddresses: string[],
): string {
  const missing = bad.map(b => `${b.field} → ${b.address}`).join('; ');
  // Only addresses an operator could plausibly type into the wizard. Loopback
  // is never the answer to "which address should this NF advertise", and the
  // link-local / unique-local v6 noise (one fe80:: per interface, so ~15 of
  // them on a host with dummies) buried the real list in the first version of
  // this message.
  const routable = hostAddresses.filter(a =>
    !/^127\./.test(a) &&
    a !== '::1' &&
    !/^fe[89ab][0-9a-f]:/i.test(a) &&   // v6 link-local
    !/^fd[0-9a-f]{2}:/i.test(a) &&      // v6 unique-local
    !/^169\.254\./.test(a),             // v4 link-local
  );
  return (
    `Not applied: ${bad.length === 1 ? 'an address was' : 'addresses were'} requested that this host ` +
    `cannot bind (${missing}). Open5GS aborts at startup on a bind to a missing address, so writing ` +
    `this would leave those NFs dead. This host currently holds: ` +
    `${routable.length > 0 ? routable.join(', ') : '(no non-loopback addresses)'}. ` +
    `Either use one of those, bind by interface name instead, or create the address first ` +
    `(the L3 Routing page's dummy interfaces are how this deployment does it).`
  );
}
