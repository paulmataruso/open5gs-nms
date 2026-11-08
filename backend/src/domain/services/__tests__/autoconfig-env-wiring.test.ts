import * as fs from 'fs';
import * as path from 'path';
import { MODULE_ENABLE_FLAGS } from '../autoconfig-apply';

/**
 * Auto-Configuration reads these from the BACKEND container's own env. The
 * module flags were previously passed only as frontend build args, which made
 * every flag read as absent in the backend and silently fell back to each
 * module's default instead of honouring what the operator set. Nothing failed
 * — the wrong set of modules just got installed.
 */
const REPO = path.resolve(__dirname, '../../../../..');
const compose = fs.readFileSync(path.join(REPO, 'docker-compose.yml'), 'utf-8');
const envExample = fs.readFileSync(path.join(REPO, '.env.example'), 'utf-8');

/** The backend service's own `environment:` block, not the frontend's build args. */
function backendEnvBlock(): string {
  const start = compose.indexOf('\n  backend:');
  expect(start).toBeGreaterThan(-1);
  const envStart = compose.indexOf('    environment:', start);
  expect(envStart).toBeGreaterThan(-1);
  const healthcheck = compose.indexOf('    healthcheck:', envStart);
  return compose.slice(envStart, healthcheck > -1 ? healthcheck : undefined);
}

describe('Auto-Configuration env wiring', () => {
  const AUTOCONFIG_VARS = [
    'AUTOCONFIG_ENABLED', 'AUTOCONFIG_START_IP', 'AUTOCONFIG_GW',
    'AUTOCONFIG_SUBNET', 'AUTOCONFIG_INTERFACE', 'AUTOCONFIG_SECGW_POOL_SIZE',
    'AUTOCONFIG_MODULES', 'AUTOCONFIG_SKIP_IP_CHECK',
  ];

  it.each(AUTOCONFIG_VARS)('passes %s through to the backend container', (name) => {
    expect(backendEnvBlock()).toContain(`- ${name}=\${${name}`);
  });

  it.each(AUTOCONFIG_VARS)('documents %s in .env.example', (name) => {
    expect(envExample).toMatch(new RegExp(`^${name}=`, 'm'));
  });

  it.each(MODULE_ENABLE_FLAGS.map(m => [m.flag, m.id] as const))(
    'passes %s to the backend, since modulesToInstall reads it there (module %s)',
    (flag) => {
      expect(backendEnvBlock()).toContain(`- ${flag}=\${${flag}`);
    },
  );

  it('defaults AUTOCONFIG_ENABLED to false — this binds addresses and installs software', () => {
    expect(backendEnvBlock()).toContain('- AUTOCONFIG_ENABLED=${AUTOCONFIG_ENABLED:-false}');
    expect(envExample).toMatch(/^AUTOCONFIG_ENABLED=false$/m);
  });

  it('keeps each module flag\'s compose default in step with the code\'s own default', () => {
    // A disagreement here means the backend decides one thing and the UI
    // shows another for a deployment that sets no flags at all.
    const block = backendEnvBlock();
    for (const m of MODULE_ENABLE_FLAGS) {
      expect(block).toContain(`- ${m.flag}=\${${m.flag}:-${m.defaultOn}}`);
    }
  });

  it('defaults AUTOCONFIG_MODULES to honouring the flags, not to installing everything', () => {
    expect(backendEnvBlock()).toContain('- AUTOCONFIG_MODULES=${AUTOCONFIG_MODULES:-enabled}');
  });

  it('defaults collision checking ON — skipping it is an explicit opt-out', () => {
    // Polarity matters: a default of true here would silently disable
    // duplicate detection for every deployment that sets nothing.
    expect(backendEnvBlock()).toContain('- AUTOCONFIG_SKIP_IP_CHECK=${AUTOCONFIG_SKIP_IP_CHECK:-false}');
    expect(envExample).toMatch(/^AUTOCONFIG_SKIP_IP_CHECK=false$/m);
  });
});

describe('status endpoint surfaces the delegated state', () => {
  // install-modules runs for over an hour with a full module set. Without the
  // sub-state the status endpoint says only "install-modules" for that whole
  // time, which looks identical to being stuck.
  const controller = fs.readFileSync(
    path.join(REPO, 'backend/src/interfaces/rest/autoconfig-controller.ts'), 'utf-8');
  const orchestrator = fs.readFileSync(
    path.join(REPO, 'backend/src/application/use-cases/autoconfig/autoconfig-orchestrator.ts'), 'utf-8');

  it('the status route reports the delegated run state', () => {
    expect(controller).toMatch(/active:\s*orchestrator\.getSubState\(\)/);
  });

  it('getSubState names the bootstrap during install-modules', () => {
    expect(orchestrator).toMatch(/currentPhase[\s\S]*?install-modules[\s\S]*?bootstrap: this\.bootstrap\.getRunState\(\)/);
  });

  it('getSubState reads live rather than caching, so it cannot go stale', () => {
    // The run-state objects belong to the use-cases; copying them into our own
    // state would freeze whatever they held at copy time.
    expect(orchestrator).not.toMatch(/this\.state\.bootstrap\s*=/);
  });
});

describe('dns-listen must prove DNS answers, not just write a config', () => {
  // This gates the FQDN migration, and gotcha #6 means a wrong answer here
  // crash-loops every 5GC network function at once. "We wrote a file" is not
  // evidence that a resolver is answering.
  const orch = fs.readFileSync(
    path.join(REPO, 'backend/src/application/use-cases/autoconfig/autoconfig-orchestrator.ts'), 'utf-8');

  it('reloads BIND after changing listen-on', () => {
    // A listen-on change alters which sockets named binds, so it means
    // nothing until the config is re-read. Asserted as ORDER rather than
    // proximity: the forwarders block legitimately sits between the two, and
    // a distance-based match just breaks whenever something is added.
    const wIdx = orch.indexOf('writeListenOn([...current, dnsIp])');
    const rIdx = orch.indexOf('this.reloadBind()');
    expect(wIdx).toBeGreaterThan(-1);
    expect(rIdx).toBeGreaterThan(wIdx);
  });

  it('prefers rndc reconfig over a restart, so the resolver is not dropped', () => {
    // The core's own NFs may already be resolving through it.
    expect(orch).toMatch(/rndc'?,\s*\['reconfig'\]/);
  });

  it('requires BOTH loopback and the service address to answer', () => {
    // Loopback is what the host's own resolv.conf uses; the service address
    // is what the radios and migrated NFs will use. Either one failing means
    // the migration must not run.
    expect(orch).toMatch(/dnsReady\s*=\s*onLoopback\s*&&\s*onService/);
  });

  it('never sets dnsReady from a successful file write alone', () => {
    expect(orch).not.toMatch(/writeListenOn\([^)]*\);\s*\n\s*dnsReady\s*=\s*true/);
  });

  it('gates the FQDN migration on dnsReady and SKIPS rather than attempting', () => {
    expect(orch).toMatch(/this\.phase\('fqdn-migration'\);\s*\n\s*if \(!dnsReady\)/);
    // The skipped flag matters: this is a deliberate refusal, not a crash.
    expect(orch).toMatch(/crash-loops every network function[\s\S]{0,200}?true\)/);
  });
});

describe('installs that depend on another module being CONFIGURED', () => {
  // Found live on a clean host, 2026-11-08: Asterisk-2G's install refuses with
  // "osmo-sip-connector has no concrete local SIP address configured yet"
  // because verifyGsmSipConnReady() needs GSM's Configure to have run. The
  // module bootstrap is install-only, so on a fresh host that Configure only
  // happens in configure-modules -- AFTER every install. Asterisk-2G could
  // therefore never install on a fresh deployment.
  const orch = fs.readFileSync(
    path.join(REPO, 'backend/src/application/use-cases/autoconfig/autoconfig-orchestrator.ts'), 'utf-8');

  it('retries failed installs AFTER the configure phase', () => {
    const cfgIdx = orch.indexOf("this.phase('configure-modules')");
    const retryIdx = orch.indexOf("this.phase('retry-installs')");
    expect(cfgIdx).toBeGreaterThan(-1);
    expect(retryIdx).toBeGreaterThan(cfgIdx);
  });

  it('retries before the addresses are applied', () => {
    // A module installed on retry still needs its address, so the retry has
    // to land before module-addresses rather than after it.
    expect(orch.indexOf("this.phase('retry-installs')"))
      .toBeLessThan(orch.indexOf("this.phase('module-addresses')"));
  });

  it('configures whatever installed on the retry', () => {
    // Otherwise it is installed-and-dark, which is the exact gap
    // configure-modules exists to close.
    const block = /this\.phase\('retry-installs'\)[\s\S]*?this\.phase\('module-addresses'\)/.exec(orch);
    expect(block).not.toBeNull();
    expect(block![0]).toContain('configureInstalledModules');
  });

  it('retries ONCE and reports a second failure as real', () => {
    const block = /this\.phase\('retry-installs'\)[\s\S]*?this\.phase\('module-addresses'\)/.exec(orch);
    expect(block![0]).toMatch(/still failing after a retry/);
    // No loop around the retry -- a module failing twice is a genuine failure.
    expect(block![0]).not.toMatch(/for \(|while \(/);
  });

  it('is generic, not special-cased to asterisk2g', () => {
    // The ordering is a property of the modules; a second module with this
    // shape should not need another fix here.
    const block = /this\.phase\('retry-installs'\)[\s\S]*?this\.phase\('module-addresses'\)/.exec(orch);
    expect(block![0]).not.toContain("'asterisk2g'");
    expect(block![0]).toContain('failedInstalls');
  });

  it('skips cleanly when every install succeeded', () => {
    const block = /this\.phase\('retry-installs'\)[\s\S]*?this\.phase\('module-addresses'\)/.exec(orch);
    expect(block![0]).toMatch(/No install needed retrying/);
  });
});

describe('dns-listen ensures BIND can resolve external names', () => {
  // Real failure: a `docker compose build` on a freshly auto-configured host
  // died on `lookup registry-1.docker.io on 127.0.0.1:53: server misbehaving`.
  // resolv.conf points at BIND, Ubuntu ships `forwarders` commented out, and
  // BIND's own recursion SERVFAILs on a cold cache under parallel load.
  const orch = fs.readFileSync(
    path.join(REPO, 'backend/src/application/use-cases/autoconfig/autoconfig-orchestrator.ts'), 'utf-8');

  it('sets forwarders when none are configured', () => {
    expect(orch).toMatch(/readForwarders\(\)/);
    expect(orch).toMatch(/writeForwarders\(resolvers\)/);
  });

  it('leaves existing forwarders ALONE', () => {
    // An operator who set them chose those servers; this is not the owner of
    // that decision.
    expect(orch).toMatch(/existingFwd\.length > 0[\s\S]{0,200}?left alone/);
  });

  it('excludes our own addresses from the forwarder list', () => {
    // Forwarding BIND to itself — loopback or the allocated DNS address —
    // stops resolution entirely.
    expect(orch).toContain('discoverUpstreamResolvers(plan.allAddresses)');
  });

  it('goes through bind-controller rather than writing named.conf.options itself', () => {
    // BIND is shared infrastructure with exactly one writer.
    expect(orch).not.toMatch(/named\.conf\.options['"]\s*,\s*[^)]*write/);
    expect(orch).toMatch(/from '\.\.\/\.\.\/\.\.\/interfaces\/rest\/bind-controller'/);
  });

  it('checks external resolution and reports it', () => {
    expect(orch).toContain('dnsResolvesExternally');
    expect(orch).toMatch(/external names: \$\{external \? 'yes' : 'NO'\}/);
  });

  it('does NOT gate the FQDN migration on external resolution', () => {
    // The gate protects the migration, which needs only this host's own
    // zones. An air-gapped deployment should still get its FQDNs.
    expect(orch).toMatch(/dnsReady = onLoopback && onService/);
    expect(orch).not.toMatch(/dnsReady\s*=\s*[^;]*external/);
  });

  it('warns loudly when external resolution fails, since apt and docker will break', () => {
    expect(orch).toMatch(/apt and docker pulls will fail/);
  });
});

describe('a retried install must not leave the run permanently failed', () => {
  // Measured on a clean host: install-modules failed (asterisk2g needs GSM
  // configured), retry-installs fixed it, asterisk-2g ended up installed AND
  // active — and the run still reported `failed`. That is not cosmetic:
  // canSkipBootRun() requires every phase green, so the manifest would record
  // a failed phase forever and EVERY backend restart would re-run the whole
  // hour-long sequence. On a fresh host this failure is guaranteed, so the
  // boot-skip would never once work.
  const orch = fs.readFileSync(
    path.join(REPO, 'backend/src/application/use-cases/autoconfig/autoconfig-orchestrator.ts'), 'utf-8');

  it('amends the install-modules phase when the retry resolved everything', () => {
    expect(orch).toMatch(/installPhase\.ok = true/);
    expect(orch).toMatch(/stillFailed\.length === 0 && ok\.length > 0/);
  });

  it('clears the stale run-level error too, or the run still looks failed', () => {
    // `status` is derived from the phases AND the error list.
    expect(orch).toMatch(/this\.state\.errors = this\.state\.errors\.filter\(e => !e\.startsWith\('install-modules:'\)\)/);
  });

  it('keeps the first attempt in the detail rather than pretending it was clean', () => {
    expect(orch).toMatch(/succeeded after retry-installs/);
    expect(orch).toMatch(/First attempt: \$\{was\}/);
  });

  it('does NOT amend when something is still failing', () => {
    // A module that failed twice is a real failure and must stay failed.
    const block = /if \(stillFailed\.length === 0 && ok\.length > 0\)[\s\S]*?\n        \}/.exec(orch);
    expect(block).not.toBeNull();
    expect(block![0]).toContain('installPhase.ok = true');
  });

  it('only amends a phase that actually failed', () => {
    expect(orch).toMatch(/installPhase && !installPhase\.ok/);
  });
});

describe('retry-installs judges only what it retried', () => {
  // Measured on a clean host: retry-installs was asked to retry asterisk2g
  // only. It installed it correctly (installed AND active), but the module
  // bootstrap ALWAYS runs bind9 first and ueValidation last regardless of the
  // requested list — and ueValidation reported a failure of its own, with the
  // srsRAN image in fact present. Judging every result made the phase report
  // FAIL, which stopped install-modules being amended, so the run reported
  // failed and the boot-skip stayed broken. Same end effect as the bug the
  // amendment exists to fix, reached a different way.
  const orch = fs.readFileSync(
    path.join(REPO, 'backend/src/application/use-cases/autoconfig/autoconfig-orchestrator.ts'), 'utf-8');

  it('filters the retry results to the requested modules', () => {
    expect(orch).toContain('const retried = new Set(failedInstalls)');
    expect(orch).toMatch(/getRunState\(\)\.results\.filter\(r => retried\.has\(r\.moduleId\)\)/);
  });

  it('derives both ok and stillFailed from the filtered set', () => {
    // Either one taking the unfiltered list reintroduces the bug.
    const block = /const retried = new Set\(failedInstalls\)[\s\S]{0,400}?stillFailed = now\.filter/.exec(orch);
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/const ok = now\.filter/);
  });

  it('does not judge the bootstrap\'s always-run steps', () => {
    // bind9 and ueValidation are never requested, so their outcome must not
    // decide this phase.
    const block = /this\.phase\('retry-installs'\)[\s\S]*?this\.phase\('module-addresses'\)/.exec(orch);
    expect(block).not.toBeNull();
    expect(block![0]).not.toMatch(/'ueValidation'|'bind9'/);
  });
});
