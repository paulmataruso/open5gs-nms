import fs from 'node:fs';
import path from 'node:path';

// STATUS values, in order of severity for sorting/printing:
//   pass    - change made, verified via an independent read-back, reverted cleanly.
//   skipped - module not installed/enabled on this instance (not a failure).
//   fail    - the product did something wrong (change didn't take, or the
//             verified value didn't match what was sent).
//   error   - the test case itself blew up (network error, unexpected
//             response shape, thrown exception) — may be a real product bug
//             or a bug in the test case; the critic pass is what tells these
//             apart from genuine `fail`s, so keep them as a separate bucket
//             rather than collapsing into `fail`.
const STATUS_ORDER = { error: 0, fail: 1, skipped: 2, pass: 3 };

export class Report {
  constructor() {
    this.results = [];
    this.startedAt = new Date().toISOString();
  }

  record({ module, name, status, detail, evidence }) {
    if (!STATUS_ORDER.hasOwnProperty(status)) {
      throw new Error(`Invalid report status "${status}" for ${module}/${name}`);
    }
    this.results.push({
      module, name, status, detail: detail ?? null, evidence: evidence ?? null,
      ts: new Date().toISOString(),
    });
  }

  revertOk(label) {
    this.reverts ??= [];
    this.reverts.push({ label, ok: true });
  }

  revertFailed(label, err) {
    this.reverts ??= [];
    this.reverts.push({ label, ok: false, error: String(err?.stack || err) });
  }

  summary() {
    const counts = { pass: 0, fail: 0, error: 0, skipped: 0 };
    for (const r of this.results) counts[r.status]++;
    return counts;
  }

  print() {
    const byModule = {};
    for (const r of this.results) {
      (byModule[r.module] ??= []).push(r);
    }
    for (const [mod, cases] of Object.entries(byModule)) {
      console.log(`\n=== ${mod} ===`);
      for (const c of cases.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status])) {
        const icon = { pass: '✅', fail: '❌', error: '💥', skipped: '⏭️ ' }[c.status];
        console.log(`  ${icon} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
      }
    }
    const s = this.summary();
    console.log(
      `\n${'─'.repeat(60)}\nTOTAL: ${this.results.length}  ` +
      `pass=${s.pass}  fail=${s.fail}  error=${s.error}  skipped=${s.skipped}`,
    );
    if (this.reverts?.length) {
      const failedReverts = this.reverts.filter(r => !r.ok);
      console.log(`Revert queue: ${this.reverts.length} actions, ${failedReverts.length} failed`);
      for (const r of failedReverts) {
        console.log(`  ⚠️  REVERT FAILED: ${r.label} — ${r.error}`);
      }
    }
  }

  writeJson(filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
      summary: this.summary(),
      results: this.results,
      reverts: this.reverts ?? [],
    }, null, 2));
    console.log(`\nFull report written to ${filePath}`);
  }
}
