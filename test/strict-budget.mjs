import assert from 'node:assert/strict';
process.env.DSH_LOOP_GUARD_NO_PERSIST = '1';
process.env.DSH_LOOP_GUARD_LOG = '0';
const mod = await import('../lib/index.js');
function harness(id, config = {}) {
  const handlers = new Map();
  const ctx = { on(event, fn) { if (!handlers.has(event)) handlers.set(event, []); handlers.get(event).push(fn); }, logger: { info() {}, warn() {} } };
  mod.apply(ctx, { persist: 0, log: 0, maxTokens: 0, sessionMaxTokens: 0, familyMaxTokens: 0, ...config });
  const session = { id };
  return {
    charge(turn = 1) { handlers.get('session/event')[0](session, { type: 'assistant/chunk', data: { turn, step: 1, chunk: { type: 'usage', usage: { inputTokens: 101, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } } } }); },
    call(i, name = 'read') { return handlers.get('tools/pre-execute')[0]({ name, arguments: { file_path: `file-${i}.txt`, command: `echo ${i}` }, agent: { session } }, async () => ({ kind: 'ok' })); },
  };
}
for (const [field, code] of [['maxTokens', 'LOOP_GUARD_BUDGET_EXHAUSTED'], ['sessionMaxTokens', 'LOOP_GUARD_SESSION_BUDGET'], ['familyMaxTokens', 'LOOP_GUARD_FAMILY_BUDGET']]) {
  const h = harness('strict-' + field, { strictBudget: 1, [field]: 100 });h.charge();
  for (let i = 0; i < 9; i++) assert.equal((await h.call(i))?.info?.code, code);
  assert.notEqual((await h.call(10, 'update_goal'))?.kind, 'deny');
  assert.notEqual((await h.call(11, ''))?.kind, 'deny');
}
const soft = harness('strict-soft', { strictBudget: 1, softLanding: 1, maxTokens: 100 });soft.charge();
for (let i = 0; i < 9; i++) assert.equal((await soft.call(i, 'pwsh'))?.info?.code, 'LOOP_GUARD_SOFT_LANDING');
const legacy = harness('legacy-budget', { maxTokens: 100 });legacy.charge();
for (let i = 0; i < 3; i++) assert.equal((await legacy.call(i))?.kind, 'deny');
assert.notEqual((await legacy.call(3))?.kind, 'deny');
console.log('PASS: strict turn/session/family budgets, strict soft landing, settlement whitelist, text output, unchanged default escape');
