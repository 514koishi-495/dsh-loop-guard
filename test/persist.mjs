/**
 * 跨重启记账的端到端测试。
 *
 * 必须分两次进程跑，因为账本是模块级的：一次进程里只能干净地测「写」或「读」。
 *
 *   node test/persist.mjs write   # 充一笔钱 → 盘上必须出现这笔数
 *   node test/persist.mjs read    # 盘上先有 9.5 亿 → 恢复后必须据此硬停手
 *
 * 只写数字，不写任何对话内容。
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const mode = process.argv[2] ?? 'read';
const STATE = fileURLToPath(new URL('./.persist-state.json', import.meta.url));

const results = [];
const check = (label, ok, extra = '') => results.push([ok ? 'PASS' : 'FAIL', label, extra]);



if (mode === 'write') {
	fs.rmSync(STATE, { force: true });
	process.env.DSH_LOOP_GUARD_STATE_FILE = STATE;
	delete process.env.DSH_LOOP_GUARD_NO_PERSIST;
} else {
	fs.writeFileSync(
		STATE,
		JSON.stringify({
			version: 1,
			savedAt: new Date().toISOString(),
			sessions: { 'persist-root': { totalInput: 950_000_000, output: 0, requests: 10, modelCalls: 10, toolCalls: 0, turn: 10 } }
		}),
		'utf8'
	);
	process.env.DSH_LOOP_GUARD_STATE_FILE = STATE;
	delete process.env.DSH_LOOP_GUARD_NO_PERSIST;
}

const mod = await import(new URL('../lib/index.js', import.meta.url).href);

const handlers = new Map();
const logs = [];
const ctx = {
	on(event, fn) {
		if (!handlers.has(event)) handlers.set(event, []);
		handlers.get(event).push(fn);
	},
	logger: { info: (m) => logs.push(['info', m]), warn: (m) => logs.push(['warn', m]) }
};
mod.apply(ctx, {});

const pre = handlers.get('tools/pre-execute')[0];
const onEvent = handlers.get('session/event')[0];
const session = { id: 'persist-root' };
const next = async () => ({ kind: 'ok' });
const call = (path) => pre({ name: 'read', arguments: { file_path: path }, agent: { session } }, next);

if (mode === 'write') {
	check('启动时没有存档可恢复', logs.every(([, text]) => !text.includes('从磁盘恢复')));
	onEvent(session, {
		type: 'assistant/chunk',
		data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 50_000_000, outputTokens: 0 } } }
	});
	check('充钱之后盘上立刻有了存档', fs.existsSync(STATE));
	const saved = JSON.parse(fs.readFileSync(STATE, 'utf8'));
	check('存档版本号是 1', saved.version === 1);
	check('存档里记下了这一笔 5000 万', saved.sessions?.['persist-root']?.totalInput === 50_000_000, JSON.stringify(saved.sessions?.['persist-root']));
	check('存档里没有对话正文（只有数字）', !JSON.stringify(saved).includes('usage'));
	fs.rmSync(STATE, { force: true });
} else {
	check('启动日志报出恢复了 1 个会话', logs.some(([, text]) => text.includes('已从磁盘恢复 1 个会话')));
	check('恢复后 9.5 亿还没到 10 亿，照常放行', (await call('x'))?.kind !== 'deny');
	onEvent(session, {
		type: 'assistant/chunk',
		data: { turn: 11, step: 1, chunk: { type: 'usage', usage: { inputTokens: 90_000_000, outputTokens: 0 } } }
	});
	const after = await call('y');
	check(
		'历史 9.5 亿 + 本轮 0.9 亿 → 会话预算拦下',
		after?.kind === 'deny' && after.info.code === 'LOOP_GUARD_SESSION_BUDGET',
		`${after?.kind}/${after?.info?.code ?? '-'}`
	);
	fs.rmSync(STATE, { force: true });
}

let failed = 0;
for (const [status, label, extra] of results) {
	if (status === 'FAIL') failed += 1;
	console.log(`${status}  ${label}${extra === '' ? '' : `   [${extra}]`}`);
}
console.log(`[persist/${mode}] 通过 ${results.length - failed}/${results.length}`);
process.exit(failed === 0 ? 0 : 1);
