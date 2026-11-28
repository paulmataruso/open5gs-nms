import * as fs from 'fs';
import * as path from 'path';
import { serverSystemdUnit, shellQuote } from '../twamp-controller';
import {
  TWAMP_SERVER_BIN,
  TWAMP_SERVER_METRICS_ADDR,
  TWAMP_SERVER_LIGHT_PEERS_ADDR,
} from '../../../application/use-cases/twamp/twamp-runner';

/**
 * The TWAMP reflector is configured entirely through its systemd ExecStart
 * line: there is no config file, so every setting is a command-line flag and
 * the only thing standing between the UI and a working reflector is that the
 * flags the controller writes are flags the Go binary declares.
 *
 * Two couplings here are currently held together by comments alone.
 *
 * The controller never passes -metrics-addr or -light-peers-addr, so the
 * binary binds its own defaults while the Node side scrapes
 * TWAMP_SERVER_METRICS_ADDR and TWAMP_SERVER_LIGHT_PEERS_ADDR. Both constants
 * carry a comment saying they match the Go defaults. Nothing enforces it, and
 * editing either side leaves the Info & Stats page and the connected-clients
 * list silently empty -- on a Light-only reflector, which is this
 * deployment's real configuration, the peers address is the ONLY source of
 * connected clients, because connectionless UDP gives `ss` no TCP connection
 * to find.
 *
 * And bool flags must use `=`. Go's flag package does not let a bool flag
 * consume the following token, so `-full-enabled false` parses as
 * `-full-enabled=true` and then aborts flag parsing on the stray `false`,
 * silently dropping -modes, -secrets and -allow-cidrs with it. Confirmed live
 * 2026-08-24: a saved config with the full protocol explicitly disabled still
 * started the TCP listener.
 *
 * The ExecStart quoting is deliberately the POSIX shell idiom even though
 * systemd never invokes a shell. That is correct, verified directly against
 * systemd's own parser on this host rather than assumed: given
 * `'ab'\''cd'`, `systemctl show -p ExecStart` reported argv as `ab'cd`,
 * byte-identical to the shell's own parse.
 */

const GO_SERVER = fs.readFileSync(
  path.resolve(__dirname, '../../../config/twamp-templates/twamp-server.go'),
  'utf-8',
);
const CONTROLLER = fs.readFileSync(path.resolve(__dirname, '../twamp-controller.ts'), 'utf-8');

/** Flags the Go program declares, with their defaults. */
export function goFlags(src: string): Record<string, { type: 'string' | 'bool'; def: string }> {
  const out: Record<string, { type: 'string' | 'bool'; def: string }> = {};
  for (const m of src.matchAll(/flag\.(String|Bool)\(\s*"([^"]+)"\s*,\s*("([^"]*)"|true|false)/g)) {
    out[m[2]] = { type: m[1] === 'Bool' ? 'bool' : 'string', def: m[4] ?? m[3] };
  }
  return out;
}

/** Flag names the controller writes into ExecStart, however they are spelled. */
export function emittedFlags(src: string): string[] {
  const block = src.slice(src.indexOf('const execArgsParts'), src.indexOf('serverSystemdUnit(execArgsParts'));
  expect(block.length).toBeGreaterThan(200);
  return Array.from(new Set(Array.from(block.matchAll(/'-([a-z-]+)'|`-([a-z-]+)=/g), (m) => m[1] ?? m[2])));
}

const FLAGS = goFlags(GO_SERVER);
const EMITTED = emittedFlags(CONTROLLER);

describe('TWAMP reflector flag agreement', () => {
  it('reads a real flag table out of the Go source', () => {
    // Vacuity guard: a regex that matched nothing would make every
    // subset assertion below pass trivially.
    expect(Object.keys(FLAGS).length).toBeGreaterThanOrEqual(9);
    expect(FLAGS['listen']).toEqual({ type: 'string', def: ':862' });
  });

  it('finds the flags the controller actually emits', () => {
    expect(EMITTED.length).toBeGreaterThanOrEqual(6);
  });

  it('emits only flags the binary declares', () => {
    // A rename on either side lands here. Go does not error on an unknown
    // flag -- it exits non-zero with a usage dump, so with Restart=on-failure
    // the unit crash-loops every 5s instead of failing visibly once.
    const undeclared = EMITTED.filter((f) => !(f in FLAGS));
    expect(undeclared).toEqual([]);
  });

  it('passes the bool flags with = and never space-separated', () => {
    for (const name of Object.keys(FLAGS).filter((f) => FLAGS[f].type === 'bool')) {
      if (!EMITTED.includes(name)) continue;
      expect(CONTROLLER).toContain(`\`-${name}=\${`);
      expect(CONTROLLER).not.toMatch(new RegExp(`'-${name}',`));
    }
  });

  it('leaves the two scraped addresses to the binary, and agrees on them', () => {
    // The controller must NOT pass these -- and because it does not, the Node
    // constants have to equal the Go defaults exactly.
    expect(EMITTED).not.toContain('metrics-addr');
    expect(EMITTED).not.toContain('light-peers-addr');
    expect(TWAMP_SERVER_METRICS_ADDR).toBe(FLAGS['metrics-addr'].def);
    expect(TWAMP_SERVER_LIGHT_PEERS_ADDR).toBe(FLAGS['light-peers-addr'].def);
  });

  it('keeps the light reflector on the same address as the full one', () => {
    // -light-listen is left unset so the UDP reflector inherits -listen.
    // Passing it would mean two addresses for an operator to keep in step.
    expect(EMITTED).not.toContain('light-listen');
    expect(FLAGS['light-listen'].def).toBe('');
  });

  it('scrapes loopback only for both internal endpoints', () => {
    for (const addr of [TWAMP_SERVER_METRICS_ADDR, TWAMP_SERVER_LIGHT_PEERS_ADDR]) {
      expect(addr.startsWith('127.0.0.1:')).toBe(true);
    }
    expect(TWAMP_SERVER_METRICS_ADDR).not.toBe(TWAMP_SERVER_LIGHT_PEERS_ADDR);
  });
});

describe('serverSystemdUnit', () => {
  const unit = serverSystemdUnit("-listen '0.0.0.0:862' -full-enabled=false -light-enabled=true");

  it('runs the reflector binary in the foreground', () => {
    // The Go binary never daemonises; Type=forking would leave systemd
    // waiting for a fork that never comes and time the unit out.
    expect(unit).toContain('Type=simple');
    expect(unit).not.toMatch(/Type=(forking|oneshot)/);
    expect(unit).toContain(`ExecStart=${TWAMP_SERVER_BIN} `);
  });

  it('restarts on failure, after the network is up', () => {
    // A listener started before the network has an address to bind fails
    // outright, so the ordering is load-bearing rather than decorative.
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toMatch(/RestartSec=\d+/);
    expect(unit).toContain('After=network.target');
    expect(unit).toContain('WantedBy=multi-user.target');
  });

  it('puts the args on the ExecStart line unaltered', () => {
    expect(unit).toContain("-full-enabled=false -light-enabled=true");
  });
});

describe('shellQuote', () => {
  it('keeps a value with spaces or metacharacters as one argument', () => {
    expect(shellQuote('0.0.0.0:862')).toBe("'0.0.0.0:862'");
    expect(shellQuote('a b')).toBe("'a b'");
    expect(shellQuote('x; rm -rf /')).toBe("'x; rm -rf /'");
    expect(shellQuote('$(id)')).toBe("'$(id)'");
  });

  it('escapes an embedded single quote the way systemd parses it back', () => {
    // Verified against systemd's real ExecStart parser on this host: this
    // exact output came back as argv `ab'cd`.
    expect(shellQuote("ab'cd")).toBe("'ab'\\''cd'");
  });

  it('never leaves a bare quote that would split the argument', () => {
    for (const raw of ["it's", "a'b'c", "''", "'"]) {
      const quoted = shellQuote(raw);
      expect(quoted.startsWith("'")).toBe(true);
      expect(quoted.endsWith("'")).toBe(true);
      // Every interior quote is part of the '\'' escape, never alone.
      expect(quoted.slice(1, -1).replace(/'\\''/g, '')).not.toContain("'");
    }
  });
});
