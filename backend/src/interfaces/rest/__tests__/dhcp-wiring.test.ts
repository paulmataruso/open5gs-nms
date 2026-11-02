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
});
