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
	'DSH_LOOP_GUARD_PURE_TALK_TOKENS',
	'DSH_LOOP_GUARD_PURE_TALK_GUARD',
	'DSH_LOOP_GUARD_SAME_ERROR_UNKNOWN_LIMIT',
	'DSH_LOOP_GUARD_VETO_NEW_TURN',
	'DSH_LOOP_GUARD_PERSIST',
	'DSH_LOOP_GUARD_NO_PERSIST',
	'DSH_LOOP_GUARD_SOFT_LANDING',
	// 消耗估算的两个 env：一个开关、一张价目表。必须跟着别的配置一起清干净，
	// 否则某个场景里关掉的 COST / 换掉的价目表会串到下一个场景。
	'DSH_LOOP_GUARD_COST',
	'DSH_LOOP_GUARD_PRICE_TABLE',
	'DSH_LOOP_GUARD_OFF'
];

const results = [];
const check = (label, ok, extra = '') => results.push([ok ? 'PASS' : 'FAIL', label, extra]);

const next = async () => ({ kind: 'ok' });

/** 一条只带 output 的 usage 事件：E1 纯输出门看的是 turnOutput，而 charge() 那个助手只喂 input。 */
const outputUsage = (tokens, turn = 1) => ({
	type: 'assistant/chunk',
	data: {
		turn,
		step: 1,
		chunk: { type: 'usage', usage: { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: tokens } }
	}
});

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
		/** 原样的 agent/pre-step handler：用来自己塞一个带 spy 的 next()，验证「放行」不是空话。 */
		rawStep: stepHandler,
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
	// 这一块测的是**会话**预算（默认 10 亿）：本轮上限显式抬到 10 亿，
	// 否则 90M/轮 已经越过单轮 60M 的硬顶，本轮门先响，测到的就不是会话门了。
	const h = harness({ DSH_LOOP_GUARD_VETO_NEW_TURN: 1, DSH_LOOP_GUARD_MAX_TOKENS: 1_000_000_000 });
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
	// 控制组：自己 2500 万 + 子代理 2500 万 = 5000 万，还没到默认的 6000 万。
	const ok = harness();
	const okRoot = ok.plain('g1b-root');
	const okChild = ok.sub('g1b-child', 'g1b-root');
	ok.charge(okRoot, 25_000_000, 1);
	ok.charge(okChild, 25_000_000, 1);
	const stillOk = await ok.call(okRoot, 'read', { file_path: 'a.txt' });
	check('本轮自己 2500 万 + 子代理 2500 万 = 5000 万，仍放行', allowed(stillOk), JSON.stringify(stillOk)?.slice(0, 60));

	// 实验组：子代理换成 4000 万，合计 6500 万 —— 越过默认 6000 万，父自己下一次调用就该被拦。
	const h = harness();
	const root = h.plain('g1c-root');
	const child = h.sub('g1c-child', 'g1c-root');
	h.charge(root, 25_000_000, 1);
	h.charge(child, 40_000_000, 1);
	const over = await h.call(root, 'read', { file_path: 'b.txt' });
	check('本轮含子代理越过 6000 万后被拦（只算自己的旧行为会放行）', isDeny(over, 'LOOP_GUARD_BUDGET_EXHAUSTED'));
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

// ══════════ 2. agent/pre-step 无条件注册，但默认不否决 ══════════
//
// 1.1.7 起这个钩子是**无条件**注册的（纯输出门要靠它停止生成）。
// 「用户不会被静默否决」这条安全属性必须继续成立，所以这里断言的是**行为**：
// 注册了不等于会否决 —— 默认条件下它必须放行，并且把 next() 交回去。
{
	const byDefault = harness();
	check('默认注册了 agent/pre-step（纯输出门需要它）', byDefault.hasStep === true);
	const s = byDefault.plain('veto-default-root');
	let nextCalled = 0;
	const verdict = await byDefault.rawStep({ agent: { session: s }, turn: 1, step: 1, signal: undefined }, async () => {
		nextCalled += 1;
		return { kind: 'ok' };
	});
	check(
		'默认不否决：不返回 reject，且真的放行（next 被调用）',
		verdict?.kind !== 'reject' && nextCalled === 1,
		`verdict=${JSON.stringify(verdict)} nextCalled=${nextCalled}`
	);

	const h = harness({ DSH_LOOP_GUARD_VETO_NEW_TURN: 0 });
	check('显式关掉 vetoNewTurn 时这个钩子照样在（注册与否不是开关的语义）', h.hasStep === true);
	const s2 = h.plain('veto-off-root');
	let nextCalled2 = 0;
	const verdict2 = await h.rawStep({ agent: { session: s2 }, turn: 2, step: 1, signal: undefined }, async () => {
		nextCalled2 += 1;
		return { kind: 'ok' };
	});
	check(
		'关掉 vetoNewTurn 后同样不否决（不返回 reject，且真的放行）',
		verdict2?.kind !== 'reject' && nextCalled2 === 1,
		`verdict=${JSON.stringify(verdict2)} nextCalled=${nextCalled2}`
	);

	// 反证：上面两条不是「这个钩子永远放行」的空断言 ——
	// 把 vetoNewTurn 打开、并且真的把会话预算烧穿，它必须否决新一轮。
	const armed = harness({ DSH_LOOP_GUARD_VETO_NEW_TURN: 1, DSH_LOOP_GUARD_SESSION_MAX_TOKENS: 1, DSH_LOOP_GUARD_MAX_DENIALS: 99 });
	const s3 = armed.plain('veto-armed-root');
	armed.charge(s3, 5_000_000, 1);
	const tripped = await armed.call(s3, 'read', { file_path: 'x.txt' });
	check('反证前置：先把会话预算烧穿（会话门拦下）', isDeny(tripped, 'LOOP_GUARD_SESSION_BUDGET'), brief(tripped));
	let nextCalled3 = 0;
	const veto = await armed.rawStep({ agent: { session: s3 }, turn: 2, step: 1, signal: undefined }, async () => {
		nextCalled3 += 1;
		return { kind: 'ok' };
	});
	check(
		'反证：开着 vetoNewTurn 且已熔断时，新一轮真的被否决（reject 且不放行）',
		veto?.kind === 'reject' && nextCalled3 === 0,
		`verdict=${JSON.stringify(veto)} nextCalled=${nextCalled3}`
	);
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
		registered.some(spec => spec.path === '/api/loop-guard/usage') && new Set(registered.map(spec => spec.path)).size === registered.length,
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
	check('limits 带 maxTokens / sessionMaxTokens', body.limits?.maxTokens === 60_000_000 && body.limits?.sessionMaxTokens === 1_000_000_000, JSON.stringify(body.limits));
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

// ══════════ 27. E1 纯输出门：命中条件 / 停止生成 + deny / 白名单永远放行 ══════════
{
	const relax = {
		DSH_LOOP_GUARD_PURE_TALK_TOKENS: 1000,
		DSH_LOOP_GUARD_REPEAT_LIMIT: 99,
		DSH_LOOP_GUARD_READ_REPEAT_LIMIT: 99,
		DSH_LOOP_GUARD_SKELETON_LIMIT: 99,
		DSH_LOOP_GUARD_CYCLE_LIMIT: 99,
		DSH_LOOP_GUARD_MAX_DENIALS: 99
	};

	// (1) 命中：本轮没有任何工具调用，只累计 output ≥ 阈值（**经典情形**：旧口径也命中）
	const h = harness({ ...relax });
	const s = h.plain('e1-hit');
	h.event(s, outputUsage(5000, 1));
	const veto = await h.step(s, 1);
	check('E1 命中：agent/pre-step 返回 reject（停止生成）', veto?.kind === 'reject', JSON.stringify(veto));
	const denied = await h.call(s, 'write', { file_path: 'x.txt' });
	check('E1 命中：非白名单工具被 deny，code = LOOP_GUARD_SETTLE_REQUIRED', isDeny(denied, 'LOOP_GUARD_SETTLE_REQUIRED'), brief(denied));
	check(
		'E1 命中：拒绝文案里带门类别与数值（5000 / 阈值 1000）',
		['只有输出', '5000', '1000'].every((needle) => String(denied?.reason ?? '').includes(needle)),
		String(denied?.reason ?? '').split('\n')[0]
	);
	const secondDeny = await h.call(s, 'edit', { file_path: 'y.txt' });
	check('E1 命中：同一轮第二次拒绝换成一行短版', isDeny(secondDeny, 'LOOP_GUARD_SETTLE_REQUIRED') && !String(secondDeny.reason).includes('\n'), String(secondDeny?.reason ?? ''));
	const wl = [await h.call(s, 'todo_write', { todos: [] }), await h.call(s, 'get_goal', {}), await h.call(s, 'search_context', { query: 'x' })];
	check('E1 白名单（NEVER_BLOCK）永远放行：交账/诊断手段不能被一起堵死', wl.every(allowed), seqBrief(wl));

	// (2) 命中：**先真执行过一次工具调用**（游标推进），此后只累计输出 ≥ 阈值 → 照常命中。
	//     旧口径（`turnToolCalls === 0`）在这一段是**放行**的 —— 这条断言就是新判据的判别力所在：
	//     「先调一次工具、再狂喷输出打转」不再能靠一次工具调用买到整轮的免检。
	const h2 = harness({ ...relax });
	const s2 = h2.plain('e1-tooled');
	const tooled = await h2.call(s2, 'write', { file_path: 'ok.txt' });
	h2.event(s2, outputUsage(5000, 1));
	const tooledStep = await h2.step(s2, 1);
	const tooledAgain = await h2.call(s2, 'edit', { file_path: 'ok2.txt' });
	check('E1 新判据：先真执行过一次工具调用、此后只输出到量 → 照常命中（停止生成 + 拦工具）', allowed(tooled) && tooledStep?.kind === 'reject' && isDeny(tooledAgain, 'LOOP_GUARD_SETTLE_REQUIRED'), seqBrief([tooled, tooledStep, tooledAgain]));
	check(
		'E1 新判据：文案说的是「自本轮上一次真的执行过工具调用以来」（不再说「一次工具调用都没有」）',
		['自本轮上一次真的执行过工具调用以来', '这期间没有再执行过工具'].every((needle) => String(tooledAgain?.reason ?? '').includes(needle)) && !String(tooledAgain?.reason ?? '').includes('一次非白名单工具调用都没有'),
		String(tooledAgain?.reason ?? '').split('\n')[1] ?? ''
	);

	// (3) 负例：**工具与输出交替**（每次输出都没到阈值）→ 一次都不命中。
	//     证明「一边干活一边产出」不受影响：每执行一次工具，判据的起点就重新起算。
	const h3 = harness({ ...relax });
	const s3 = h3.plain('e1-alternate');
	const round1 = await h3.call(s3, 'write', { file_path: 'a1.txt' });
	h3.event(s3, outputUsage(600, 1));
	const quietStep1 = await h3.step(s3, 1);
	const round2 = await h3.call(s3, 'edit', { file_path: 'a2.txt' });
	h3.event(s3, outputUsage(700, 1));
	const quietStep2 = await h3.step(s3, 1);
	const round3 = await h3.call(s3, 'edit', { file_path: 'a3.txt' });
	check(
		'E1 负例：工具与输出交替（每次输出 600/700 都没到阈值 1000）→ 不命中（本轮总输出已 1300，只看累计量早就误伤了）',
		[round1, quietStep1, round2, quietStep2, round3].every(allowed),
		seqBrief([round1, quietStep1, round2, quietStep2, round3])
	);

	// (4) 只满足一半：没调过工具，但输出没到阈值
	const h4 = harness({ ...relax });
	const s4 = h4.plain('e1-quiet');
	h4.event(s4, outputUsage(500, 1));
	const quietStep = await h4.step(s4, 1);
	const quietCall = await h4.call(s4, 'write', { file_path: 'q.txt' });
	check('E1 只满足一半不算：没调工具但输出没到阈值 → 不拦', allowed(quietStep) && allowed(quietCall), seqBrief([quietStep, quietCall]));

	// (5) 两个开关：都关掉这道门（计数与统计照旧）
	const offGuard = harness({ ...relax, DSH_LOOP_GUARD_PURE_TALK_GUARD: 0 });
	const og = offGuard.plain('e1-off-guard');
	offGuard.event(og, outputUsage(5000, 1));
	const ogStep = await offGuard.step(og, 1);
	const ogCall = await offGuard.call(og, 'write', { file_path: 'x.txt' });
	check(
		'E1 开关：DSH_LOOP_GUARD_PURE_TALK_GUARD=0 → 这道门不动作（不否决、不拦、不告警）',
		allowed(ogStep) && allowed(ogCall) && !offGuard.warned('纯输出门命中'),
		seqBrief([ogStep, ogCall])
	);
	const offTokens = harness({ ...relax, DSH_LOOP_GUARD_PURE_TALK_TOKENS: 0 });
	const ot = offTokens.plain('e1-off-tokens');
	offTokens.event(ot, outputUsage(5_000_000, 1));
	const otStep = await offTokens.step(ot, 1);
	const otCall = await offTokens.call(ot, 'write', { file_path: 'x.txt' });
	check(
		'E1 开关：DSH_LOOP_GUARD_PURE_TALK_TOKENS=0 → 这道门不动作',
		allowed(otStep) && allowed(otCall) && !offTokens.warned('纯输出门命中'),
		seqBrief([otStep, otCall])
	);

	// ── 记账口径（P1-1 的回归）：只读用量端点读计数，别拿内存账本当断言 ───────────────
	// 「被拦下的调用不记账」这件事的判别力就落在 E1a 上：E1a 拦下的调用走不到任何放行出口，
	// 所以它既不加 `toolCalls`、也不推水位游标 —— 命中之后每一条非白名单调用都还该被拦。
	/** 带用量端点的 harness：断言只读那本账（工具调用数），不去读内存里的账本。 */
	const endpointHarness = (env) => {
		const registered = [];
		const h = harness(env, {
			webServer: {
				register(spec) {
					registered.push(spec);
					return () => undefined;
				}
			}
		});
		return {
			h,
			usage: async (sessionId) => (await httpGet(registered[0].handler, `/api/loop-guard/usage?sessionId=${encodeURIComponent(sessionId)}`)).body?.session ?? {}
		};
	};

	// (6) 被 ⓪ 拦下的调用：`toolCalls` 一个都不加（否则徽标与配额会被没执行过的调用吃掉）
	const six = endpointHarness(relax);
	const s6 = six.h.plain('e1-account-hit');
	six.h.event(s6, outputUsage(5000, 1));
	const sixDeny1 = await six.h.call(s6, 'write', { file_path: 'acct1.txt' });
	const sixDeny2 = await six.h.call(s6, 'edit', { file_path: 'acct2.txt' });
	const sixUsage = await six.usage('e1-account-hit');
	check(
		'E1 记账：被纯输出门拦下的调用不记 `toolCalls`，而且拦第二次时判据一个字节都没变（仍命中）',
		isDeny(sixDeny1, 'LOOP_GUARD_SETTLE_REQUIRED') && isDeny(sixDeny2, 'LOOP_GUARD_SETTLE_REQUIRED') && sixUsage.toolCalls === 0,
		`${seqBrief([sixDeny1, sixDeny2])} toolCalls=${String(sixUsage.toolCalls)}`
	);

	// (7) 放行执行的调用：`toolCalls` +1（而 `turnToolCalls` 一 +1，水位游标就重新起算）
	const seven = endpointHarness(relax);
	const s7 = seven.h.plain('e1-account-allow');
	const sevenAllow = await seven.h.call(s7, 'write', { file_path: 'acct-ok.txt' });
	const sevenAfter = await seven.usage('e1-account-allow');
	check(
		'E1 记账：放行执行的调用 `toolCalls` 恰好 +1',
		allowed(sevenAllow) && sevenAfter.toolCalls === 1,
		`${brief(sevenAllow)} toolCalls=${String(sevenAfter.toolCalls)}`
	);
	// 反证「真的干过活」与「单纯执行」不是同一个计数：同一会话接着狂输出，照样命中。
	seven.h.event(s7, outputUsage(5000, 1));
	const sevenDeny = await seven.h.call(s7, 'edit', { file_path: 'acct-ok2.txt' });
	check('E1 记账：「干活」与「执行」不是一个计数 —— 执行过一次之后再狂输出照样命中', isDeny(sevenDeny, 'LOOP_GUARD_SETTLE_REQUIRED'), brief(sevenDeny));

	// (8) 交账白名单工具：`toolCalls` +1，但「本轮干过活」计数**不变**（水位游标不动）。
	//     反证：白名单之外的活（edit）依旧会被拦 —— 如果交账工具推了游标，下面这一条就该放行。
	const eight = endpointHarness(relax);
	const s8 = eight.h.plain('e1-account-whitelist');
	const eightTool = await eight.h.call(s8, 'write', { file_path: 'wl-ok.txt' });
	const eightTodo = await eight.h.call(s8, 'todo_write', { todos: [] });
	eight.h.event(s8, outputUsage(5000, 1));
	const eightDeny = await eight.h.call(s8, 'edit', { file_path: 'wl-after.txt' });
	const eightUsage = await eight.usage('e1-account-whitelist');
	check(
		'E1 记账：交账白名单工具 `toolCalls` +1，但「本轮干过活」计数不变（E1a 交账之后照常命中）',
		[eightTool, eightTodo].every(allowed) && isDeny(eightDeny, 'LOOP_GUARD_SETTLE_REQUIRED') && eightUsage.toolCalls === 2,
		`${seqBrief([eightTool, eightTodo, eightDeny])} toolCalls=${String(eightUsage.toolCalls)}`
	);

	// (9) 被 ⑪ 同签名门拦下的一次调用：`toolCalls` 不 +1。
	//     区分力：两次同签名调用里**只有第一次真的执行过**，第二次是被拦的重复调用。
	const nine = endpointHarness({ ...relax, DSH_LOOP_GUARD_REPEAT_LIMIT: 1, DSH_LOOP_GUARD_READ_REPEAT_LIMIT: 1 });
	const s9 = nine.h.plain('e1-account-repeat');
	const nineFirst = await nine.h.call(s9, 'read', { file_path: 'same-acct.txt' });
	const nineSecond = await nine.h.call(s9, 'read', { file_path: 'same-acct.txt' });
	const nineUsage = await nine.usage('e1-account-repeat');
	check(
		'E1 记账：被 ⑪ 同签名门拦下的调用不加 `toolCalls`（只有那一次真的执行过）',
		allowed(nineFirst) && isDeny(nineSecond, 'LOOP_GUARD_REPEAT') && nineUsage.toolCalls === 1,
		`${seqBrief([nineFirst, nineSecond])} toolCalls=${String(nineUsage.toolCalls)}`
	);
}

// ══════════ 28. E2 拒绝文案：同一道门首次完整 / 后续一行短版 ══════════
{
	const h = harness({
		DSH_LOOP_GUARD_REPEAT_LIMIT: 1,
		DSH_LOOP_GUARD_READ_REPEAT_LIMIT: 1,
		DSH_LOOP_GUARD_SKELETON_LIMIT: 99,
		DSH_LOOP_GUARD_MAX_DENIALS: 99
	});
	const s = h.plain('e2-repeat');
	await h.call(s, 'read', { file_path: 'same.txt' });
	const full = await h.call(s, 'read', { file_path: 'same.txt' });
	const short = await h.call(s, 'read', { file_path: 'same.txt' });
	check(
		'E2 同一道门首次拒绝：完整文案（多行、说清根因和怎么出去）',
		isDeny(full, 'LOOP_GUARD_REPEAT') && String(full.reason).includes('\n') && full.reason.length > String(short.reason).length,
		`${brief(full)} 行数=${String(full?.reason ?? '').split('\n').length}`
	);
	check(
		'E2 同一道门后续拒绝：一行短版（含门类别、关键数值与要它做什么）',
		isDeny(short, 'LOOP_GUARD_REPEAT') && !String(short.reason).includes('\n') && short.reason.includes('【防烧钱 · ') && short.reason.includes('阈值'),
		String(short?.reason ?? '')
	);
	check('E2 重复签名类：完整版与短版都保留「放行那一次紧接着原样再发也放行」这句承诺', full.reason.includes('紧接着') && short.reason.includes('紧接着'), '');

	// 配额类（一次性豁免那一类）不得出现这句承诺
	const q = harness({
		DSH_LOOP_GUARD_MAX_SUBAGENT_REQUESTS: 1,
		DSH_LOOP_GUARD_MAX_DENIALS: 99,
		DSH_LOOP_GUARD_REPEAT_LIMIT: 99,
		DSH_LOOP_GUARD_READ_REPEAT_LIMIT: 99,
		DSH_LOOP_GUARD_SKELETON_LIMIT: 99
	});
	const sub = q.sub('e2-sub', 'e2-root');
	q.created(sub);
	q.modelCall(sub);
	const exempted = await q.call(sub, 'read', { file_path: 'q1.txt' });
	const blocked = await q.call(sub, 'read', { file_path: 'q2.txt' });
	check('E2 配额类：首次超配额走一次性豁免（放行一次）', allowed(exempted) && q.warned('一次性豁免'), brief(exempted));
	check(
		'E2 配额类文案里不得出现「原样再发也放行」这句承诺',
		isDeny(blocked, 'LOOP_GUARD_SUBAGENT_REQUESTS') && !String(blocked.reason).includes('紧接着') && !String(blocked.reason).includes('原样再发'),
		brief(blocked)
	);
}

// ══════════ 29. E4 统计三处计数 + 会话收尾 info 摘要 ══════════
{
	const h = harness({
		DSH_LOOP_GUARD_REPEAT_LIMIT: 1,
		DSH_LOOP_GUARD_READ_REPEAT_LIMIT: 1,
		DSH_LOOP_GUARD_MAX_DENIALS: 1,
		DSH_LOOP_GUARD_SKELETON_LIMIT: 99,
		DSH_LOOP_GUARD_MAX_FANOUT: 1
	});
	const s = h.plain('e4-root');
	const liveChild = h.sub('e4-child', 'e4-root');
	h.created(liveChild);
	await h.call(s, 'read', { file_path: 'same.txt' });
	const denied = await h.call(s, 'read', { file_path: 'same.txt' });
	const released = await h.call(s, 'read', { file_path: 'same.txt' });
	check('E4 亲拦计数：第 2 次被拦', isDeny(denied, 'LOOP_GUARD_REPEAT'), brief(denied));
	check('E4 逃生门放行计数：第 3 次按保险丝放行一次', allowed(released) && h.warned('逃生门放行'), brief(released));
	const exempted = await h.call(s, 'subagent', { prompt: 'x' });
	check('E4 配额豁免计数：扇出上限 1、已活着 1 个 → 首次超配额一次性豁免', allowed(exempted) && h.warned('一次性豁免'), brief(exempted));
	h.disposed(s);
	const summary = h.logs.find(([level, text]) => level === 'info' && text.includes('会话收尾摘要'))?.[1] ?? '';
	check('E4 会话收尾写一条 info 摘要：被拦 / 放行 / 豁免', summary.includes('被拦 1 次') && summary.includes('逃生门放行 1 次') && summary.includes('配额豁免 1 次'), summary);
	check('E4 摘要还带请求数、轮次与 token 量', summary.includes('模型请求') && summary.includes('轮次') && summary.includes('累计计费输入') && summary.includes('token'), summary);
}

// ══════════ 30. B2 受限降级：认不出报错工具名时只让这一分支失效 ══════════
{
	const h = harness({
		DSH_LOOP_GUARD_SAME_ERROR_LIMIT: 1,
		DSH_LOOP_GUARD_SAME_ERROR_UNKNOWN_LIMIT: 3,
		DSH_LOOP_GUARD_MAX_DENIALS: 9,
		DSH_LOOP_GUARD_REPEAT_LIMIT: 99,
		DSH_LOOP_GUARD_READ_REPEAT_LIMIT: 99,
		DSH_LOOP_GUARD_SKELETON_LIMIT: 99,
		DSH_LOOP_GUARD_CYCLE_LIMIT: 99,
		DSH_LOOP_GUARD_PERSIST: 1
	});
	const s = h.plain('b2-root');
	// 错误事件里没有工具名、callId 也没登记过 → 认不出报错工具名，只能全局拦
	h.toolFail(s, { callId: 'u1', reason: 'boom one' });
	const d1 = await h.call(s, 'read', { file_path: 'r1.txt' });
	const d2 = await h.call(s, 'write', { file_path: 'w1.txt' });
	const d3 = await h.call(s, 'read', { file_path: 'r2.txt' });
	check('B2 认不出报错工具名时是全局拦：工具 A、B 都被这个门拦', [d1, d2, d3].every((v) => isDeny(v, 'LOOP_GUARD_SAME_ERROR')), seqBrief([d1, d2, d3]));
	const after = [await h.call(s, 'write', { file_path: 'w2.txt' }), await h.call(s, 'read', { file_path: 'r3.txt' })];
	check('B2 连拦 3 次（DSH_LOOP_GUARD_SAME_ERROR_UNKNOWN_LIMIT 默认 3）后只让这一分支失效：A、B 都不再被这一支拦', after.every(allowed), seqBrief(after));
	check('B2 降级时吼一声（不静默松开）', h.warned('受限降级'), '');
	// 另一条分支照常：一旦认出了具体的报错工具名，对它的同错误拦截仍然生效
	h.toolCall(s, 'read', 'c9');
	h.toolFail(s, { name: 'read', callId: 'c9', reason: 'boom two' });
	const readBlocked = await h.call(s, 'read', { file_path: 'r4.txt' });
	const writeOk = await h.call(s, 'write', { file_path: 'w3.txt' });
	check('B2 认出工具名后：read 这条分支恢复拦截', isDeny(readBlocked, 'LOOP_GUARD_SAME_ERROR'), brief(readBlocked));
	check('B2 同一次里另一条分支照常（write 不被这个门拦）', allowed(writeOk), brief(writeOk));
	h.disposed(s);
	const stateText = fs.existsSync(STATE_PATH) ? fs.readFileSync(STATE_PATH, 'utf8') : '';
	check('B2 降级不落盘（重启即恢复）：存档里没有任何降级标记', stateText.includes('"version"') && !stateText.includes('degraded') && !stateText.includes('unknownTool'), '');
}

// ══════════ 31. B1 同骨架逃生分键 + E10 单槽豁免（重复类门） ══════════
{
	const h = harness({
		DSH_LOOP_GUARD_SKELETON_LIMIT: 1,
		DSH_LOOP_GUARD_MAX_DENIALS: 1,
		DSH_LOOP_GUARD_REPEAT_LIMIT: 99,
		DSH_LOOP_GUARD_READ_REPEAT_LIMIT: 99,
		DSH_LOOP_GUARD_CYCLE_LIMIT: 99
	});
	const s = h.plain('b1-root');
	await h.call(s, 'read', { file_path: 'a-one.txt' });
	const aDeny = await h.call(s, 'read', { file_path: 'a-one.txt' });
	check('B1 骨架 A 到线：被拦', isDeny(aDeny, 'LOOP_GUARD_SKELETON'), brief(aDeny));
	await h.call(s, 'read', { file_path: 'b-one.txt' });
	const bDeny = await h.call(s, 'read', { file_path: 'b-one.txt' });
	check('B1 全新骨架 B 第一次到线仍被拦（逃生计数按骨架分键，不再共用固定键）', isDeny(bDeny, 'LOOP_GUARD_SKELETON'), brief(bDeny));
	check('B1 分键的证据：两次拒绝各报各的骨架', String(aDeny.reason).includes('a-one.txt') && String(bDeny.reason).includes('b-one.txt'), `${brief(aDeny)} / ${brief(bDeny)}`);
	const aEscape = await h.call(s, 'read', { file_path: 'a-one.txt' });
	check('B1 骨架 A 连拦到上限后放行一次（保险丝）', allowed(aEscape), brief(aEscape));
	const slot = await h.call(s, 'read', { file_path: 'a-one.txt' });
	check('E10 放行那一次紧接着的同签名一次仍放行（单槽 escapeSig）', allowed(slot), brief(slot));
	const afterSlot = await h.call(s, 'read', { file_path: 'a-one.txt' });
	check('E10 单槽只用一次：再下一次照样被拦', isDeny(afterSlot, 'LOOP_GUARD_SKELETON'), brief(afterSlot));
}

// ══════════ 32. E10 outlier 门：放行后紧接着发同签名必须放行 ══════════
{
	const h = harness({
		DSH_LOOP_GUARD_OUTLIER_RATIO: 5,
		DSH_LOOP_GUARD_OUTLIER_MIN_SIBLINGS: 3,
		DSH_LOOP_GUARD_OUTLIER_FLOOR_TOKENS: 1000,
		DSH_LOOP_GUARD_MAX_DENIALS: 3,
		DSH_LOOP_GUARD_MAX_SUBAGENT_REQUESTS: 9999,
		DSH_LOOP_GUARD_MAX_SUBAGENT_TOOLS: 9999,
		DSH_LOOP_GUARD_REPEAT_LIMIT: 99,
		DSH_LOOP_GUARD_READ_REPEAT_LIMIT: 99,
		DSH_LOOP_GUARD_SKELETON_LIMIT: 99,
		DSH_LOOP_GUARD_CYCLE_LIMIT: 99
	});
	for (const id of ['e10-s1', 'e10-s2', 'e10-s3']) {
		const sib = h.sub(id, 'e10-root');
		h.created(sib);
		h.charge(sib, 1_000_000, 1);
	}
	const odd = h.sub('e10-odd', 'e10-root');
	h.created(odd);
	h.charge(odd, 10_000_000, 1);
	const seq = [];
	for (let i = 0; i < 4; i += 1) seq.push(await h.call(odd, 'read', { file_path: 'z.txt' }));
	check('E10 前置：outlier 门连拦到 maxDenials 后放行一次', seq.slice(0, 3).every((v) => isDeny(v, 'LOOP_GUARD_OUTLIER')) && allowed(seq[3]), seqBrief(seq));
	const resend = await h.call(odd, 'read', { file_path: 'z.txt' });
	check('E10 outlier 门放行后紧接着发同签名：必须放行（单槽 escapeSig）', allowed(resend), brief(resend));
	const later = await h.call(odd, 'read', { file_path: 'z.txt' });
	check('E10 再下一次仍被拦（单槽只用一次）', isDeny(later, 'LOOP_GUARD_OUTLIER'), brief(later));
}

// ══════════ 33. G6 每轮自比异常：只写 warn，不产生 deny ══════════
{
	const h = harness({
		DSH_LOOP_GUARD_OUTLIER_RATIO: 5,
		DSH_LOOP_GUARD_OUTLIER_FLOOR_TOKENS: 1000,
		DSH_LOOP_GUARD_OUTLIER_MIN_SIBLINGS: 3
	});
	const odd = h.sub('g6-odd', 'g6-root');
	h.created(odd);
	h.charge(odd, 1_000_000, 1);
	h.charge(odd, 10_000_000, 2);
	check('G6 本轮计费输入远超本会话已结束轮次中位数：写一条 warn', h.warned('只告警不拦截'), h.logs.map(([, text]) => text).join(' | ').slice(0, 240));
	check('G6 这条 warn 点明是「和中位数比」而不是别的原因', h.warned('中位数'), '');
	check('G6 只告警一次（不是每轮刷屏）', h.logs.filter(([, text]) => text.includes('只告警不拦截')).length === 1, String(h.logs.filter(([, text]) => text.includes('只告警不拦截')).length));
	const verdict = await h.call(odd, 'read', { file_path: 'q.txt' });
	check('G6 不产生任何 deny：随后那次工具调用照常放行', allowed(verdict), brief(verdict));
	check('G6 也没有误触发子代理 outlier 门（这个子代理没有兄弟）', !h.logs.some(([level, text]) => level === 'warn' && text.includes('单次请求花得')), '');
}

// ══════════ 34. 存档 v0 / v1 努力迁移（不许整份丢弃）+ A3 退休表上限 ══════════
{
	// ① v0：只有已知字段，也要按已知字段迁移
	fs.writeFileSync(STATE_PATH, JSON.stringify({ version: 0, sessions: { 'g34-v0': { totalInput: 950_000_000, turn: 1 } } }), 'utf8');
	const h0 = harness({ DSH_LOOP_GUARD_PERSIST: 1 });
	check('v0 老存档：打一条「版本不一致 → 按已知字段尽力迁移」的 warn', h0.warned('不一致'), h0.logs.map(([, text]) => text).join(' | ').slice(0, 160));
	const s0 = h0.plain('g34-v0');
	const v0Call = await h0.call(s0, 'read', { file_path: 'v0.txt' });
	check('v0 老存档的 9.5 亿没被丢弃（不到 10 亿时照常放行）', allowed(v0Call), brief(v0Call));
	h0.charge(s0, 90_000_000, 2);
	const v0Over = await h0.call(s0, 'read', { file_path: 'v0b.txt' });
	check('v0 老存档累加到 10.4 亿 → 会话预算照常拦', isDeny(v0Over, 'LOOP_GUARD_SESSION_BUDGET'), brief(v0Over));

	// ② v1：多一个 v2 才有的 turnInput，也不能丢
	fs.writeFileSync(
		STATE_PATH,
		JSON.stringify({
			version: 1,
			savedAt: 'x',
			retired: ['g34-old-retired'],
			sessions: { 'g34-v1': { totalInput: 950_000_000, turnInput: 5_000_000, turn: 1 } },
			stats: { sessions: 1, denied: 1, released: 0, exempted: 0, updatedAt: 'x' }
		}),
		'utf8'
	);
	const registered = [];
	const webServer = { register(spec) { registered.push(spec); return () => undefined; } };
	const h1 = harness({ DSH_LOOP_GUARD_PERSIST: 1 }, { webServer });
	check('v1 老存档：同样按已知字段迁移（有 warn）', h1.warned('不一致'), '');
	const usage = await httpGet(registered[0].handler, '/api/loop-guard/usage?sessionId=g34-v1');
	check('v1 老存档：turnInput 也迁移过来了（5 百万）', usage.body?.turn?.input === 5_000_000, JSON.stringify(usage.body?.turn));

	// ③ A3：退休表超过 RETIRED_CAP(2000) 时按插入顺序淘汰最旧一条，而不是整体清空
	const full = Array.from({ length: 2000 }, (_, index) => `g34-retired-${index}`);
	fs.writeFileSync(
		STATE_PATH,
		JSON.stringify({ version: 2, savedAt: 'x', retired: full, sessions: {}, stats: { sessions: 0, denied: 0, released: 0, exempted: 0, updatedAt: 'x' } }),
		'utf8'
	);
	const h2 = harness({ DSH_LOOP_GUARD_PERSIST: 1 });
	const extra = h2.plain('g34-extra');
	h2.created(extra);
	h2.disposed(extra);
	const saved = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
	check('A3 退休表上限：长度正好是 2000（不是整体清空）', Array.isArray(saved.retired) && saved.retired.length === 2000, `len=${saved.retired?.length}`);
	check(
		'A3 按插入顺序淘汰最旧一条（第 0 条走了，最后一条还在）',
		!saved.retired.includes('g34-retired-0') && saved.retired.includes('g34-retired-1999'),
		JSON.stringify(saved.retired.slice(0, 3))
	);
	check('A3 新退休的 id 进了表（退休会话不许复活成全新会话）', saved.retired.includes('g34-extra'), '');
	fs.rmSync(STATE_PATH, { force: true });
}

// ══════════ 35. 消耗估算（cacheReadInput / uncachedInput / costCny / lastModel） ══════════
//
// 契约（冻结，实现必须与此一致；实测不符就报，不许改断言将就）：
//   cost += cacheRead*cacheHit + (input+cacheWrite)*inputMiss + output*output   （CNY / 百万 token）
//   价目表 FLASH 平 0.02/1.0/4.0、峰 0.04/2.0/8.0；PRO 平 0.15/4.5/13.5、峰 0.30/9.0/27.0
//   峰窗口 = 北京时间周一至周五 09:00-12:00 与 14:00-18:00，其余时刻平价，不处理节假日
//   模型归属 request/header → data.header.config.{provider,model}；request/context → data.{provider,model}
//   名字含 pro（不区分大小写）走 PRO 表，其余（含压根没收到模型 event）回落 FLASH
//   只存裸模型名：不加 provider 前缀，大小写原样；provider 仅在模型名缺失时兜底。state 的 lastModel 与 payload 的 cost.model 都是它
//   折叠规则：模型名含 pro 且样本时刻 < Date.UTC(2026,8,14,4,0) 才走 PRO 行；该时刻及之后 v4-pro 并入 FLASH 计价
//   端点 payload 的 cost 段：{ cny, estimated: true, model, cacheReadInput, uncachedInput, output, pricesAsOf: '2026-10' }
{
	// 期望值全部照契约上的价目表自己算 —— 不从实现里读回来，读回来就等于没测。
	const FLASH = { hit: [0.02, 0.04], miss: [1.0, 2.0], out: [4.0, 8.0] };
	const PRO = { hit: [0.15, 0.3], miss: [4.5, 9.0], out: [13.5, 27.0] };
	const OFF = 0;
	const PEAK = 1;
	const million = (tokens, price) => (tokens * price) / 1_000_000;
	const near = (actual, expected) => typeof actual === 'number' && Math.abs(actual - expected) < 1e-6;

	// 北京时间「第 dayOffset 天（0 = 周一）的 hh:mm」对应的 UTC 毫秒。
	// 基准：2026-10-05 08:00 北京时间 = 2026-10-05T00:00:00Z，那天是周一（下面第一条断言守着这个前提）。
	const BJ_MONDAY_0800 = Date.parse('2026-10-05T00:00:00Z');
	const bjAt = (dayOffset, hour, minute) => BJ_MONDAY_0800 + ((dayOffset * 24 + hour - 8) * 60 + minute) * 60_000;
	// 折叠点（2026-09-14T04:00:00Z = 北京时间 2026-09-14 12:00）之前才走 PRO 行，
	// PRO 价的用例要落在它之前：2026-09-07 也是周一（基准日往前 28 天），同一个 bjAt 传负偏移即可。
	const bjEarly = (dayOffset, hour, minute) => bjAt(dayOffset - 28, hour, minute);

	// 峰/平是按「每笔 usage 样本的到达时刻」选的，而契约里没有注入时钟的 env ——
	// 只能把进程看到的「现在」钉成一个确定的瞬间（Date.now 与 new Date() 一起换）。
	const withNow = async (instant, fn) => {
		const RealDate = Date;
		class FixedDate extends RealDate {
			constructor(...args) {
				if (args.length === 0) super(instant);
				else super(...args);
			}
			static now() {
				return instant;
			}
		}
		globalThis.Date = FixedDate;
		try {
			return await fn();
		} finally {
			globalThis.Date = RealDate;
		}
	};
	check(
		'测试基准日 2026-10-05 是周一（全部峰窗口断言都建在它上面）',
		new Date(BJ_MONDAY_0800).getUTCDay() === 1,
		new Date(BJ_MONDAY_0800).toUTCString()
	);

	const registered = [];
	const webServer = {
		register(spec) {
			registered.push(spec);
			return () => undefined;
		}
	};
	const costEnv = ['DSH_LOOP_GUARD_COST', 'DSH_LOOP_GUARD_PRICE_TABLE'];
	/**
	 * harness() 会在 apply() 之后把 KEYS 里的 env 删掉（那条约定是给「apply 时才读」的配置用的）。
	 * 消耗估算这两个 env 我按「真正读到它的时候还在」写，所以 apply 之后再钉一次 —— 两种读法都覆盖得住。
	 */
	const costHarness = (env = {}) => {
		const h = harness(env, { webServer });
		for (const key of costEnv) {
			if (env[key] === undefined) delete process.env[key];
			else process.env[key] = String(env[key]);
		}
		return h;
	};
	/** 一笔 usage 样本：三项可以只给其中任意几项。 */
	const sample = (h, session, usage, turn = 1) =>
		h.event(session, {
			type: 'assistant/chunk',
			data: {
				turn,
				step: 1,
				chunk: {
					type: 'usage',
					usage: { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, ...usage }
				}
			}
		});
	/** 让插件认出这一轮的模型：两种 event 形状都要能用。 */
	const seeModel = (h, session, model, via = 'header') =>
		h.event(
			session,
			via === 'header'
				? { type: 'request/header', data: { header: { config: { provider: 'deepseek', model } } } }
				: { type: 'request/context', data: { provider: 'deepseek', model } }
		);
	/** 读端点：用最后一次 apply 注册的 handler（cfg 是 apply 时的快照，COST=0 那一段必须看它）。 */
	const bodyOf = async (sessionId) => {
		const spec = registered.filter(spec => spec.path === '/api/loop-guard/usage').at(-1);
		const res = await httpGet(spec.handler, `/api/loop-guard/usage?sessionId=${encodeURIComponent(sessionId)}`);
		return res.body ?? {};
	};
	const hasCostShape = (cost) =>
		cost !== null &&
		typeof cost === 'object' &&
		typeof cost.cny === 'number' &&
		cost.estimated === true &&
		typeof cost.model === 'string' &&
		typeof cost.cacheReadInput === 'number' &&
		typeof cost.uncachedInput === 'number' &&
		typeof cost.output === 'number' &&
		cost.pricesAsOf === '2026-10';

	// ① 三项各自计价（平价组）+ 三个计费基各自累加 + payload 形状
	{
		const h = costHarness();
		const s = h.plain('cost-flash-off');
		seeModel(h, s, 'deepseek-v4-flash');

		await withNow(bjAt(0, 8, 59), () => sample(h, s, { cacheReadTokens: 1_000_000 }));
		const step1 = (await bodyOf('cost-flash-off')).cost;
		check('平价 · 只算 cacheRead：1 百万 × 0.02 = 0.02', near(step1?.cny, million(1_000_000, FLASH.hit[OFF])), JSON.stringify(step1));
		check('payload 的 cost 段形状：七个约定的键都在、类型对', hasCostShape(step1), JSON.stringify(step1));
		// 契约钉死了这一列的格式：裸模型名（不加 provider 前缀）。这里连「含 /」一起钉。
		check(
			'cost.model 是裸模型名：非空、不含 "/"、大小写原样保留',
			typeof step1?.model === 'string' && step1.model !== '' && !step1.model.includes('/') && step1.model.includes('deepseek-v4-flash'),
			JSON.stringify(step1?.model)
		);

		await withNow(bjAt(0, 8, 59), () => sample(h, s, { inputTokens: 1_000_000 }));
		const step2 = (await bodyOf('cost-flash-off')).cost;
		check('平价 · 再加 input：0.02 + 1 百万 × 1.0 = 1.02', near(step2?.cny, 1.02), JSON.stringify(step2));

		await withNow(bjAt(0, 8, 59), () => sample(h, s, { outputTokens: 1_000_000 }));
		const step3 = (await bodyOf('cost-flash-off')).cost;
		check('平价 · 再加 output：1.02 + 1 百万 × 4.0 = 5.02', near(step3?.cny, 5.02), JSON.stringify(step3));

		// inputMiss 的基是 input + cacheWrite（契约写作 (input+cacheWrite)）
		await withNow(bjAt(0, 8, 59), () => sample(h, s, { inputTokens: 1_000_000, cacheWriteTokens: 1_000_000 }));
		const step4 = (await bodyOf('cost-flash-off')).cost;
		check('平价 · cacheWrite 与 input 同价：5.02 + 2 百万 × 1.0 = 7.02', near(step4?.cny, 7.02), JSON.stringify(step4));
		check(
			'三个计费基各记各的：cacheRead 1 百万 / uncached 3 百万 / output 1 百万',
			step4?.cacheReadInput === 1_000_000 && step4?.uncachedInput === 3_000_000 && step4?.output === 1_000_000,
			JSON.stringify(step4)
		);
	}

	// ② 三项各自计价（峰时组）：同一个会话、周一 09:00
	{
		const h = costHarness();
		const s = h.plain('cost-flash-peak');
		seeModel(h, s, 'deepseek-v4-flash');

		await withNow(bjAt(0, 9, 0), () => sample(h, s, { cacheReadTokens: 1_000_000 }));
		const step1 = (await bodyOf('cost-flash-peak')).cost;
		check('峰时 · cacheRead：1 百万 × 0.04 = 0.04', near(step1?.cny, million(1_000_000, FLASH.hit[PEAK])), JSON.stringify(step1));

		await withNow(bjAt(0, 9, 0), () => sample(h, s, { inputTokens: 1_000_000 }));
		const step2 = (await bodyOf('cost-flash-peak')).cost;
		check('峰时 · 再加 input：0.04 + 1 百万 × 2.0 = 2.04', near(step2?.cny, 2.04), JSON.stringify(step2));

		await withNow(bjAt(0, 9, 0), () => sample(h, s, { outputTokens: 1_000_000 }));
		const step3 = (await bodyOf('cost-flash-peak')).cost;
		check('峰时 · 再加 output：2.04 + 1 百万 × 8.0 = 10.04', near(step3?.cny, 10.04), JSON.stringify(step3));
	}

	// ③ 峰窗口边界：一笔只含 cacheRead 的样本，看它被算成峰价还是平价
	{
		const edge = async (sessionId, instant) => {
			const h = costHarness();
			const s = h.plain(sessionId);
			seeModel(h, s, 'deepseek-v4-flash');
			await withNow(instant, () => sample(h, s, { cacheReadTokens: 1_000_000 }));
			return (await bodyOf(sessionId)).cost?.cny;
		};
		// 只测语义明确的点：12:00 / 18:00 是「窗口终点含不含」的歧义边界，契约没写死，不在这儿赌。
		const cases = [
			['周一 09:00（上午窗口起点，含）', bjAt(0, 9, 0), PEAK],
			['周一 10:00（窗口内）', bjAt(0, 10, 0), PEAK],
			['周一 14:00（下午窗口起点，含）', bjAt(0, 14, 0), PEAK],
			['周一 08:59（窗口前）', bjAt(0, 8, 59), OFF],
			['周一 13:00（午休）', bjAt(0, 13, 0), OFF],
			['周六 10:00（周末）', bjAt(5, 10, 0), OFF],
			['周日 10:00（周末）', bjAt(6, 10, 0), OFF]
		];
		let edgeIndex = 0;
		for (const [label, instant, column] of cases) {
			// 会话 id 必须逐个手写：早先是拿 label 拼 id，几个中文标签被 replace 成同一串，
			// 后一个案例接着前一个的账累加（周六/周日实测 0.06/0.08 的假红就是这么来的）。
			const cny = await edge(`cost-edge-${edgeIndex++}`, instant);
			check(`峰窗口边界 · ${label} → ${column === PEAK ? '峰价' : '平价'}`, near(cny, million(1_000_000, FLASH.hit[column])), `${cny}`);
		}
	}

	// ④ 模型归属：两种 event 形状 + 名字含 pro（不区分大小写）+ 未知模型回落 FLASH
	{
		const sessionCost = async (sessionId, setup, instant = bjAt(0, 8, 59)) => {
			const h = costHarness();
			const s = h.plain(sessionId);
			if (setup !== undefined) setup(h, s);
			await withNow(instant, () => sample(h, s, { cacheReadTokens: 1_000_000 }));
			return (await bodyOf(sessionId)).cost;
		};
		// pro 行只在折叠点之前有效，所以这两个 case 的时刻要用折叠点之前的（2026-09-07 周一 08:59）。
		const proUpper = await sessionCost('cost-pro-upper', (h, s) => seeModel(h, s, 'V4-PRO-0528'), bjEarly(0, 8, 59));
		check('名字含 PRO（大写）也走 PRO 表：1 百万 × 0.15 = 0.15', near(proUpper?.cny, million(1_000_000, PRO.hit[OFF])), JSON.stringify(proUpper));
		check(
			'cost.model 里的模型名大小写没被吃掉（V4-PRO-0528 原样在，且是裸名不含 "/"）',
			typeof proUpper?.model === 'string' && proUpper.model !== '' && !proUpper.model.includes('/') && proUpper.model.includes('V4-PRO-0528'),
			JSON.stringify(proUpper?.model)
		);

		const proCtx = await sessionCost('cost-pro-ctx', (h, s) => seeModel(h, s, 'v4-pro', 'context'), bjEarly(0, 8, 59));
		check('request/context 形状也认模型（data.model 含 pro → PRO 表）', near(proCtx?.cny, million(1_000_000, PRO.hit[OFF])), JSON.stringify(proCtx));

		const flashCtx = await sessionCost('cost-flash-ctx', (h, s) => seeModel(h, s, 'deepseek-v4-flash', 'context'));
		check('request/context + 非 pro 模型 → FLASH 表：1 百万 × 0.02 = 0.02', near(flashCtx?.cny, million(1_000_000, FLASH.hit[OFF])), JSON.stringify(flashCtx));

		const unknown = await sessionCost('cost-unknown-model', (h, s) => seeModel(h, s, 'mystery-model-9000'));
		check('未知模型回落 FLASH 表（既不是算不出来、也不是按 PRO 算）', near(unknown?.cny, million(1_000_000, FLASH.hit[OFF])), JSON.stringify(unknown));

		const noModel = await sessionCost('cost-no-model', undefined);
		check('一次模型 event 都没收到 → 同样回落 FLASH 表', near(noModel?.cny, million(1_000_000, FLASH.hit[OFF])), JSON.stringify(noModel));
		check(
			'识别出模型时 cost.model 一律非空且不含 "/"（pro 大写 / pro context / flash context / 未知模型）',
			[proUpper?.model, proCtx?.model, flashCtx?.model, unknown?.model].every(
				(value) => typeof value === 'string' && value !== '' && !value.includes('/')
			),
			JSON.stringify([proUpper?.model, proCtx?.model, flashCtx?.model, unknown?.model])
		);
		check('一次模型 event 都没收到 → cost.model 是空串（不拿 provider 兜底）', noModel?.model === '', JSON.stringify(noModel?.model));
	}

	// ④b 折叠规则：v4-pro 在 2026-09-14T04:00:00Z（北京时间 2026-09-14 12:00）及之后并入 FLASH 计价
	{
		const CUTOFF = Date.UTC(2026, 8, 14, 4, 0);
		check(
			'折叠点常量自检：2026-09-14T04:00:00Z 且折叠点前 1 秒是周一（峰窗口断言建在这个前提上）',
			new Date(CUTOFF).toISOString() === '2026-09-14T04:00:00.000Z' && new Date(CUTOFF - 1_000).getUTCDay() === 1,
			new Date(CUTOFF - 1_000).toUTCString()
		);
		// 峰/平还是按样本时刻选列；这里只换「模型名 + 时刻」两件事，别的一律不动。
		const at = async (sessionId, instant, model = 'v4-pro') => {
			const h = costHarness();
			const s = h.plain(sessionId);
			seeModel(h, s, model);
			await withNow(instant, () => sample(h, s, { cacheReadTokens: 1_000_000 }));
			return (await bodyOf(sessionId)).cost?.cny;
		};
		// ① 折叠点之前 1 秒（= 北京 11:59:59 周一，窗口内）→ 仍是 PRO 峰价
		const beforePeak = await at('cost-fold-before-peak', CUTOFF - 1_000);
		check('折叠点前 1 秒的 v4-pro 在峰窗口 → PRO 峰价：1 百万 × 0.30 = 0.30', near(beforePeak, million(1_000_000, PRO.hit[PEAK])), `${beforePeak}`);
		// ① 折叠点之前的平价组（= 北京 08:59:59 周一，窗口外）→ 仍是 PRO 平价
		const beforeOff = await at('cost-fold-before-off', Date.UTC(2026, 8, 14, 0, 59, 59));
		check('折叠点前的 v4-pro 在窗口外 → PRO 平价：1 百万 × 0.15 = 0.15', near(beforeOff, million(1_000_000, PRO.hit[OFF])), `${beforeOff}`);
		// ② 折叠点当刻：北京 12:00 正好是「窗口终点含不含」的契约歧义点，所以这一笔只钉「已不再走 PRO 行」
		const atCutoff = await at('cost-fold-at-cutoff', CUTOFF);
		check(
			'折叠点当刻（2026-09-14T04:00:00Z）的 v4-pro 已并入 FLASH 行：0.02 或 0.04，不再有 PRO 价',
			[FLASH.hit[OFF], FLASH.hit[PEAK]].some((price) => near(atCutoff, million(1_000_000, price))),
			`${atCutoff}`
		);
		// ② 折叠点之后：北京 12:59:59（窗口外，无歧义）与 2026-10-14T02:00:00Z（北京周三 10:00，窗口内）
		const afterOff = await at('cost-fold-after-off', Date.UTC(2026, 8, 14, 4, 59, 59));
		check('折叠点之后的 v4-pro 在窗口外 → FLASH 平价：1 百万 × 0.02 = 0.02', near(afterOff, million(1_000_000, FLASH.hit[OFF])), `${afterOff}`);
		const afterPeak = await at('cost-fold-after-peak', Date.UTC(2026, 9, 14, 2, 0, 0));
		check('折叠点之后的 v4-pro 在峰窗口（2026-10-14T02:00:00Z）→ FLASH 峰价：1 百万 × 0.04 = 0.04', near(afterPeak, million(1_000_000, FLASH.hit[PEAK])), `${afterPeak}`);
		// ③ flash 类模型不受折叠规则影响：同一列（峰窗口内）在折叠点前后同价
		const flashBefore = await at('cost-fold-flash-before', CUTOFF - 1_000, 'deepseek-v4-flash');
		const flashAfter = await at('cost-fold-flash-after', Date.UTC(2026, 9, 14, 2, 0, 0), 'deepseek-v4-flash');
		check(
			'flash 类模型不受折叠规则影响：折叠点前后同为峰价 0.04（变了就是误伤）',
			near(flashBefore, million(1_000_000, FLASH.hit[PEAK])) && near(flashAfter, million(1_000_000, FLASH.hit[PEAK])),
			`${flashBefore} / ${flashAfter}`
		);
	}

	// ⑤ DSH_LOOP_GUARD_PRICE_TABLE 覆盖生效（平/峰两列给不同的数，认得出用的是哪一列）
	{
		const table = JSON.stringify({
			default: { cacheHit: [1, 2], inputMiss: [3, 4], output: [5, 6] },
			pro: { cacheHit: [7, 8], inputMiss: [9, 10], output: [11, 12] }
		});
		const full = { cacheReadTokens: 1_000_000, inputTokens: 1_000_000, cacheWriteTokens: 1_000_000, outputTokens: 1_000_000 };
		const tbl = async (sessionId, instant, model, usage) => {
			const h = costHarness({ DSH_LOOP_GUARD_PRICE_TABLE: table });
			const s = h.plain(sessionId);
			seeModel(h, s, model);
			await withNow(instant, () => sample(h, s, usage));
			return (await bodyOf(sessionId)).cost;
		};
		const flashOff = await tbl('cost-tbl-flash-off', bjAt(0, 8, 59), 'deepseek-v4-flash', full);
		check('PRICE_TABLE 覆盖 · 平价 FLASH：1×(1) + 2×(3) + 1×(5) = 12', near(flashOff?.cny, 1 + 2 * 3 + 5), JSON.stringify(flashOff));
		check(
			'PRICE_TABLE 覆盖 · 计费基照旧分开记：cacheRead 1 百万 / uncached 2 百万 / output 1 百万',
			flashOff?.cacheReadInput === 1_000_000 && flashOff?.uncachedInput === 2_000_000 && flashOff?.output === 1_000_000,
			JSON.stringify(flashOff)
		);
		const flashPeak = await tbl('cost-tbl-flash-peak', bjAt(0, 9, 0), 'deepseek-v4-flash', full);
		check('PRICE_TABLE 覆盖 · 同一笔在峰价列：1×(2) + 2×(4) + 1×(6) = 16', near(flashPeak?.cny, 1 * 2 + 2 * 4 + 6), JSON.stringify(flashPeak));
		const proOff = await tbl('cost-tbl-pro-off', bjEarly(0, 8, 59), 'v4-pro', { cacheReadTokens: 1_000_000, inputTokens: 1_000_000, outputTokens: 1_000_000 });
		check('PRICE_TABLE 覆盖 · pro 段独立生效：1×(7) + 1×(9) + 1×(11) = 27', near(proOff?.cny, 7 + 9 + 11), JSON.stringify(proOff));
		// 折叠规则优先于覆盖表：折叠点之后 v4-pro 只能走 default 行（覆盖表也覆盖不动折叠后的 pro 价）。
		const proFoldedOff = await tbl('cost-tbl-pro-folded-off', Date.UTC(2026, 8, 14, 4, 59, 59), 'v4-pro', full);
		const proFoldedPeak = await tbl('cost-tbl-pro-folded-peak', Date.UTC(2026, 9, 14, 2, 0, 0), 'v4-pro', full);
		check(
			'PRICE_TABLE 覆盖 · 折叠之后的 v4-pro 不再走 pro 行、改走 default 行：平价 1+2×3+5 = 12 / 峰价 2+2×4+6 = 16',
			near(proFoldedOff?.cny, 1 + 2 * 3 + 5) && near(proFoldedPeak?.cny, 1 * 2 + 2 * 4 + 6),
			`${proFoldedOff?.cny} / ${proFoldedPeak?.cny}`
		);
	}

	// ⑥ 非法 PRICE_TABLE：只 warn 一条，然后回落内置表（不许崩、不许把闸门带下去）
	{
		const h = costHarness({ DSH_LOOP_GUARD_PRICE_TABLE: '{"default": {"cacheHit": [1,' });
		const malformed = h.logs.filter(([level, text]) => level === 'warn' && String(text).includes('PRICE_TABLE'));
		check('非法 PRICE_TABLE 只 warn 一条（不刷屏）', malformed.length === 1, h.logs.map(([, text]) => text).join(' | ').slice(0, 240));
		check('非法 PRICE_TABLE 之后闸门照常装上（apply 没炸）', h.hasPre === true);

		const s = h.plain('cost-tbl-bad');
		seeModel(h, s, 'deepseek-v4-flash');
		await withNow(bjAt(0, 8, 59), () => sample(h, s, { cacheReadTokens: 1_000_000 }));
		const fallback = (await bodyOf('cost-tbl-bad')).cost;
		check('非法 PRICE_TABLE → 回落内置表：1 百万 × 0.02 = 0.02', near(fallback?.cny, million(1_000_000, FLASH.hit[OFF])), JSON.stringify(fallback));
	}

	// ⑦ costCny 只增不减（含一笔全 0 的样本：不涨，但也不许回退）
	{
		const h = costHarness();
		const s = h.plain('cost-monotonic');
		seeModel(h, s, 'deepseek-v4-flash');
		const seen = [];
		const steps = [
			{ cacheReadTokens: 1_000_000 },
			{ inputTokens: 1_000_000 },
			{},
			{ outputTokens: 1_000_000, cacheReadTokens: 1_000_000 },
			{ cacheWriteTokens: 1_000_000 }
		];
		for (const usage of steps) {
			await withNow(bjAt(0, 8, 59), () => sample(h, s, usage));
			seen.push((await bodyOf('cost-monotonic')).cost?.cny);
		}
		check(
			'costCny 只增不减（每一步都 ≥ 上一步，全 0 样本只是不涨）',
			seen.length === steps.length && seen.every((value, index) => typeof value === 'number' && (index === 0 || value >= seen[index - 1])),
			JSON.stringify(seen)
		);
		check('costCny 真的在涨（最后一步 > 第一步）', seen[seen.length - 1] > seen[0], JSON.stringify(seen));
	}

	// ⑧ DSH_LOOP_GUARD_COST=0：既不累加、也不上报（payload 里没有 cost 键）
	{
		const hOff = costHarness({ DSH_LOOP_GUARD_COST: 0 });
		const s = hOff.plain('cost-off');
		check('COST=0 时闸门照常装上（关掉的是账本，不是守卫）', hOff.hasPre === true);
		seeModel(hOff, s, 'deepseek-v4-flash');
		// 这一笔要是记了就是 5×0.02 + 5×1.0 + 5×4.0 = 25.1（平价 FLASH）
		await withNow(bjAt(0, 8, 59), () => sample(hOff, s, { cacheReadTokens: 5_000_000, inputTokens: 5_000_000, outputTokens: 5_000_000 }));
		const offBody = await bodyOf('cost-off');
		check('COST=0：端点照常答 ok，但 payload 里没有 cost 键', offBody.ok === true && !('cost' in offBody), JSON.stringify(Object.keys(offBody)));

		const hOn = costHarness();
		const afterOn = await bodyOf('cost-off');
		check('COST=0 期间一分钱都没记：打开之后这一笔的账是 0', 'cost' in afterOn && afterOn.cost?.cny === 0, JSON.stringify(afterOn.cost));
		await withNow(bjAt(0, 8, 59), () => sample(hOn, s, { cacheReadTokens: 1_000_000 }));
		const small = await bodyOf('cost-off');
		check(
			'打开后只记新样本：0 + 1 百万 × 0.02 = 0.02（关闭期间那 25.1 没被补记）',
			near(small.cost?.cny, million(1_000_000, FLASH.hit[OFF])),
			JSON.stringify(small.cost)
		);
	}

	for (const key of costEnv) delete process.env[key];
}

// ══════════ 36. 旧账金额补算：本版之前就记过账的会话，用快照只补金额 ══════════
//
// 契约（冻结；实测不符就报，不许改断言将就）：
//   触发点 session/created；条件是 `!retired.has(id) && requests > 0 && costEnabled && cacheReadInput + uncachedInput === 0`
//   只动 cacheReadInput / uncachedInput / costCny 三项，另把 lastModel 换成快照里最后一个 request 事件的裸模型名
//   token 七项（totalInput / familyInput / requests / modelCalls / toolCalls / turn / turnInput）逐一不变，也不上卷给祖先
//   金额按快照里的 usage 事件算；价目表的平／峰列取**补算当刻**（事件自带的时刻只用于 pro→flash 的折叠判断）
//   幂等（补完拆分不再为 0）、COST=0 不补、退休 id 不补、空快照是空操作不崩、只多一行含计数的 info
//
// 「requests > 0 而拆分全 0」的旧账只能来自存档：进程内 charge 一笔必然同时写上拆分
// （lib/index.js 的 charge 与 accrueCost 共用同一段算术）。所以每个场景都先写一份 v2 存档，
// 再用 harness({ DSH_LOOP_GUARD_PERSIST: 1 }) 把它读回来 —— 进程内造不出这种账。
{
	const million = (tokens, price) => (tokens * price) / 1_000_000;
	const near = (actual, expected) => typeof actual === 'number' && Math.abs(actual - expected) < 1e-6;
	// 覆盖表把平／峰两列写成同一个数：金额就与「补算发生在什么时刻」无关。
	// 只有⑨⑩两组要考「取哪一列 / 模型归属」，那两组用内置表 + 钉住进程时钟。
	const FLAT = JSON.stringify({
		default: { cacheHit: [3, 3], inputMiss: [5, 5], output: [7, 7] },
		pro: { cacheHit: [11, 11], inputMiss: [13, 13], output: [17, 17] }
	});
	const BJ_MONDAY_0800 = Date.parse('2026-10-05T00:00:00Z');
	const bjAt = (dayOffset, hour, minute) => BJ_MONDAY_0800 + ((dayOffset * 24 + hour - 8) * 60 + minute) * 60_000;
	const bjEarly = (dayOffset, hour, minute) => bjAt(dayOffset - 28, hour, minute);
	const withNow = async (instant, fn) => {
		const RealDate = Date;
		class FixedDate extends RealDate {
			constructor(...args) {
				if (args.length === 0) super(instant);
				else super(...args);
			}
			static now() {
				return instant;
			}
		}
		globalThis.Date = FixedDate;
		try {
			return await fn();
		} finally {
			globalThis.Date = RealDate;
		}
	};

	const registered = [];
	const webServer = {
		register(spec) {
			registered.push(spec);
			return () => undefined;
		}
	};
	const bodyOf = async (sessionId) => {
		const spec = registered.filter(spec => spec.path === '/api/loop-guard/usage').at(-1);
		const res = await httpGet(spec.handler, `/api/loop-guard/usage?sessionId=${encodeURIComponent(sessionId)}`);
		return res.body ?? {};
	};
	/** 端点 payload 里的七个 token / 轮次字段 —— 补算一个都不许碰。 */
	const TOKEN_KEYS = ['totalInput', 'familyInput', 'requests', 'modelCalls', 'toolCalls', 'turn', 'turnInput'];
	const tokenSlice = (body) => ({
		totalInput: body.session?.totalInput,
		familyInput: body.session?.familyInput,
		requests: body.session?.requests,
		modelCalls: body.session?.modelCalls,
		toolCalls: body.session?.toolCalls,
		turn: body.session?.turn,
		turnInput: body.turn?.input
	});
	const usageEvent = (usage, turn = 1) => ({
		type: 'assistant/chunk',
		data: { turn, step: 1, chunk: { type: 'usage', usage } }
	});
	/** 快照里的模型归属事件：header 走 data.header.config，context 走 data 本身。 */
	const requestEvent = (model, via = 'header') =>
		via === 'header'
			? { type: 'request/header', data: { header: { config: { provider: 'deepseek', model } } } }
			: { type: 'request/context', data: { provider: 'deepseek', model } };
	const backfillLogs = (h, sessionId) => h.logs.filter(([level, text]) => level === 'info' && text.includes(`旧账补算 会话 ${sessionId}`));

	/** 旧版本写下的账本形状：requests 记过，四个金额字段全 0（实测 session-751ec6e6 就是这个样子）。 */
	const legacyLedger = (over = {}) => ({
		totalInput: 77_652_325,
		familyInput: 0,
		output: 1_234_567,
		requests: 6,
		modelCalls: 6,
		toolCalls: 3,
		turn: 4,
		turnInput: 12_345_678,
		familyTurnInput: 0,
		cacheReadInput: 0,
		uncachedInput: 0,
		costCny: 0,
		lastModel: '',
		...over
	});
	const archive = (sessions, retired = []) => ({
		version: 2,
		savedAt: '2026-01-01T00:00:00.000Z',
		retired,
		sessions,
		stats: { sessions: Object.keys(sessions).length, denied: 0, released: 1, exempted: 2, updatedAt: '2026-01-01T00:00:00.000Z' }
	});
	/** 写一份存档，紧接着 harness(PERSIST=1) 把它读回来 —— 两件事之间没有 await，不会有别的写盘插进来。 */
	const loadArchive = (sessions, env = {}, retired = [], priceTable = FLAT) => {
		fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
		fs.writeFileSync(STATE_PATH, JSON.stringify(archive(sessions, retired)));
		const vars = { DSH_LOOP_GUARD_PERSIST: 1, ...env };
		if (priceTable !== null) vars.DSH_LOOP_GUARD_PRICE_TABLE = priceTable;
		return harness(vars, { webServer });
	};

	// ① 旧账补算：算术自己手算（不从实现里读回来），只补金额三项 + lastModel + 一行 info
	{
		const h = loadArchive({ 'lg-legacy': legacyLedger() });
		const before = await bodyOf('lg-legacy');
		check(
			'① 旧账读得回来：payload 是存档原值（requests=6 / turnInput=12_345_678 / 三个金额字段全 0）',
			before.session?.requests === 6 &&
				before.turn?.input === 12_345_678 &&
				before.cost?.cacheReadInput === 0 &&
				before.cost?.uncachedInput === 0 &&
				before.cost?.cny === 0,
			JSON.stringify(before)
		);
		check('① 旧账读得回来 · 存档里的 lastModel 是空的（所以下面的模型名只能来自快照）', before.cost?.model === '', JSON.stringify(before.cost));
		await h.created({
			id: 'lg-legacy',
			snapshotEvents: () => [
				requestEvent('deepseek-v4-flash'),
				usageEvent({ inputTokens: 4_000_000, cacheReadTokens: 6_000_000, cacheWriteTokens: 1_000_000, outputTokens: 2_000_000 }),
				usageEvent({ outputTokens: 500_000 }), // 缺字段按 0：这笔只贡献 output 的价
				requestEvent('deepseek-v4-pro')
			]
		});
		const after = await bodyOf('lg-legacy');
		check(
			'① 旧账补算 · 手算期望：6M×3 + (4M+1M)×5 + 2.5M×7 = 60.5 元（平=峰，与补算时刻无关）',
			near(after.cost?.cny, 60.5),
			JSON.stringify(after.cost)
		);
		check('① 旧账补算 · cacheReadInput = 6_000_000（快照里两笔 cacheRead 之和）', after.cost?.cacheReadInput === 6_000_000, JSON.stringify(after.cost));
		check('① 旧账补算 · uncachedInput = inputTokens + cacheWriteTokens = 5_000_000', after.cost?.uncachedInput === 5_000_000, JSON.stringify(after.cost));
		check('① 旧账补算 · 旧账的 output 一个 token 都没被重算（仍是存档里的 1_234_567）', after.cost?.output === 1_234_567, JSON.stringify(after.cost));
		check(
			'① 旧账补算 · lastModel 取快照里最后一个 request 事件的裸模型名（pro，不带 provider）',
			after.cost?.model === 'deepseek-v4-pro',
			JSON.stringify(after.cost?.model)
		);
		const infos = backfillLogs(h, 'lg-legacy');
		// logger 那一层会带上 `[loop-guard] ` 前缀，所以只锚两头、中间逐字对齐冻结文案。
		const frozen = /^(?:\[loop-guard\] )?旧账补算 会话 lg-legacy：历史 4 条 → cacheRead=6000000 uncached=5000000 金额=[\d.]+（只补金额，token 一概未动）$/;
		check('① 旧账补算 · 恰好一行 info，文案只有计数（没有对话内容）', infos.length === 1 && frozen.test(infos[0][1]), JSON.stringify(infos));
		check(
			'① 旧账补算 · 同一行也落进诊断日志文件',
			fs.existsSync(LOG_PATH) && fs.readFileSync(LOG_PATH, 'utf8').includes('旧账补算 会话 lg-legacy'),
			fs.existsSync(LOG_PATH) ? fs.readFileSync(LOG_PATH, 'utf8').slice(-300) : '没有日志文件'
		);
	}

	// ② token 七项逐一不变：快照里塞满「完整重放会改数」的事件，补算也不许碰它们
	{
		const h = loadArchive({ 'lg-invariant': legacyLedger() });
		const before = tokenSlice(await bodyOf('lg-invariant'));
		await h.created({
			id: 'lg-invariant',
			snapshotEvents: () => [
				requestEvent('deepseek-v4-flash'),
				usageEvent({ inputTokens: 9_000_000, outputTokens: 9_000_000 }),
				// 完整重放里这一条会把 modelCalls 加一：它没把计数改掉，就说明走的是补算不是重放
				{ type: 'assistant/message', data: {} },
				{ type: 'tool/call', data: { turn: 1, step: 1, name: 'read', callId: 'c1', arguments: {} } }
			]
		});
		const afterBody = await bodyOf('lg-invariant');
		const after = tokenSlice(afterBody);
		for (const key of TOKEN_KEYS) {
			check(`② 旧账补算 · token 七项逐一不变：${key}`, after[key] === before[key], `${key}: ${before[key]} → ${after[key]}`);
		}
		check(
			'② 旧账补算 · 七项确实还是旧账原值（不是「两边一起变成 0」那种假不变）',
			after.totalInput === 77_652_325 &&
				after.familyInput === 0 &&
				after.requests === 6 &&
				after.modelCalls === 6 &&
				after.toolCalls === 3 &&
				after.turn === 4 &&
				after.turnInput === 12_345_678,
			JSON.stringify(after)
		);
		check(
			'② 旧账补算 · 补算真的发生了（否则「不变」是空话）：uncachedInput 被补成 9_000_000',
			afterBody.cost?.cacheReadInput === 0 && afterBody.cost?.uncachedInput === 9_000_000,
			JSON.stringify(afterBody.cost)
		);
		check(
			'② 旧账补算 · 跳过了完整重放：快照里的 assistant/message 没把 requests / modelCalls 加一',
			after.requests === 6 && after.modelCalls === 6,
			`requests ${before.requests} → ${after.requests}、modelCalls ${before.modelCalls} → ${after.modelCalls}`
		);
	}

	// ③ 幂等：同一会话再触发两次，金额与拆分都不许翻倍；顺带守「不上卷给祖先」
	{
		const h = loadArchive({
			'lg-idem': legacyLedger(),
			'lg-idem-parent': legacyLedger({ totalInput: 0, output: 0, requests: 1, modelCalls: 1, toolCalls: 0, turn: 1, turnInput: 0 })
		});
		const session = {
			id: 'lg-idem',
			header: { origin: 'subagent', parentSession: 'lg-idem-parent' },
			snapshotEvents: () => [requestEvent('deepseek-v4-flash'), usageEvent({ inputTokens: 1_000_000, cacheReadTokens: 2_000_000 })]
		};
		await h.created(session);
		const once = await bodyOf('lg-idem');
		check('③ 幂等 · 第一遍：2M×3 + 1M×5 = 11 元', near(once.cost?.cny, 11), JSON.stringify(once.cost));
		await h.created(session);
		await h.created(session);
		const thrice = await bodyOf('lg-idem');
		check('③ 幂等 · 再触发两次金额不翻倍（仍是 11 元，不是 33）', near(thrice.cost?.cny, 11), JSON.stringify(thrice.cost));
		check(
			'③ 幂等 · 拆分也不翻倍：cacheReadInput=2_000_000、uncachedInput=1_000_000',
			thrice.cost?.cacheReadInput === 2_000_000 && thrice.cost?.uncachedInput === 1_000_000,
			JSON.stringify(thrice.cost)
		);
		check('③ 幂等 · 只有第一次留下补算日志（后两次条件已不成立）', backfillLogs(h, 'lg-idem').length === 1, JSON.stringify(backfillLogs(h, 'lg-idem')));
		const parent = await bodyOf('lg-idem-parent');
		check('③ 旧账补算 · 不上卷给祖先：父会话 familyInput 仍是 0（补算只动自己那一本账）', parent.session?.familyInput === 0, JSON.stringify(parent.session));
	}

	// ④ 幂等·续命：补算结果落盘后再重启一次，新的进程不许再补一遍
	{
		const h1 = loadArchive({ 'lg-reload': legacyLedger() });
		await h1.created({
			id: 'lg-reload',
			snapshotEvents: () => [requestEvent('deepseek-v4-flash'), usageEvent({ inputTokens: 3_000_000, cacheReadTokens: 4_000_000 })]
		});
		const done = await bodyOf('lg-reload');
		check('④ 幂等·存盘前：4M×3 + 3M×5 = 27 元', near(done.cost?.cny, 27), JSON.stringify(done.cost));
		// charge 的写盘有 10 秒节流，而 session/disposed 里那一次 writeState 是无条件的 ——
		// 所以借 dispose 另一个 id 把内存账本立刻逼到盘上（persist.mjs 的 saveNow 也是这么干的）。
		// 不能 dispose lg-reload 自己：disposed 会先 ledgers.delete(id) 再 writeState()，
		// 那样它反而不会出现在存档的 sessions 里（只进 retired 名单）。
		await h1.disposed({ id: 'lg-flush' });
		const saved = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
		const written = saved.sessions?.['lg-reload'] ?? {};
		check(
			'④ 幂等·补算结果真的落进存档（cacheReadInput=4_000_000 / uncachedInput=3_000_000 / costCny=27 / lastModel=flash）',
			written.cacheReadInput === 4_000_000 && written.uncachedInput === 3_000_000 && near(written.costCny, 27) && written.lastModel === 'deepseek-v4-flash',
			JSON.stringify(written)
		);
		check(
			'④ 幂等·被 dispose 的是那个替身 id：lg-flush 进了退休表、lg-reload 没有（它的账本活着才会被写盘）',
			Array.isArray(saved.retired) && saved.retired.includes('lg-flush') && !saved.retired.includes('lg-reload'),
			JSON.stringify(saved.retired.slice(-3))
		);
		const h2 = harness({ DSH_LOOP_GUARD_PERSIST: 1, DSH_LOOP_GUARD_PRICE_TABLE: FLAT }, { webServer });
		const beforeReload = tokenSlice(await bodyOf('lg-reload'));
		await h2.created({
			id: 'lg-reload',
			snapshotEvents: () => [requestEvent('deepseek-v4-flash'), usageEvent({ inputTokens: 3_000_000, cacheReadTokens: 4_000_000 })]
		});
		const restart = await bodyOf('lg-reload');
		check('④ 幂等·存档存读一轮后重启：金额仍是 27 元、没有重复计', near(restart.cost?.cny, 27), JSON.stringify(restart.cost));
		check('④ 幂等·重启后没有补算日志（cacheReadInput + uncachedInput === 0 不成立）', backfillLogs(h2, 'lg-reload').length === 0, JSON.stringify(h2.logs));
		check(
			'④ 幂等·重启后 token 七项仍是存档原值',
			JSON.stringify(tokenSlice(restart)) === JSON.stringify(beforeReload),
			`${JSON.stringify(beforeReload)} → ${JSON.stringify(tokenSlice(restart))}`
		);
	}

	// ⑤ 拆分已非 0（含「只有 1」的边界）时不许补算，连 lastModel 都不许换
	{
		const h = loadArchive({
			'lg-priced': legacyLedger({ cacheReadInput: 111, uncachedInput: 222, costCny: 0.03, lastModel: 'deepseek-v4-flash' }),
			'lg-one': legacyLedger({ cacheReadInput: 1, uncachedInput: 0, lastModel: 'deepseek-v4-flash' })
		});
		const beforePriced = tokenSlice(await bodyOf('lg-priced'));
		const big = () => [requestEvent('deepseek-v4-pro'), usageEvent({ inputTokens: 1_000_000, cacheReadTokens: 1_000_000, outputTokens: 1_000_000 })];
		await h.created({ id: 'lg-priced', snapshotEvents: big });
		await h.created({ id: 'lg-one', snapshotEvents: big });
		const priced = await bodyOf('lg-priced');
		check('⑤ 拆分已非 0 不补算 · 金额原样 0.03（没被补算改掉）', near(priced.cost?.cny, 0.03), JSON.stringify(priced.cost));
		check('⑤ 拆分已非 0 不补算 · 拆分原样 111 / 222', priced.cost?.cacheReadInput === 111 && priced.cost?.uncachedInput === 222, JSON.stringify(priced.cost));
		check('⑤ 拆分已非 0 不补算 · 连 lastModel 都没被快照里的 pro 换掉', priced.cost?.model === 'deepseek-v4-flash', JSON.stringify(priced.cost?.model));
		check('⑤ 拆分已非 0 不补算 · 没有补算日志', backfillLogs(h, 'lg-priced').length === 0, JSON.stringify(h.logs));
		check(
			'⑤ 拆分已非 0 不补算 · token 七项也不变',
			JSON.stringify(tokenSlice(priced)) === JSON.stringify(beforePriced),
			`${JSON.stringify(beforePriced)} → ${JSON.stringify(tokenSlice(priced))}`
		);
		const one = await bodyOf('lg-one');
		check(
			'⑤ 边界 · cacheReadInput + uncachedInput = 1 也算「已记过」：拆分仍是 1 / 0',
			one.cost?.cacheReadInput === 1 && one.cost?.uncachedInput === 0,
			JSON.stringify(one.cost)
		);
		check('⑤ 边界 · 那一笔也没留下补算日志', backfillLogs(h, 'lg-one').length === 0, JSON.stringify(backfillLogs(h, 'lg-one')));
	}

	// ⑥ COST=0 整个补算不启动；关掉开关时端点连 cost 段都不给，所以拆分去落盘的存档里看
	{
		const h = loadArchive({ 'lg-costoff': legacyLedger() }, { DSH_LOOP_GUARD_COST: 0 });
		const before = tokenSlice(await bodyOf('lg-costoff'));
		const off = await bodyOf('lg-costoff');
		check('⑥ COST=0 · 端点连 cost 段都不给（与「花了 0 元」是两件事）', off.cost === undefined, JSON.stringify(Object.keys(off)));
		await h.created({
			id: 'lg-costoff',
			snapshotEvents: () => [requestEvent('deepseek-v4-flash'), usageEvent({ inputTokens: 5_000_000, cacheReadTokens: 5_000_000, outputTokens: 5_000_000 })]
		});
		const after = tokenSlice(await bodyOf('lg-costoff'));
		check('⑥ COST=0 不补算 · 没有补算日志', backfillLogs(h, 'lg-costoff').length === 0, JSON.stringify(h.logs));
		check(
			'⑥ COST=0 不补算 · token 七项一个没动',
			JSON.stringify(after) === JSON.stringify(before),
			`${JSON.stringify(before)} → ${JSON.stringify(after)}`
		);
		await h.disposed({ id: 'lg-costoff-flush' }); // 同上：借另一个 id 触发无条件写盘
		const saved = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
		const entry = saved.sessions?.['lg-costoff'] ?? {};
		check(
			'⑥ COST=0 不补算 · 落盘的那条也没有金额拆分（缓存读 / 未缓存输入仍是 0）',
			(entry.cacheReadInput ?? -1) === 0 && (entry.uncachedInput ?? -1) === 0,
			JSON.stringify(entry)
		);
		// 反证：同一份落盘存档（拆分全 0、lg-costoff 自己没退休）拿给打开开关的新装载，必须补出一笔 ——
		// 上面那次 COST=0 要是偷偷补过，这里读到的拆分就不是 0、门已经关上、不会再补。
		const h2 = harness({ DSH_LOOP_GUARD_PERSIST: 1, DSH_LOOP_GUARD_COST: 1, DSH_LOOP_GUARD_PRICE_TABLE: FLAT }, { webServer });
		await h2.created({
			id: 'lg-costoff',
			snapshotEvents: () => [requestEvent('deepseek-v4-flash'), usageEvent({ inputTokens: 5_000_000, cacheReadTokens: 5_000_000, outputTokens: 5_000_000 })]
		});
		const on = await bodyOf('lg-costoff');
		check(
			'⑥ 反证 · 打开开关后同一份存档补出 5M×3 + 5M×5 + 5M×7 = 75 元（说明 COST=0 那次真的没补）',
			near(on.cost?.cny, 75) && backfillLogs(h2, 'lg-costoff').length === 1,
			`${JSON.stringify(on.cost)} / ${JSON.stringify(backfillLogs(h2, 'lg-costoff'))}`
		);
	}

	// ⑦ 退休 id 不补算（H1 那套夹具写法：带子代理头 + 一大笔快照）
	{
		const h = loadArchive(
			{
				'lg-retired': legacyLedger({ totalInput: 0, output: 0, requests: 3, modelCalls: 3, toolCalls: 0, turn: 1, turnInput: 0 }),
				'lg-retired-parent': legacyLedger({ totalInput: 0, output: 0, requests: 1, modelCalls: 1, toolCalls: 0, turn: 1, turnInput: 0 })
			},
			{},
			['lg-retired']
		);
		await h.created({
			id: 'lg-retired',
			header: { origin: 'subagent', parentSession: 'lg-retired-parent' },
			snapshotEvents: () => [requestEvent('deepseek-v4-flash'), usageEvent({ inputTokens: 400_000_000, cacheReadTokens: 400_000_000, outputTokens: 400_000_000 })]
		});
		const self = await bodyOf('lg-retired');
		check(
			'⑦ 退休 id 不补算 · 一笔 4 亿 token 的快照都没被算进去（金额与拆分仍是 0）',
			near(self.cost?.cny, 0) && self.cost?.cacheReadInput === 0 && self.cost?.uncachedInput === 0,
			JSON.stringify(self.cost)
		);
		check('⑦ 退休 id 不补算 · 也没有补算日志', backfillLogs(h, 'lg-retired').length === 0, JSON.stringify(h.logs));
		const parent = await bodyOf('lg-retired-parent');
		check('⑦ 退休 id 不补算 · 祖先没被卷进来（familyInput 仍是 0）', parent.session?.familyInput === 0, JSON.stringify(parent.session));
	}

	// ⑧ 空快照（[] / 宿主没给 snapshotEvents / 返回 undefined）是空操作：不崩、不动字段
	{
		const h = loadArchive({ 'lg-empty': legacyLedger(), 'lg-noevents': legacyLedger(), 'lg-undefined': legacyLedger() });
		const before = {
			empty: tokenSlice(await bodyOf('lg-empty')),
			noevents: tokenSlice(await bodyOf('lg-noevents')),
			undef: tokenSlice(await bodyOf('lg-undefined'))
		};
		let threw = '';
		try {
			await h.created({ id: 'lg-empty', snapshotEvents: () => [] });
			await h.created({ id: 'lg-noevents' }); // 宿主压根没给 snapshotEvents
			await h.created({ id: 'lg-undefined', snapshotEvents: () => undefined });
		} catch (error) {
			threw = String(error?.message ?? error);
		}
		check('⑧ 空快照不崩 · session/created 没有把异常抛回宿主', threw === '', threw);
		const empty = await bodyOf('lg-empty');
		check(
			'⑧ 空快照不崩 · 空数组快照：金额与拆分仍是 0，token 七项一个字段都没动',
			near(empty.cost?.cny, 0) &&
				empty.cost?.cacheReadInput === 0 &&
				empty.cost?.uncachedInput === 0 &&
				JSON.stringify(tokenSlice(empty)) === JSON.stringify(before.empty),
			JSON.stringify({ cost: empty.cost, tokens: tokenSlice(empty) })
		);
		check(
			'⑧ 空快照不崩 · 空快照也照回一行 info（历史 0 条）',
			backfillLogs(h, 'lg-empty').length === 1 && backfillLogs(h, 'lg-empty')[0][1].includes('历史 0 条'),
			JSON.stringify(backfillLogs(h, 'lg-empty'))
		);
		const noevents = await bodyOf('lg-noevents');
		check(
			'⑧ 空快照不崩 · 宿主没给 snapshotEvents 时按空快照处理（字段不动、也回一行 info）',
			JSON.stringify(tokenSlice(noevents)) === JSON.stringify(before.noevents) && near(noevents.cost?.cny, 0) && backfillLogs(h, 'lg-noevents').length === 1,
			JSON.stringify({ cost: noevents.cost, tokens: tokenSlice(noevents) })
		);
		const undef = await bodyOf('lg-undefined');
		check(
			'⑧ 空快照不崩 · snapshotEvents() 返回 undefined 也当空快照',
			JSON.stringify(tokenSlice(undef)) === JSON.stringify(before.undef) && near(undef.cost?.cny, 0),
			JSON.stringify({ cost: undef.cost, tokens: tokenSlice(undef) })
		);
	}

	// ⑨ 平/峰列取「补算当刻」而不是事件时刻：同一份快照换个补算时刻就该换个价
	{
		const snapshotEvents = () => [requestEvent('deepseek-v4-flash'), usageEvent({ inputTokens: 1_000_000, cacheReadTokens: 1_000_000, outputTokens: 1_000_000 })];
		const h = loadArchive({ 'lg-column-off': legacyLedger() }, {}, [], null); // null = 用内置价目表
		await withNow(bjAt(0, 8, 30), () => h.created({ id: 'lg-column-off', snapshotEvents })); // 周一 08:30 北京 = 平价窗口
		const off = await bodyOf('lg-column-off');
		check('⑨ 价列取补算当刻 · 周一 08:30 补算 → 平价：0.02 + 1 + 4 = 5.02 元', near(off.cost?.cny, 5.02), JSON.stringify(off.cost));
		const h2 = loadArchive({ 'lg-column-peak': legacyLedger() }, {}, [], null);
		await withNow(bjAt(0, 11, 0), () => h2.created({ id: 'lg-column-peak', snapshotEvents })); // 周一 11:00 北京 = 峰窗口
		const peak = await bodyOf('lg-column-peak');
		check('⑨ 价列取补算当刻 · 同一份快照在周一 11:00 补算 → 峰价：0.04 + 2 + 8 = 10.04 元', near(peak.cost?.cny, 10.04), JSON.stringify(peak.cost));
		check(
			'⑨ 价列取补算当刻 · 两次补算同一份快照金额不同 ⇒ 看的是补算时刻',
			near(off.cost?.cny, 5.02) && near(peak.cost?.cny, 10.04),
			`平价 ${off.cost?.cny} / 峰价 ${peak.cost?.cny}`
		);
	}

	// ⑩ 模型归属来自快照：request/context 能把后面的样本从 flash 行切到 pro 行
	{
		// 折叠点（2026-09-14T04:00:00Z）之前 pro 才走 pro 行，所以时钟钉在前一周的周一 08:30（平价窗口）。
		const at = bjEarly(0, 8, 30);
		const h = loadArchive({ 'lg-context': legacyLedger() }, {}, [], null);
		await withNow(at, () =>
			h.created({
				id: 'lg-context',
				snapshotEvents: () => [
					requestEvent('deepseek-v4-flash'),
					usageEvent({ cacheReadTokens: 1_000_000 }),
					requestEvent('deepseek-v4-pro', 'context'),
					usageEvent({ cacheReadTokens: 1_000_000 })
				]
			})
		);
		const body = await bodyOf('lg-context');
		check(
			'⑩ 模型归属来自快照 · request/context 把后一笔从 flash 切到 pro：1M×0.02 + 1M×0.15 = 0.17 元',
			near(body.cost?.cny, 0.17),
			JSON.stringify(body.cost)
		);
		check('⑩ 模型归属来自快照 · lastModel 是快照里最后一个 request 事件的裸模型名（pro）', body.cost?.model === 'deepseek-v4-pro', JSON.stringify(body.cost?.model));
		const h2 = loadArchive({ 'lg-context-flash': legacyLedger() }, {}, [], null);
		await withNow(at, () =>
			h2.created({
				id: 'lg-context-flash',
				snapshotEvents: () => [
					requestEvent('deepseek-v4-flash'),
					usageEvent({ cacheReadTokens: 1_000_000 }),
					requestEvent('deepseek-v4-flash', 'context'),
					usageEvent({ cacheReadTokens: 1_000_000 })
				]
			})
		);
		const flatBody = await bodyOf('lg-context-flash');
		check('⑩ 模型归属来自快照 · 反证：两条 request 都说 flash 时只有 1M×0.02 ×2 = 0.04 元', near(flatBody.cost?.cny, 0.04), JSON.stringify(flatBody.cost));
	}
}

// ══════════ 37. 日志安全化：控制字符绝不落盘 ══════════
//
// 真实事故：内部错误指纹是 `工具名\u0000错误正文`，同一个错误门的 warn 原来把指纹原样
// 拼进日志行，于是真日志 ~/.dsh/loop-guard.log 里出现 U+0000（实测 4 处）—— 整份日志
// 被 grep / tail 判成二进制文件，从此读不出来。
//
// 两层修，两层各要一条断言：① lib/index.js:1847 的 fingerprintParts 在展示前拆开指纹
// （U+0000 只是分隔符，不该糊在正文里）；② lib/index.js:540-552 的 LOG_UNSAFE_RE /
// logSafe 在 fileLog 落盘前兜底（C0 与 DEL → `·`，保留 \t 与 \n）。只测其中一层，
// 另一层被改掉时日志会重新变成二进制文件。
{
	// 落盘要显式打开（默认 NO_PERSIST=1 时 fileLog 直接返回，见文件头），日志路径是
	// test/.guards-log.log（import 之前就指好了）。按**行号**切出「本场景新增的那一段」：
	// 前面 36 节已经写过若干行，不切的话断言可能被旧行满足（`·` 这种短串尤其危险）。
	const logLineCount = () => (fs.existsSync(LOG_PATH) ? fs.readFileSync(LOG_PATH, 'utf8').split('\n').length : 0);
	const logSince = (before) => (fs.existsSync(LOG_PATH) ? fs.readFileSync(LOG_PATH, 'utf8').split('\n').slice(before - 1).join('\n') : '');
	/** 断言失败时要看的那一小段，别把整份日志倒进测试输出。 */
	const snippet = (text) => JSON.stringify(String(text).slice(-140));

	const h = harness({
		DSH_LOOP_GUARD_PERSIST: 1,
		DSH_LOOP_GUARD_SAME_ERROR_LIMIT: 1,
		DSH_LOOP_GUARD_MAX_DENIALS: 9,
		DSH_LOOP_GUARD_REPEAT_LIMIT: 99,
		DSH_LOOP_GUARD_READ_REPEAT_LIMIT: 99,
		DSH_LOOP_GUARD_SKELETON_LIMIT: 9999,
		DSH_LOOP_GUARD_CYCLE_LIMIT: 9999
	});

	// 37.1 正文里自带 U+0000 的报错 → 真实的同错误门 → warn → fileLog
	let mark = logLineCount();
	const s = h.plain('g37-nul');
	h.toolFail(s, { name: 'edit', callId: 'c37', reason: 'Error: EPERM\u0000kept-going' });
	const tripped = await h.call(s, 'edit', { file_path: 'g37-a.txt' });
	check('37.1 带 NUL 的同一个错误门真的触发（否则下面的落盘断言是空转）', isDeny(tripped, 'LOOP_GUARD_SAME_ERROR'), brief(tripped));
	check('37.1 宿主日志里已经是「拦：edit — 正文」而不是指纹原文', h.warned('拦：edit \u2014 Error: EPERM'), '');
	check('37.1 第①层 fingerprintParts：连宿主日志里都没有 `edit\\u0000Error` 这个指纹形状', !h.logs.some(([, text]) => text.includes('edit\u0000Error')), '');
	const added = logSince(mark);
	check('37.1 这一段真的落进了诊断日志', added.includes('同一个错误已出现'), snippet(added));
	check('37.1 落盘后 0 个 U+0000（有 NUL 就会被 grep / tail 判成二进制）', !added.includes('\u0000'), snippet(added));
	check('37.1 第②层 logSafe：正文里的 NUL 换成 ·（替换而不是删除）', added.includes('Error: EPERM\u00b7kept-going'), snippet(added));
	check('37.1 展示形式：工具名 +「 — 」+ 正文都在同一行', added.includes('拦：edit \u2014 Error: EPERM\u00b7kept-going'), snippet(added));
	check('37.1 不是指纹原文形状 `edit\\u0000Error`', !added.includes('edit\u0000Error'), snippet(added));

	// 37.2 \t 与 \n 必须保留（「替换而不是删除」只针对别的控制字符）。logSafe 没有导出，
	// 所以走间接路线：把 \t / \n 放进**会话 id** —— 它被原样拼进每一条 warn 行，
	// 正好是「消息里带 \t / \n」最干净的入口。
	mark = logLineCount();
	const t = h.plain('g37-tab\tmid\nend');
	h.toolFail(t, { name: 'edit', callId: 'c37t', reason: 'Error: ETXTBSY blob locked' });
	const tabbed = await h.call(t, 'edit', { file_path: 'g37-b.txt' });
	check('37.2 制表 / 换行这一场也真的触发了这条 warn', isDeny(tabbed, 'LOOP_GUARD_SAME_ERROR'), brief(tabbed));
	const added2 = logSince(mark);
	check('37.2 落盘后 \\t 与 \\n 原样保留（没被换成 ·）', added2.includes('g37-tab\tmid\nend'), snippet(added2));
	check('37.2 \\t / \\n 没被当成不安全字符（那一段里不该出现 g37-tab·）', !added2.includes('g37-tab\u00b7'), '');

	// 37.3 指纹里工具名为空（认不出报错工具名）：原样只输出正文，不拼一个空工具名 +「 — 」。
	//     （fingerprintParts 里 `cut === -1`（整串都算正文）那条分支只能从旧存档喂进来，
	//     本文件不覆盖 —— 这里的指纹一定带分隔符。）
	mark = logLineCount();
	const u = h.plain('g37-unknown');
	h.toolFail(u, { callId: 'c37u', reason: 'Error: EIO\u0000bare-body' });
	const unknown = await h.call(u, 'read', { file_path: 'g37-c.txt' });
	check('37.3 认不出工具名时这一支照常拦（否则断言空转）', isDeny(unknown, 'LOOP_GUARD_SAME_ERROR'), brief(unknown));
	const added3 = logSince(mark);
	check('37.3 没有工具名就不拼「 — 」：正文原样接在「拦：」后面', added3.includes('拦：Error: EIO\u00b7bare-body') && !added3.includes('拦：\u2014') && !added3.includes('拦： \u2014'), snippet(added3));
	check('37.3 这一条里同样 0 个 U+0000', !added3.includes('\u0000'), '');

	// 整份测试日志的终检：三场写完之后文件里一个 NUL 都不该有 ——
	// 这正是真实事故的判据（有 NUL，grep / tail 就把整份日志当二进制）。
	const wholeLog = fs.existsSync(LOG_PATH) ? fs.readFileSync(LOG_PATH, 'utf8') : '';
	check('37 整份测试日志 0 个 U+0000（不是只看新增那一段）', !wholeLog.includes('\u0000'), `共 ${wholeLog.split('\n').length} 行`);
}

// ══════════ 38. 崩溃/重启后同一会话接着算（H2：注销时不丢账） ══════════
//
// 真实事故：宿主崩溃 / 重启会把**在跑的会话逐个** session/disposed。旧实现是
// 「ledgers.delete(id) → retired.add(id) → writeState()」—— 那些会话的计数于是从存档里
// 消失，重启后同一个 id 复活又被 retired 挡住、不许重放历史，于是计数从零重数
// （真机实测：崩溃前累计计费输入 2485.7 万 token，重启后存档只剩 260 万 / 13 次请求）。
//
// 新口径：已注销的账本留在存档的 disposed 里（FIFO，上限 DISPOSED_CAP = 200），同一个 id
// 复活时把这些计数直接接回账本 —— 不重放历史、也不给祖先重复上卷。本节钉住六件事：
//   ① 注销时落盘：快照的 13 个字段与注销前的账本逐一相等；
//   ② 复活时用掉它：同一份存档里不再同时留两份账（sessions 里活着、disposed 里没有）；
//   ③ 上限 FIFO：第 201 条进来时淘汰的是最旧那条，最新的还在；
//   ④ 老行为回归：只有 retired 名单、没有快照的 id 依旧完全不重放（H1 不许被放松）；
//   ⑤ 恢复之后仍然是老账：拆分全 0 ⇒ 既有的「旧账金额补算」照旧生效，9 个计数一个不动；
//   ⑥ 存档兼容：disposed 缺失 / 不是数组 / 元素残缺都照常加载，版本号仍是 2。
//
// 「写档 → **新进程**加载 → 同 id 复活」那一段在 test/persist.mjs —— 那边本来就是两次进程跑。
// 本节所有场景都用**自己传的 config**（价目表 / 成本开关 / PERSIST），不依赖任何默认上限。
{
	/** 存档里一条 disposed 记录的形状：id + disposedAt + 13 个计数字段。 */
	const H2_FIELDS = [
		'totalInput',
		'familyInput',
		'output',
		'requests',
		'modelCalls',
		'toolCalls',
		'turn',
		'turnInput',
		'familyTurnInput',
		'cacheReadInput',
		'uncachedInput',
		'costCny',
		'lastModel'
	];
	/** 估价用的价目表：平／峰两列写成同一个数，金额就与「这笔样本什么时候到」无关。 */
	const H2_PRICE = JSON.stringify({
		default: { cacheHit: [3, 3], inputMiss: [5, 5], output: [7, 7] },
		pro: { cacheHit: [11, 11], inputMiss: [13, 13], output: [17, 17] }
	});
	const archiveOf = () => (fs.existsSync(STATE_PATH) ? JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) : null);
	const putArchive = (payload) => fs.writeFileSync(STATE_PATH, JSON.stringify(payload), 'utf8');
	const dropArchive = () => fs.rmSync(STATE_PATH, { force: true });
	const parkedOf = (archive) => (Array.isArray(archive?.disposed) ? archive.disposed : []);
	const parkedIds = (archive) => parkedOf(archive).map((item) => item?.id);
	const countId = (list, id) => list.filter((item) => item?.id === id).length;
	/** 本节自己的容差比：near 是两个相邻区块里的局部名字，这里不借它们的。 */
	const near38 = (actual, expected) => typeof actual === 'number' && Math.abs(actual - expected) < 1e-6;
	const logText38 = () => (fs.existsSync(LOG_PATH) ? fs.readFileSync(LOG_PATH, 'utf8') : '');
	/** 日志被 logger 包了一层 `[loop-guard] ` 前缀：冻结文案说的是正文本身。 */
	const body38 = (text) => String(text).replace(/^\[loop-guard\]\s*/, '');
	/** 金额经过 roundCny / numberOr0，浮点用容差比；其余字段严格相等。 */
	const same13 = (actual, expected) =>
		actual !== null &&
		typeof actual === 'object' &&
		expected !== null &&
		typeof expected === 'object' &&
		H2_FIELDS.every((field) => {
			const a = typeof actual[field] === 'number' ? actual[field] : Number.NaN;
			return typeof expected[field] === 'number' ? Math.abs(a - expected[field]) < 1e-6 : actual[field] === expected[field];
		});
	/** 一行说清 13 个字段里哪几个对不上，断言失败时用。 */
	const diff13 = (actual, expected) =>
		JSON.stringify({
			mismatch: H2_FIELDS.filter((field) => (typeof expected?.[field] === 'number' ? Math.abs((typeof actual?.[field] === 'number' ? actual[field] : Number.NaN) - expected[field]) >= 1e-6 : actual?.[field] !== expected?.[field])),
			actual,
			expected
		});

	// ── 38.1 注销时落盘：快照的 13 个字段与注销前的账本逐一相等 ──────────────────
	dropArchive();
	const h2 = harness({ DSH_LOOP_GUARD_PERSIST: 1, DSH_LOOP_GUARD_COST: 1, DSH_LOOP_GUARD_PRICE_TABLE: H2_PRICE });
	const victim = { id: 'h2-park-a' };
	const victimSub = h2.sub('h2-park-sub', 'h2-park-a');
	// 计费输入按「缓存读 / 未命中 / 输出」分开喂，工具也真的走一次闸门；familyInput 靠子代理上卷 ——
	// 这样 13 个字段里没有一个是因为两边都是 0 才碰巧相等。
	h2.event(victim, { type: 'request/header', data: { header: { config: { provider: 'deepseek', model: 'deepseek-v4-flash' } } } });
	h2.event(victim, {
		type: 'assistant/chunk',
		data: {
			turn: 1,
			step: 1,
			chunk: { type: 'usage', usage: { inputTokens: 4_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 0, outputTokens: 200_000 } }
		}
	});
	h2.modelCall(victim);
	h2.event(victim, {
		type: 'assistant/chunk',
		data: {
			turn: 2,
			step: 1,
			chunk: { type: 'usage', usage: { inputTokens: 6_000_000, cacheReadTokens: 2_000_000, cacheWriteTokens: 0, outputTokens: 300_000 } }
		}
	});
	h2.call(victim, 'read', { file_path: 'x' });
	h2.created(victimSub);
	h2.event(victimSub, {
		type: 'assistant/chunk',
		data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 500_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 10_000 } } }
	});
	// 借一个**没有账本**的替身 id 触发那一次无条件 writeState，把内存账本先照进 sessions：
	// 这样「注销前的账本」是存档自己写出来的那一份，不是测试手抄的期望值。
	h2.disposed({ id: 'h2-park-flush' });
	const liveBefore = archiveOf()?.sessions?.['h2-park-a'];
	h2.disposed(victim);
	const parkedArchive = archiveOf();
	const parked = parkedOf(parkedArchive).find((item) => item?.id === 'h2-park-a');
	// toolCalls 故意**不**要求非 0：它的记账口（countExecutedTool）刚被实现者收口过一次，
	// 值会随实现浮动；这里只要求「键在、是数字」。其余 12 个字段必须非 0 / 非空，
	// 保证下面那条「13 个字段逐一相等」不是拿一堆 0 在空转。
	check(
		'38.1 前置：注销之前这份账本确实在存档里，且 13 个计数字段都是真值（比对不是空转）',
		liveBefore !== undefined &&
			liveBefore.requests === 2 &&
			typeof liveBefore.toolCalls === 'number' &&
			H2_FIELDS.every((field) => field === 'toolCalls' || (liveBefore[field] !== 0 && liveBefore[field] !== '')),
		JSON.stringify(liveBefore)
	);
	check('38.1 注销之后 id 落进了存档的 disposed，而不是从存档里消失', parked !== undefined, JSON.stringify(parkedIds(parkedArchive)));
	check(
		'38.1 快照的 13 个计数字段与注销前的账本逐一相等',
		same13(parked, liveBefore),
		diff13(parked, liveBefore)
	);
	/**
	 * 快照是「13 个计数 + id + disposedAt + 4 个豁免/逃生小本子」的**扁平**形状 ——
	 * 这条断言就是防「图省事把整个账本对象塞进去」：账本上还有历史、工具签名表之类的
	 * 大字段，真塞进去这一份存档会立刻涨成几十倍。
	 */
	const H2_EXTRA_KEYS = ['quotaExempted', 'escape', 'escapeSig', 'escapeSigUsed'];
	check(
		'38.1 快照就是扁平形状：13 个计数 + id + disposedAt + 4 个豁免/逃生小本子，没有把整个账本对象倒进去',
		parked !== undefined &&
			typeof parked.disposedAt === 'number' &&
			parked.disposedAt > 0 &&
			H2_FIELDS.every((field) => field in parked) &&
			Object.keys(parked).sort().join(',') === [...H2_FIELDS, 'id', 'disposedAt', ...H2_EXTRA_KEYS].sort().join(','),
		Object.keys(parked ?? {}).sort().join(',')
	);
	check(
		'38.1 注销走的还是老规矩：id 也进了 retired（H1 的保护没被这次改动拆掉）',
		(parkedArchive?.retired ?? []).includes('h2-park-a'),
		JSON.stringify(parkedArchive?.retired?.slice(-3))
	);
	check(
		'38.1 同一份存档里这个 id 不再出现在 sessions（内存账本确实放掉了，不是两边都留一份）',
		parkedArchive?.sessions?.['h2-park-a'] === undefined,
		JSON.stringify(parkedArchive?.sessions?.['h2-park-a'])
	);

	// ── 38.2 复活：接回计数、不重放历史、日志只含计数；取回即消费 ────────────────
	let h2Replay = 0;
	h2.created({
		id: 'h2-park-a',
		snapshotEvents: () => {
			h2Replay += 1;
			return [
				{
					type: 'assistant/chunk',
					data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 777_000_000, outputTokens: 0 } } }
				}
			];
		}
	});
	check('38.2 复活不重放历史：注入的 snapshotEvents 一次都没被调用', h2Replay === 0, `replayCalls=${h2Replay}`);
	const reviveLines = h2.logs.filter(([level, text]) => level === 'info' && text.includes('会话复活，接着算：')).map(([, text]) => text);
	const reviveLine = reviveLines.find((text) => text.includes('会话复活，接着算：h2-park-a')) ?? '';
	check(
		'38.2 复活写了那条冻结文案的 info 日志（会话复活，接着算： / 退休前 计费输入 / （不重放历史，也不给祖先重复上卷））',
		reviveLine.includes('会话复活，接着算：h2-park-a') &&
			reviveLine.includes('退休前 计费输入 ') &&
			reviveLine.includes('（不重放历史，也不给祖先重复上卷）'),
		JSON.stringify(reviveLines.slice(-1))
	);
	check(
		'38.2 日志只说计数：形状就是「id ← 退休前 … token、请求 N 次、轮次 N、金额 ¥N、配额豁免 N 项 / 逃生计数 N 条（…）」',
		/^会话复活，接着算：h2-park-a ← 退休前 计费输入 [\d.,]+ ?[万亿]? token、请求 2 次、轮次 2、金额 ¥[\d.]+、配额豁免 \d+ 项 \/ 逃生计数 \d+ 条（不重放历史，也不给祖先重复上卷）$/.test(
			body38(reviveLine)
		),
		JSON.stringify(reviveLine)
	);
	check(
		'38.2 日志里没有正文 / JSON / NUL / 换行（没有把账本对象倒进日志）',
		body38(reviveLine) !== '' && !/[{}\[\]\u0000\n]/.test(body38(reviveLine)),
		JSON.stringify(reviveLine)
	);
	h2.disposed({ id: 'h2-park-flush2' });
	const afterRevive = archiveOf();
	const liveAfter = afterRevive?.sessions?.['h2-park-a'];
	check(
		'38.2 取回即消费：同一份存档里这个 id 不再留在 disposed（不长期留两份账）',
		parkedIds(afterRevive).every((id) => id !== 'h2-park-a'),
		JSON.stringify(parkedIds(afterRevive).slice(0, 6))
	);
	check('38.2 计数整体回到了 sessions 里（13 个字段与注销前逐一相等）', same13(liveAfter, liveBefore), diff13(liveAfter, liveBefore));

	// ── 38.3 上限：DISPOSED_CAP = 200，第 201 条进来时淘汰最旧那条（FIFO）────────
	// 先把内存里剩下的旧条目全挤出去：连续 park 200 个替身（此刻表满，表里只可能是它们），
	// 这样下面数出来的就是本节自己插的 201 条。
	for (let index = 0; index < 200; index += 1) {
		const dummy = { id: `h2-evict-dummy-${index}` };
		h2.charge(dummy, 1, 1);
		h2.disposed(dummy);
	}
	const logMark = logText38().length;
	for (let index = 0; index < 201; index += 1) {
		const capped = { id: `h2-cap-${index}` };
		h2.charge(capped, 1, 1);
		h2.disposed(capped);
	}
	const cappedArchive = archiveOf();
	const cappedList = parkedOf(cappedArchive);
	check('38.3 表满之后只剩 DISPOSED_CAP = 200 条', cappedList.length === 200, `共 ${cappedList.length} 条`);
	check(
		'38.3 最旧那条（第 1 条）被淘汰掉了：淘汰的正好是最旧，不是整体清空',
		cappedList.length > 0 && countId(cappedList, 'h2-cap-0') === 0 && cappedList[0]?.id === 'h2-cap-1',
		JSON.stringify(cappedList.slice(0, 3).map((item) => item?.id))
	);
	check(
		'38.3 最新的那条还在，而且是数组最后一条（数组顺序就是淘汰顺序）',
		cappedList[cappedList.length - 1]?.id === 'h2-cap-200' && countId(cappedList, 'h2-cap-200') === 1,
		JSON.stringify(cappedList.slice(-2).map((item) => item?.id))
	);
	const logAfterCap = logText38();
	check(
		'38.3 淘汰按插入顺序淘汰最旧的一条（诊断日志里查得到，不是静默清空）',
		logAfterCap.length > logMark && logAfterCap.includes('已注销账本表 已满，按插入顺序淘汰最旧的一条'),
		`新增 ${logAfterCap.length - logMark} 字节`
	);

	// ── 38.4 老行为回归：只有 retired 名单、没有快照的 id 依旧完全不重放 ──────────
	// 这正是「先退休、快照却不在表里」的形状：给一个**没有账本**的 id 注销 —— park 那一步
	// 要求 ledgers.get(id) 存在，所以它只进 retired、不进 disposed。
	h2.disposed({ id: 'h2-retired-only' });
	check(
		'38.4 前置：这个 id 只进了 retired、没进 disposed（否则下面的断言是空转）',
		(archiveOf()?.retired ?? []).includes('h2-retired-only') && parkedIds(archiveOf()).every((id) => id !== 'h2-retired-only'),
		JSON.stringify(parkedIds(archiveOf()).slice(0, 4))
	);
	let retiredReplay = 0;
	h2.created({
		id: 'h2-retired-only',
		snapshotEvents: () => {
			retiredReplay += 1;
			return [
				{
					type: 'assistant/chunk',
					data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 500_000_000, outputTokens: 0 } } }
				}
			];
		}
	});
	check('38.4 只有 retired、没有快照的 id 复活：历史一次都不重放', retiredReplay === 0, `replayCalls=${retiredReplay}`);
	let controlReplay = 0;
	h2.created({
		id: 'h2-retired-control',
		snapshotEvents: () => {
			controlReplay += 1;
			return [
				{
					type: 'assistant/chunk',
					data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 5_000_000, outputTokens: 0 } } }
				}
			];
		}
	});
	check(
		'38.4 反证：既没退休、也没快照的全新 id 照常吸收历史（0 次是守卫起作用，不是重放坏了）',
		controlReplay === 1,
		`replayCalls=${controlReplay}`
	);
	h2.disposed({ id: 'h2-retired-flush' });
	const controlLive = archiveOf()?.sessions?.['h2-retired-control'];
	const ghostLive = archiveOf()?.sessions?.['h2-retired-only'];
	check('38.4 反证：控制组那 500 万真的记进了账本', controlLive?.totalInput === 5_000_000, JSON.stringify(controlLive));
	check('38.4 retired-only 那个 id 依旧一分账都没有（历史被完全挡住）', ghostLive === undefined || ghostLive.totalInput === 0, JSON.stringify(ghostLive));

	// ── 38.5 恢复之后仍然是老账：拆分全 0 ⇒ 既有的「旧账金额补算」照旧生效 ────────
	// 真机里最要紧的一档：本版装载之前就开始记账的会话（77,652,325 token / 719 次请求），
	// 存档里 cacheRead / uncached / costCny 全是 0。恢复完之后**没有第二次补算机会**，
	// 所以这一次必须补上：金额 > 0，而 9 个计数一个都不许动（历史只用来补金额）。
	dropArchive();
	const legacyParked = {
		id: 'h2-legacy',
		disposedAt: 1_760_000_000_000,
		totalInput: 77_652_325,
		familyInput: 0,
		output: 1_234,
		requests: 719,
		modelCalls: 700,
		toolCalls: 42,
		turn: 12,
		turnInput: 5_000_000,
		familyTurnInput: 0,
		cacheReadInput: 0,
		uncachedInput: 0,
		costCny: 0,
		lastModel: ''
	};
	const legacyUntouched = ['totalInput', 'familyInput', 'output', 'requests', 'modelCalls', 'toolCalls', 'turn', 'turnInput', 'familyTurnInput'];
	putArchive({
		version: 2,
		savedAt: new Date().toISOString(),
		retired: ['h2-legacy'],
		disposed: [legacyParked],
		sessions: {},
		stats: {}
	});
	const legacyEvents = [
		{ type: 'request/header', data: { header: { config: { provider: 'deepseek', model: 'deepseek-v4-flash' } } } },
		{
			type: 'assistant/chunk',
			data: {
				turn: 12,
				step: 1,
				chunk: { type: 'usage', usage: { inputTokens: 3_000_000, cacheReadTokens: 2_000_000, cacheWriteTokens: 0, outputTokens: 1_000_000 } }
			}
		}
	];
	const h5 = harness({ DSH_LOOP_GUARD_PERSIST: 1, DSH_LOOP_GUARD_COST: 1, DSH_LOOP_GUARD_PRICE_TABLE: H2_PRICE });
	h5.created({ id: 'h2-legacy', snapshotEvents: () => legacyEvents });
	h5.disposed({ id: 'h2-legacy-flush' });
	const legacyLive = archiveOf()?.sessions?.['h2-legacy'];
	check(
		'38.5 恢复 + 补算：9 个计数一个都没动（token 与请求数只来自快照，历史只用来补金额）',
		legacyLive !== undefined && legacyUntouched.every((field) => legacyLive[field] === legacyParked[field]),
		JSON.stringify({ actual: legacyLive, expected: legacyParked })
	);
	check(
		'38.5 金额真的补上了（不是留着 ¥0.00、再没有第二次机会）',
		typeof legacyLive?.costCny === 'number' && legacyLive.costCny > 0,
		JSON.stringify(legacyLive)
	);
	check(
		'38.5 金额按注入的历史算：2 百万 × 3 + 3 百万 × 5 + 1 百万 × 7 = 28 元',
		near38(legacyLive?.costCny, 28),
		String(legacyLive?.costCny)
	);
	check(
		'38.5 拆分字段被补算填上：cacheReadInput 2 百万 / uncachedInput 3 百万 / lastModel 认出了这一轮的模型',
		legacyLive?.cacheReadInput === 2_000_000 && legacyLive?.uncachedInput === 3_000_000 && legacyLive?.lastModel === 'deepseek-v4-flash',
		JSON.stringify(legacyLive)
	);
	check(
		'38.5 补算日志照旧（只补金额，token 一概未动）',
		h5.logs.some(([level, text]) => level === 'info' && text.includes('旧账补算') && text.includes('只补金额，token 一概未动')),
		JSON.stringify(h5.logs.filter(([, text]) => text.includes('补算')).slice(-1))
	);
	const legacyReviveLine = h5.logs.filter(([level, text]) => level === 'info' && text.includes('会话复活，接着算：h2-legacy')).map(([, text]) => text)[0] ?? '';
	check(
		'38.5 有快照的会话走的是「接回计数 + 补金额」两步（复活日志里的三个数字就是快照里的那三个）',
		/^会话复活，接着算：h2-legacy ← 退休前 计费输入 [\d.,]+ ?[万亿]? token、请求 719 次、轮次 12、金额 ¥[\d.]+、配额豁免 \d+ 项 \/ 逃生计数 \d+ 条（不重放历史，也不给祖先重复上卷）$/.test(
			body38(legacyReviveLine)
		),
		JSON.stringify(legacyReviveLine)
	);

	// ── 38.6 存档兼容：disposed 缺失 / 不是数组 / 元素残缺 ──────────────────────
	// (a) 老存档根本没有 disposed 这个键（本版之前的存档就是这样）：照常加载。
	dropArchive();
	putArchive({
		version: 2,
		savedAt: new Date().toISOString(),
		retired: [],
		sessions: {
			'h2-compat-session': {
				totalInput: 4_000_000,
				familyInput: 0,
				output: 0,
				requests: 4,
				modelCalls: 4,
				toolCalls: 0,
				turn: 2,
				turnInput: 1_000_000,
				familyTurnInput: 0
			}
		},
		stats: { sessions: 1, denied: 0, released: 0, exempted: 0, updatedAt: '2024-01-01T00:00:00.000Z' }
	});
	const h6 = harness({ DSH_LOOP_GUARD_PERSIST: 1 });
	const compatVerdict = await h6.call({ id: 'h2-compat-session' }, 'read', { file_path: 'x' });
	check('38.6a 没有 disposed 键的老存档照常加载（sessions 照旧恢复、照常放行）', compatVerdict?.kind !== 'deny', brief(compatVerdict));
	h6.created({ id: 'h2-compat-nokey', snapshotEvents: () => [] });
	h6.disposed({ id: 'h2-compat-flush' });
	const arch6 = archiveOf();
	check('38.6a 写回去的存档版本号仍是 2（纯加字段，不换版本）', arch6?.version === 2, String(arch6?.version));
	check(
		'38.6a disposed 写出来一定是数组（没有这个键时就是空表，不会是 undefined）',
		Array.isArray(arch6?.disposed),
		Array.isArray(arch6?.disposed) ? `数组，${arch6.disposed.length} 条` : `typeof=${typeof arch6?.disposed}`
	);

	// (b) disposed 不是数组（手工改坏 / 将来换过形状）：当空表处理，不许炸。
	dropArchive();
	putArchive({
		version: 2,
		savedAt: new Date().toISOString(),
		retired: [],
		disposed: { 'h2-compat-nonarray': { requests: 9, totalInput: 9_000_000 } },
		sessions: {},
		stats: {}
	});
	const h7 = harness({ DSH_LOOP_GUARD_PERSIST: 1 });
	h7.created({ id: 'h2-compat-nonarray', snapshotEvents: () => [] });
	h7.disposed({ id: 'h2-compat-nonarray-flush' });
	const nonArrayLive = archiveOf()?.sessions?.['h2-compat-nonarray'];
	check(
		'38.6b disposed 不是数组时按空表处理（对象里的那条没有被当成快照读进来）',
		h7.hasPre === true && (nonArrayLive?.requests ?? 0) === 0 && (nonArrayLive?.totalInput ?? 0) === 0,
		JSON.stringify(nonArrayLive)
	);

	// (c) 数组里的元素残缺 / 是垃圾：坏的跳掉、好的照常读，缺字段按 0 与空串兜底。
	dropArchive();
	putArchive({
		version: 2,
		savedAt: new Date().toISOString(),
		retired: [],
		sessions: {},
		stats: {},
		disposed: [
			null,
			42,
			'x',
			{},
			{ id: '' },
			{ id: 'h2-compat-partial', requests: 3, totalInput: 1_500_000 },
			{ id: 'h2-compat-partial', requests: 999 },
			{ id: 'h2-compat-ok', totalInput: 7_000_000, requests: 7, lastModel: 'deepseek-v4-flash' }
		]
	});
	const h8 = harness({ DSH_LOOP_GUARD_PERSIST: 1 });
	h8.created({ id: 'h2-compat-partial', snapshotEvents: () => [] });
	h8.created({ id: 'h2-compat-ok', snapshotEvents: () => [] });
	h8.disposed({ id: 'h2-compat-flush2' });
	const arch8 = archiveOf();
	const partialLive = arch8?.sessions?.['h2-compat-partial'];
	const okLive = arch8?.sessions?.['h2-compat-ok'];
	check(
		'38.6c 残缺元素照常读、缺字段按 0 与空串兜底（requests 3、totalInput 150 万，其余计数字段全 0、lastModel 空串）',
		partialLive?.requests === 3 &&
			partialLive?.totalInput === 1_500_000 &&
			partialLive?.output === 0 &&
			partialLive?.turn === 0 &&
			partialLive?.cacheReadInput === 0 &&
			partialLive?.costCny === 0 &&
			partialLive?.lastModel === '',
		JSON.stringify(partialLive)
	);
	check(
		'38.6c 存档里同一个 id 出现两次时只认第一条（没有被后面的 999 覆盖）',
		partialLive?.requests === 3,
		JSON.stringify(partialLive)
	);
	check(
		'38.6c 好元素照常读：h2-compat-ok 的 700 万与 7 次请求都在',
		okLive?.totalInput === 7_000_000 && okLive?.requests === 7 && okLive?.lastModel === 'deepseek-v4-flash',
		JSON.stringify(okLive)
	);
	check(
		'38.6c 垃圾元素没有被写回存档（null / 数字 / 空 id / 没有 id 的都没变成记录）',
		Array.isArray(arch8?.disposed) &&
			arch8.disposed.every((item) => item !== null && typeof item === 'object' && typeof item.id === 'string' && item.id !== ''),
		JSON.stringify(arch8?.disposed?.length)
	);
	check(
		'38.6c 存档里同一个 id 出现两次时只留下一条（按 id 去重，不是两条都留着）',
		parkedIds(arch8).length === new Set(parkedIds(arch8)).size,
		JSON.stringify(parkedIds(arch8).filter((id) => id === 'h2-compat-partial').length === 0 ? '已被复活消费' : parkedIds(arch8))
	);
	check('38.6c 版本号仍是 2', arch8?.version === 2, String(arch8?.version));
}

// ══════════ 26. 测试隔离：真账本与真日志一个字节都不许动 ══════════
{
	const stateAfter = snapshot(REAL_STATE);
	const logAfter = snapshot(REAL_LOG);
	// 本机的活账本是按 profile 分文件的（~/.dsh/loop-guard-state.<profile>.json），旧全局路径通常
	// 已经不存在。这时两侧都是 null，断言只剩「旧路径没被创建/改写」这一层含义 —— 不跳过（计数要留住），
	// 但用 SKIP 行如实说明；活账本正被运行中的宿主不断改写，不能拿来当比对靶子。
	const stateVacuous = realStateBefore === null && stateAfter === null;
	const logVacuous = realLogBefore === null && logAfter === null;
	if (stateVacuous) console.log(`SKIP  真账本 ${REAL_STATE} 不存在（本机已改用按 profile 的账本），本断言退化为「旧路径未被创建/改写」`);
	if (logVacuous) console.log(`SKIP  真日志 ${REAL_LOG} 不存在，本断言退化为「旧路径未被创建/改写」`);
	check(
		stateVacuous
			? `测试全程没有写/改真账本（旧全局路径 ${REAL_STATE} 不存在，本断言退化为「旧路径未被创建/改写」）`
			: `测试全程没有写/改真账本（${REAL_STATE}）`,
		stateAfter === realStateBefore,
		stateAfter === realStateBefore ? '' : '真账本被改动了'
	);
	check(
		logVacuous
			? `测试全程没有写/改真日志（旧全局路径 ${REAL_LOG} 不存在，本断言退化为「旧路径未被创建/改写」）`
			: `测试全程没有写/改真日志（${REAL_LOG}）`,
		logAfter === realLogBefore,
		logAfter === realLogBefore ? '' : '真日志被改动了'
	);
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
