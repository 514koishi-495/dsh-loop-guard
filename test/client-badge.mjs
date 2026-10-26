import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
let declaration;
const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
vm.runInNewContext(source, { window: { __ModuleLoader__: { load(value) { declaration = value; } } }, Object, Number });
let seeds;
const jsx = (type, props, key) => ({ type, props, key });
const react = { createElement: (type, props, ...children) => ({ type, props, children }), useState: () => [seeds.shift(), () => {}], useEffect() {} };
const client = declaration.factory(name => name === 'react' ? react : { jsx, jsxs: jsx });
for (const turn of [0, 4]) {
  const usage = client.readUsage({ ok: true, session: { totalInput: 500, turn }, turn: { total: 200 }, tripped: {} });
  assert.equal(usage.turnNo, turn);
  seeds = [{ sessionId: 'test', data: usage }, false];
  const tree = client.LoopGuardUsageBadge({ sessionId: 'test' });
  assert.equal(tree.type, 'details');
  const text = JSON.stringify(tree);
  if (turn === 4) assert(text.includes('第 4 轮'));else assert(!text.includes('第 0 轮'));
}
console.log('PASS: local turn indicator preserved inside the new expandable budget badge');
