#!/usr/bin/env node
// open5gs-nms API regression harness — entry point.
//
// Usage:
//   node run.mjs [--base-url http://localhost:3001] [--username admin] [--password admin]
//                [--only module1,module2] [--out report.json]
//
// Designed to run against ANY open5gs-nms instance: no assumptions beyond
// "the REST API is reachable at --base-url and admin/admin (or whatever
// credentials you pass) logs in." No npm install needed — Node 18+'s
// built-in fetch is the only runtime dependency.
//
// Every test module is self-contained and declares its own list of cases.
// A case that touches live config MUST register its own undo on the shared
// revertQueue before (or atomically with) making the change — see
// lib/test-case.mjs and any existing modules/*.mjs for the pattern. The
// runner drains the revert queue in a `finally`, so even a hard crash
// partway through still attempts to clean up everything queued so far.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { ApiClient } from './lib/client.mjs';
import { Report } from './lib/report.mjs';
import { RevertQueue } from './lib/revert-queue.mjs';
import { runCase } from './lib/test-case.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = {
    baseUrl: 'http://localhost:3001',
    username: 'admin',
    password: 'admin',
    only: null,
    includeDisruptive: false,
    out: path.join(__dirname, 'reports', `report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base-url') args.baseUrl = argv[++i];
    else if (a === '--username') args.username = argv[++i];
    else if (a === '--password') args.password = argv[++i];
    else if (a === '--only') args.only = argv[++i].split(',').map(s => s.trim());
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--include-disruptive') args.includeDisruptive = true;
    else if (a === '--help' || a === '-h') {
      console.log(fs.readFileSync(path.join(__dirname, 'README.md'), 'utf-8'));
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a} (use --help)`);
      process.exit(2);
    }
  }
  return args;
}

async function loadModules(dir, only) {
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.test.mjs')).sort();
  const modules = [];
  for (const f of files) {
    const mod = await import(path.join(dir, f));
    if (!mod.MODULE || !Array.isArray(mod.CASES)) {
      console.error(`⚠️  Skipping ${f}: must export MODULE (string) and CASES (array)`);
      continue;
    }
    if (only && !only.includes(mod.MODULE)) continue;
    modules.push(mod);
  }
  return modules;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const client = new ApiClient(args.baseUrl);
  const report = new Report();
  const revertQueue = new RevertQueue(report);

  console.log(`open5gs-nms API regression suite`);
  console.log(`Target: ${args.baseUrl}`);
  if (args.includeDisruptive) {
    console.log(`⚠️  --include-disruptive is ON: tests that restart live, always-on core NFs WILL run.`);
  }

  try {
    const user = await client.login(args.username, args.password);
    console.log(`Logged in as ${user?.username ?? args.username} (role: ${user?.role ?? 'unknown'})`);
  } catch (err) {
    console.error(`FATAL: could not log in — ${err.message}`);
    console.error('Nothing was changed on the target; exiting without running any test cases.');
    process.exit(1);
  }

  const modulesDir = path.join(__dirname, 'modules');
  const modules = await loadModules(modulesDir, args.only);
  if (modules.length === 0) {
    console.error('No test modules matched — nothing to run.');
    process.exit(1);
  }
  console.log(`Loaded ${modules.length} test module(s): ${modules.map(m => m.MODULE).join(', ')}`);

  try {
    const runCtx = { includeDisruptive: args.includeDisruptive };
    for (const mod of modules) {
      for (const testCase of mod.CASES) {
        await runCase(report, client, revertQueue, runCtx, {
          module: mod.MODULE,
          name: testCase.name,
          fn: testCase.run,
          disruptive: testCase.disruptive === true,
        });
      }
    }
  } finally {
    // Runs even if something above threw past runCase's own try/catch
    // (e.g. a bug in the loop itself, not a test case) — reverting whatever
    // *did* get queued is strictly better than leaving it all live.
    if (revertQueue.pending > 0) {
      console.log(`\nReverting ${revertQueue.pending} change(s)...`);
      await revertQueue.drainAll();
    }
  }

  report.print();
  report.writeJson(args.out);

  const s = report.summary();
  process.exit(s.fail > 0 || s.error > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('FATAL: unhandled error in the harness itself (not a test case):', err);
  process.exit(1);
});
