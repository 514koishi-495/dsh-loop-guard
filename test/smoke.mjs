/**
 * dsh-loop-guard 冒烟测试：不开 DSH 也能验守卫真的会拦。
 *   node test/smoke.mjs
 *
 * 每道闸门一个场景，各自一份配置、各自一组会话 id
 * （插件内部的谱系表是模块级的，所以 id 必须互不重叠）。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 测试绝不能碰真账本：真账本是给真会话用的，测试用的 id 是固定的，
// 一旦混进去，第二次跑测试就会「带着上次的余额」开始，结果飘。
// 真日志同理，而且更容易漏：守卫的日志默认就是开的，不把它指到 test/ 下，
// 测试触发出来的 warn 会原样写进用户自己的 ~/.dsh/loop-guard.log。
//
// **这三条必须在 import 之前设好。** 插件把 STATE_FILE / LOG_FILE 放在模块顶层各读一次
// （lib/index.js 的 `const STATE_FILE = process.env.DSH_LOOP_GUARD_STATE_FILE ?? …`），
// 写在 import 之后的那一行只是死代码 —— 真正兜住测试的是 apply() 时才读的
// NO_PERSIST（persist: false ⇒ 根本不落盘、也不写日志）。
const REAL_STATE = path.join(os.homedir(), '.dsh', 'loop-guard-state.json');
const REAL_LOG = path.join(os.homedir(), '.dsh', 'loop-guard.log');
const sha256 = (file) => (fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : '<absent>');
const realStateBefore = sha256(REAL_STATE);
const realLogBefore = sha256(REAL_LOG);
const SMOKE_LOG = fileURLToPath(new URL('./.smoke-log.log', import.meta.url));

process.env.DSH_LOOP_GUARD_NO_PERSIST = '1';
process.env.DSH_LOOP_GUARD_STATE_FILE = fileURLToPath(new URL('./.smoke-state.json', import.meta.url));
process.env.DSH_LOOP_GUARD_LOG_FILE = SMOKE_LOG;

const url = new URL('../lib/index.js', import.meta.url);
const mod = await import(url.href);


const KEYS = [
	'DSH_LOOP_GUARD_MAX_TOKENS',
	'DSH_LOOP_GUARD_SESSION_MAX_TOKENS',
	'DSH_LOOP_GUARD_FAMILY_MAX_TOKENS',
	'DSH_LOOP_GUARD_WARN_RATIO',
	'DSH_LOOP_GUARD_REPEAT_LIMIT',
	'DSH_LOOP_GUARD_READ_REPEAT_LIMIT',
	'DSH_LOOP_GUARD_SKELETON_LIMIT',
	'DSH_LOOP_GUARD_CYCLE_LIMIT',
	'DSH_LOOP_GUARD_SAME_ERROR_LIMIT',
	'DSH_LOOP_GUARD_MAX_DENIALS',
	'DSH_LOOP_GUARD_MAX_FANOUT',
	'DSH_LOOP_GUARD_FANOUT_TTL_MS',
	'DSH_LOOP_GUARD_MAX_WORKFLOW_AGENTS',
	'DSH_LOOP_GUARD_MAX_SUBAGENT_REQUESTS',
	'DSH_LOOP_GUARD_MAX_SUBAGENT_TOOLS',
	'DSH_LOOP_GUARD_OUTLIER_RATIO',
	'DSH_LOOP_GUARD_OUTLIER_MIN_SIBLINGS',
	'DSH_LOOP_GUARD_OUTLIER_FLOOR_TOKENS',
	'DSH_LOOP_GUARD_EMPTY_RESULT_TOKENS',
	'DSH_LOOP_GUARD_EMPTY_RESULT_OUTPUT',
	'DSH_LOOP_GUARD_MAX_BATCH_FAILURES',
	'DSH_LOOP_GUARD_VETO_NEW_TURN',
	'DSH_LOOP_GUARD_SOFT_LANDING',
	'DSH_LOOP_GUARD_OFF'
];

const results = [];
let nextCalls = 0;

function check(label, condition, extra = '') {
	results.push([condition ? 'PASS' : 'FAIL', label, extra]);
}

function clearEnv() {
	for (const key of KEYS) delete process.env[key];
}

/** 用给定环境变量武装一份守卫，返回它的各个口子。 */
function harness(env = {}) {
	clearEnv();
	for (const [key, value] of Object.entries(env)) process.env[key] = String(value);
	const handlers = new Map();
	const logs = [];
	const ctx = {
		on(event, fn) {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(fn);
		},
		logger: {
			info: (m) => logs.push(['info', m]),
			warn: (m) => logs.push(['warn', m])
		}
	};
	mod.apply(ctx, {});
	clearEnv();

	const next = async () => {
		nextCalls += 1;
		return { kind: 'ok' };
	};
	const pre = handlers.get('tools/pre-execute')?.[0];

	return {
		logs,
		pre,
		session: (id, parent) => (parent === undefined ? { id } : { id, header: { origin: 'subagent', parentSession: parent } }),
		call: (exec) => {
			if (typeof pre !== 'function') throw new Error('守卫没注册 tools/pre-execute');
			return pre(exec, next);
		},
		/** 记一笔模型请求（不依赖 usage 事件）。 */
		modelCall: (session) => handlers.get('session/event')[0](session, { type: 'assistant/message', data: {} }),
		/** 记一笔账单。 */
		charge: (session, tokens, opts = {}) =>
			handlers.get('session/event')[0](session, {
				type: 'assistant/chunk',
				data: { turn: opts.turn ?? 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: tokens, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: opts.output ?? 0 } } }
			}),
		created: (session) => handlers.get('session/created')[0](session),
		disposed: (session) => handlers.get('session/disposed')[0](session)
	};
}

const isDeny = (v, code) => v?.kind === 'deny' && (code === undefined || v.info.code === code);
const allowed = (v) => v === undefined || v.kind !== 'deny';

// ══════════════════ A. 基础：口径、重复、交账、默认不设限 ══════════════════
{
	const h = harness();
	const agent = { session: h.session('a-base') };
	const call = (name, args) => h.call({ name, arguments: args, agent });

	// 1. 计费输入 = 非缓存 + 缓存读 + 缓存写
	h.charge(h.session('a-base'), 40_000_000);
	h.charge(h.session('a-base'), 20_000_000);
	h.charge(h.session('a-base'), 5_000_000);
	check('65M 未触发预警（阈值 70M）', !h.logs.some(([, m]) => m.includes('本轮已用')));

	// 2. 正常调用放行
	const exec = { name: 'pwsh', arguments: { command: 'echo hello' }, agent };
	check('第一次调用放行', allowed(await h.call(exec)));

	// 3. 同签名重复：阈值 4，第 5 次拦
	for (let i = 0; i < 3; i += 1) await h.call(exec);
	const fifth = await h.call(exec);
	check('同签名第 5 次被拦', isDeny(fifth, 'LOOP_GUARD_REPEAT'), JSON.stringify(fifth?.info));

	// 4. 逃生门
	await h.call(exec);
	await h.call(exec);
	check('拦满 3 次后放行（不锁死 agent）', allowed(await h.call(exec)));

	// 5. 换命令 = 换签名
	check('换命令立刻放行', allowed(await call('pwsh', { command: 'echo goodbye' })));

	// 6. 预警
	h.charge(h.session('a-base'), 10_000_000);
	check('到 75M 打出预警', h.logs.some(([, m]) => m.includes('本轮已用')));

	// 7. 预算到线：硬停手 + 交账报告三要素
	h.charge(h.session('a-base'), 30_000_000);
	const tripped = await call('read', { file_path: 'C:\\whatever\\x.txt' });
	check('预算用尽后拦截', isDeny(tripped, 'LOOP_GUARD_BUDGET_EXHAUSTED'), JSON.stringify(tripped?.info));
	check('交账报告要求「已经做完」', (tripped?.reason ?? '').includes('已经做完什么'));
	check('交账报告要求「还剩什么」', (tripped?.reason ?? '').includes('还剩什么没做'));
	check('交账报告要求「建议怎么继续」', (tripped?.reason ?? '').includes('建议用户怎么继续'));
	check('预算用尽后连 read 也拦', isDeny(await call('read', { file_path: 'C:\\a\\b.txt' })));

	// 8. 换 turn = 换一次问答
	h.charge(h.session('a-base'), 1000, { turn: 2 });
	check('换新一轮问答后恢复放行', allowed(await call('read', { file_path: 'C:\\a\\b.txt' })));

	// 9. 豁免工具永不拦（真的连发 12 次，断言全部放行 —— 不能写成恒真的 `check(…, true)`）
	const todos = [];
	for (let i = 0; i < 12; i += 1) todos.push(await call('todo_write', { todos: [] }));
	check(
		'todo_write 重复 12 次也不拦',
		todos.length === 12 && todos.every(allowed),
		JSON.stringify(todos.find((v) => !allowed(v)))?.slice(0, 80)
	);

	// 10. 会话累计上限默认关闭
	for (const turn of [3, 4, 5]) h.charge(h.session('a-base'), 90_000_000, { turn });
	check('会话累计 2.7 亿也不拦（默认不设限）', allowed(await call('pwsh', { command: 'echo zzz' })));
}

// ══════════════════ B. 会话累计上限：只有设了才生效 ══════════════════
{
	const h = harness({ DSH_LOOP_GUARD_SESSION_MAX_TOKENS: 300_000_000 });
	const agent = { session: h.session('b-optin') };
	for (const turn of [1, 2, 3, 4]) h.charge(h.session('b-optin'), 80_000_000, { turn });
	const tripped = await h.call({ name: 'pwsh', arguments: { command: 'echo q' }, agent }, async () => ({ kind: 'ok' }));
	check('设成 3 亿后会话上限生效', isDeny(tripped, 'LOOP_GUARD_SESSION_BUDGET'), JSON.stringify(tripped?.info));
	check('会话用尽时劝开新会话', (tripped?.reason ?? '').includes('开新'));
}

// ══════════════════ C. 家族总预算：后代的账上卷到祖先 ══════════════════
{
	const h = harness({ DSH_LOOP_GUARD_FAMILY_MAX_TOKENS: 200_000_000 });
	const root = h.session('c-root');
	const child = h.session('c-child', 'c-root');
	// 分多轮累计到 2.8 亿：单轮谁都不碰 1 亿的本轮上限，走的才是家族闸门。
	// 根会话每轮自己也要记一笔 —— 它不说话就没有 turn，换轮清账也就无从谈起。
	for (const turn of [1, 2, 3, 4]) {
		h.charge(root, 1_000_000, { turn });
		h.charge(child, 70_000_000, { turn });
	}
	const onChild = await h.call({ name: 'read', arguments: { file_path: 'x' }, agent: { session: child } });
	check('子代理自己会看到家族总量', isDeny(onChild, 'LOOP_GUARD_FAMILY_BUDGET'), JSON.stringify(onChild?.info));
	const onRoot = await h.call({ name: 'read', arguments: { file_path: 'x' }, agent: { session: root } });
	check('父会话账本里也看得见子代理的消耗', isDeny(onRoot, 'LOOP_GUARD_FAMILY_BUDGET'), JSON.stringify(onRoot?.info));
	check('家族超限时说明是后代花的', (onRoot?.reason ?? '').includes('后代'));
}

// ══════════════════ D. 子代理请求数上限（不依赖 usage 事件） ══════════════════
{
	const h = harness({ DSH_LOOP_GUARD_MAX_SUBAGENT_REQUESTS: 5 });
	const child = h.session('d-child', 'd-root');
	for (let i = 0; i < 5; i += 1) h.modelCall(child);
	// 配额类闸门：到线之后的**第一次**是 warn + 放行（一次性豁免），此后每次都拦。
	const first = await h.call({ name: 'read', arguments: { file_path: 'x' }, agent: { session: child } });
	check(
		'子代理请求数到顶：首超豁免一次并打 warn',
		allowed(first) && h.logs.some(([, m]) => m.includes('一次性豁免')),
		JSON.stringify(first?.info)
	);
	const tripped = await h.call({ name: 'read', arguments: { file_path: 'x2' }, agent: { session: child } });
	check('子代理请求数到顶：此后每次都被拦', isDeny(tripped, 'LOOP_GUARD_SUBAGENT_REQUESTS'), JSON.stringify(tripped?.info));

	// 主会话不受这条限制
	const h2 = harness({ DSH_LOOP_GUARD_MAX_SUBAGENT_REQUESTS: 5 });
	const main = h2.session('d-main');
	for (let i = 0; i < 30; i += 1) h2.modelCall(main);
	check('主会话不受子代理请求数限制', allowed(await h2.call({ name: 'read', arguments: { file_path: 'y' }, agent: { session: main } })));
}

// ══════════════════ E. 扇出上限：出生那一刻就查并发 ══════════════════
{
	const h = harness({ DSH_LOOP_GUARD_MAX_FANOUT: 3 });
	const root = h.session('e-root');
	for (const id of ['e-c1', 'e-c2', 'e-c3']) h.created(h.session(id, 'e-root'));
	const first = await h.call({ name: 'subagent', arguments: { prompt: '干活' }, agent: { session: root } });
	check(
		'扇出到顶：首超豁免一次并打 warn',
		allowed(first) && h.logs.some(([, m]) => m.includes('一次性豁免')),
		JSON.stringify(first?.info)
	);
	const tripped = await h.call({ name: 'subagent', arguments: { prompt: '干活2' }, agent: { session: root } });
	check('此后每次 spawn 都被拦', isDeny(tripped, 'LOOP_GUARD_FANOUT'), JSON.stringify(tripped?.info));

	// 有人返回了就该放行
	h.disposed(h.session('e-c1'));
	check('子代理返回后名额释放', allowed(await h.call({ name: 'subagent', arguments: { prompt: '干活3' }, agent: { session: root } })));
}

// ══════════════════ F. 横向异常：同父兄弟取中位数 ══════════════════
{
	const h = harness({
		DSH_LOOP_GUARD_OUTLIER_MIN_SIBLINGS: 3,
		DSH_LOOP_GUARD_OUTLIER_RATIO: 5,
		DSH_LOOP_GUARD_OUTLIER_FLOOR_TOKENS: 1000
	});
	h.charge(h.session('f-c1', 'f-root'), 1_000_000);
	h.charge(h.session('f-c2', 'f-root'), 1_000_000);
	h.charge(h.session('f-c3', 'f-root'), 50_000_000);
	const normal = await h.call({ name: 'read', arguments: { file_path: 'x' }, agent: { session: h.session('f-c1', 'f-root') } });
	check('兄弟里的正常水平不被拦', allowed(normal), JSON.stringify(normal?.info));
	const outlier = await h.call({ name: 'read', arguments: { file_path: 'x' }, agent: { session: h.session('f-c3', 'f-root') } });
	check('比中位数高 50 倍的被单独掐', isDeny(outlier, 'LOOP_GUARD_OUTLIER'), JSON.stringify(outlier?.info));
	check('异常说明里带上中位数', (outlier?.reason ?? '').includes('中位数'));
}

// ══════════════════ G. 熔断：烧多吐少记失败，够次数不再开新的 ══════════════════
{
	const h = harness({
		DSH_LOOP_GUARD_MAX_BATCH_FAILURES: 2,
		DSH_LOOP_GUARD_EMPTY_RESULT_TOKENS: 1000,
		DSH_LOOP_GUARD_EMPTY_RESULT_OUTPUT: 100
	});
	const root = h.session('g-root');
	for (const id of ['g-c1', 'g-c2']) {
		h.charge(h.session(id, 'g-root'), 1_000_000, { output: 0 });
		h.disposed(h.session(id, 'g-root'));
	}
	check('烧多吐少被记成失败', h.logs.filter(([, m]) => m.includes('记一次失败')).length === 2);
	const first = await h.call({ name: 'subagent', arguments: { prompt: '再派一个' }, agent: { session: root } });
	check(
		'熔断后首超（第一次开新子代理）豁免一次并打 warn',
		allowed(first) && h.logs.some(([, m]) => m.includes('一次性豁免')),
		JSON.stringify(first?.info)
	);
	const tripped = await h.call({ name: 'subagent', arguments: { prompt: '再派第二个' }, agent: { session: root } });
	check('失败够次数后熔断，此后不再开新子代理', isDeny(tripped, 'LOOP_GUARD_BREAKER'), JSON.stringify(tripped?.info));
}

// ══════════════════ H. workflow 扇出：数脚本里几个 agent() ══════════════════
{
	const h = harness({ DSH_LOOP_GUARD_MAX_WORKFLOW_AGENTS: 2 });
	const root = h.session('h-root');
	const script = 'await agent("a", {schema:s}); await agent("b", {schema:s}); await pipeline(items, () => agent("c"));';
	const args = { script };
	const first = await h.call({ name: 'workflow', arguments: args, agent: { session: root } });
	check(
		'workflow 扇出首超豁免一次并打 warn',
		allowed(first) && h.logs.some(([, m]) => m.includes('一次性豁免')),
		JSON.stringify(first?.info)
	);
	const tripped = await h.call({ name: 'workflow', arguments: args, agent: { session: root } });
	check('workflow 里 agent() 太多被拦', isDeny(tripped, 'LOOP_GUARD_WORKFLOW_FANOUT'), JSON.stringify(tripped?.info));
	check('说明里给出估计个数', (tripped?.reason ?? '').includes('3'));
}

// ══════════════════ I. 软着陆：到线只拦探索，放过收尾 ══════════════════
{
	const h = harness({ DSH_LOOP_GUARD_SOFT_LANDING: 1 });
	const session = h.session('i-soft');
	h.charge(session, 105_000_000);
	const explore = await h.call({ name: 'web_search', arguments: { queries: ['x'] }, agent: { session } });
	check('软着陆：继续探索的工具被拦', isDeny(explore, 'LOOP_GUARD_SOFT_LANDING'), JSON.stringify(explore?.info));
	const finish = await h.call({ name: 'write', arguments: { file_path: 'a.txt', content: 'x' }, agent: { session } });
	check('软着陆：收尾工具照常放行', allowed(finish), JSON.stringify(finish?.info));

	// 关掉软着陆就恢复硬停手
	const h2 = harness();
	const s2 = h2.session('i-hard');
	h2.charge(s2, 105_000_000);
	check('关掉软着陆后 write 也被拦', isDeny(await h2.call({ name: 'write', arguments: { file_path: 'a.txt', content: 'x' }, agent: { session: s2 } }), 'LOOP_GUARD_BUDGET_EXHAUSTED'));
}

// ══════════════════ J. 总开关 ══════════════════
{
	const h = harness({ DSH_LOOP_GUARD_OFF: 1 });
	check('DSH_LOOP_GUARD_OFF=1 时根本不上闸', h.pre === undefined);
	check('关掉时日志里说清楚', h.logs.some(([, m]) => m.includes('关掉')));
}

// ══════════════════ K. SPAWN_TOOLS：三个「出生即查」的工具一个都不能漏 ══════════════════
{
	// subagent / subagent_fork / workflow 走的是同一条出生闸门（扇出并发）。三个都是
	// 子代理乘数，卡住入口比等它们烧完再拦便宜得多 —— 所以三个各要一条真断言，
	// 不是只测其中常用的那一个。
	//
	// 配额类闸门带一次性豁免：到线后的**第一次**是 warn + 放行，此后每次都拦。
	// 豁免按「会话 + 闸门」记，所以每个工具各开一份守卫，免得互相把豁免吃掉。
	for (const name of ['subagent', 'subagent_fork', 'workflow']) {
		const h = harness({ DSH_LOOP_GUARD_MAX_FANOUT: 1, DSH_LOOP_GUARD_MAX_WORKFLOW_AGENTS: 9999 });
		const root = h.session(`k-${name}-root`);
		h.created(h.session(`k-${name}-c1`, `k-${name}-root`));
		const args = name === 'workflow' ? { script: 'return await agent("x");' } : { prompt: '干活' };
		const first = await h.call({ name, arguments: args, agent: { session: root } });
		const second = await h.call({ name, arguments: args, agent: { session: root } });
		check(
			`扇出到顶：${name} 首超豁免一次、第二次被拦`,
			allowed(first) && isDeny(second, 'LOOP_GUARD_FANOUT'),
			`first=${JSON.stringify(first?.info)?.slice(0, 60)} second=${JSON.stringify(second?.info)?.slice(0, 60)}`
		);
	}

	// workflow 自己的估数闸门（不是并发闸门）：脚本里 1 处 agent() × args 里 3 个条目。
	const h2 = harness({ DSH_LOOP_GUARD_MAX_WORKFLOW_AGENTS: 2 });
	const root2 = h2.session('k2-root');
	const overArgs = {
		script: 'return await pipeline(args.files, async (f) => agent("x"));',
		args: { files: ['a', 'b', 'c'] }
	};
	const overFirst = await h2.call({ name: 'workflow', arguments: overArgs, agent: { session: root2 } });
	check('workflow 估数首超豁免一次并打 warn', allowed(overFirst), JSON.stringify(overFirst?.info)?.slice(0, 80));
	const over = await h2.call({ name: 'workflow', arguments: overArgs, agent: { session: root2 } });
	check('workflow 估数超过 maxWorkflowAgents 被拦', isDeny(over, 'LOOP_GUARD_WORKFLOW_FANOUT'), JSON.stringify(over?.info)?.slice(0, 80));
	check('估出来的扇出数写进了理由里', String(over?.reason ?? '').includes('3'));

	// 反向：估算值没超线就放行（闸门不能把「1 个子代理的 workflow」也拦掉）。
	const h3 = harness({ DSH_LOOP_GUARD_MAX_WORKFLOW_AGENTS: 24 });
	const root3 = h3.session('k3-root');
	const small = await h3.call({ name: 'workflow', arguments: { script: 'return await agent("只派一个");' }, agent: { session: root3 } });
	check('只派一个子代理的 workflow 照常放行', allowed(small), JSON.stringify(small?.info)?.slice(0, 80));
}

// ══════════════════ L. 测试隔离：真账本与真日志一个字节都不许动 ══════════════════
{
	// 这正是「测试隔离」那句话的可验证形式：跑完 60 多个场景，两样都原样不动。
	const stateAfter = sha256(REAL_STATE);
	const logAfter = sha256(REAL_LOG);
	check(`测试全程没有写/改真账本（${REAL_STATE}）`, stateAfter === realStateBefore, `${realStateBefore} → ${stateAfter}`);
	check(`测试全程没有写/改真日志（${REAL_LOG}）`, logAfter === realLogBefore, `${realLogBefore} → ${logAfter}`);
}

// 测试自己的临时文件也收掉，别在 test/ 下留垃圾。
for (const file of [SMOKE_LOG, fileURLToPath(new URL('./.smoke-state.json', import.meta.url))]) {
	try {
		fs.rmSync(file, { force: true });
	} catch {
		/* 本来就没有 */
	}
}

// ── 输出 ──
console.log('\n===== dsh-loop-guard 冒烟测试 =====');
let failed = 0;
for (const [status, label, extra] of results) {
	if (status === 'FAIL') failed += 1;
	console.log(`${status}  ${label}${status === 'FAIL' && extra ? `   → ${extra}` : ''}`);
}
console.log(`\n通过 ${results.length - failed}/${results.length}；next() 被调用 ${nextCalls} 次`);
process.exit(failed === 0 ? 0 : 1);
