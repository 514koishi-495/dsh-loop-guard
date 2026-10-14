/**
 * 跨重启记账的端到端测试。
 *
 * 必须分两次进程跑，因为账本是模块级的：一次进程里只能干净地测「写」或「读」。
 *
 *   node test/persist.mjs write   # 充一笔钱 → 盘上必须出现这笔数
 *   node test/persist.mjs read    # 盘上先有 9.5 亿 → 恢复后必须据此硬停手
 *   node test/persist.mjs migrate # 盘上版本号对不上 → 按已知字段迁移，不许整份丢弃
 *
 * 只写数字，不写任何对话内容。
 *
 * env 必须在下面那个动态 import 之前设置：账本与日志路径都是模块加载时读的，
 * 在 import 之后赋值是死代码（这条踩过一次，别改回去）。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mode = process.argv[2] ?? 'read';
const STATE = fileURLToPath(new URL('./.persist-state.json', import.meta.url));
const LOG = fileURLToPath(new URL('./.persist-log.log', import.meta.url));

// 真账本 / 真日志的基线：跑完必须一字节不差。日志这条尤其要紧 —— 守卫的日志默认是
// 开的，不把 LOG_FILE 指到 test/ 下，这个脚本的「会话预算用尽」「存档版本迁移」这些
// warn 会原样写进用户自己的 ~/.dsh/loop-guard.log（踩过一次）。
const REAL_STATE = path.join(os.homedir(), '.dsh', 'loop-guard-state.json');
const REAL_LOG = path.join(os.homedir(), '.dsh', 'loop-guard.log');
const sha256 = (file) => (fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : '<absent>');
const realStateBefore = sha256(REAL_STATE);
const realLogBefore = sha256(REAL_LOG);

process.env.DSH_LOOP_GUARD_LOG_FILE = LOG;

const results = [];
const check = (label, ok, extra = '') => results.push([ok ? 'PASS' : 'FAIL', label, extra]);



if (mode === 'write') {
	fs.rmSync(STATE, { force: true });
	process.env.DSH_LOOP_GUARD_STATE_FILE = STATE;
	delete process.env.DSH_LOOP_GUARD_NO_PERSIST;
} else if (mode === 'migrate') {
	// 版本号对不上（旧版本写的、或将来别人升级过）：必须按已知字段尽力迁移。
	// 丢掉的不是格式，是「这个会话已经花掉多少钱」这个事实 —— 丢了预算门就等于没有。
	fs.writeFileSync(
		STATE,
		JSON.stringify({
			version: 0,
			savedAt: new Date().toISOString(),
			sessions: {
				'persist-root': {
					totalInput: 950_000_000,
					familyInput: 999_999_999,
					output: 1,
					requests: 10,
					modelCalls: 10,
					toolCalls: 0,
					turn: 12
				}
			}
		}),
		'utf8'
	);
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
} else if (mode !== 'migrate') {
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
} else if (mode === 'migrate') {
	const migrated = logs.filter(([, text]) => text.includes('迁移') && text.includes('版本'));
	check(
		'版本不匹配时打一条「迁移」warn，而不是整份丢弃',
		migrated.length > 0,
		logs.map(([, t]) => t).join(' | ').slice(0, 200)
	);
	check('迁移保留了 totalInput：9.5 亿还在，没到 10 亿时照常放行', (await call('m1'))?.kind !== 'deny');
	onEvent(session, {
		type: 'assistant/chunk',
		data: { turn: 13, step: 1, chunk: { type: 'usage', usage: { inputTokens: 90_000_000, outputTokens: 0 } } }
	});
	const after = await call('m2');
	check(
		'迁移保留了历史：9.5 亿 + 0.9 亿 → 会话预算拦下',
		after?.kind === 'deny' && after.info.code === 'LOOP_GUARD_SESSION_BUDGET',
		`${after?.kind}/${after?.info?.code ?? '-'}`
	);
	const saved2 = JSON.parse(fs.readFileSync(STATE, 'utf8'));
	check('迁移后写回的是当前版本号 1', saved2.version === 1, String(saved2.version));
	check(
		'familyInput 与 turn 一起活了下来（下次写盘仍是它们）',
		saved2.sessions?.['persist-root']?.familyInput === 999_999_999 && saved2.sessions?.['persist-root']?.turn === 13,
		JSON.stringify(saved2.sessions?.['persist-root'])
	);
	fs.rmSync(STATE, { force: true });
}

// 真账本 / 真日志隔离：这个脚本会主动把预算烧到线上、还会写一份版本对不上的存档，
// 两者都会让守卫记 warn —— 那些 warn 只能落在 test/ 下的临时日志里。
check(`测试全程没有写/改真账本（${REAL_STATE}）`, sha256(REAL_STATE) === realStateBefore, realStateBefore);
check(`测试全程没有写/改真日志（${REAL_LOG}）`, sha256(REAL_LOG) === realLogBefore, realLogBefore);

// 自己的临时文件也收掉（状态文件各分支里删过，这里连同临时日志一起收尾）。
fs.rmSync(LOG, { force: true });
fs.rmSync(STATE, { force: true });

let failed = 0;
for (const [status, label, extra] of results) {
	if (status === 'FAIL') failed += 1;
	console.log(`${status}  ${label}${extra === '' ? '' : `   [${extra}]`}`);
}
console.log(`[persist/${mode}] 通过 ${results.length - failed}/${results.length}`);
process.exit(failed === 0 ? 0 : 1);
