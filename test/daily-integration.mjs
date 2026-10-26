import assert from 'node:assert/strict';
process.env.DSH_LOOP_GUARD_NO_PERSIST = '1';process.env.DSH_LOOP_GUARD_LOG = '0';
const { apply } = await import('../lib/index.js');
const handlers = new Map(), routes = [];
apply({ on(name, handler) { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(handler); }, logger: { info() {}, warn() {} }, webServer: { register(route) { routes.push(route); return () => {}; } } }, { persist: 0, cost: 0, maxTokens: 0, sessionMaxTokens: 0, familyMaxTokens: 0, dailyMaxTokens: 1000 });
const parent = { id: 'integration-parent' }, child = { id: 'integration-child', header: { origin: 'subagent', parentSession: parent.id }, snapshotEvents: () => [{ type: 'assistant/chunk', data: { turn: 1, chunk: { type: 'usage', usage: { inputTokens: 50000 } } } }] };
const event = (session, input, seq) => handlers.get('session/event')[0](session, { seq, type: 'assistant/chunk', data: { turn: 1, chunk: { type: 'usage', usage: { inputTokens: input, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 } } } });
handlers.get('session/created')[0](child);event(parent, 400, 1);event(child, 700, 2);
async function get(route, url) {
  let body;const res = { setHeader() {}, end(text) { body = JSON.parse(text); } };
  await routes.find(item => item.path === route).handler({ method: 'GET', url, headers: {} }, res);return body;
}
const details = await get('/api/loop-guard/details', '/api/loop-guard/details?sessionId=' + child.id);
assert.equal(details.daily.totalInput, 1100);assert.equal(details.daily.tripped, true);
const pre = handlers.get('tools/pre-execute')[0];let executed = 0;
for (let index = 0; index < 6; index++) assert.equal((await pre({ name: 'pwsh', arguments: { command: 'mock' }, agent: { session: child } }, async () => { executed++; })).info.code, 'LOOP_GUARD_DAILY_BUDGET');
assert.equal(executed, 0);
await pre({ name: 'update_goal', agent: { session: child } }, async () => { executed++; });assert.equal(executed, 1);
const paused = globalThis[Symbol.for('dsh.loopGuard.state.v1')].paused(parent.id);assert.equal(paused.blocked, true);
const after = await get('/api/loop-guard/details', '/api/loop-guard/details?sessionId=' + child.id);
assert.equal(after.notices.length, 1);assert.equal(after.notices[0].count, 6);
assert.equal((await get('/api/loop-guard/usage', '/api/loop-guard/usage?sessionId=' + child.id)).session.toolCalls, 1);
console.log('PASS: historical replay excluded, parent/child counted once, daily work blocked without false tool counts, settlement remains available, one coordinated notice');
