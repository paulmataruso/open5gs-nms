
/**
 * The shared named.conf.options API: listen-on and forwarders.
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS. IMS, VoWiFi, the DNS/FQDN Migration
 * Wizard and Auto-Configuration all use the SAME single BIND instance for
 * different zones, and bind-controller.ts is deliberately the only writer of
 * the options{} block. Every other module is supposed to import
 * readListenOn/writeListenOn (or readForwarders/writeForwarders) and merge
 * into it, rather than writing the file itself -- because a module that
 * rewrites the whole file takes out every other module's settings, and the
 * uninstall equivalent of that mistake (`apt purge bind9`) wipes /etc/bind
 * entirely including every other module's zones.
 *
 * insertIntoOptionsBlock already had tests. The four exported read/write
 * functions -- the part other modules actually import -- had none, so the
 * merge property itself was unverified: nothing caught a writeListenOn that
 * discarded a forwarders block, which is precisely the failure the ownership
 * rule exists to prevent.
 *
 * NO REAL FILE IS TOUCHED. HOST_BIND_DIR is the literal
 * '/proc/1/root/etc/bind', i.e. this host's live BIND config, and it is not
 * injectable -- so fs is mocked such that the options file lives in memory
 * and a write to ANY other path throws instead of landing on the real disk.
 * That the only path written is the expected one is itself asserted below.
 */

const OPTIONS_PATH = '/proc/1/root/etc/bind/named.conf.options';

/** The in-memory stand-in for named.conf.options. */
let stored: string | null = null;
/** Every path written during a test, so an unexpected target is visible. */
let writes: string[] = [];

jest.mock('fs', () => {
  const actual = jest.requireActual<typeof import('fs')>('fs');
  const isTarget = (p: unknown): boolean =>
    String(p) === '/proc/1/root/etc/bind/named.conf.options';
  return {
    ...actual,
    existsSync: (p: unknown): boolean =>
      (isTarget(p) ? stored !== null : actual.existsSync(p as string)),
    readFileSync: (p: unknown, ...rest: unknown[]): unknown => {
      if (!isTarget(p)) return (actual.readFileSync as (...a: unknown[]) => unknown)(p, ...rest);
      if (stored === null) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return stored;
    },
    writeFileSync: (p: unknown, data: unknown): void => {
      writes.push(String(p));
      if (!isTarget(p)) throw new Error(`refusing to write outside the mock: ${String(p)}`);
      stored = String(data);
    },
    mkdirSync: (p: unknown): undefined => {
      // The real writeListenOn mkdir -p's the options file's directory.
      if (String(p) !== '/proc/1/root/etc/bind') {
        throw new Error(`refusing to mkdir outside the mock: ${String(p)}`);
      }
      return undefined;
    },
  };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const bind = require('../bind-controller') as typeof import('../bind-controller');
const { readListenOn, writeListenOn, readForwarders, writeForwarders } = bind;

/** named.conf.options as a real deployment has it, with both blocks set. */
const BOTH = `options {
\tdirectory "/var/cache/bind";
\tlisten-on { 127.0.0.1; 10.0.1.178; };
\tforwarders { 9.9.9.9; 1.1.1.1; };
\tdnssec-validation no;
\trecursion yes;
\tallow-query { any; };
};
`;

beforeEach(() => { stored = null; writes = []; });

describe('writing one block never disturbs the other', () => {
  it('writeListenOn keeps an existing forwarders block exactly as it was', () => {
    // The ownership rule's whole point: VoWiFi adding its own ePDG address to
    // listen-on must not cost the DNS page its forwarders.
    stored = BOTH;
    writeListenOn(['10.0.1.178', '10.0.1.200']);
    expect(readForwarders()).toEqual(['9.9.9.9', '1.1.1.1']);
    expect(stored).toContain('forwarders { 9.9.9.9; 1.1.1.1; };');
  });

  it('writeForwarders keeps an existing listen-on block exactly as it was', () => {
    stored = BOTH;
    writeForwarders(['8.8.8.8']);
    expect(readListenOn()).toEqual(['127.0.0.1', '10.0.1.178']);
    expect(stored).toContain('listen-on { 127.0.0.1; 10.0.1.178; };');
  });

  it('neither touches the unrelated directives other modules rely on', () => {
    // recursion/allow-query are maintained by this same file for the resolver
    // fix, and `directory` is BIND's own. A write that rebuilt the block
    // rather than editing one line would silently drop all three.
    stored = BOTH;
    writeListenOn(['10.9.9.9']);
    writeForwarders(['8.8.8.8']);
    for (const line of [
      'directory "/var/cache/bind";', 'dnssec-validation no;',
      'recursion yes;', 'allow-query { any; };',
    ]) {
      expect(stored).toContain(line);
    }
  });

  it('replaces its own block rather than appending a second one', () => {
    // Two listen-on lines in one options{} block is a config BIND refuses to
    // load, so an append would take DNS down for every module at once.
    stored = BOTH;
    writeListenOn(['10.9.9.9']);
    writeForwarders(['8.8.8.8']);
    expect(String(stored).match(/listen-on\s*\{/g)).toHaveLength(1);
    expect(String(stored).match(/forwarders\s*\{/g)).toHaveLength(1);
    expect(String(stored).match(/^options\s*\{/gm)).toHaveLength(1);
  });
});

describe('listen-on', () => {
  it('always keeps 127.0.0.1, even when the caller does not ask for it', () => {
    // Every module here assumes BIND answers on loopback regardless of what
    // else is configured -- IMS zone verification, VoWiFi, and the migration
    // wizard's own dig checks all query 127.0.0.1. Dropping it would make
    // those read as "the zone does not resolve" while BIND was serving fine.
    stored = BOTH;
    writeListenOn(['10.0.1.200']);
    expect(readListenOn()).toEqual(['127.0.0.1', '10.0.1.200']);
  });

  it('deduplicates, including a caller that passes loopback itself', () => {
    stored = BOTH;
    writeListenOn(['127.0.0.1', '10.0.1.200', '10.0.1.200']);
    expect(readListenOn()).toEqual(['127.0.0.1', '10.0.1.200']);
    expect(stored).toContain('listen-on { 127.0.0.1; 10.0.1.200; };');
  });

  it('round-trips an address set through write and read', () => {
    stored = BOTH;
    const want = ['127.0.0.1', '10.0.1.178', '10.0.1.200', '192.168.253.2'];
    writeListenOn(want);
    expect(readListenOn()).toEqual(want);
  });

  it('reports loopback when the file does not exist at all', () => {
    // A fresh host before BIND is installed. Returning [] would read as "BIND
    // listens nowhere" and an empty listen-on is not the same thing.
    expect(stored).toBeNull();
    expect(readListenOn()).toEqual(['127.0.0.1']);
  });

  it('reports loopback when the block is absent or holds nothing usable', () => {
    stored = 'options {\n\trecursion yes;\n};\n';
    expect(readListenOn()).toEqual(['127.0.0.1']);
    stored = 'options {\n\tlisten-on { };\n};\n';
    expect(readListenOn()).toEqual(['127.0.0.1']);
  });

  it('ignores entries that are not addresses, such as BIND keywords', () => {
    // `listen-on { any; }` and `port` forms are legal BIND that this module
    // does not manage; returning them as addresses would have callers merge a
    // keyword into an address list and write it back as one.
    stored = 'options {\n\tlisten-on { any; 10.0.1.178; };\n};\n';
    expect(readListenOn()).toEqual(['10.0.1.178']);
  });

  it('creates the options block when the file has none', () => {
    // The fallback path: a named.conf.options that exists but holds only
    // comments must end up with a loadable options{} block, not a bare line.
    stored = '// nothing here yet\n';
    writeListenOn(['10.0.1.178']);
    expect(stored).toMatch(/options\s*\{/);
    expect(readListenOn()).toEqual(['127.0.0.1', '10.0.1.178']);
  });
});

describe('forwarders', () => {
  it('round-trips, and replaces rather than merges', () => {
    // Unlike listen-on there is no address that must always survive: the DNS
    // page owns this list outright, so a write is the new list.
    stored = BOTH;
    writeForwarders(['8.8.8.8', '8.8.4.4']);
    expect(readForwarders()).toEqual(['8.8.8.8', '8.8.4.4']);
  });

  it('is empty, not defaulted, when nothing is configured', () => {
    stored = 'options {\n\trecursion yes;\n};\n';
    expect(readForwarders()).toEqual([]);
    expect(stored).toBeTruthy();
  });

  it('writes an empty list without emitting a malformed block', () => {
    stored = BOTH;
    writeForwarders([]);
    expect(readForwarders()).toEqual([]);
    expect(stored).toContain('forwarders {  };');
  });
});

describe('this file is the only writer', () => {
  it('writes nowhere except named.conf.options', () => {
    // The ownership rule, asserted mechanically. A module that reached for the
    // zone files or named.conf.local from here would show up as a second path.
    stored = BOTH;
    writeListenOn(['10.0.1.200']);
    writeForwarders(['8.8.8.8']);
    expect(new Set(writes)).toEqual(new Set([OPTIONS_PATH]));
  });

  it('does not write at all on a read', () => {
    stored = BOTH;
    readListenOn();
    readForwarders();
    expect(writes).toEqual([]);
  });
});
