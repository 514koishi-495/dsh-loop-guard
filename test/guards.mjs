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
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const STATE_PATH = fileURLToPath(new URL('./.guards-state.json', import.meta.url));
const LOG_PATH = fileURLToPath(new URL('./.guards-log.log', import.meta.url));

// **这两个路径必须在 import 之前设好。** 插件把 STATE_FILE / LOG_FILE 放在模块顶层
// 各读一次（lib/index.js 的 `const STATE_FILE = process.env.DSH_LOOP_GUARD_STATE_FILE ?? …`、
// `const LOG_FILE = process.env.DSH_LOOP_GUARD_LOG_FILE ?? …`），写在 import 之后的行
// 只是死代码；真正兜住「测试不碰真账本」的还有 apply() 时才读的 NO_PERSIST
// （persist: false ⇒ writeState/fileLog 直接返回）。
const REAL_STATE = path.join(os.homedir(), '.dsh', 'loop-guard-state.json');
const REAL_LOG = path.join(os.homedir(), '.dsh', 'loop-guard.log');
const snapshot = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);
const realStateBefore = snapshot(REAL_STATE);
const realLogBefore = snapshot(REAL_LOG);

process.env.DSH_LOOP_GUARD_STATE_FILE = STATE_PATH;
process.env.DSH_LOOP_GUARD_LOG_FILE = LOG_PATH;

try {
	fs.rmSync(STATE_PATH, { force: true });
	fs.rmSync(LOG_PATH, { force: true });
} catch {
	/* 本来就没有 */
}

const mod = await import(new URL('../lib/index.js', import.meta.url).href);

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

function harness(env = {}, opts = {}) {
	for (const key of KEYS) delete process.env[key];
	process.env.DSH_LOOP_GUARD_STATE_FILE = STATE_PATH;
	// 除非这个场景明确要测跨重启记账，否则一律不许碰磁盘 ——
	// 账本是模块级的、测试的会话 id 是固定的，一写盘就会串到下一个场景。
	// （NO_PERSIST 是 apply() 时才读的，所以在这里设来得及；两个路径不是，见文件头。）
	if (env.DSH_LOOP_GUARD_PERSIST === undefined) process.env.DSH_LOOP_GUARD_NO_PERSIST = '1';

	for (const [key, value] of Object.entries(env)) process.env[key] = String(value);
	const handlers = new Map();
	const logs = [];
	const ctx = {
		on(event, fn) {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(fn);
		},
		logger: opts.logger ?? { info: (m) => logs.push(['info', m]), warn: (m) => logs.push(['warn', m]) },
		// 宿主的 effect 负责注册/注销副作用；测试里立刻执行一次就够（用量端点靠它注册）。
		effect: (fn) => {
			try {
				return fn();
			} catch {
				return undefined;
			}
		}
	};
	if (opts.webServer !== undefined) ctx.webServer = opts.webServer;
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
/** 一行说清一次判定，用在断言失败的 extra 里。 */
const brief = (v) => (allowed(v) ? '放行' : `拦/${v?.info?.code ?? '?'}`);
const seqBrief = (list) => list.map(brief).join(' ');

/**
 * 直接喂一次 HTTP 请求给插件注册的 handler，不启真服务器。
 * handler 可能是同步的、也可能返回 Promise；响应可能写在 res 上，也可能作为返回值。
 */
async function httpGet(handler, url) {
	if (typeof handler !== 'function') return { status: 0, body: null, raw: '', error: '没有可调用的 handler' };
	const res = {
		statusCode: 0,
		headers: {},
		body: '',
		writeHead(status, headers) {
			this.statusCode = status;
			if (headers !== undefined && headers !== null) Object.assign(this.headers, headers);
			return this;
		},
		setHeader(name, value) {
			this.headers[name] = value;
		},
		write(chunk) {
			if (chunk !== undefined) this.body += String(chunk);
			return true;
		},
		end(chunk) {
			if (chunk !== undefined) this.body += String(chunk);
			return this;
		}
	};
	const req = { method: 'GET', url, headers: { accept: 'application/json' }, socket: null };
	let returned;
	try {
		returned = await handler(req, res);
	} catch (error) {
		return { status: res.statusCode, body: null, raw: res.body, error: String(error?.message ?? error) };
	}
	const raw = typeof returned === 'string' ? returned : res.body;
	let body = null;
	try {
		body = raw === '' ? null : JSON.parse(raw);
	} catch {
		body = null;
	}
	return { status: res.statusCode, headers: res.headers, body, raw };
}

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

	const fanoutArgs = {
		script: 'const r = await pipeline(args.files, async (f) => agent("处理 " + f)); return r;',
		args: { files: ['a', 'b', 'c', 'd', 'e'] }
	};
	// 配额类闸门带一次性豁免：到线后的**第一次**是 warn + 放行，此后每次都拦。
	const fanoutFirst = await h.call(s, 'workflow', fanoutArgs);
	check('pipeline + 5 个条目：首超豁免一次并打 warn', allowed(fanoutFirst) && h.warned('一次性豁免'), brief(fanoutFirst));
	const fanout = await h.call(s, 'workflow', fanoutArgs);
	check('pipeline + 5 个条目的扇出被拦', isDeny(fanout, 'LOOP_GUARD_WORKFLOW_FANOUT'), brief(fanout));
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
	// 配额类闸门：首超那一次 warn + 放行（一次性豁免），此后每次拦。
	const first = await h.call(root, 'subagent', { prompt: 'x' });
	check('活着 2 个子代理：首超豁免一次并打 warn', allowed(first) && h.warned('一次性豁免'), brief(first));
	const full = await h.call(root, 'subagent', { prompt: 'x2' });
	check('此后每次 spawn 都被拦', isDeny(full, 'LOOP_GUARD_FANOUT'), brief(full));
	h.disposed(c1);
	const after = await h.call(root, 'subagent', { prompt: 'y' });
	check('子代理结束、账本释放后名额让出来', allowed(after), brief(after));
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

// ══════════ 14. 契约 C1/C3：三道预算门（会话/本轮/家族）也带逃生门 ══════════
//
// 老实现里这几道门是裸 `return deny(...)`：一处到线就永久否决，逃生门只长在
// 「重复类」闸门上 —— 那是「绝不把 agent 锁死」这条原则最大的漏洞。
// 契约：第一次拦；同一处连拦满 maxDenials（默认 3）次之后必须放行一次，且放行要打 warn。
// 「到线后还能收尾」不靠「到线那一轮放它走完」，而靠第 15 节的免拦白名单 + 这里的保险丝。
{
	const h = harness({ DSH_LOOP_GUARD_SESSION_MAX_TOKENS: 1_000_000, DSH_LOOP_GUARD_MAX_DENIALS: 3 });
	const s = h.plain('c1-session');
	h.charge(s, 2_000_000, 1);
	const seq = [];
	for (let i = 0; i < 4; i += 1) seq.push(await h.call(s, 'read', { file_path: `c1s-${i}.txt` }));
	check('会话门到线：第 1 次就拦（LOOP_GUARD_SESSION_BUDGET）', isDeny(seq[0], 'LOOP_GUARD_SESSION_BUDGET'), seqBrief(seq));
	check('会话门连拦 3 次都拦下了', seq.slice(0, 3).every((v) => isDeny(v, 'LOOP_GUARD_SESSION_BUDGET')), seqBrief(seq));
	check('会话门拦满 3 次后第 4 次按逃生门放行（不会再永久锁死）', allowed(seq[3]), seqBrief(seq));
	check('会话门放行时打了 warn（静默放行等于偷偷烧钱）', h.warned('逃生门放行'));

	// 换轮不是解锁：门是粘性的，换轮之后照旧拦。
	h.charge(s, 10, 2);
	const nextTurn = await h.call(s, 'read', { file_path: 'c1s-next.txt' });
	check('会话门换轮之后仍然拦（不是「换轮降级为软」）', isDeny(nextTurn, 'LOOP_GUARD_SESSION_BUDGET'), brief(nextTurn));
}

{
	const h = harness({ DSH_LOOP_GUARD_MAX_DENIALS: 3 });
	const s = h.plain('c1-turn');
	h.charge(s, 105_000_000, 1);
	const seq = [];
	for (let i = 0; i < 4; i += 1) seq.push(await h.call(s, 'read', { file_path: `c1t-${i}.txt` }));
	check('本轮门到线：前 3 次拦（LOOP_GUARD_BUDGET_EXHAUSTED）', seq.slice(0, 3).every((v) => isDeny(v, 'LOOP_GUARD_BUDGET_EXHAUSTED')), seqBrief(seq));
	check('本轮门拦满 3 次后第 4 次放行', allowed(seq[3]), seqBrief(seq));
	check('本轮门放行时也打了 warn', h.warned('逃生门放行'));
}

{
	const h = harness({ DSH_LOOP_GUARD_FAMILY_MAX_TOKENS: 1_000_000, DSH_LOOP_GUARD_MAX_DENIALS: 2 });
	const s = h.plain('c1-family');
	h.charge(s, 2_000_000, 1);
	const seq = [];
	for (let i = 0; i < 3; i += 1) seq.push(await h.call(s, 'read', { file_path: `c1f-${i}.txt` }));
	check('家族门到线：连拦 maxDenials=2 次', seq.slice(0, 2).every((v) => isDeny(v, 'LOOP_GUARD_FAMILY_BUDGET')), seqBrief(seq));
	check('家族门第 3 次按逃生门放行', allowed(seq[2]), seqBrief(seq));
	check('家族门放行时也打了 warn', h.warned('逃生门放行'));
}

// ══════════ 15. 契约 C2：预算门到线时，免拦工具与非工具步骤照旧放行 ══════════
{
	const NEVER = [
		'todo_write',
		'todo_read',
		'job_list',
		'job_output',
		'job_kill',
		'ask_user_question',
		'update_goal',
		'get_goal',
		'acp_status',
		'acp_cache',
		'search_context'
	];
	const h = harness({ DSH_LOOP_GUARD_MAX_DENIALS: 99 });
	const s = h.plain('c2-turn');
	h.charge(s, 105_000_000, 1);
	const verdicts = [];
	for (const name of NEVER) verdicts.push(await h.call(s, name, {}));
	check(
		`本轮门到线时 ${NEVER.length} 个免拦工具全部放行（白名单在预算门之前判定）`,
		verdicts.every(allowed),
		NEVER.filter((_, index) => !allowed(verdicts[index])).join(',')
	);
	const noTool = await h.call(s, '', {});
	check('非工具步骤（toolName 为空）不拦', allowed(noTool), brief(noTool));
	const normal = await h.call(s, 'read', { file_path: 'c2-blocked.txt' });
	check('反例：同一时刻普通工具照旧被拦（白名单不是整体放行）', isDeny(normal, 'LOOP_GUARD_BUDGET_EXHAUSTED'), brief(normal));

	const h2 = harness({ DSH_LOOP_GUARD_SESSION_MAX_TOKENS: 1_000_000, DSH_LOOP_GUARD_MAX_DENIALS: 99 });
	const s2 = h2.plain('c2-session');
	h2.charge(s2, 2_000_000, 1);
	const w1 = await h2.call(s2, 'update_goal', {});
	const w2 = await h2.call(s2, 'todo_write', { todos: [] });
	check('会话门到线时免拦工具仍放行', allowed(w1) && allowed(w2), `${brief(w1)} / ${brief(w2)}`);
	check('反例：会话门到线时 read 被拦', isDeny(await h2.call(s2, 'read', { file_path: 'c2s.txt' }), 'LOOP_GUARD_SESSION_BUDGET'));

	const h3 = harness({ DSH_LOOP_GUARD_FAMILY_MAX_TOKENS: 1_000_000, DSH_LOOP_GUARD_MAX_DENIALS: 99 });
	const s3 = h3.plain('c2-family');
	h3.charge(s3, 2_000_000, 1);
	const w3 = await h3.call(s3, 'job_kill', { job_id: 'j1' });
	const w4 = await h3.call(s3, 'get_goal', {});
	check('家族门到线时免拦工具仍放行', allowed(w3) && allowed(w4), `${brief(w3)} / ${brief(w4)}`);
}

// ══════════ 16. 契约 C4：上限 <= 0 = 不设限（不是立刻全拦） ══════════
{
	const cases = [
		['本轮上限设 0', { DSH_LOOP_GUARD_MAX_TOKENS: 0 }, 500_000_000, 'c4-turn-zero'],
		['本轮上限设负数', { DSH_LOOP_GUARD_MAX_TOKENS: -1 }, 500_000_000, 'c4-turn-neg'],
		[
			'会话与家族上限设 0',
			{ DSH_LOOP_GUARD_MAX_TOKENS: 0, DSH_LOOP_GUARD_SESSION_MAX_TOKENS: 0, DSH_LOOP_GUARD_FAMILY_MAX_TOKENS: 0 },
			2_000_000_000,
			'c4-both-zero'
		]
	];
	for (const [label, env, tokens, id] of cases) {
		const h = harness(env);
		const s = h.plain(id);
		h.charge(s, tokens, 1);
		const verdict = await h.call(s, 'read', { file_path: `${id}.txt` });
		check(`${label} = 不设限（烧到 ${tokens} 也放行）`, allowed(verdict), brief(verdict));
	}
	// 反例：上限是正数（哪怕很小）时必须照常拦。
	const h = harness({ DSH_LOOP_GUARD_MAX_TOKENS: 1 });
	const s = h.plain('c4-reverse');
	h.charge(s, 5, 1);
	check('反例：本轮上限设成 1 时，烧 5 个 token 就被拦', isDeny(await h.call(s, 'read', { file_path: 'x.txt' }), 'LOOP_GUARD_BUDGET_EXHAUSTED'));
}

// ══════════ 17. 契约 C5：配额门的逃生是「首超 warn + 放行一次」，此后一直拦 ══════════
//
// 不允许出现「拦 3 次放 1 次」那种以 1/4 速率继续花钱的序列 —— 配额是钱的上限，
// 不是重复检测；保险丝那套（maxDenials）对它不适用。
const QUOTA_BASE = {
	DSH_LOOP_GUARD_REPEAT_LIMIT: 9999,
	DSH_LOOP_GUARD_READ_REPEAT_LIMIT: 9999,
	DSH_LOOP_GUARD_SKELETON_LIMIT: 9999,
	DSH_LOOP_GUARD_CYCLE_LIMIT: 9999,
	DSH_LOOP_GUARD_MAX_DENIALS: 3
};
{
	const h = harness({ ...QUOTA_BASE, DSH_LOOP_GUARD_MAX_SUBAGENT_REQUESTS: 2 });
	const child = h.sub('c5-req', 'c5-req-root');
	for (let i = 0; i < 2; i += 1) h.modelCall(child);
	const seq = [];
	for (let i = 0; i < 6; i += 1) seq.push(await h.call(child, 'read', { file_path: `c5r-${i}.txt` }));
	check('子代理请求数首超：warn + 放行一次（一次性豁免）', allowed(seq[0]) && h.warned('子代理请求数'), seqBrief(seq));
	check('子代理请求数后续 5 次全拦（不出现 1/4 速率的放行）', seq.slice(1).every((v) => isDeny(v, 'LOOP_GUARD_SUBAGENT_REQUESTS')), seqBrief(seq));
}

{
	const h = harness({ ...QUOTA_BASE, DSH_LOOP_GUARD_MAX_SUBAGENT_TOOLS: 2 });
	const child = h.sub('c5-tools', 'c5-tools-root');
	const seq = [];
	for (let i = 0; i < 6; i += 1) seq.push(await h.call(child, 'read', { file_path: `c5t-${i}.txt` }));
	check('子代理工具数：前 2 次在配额内放行，第 3 次首超 warn + 放行', seq.slice(0, 3).every(allowed) && h.warned('子代理工具数'), seqBrief(seq));
	check('子代理工具数后续 3 次全拦', seq.slice(3).every((v) => isDeny(v, 'LOOP_GUARD_SUBAGENT_TOOLS')), seqBrief(seq));
}

{
	const h = harness({ ...QUOTA_BASE, DSH_LOOP_GUARD_MAX_FANOUT: 1 });
	const root = h.plain('c5-fanout');
	h.created(h.sub('c5-fanout-c1', 'c5-fanout'));
	const seq = [];
	for (let i = 0; i < 5; i += 1) seq.push(await h.call(root, 'subagent', { prompt: `第 ${i} 个任务，内容各不相同` }));
	check('扇出首超：warn + 放行一次', allowed(seq[0]) && h.warned('扇出到顶'), seqBrief(seq));
	check('扇出后续 4 次全拦', seq.slice(1).every((v) => isDeny(v, 'LOOP_GUARD_FANOUT')), seqBrief(seq));
}

{
	const h = harness({ ...QUOTA_BASE, DSH_LOOP_GUARD_MAX_WORKFLOW_AGENTS: 2, DSH_LOOP_GUARD_MAX_FANOUT: 9999 });
	const root = h.plain('c5-workflow');
	const script = 'await agent("a"); await agent("b"); await agent("c");';
	const seq = [];
	for (let i = 0; i < 4; i += 1) seq.push(await h.call(root, 'workflow', { script: `${script} // ${i}` }));
	check('workflow 扇出首超：warn + 放行一次', allowed(seq[0]) && h.warned('workflow 扇出'), seqBrief(seq));
	check('workflow 扇出后续 3 次全拦', seq.slice(1).every((v) => isDeny(v, 'LOOP_GUARD_WORKFLOW_FANOUT')), seqBrief(seq));
}

// ══════════ 18. 契约 C6：同签名门放行的那一次，同时豁免同骨架门 ══════════
//
// 文档对模型承诺过「说明理由后照原样再发一次会被放行」。如果骨架门紧接着
// 把同一次调用拦回去，这个承诺就是空话 —— 模型只会看到「说了也没用」。
{
	const h = harness({
		DSH_LOOP_GUARD_REPEAT_LIMIT: 3,
		DSH_LOOP_GUARD_SKELETON_LIMIT: 5,
		DSH_LOOP_GUARD_MAX_DENIALS: 1,
		DSH_LOOP_GUARD_CYCLE_LIMIT: 9999
	});
	const s = h.plain('c6-root');
	const seq = [];
	for (let i = 0; i < 6; i += 1) seq.push(await h.call(s, 'pwsh', { command: 'probe --same' }));
	check('同签名第 4 次先被同签名门拦（同骨架门有更高的阈值）', isDeny(seq[3], 'LOOP_GUARD_REPEAT'), seqBrief(seq));
	check('第 5 次按逃生门放行', allowed(seq[4]), seqBrief(seq));
	check('第 6 次照原样再发一次，不得转而被同骨架门拦', allowed(seq[5]), seqBrief(seq));
	check('放行时打了 warn', h.warned('逃生门放行'));

	// 反例：把同签名门关掉，同一个骨架第 6 次就该被同骨架门拦下 ——
	// 证明上面那条「放行」确实来自豁免，而不是骨架门根本没武装。
	const h2 = harness({
		DSH_LOOP_GUARD_REPEAT_LIMIT: 9999,
		DSH_LOOP_GUARD_SKELETON_LIMIT: 5,
		DSH_LOOP_GUARD_MAX_DENIALS: 1,
		DSH_LOOP_GUARD_CYCLE_LIMIT: 9999
	});
	const s2 = h2.plain('c6-reverse');
	const seq2 = [];
	for (let i = 0; i < 6; i += 1) seq2.push(await h2.call(s2, 'pwsh', { command: 'probe --same' }));
	check('反例：同签名门关掉后，第 6 次被同骨架门拦下', isDeny(seq2[5], 'LOOP_GUARD_SKELETON'), seqBrief(seq2));
}

// ══════════ 19. 契约 C7：计数表溢出用 FIFO 淘汰，且淘汰不重置逃生计数 ══════════
{
	// ① 不是整体 clear()：表满之后插进来的那个签名，必须还在表里。
	const h = harness({
		DSH_LOOP_GUARD_REPEAT_LIMIT: 1,
		DSH_LOOP_GUARD_READ_REPEAT_LIMIT: 1,
		DSH_LOOP_GUARD_MAX_DENIALS: 9999,
		DSH_LOOP_GUARD_SKELETON_LIMIT: 9999,
		DSH_LOOP_GUARD_CYCLE_LIMIT: 9999
	});
	const s = h.plain('c7-cap');
	for (let i = 0; i < 399; i += 1) await h.call(s, 'pwsh', { command: `probe --filler ${i}` });
	await h.call(s, 'pwsh', { command: 'probe --target' });
	await h.call(s, 'pwsh', { command: 'probe --one-more' }); // 这一条把表顶过上限
	const verdict = await h.call(s, 'pwsh', { command: 'probe --target' });
	check('计数表满了按插入顺序淘汰最旧一条（不是整体清空）：目标签名还在表里', isDeny(verdict, 'LOOP_GUARD_REPEAT'), brief(verdict));
}

{
	// ② 逃生计数与签名记录分开存：记录被淘汰，也不许把「已连拦几次」一起丢掉。
	const h = harness({
		DSH_LOOP_GUARD_REPEAT_LIMIT: 1,
		DSH_LOOP_GUARD_READ_REPEAT_LIMIT: 1,
		DSH_LOOP_GUARD_MAX_DENIALS: 3,
		DSH_LOOP_GUARD_SKELETON_LIMIT: 9999,
		DSH_LOOP_GUARD_CYCLE_LIMIT: 9999
	});
	const s = h.plain('c7-escape');
	await h.call(s, 'pwsh', { command: 'probe --hot' });
	const firstDeny = await h.call(s, 'pwsh', { command: 'probe --hot' });
	check('重复门第 2 次拦下（逃生计数已用掉 1 次）', isDeny(firstDeny, 'LOOP_GUARD_REPEAT'), brief(firstDeny));
	for (let i = 0; i < 450; i += 1) await h.call(s, 'pwsh', { command: `probe --flood ${i}` });
	const seq = [];
	for (let i = 0; i < 4; i += 1) seq.push(await h.call(s, 'pwsh', { command: 'probe --hot' }));
	check(
		'签名记录被淘汰后重新计数，但逃生计数接着算：第 4 次（连拦累计满 3 次）放行一次',
		allowed(seq[3]) && h.warned('逃生门放行'),
		seqBrief(seq)
	);
}

{
	// ③ callId → 工具名 的表淘汰之后，同错误门仍然「只拦报错的那个工具」。
	const h = harness(ONLY_SAME_ERROR);
	const s = h.plain('c7-callnames');
	for (let i = 0; i < 450; i += 1) h.toolCall(s, 'read', `filler-${i}`);
	h.toolCall(s, 'pwsh', 'fresh-c1');
	await h.toolFail(s, { callId: 'fresh-c1', reason: 'boom ENOENT' });
	h.toolCall(s, 'pwsh', 'fresh-c2');
	await h.toolFail(s, { callId: 'fresh-c2', reason: 'boom ENOENT' });
	const bystander = await h.call(s, 'read', { file_path: 'c7-read.js' });
	const named = await h.call(s, 'pwsh', { command: 'echo still broken' });
	check('工具名映射表经过 450 次插入之后，仍然只拦报错的那个工具（诊断的路不堵）', allowed(bystander), brief(bystander));
	check('反例：报错的那个工具照样拦', isDeny(named, 'LOOP_GUARD_SAME_ERROR'), brief(named));
}

// ══════════ 20. 契约 C8：命令归一化收窄，read 的路径仍然原样保留 ══════════
{
	const limits = { DSH_LOOP_GUARD_MAX_DENIALS: 9999, DSH_LOOP_GUARD_SKELETON_LIMIT: 9999, DSH_LOOP_GUARD_CYCLE_LIMIT: 9999 };
	const h = harness({ ...limits, DSH_LOOP_GUARD_REPEAT_LIMIT: 1, DSH_LOOP_GUARD_READ_REPEAT_LIMIT: 1 });
	const s = h.plain('c8-shell');
	const v1 = await h.call(s, 'pwsh', { command: 'Get-Content build1.log' });
	const v2 = await h.call(s, 'pwsh', { command: 'Get-Content build5.log' });
	check('build1.log 与 build5.log 不再撞成同一签名（读五个不同的日志是正常干活）', allowed(v1) && allowed(v2), `${brief(v1)} / ${brief(v2)}`);
	const v3 = await h.call(s, 'pwsh', { command: 'Get-Content build1.log' });
	check('同一份日志反复取仍然算重复（名字一模一样时签名本来就相同）', isDeny(v3, 'LOOP_GUARD_REPEAT'), brief(v3));

	// read：路径原样保留 —— 同文件换 offset 会被同骨架拦，换路径不会。
	const h2 = harness({ ...limits, DSH_LOOP_GUARD_READ_REPEAT_LIMIT: 9999, DSH_LOOP_GUARD_SKELETON_LIMIT: 10 });
	const s2 = h2.plain('c8-read');
	const reads = [];
	for (let i = 0; i < 11; i += 1) reads.push(await h2.call(s2, 'read', { file_path: 'C:\\big.txt', offset: i * 100, limit: 100 }));
	check('read：同一个文件换 offset 前 10 次放行、第 11 次被同骨架拦', reads.slice(0, 10).every(allowed) && isDeny(reads[10], 'LOOP_GUARD_SKELETON'), seqBrief(reads));
	const h3 = harness({ ...limits, DSH_LOOP_GUARD_READ_REPEAT_LIMIT: 9999, DSH_LOOP_GUARD_SKELETON_LIMIT: 1 });
	const s3 = h3.plain('c8-read-paths');
	const a = await h3.call(s3, 'read', { file_path: 'C:\\chapter1.txt' });
	const b = await h3.call(s3, 'read', { file_path: 'C:\\chapter2.txt' });
	check('read：换路径不算同骨架（chapter1 / chapter2 不互撞）', allowed(a) && allowed(b), `${brief(a)} / ${brief(b)}`);
}

// ══════════ 21. 契约 C9/C10：workflow 估数 —— 先剥字符串再剥注释、乘数不再只看 pipeline ══════════
{
	const limits = { DSH_LOOP_GUARD_MAX_FANOUT: 9999, DSH_LOOP_GUARD_REPEAT_LIMIT: 9999, DSH_LOOP_GUARD_SKELETON_LIMIT: 9999, DSH_LOOP_GUARD_CYCLE_LIMIT: 9999 };
	const files50 = Array.from({ length: 50 }, (_, index) => `f${index}`);

	// ① URL 里的 // 不能把同一行后面真正的 agent() 吃掉（字符串必须先剥）。
	const h = harness({ ...limits, DSH_LOOP_GUARD_MAX_WORKFLOW_AGENTS: 5 });
	const s = h.plain('c9-url');
	const urlLine = 'const u = "https://example.com/a//b"; for (const f of args.files) await agent("x" + f);';
	const urlArgs = { script: urlLine, args: { files: files50 } };
	const urlFirst = await h.call(s, 'workflow', urlArgs);
	check('含 URL 的场景：首超豁免一次并打 warn', allowed(urlFirst) && h.warned('一次性豁免'), brief(urlFirst));
	const over = await h.call(s, 'workflow', urlArgs);
	check('含 URL 的同一行里，for..of args.files 与 agent() 都被数到（先剥字符串再剥注释）', isDeny(over, 'LOOP_GUARD_WORKFLOW_FANOUT'), String(over?.reason ?? '').split('\n')[1] ?? brief(over));
	check('理由是「1 处 agent() × 50 条目 ≈ 50 个」的估算', String(over?.reason ?? '').includes('预计会扇出约 50 个'), String(over?.reason ?? '').slice(0, 160));

	// ② 乘数不再依赖 pipeline|parallel：裸 for..of 也要算。
	const h2 = harness({ ...limits, DSH_LOOP_GUARD_MAX_WORKFLOW_AGENTS: 5 });
	const s2 = h2.plain('c10-forof');
	const forOfArgs = { script: 'for (const f of args.files) { await agent("x" + f); }', args: { files: files50 } };
	const forOfFirst = await h2.call(s2, 'workflow', forOfArgs);
	check('裸 for..of：首超豁免一次并打 warn', allowed(forOfFirst) && h2.warned('一次性豁免'), brief(forOfFirst));
	const forOf = await h2.call(s2, 'workflow', forOfArgs);
	check('for (const f of args.files) 的 50 路扇出被算出来（老实现估成 1）', isDeny(forOf, 'LOOP_GUARD_WORKFLOW_FANOUT'), brief(forOf));

	// ③ 乘数上限 1000：5000 条目按 1000 算。
	const bigArgs = { script: 'for (const f of args.files) await agent("x" + f);', args: { files: Array.from({ length: 5000 }, (_, index) => index) } };
	const h3 = harness({ ...limits, DSH_LOOP_GUARD_MAX_WORKFLOW_AGENTS: 999 });
	const s3 = h3.plain('c10-cap');
	const capFirst = await h3.call(s3, 'workflow', bigArgs);
	check('5000 条目：首超豁免一次并打 warn', allowed(capFirst) && h3.warned('一次性豁免'), brief(capFirst));
	const big = await h3.call(s3, 'workflow', bigArgs);
	check('乘数受 Math.min(乘数, 1000) 约束：5000 条目按 1000 算', isDeny(big, 'LOOP_GUARD_WORKFLOW_FANOUT') && String(big?.reason ?? '').includes('预计会扇出约 1000 个'), String(big?.reason ?? '').slice(0, 160));
	const h4 = harness({ ...limits, DSH_LOOP_GUARD_MAX_WORKFLOW_AGENTS: 1001 });
	const s4 = h4.plain('c10-cap-ok');
	const under = await h4.call(s4, 'workflow', { script: 'for (const f of args.files) await agent("x" + f);', args: { files: Array.from({ length: 5000 }, (_, index) => index) } });
	check('上限 1001 时同一个脚本放行（证明算出来的真的是 1000 而不是更高）', allowed(under), brief(under));

	// ④ 注释里的 agent( 不算调用。
	const h5 = harness({ ...limits, DSH_LOOP_GUARD_MAX_WORKFLOW_AGENTS: 1 });
	const s5 = h5.plain('c10-comment');
	const commentedArgs = { script: '// agent(agent(agent(\n/* agent( */\nawait agent("真调用一"); await agent("真调用二");' };
	const commentedFirst = await h5.call(s5, 'workflow', commentedArgs);
	check('注释场景：首超豁免一次并打 warn', allowed(commentedFirst) && h5.warned('一次性豁免'), brief(commentedFirst));
	const commented = await h5.call(s5, 'workflow', commentedArgs);
	check('注释里的 agent( 不算调用：只数到真的 2 处', isDeny(commented, 'LOOP_GUARD_WORKFLOW_FANOUT') && String(commented?.reason ?? '').includes('预计会扇出约 2 个'), String(commented?.reason ?? '').slice(0, 160));
}

// ══════════ 22. 契约 C11：计数类阈值 <= 0 = 关闭该门 ══════════
//
// 所有判据都是 `已发生次数 >= 阈值`，阈值 = 0 时恒真 —— 不钳住的话
// 一个 `DSH_LOOP_GUARD_CYCLE_LIMIT=0` 就能让整个会话每一步都被拦。
{
	const wide = { DSH_LOOP_GUARD_MAX_DENIALS: 9999, DSH_LOOP_GUARD_REPEAT_LIMIT: 9999, DSH_LOOP_GUARD_READ_REPEAT_LIMIT: 9999, DSH_LOOP_GUARD_SKELETON_LIMIT: 9999, DSH_LOOP_GUARD_CYCLE_LIMIT: 9999 };

	const h = harness({ ...wide, DSH_LOOP_GUARD_CYCLE_LIMIT: 0 });
	const s = h.plain('c11-cycle');
	const cycles = [];
	for (let i = 0; i < 8; i += 1) cycles.push(await h.call(s, 'pwsh', { command: i % 2 === 0 ? 'echo AAA' : 'echo BBB' }));
	check('CYCLE_LIMIT=0 = 关掉乒乓门（连打 8 步都不拦）', cycles.every(allowed), seqBrief(cycles));

	const h2 = harness({ ...wide, DSH_LOOP_GUARD_REPEAT_LIMIT: 0, DSH_LOOP_GUARD_READ_REPEAT_LIMIT: 0 });
	const s2 = h2.plain('c11-repeat');
	const repeats = [];
	for (let i = 0; i < 6; i += 1) repeats.push(await h2.call(s2, 'read', { file_path: 'same.txt' }));
	check('REPEAT_LIMIT=0 = 关掉同签名门（同一次读取连做 6 次都不拦）', repeats.every(allowed), seqBrief(repeats));

	const h3 = harness({ ...wide, DSH_LOOP_GUARD_SKELETON_LIMIT: 0 });
	const s3 = h3.plain('c11-skeleton');
	const skeletons = [];
	for (let i = 1; i <= 8; i += 1) skeletons.push(await h3.call(s3, 'pwsh', { command: `probe --index ${i}` }));
	check('SKELETON_LIMIT=0 = 关掉同骨架门', skeletons.every(allowed), seqBrief(skeletons));

	const h4 = harness({ ...ONLY_SAME_ERROR, DSH_LOOP_GUARD_SAME_ERROR_LIMIT: 0, DSH_LOOP_GUARD_MAX_DENIALS: 9999 });
	const s4 = h4.plain('c11-sameerror');
	await h4.toolFail(s4, { name: 'pwsh', callId: 'c1', reason: 'boom ENOENT' });
	await h4.toolFail(s4, { name: 'pwsh', callId: 'c2', reason: 'boom ENOENT' });
	check('SAME_ERROR_LIMIT=0 = 关掉同错误门', allowed(await h4.call(s4, 'pwsh', { command: 'echo hi' })), '');
}

// ══════════ 23. 契约 C12：诊断日志真的落盘，写失败不许影响闸门 ══════════
//
// 日志路径必须在 import 之前指向 test/ 下（见文件头），所以这里写的是测试文件，
// 真日志 ~/.dsh/loop-guard.log 由最后一节验证「一个字节都没动」。
{
	const h = harness({
		DSH_LOOP_GUARD_PERSIST: 1,
		DSH_LOOP_GUARD_REPEAT_LIMIT: 1,
		DSH_LOOP_GUARD_READ_REPEAT_LIMIT: 1,
		DSH_LOOP_GUARD_MAX_DENIALS: 1,
		DSH_LOOP_GUARD_SKELETON_LIMIT: 9999,
		DSH_LOOP_GUARD_CYCLE_LIMIT: 9999
	});
	const s = h.plain('c12-log');
	await h.call(s, 'read', { file_path: 'log-a.txt' });
	await h.call(s, 'read', { file_path: 'log-a.txt' });
	await h.call(s, 'read', { file_path: 'log-a.txt' });
	check('逃生门放行时打了 warn', h.warned('逃生门放行'));
	const text = fs.existsSync(LOG_PATH) ? fs.readFileSync(LOG_PATH, 'utf8') : '';
	check('诊断日志文件真的写出来了', text !== '', LOG_PATH);
	check('日志里至少有「逃生门放行」那一条', text.includes('逃生门放行'), text.split('\n').slice(-3).join(' | ').slice(0, 200));

	// 注入失败：ctx.logger 一被调用就抛异常，判定必须照常。
	const h2 = harness(
		{ DSH_LOOP_GUARD_REPEAT_LIMIT: 1, DSH_LOOP_GUARD_READ_REPEAT_LIMIT: 1, DSH_LOOP_GUARD_MAX_DENIALS: 1 },
		{
			logger: {
				info() {
					throw new Error('logger 炸了');
				},
				warn() {
					throw new Error('logger 炸了');
				}
			}
		}
	);
	const s2 = h2.plain('c12-throw');
	const t1 = await h2.call(s2, 'read', { file_path: 't.txt' });
	const t2 = await h2.call(s2, 'read', { file_path: 't.txt' });
	const t3 = await h2.call(s2, 'read', { file_path: 't.txt' });
	check('ctx.logger 抛异常时闸门照常判定（日志永远不能影响主流程）', allowed(t1) && isDeny(t2, 'LOOP_GUARD_REPEAT') && allowed(t3), seqBrief([t1, t2, t3]));

	// 落盘关掉时连日志一起关（fileLog 复用 cfgPersist），闸门照常工作。
	const sizeBefore = fs.existsSync(LOG_PATH) ? fs.statSync(LOG_PATH).size : 0;
	const h3 = harness({ DSH_LOOP_GUARD_REPEAT_LIMIT: 1, DSH_LOOP_GUARD_READ_REPEAT_LIMIT: 1, DSH_LOOP_GUARD_MAX_DENIALS: 1 });
	const s3 = h3.plain('c12-nopersist');
	const n1 = await h3.call(s3, 'read', { file_path: 'n.txt' });
	const n2 = await h3.call(s3, 'read', { file_path: 'n.txt' });
	const n3 = await h3.call(s3, 'read', { file_path: 'n.txt' });
	const sizeAfter = fs.existsSync(LOG_PATH) ? fs.statSync(LOG_PATH).size : 0;
	check('关掉落盘时不再写诊断日志', sizeAfter === sizeBefore, `${sizeBefore} → ${sizeAfter}`);
	check('关掉落盘时闸门照常判定', allowed(n1) && isDeny(n2, 'LOOP_GUARD_REPEAT') && allowed(n3), seqBrief([n1, n2, n3]));
}

// ══════════ 24. 契约 C13：会话头用量徽标的只读端点 ══════════
//
// GET /api/loop-guard/usage?sessionId=<id> → 200 + 一份约定 JSON；
// 客户端半边（lib/client.js）每 1500ms 轮询它。这里不启真服务器，直接调 handler。
{
	const registered = [];
	const webServer = {
		register(spec) {
			registered.push(spec);
			return () => undefined;
		}
	};
	const h = harness({ DSH_LOOP_GUARD_MAX_DENIALS: 99 }, { webServer });
	check(
		'有 webServer 时注册了 /api/loop-guard/usage',
		registered.length === 1 && registered[0]?.path === '/api/loop-guard/usage',
		JSON.stringify(registered.map((spec) => spec?.path))
	);
	const handler = typeof registered[0]?.handler === 'function' ? registered[0].handler : registered[0]?.handler;
	const s = h.plain('c13-root');
	h.charge(s, 1_000_000, 1);
	const known = await httpGet(handler, '/api/loop-guard/usage?sessionId=c13-root');
	const body = known.body ?? {};
	check('已知会话：200 + ok:true', known.status === 200 && body.ok === true, `${known.status} ${String(known.raw).slice(0, 120)}`);
	check('session.totalInput = 1000000', body.session?.totalInput === 1_000_000, JSON.stringify(body.session));
	check('turn.total = 本轮输入（input + familyTurnInput）', body.turn?.total === 1_000_000, JSON.stringify(body.turn));
	check('limits 带 maxTokens / sessionMaxTokens', body.limits?.maxTokens === 100_000_000 && body.limits?.sessionMaxTokens === 1_000_000_000, JSON.stringify(body.limits));
	check(
		'tripped 是三个布尔（turn / session / family），不是数组',
		typeof body.tripped?.turn === 'boolean' && typeof body.tripped?.session === 'boolean' && typeof body.tripped?.family === 'boolean',
		JSON.stringify(body.tripped)
	);
	check('updatedAt 是数字时间戳', typeof body.updatedAt === 'number', String(body.updatedAt));

	h.charge(s, 105_000_000, 1);
	const trippedBody = (await httpGet(handler, '/api/loop-guard/usage?sessionId=c13-root')).body ?? {};
	check('到线之后端点里看得见（tripped.turn = true）', trippedBody.tripped?.turn === true, JSON.stringify(trippedBody.tripped));

	const missing = await httpGet(handler, '/api/loop-guard/usage');
	check('缺 sessionId：400 + ok:false + sessionId-required', missing.status === 400 && missing.body?.ok === false && missing.body?.error === 'sessionId-required', `${missing.status} ${String(missing.raw).slice(0, 120)}`);

	const unknown = await httpGet(handler, '/api/loop-guard/usage?sessionId=does-not-exist');
	check('未知会话：200 且计数全 0（不是 404）', unknown.status === 200 && unknown.body?.ok === true && unknown.body?.session?.totalInput === 0 && unknown.body?.turn?.total === 0, `${unknown.status} ${String(unknown.raw).slice(0, 120)}`);

	// 宿主没有 webServer 时，apply() 必须还能装上闸门（不能因为拿不到 webServer 就整体失败）。
	const bare = harness();
	check('宿主没有 webServer 时 apply() 不抛异常、闸门照常装上', bare.hasPre === true);
}

// ══════════ 25. 契约 C14：不回归（计费口径、记账异常） ══════════
{
	// ① 计费输入 = inputTokens + cacheReadTokens + cacheWriteTokens。
	//    光看 inputTokens 会低报一个数量级 —— 这正是「到线了却没人拦」的成因之一。
	const h = harness({ DSH_LOOP_GUARD_MAX_TOKENS: 10_000_000, DSH_LOOP_GUARD_MAX_DENIALS: 9999 });
	const s = h.plain('c14-billing');
	h.event(s, {
		type: 'assistant/chunk',
		data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 1_000_000, cacheReadTokens: 8_000_000, cacheWriteTokens: 1_000_000, outputTokens: 0 } } }
	});
	check(
		'计费口径含缓存：1M + 8M + 1M = 10M 到线（只看 inputTokens 只有 1M，不会拦）',
		isDeny(await h.call(s, 'read', { file_path: 'b1.txt' }), 'LOOP_GUARD_BUDGET_EXHAUSTED'),
		''
	);

	// ⑥ 记账失败不许拦住会话：畸形事件既不能抛出来，也不能让守卫变哑巴。
	const h2 = harness();
	const s2 = h2.plain('c14-malformed');
	let threw = '';
	try {
		for (const bad of [null, undefined, { type: 'assistant/chunk' }, { type: 'assistant/chunk', data: null }, { type: 'assistant/chunk', data: { chunk: { type: 'usage', usage: { inputTokens: 'x', cacheReadTokens: null } } } }, { type: 'tool/result', data: null }, { type: 'session/event' }, { type: 'assistant/chunk', data: { turn: 'nope', chunk: { type: 'usage', usage: {} } } }]) {
			h2.event(s2, bad);
		}
	} catch (error) {
		threw = String(error?.message ?? error);
	}
	check('畸形事件（null / 缺 data / usage 字段是字符串）不会抛出来', threw === '', threw);
	check('记账异常之后闸门照常工作', allowed(await h2.call(s2, 'read', { file_path: 'after-throw.txt' })), '');
}

// ══════════ 26. 测试隔离：真账本与真日志一个字节都不许动 ══════════
{
	const stateAfter = snapshot(REAL_STATE);
	const logAfter = snapshot(REAL_LOG);
	check(`测试全程没有写/改真账本（${REAL_STATE}）`, stateAfter === realStateBefore, stateAfter === realStateBefore ? '' : '真账本被改动了');
	check(`测试全程没有写/改真日志（${REAL_LOG}）`, logAfter === realLogBefore, logAfter === realLogBefore ? '' : '真日志被改动了');
	for (const file of [STATE_PATH, LOG_PATH, `${STATE_PATH}.tmp`]) {
		if (fs.existsSync(file)) fs.rmSync(file, { force: true });
	}
}

// ────────────────────────────── 汇总 ──────────────────────────────

let failed = 0;
for (const [status, label, extra] of results) {
	if (status === 'FAIL') failed += 1;
	console.log(`${status}  ${label}${extra === '' ? '' : `   [${extra}]`}`);
}
console.log(`\n通过 ${results.length - failed}/${results.length}`);
process.exit(failed === 0 ? 0 : 1);
