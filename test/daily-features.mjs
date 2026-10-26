import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { DailyLedger, createGuardFeatures, handleFeatureRequest } from '../lib/daily-features.js';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-daily-test-'));
try {
  let now = Date.parse('2026-10-27T15:59:00Z');
  const file = path.join(directory, 'daily.json');
  const options = { file, now: () => now, timeZone: 'Asia/Shanghai' };
  const ledger = new DailyLedger(options); ledger.setLimit(1000);
  ledger.record({ id: 'parent', seq: 1, input: 600, cached: 400, uncached: 200, output: 10, cost: .1 });
  ledger.record({ id: 'child', seq: 1, input: 500, cached: 200, uncached: 300, output: 5, cost: .2, child: true });
  assert.equal(ledger.snapshot().totalInput, 1100); assert.equal(ledger.tripped(), true);
  assert.equal(ledger.record({ id: 'parent', seq: 1, input: 600 }), false);
  const restarted = new DailyLedger(options);
  assert.equal(restarted.snapshot().totalInput, 1100);assert.equal(restarted.tripped(), true);
  assert.equal(restarted.record({ id: 'child', seq: 1, input: 500 }), false);
  assert.equal(restarted.snapshot().ranking[1].label.startsWith('子代理'), true);
  now += 120000; assert.equal(restarted.snapshot().day, '2026-10-28'); assert.equal(restarted.tripped(), false);
  assert.equal(restarted.snapshot().totalInput, 0);
  const hiddenCost = new DailyLedger({ persist: false, costEnabled: false });
  assert.equal(Object.hasOwn(hiddenCost.snapshot(), 'estimatedCostCny'), false);
  for (let index = 0; index < 505; index++) hiddenCost.record({ id: String(index), input: 1 });
  assert.equal(hiddenCost.snapshot().totalInput, 505);assert(Object.keys(hiddenCost.today().rows).length <= 500);

  const features = createGuardFeatures({ persist: false });
  const verdict = { kind: 'deny', info: { code: 'LOOP_GUARD_REPEAT' }, reason: 'secret command must not be stored' };
  features.recordCall('session', 'read', verdict);features.recordCall('session', 'read', verdict);
  assert.equal(features.snapshot('session').notices.length, 1);assert.equal(features.snapshot('session').notices[0].count, 2);
  assert(!JSON.stringify(features.snapshot()).includes('secret command'));
  assert.equal(features.hub.paused('session').blocked, true);
  features.recordCall('session', 'update_goal', undefined, true);assert.equal(features.hub.paused('session').blocked, true);
  features.humanTurn('session');assert.equal(features.hub.paused('session').blocked, false);
  async function request(method, origin, body, target = '/api/loop-guard/daily-limit') {
    const req = Object.assign(Readable.from([JSON.stringify(body)]), { method, url: target, headers: { host: 'localhost:1234', origin, 'content-type': 'application/json' } });
    let result;const res = { setHeader() {}, end(value) { result = { status: this.statusCode, body: JSON.parse(value) }; } };
    await handleFeatureRequest(req, res, features);return result;
  }
  assert.equal((await request('POST', 'https://evil.invalid', { limit: 10 })).status, 403);
  assert.equal((await request('POST', 'http://localhost:1234', { limit: 10 })).status, 200);
  assert.equal((await request('POST', 'http://localhost:1234', { limit: -1 })).status, 400);
  assert.equal((await request('GET', 'http://localhost:1234', {}, '/api/loop-guard/details')).body.ok, true);
  console.log('PASS: cross-session totals, child deduplication, restart persistence, local midnight, bounds, cost toggle, explanation privacy, notice deduplication, retry pause state, same-origin settings');
} finally {
  if (!path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('Unsafe cleanup path');
  fs.rmSync(directory, { recursive: true, force: true });
}
