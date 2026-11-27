// Shared "you typed a hostname" warning for any MME address the real Open5GS
// MME resolves with a SYNCHRONOUS getaddrinfo() during config parse.
//
// This is not a style nit. Open5GS MME aborts FATALLY at startup when such a
// name does not resolve -- an IP, even an unreachable one, always parses --
// which makes a typo here an MME that will not come back up after the next
// Apply Config restart (CLAUDE.md gotcha #8, and #6 for the 5GC equivalent).
//
// Lives in its own module rather than inside MmeEditor so the SGs-AP client
// addresses and the inter-MME mobility peers can show the SAME warning: the
// mobility section is a separate component that MmeEditor imports, so importing
// a helper back out of MmeEditor would be a circular import. One copy also
// means the two cannot drift into disagreeing about what counts as a hostname.

/**
 * True when a value looks like a name the MME will have to resolve, rather than
 * a literal address.
 *
 * Deliberately conservative: an unqualified single label (`msc`, resolved via
 * the host's search domains) is NOT flagged, because the dotless form is also
 * how several of this project's own generated configs refer to local services
 * and warning on all of them would train the operator to ignore the banner. A
 * dot plus a non-numeric label is the case that actually needs DNS.
 *
 * Module-private on purpose: every call site wants the BANNER, and exporting a
 * second non-component symbol from this file also breaks Vite's fast refresh
 * (react-refresh/only-export-components). Add a caller here rather than
 * exporting the predicate.
 */
function isHostname(val: string): boolean {
  if (!val) return false;
  // IPv4
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(val)) return false;
  // IPv6
  if (val.includes(':')) return false;
  // Has a dot — likely a hostname/FQDN
  return val.includes('.');
}

interface Props {
  /** The address as typed. Rendered inline, so pass the single representative
   * value rather than a joined list. */
  address: string;
  /** What fails to start if the name does not resolve, e.g. "MME". */
  subject?: string;
  className?: string;
}

/**
 * The banner itself. Renders nothing unless `address` is a hostname, so a call
 * site can mount it unconditionally.
 */
export function HostnameWarning({ address, subject = 'MME', className = 'col-span-2 mt-1' }: Props): JSX.Element | null {
  if (!isHostname(address)) return null;
  return (
    <div className={`${className} flex items-start gap-2 px-3 py-2 rounded bg-nms-amber/10 border border-nms-amber/30 text-nms-amber text-xs`}>
      <span className="mt-0.5" aria-hidden="true">⚠</span>
      <span>
        <strong>Hostname detected.</strong> Open5GS {subject} resolves this address via DNS at startup.
        If <code className="font-mono bg-nms-bg/40 px-1 rounded">{address}</code> is
        not resolvable from the MME host at boot time, the {subject} will abort with a fatal error.
        Use an IP address if DNS is not guaranteed.
      </span>
    </div>
  );
}
