import * as fs from 'fs';
import * as path from 'path';

// Confirmed live 2026-10-11: osmo-sgsn and osmo-ggsn had been down since the
// 2026-10-06 reboot — no journal entries at all, empty ActiveEnterTimestamp —
// while the 2G module's own state still said `gprsEnabled: true` and both
// configs sat on disk. Root cause: nothing ever `systemctl enable`d them, so
// Configure/Start only brought them up for the current boot.
//
// The rest of the 2G/3G stack survived reboots only by ACCIDENT: osmo-hnbgw and
// osmo-sip-connector happen to be enabled and pull osmo-stp/osmo-msc/osmo-bsc/
// osmo-mgw in as dependencies. Both belong to other optional modules, so
// uninstalling either would have silently taken 2G down on the next reboot too.
// osmo-sgsn/osmo-ggsn were in nobody's dependency chain, which is why they were
// the pair that actually broke.
//
// There is no REST surface for "is this unit enabled", and asserting against the
// live host would make this environment-dependent, so this guards the wiring
// statically. Cheap, and it fails the moment someone reverts to a bare
// start/stop.

const SRC = path.resolve(__dirname, '../../..');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf-8');

// The body of a router.post('<route>', ...) handler, up to the next route.
function routeBody(src: string, route: string): string {
  const start = src.indexOf(`router.post('${route}'`);
  expect(start).toBeGreaterThan(-1);
  const next = src.indexOf('router.post(', start + 10);
  return src.slice(start, next === -1 ? src.length : next);
}

describe('Osmocom services are enabled, not just started', () => {
  describe('2G GSM module', () => {
    const src = read('interfaces/rest/gsm-controller.ts');

    it('/start enables every lifecycle service so it survives a reboot', () => {
      const body = routeBody(src, '/start');
      expect(body).toMatch(/lifecycleServices\(state\)\)\s*await nsenter\('systemctl',\s*\['enable',\s*'--now',\s*svc\]\)/);
      // A bare start would leave the unit disabled.
      expect(body).not.toMatch(/\['start',\s*svc\]/);
    });

    it('/stop disables them, so "stopped" is not undone by the next reboot', () => {
      const body = routeBody(src, '/stop');
      expect(body).toMatch(/\['disable',\s*'--now',\s*svc\]/);
      expect(body).not.toMatch(/\['stop',\s*svc\]/);
    });

    it('lifecycleServices still includes the GPRS pair when GPRS is on', () => {
      // If this list stops covering them, enabling the list stops helping.
      expect(src).toMatch(/gprsEnabled \? \['osmo-sgsn', 'osmo-ggsn'\]/);
    });

    it('Configure enables the GPRS pair on the on-path', () => {
      expect(src).toMatch(/\['enable',\s*'osmo-sgsn'\]/);
      expect(src).toMatch(/\['enable',\s*'osmo-ggsn'\]/);
    });

    it('Configure disables the GPRS pair when GPRS is turned off', () => {
      // There was no off-path at all: turning GPRS off left both daemons
      // running and serving, while the page reported it disabled.
      expect(src).toMatch(/for \(const svc of \['osmo-pcu', 'osmo-sgsn', 'osmo-ggsn'\]\)/);
    });
  });

  describe('SMS-over-SGs module (shares osmo-stp/hlr/msc)', () => {
    const src = read('interfaces/rest/sms-controller.ts');

    it('/start enables the three shared daemons', () => {
      const body = routeBody(src, '/start');
      expect(body).toMatch(/\['enable',\s*'--now',\s*svc\]/);
      expect(body).not.toMatch(/\['start',\s*svc\]/);
    });

    it('/stop disables them', () => {
      const body = routeBody(src, '/stop');
      expect(body).toMatch(/\['disable',\s*'--now',\s*svc\]/);
      expect(body).not.toMatch(/\['stop',\s*svc\]\)/);
    });

    it('no bare start/stop of the shared trio survives anywhere in the file', () => {
      // Catches the /enable and /disable routes too, without coupling the test
      // to their exact route names.
      expect(src).not.toMatch(/\['start',\s*svc\]/);
      expect(src).not.toMatch(/\['stop',\s*svc\]/);
    });
  });
});
