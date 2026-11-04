import * as fs from 'fs';
import * as path from 'path';

// Static wiring guard for the DHCP (Kea) module. Each of these is a way the
// module ships looking finished and is not:
//
//   * The install route missing from nginx's streaming-timeout location. A real
//     `apt-get install kea-dhcp4-server` runs well past the generic 120s /api/
//     read timeout, and the browser then shows a bare network error with the
//     install still running on the host (CLAUDE.md pattern #5).
//   * The feature flag not plumbed end to end. The page compiles, the route
//     exists, and the nav entry never appears, which looks like a broken build.
//   * The page imported statically in App.tsx, silently handing back a chunk of
//     the route-splitting win that cut first load from ~821kB to ~111kB gzip.

const REPO = path.resolve(__dirname, '../../../../..');
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf-8');

const INDEX    = read('backend/src/index.ts');
const NGINX    = read('nginx/conf.d/nms.conf');
const COMPOSE  = read('docker-compose.yml');
const ENV      = read('.env.example');
const FEATURES = read('frontend/src/config/features.ts');
const NAV      = read('frontend/src/components/common/navItems.ts');
const APP      = read('frontend/src/App.tsx');
const AUDIT    = read('backend/src/domain/entities/audit-log.ts');
const PAGE     = read('frontend/src/components/dhcp/DhcpPage.tsx');
const CTRL     = read('backend/src/interfaces/rest/dhcp-controller.ts');
const FE_DOCKER = read('frontend/Dockerfile');

describe('DHCP module — wiring', () => {
  test('the router is mounted', () => {
    expect(INDEX).toMatch(/createDhcpRouter/);
    expect(INDEX).toMatch(/app\.use\('\/api\/dhcp',/);
  });

  test('the streamed install route is in nginx\'s long-timeout location', () => {
    const loc = NGINX.split('\n').find(l => /location ~ \^\/api\/\(/.test(l) && /install\|uninstall\|remove/.test(l));
    expect(loc).toBeDefined();
    expect(loc!).toMatch(/\|dhcp\)/);
  });

  test('the feature flag is plumbed from .env through compose to the frontend', () => {
    expect(ENV).toMatch(/^ENABLE_DHCP_MODULE=false$/m);
    expect(COMPOSE).toMatch(/VITE_ENABLE_DHCP=\$\{ENABLE_DHCP_MODULE:-false\}/);
    expect(FEATURES).toMatch(/dhcp: import\.meta\.env\.VITE_ENABLE_DHCP === 'true'/);
  });

  // The gap that actually shipped: compose passed VITE_ENABLE_DHCP, the
  // Dockerfile never declared it, and Docker DROPS an undeclared build arg
  // silently — so Vite saw nothing, FEATURES.dhcp compiled to false, and the
  // nav entry simply never appeared on a deployment that had switched it on.
  // Generalised to every flag so the next module cannot repeat it.
  test('every VITE_ENABLE_* compose build arg is declared ARG and ENV in the frontend Dockerfile', () => {
    const flags = [...new Set([...COMPOSE.matchAll(/^\s*-\s*(VITE_ENABLE_[A-Z0-9_]+)=/gm)].map(m => m[1]))];
    expect(flags.length).toBeGreaterThan(10);
    const missingArg = flags.filter(f => !new RegExp(`^ARG ${f}=`, 'm').test(FE_DOCKER));
    const missingEnv = flags.filter(f => !new RegExp(`^ENV ${f}=\\$${f}$`, 'm').test(FE_DOCKER));
    expect({ missingArg, missingEnv }).toEqual({ missingArg: [], missingEnv: [] });
  });

  test('the ENV lines come before the build, or the flag is set too late to matter', () => {
    const lastEnv = FE_DOCKER.lastIndexOf('ENV VITE_ENABLE_');
    const build = FE_DOCKER.indexOf('RUN npm run build');
    expect(lastEnv).toBeGreaterThan(-1);
    expect(build).toBeGreaterThan(lastEnv);
  });

  test('it defaults to DISABLED — installing it binds UDP/67 on a real segment', () => {
    // `=== 'true'` is opt-in; `!== 'false'` would be default-on.
    expect(FEATURES).toMatch(/dhcp:.*=== 'true'/);
    expect(FEATURES).not.toMatch(/dhcp:.*!== 'false'/);
  });

  test('the nav entry and route are both gated on the same flag', () => {
    expect(NAV).toMatch(/FEATURES\.dhcp \? \[\{ id: 'dhcp'/);
    expect(APP).toMatch(/case 'dhcp':/);
    expect(APP).toMatch(/FEATURES\.dhcp \? <DhcpPage \/>/);
  });

  test('the page is lazily imported, not statically', () => {
    expect(APP).toMatch(/const DhcpPage = lazy\(\(\) => import\('\.\/components\/dhcp\/DhcpPage'\)/);
    expect(APP).not.toMatch(/^import \{ DhcpPage \}/m);
  });

  test('every audit action the controller emits is declared', () => {
    for (const m of CTRL.matchAll(/action: (?:`dhcp_\$\{action\}`|'(dhcp_[a-z_]+)')/g)) {
      if (m[1]) expect(AUDIT).toContain(`'${m[1]}'`);
    }
    // The templated lifecycle actions, spelled out.
    for (const a of ['dhcp_start', 'dhcp_stop', 'dhcp_restart']) expect(AUDIT).toContain(`'${a}'`);
  });

  test('install leaves the service stopped rather than serving a stock config', () => {
    // Kea's package enables and starts itself; left alone it would hold :67 and
    // answer nothing useful on whatever segment the host is on.
    expect(CTRL).toMatch(/systemctl', \['stop', KEA_SERVICE\]/);
    expect(CTRL).toMatch(/systemctl', \['disable', KEA_SERVICE\]/);
  });

  test('start refuses an unconfigured server instead of letting Kea come up empty', () => {
    expect(CTRL).toMatch(/Configure at least one subnet and one interface before starting/);
  });

  test('lifecycle actions re-read real state instead of trusting the exit code', () => {
    // "systemctl start exited 0" is not "the service is running" — this project's
    // standing verify-don't-trust rule.
    expect(CTRL).toMatch(/did not \$\{action\}/);
    expect(CTRL).toMatch(/journalctl/);
  });

  test('the config is written atomically, never in place', () => {
    expect(CTRL).toMatch(/\.tmp/);
    expect(CTRL).toMatch(/'mv', \[`\$\{KEA_CONF_PATH\}\.tmp`, KEA_CONF_PATH\]/);
  });

  test('host commands go through safeNsenter, not a local execFile helper', () => {
    // Pattern #20: nsenter -p forks internally, so execFile + a timeout kills
    // only the tracked PID and orphans the real process. Matches CODE, not the
    // comment that explains it.
    expect(CTRL).toMatch(/from '\.\.\/\.\.\/infrastructure\/system\/safe-nsenter'/);
    expect(CTRL).not.toMatch(/child_process/);
    expect(CTRL).not.toMatch(/execFile(?:Async)?\s*\(/);
    expect(CTRL).not.toMatch(/promisify\s*\(/);
  });

  test('the page follows the theme and a11y baseline', () => {
    expect(PAGE).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);   // no hardcoded hex
    expect(PAGE).not.toMatch(/text-white/);            // fails contrast on every theme
    expect(PAGE).toMatch(/border-nms-border-strong/);  // interactive boundaries
    expect(PAGE).toMatch(/nms-table-scroll/);          // tables can outgrow their column
    // Every icon-only control names what it acts on.
    expect(PAGE).toMatch(/aria-label=\{`Remove subnet/);
    expect(PAGE).toMatch(/aria-label=\{`Remove binding for/);
  });

  test('service controls are gated on installed, not configured', () => {
    // Gating on `configured` is what made VoWiFi's Start/Stop vanish while the
    // service was actively running.
    expect(PAGE).toMatch(/isAdmin && status\?\.installed &&/);
  });

  // ── Binding is a dropdown, and a subnet is independent of it ──────────────
  //
  // Both halves of an explicit operator correction: most deployments serve
  // REMOTE subnets through a DHCP relay, so a subnet must never read as a
  // property of whichever address Kea happens to be bound to.

  test('interface binding is a dropdown, not a grid of selectable cards', () => {
    expect(PAGE).toMatch(/<select id="dhcp-iface-add"/);
    // The card grid it replaced: a per-interface checkbox the operator ticked.
    expect(PAGE).not.toMatch(/id=\{`iface-\$\{i\.name\}`\}/);
    expect(PAGE).not.toMatch(/type="checkbox"[\s\S]{0,200}interfaces: e\.target\.checked/);
    // Blocked interfaces stay visible in the list, disabled with their reason,
    // rather than silently vanishing.
    expect(PAGE).toMatch(/unavailableIfaces\.map/);
    expect(PAGE).toMatch(/<option key=\{i\.name\} value=\{i\.name\} disabled>/);
  });

  test('the page says in words that binding does not decide which subnets are served', () => {
    // The conceptual error this feature shipped with. If someone rewrites the
    // copy, it still has to carry this.
    expect(PAGE).toMatch(/does not decide which subnets/i);
    expect(PAGE).toMatch(/relay/i);
    expect(PAGE).toMatch(/giaddr/);
  });

  test('a subnet carries its own relay addresses, through to the Kea document', () => {
    expect(PAGE).toMatch(/id=\{`relay-\$\{s\.id\}`\}/);
    expect(PAGE).toMatch(/relayIps:/);
    // And the generator really emits Kea's own relay block, not a dead field.
    const DHCPCFG = read('backend/src/domain/services/dhcp-config.ts');
    expect(DHCPCFG).toMatch(/out\.relay = \{ 'ip-addresses': \[\.\.\.s\.relayIps\] \}/);
  });

  // ── Relaying is configured on the ROUTER, not on this page ───────────────
  //
  // From an operator reading the subnet form: "you set the DHCP relay on the
  // far end network to point to my DHCP server". Exactly right, and the form
  // implied otherwise — a "Relay addresses (optional)" field sat in the same
  // grid as Gateway and DNS, which reads as a step in the normal flow whatever
  // its help text says. The field is a real but uncommon Kea feature, so it is
  // kept and moved rather than removed; what these pin is the placement.

  test('the page says where relaying is actually configured', () => {
    expect(PAGE).toMatch(/ip helper-address/);
  });

  test('both reachability overrides sit behind a disclosure, not in the field grid', () => {
    const disclosure = PAGE.indexOf('Reachability overrides');
    expect(disclosure).toBeGreaterThan(-1);
    // Index order is the assertion: either input appearing BEFORE the
    // disclosure means it is back in the grid above it.
    expect(PAGE.indexOf('`relay-${s.id}`')).toBeGreaterThan(disclosure);
    expect(PAGE.indexOf('`iface-pin-${s.id}`')).toBeGreaterThan(disclosure);
    // A real button, per the a11y baseline — it is the only control here.
    expect(PAGE).toMatch(/<button type="button" aria-expanded=\{reachVisible\(s\)\}/);
  });

  test('a subnet that already carries an override starts revealed', () => {
    // Collapsing a value that is live in Kea's own config would make the page
    // disagree with the file it edits. The explicit choice still wins.
    expect(PAGE).toMatch(/reachOpen\[s\.id\] \?\? reachOverridden\(s\)/);
    expect(PAGE).toMatch(/!!s\.iface \|\| \(s\.relayIps\?\.length \?\? 0\) > 0/);
  });

  test('a remote subnet is reported as relayed rather than refused', () => {
    expect(PAGE).toMatch(/subnetReach\(/);
    expect(PAGE).toMatch(/Via DHCP relay/);
    expect(PAGE).toMatch(/Directly connected/);
    // The reachability module must stay free of React/browser APIs, or the
    // backend jest run that executes it stops working.
    const REACH = read('frontend/src/components/dhcp/subnet-reach.ts');
    expect(REACH).not.toMatch(/\bfrom 'react'|localStorage|window\.|document\./);
  });

  test('a prefix-size note is only raised when a subnet leases from that interface', () => {
    // Binding a /30 transit interface purely to RECEIVE relayed requests is
    // normal; complaining about its one leasable address is a false alarm.
    const DHCPCFG = read('backend/src/domain/services/dhcp-config.ts');
    expect(DHCPCFG).toMatch(/localPoolWarnings/);
    expect(DHCPCFG).toMatch(/if \(servesOwnRangeOf\(iface\)\) \{/);
    expect(PAGE).toMatch(/ifaceServesOwnRange\(/);
  });

  test('every form control has an accessible name', () => {
    const ids = [...PAGE.matchAll(/<(?:input|select) id="([^"]+)"/g)].map(m => m[1]);
    const tmpl = [...PAGE.matchAll(/<(?:input|select) id=\{`([^`]+)`\}/g)].map(m => m[1]);
    expect(ids.length + tmpl.length).toBeGreaterThan(5);
    for (const id of ids) expect(PAGE).toContain(`htmlFor="${id}"`);
    for (const t of tmpl) expect(PAGE).toContain('htmlFor={`' + t + '`}');
  });
  // ── Lease detail rows ───────────────────────────────────────────────────

  test('lease rows are keyboard-operable, not click-only', () => {
    // A div/tr with onClick is unreachable by keyboard without these. The
    // a11y baseline also forbids role="button" on a <tr> — it destroys the
    // table semantics — so aria-expanded carries the state instead.
    expect(PAGE).toMatch(/onKeyDown=\{activateOnKey\(toggle\)\}/);
    expect(PAGE).toMatch(/tabIndex=\{0\}\s*\n\s*aria-expanded=\{open\}/);
    expect(PAGE).not.toMatch(/<tr[^>]*role="button"/);
  });

  test('the expanded pair is keyed on the fragment, not the inner rows', () => {
    // Keying the <tr>s instead leaves the array element itself unkeyed: React
    // warns and cannot reconcile the summary and detail rows as one unit.
    expect(PAGE).toMatch(/<Fragment key=\{l\.ip\}>/);
    expect(PAGE).not.toMatch(/<tr\s+key=\{`\$\{l\.ip\}-detail`\}/);
  });

  test('open rows survive the 10s lease refresh', () => {
    // Keyed by IP, which is a lease's identity in Kea's file (one current row
    // per address). Keying by array index would reassign every open row as
    // leases are added or re-sorted.
    expect(PAGE).toMatch(/openLeases\[l\.ip\]/);
    expect(PAGE).toMatch(/setOpenLeases\(prev => \(\{ \.\.\.prev, \[l\.ip\]: !prev\[l\.ip\] \}\)\)/);
  });

  test('the detail view resolves the numeric subnet id to a real CIDR', () => {
    // Kea's lease file records only `subnet_id`. Showing "subnet 1" would make
    // the operator go and look it up by hand.
    expect(PAGE).toMatch(/config\.subnets\.find\(s => s\.id === l\.subnetId\)/);
  });

  test('a lease row with shifted columns says so instead of showing guessed values', () => {
    // The withheld-fields path has to be visible in the UI, or a shifted pool
    // id reads as fact. Backed by detailsComplete from the parser.
    expect(PAGE).toMatch(/!l\.detailsComplete/);
    const DHCPCFG = read('backend/src/domain/services/dhcp-config.ts');
    expect(DHCPCFG).toMatch(/detailsComplete: complete/);
    expect(DHCPCFG).toMatch(/const complete = f\.length === cols\.length/);
  });

  test('the lease CSV is split with quote handling, not a bare split', () => {
    // user_context holds Kea's own JSON, which contains commas, and it sits
    // after `state` — so a naive split silently shifts pool_id only once these
    // columns are actually read.
    const DHCPCFG = read('backend/src/domain/services/dhcp-config.ts');
    expect(DHCPCFG).toMatch(/const f = splitLeaseRow\(lines\[i\]\)/);
    expect(DHCPCFG).not.toMatch(/const f = lines\[i\]\.split\(','\)/);
  });

  test('the client identifier is decoded for display, and the raw form kept', () => {
    expect(PAGE).toMatch(/l\.clientIdText/);
    expect(PAGE).toMatch(/\{l\.clientId\}/);
  });
  // ── Dynamic lease -> static binding ─────────────────────────────────────

  test('pinning a lease stages it through the one save path, not a second write', () => {
    // A direct dhcpApi.saveConfig() here would give this config two ways to
    // reach the host and let a half-edited page be written by an unrelated
    // click. It goes through patchSubnet like every other edit on the page.
    expect(PAGE).toMatch(/const pinLease = \(l: DhcpLease, subnet: DhcpSubnet\) => \{/);
    expect(PAGE).toMatch(/patchSubnet\(subnet\.id, \{\s*\n\s*reservations: \[\.\.\.subnet\.reservations, \{/);
    const pin = PAGE.slice(PAGE.indexOf('const pinLease'), PAGE.indexOf('const allReservations') + 1);
    expect(pin).not.toMatch(/saveConfig|dhcpApi\./);
  });

  test('the button is admin-gated', () => {
    // Asserted structurally, on the guard immediately opening the action row.
    // A nearest-preceding-`isAdmin` search passes against the several other
    // admin guards on this page and survives deleting this one — verified by
    // replacing it with `true &&`, which left the whole suite green.
    expect(PAGE).toMatch(
      /\{isAdmin && \(\s*\n\s*<div className="mt-3 pt-3 border-t border-nms-border flex items-center gap-2 flex-wrap">/,
    );
    expect(PAGE).toContain('Make this a static binding');
  });

  test('staged state is read from the edited config, not the host-side flag', () => {
    // l.reserved comes from the file on disk, so a just-staged binding would
    // still offer the button and could be added twice.
    expect(PAGE).toMatch(/const staged = !!binding;/);
    expect(PAGE).toMatch(/const binding = subnet\?\.reservations\.find\(r => r\.ip === l\.ip\)/);
  });

  test('ineligible leases explain why instead of failing at save', () => {
    // Each of these is a real validator rule (dhcp-config.ts): an unknown
    // subnet, no MAC to key on, or a MAC/IP already bound elsewhere.
    expect(PAGE).toMatch(/const bindingBlocker =/);
    expect(PAGE).toMatch(/which is not in the saved configuration/);
    expect(PAGE).toMatch(/a binding is keyed on the MAC/);
    expect(PAGE).toMatch(/A MAC can hold only one address/);
    expect(PAGE).toMatch(/disabled=\{!!blocker\}/);
  });

  test('the in-pool caution is surfaced, using the shared pure helper', () => {
    // The Bindings tab's own guidance is to keep reservations out of the pool,
    // and a dynamic lease is always in one — so pinning must say so. The check
    // reuses ipInAnyPool rather than re-deriving IP maths in the component.
    expect(PAGE).toMatch(/ipInAnyPool\(subnet\.pools, l\.ip\)/);
    expect(PAGE).toMatch(/inside the dynamic pool/);
    expect(PAGE).not.toMatch(/split\('\.'\)\.reduce/);
    const REACH = read('frontend/src/components/dhcp/subnet-reach.ts');
    expect(REACH).toMatch(/export function ipInAnyPool/);
    // Still pure — the module is imported directly by a backend test.
    expect(REACH).not.toMatch(/\bfrom 'react'|localStorage|window\.|document\./);
  });

  test('the validator still owns the rules the button pre-checks', () => {
    const DHCPCFG = read('backend/src/domain/services/dhcp-config.ts');
    expect(DHCPCFG).toMatch(/is reserved for two different MACs/);
    expect(DHCPCFG).toMatch(/is reserved twice, for/);
    expect(DHCPCFG).toMatch(/sits inside a dynamic pool/);
  });

  test('a staged binding offers Save in place rather than sending the operator to another tab', () => {
    expect(PAGE).toMatch(/Binding staged — not applied until saved\./);
    expect(PAGE).toMatch(/\{dirty && \(\s*\n\s*<button onClick=\{save\}/);
  });
});
