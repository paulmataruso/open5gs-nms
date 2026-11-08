import {
  AUTOCONFIG_SERVICES, DEFAULT_SECGW_POOL_SIZE,
  readAutoconfigEnv, isValidIpv4, netmaskToPrefix,
  buildAutoconfigContext, allocateAddresses, planAddress, describePlan,
  TakenPredicate,
} from '../autoconfig-plan';

const ENV = (over: Record<string, string> = {}) => readAutoconfigEnv({
  AUTOCONFIG_ENABLED: 'true',
  AUTOCONFIG_INTERFACE: 'eth0',
  AUTOCONFIG_START_IP: '172.16.0.100',
  AUTOCONFIG_GW: '172.16.0.1',
  AUTOCONFIG_SUBNET: '255.255.255.0',
  ...over,
});

const NONE_TAKEN: TakenPredicate = () => false;

const ctxOf = (over: Record<string, string> = {}) => {
  const r = buildAutoconfigContext(ENV(over));
  if (!r.ok) throw new Error(`expected a context, got: ${JSON.stringify(r.errors)}`);
  return r.context;
};
/** Plan with nothing occupied, i.e. the simple consecutive case. */
const planOf = (over: Record<string, string> = {}, taken: TakenPredicate = NONE_TAKEN) => {
  const r = allocateAddresses(ctxOf(over), taken);
  if (!r.ok) throw new Error(`expected a plan, got: ${JSON.stringify(r.errors)}`);
  return r.plan;
};
const errorsOf = (over: Record<string, string> = {}) => {
  const r = buildAutoconfigContext(ENV(over));
  if (r.ok) throw new Error('expected errors, got a context');
  return r.errors;
};
/** Allocation errors (as opposed to env-validation errors). */
const allocErrorsOf = (taken: (ip: string) => boolean, over: Record<string, string> = {}) => {
  const r = allocateAddresses(ctxOf(over), taken);
  if (r.ok) throw new Error('expected allocation errors, got a plan');
  return r.errors;
};

describe('readAutoconfigEnv', () => {
  it('is off unless explicitly enabled', () => {
    expect(readAutoconfigEnv({}).enabled).toBe(false);
    expect(readAutoconfigEnv({ AUTOCONFIG_ENABLED: 'yes' }).enabled).toBe(false);
    expect(readAutoconfigEnv({ AUTOCONFIG_ENABLED: 'true' }).enabled).toBe(true);
  });

  it('defaults the SecGW pool size and rejects nonsense', () => {
    expect(ENV().secgwPoolSize).toBe(DEFAULT_SECGW_POOL_SIZE);
    expect(ENV({ AUTOCONFIG_SECGW_POOL_SIZE: '0' }).secgwPoolSize).toBe(DEFAULT_SECGW_POOL_SIZE);
    expect(ENV({ AUTOCONFIG_SECGW_POOL_SIZE: '-4' }).secgwPoolSize).toBe(DEFAULT_SECGW_POOL_SIZE);
    expect(ENV({ AUTOCONFIG_SECGW_POOL_SIZE: 'eight' }).secgwPoolSize).toBe(DEFAULT_SECGW_POOL_SIZE);
    expect(ENV({ AUTOCONFIG_SECGW_POOL_SIZE: '16' }).secgwPoolSize).toBe(16);
  });

  it('treats blank values as unset so the validator can name them', () => {
    expect(readAutoconfigEnv({ AUTOCONFIG_START_IP: '   ' }).startIp).toBeNull();
  });
});

describe('isValidIpv4', () => {
  it('accepts real addresses', () => {
    for (const ip of ['0.0.0.0', '172.16.0.100', '255.255.255.255', '10.0.1.1']) {
      expect(isValidIpv4(ip)).toBe(true);
    }
  });

  it('rejects out-of-range octets and wrong shapes', () => {
    for (const ip of ['256.0.0.1', '1.2.3', '1.2.3.4.5', 'abc', '', '1.2.3.-1']) {
      expect(isValidIpv4(ip)).toBe(false);
    }
  });

  it('rejects a leading zero, which is ambiguous between decimal and octal', () => {
    expect(isValidIpv4('010.0.0.1')).toBe(false);
    expect(isValidIpv4('172.16.00.1')).toBe(false);
  });
});

describe('netmaskToPrefix', () => {
  it('converts the netmasks an operator would actually type', () => {
    expect(netmaskToPrefix('255.255.255.0')).toBe(24);
    expect(netmaskToPrefix('255.255.0.0')).toBe(16);
    expect(netmaskToPrefix('255.255.255.192')).toBe(26);
    expect(netmaskToPrefix('255.255.255.255')).toBe(32);
    expect(netmaskToPrefix('0.0.0.0')).toBe(0);
  });

  it('accepts a /prefix too, with or without the slash', () => {
    expect(netmaskToPrefix('/24')).toBe(24);
    expect(netmaskToPrefix('24')).toBe(24);
  });

  it('REJECTS a non-contiguous mask rather than silently inventing a subnet', () => {
    // 255.255.0.255 is not a netmask. Accepting it would produce addresses
    // that only fail later, on the host, as unreachable.
    expect(netmaskToPrefix('255.255.0.255')).toBeNull();
    expect(netmaskToPrefix('255.0.255.0')).toBeNull();
    expect(netmaskToPrefix('0.255.255.255')).toBeNull();
  });

  it('rejects junk', () => {
    expect(netmaskToPrefix('/33')).toBeNull();
    expect(netmaskToPrefix('banana')).toBeNull();
  });

  it('handles masks whose first octet is >= 128 without sign corruption', () => {
    // The bitwise-on-signed-int32 footgun this project has already been bitten
    // by once (see ip-utils' own >>> 0 normalisation).
    expect(netmaskToPrefix('128.0.0.0')).toBe(1);
    expect(netmaskToPrefix('192.0.0.0')).toBe(2);
  });
});

describe('buildAutoconfigPlan — the operator example', () => {
  const plan = planOf();

  it('allocates one address per service, consecutively from the start IP', () => {
    expect(plan.services).toHaveLength(AUTOCONFIG_SERVICES.length);
    expect(plan.services.map(s => s.ip)).toEqual([
      '172.16.0.100', '172.16.0.101', '172.16.0.102', '172.16.0.103', '172.16.0.104',
      '172.16.0.105', '172.16.0.106', '172.16.0.107', '172.16.0.108', '172.16.0.109',
    ]);
  });

  it('allocates the SecGW pool on the next ALIGNED block after the services', () => {
    // A /29 must start on a multiple of 8, so .112 — not .110 — or the mask
    // would describe addresses outside the block SecGW was given.
    expect(plan.secgwPool).toEqual([
      '172.16.0.112', '172.16.0.113', '172.16.0.114', '172.16.0.115',
      '172.16.0.116', '172.16.0.117', '172.16.0.118', '172.16.0.119',
    ]);
    expect(plan.secgwPoolCidr).toBe('172.16.0.112/29');
  });

  it('derives the subnet and keeps the gateway', () => {
    expect(plan.network).toBe('172.16.0.0');
    expect(plan.prefix).toBe(24);
    expect(plan.gateway).toBe('172.16.0.1');
  });

  it('reports every address it will bind, with no duplicates', () => {
    expect(plan.allAddresses).toHaveLength(18);
    expect(new Set(plan.allAddresses).size).toBe(18);
  });

  it('skips nothing when the range is empty', () => {
    expect(plan.skipped).toEqual([]);
  });

  it('gives the four port-colliding services distinct addresses', () => {
    // UPF/SGW-U both bind udp/2152; ePDG/SecGW both bind udp/500+4500.
    // Sharing an address would make one of each pair fail to bind.
    const a = (k: string) => planAddress(plan, k);
    expect(a('upfGtpu')).not.toBe(a('sgwuGtpu'));
    expect(a('epdg')).not.toBe(a('secgw'));
    expect(a('pcscf')).not.toBe(a('pstnTrunk'));
  });

  it('looks an address up by key', () => {
    expect(planAddress(plan, 'amfNgap')).toBe('172.16.0.100');
    expect(planAddress(plan, 'pstnTrunk')).toBe('172.16.0.109');
    expect(planAddress(plan, 'nope')).toBeNull();
  });
});

describe('the frozen service order', () => {
  it('is a compatibility contract — changing it reshuffles every deployment', () => {
    // If this fails you are about to re-address every upgraded host. Append
    // new services at the END; never insert or remove.
    expect(AUTOCONFIG_SERVICES.map(s => s.key)).toEqual([
      'amfNgap', 'upfGtpu', 'mmeS1ap', 'sgwuGtpu', 'pcscf',
      'mmsc', 'dns', 'epdg', 'secgw', 'pstnTrunk',
    ]);
  });

  it('has unique keys and unique FQDN labels', () => {
    const keys = AUTOCONFIG_SERVICES.map(s => s.key);
    const fqdns = AUTOCONFIG_SERVICES.map(s => s.fqdnLabel);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(fqdns).size).toBe(fqdns.length);
  });

  it('records port collisions symmetrically, so neither side can be merged by mistake', () => {
    for (const s of AUTOCONFIG_SERVICES) {
      if (!s.sharesPortWith) continue;
      const other = AUTOCONFIG_SERVICES.find(o => o.key === s.sharesPortWith);
      expect(other).toBeDefined();
      expect(other?.sharesPortWith).toBe(s.key);
    }
  });

  it('omits everything that binds a wildcard or loopback', () => {
    // Each of these would waste a routable address: verified on the reference
    // host as binding 0.0.0.0 or 127.x.
    const keys = AUTOCONFIG_SERVICES.map(s => s.key).join(',');
    for (const absent of ['nginx', 'grafana', 'sasbench', 'chrony', 'snmp', 'mongo',
                          'icscf', 'scscf', 'asterisk', 'ocs', 'hnbgw', 'sgsn']) {
      expect(keys).not.toContain(absent);
    }
  });
});

describe('buildAutoconfigPlan — validation', () => {
  it('reports EVERY problem at once, not just the first', () => {
    const r = buildAutoconfigContext(readAutoconfigEnv({ AUTOCONFIG_ENABLED: 'true' }));
    // An operator editing .env wants one round trip, not three restarts.
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toHaveLength(3);
  });

  it('rejects a gateway outside the start address subnet', () => {
    const e = errorsOf({ AUTOCONFIG_GW: '10.9.9.1' });
    expect(e.some(x => x.field === 'AUTOCONFIG_GW' && /one L2 subnet/.test(x.message))).toBe(true);
  });

  it('refuses when the block would run past the broadcast address', () => {
    // .250 + 18 addresses overruns .255 on a /24.
    const e = errorsOf({ AUTOCONFIG_START_IP: '172.16.0.250' });
    expect(e.some(x => /below the broadcast address 172\.16\.0\.255/.test(x.message))).toBe(true);
    // And it says how many are actually left, so the operator can do the maths.
    expect(e.some(x => /only 5 remain/.test(x.message))).toBe(true);
  });

  it('names how many addresses it needed and why', () => {
    const e = errorsOf({ AUTOCONFIG_START_IP: '172.16.0.250' });
    expect(e[0].message).toMatch(/at least 18 addresses \(10 services \+ 8 SecGW pool\)/);
  });

  it('refuses a start address that is the network address', () => {
    const e = errorsOf({ AUTOCONFIG_START_IP: '172.16.0.0' });
    expect(e.some(x => /network address/.test(x.message))).toBe(true);
  });

  it('never allocates the gateway, even when it sits inside the range', () => {
    // Claiming the gateway's own address would black-hole the whole host.
    const plan = planOf({ AUTOCONFIG_START_IP: '172.16.0.2', AUTOCONFIG_GW: '172.16.0.5' });
    expect(plan.allAddresses).not.toContain('172.16.0.5');
    expect(ctxOf({ AUTOCONFIG_START_IP: '172.16.0.2', AUTOCONFIG_GW: '172.16.0.5' }).candidates)
      .not.toContain('172.16.0.5');
  });

  it('refuses a subnet with no usable host range', () => {
    const e = errorsOf({ AUTOCONFIG_SUBNET: '255.255.255.254' });
    expect(e.some(x => /no usable host range/.test(x.message))).toBe(true);
  });

  it('accepts a larger pool when the subnet has room', () => {
    const plan = planOf({ AUTOCONFIG_SECGW_POOL_SIZE: '16', AUTOCONFIG_SUBNET: '255.255.0.0' });
    expect(plan.secgwPool).toHaveLength(16);
    expect(plan.allAddresses).toHaveLength(AUTOCONFIG_SERVICES.length + 16);
    // /28 must be 16-aligned, so .112 not .110.
    expect(plan.secgwPoolCidr).toBe('172.16.0.112/28');
  });

  it('works across an octet boundary', () => {
    const plan = planOf({ AUTOCONFIG_START_IP: '172.16.0.250', AUTOCONFIG_SUBNET: '255.255.0.0' });
    expect(planAddress(plan, 'amfNgap')).toBe('172.16.0.250');
    // Services land .250-.259; the pool then takes the next aligned /29.
    expect(plan.secgwPool[0]).toBe('172.16.1.8');
  });

  it('works in a subnet whose first octet is >= 128', () => {
    // Guards the signed-int32 bitwise class of bug directly.
    const plan = planOf({ AUTOCONFIG_START_IP: '192.168.50.100', AUTOCONFIG_GW: '192.168.50.1' });
    expect(plan.network).toBe('192.168.50.0');
    expect(planAddress(plan, 'amfNgap')).toBe('192.168.50.100');
  });
});

describe('describePlan', () => {
  it('shows every address and what claims it, before anything is touched', () => {
    const out = describePlan(planOf());
    expect(out).toContain('18 addresses on eth0');
    expect(out).toContain('172.16.0.0/24');
    expect(out).toContain('172.16.0.100');
    expect(out).toContain('AMF NGAP (N2)');
    expect(out).toContain('SecGW per-radio pool');
    for (const s of planOf().services) expect(out).toContain(s.ip);
  });

  it('says so when the interface will be auto-detected', () => {
    const c = buildAutoconfigContext(readAutoconfigEnv({
      AUTOCONFIG_ENABLED: 'true', AUTOCONFIG_START_IP: '172.16.0.100',
      AUTOCONFIG_GW: '172.16.0.1', AUTOCONFIG_SUBNET: '/24',
    }));
    if (!c.ok) throw new Error('expected a context');
    const r = allocateAddresses(c.context, () => false);
    if (!r.ok) throw new Error('expected a plan');
    expect(describePlan(r.plan)).toContain('auto-detected interface');
  });

  it('lists the addresses it stepped over, so the skip is visible', () => {
    const taken = (ip: string) => ['172.16.0.101', '172.16.0.105'].includes(ip);
    const out = describePlan(planOf({}, taken));
    expect(out).toMatch(/skipped 2 address\(es\) already in use/);
    expect(out).toContain('172.16.0.101');
  });
});

describe('allocateAddresses — skipping addresses already in use', () => {
  const ctx = () => {
    const r = buildAutoconfigContext(ENV());
    if (!r.ok) throw new Error('ctx');
    return r.context;
  };
  const alloc = (taken: (ip: string) => boolean) => {
    const r = allocateAddresses(ctx(), taken);
    if (!r.ok) throw new Error(`expected a plan: ${JSON.stringify(r.errors)}`);
    return r.plan;
  };

  it('steps over an occupied address and takes the next free one', () => {
    const plan = alloc(ip => ip === '172.16.0.100');
    expect(planAddress(plan, 'amfNgap')).toBe('172.16.0.101');
    expect(plan.allAddresses).not.toContain('172.16.0.100');
    expect(plan.skipped).toContain('172.16.0.100');
  });

  it('steps over a run of occupied addresses', () => {
    const busy = ['172.16.0.100', '172.16.0.101', '172.16.0.102'];
    const plan = alloc(ip => busy.includes(ip));
    expect(planAddress(plan, 'amfNgap')).toBe('172.16.0.103');
    expect(plan.skipped).toEqual(busy);
  });

  it('steps over gaps in the middle, keeping the frozen service ORDER intact', () => {
    // Order is the contract; contiguity is not.
    const plan = alloc(ip => ['172.16.0.102', '172.16.0.106'].includes(ip));
    expect(plan.services.map(s => s.key)).toEqual(AUTOCONFIG_SERVICES.map(s => s.key));
    expect(planAddress(plan, 'amfNgap')).toBe('172.16.0.100');
    expect(planAddress(plan, 'upfGtpu')).toBe('172.16.0.101');
    expect(planAddress(plan, 'mmeS1ap')).toBe('172.16.0.103');   // .102 skipped
    expect(plan.allAddresses).not.toContain('172.16.0.102');
    expect(plan.allAddresses).not.toContain('172.16.0.106');
  });

  it('never allocates an address it skipped', () => {
    const busy = new Set(['172.16.0.103', '172.16.0.110', '172.16.0.117']);
    const plan = alloc(ip => busy.has(ip));
    for (const ip of plan.allAddresses) expect(busy.has(ip)).toBe(false);
  });

  it('keeps the colliding pairs on distinct addresses even after skipping', () => {
    const plan = alloc(ip => ['172.16.0.101', '172.16.0.107'].includes(ip));
    expect(planAddress(plan, 'upfGtpu')).not.toBe(planAddress(plan, 'sgwuGtpu'));
    expect(planAddress(plan, 'epdg')).not.toBe(planAddress(plan, 'secgw'));
  });

  it('finds an ALIGNED, entirely free block for the SecGW pool', () => {
    // A single occupied address inside an aligned /29 disqualifies that whole
    // block: SecGW is handed one CIDR and later draws single addresses from
    // it, so a covered-but-occupied address would be given to a radio.
    const plan = alloc(ip => ip === '172.16.0.114');
    expect(plan.secgwPool).not.toContain('172.16.0.114');
    expect(plan.secgwPool[0]).toBe('172.16.0.120');          // next aligned /29
    expect(plan.secgwPoolCidr).toBe('172.16.0.120/29');
    expect(plan.secgwPool).toHaveLength(8);
  });

  it('keeps the pool CIDR aligned to its own size', () => {
    const plan = alloc(() => false);
    const [first, prefix] = plan.secgwPoolCidr.split('/');
    const last = Number(first.split('.')[3]);
    const span = 2 ** (32 - Number(prefix));
    expect(last % span).toBe(0);
  });

  it('fails with a useful message when the range is too crowded for the services', () => {
    // Everything busy except a handful — not enough for 10 services.
    const freeOnes = ['172.16.0.100', '172.16.0.101'];
    const r = allocateAddresses(ctx(), ip => !freeOnes.includes(ip));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0].message).toMatch(/ran out of free addresses/);
      expect(r.errors[0].message).toMatch(/already in use on the network/);
      // Names which service it got stuck on, so the operator knows how far it got.
      expect(r.errors[0].message).toMatch(/MME S1-MME|AMF NGAP|UPF GTP-U/);
    }
  });

  it('fails clearly when services fit but no aligned pool block is free', () => {
    // Free the 10 service addresses; occupy everything above them.
    const svc = Array.from({ length: 10 }, (_, i) => `172.16.0.${100 + i}`);
    const r = allocateAddresses(ctx(), ip => !svc.includes(ip));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0].field).toBe('AUTOCONFIG_SECGW_POOL_SIZE');
      expect(r.errors[0].message).toMatch(/consecutive free addresses on a \/29 boundary/);
      expect(r.errors[0].message).toMatch(/aligned and entirely free/);
    }
  });

  it('does not count the gateway as a skipped address — it was never a candidate', () => {
    const r = buildAutoconfigContext(ENV({ AUTOCONFIG_START_IP: '172.16.0.2' }));
    if (!r.ok) throw new Error('ctx');
    const plan = allocateAddresses(r.context, () => false);
    if (!plan.ok) throw new Error('plan');
    expect(plan.plan.skipped).not.toContain('172.16.0.1');
    expect(plan.plan.allAddresses).not.toContain('172.16.0.1');
  });

  it('reports each skipped address once, not once per service that passed it', () => {
    const plan = alloc(ip => ip === '172.16.0.100');
    expect(plan.skipped.filter(x => x === '172.16.0.100')).toHaveLength(1);
  });
});
