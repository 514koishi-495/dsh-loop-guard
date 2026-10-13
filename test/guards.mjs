/**
 * dsh-loop-guard 新增闸门测试：会话跨轮硬停手、新一轮否决、乒乓循环、
 * 同错误、同骨架、命令归一化、workflow 估数、按请求均值的横向异常、
 * 逃生门日志、账本释放、跨重启记账。
 *
 *   node test/guards.mjs
 *
 * 全部在进程内跑，不碰真账本（STATE_FILE 指向 test/.guards-state.json）。
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const mod = await import(new URL('../lib/index.js', import.meta.url).href);

const STATE_PATH = fileURLToPath(new URL('./.guards-state.json', import.meta.url));
try {
	fs.rmSync(STATE_PATH, { force: true });
} catch {
	/* 本来就没有 */
}

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
	'DSH_LOOP_GUARD_PERSIST',
	'DSH_LOOP_GUARD_NO_PERSIST',
	'DSH_LOOP_GUARD_SOFT_LANDING',
	'DSH_LOOP_GUARD_OFF'
];

const results = [];
const check = (label, ok, extra = '') => results.push([ok ? 'PASS' : 'FAIL', label, extra]);

const next = async () => ({ kind: 'ok' });

function harness(env = {}) {
	for (const key of KEYS) delete process.env[key];
	process.env.DSH_LOOP_GUARD_STATE_FILE = STATE_PATH;
	// 除非这个场景明确要测跨重启记账，否则一律不许碰磁盘 ——
	// 账本是模块级的、测试的会话 id 是固定的，一写盘就会串到下一个场景。
	if (env.DSH_LOOP_GUARD_PERSIST === undefined) process.env.DSH_LOOP_GUARD_NO_PERSIST = '1';

	for (const [key, value] of Object.entries(env)) process.env[key] = String(value);
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
	for (const key of KEYS) delete process.env[key];

	const pre = handlers.get('tools/pre-execute')?.[0];
	const stepHandler = handlers.get('agent/pre-step')?.[0];
	const onEvent = handlers.get('session/event')?.[0];

	return {
		logs,
		hasPre: typeof pre === 'function',
		hasStep: typeof stepHandler === 'function',
		warned: (needle) => logs.some(([level, text]) => level === 'warn' && text.includes(needle)),
		sub: (id, parent) => ({ id, header: { origin: 'subagent', parentSession: parent } }),
		plain: (id) => ({ id }),
		call: (session, name, args = {}) => pre({ name, arguments: args, agent: { session } }, next),
		step: (session, turn) => stepHandler({ agent: { session }, turn, step: 1, signal: undefined }, next),
		charge: (session, tokens, turn = 1) =>
			onEvent(session, {
				type: 'assistant/chunk',
				data: { turn, step: 1, chunk: { type: 'usage', usage: { inputTokens: tokens, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 } } }
			}),
		modelCall: (session) => onEvent(session, { type: 'assistant/message', data: {} }),
		created: (session) => handlers.get('session/created')[0](session),
		disposed: (session) => handlers.get('session/disposed')[0](session),
		toolError: (session, reason, text = '', turn = 1) =>
			onEvent(session, {
				type: 'tool/result',
				data: {
					turn,
					step: 1,
					message: { role: 'tool', isError: true, toolCallId: 'c1', content: [{ type: 'text', text }] },
					error: { name: 'ToolError', code: 'E_FAIL', reason }
				}
			}),
		/** 一次工具调用的开始（用来喂 callId → 工具名 映射）。 */
		toolCall: (session, name, callId, turn = 1) =>
			onEvent(session, { type: 'tool/call', data: { turn, step: 1, name, callId, arguments: {} } }),
		/** 直接塞一条原始事件，用来测各种载荷形状。 */
		event: (session, ev) => onEvent(session, ev),
		/** 一次**成功**的工具结果（用来测「脱困了没有」）。 */
		toolOk: (session, name, callId, turn = 1) =>
			onEvent(session, {
				type: 'tool/result',
				data: {
					turn,
					step: 1,
					name,
					message: { role: 'tool', isError: false, toolCallId: callId, content: [{ type: 'text', text: 'ok' }] }
				}
			}),
		/** 完全自定义的一次工具失败，用来测各种错误载荷形状。 */
		toolFail: (session, opts = {}) =>
			onEvent(session, {
				type: 'tool/result',
				data: {
					turn: opts.turn ?? 1,
					step: 1,
					name: opts.name,
					message: {
						role: 'tool',
						isError: true,
						toolCallId: opts.callId ?? 'c1',
						content: [{ type: 'text', text: opts.text ?? '' }]
					},
					error: opts.error ?? { name: 'ToolError', code: opts.code ?? 'E_FAIL', reason: opts.reason ?? '' }
				}
			})
	};
}

const isDeny = (v, code) => v?.kind === 'deny' && (code === undefined || v.info.code === code);
const allowed = (v) => v === undefined || v.kind !== 'deny';

// ══════════ 1. 会话上限默认 10 亿；到线的那一轮放完，之后拒绝新轮 ══════════
{
	// vetoNewTurn 默认是关的（reject 是空决定，会把用户闷在一个没有解释的死胡同里），
	// 所以这个场景要显式打开它。
	const h = harness({ DSH_LOOP_GUARD_VETO_NEW_TURN: 1 });
	const s = h.plain('g1-root');
	for (let turn = 1; turn <= 10; turn += 1) h.charge(s, 90_000_000, turn);
	const at900 = await h.call(s, 'read', { file_path: 'a.txt' });
	check('累计 9 亿（< 默认 10 亿）时照常放行', allowed(at900), JSON.stringify(at900)?.slice(0, 60));

	for (let turn = 11; turn <= 12; turn += 1) h.charge(s, 90_000_000, turn);
	const over = await h.call(s, 'read', { file_path: 'b.txt' });
	check('累计 11.2 亿越过默认 10 亿后被拦', isDeny(over, 'LOOP_GUARD_SESSION_BUDGET'));
	check('拦的理由里劝开新会话', String(over?.reason ?? '').includes('会话上限'));

	const sameTurn = await h.step(s, 12);
	check('到线的那一轮不被否决（模型要靠它写交账报告）', sameTurn === undefined || sameTurn.kind !== 'reject');
	const laterTurn = await h.step(s, 13);
	check('之后的新一轮被否决', laterTurn?.kind === 'reject');
	check('reject 是空决定（只有 kind，没有多余字段）', JSON.stringify(laterTurn) === '{"kind":"reject"}');
}

// ══════════ 1b. 单轮预算含子代理：自己这一轮 + 这一轮生出来的子代理 ══════════
{
	// 控制组：自己 6000 万 + 子代理 3000 万 = 9000 万，还没到 1 亿。
	const ok = harness();
	const okRoot = ok.plain('g1b-root');
	const okChild = ok.sub('g1b-child', 'g1b-root');
	ok.charge(okRoot, 60_000_000, 1);
	ok.charge(okChild, 30_000_000, 1);
	const stillOk = await ok.call(okRoot, 'read', { file_path: 'a.txt' });
	check('本轮自己 6000 万 + 子代理 3000 万 = 9000 万，仍放行', allowed(stillOk), JSON.stringify(stillOk)?.slice(0, 60));

	// 实验组：子代理换成 5000 万，合计 1.1 亿 —— 父自己下一次调用就该被拦。
	const h = harness();
	const root = h.plain('g1c-root');
	const child = h.sub('g1c-child', 'g1c-root');
	h.charge(root, 60_000_000, 1);
	h.charge(child, 50_000_000, 1);
	const over = await h.call(root, 'read', { file_path: 'b.txt' });
	check('本轮含子代理越过 1 亿后被拦（只算自己的旧行为会放行）', isDeny(over, 'LOOP_GUARD_BUDGET_EXHAUSTED'));
	check('拦的理由里点明子代理也算了', String(over?.reason ?? '').includes('子代理'));

	// 子代理的账只该落在「它花钱时那一轮」。换轮之后必须归零，否则第一轮就会被永久拖累。
	h.charge(root, 1_000_000, 2);
	const nextTurn = await h.call(root, 'read', { file_path: 'c.txt' });
	check('换到新一轮后，子代理上一轮的账不再算进本轮', allowed(nextTurn), JSON.stringify(nextTurn)?.slice(0, 60));

	// 子代理自己的那一轮也一样：它生的孙代理要算进它的本轮预算。
	const g = harness();
	const gRoot = g.plain('g1d-root');
	const gChild = g.sub('g1d-child', 'g1d-root');
	const gGrand = g.sub('g1d-grand', 'g1d-child');
	g.created(gChild);
	g.created(gGrand);
	g.charge(gRoot, 10_000_000, 1);
	g.charge(gChild, 60_000_000, 1);
	g.charge(gGrand, 50_000_000, 1);
	const childOver = await g.call(gChild, 'read', { file_path: 'd.txt' });
	check('孙代理的消耗也算进子代理自己的本轮预算', isDeny(childOver, 'LOOP_GUARD_BUDGET_EXHAUSTED'));
	const rootFine = await g.call(gRoot, 'read', { file_path: 'e.txt' });
	check('爷爷自己那轮只有 1000 万 + 孙辈 1.1 亿…… 一样会被拦', isDeny(rootFine, 'LOOP_GUARD_BUDGET_EXHAUSTED'));
}

// ══════════ 2. vetoNewTurn 默认关闭，显式关掉也不注册这个钩子 ══════════
{
	const byDefault = harness();
	check('默认不注册 agent/pre-step（免得用户被静默否决）', byDefault.hasStep === false);

	const h = harness({ DSH_LOOP_GUARD_VETO_NEW_TURN: 0 });
	check('关掉 vetoNewTurn 后不注册 agent/pre-step', h.hasStep === false);
}

// ══════════ 2b. 同骨架只该管命令行，不该误伤「一批不同的文件」 ══════════
{
	const h = harness({
		DSH_LOOP_GUARD_SKELETON_LIMIT: 3,
		DSH_LOOP_GUARD_REPEAT_LIMIT: 99,
		DSH_LOOP_GUARD_READ_REPEAT_LIMIT: 99
	});
	const s = h.plain('g2b-root');

	const edits = [];
	for (let i = 1; i <= 12; i += 1) {
		edits.push(await h.call(s, 'edit', { file_path: `src/file${i}.js`, old_string: `a${i}`, new_string: `b${i}` }));
	}
	check('改 12 个不同的文件不算同骨架（不误伤批量重构）', edits.every(allowed), JSON.stringify(edits.find((v) => !allowed(v)))?.slice(0, 80));

	const subs = [];
	for (let i = 1; i <= 6; i += 1) {
		subs.push(await h.call(s, 'subagent', { prompt: `查第 ${i} 个问题，内容各不相同`, description: `r${i}` }));
	}
	check('连着起 6 个内容不同的子代理不算同骨架', subs.every(allowed));

	const reads = [];
	for (let i = 0; i < 5; i += 1) {
		reads.push(await h.call(s, 'read', { file_path: 'big.txt', offset: i * 100, limit: 100 }));
	}
	check('换着 offset 反复读同一个文件仍会被同骨架拦', isDeny(reads[3], 'LOOP_GUARD_SKELETON'));

	const chapters = [];
	for (let i = 1; i <= 5; i += 1) {
		chapters.push(await h.call(s, 'read', { file_path: `chapter${i}.txt` }));
	}
	check('读 chapter1..chapter5 这种编了号的不同文件不算同骨架', chapters.every(allowed));
}

// ══════════ 3. 乒乓循环 A-B-A-B-A-B ══════════
{
	const h = harness();
	const s = h.plain('g3-root');
	const a = { command: 'echo AAA' };
	const b = { command: 'echo BBB' };
	const seen = [];
	for (let i = 0; i < 6; i += 1) seen.push(await h.call(s, 'pwsh', i % 2 === 0 ? a : b));
	check('前 5 步都没拦（每步签名都是新的）', seen.slice(0, 5).every(allowed));
	check('第 6 步被乒乓循环拦下', isDeny(seen[5], 'LOOP_GUARD_CYCLE'));
	check('理由里点出是在两种写法之间打转', String(seen[5]?.reason ?? '').includes('乒乓循环'));
}

// ══════════ 4. 同一个错误反复出现 ══════════
{
	const h = harness({ DSH_LOOP_GUARD_SAME_ERROR_LIMIT: 2 });
	const s = h.plain('g4-root');
	check('第一次正常放行', allowed(await h.call(s, 'pwsh', { command: 'run one' })));
	h.toolError(s, 'ENOENT: no such file or directory, open C:\\x\\y.json');
	check('错一次还不拦', allowed(await h.call(s, 'pwsh', { command: 'run two' })));
	h.toolError(s, 'ENOENT: no such file or directory, open C:\\x\\z.json');
	const tripped = await h.call(s, 'pwsh', { command: 'run three' });
	check('同样的错第二次后被拦', isDeny(tripped, 'LOOP_GUARD_SAME_ERROR'));
	check('理由里带出错误原文', String(tripped?.reason ?? '').includes('ENOENT'));
	check('理由里要求换假设而不是换写法', String(tripped?.reason ?? '').includes('假设'));
}

// ══════════ 5. 同骨架：换数字、换路径就溜不掉 ══════════
{
	const h = harness({ DSH_LOOP_GUARD_SKELETON_LIMIT: 3, DSH_LOOP_GUARD_CYCLE_LIMIT: 99 });
	const s = h.plain('g5-root');
	const verdicts = [];
	for (let i = 1; i <= 4; i += 1) verdicts.push(await h.call(s, 'pwsh', { command: `probe --index ${i}` }));
	check('换数字的前 3 次都放行', verdicts.slice(0, 3).every(allowed));
	check('第 4 次被同骨架拦下', isDeny(verdicts[3], 'LOOP_GUARD_SKELETON'));
	check('理由里说清了骨架是什么', String(verdicts[3]?.reason ?? '').includes('pwsh::probe --index'));
}

// ══════════ 6. 命令归一化：pid / epoch / 时间戳 / hash 不该算新命令 ══════════
{
	const h = harness({ DSH_LOOP_GUARD_REPEAT_LIMIT: 1, DSH_LOOP_GUARD_MAX_DENIALS: 9, DSH_LOOP_GUARD_SKELETON_LIMIT: 99 });
	const s = h.plain('g6-root');
	await h.call(s, 'pwsh', { command: 'Get-Process -Id 4821' });
	await h.call(s, 'pwsh', { command: 'Get-Process -Id 9134' });
	const third = await h.call(s, 'pwsh', { command: 'Get-Process -Id 7777' });
	check('只换 pid 的调用算同一条命令（被同签名拦）', isDeny(third, 'LOOP_GUARD_REPEAT'));

	const s2 = h.plain('g6b-root');
	await h.call(s2, 'pwsh', { command: 'run 1699999999 --out 11111111.log' });
	await h.call(s2, 'pwsh', { command: 'run 1700000001 --out 22222222.log' });
	const b = await h.call(s2, 'pwsh', { command: 'run 1700000002 --out 33333333.log' });
	check('只换 epoch 和日志文件名也算同一条命令', isDeny(b, 'LOOP_GUARD_REPEAT'));
}

// ══════════ 7. workflow 估数：不再被字符串骗，也不漏掉乘数 ══════════
{
	const h = harness({ DSH_LOOP_GUARD_MAX_WORKFLOW_AGENTS: 3 });
	const s = h.plain('g7-root');
	const liars = await h.call(s, 'workflow', { script: 'const s = "agent(agent(agent(agent("; log(s);' });
	check('字符串里的 agent( 不算调用', allowed(liars), JSON.stringify(liars)?.slice(0, 60));

	const single = await h.call(s, 'workflow', { script: 'return await agent("do it");' });
	check('真的 1 个 agent() 不超线', allowed(single));

	const fanout = await h.call(s, 'workflow', {
		script: 'const r = await pipeline(args.files, async (f) => agent("处理 " + f)); return r;',
		args: { files: ['a', 'b', 'c', 'd', 'e'] }
	});
	check('pipeline + 5 个条目的扇出被拦', isDeny(fanout, 'LOOP_GUARD_WORKFLOW_FANOUT'));
	check('理由里给出「1 处 agent() × 5」的估算', String(fanout?.reason ?? '').includes('预计会扇出约 5 个'));
}

// ══════════ 8. 横向异常改成比「每次请求均值」 ══════════
{
	const h = harness({
		DSH_LOOP_GUARD_OUTLIER_MIN_SIBLINGS: 3,
		DSH_LOOP_GUARD_OUTLIER_RATIO: 5,
		DSH_LOOP_GUARD_OUTLIER_FLOOR_TOKENS: 1000,
		DSH_LOOP_GUARD_MAX_SUBAGENT_REQUESTS: 9999,
		DSH_LOOP_GUARD_MAX_SUBAGENT_TOOLS: 9999
	});
	const parent = h.plain('g8-parent');
	h.created(parent);
	// c1 总量最大，但每次请求很便宜 —— 以前会被误判成异常。
	// 每个兄弟都花 1 亿，但摊在 100 次请求上；c4 只花 1000 万，却只用了 1 次请求。
	const spread = (c) => {
		for (let turn = 1; turn <= 100; turn += 1) h.charge(c, 1_000_000, turn);
	};
	const c1 = h.sub('g8-c1', 'g8-parent');
	h.created(c1);
	spread(c1);
	for (const id of ['g8-c2', 'g8-c3']) {
		const c = h.sub(id, 'g8-parent');
		h.created(c);
		spread(c);
	}
	const c4 = h.sub('g8-c4', 'g8-parent');
	h.created(c4);
	h.charge(c4, 10_000_000, 1);

	const v1 = await h.call(h.plain('g8-c1'), 'read', { file_path: 'x' });
	check('总量最大但每次请求便宜的，不再被误判', allowed(v1), JSON.stringify(v1)?.slice(0, 80));
	const v4 = await h.call(h.plain('g8-c4'), 'read', { file_path: 'y' });
	check('每次请求贵 10 倍的被单独掐', isDeny(v4, 'LOOP_GUARD_OUTLIER'));
	check('理由里给的是「每次请求」的比较', String(v4?.reason ?? '').includes('每次请求'));
}

// ══════════ 9. 逃生门放行时必须吼一声 ══════════
{
	const h = harness({ DSH_LOOP_GUARD_REPEAT_LIMIT: 1, DSH_LOOP_GUARD_READ_REPEAT_LIMIT: 1, DSH_LOOP_GUARD_MAX_DENIALS: 1, DSH_LOOP_GUARD_SKELETON_LIMIT: 99 });
	const s = h.plain('g9-root');
	await h.call(s, 'read', { file_path: 'same.txt' });
	const denied = await h.call(s, 'read', { file_path: 'same.txt' });
	check('第 2 次拦下', isDeny(denied, 'LOOP_GUARD_REPEAT'));
	const escaped = await h.call(s, 'read', { file_path: 'same.txt' });
	check('第 3 次按逃生门放行', allowed(escaped));
	check('放行时打了 warn 日志（不静默烧钱）', h.warned('逃生门放行'));
}

// ══════════ 10. 会话结束要释放账本（否则插件自己变成内存泄漏） ══════════
{
	const h = harness({ DSH_LOOP_GUARD_MAX_FANOUT: 2 });
	const root = h.plain('gA-root');
	const c1 = h.sub('gA-c1', 'gA-root');
	const c2 = h.sub('gA-c2', 'gA-root');
	h.created(c1);
	h.created(c2);
	const full = await h.call(root, 'subagent', { prompt: 'x' });
	check('活着 2 个子代理时第 3 个被拦', isDeny(full, 'LOOP_GUARD_FANOUT'));
	h.disposed(c1);
	const after = await h.call(root, 'subagent', { prompt: 'y' });
	check('子代理结束、账本释放后名额让出来', allowed(after), JSON.stringify(after)?.slice(0, 60));
}

// ══════════ 11. 跨重启记账 ══════════
// 这一项必须单独开进程测：账本是模块级的、apply() 可以调很多次，
// 在同一个进程里先跑十个场景再测「从盘上恢复」会因为模块状态已经脏了而不准。
// 见 test/persist.mjs（node test/persist.mjs write && node test/persist.mjs read）。

// ══════════ 12.0 「同一错误」闸门的五个修正 ══════════
//
// 这一节全部来自一次真实事故：Hindsight 记忆库两次取数失败 → 插件认定「原地打转」
// → 拒绝 → 拒绝文本又被当成新的错误指纹 → 越滚越长的套娃拒绝 → 会话被永久锁死，
// 连读文件都读不了。下面每一条都对着事故里的一个成因。

/** 这些场景只关心「同一错误」，其它闸门一律调高，免得误判成它们。 */
const ONLY_SAME_ERROR = {
	DSH_LOOP_GUARD_SAME_ERROR_LIMIT: 2,
	DSH_LOOP_GUARD_SKELETON_LIMIT: 99,
	DSH_LOOP_GUARD_REPEAT_LIMIT: 99,
	DSH_LOOP_GUARD_READ_REPEAT_LIMIT: 99
};

{
	// ① 插件自己的拒绝不算「同一个错误」，否则「被拦」会喂养「再拦」。
	const h = harness(ONLY_SAME_ERROR);
	const s = h.plain('t12a');
	for (let i = 0; i < 6; i += 1) {
		await h.toolFail(s, {
			name: 'read',
			callId: `c${i}`,
			error: {
				name: 'LoopGuard',
				code: 'LOOP_GUARD_SAME_ERROR',
				reason: `【防烧钱 · 同一个错误反复出现】${'套娃'.repeat(i * 40)}`
			}
		});
	}
	const afterDenials = await h.call(s, 'read', { file_path: 'a.js' });
	check(
		'插件自己的拒绝不计入错误指纹（不会被自己的拒绝锁死）',
		allowed(afterDenials),
		JSON.stringify(afterDenials)?.slice(0, 80)
	);
}

{
	// ② 瞬时 / 外部故障不计入 —— 重试一次是合理的。
	const h = harness(ONLY_SAME_ERROR);
	const s = h.plain('t12b');
	for (let i = 0; i < 3; i += 1) {
		await h.toolFail(s, {
			name: 'pwsh',
			callId: `c${i}`,
			reason: 'Error: {"error":"GET https://api.github.com/repos/x/y failed"}'
		});
	}
	const afterTransient = await h.call(s, 'pwsh', { command: 'echo hi' });
	check(
		'瞬时网络错误不计入（网络抽一下不是原地打转）',
		allowed(afterTransient),
		JSON.stringify(afterTransient)?.slice(0, 80)
	);

	// 反向确认：非瞬时的同类错误照旧会被计入。
	const h2 = harness(ONLY_SAME_ERROR);
	const s2 = h2.plain('t12b2');
	for (let i = 0; i < 2; i += 1) {
		await h2.toolFail(s2, { name: 'pwsh', callId: `c${i}`, reason: 'ENOENT: no such file or directory' });
	}
	check('真·死循环（非瞬时）照旧被拦', isDeny(await h2.call(s2, 'pwsh', { command: 'echo hi' }), 'LOOP_GUARD_SAME_ERROR'));
}

{
	// ③ 指纹带工具名：A 工具的错误不该把 B 工具拦住。
	const h = harness(ONLY_SAME_ERROR);
	const s = h.plain('t12c');
	await h.toolFail(s, { name: 'pwsh', callId: 'c1', reason: 'boom ENOENT' });
	await h.toolFail(s, { name: 'read', callId: 'c2', reason: 'boom ENOENT' });
	const otherTool = await h.call(s, 'read', { file_path: 'b.js' });
	check('A 工具的错不会把 B 工具拦住', allowed(otherTool), JSON.stringify(otherTool)?.slice(0, 80));

	// 同一个工具错两次，才算数。
	await h.toolFail(s, { name: 'read', callId: 'c3', reason: 'boom ENOENT' });
	const sameTool = await h.call(s, 'read', { file_path: 'b2.js' });
	check('同一个工具错两次之后才拦', isDeny(sameTool, 'LOOP_GUARD_SAME_ERROR'));
}

{
	// ④ 拒绝理由要点出「真正报错的工具」，而闸门也只拦那个工具。
	const h = harness(ONLY_SAME_ERROR);
	const s = h.plain('t12d');
	await h.toolFail(s, { name: 'pwsh', callId: 'c1', reason: 'boom ENOENT' });
	await h.toolFail(s, { name: 'pwsh', callId: 'c2', reason: 'boom ENOENT' });

	// 事故里最难受的一段：pwsh 反复失败之后，连读个文件都被拦 ——
	// 而读文件恰恰是它诊断失败原因所必需的动作。
	const bystander = await h.call(s, 'read', { file_path: 'c.js' });
	check(
		'报错的是 pwsh 时，别的工具照常放行（不堵死诊断的路）',
		allowed(bystander),
		JSON.stringify(bystander)?.slice(0, 80)
	);

	const named = await h.call(s, 'pwsh', { command: 'echo try a different way' });
	check(
		'再碰 pwsh 才拦，且理由点名真凶',
		isDeny(named, 'LOOP_GUARD_SAME_ERROR') && String(named?.reason ?? '').includes('pwsh 报的'),
		String(named?.reason ?? '').split('\n')[1]?.trim() ?? ''
	);
	check(
		'理由里不再把工具名前缀糊进错误正文',
		!String(named?.reason ?? '').includes('\u0000') && !String(named?.reason ?? '').includes('pwsh\u0000'),
		String(named?.reason ?? '').split('\n')[2]?.trim() ?? ''
	);
}

{
	// ⑤ 逃生计数不许在换轮时清零 —— 这条正是那次永久锁死的直接成因。
	const h = harness({ ...ONLY_SAME_ERROR, DSH_LOOP_GUARD_MAX_DENIALS: 3 });
	const s = h.plain('t12e');
	await h.toolFail(s, { name: 'pwsh', callId: 'c1', reason: 'boom ENOENT' });
	await h.toolFail(s, { name: 'pwsh', callId: 'c2', reason: 'boom ENOENT' });
	const verdicts = [];
	for (let turn = 1; turn <= 4; turn += 1) {
		// 每一次都发生在**新的轮**里：真实事故就是被这个换轮重置锁死的。
		await h.charge(s, 10, turn);
		verdicts.push(await h.call(s, 'pwsh', { command: `echo round ${turn}` }));
	}
	check(
		'前 3 次都拦下了',
		verdicts.slice(0, 3).every((v) => isDeny(v, 'LOOP_GUARD_SAME_ERROR')),
		verdicts.map((v) => (allowed(v) ? '放行' : '拦')).join('/')
	);
	check(
		'跨轮连拦 3 次后第 4 次按逃生门放行（换轮不再清零计数）',
		allowed(verdicts[3]),
		JSON.stringify(verdicts[3])?.slice(0, 80)
	);
	check('放行时吼了一声（不静默烧钱）', h.warned('逃生门放行'));
}

{
	// ⑥ 报错的那个工具成功了，标志就该放下（别带着病继续跑）。
	const h = harness(ONLY_SAME_ERROR);
	const s = h.plain('t12f');
	await h.toolFail(s, { name: 'pwsh', callId: 'c1', reason: 'boom ENOENT' });
	await h.toolFail(s, { name: 'pwsh', callId: 'c2', reason: 'boom ENOENT' });
	const before = await h.call(s, 'pwsh', { command: 'echo still broken' });
	check('条件齐了先拦一次（确认标志真的立起来了）', isDeny(before, 'LOOP_GUARD_SAME_ERROR'));

	// 别的工具跑通不算脱困。
	await h.toolOk(s, 'read', 'c3');
	const otherOk = await h.call(s, 'pwsh', { command: 'echo try again' });
	check('别的工具成功不算脱困，标志还在', isDeny(otherOk, 'LOOP_GUARD_SAME_ERROR'));

	// 报错的这个工具自己跑通了，才算脱困。
	await h.toolOk(s, 'pwsh', 'c4');
	const healed = await h.call(s, 'pwsh', { command: 'echo try once more' });
	check('报错的工具自己成功后，标志放下、不再拦', allowed(healed), JSON.stringify(healed)?.slice(0, 80));
}

{
	// ⑦ 载荷形状：dsh-agent-loop 会把 `error.info` **展开到事件顶层**，
	//    也就是 `data.name` / `data.code` / `data.reason` 直接挂着、根本没有 `data.error`。
	//    只认 `data.error.*` 一种形状的话，这条过滤整条失效。
	const h = harness(ONLY_SAME_ERROR);
	const s = h.plain('t12g');
	for (let i = 0; i < 4; i += 1) {
		await h.event(s, {
			type: 'tool/result',
			data: {
				turn: 1,
				step: 1,
				name: 'LoopGuard',
				code: 'LOOP_GUARD_SAME_ERROR',
				reason: '【防烧钱 · 同一个错误反复出现，判定原地打转】',
				message: {
					role: 'tool',
					isError: true,
					toolCallId: `d${i}`,
					content: [{ type: 'text', text: 'Error: 【防烧钱 · 同一个错误反复出现，判定原地打转】' }]
				}
			}
		});
	}
	check(
		'摊在顶层的拒绝（没有 data.error）也不计入指纹',
		allowed(await h.call(s, 'read', { file_path: 'd.js' })),
		JSON.stringify(await h.call(s, 'read', { file_path: 'd2.js' }))?.slice(0, 60)
	);
}

{
	// ⑧ 拒绝正文可能被工具层包一层 `Error: ` 前缀 —— 判据不能是「以【防烧钱开头」。
	const h = harness(ONLY_SAME_ERROR);
	const s = h.plain('t12h');
	for (let i = 0; i < 4; i += 1) {
		await h.toolFail(s, {
			name: 'read',
			callId: `e${i}`,
			text: 'Error: 【防烧钱 · 同一个错误反复出现，判定原地打转】',
			reason: ''
		});
	}
	check(
		'被包了 Error: 前缀的拒绝正文，也认得出',
		allowed(await h.call(s, 'read', { file_path: 'e.js' })),
		JSON.stringify(await h.call(s, 'read', { file_path: 'e2.js' }))?.slice(0, 60)
	);
}

// ══════════ 12. 总开关：off=1 时一个钩子都不装 ══════════
{
	// 用户「一键停手」的出口是插件市场里的启用开关，面板/环境变量里的 off 是它的等价物。
	// 它要是没生效，守卫就会在用户以为已经关掉的时候继续拦人 —— 那是最坏的失效方式。
	const h = harness({ DSH_LOOP_GUARD_OFF: '1' });
	check('off=1 时不注册 tools/pre-execute（不再拦任何工具）', h.hasPre === false);
	check('off=1 时不注册 agent/pre-step（不再否决新一轮）', h.hasStep === false);
	check('off=1 时启动日志说清了它在关着', h.logs.some(([, text]) => text.includes('关掉')));
}

// ══════════ 13. 启动横幅要带上新闸门 ══════════
{
	const h = harness();
	const banner = h.logs.find(([level]) => level === 'info')?.[1] ?? '';
	check('横幅提到同骨架阈值', banner.includes('同骨架'));
	check('横幅提到同错误阈值', banner.includes('同错误'));
	check('横幅提到乒乓循环', banner.includes('乒乓循环'));
	check('横幅里会话累计不再是「不设限」', banner.includes('会话累计') && !banner.includes('会话累计 不设限'));
	check('横幅里跨重启记账状态可见', banner.includes('跨重启记账'));
}

// ────────────────────────────── 汇总 ──────────────────────────────

let failed = 0;
for (const [status, label, extra] of results) {
	if (status === 'FAIL') failed += 1;
	console.log(`${status}  ${label}${extra === '' ? '' : `   [${extra}]`}`);
}
console.log(`\n通过 ${results.length - failed}/${results.length}`);
process.exit(failed === 0 ? 0 : 1);
