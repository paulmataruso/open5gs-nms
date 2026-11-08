import { CONFIGURABLE_MODULE_IDS, describeModuleConfig, ModuleConfigResult } from '../module-initial-config';
import * as fs from 'fs';
import * as path from 'path';

const src = fs.readFileSync(path.resolve(__dirname, '../module-initial-config.ts'), 'utf-8');

describe('CONFIGURABLE_MODULE_IDS', () => {
  it('covers every module the bootstrap can install', () => {
    // A module installed but absent here would be left dark, which is the
    // exact gap this file exists to close.
    const bootstrap = fs.readFileSync(
      path.resolve(__dirname, '../../fresh-host-bootstrap-usecase.ts'), 'utf-8');
    const order = /const MODULE_INSTALL_ORDER: BootstrapModuleId\[\] = \[([\s\S]*?)\];/.exec(bootstrap);
    expect(order).not.toBeNull();
    const ids = [...order![1].matchAll(/'([a-zA-Z0-9]+)'/g)].map(m => m[1]);
    expect(ids.length).toBeGreaterThan(10);
    for (const id of ids) expect(CONFIGURABLE_MODULE_IDS).toContain(id);
  });

  it('configures in the install order, because configure-time deps run the same way', () => {
    // IMS underpins MMS/PSTN/VectorCore SMSC; HNBGW's configure needs GSM's
    // GPRS already applied.
    const ids = [...CONFIGURABLE_MODULE_IDS];
    expect(ids.indexOf('ims')).toBeLessThan(ids.indexOf('mms'));
    expect(ids.indexOf('ims')).toBeLessThan(ids.indexOf('pstn'));
    expect(ids.indexOf('ims')).toBeLessThan(ids.indexOf('vectorcoreSmsc'));
    expect(ids.indexOf('gsm')).toBeLessThan(ids.indexOf('hnbgw'));
    expect(ids.indexOf('gsm')).toBeLessThan(ids.indexOf('asterisk2g'));
  });
});

describe('addresses come from the plan, never a module default', () => {
  it('uses planAddress for every module that binds a service address', () => {
    for (const key of ['pcscf', 'dns', 'epdg', 'secgw', 'mmsc']) {
      expect(src).toContain(`planAddress(plan, '${key}')`);
    }
  });

  it('fails loudly when the plan lacks an address it needs', () => {
    // Silently falling back to a module default is how a deployment ends up
    // on a colliding address -- VoWiFi's own default is the address BIND
    // uses, and SecGW's default gateway is where ePDG actually runs.
    expect(src).toMatch(/if \(!pcscfIp \|\| !dnsIp\) throw new Error/);
    expect(src).toMatch(/if \(!epdgIp\) throw new Error/);
    expect(src).toMatch(/if \(!gatewayIp\) throw new Error/);
    expect(src).toMatch(/if \(!mm1\) throw new Error/);
  });

  it('never uses a colliding module default as a bind address', () => {
    expect(src).not.toMatch(/epdgIp:\s*DEFAULT_EPDG_IP/);
    expect(src).not.toMatch(/10\.0\.1\.\d+/);
  });

  it('takes the SecGW pool CIDR from the plan, which guaranteed its alignment', () => {
    expect(src).toContain('poolCidr: plan.secgwPoolCidr');
  });

  it('gives P-CSCF and rtpengine the same address', () => {
    expect(src).toMatch(/pcscfIp,\s*\n\s*rtpEngineIp: pcscfIp,/);
  });

  it('shares the IMS port defaults rather than copying the literals', () => {
    // Duplicating them is how the route and this path silently drift apart.
    expect(src).toContain('...IMS_CONFIGURE_DEFAULTS');
    expect(src).not.toMatch(/pcscfPort:\s*5060/);
  });
});

describe('interface mode', () => {
  it('uses the existing interface, never a dummy', () => {
    // This feature binds service addresses on one real NIC. 'dummy' creates a
    // /32 netdev expecting a routing protocol to carry it -- the layer-3
    // design this explicitly is not.
    const modes = [...src.matchAll(/interfaceMode: '(\w+)'/g)].map(m => m[1]);
    expect(modes.length).toBeGreaterThanOrEqual(2);
    for (const m of modes) expect(m).toBe('existing');
  });
});

describe('2G safety', () => {
  it('does not enable a real BTS or transmit', () => {
    // A real BTS transmits on real spectrum; an unattended run must never
    // switch that on.
    expect(src).toContain('gprsEnabled: false');
    expect(src).not.toMatch(/backend:\s*'(trx|sysmo|nanobts|octphy)'/);
  });
});

describe('describeModuleConfig', () => {
  const r = (over: Partial<ModuleConfigResult>): ModuleConfigResult =>
    ({ moduleId: 'x', configured: false, ...over });

  it('counts the configured modules', () => {
    expect(describeModuleConfig([r({ configured: true }), r({ configured: true })]))
      .toBe('2 configured');
  });

  it('names every failure with its reason', () => {
    const out = describeModuleConfig([
      r({ moduleId: 'ims', configured: true }),
      r({ moduleId: 'mms', error: 'no MMSC address' }),
    ]);
    expect(out).toMatch(/1 configured/);
    expect(out).toMatch(/1 FAILED: mms \(no MMSC address\)/);
  });

  it('reports a missing reason rather than an empty parenthesis', () => {
    expect(describeModuleConfig([r({ moduleId: 'ocs' })]))
      .toMatch(/ocs \(no error reported\)/);
  });

  it('counts deliberate skips apart from failures', () => {
    const out = describeModuleConfig([r({ moduleId: 'syslog', skipped: true })]);
    expect(out).toMatch(/1 skipped/);
    expect(out).not.toMatch(/FAILED/);
  });
});

import { MODULE_OWNED_IP_PLAN_SERVICES, servicesAlreadyConfigured } from '../module-initial-config';
import { SERVICE_TO_IP_PLAN } from '../../../../domain/services/autoconfig-apply';

describe('not configuring the same module twice in one run', () => {
  // Found live: configure-modules set IMS from the plan, then module-addresses
  // re-applied the SAME address through IpPlanApply, which calls IMS Configure
  // again. That left smf.yaml with a duplicate `dnn: ims` session entry, and
  // Open5GS refuses to start on overlapping subnets -- SMF went down with
  // "Overlapping subnets in SMF configuration file: 10.46.0.1/24 and
  // 10.46.0.1/24".
  it('claims the IMS services, which is where this actually bit', () => {
    expect(servicesAlreadyConfigured(['ims'])).toEqual(new Set(['ims-pcscf', 'ims-rtpengine']));
  });

  it('claims the single-address modules too', () => {
    expect(servicesAlreadyConfigured(['vowifi'])).toEqual(new Set(['vowifi-epdg']));
    expect(servicesAlreadyConfigured(['secgw'])).toEqual(new Set(['secgw-gateway']));
    expect(servicesAlreadyConfigured(['mms'])).toEqual(new Set(['mms-mm1']));
  });

  it('does NOT claim the PSTN external trunk', () => {
    // PSTN's Configure sets only its loopback Asterisk bind; the external
    // trunk address is genuinely the IP Plan step's to apply, so claiming it
    // here would silently skip a real change.
    expect(servicesAlreadyConfigured(['pstn'])).toEqual(new Set());
  });

  it('claims nothing for a module that configures no addresses', () => {
    expect(servicesAlreadyConfigured(['smsOverSgs', 'gsm', 'hnbgw', 'ocs', 'syslog'])).toEqual(new Set());
  });

  it('unions across several modules', () => {
    expect(servicesAlreadyConfigured(['ims', 'vowifi', 'secgw']))
      .toEqual(new Set(['ims-pcscf', 'ims-rtpengine', 'vowifi-epdg', 'secgw-gateway']));
  });

  it('claims nothing when nothing was configured', () => {
    expect(servicesAlreadyConfigured([])).toEqual(new Set());
  });

  it('only ever names services the allocator actually produces', () => {
    // A name that no plan emits would be dead, and a typo here silently
    // stops skipping — reintroducing the duplicate Configure.
    const emitted = new Set(Object.values(SERVICE_TO_IP_PLAN).flat());
    for (const svcs of Object.values(MODULE_OWNED_IP_PLAN_SERVICES)) {
      for (const s of svcs) expect(emitted.has(s)).toBe(true);
    }
  });

  it('covers every module whose configurator takes a plan address', () => {
    // If a configurator starts applying an address but is not listed here,
    // module-addresses re-applies it and the double-Configure returns.
    const src = fs.readFileSync(path.resolve(__dirname, '../module-initial-config.ts'), 'utf-8');
    for (const id of ['ims', 'vowifi', 'secgw', 'mms']) {
      const block = new RegExp(`id: '${id}'[\\s\\S]*?\\n  \\},`).exec(src);
      expect(block).not.toBeNull();
      if (/planAddress\(plan, '/.test(block![0])) {
        expect((MODULE_OWNED_IP_PLAN_SERVICES[id] ?? []).length).toBeGreaterThan(0);
      }
    }
  });
});
