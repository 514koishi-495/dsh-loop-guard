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
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const mode = process.argv[2] ?? 'read';
const STATE = fileURLToPath(new URL('./.persist-state.json', import.meta.url));
const LOG = fileURLToPath(new URL('./.persist-log.log', import.meta.url));
// A2（profile 分片与迁移）用的临时家目录：整套仿真都在这里面，跑完删掉。
const A2_ROOT = fileURLToPath(new URL('./.persist-a2', import.meta.url));

// 真账本 / 真日志的基线：跑完必须一字节不差。日志这条尤其要紧 —— 守卫的日志默认是
// 开的，不把 LOG_FILE 指到 test/ 下，这个脚本的「会话预算用尽」「存档版本迁移」这些
// warn 会原样写进用户自己的 ~/.dsh/loop-guard.log（踩过一次）。
const REAL_STATE = path.join(os.homedir(), '.dsh', 'loop-guard-state.json');
const REAL_LOG = path.join(os.homedir(), '.dsh', 'loop-guard.log');
const sha256 = (file) => (fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : '<absent>');
const realStateBefore = sha256(REAL_STATE);
const realLogBefore = sha256(REAL_LOG);

process.env.DSH_LOOP_GUARD_LOG_FILE = LOG;

// 消耗估算的验价：把平价/峰价两列写成同一个数，金额就与「样本到达时刻」无关 ——
// 这个脚本不该因为跑在什么时间点而红绿不同。migrate 分支不碰消耗估算，别把这套 env 带进 A2 仿真。
if (mode !== 'migrate') {
	process.env.DSH_LOOP_GUARD_PRICE_TABLE = JSON.stringify({
		default: { cacheHit: [3, 3], inputMiss: [5, 5], output: [7, 7] },
		pro: { cacheHit: [11, 11], inputMiss: [13, 13], output: [17, 17] }
	});
}

const results = [];
const check = (label, ok, extra = '') => results.push([ok ? 'PASS' : 'FAIL', label, extra]);

/**
 * BOM 那一组用的存档正文（只有数字，沿用本文件的老规矩）。
 *
 * 「bom-prefixed」= 同一份合法正文，只在开头多一个 U+FEFF；
 * 「bom-absent」= 同一份正文，一个字节都不多（对照组）；
 * 「bom-corrupt」= 带 BOM 但正文是坏 JSON（判别力：它**不该**恢复出计数）。
 * 三例共用同一份正文，差别只在开头那个字节。
 */
const bomStateBody = (which) => {
	const body =
		which === 'bom-corrupt'
			? '{ 这不是 JSON'
			: JSON.stringify({
					version: 2,
					savedAt: new Date().toISOString(),
					retired: [],
					sessions: {
						'bom-root': {
							totalInput: 12_345_678,
							output: 4_321,
							requests: 7,
							modelCalls: 7,
							toolCalls: 3,
							turn: 5,
							turnInput: 6_000_000
						}
					},
					stats: { sessions: 1, denied: 1, released: 0, exempted: 0, updatedAt: '2024-01-01T00:00:00.000Z' }
				});
	return which === 'bom-absent' ? body : `\ufeff${body}`;
};



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
			},
			// E5：stats 只读。这里故意塞一个离谱的 denied，用它验证「统计再离谱也不影响门控」。
			stats: { sessions: 1, denied: 999_999, released: 888_888, exempted: 777_777, updatedAt: '2024-01-01T00:00:00.000Z' }
		}),
		'utf8'
	);
	process.env.DSH_LOOP_GUARD_STATE_FILE = STATE;
	delete process.env.DSH_LOOP_GUARD_NO_PERSIST;
} else if (mode === 'bom' || mode === 'bom-case') {
	// BOM 容错：一份**完全合法**的存档，只在开头多一个 U+FEFF。
	// JSON.parse 不认 BOM，而读取侧是「catch 里当第一次跑」的形状 —— 少一个 stripBom，
	// 存档就会被**静默**丢掉、计数归零。这一组就是钉住那个不可见字节。
	fs.writeFileSync(STATE, bomStateBody(process.argv[3] ?? 'bom-prefixed'), 'utf8');
	process.env.DSH_LOOP_GUARD_STATE_FILE = STATE;
	delete process.env.DSH_LOOP_GUARD_NO_PERSIST;
} else {
	// 这一份是 v2 存档：里面躺着一个**已经退休**的会话 id（h1-retired），
	// 以及一个祖先（h1-parent）—— 专门用来验证「退休身份跨重启后不许重放历史」。
	fs.writeFileSync(
		STATE,
		JSON.stringify({
			version: 2,
			savedAt: new Date().toISOString(),
			retired: ['h1-retired'],
			sessions: {
				'persist-root': {
					totalInput: 950_000_000,
					familyInput: 0,
					output: 0,
					requests: 10,
					modelCalls: 10,
					toolCalls: 0,
					turn: 10,
					turnInput: 5_000_000,
					familyTurnInput: 0,
					// 消耗估算的四个新字段：必须原样活过来，而且要在恢复出来的金额上接着累。
					cacheReadInput: 2_000_000,
					uncachedInput: 4_000_000,
					costCny: 12.5,
					lastModel: 'deepseek-v4-flash'
				},
				'h1-parent': {
					totalInput: 0,
					familyInput: 0,
					output: 0,
					requests: 0,
					modelCalls: 0,
					toolCalls: 0,
					turn: 1,
					turnInput: 0,
					familyTurnInput: 0
				}
			},
			// H2：崩溃 / 重启的那些会话**不许从存档里消失**。下面躺着一份 parked 快照 ——
			// 真机里宿主崩溃会把在跑的会话逐个 session/disposed，旧实现顺手把它的计数从存档里
			// 删掉；重启后同一个 id 复活又被 retired 挡住不许重放历史，于是计数从零重数。
			// 这份快照就是「重启后能接着算」的唯一依据，所以它必须在存档里跨进程活下来。
			// 故意只写 13 个计数字段 + id + disposedAt（没有 quotaExempted / escape 那几本小账，
			// 也没写全 19 个键）—— 顺带验证缺字段时按 0 与空串兜底，不会因此整条读不进来。
			disposed: [
				{
					id: 'revive-crashed',
					disposedAt: 1_760_000_000_000,
					totalInput: 24_860_000,
					familyInput: 1_000_000,
					output: 400_000,
					requests: 13,
					modelCalls: 13,
					toolCalls: 5,
					turn: 7,
					turnInput: 3_000_000,
					familyTurnInput: 1_000_000,
					cacheReadInput: 16_000_000,
					uncachedInput: 8_860_000,
					costCny: 95.1,
					lastModel: 'deepseek-v4-flash'
				}
			],
			// E5：stats 是**只读**的展示数据，读回来只该进摘要，绝不能影响门控。
			stats: { sessions: 3, denied: 7, released: 1, exempted: 2, updatedAt: '2024-01-01T00:00:00.000Z' }
		}),
		'utf8'
	);
	process.env.DSH_LOOP_GUARD_STATE_FILE = STATE;
	delete process.env.DSH_LOOP_GUARD_NO_PERSIST;
}

const mod = await import(new URL('../lib/index.js', import.meta.url).href);

const handlers = new Map();
const logs = [];
// 用量端点是「内存里那本账」最干净的观察窗口：只读、不落盘、不为未知会话新建账本。
const routes = [];
const ctx = {
	on(event, fn) {
		if (!handlers.has(event)) handlers.set(event, []);
		handlers.get(event).push(fn);
	},
	logger: { info: (m) => logs.push(['info', m]), warn: (m) => logs.push(['warn', m]) },
	webServer: {
		register(spec) {
			routes.push(spec);
			return () => undefined;
		}
	}
};
mod.apply(ctx, {});

const pre = handlers.get('tools/pre-execute')[0];
const onEvent = handlers.get('session/event')[0];
const session = { id: 'persist-root' };
const next = async () => ({ kind: 'ok' });
const call = (path) => pre({ name: 'read', arguments: { file_path: path }, agent: { session } }, next);

/** 充一笔用量。output 单独给：A1 看的是 turnInput，E1 纯输出门看的是 turnOutput。 */
const charge = (target, tokens, turn, output = 0) =>
	onEvent(target, {
		type: 'assistant/chunk',
		data: { turn, step: 1, chunk: { type: 'usage', usage: { inputTokens: tokens, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: output } } }
	});

/** 记一次模型请求（H1 重放历史时用来判断「这条会话自己动过没」）。 */
const modelCall = (target) => onEvent(target, { type: 'assistant/message', data: {} });

/** session/disposed 里那一次 writeState 是无条件的 —— 拿它把内存账本立刻逼到盘上（charge 的写盘有 10 秒节流）。 */
const saveNow = (target) => handlers.get('session/disposed')[0](target);
const created = (target) => handlers.get('session/created')[0](target);
const readSaved = () => JSON.parse(fs.readFileSync(STATE, 'utf8'));

/** 金额是「CNY / 百万 token」除出来的，别拿 === 比浮点。 */
const near = (actual, expected) => typeof actual === 'number' && Math.abs(actual - expected) < 1e-6;

/** 一笔任意形状的 usage 样本（charge() 只会喂 inputTokens，消耗估算要 cacheRead / cacheWrite / output）。 */
const sampleUsage = (target, usage, turn = 1) =>
	onEvent(target, {
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

/** 让插件认出这一轮的模型（消耗估算要按它选价目表的哪一张、哪一列）。 */
const seeModel = (target, model) =>
	onEvent(target, { type: 'request/header', data: { header: { config: { provider: 'deepseek', model } } } });

/** 只读用量端点。跨重启恢复得对不对、退休会话有没有被重放，看这里的数字最准。 */
async function requestUsage(route, sessionId) {
	if (route === undefined) return null;
	const res = {
		statusCode: 0,
		headers: {},
		body: '',
		writeHead(status, headers) {
			this.statusCode = status;
			if (headers) Object.assign(this.headers, headers);
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
	await route.handler({ method: 'GET', url: `/api/loop-guard/usage?sessionId=${encodeURIComponent(sessionId)}`, headers: {} }, res);
	try {
		return JSON.parse(res.body);
	} catch {
		return null;
	}
}

const USAGE_PATH = '/api/loop-guard/usage';
const usageOf = (sessionId) => requestUsage(routes.find((spec) => spec.path === USAGE_PATH), sessionId);

if (mode === 'bom') {
	// 每个子进程只 import 一次模块（STATE_FILE 在模块加载时读），所以实例个数 = 子进程个数：
	// 三例各起一个子进程，断言在主进程做。子进程的 stdout / stderr 收进内存，
	// 只在断言里露出一行摘要 —— 不然收尾那段「真账本没被写」的报告会被三份输出冲散。
	const spawnCase = (name) =>
		new Promise((resolveCase) => {
			const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'bom-case', name], {
				env: { ...process.env },
				stdio: ['ignore', 'pipe', 'pipe']
			});
			let out = '';
			let err = '';
			child.stdout.on('data', (chunk) => (out += String(chunk)));
			child.stderr.on('data', (chunk) => (err += String(chunk)));
			child.on('close', (code) => {
				const line = out.split('\n').find((text) => text.startsWith('BOMRESULT ')) ?? '';
				let parsed = {};
				try {
					parsed = JSON.parse(line.slice('BOMRESULT '.length));
				} catch {
					parsed = { parseError: line.slice(0, 120) };
				}
				resolveCase({ name, code, err: err.trim().slice(0, 200), ...parsed });
			});
			child.on('error', (error) => resolveCase({ name, code: -1, err: String(error?.message ?? error) }));
		});

	const bomPrefixed = await spawnCase('bom-prefixed');
	const bomAbsent = await spawnCase('bom-absent');
	const bomCorrupt = await spawnCase('bom-corrupt');

	// 正例：开头多一个 U+FEFF，合法存档照样读回来（没有 stripBom 这一条必红）。
	check(
		'BOM 容错：存档开头带一个 U+FEFF，计数照样恢复（没有 stripBom 时这里会归零）',
		bomPrefixed.code === 0 && bomPrefixed.toolCalls === 3 && bomPrefixed.totalInput === 12_345_678,
		JSON.stringify(bomPrefixed)
	);
	// 对照：同一份正文不写 BOM → 正常读回。证明正例的绿不是「端点在撒谎」。
	check(
		'BOM 容错对照：同一份正文不带 BOM 时正常读回（两例之差只有那一个字节）',
		bomAbsent.code === 0 && bomAbsent.toolCalls === 3 && bomAbsent.totalInput === 12_345_678,
		JSON.stringify(bomAbsent)
	);
	// 负例：判别力的证据 —— 带 BOM 但正文是坏 JSON，计数**不该**恢复。
	check(
		'BOM 容错负例：带 BOM 的坏 JSON 一律当第一次跑（证明上面两条真在读存档，不是端点常数）',
		bomCorrupt.code === 0 && bomCorrupt.toolCalls === 0 && bomCorrupt.totalInput === 0,
		JSON.stringify(bomCorrupt)
	);
	console.log(`BOM 子进程 ${[bomPrefixed, bomAbsent, bomCorrupt].map((item) => `${item.name}=exit${item.code}`).join(' ')}`);
} else if (mode === 'bom-case') {
	// 这一支只在子进程里跑：把「读回来的计数」打成一行给主进程解析。
	const bomUsage = (await usageOf('bom-root'))?.session ?? {};
	console.log(
		`BOMRESULT ${JSON.stringify({
			name: process.argv[3],
			toolCalls: bomUsage.toolCalls ?? 0,
			totalInput: bomUsage.totalInput ?? 0
		})}`
	);
} else if (mode === 'write') {
	check('启动时没有存档可恢复', logs.every(([, text]) => !text.includes('从磁盘恢复')));
	charge(session, 50_000_000, 1);
	check('充钱之后盘上立刻有了存档', fs.existsSync(STATE));
	const saved = readSaved();
	check('存档版本号是当前版本 2', saved.version === 2, String(saved.version));
	check('存档里记下了这一笔 5000 万', saved.sessions?.['persist-root']?.totalInput === 50_000_000, JSON.stringify(saved.sessions?.['persist-root']));
	// A1：本轮账（turnInput）也必须落盘。只存 totalInput 的话，重启后同一轮会从 0 重新起算，
	// 「本轮预算」这道门在重启后等于没开。
	check(
		'A1 本轮账落盘：turnInput 记下了这一笔',
		saved.sessions?.['persist-root']?.turnInput === 50_000_000,
		JSON.stringify(saved.sessions?.['persist-root'])
	);
	check(
		'A1 本轮账落盘：没有子代理时 familyTurnInput 是 0（不是 undefined）',
		saved.sessions?.['persist-root']?.familyTurnInput === 0,
		JSON.stringify(saved.sessions?.['persist-root'])
	);
	// v2 存档的形状：退休名单 / 只读统计 / savedAt 三样都得在，少一样就是格式没写完。
	check(
		'存档是 v2 形状：retired、stats、savedAt 都在',
		Array.isArray(saved.retired) && saved.stats !== null && typeof saved.stats === 'object' && typeof saved.savedAt === 'string',
		JSON.stringify({ retired: saved.retired, stats: saved.stats, savedAt: saved.savedAt })
	);
	check('存档里没有对话正文（只有数字）', !JSON.stringify(saved).includes('usage'));
	// 消耗估算：四个新字段也要随存档落盘，而且存档里依然只有数字/短字符串（不许出现正文）。
	// 价目表这一趟被 PRICE_TABLE 钉成平价=峰价：2 百万 × 3 + 3 百万 × 5 + 1 百万 × 7 = 28。
	const costSession = { id: 'persist-cost' };
	seeModel(costSession, 'deepseek-v4-flash');
	sampleUsage(costSession, { inputTokens: 3_000_000, cacheReadTokens: 2_000_000, outputTokens: 1_000_000 });
	saveNow({ id: 'persist-dummy-cost' });
	const costSaved = readSaved().sessions?.['persist-cost'];
	check(
		'消耗估算落盘：cacheReadInput / uncachedInput / output 各记各的',
		costSaved?.cacheReadInput === 2_000_000 && costSaved?.uncachedInput === 3_000_000 && costSaved?.output === 1_000_000,
		JSON.stringify(costSaved)
	);
	// 契约钉死了这一列的格式：裸模型名（不加 provider 前缀；provider 只在模型名缺失时兜底）。
	check(
		'消耗估算落盘：lastModel 是裸模型名（非空、不含 "/"、就是这一轮的模型名）',
		typeof costSaved?.lastModel === 'string' && costSaved.lastModel !== '' && !costSaved.lastModel.includes('/') && costSaved.lastModel.includes('deepseek-v4-flash'),
		JSON.stringify(costSaved?.lastModel)
	);
	check('消耗估算落盘：costCny = 28（按覆盖后的价目表算）', near(costSaved?.costCny, 28), String(costSaved?.costCny));
	check('消耗估算落盘：存档版本号仍然是 2（新字段不换版本）', readSaved().version === 2, String(readSaved().version));
	check(
		'消耗估算落盘：存档里仍然没有对话正文（新字段也全是数字/短字符串）',
		costSaved !== undefined &&
			Object.values(costSaved).every((value) => typeof value === 'number' || (typeof value === 'string' && value.length <= 64)) &&
			!JSON.stringify(costSaved).includes('usage'),
		JSON.stringify(costSaved)
	);
	// A1：同一轮再充一笔 → 续账，不归零。charge 的写盘有 10 秒节流，所以借 session/disposed
	// 那一次无条件 writeState 把内存账本逼到盘上（dispose 的是另一个 id，不动 root 的账）。
	charge(session, 20_000_000, 1);
	saveNow({ id: 'persist-dummy' });
	const continued = readSaved();
	check(
		'A1 同一轮续账：turn 没变，本轮账从 5000 万累到 7000 万（不归零）',
		continued.sessions?.['persist-root']?.turnInput === 70_000_000,
		JSON.stringify(continued.sessions?.['persist-root'])
	);
	// H1：会话退休后 id 必须进 retired。不落盘的话，同一个 session id 在重启后复活会被
	// 当成新会话，把 snapshot 历史整段重放一遍 —— 那笔历史会再上卷给祖先一次。
	saveNow(session);
	const retired = readSaved();
	check(
		'H1 会话 disposed 之后，它的 id 落进了存档的 retired',
		Array.isArray(retired.retired) && retired.retired.includes('persist-root'),
		JSON.stringify(retired.retired)
	);
	check(
		'E5 存档带只读统计段 stats（updatedAt 是时间戳）',
		retired.stats !== null && typeof retired.stats === 'object' && typeof retired.stats.updatedAt === 'string' && retired.stats.sessions >= 1,
		JSON.stringify(retired.stats)
	);

	// ── H2：注销时把账留在存档里，不是把它删掉 ──────────────────────────────────
	// 上面 saveNow(session) 注销的正是 persist-root。旧口径在这一步之后存档里就查无此人：
	// 重启后同 id 复活又被 retired 挡住不许重放历史 → 计数从零重数（真机实测：崩溃前
	// 2485.7 万 token / 13 次请求，重启后只剩 260 万 / 13 次请求里的一小截）。
	// 新口径：快照留在 disposed 里等复活，所以这 13 个字段必须一个不差地写进存档。
	const parked = readSaved().disposed?.find((item) => item?.id === 'persist-root');
	check(
		'H2 注销时落盘：persist-root 出现在存档的 disposed 里，13 个计数字段与注销前的账逐一相等',
		parked !== undefined &&
			parked.totalInput === 70_000_000 &&
			parked.familyInput === 0 &&
			parked.output === 0 &&
			parked.requests === 2 &&
			parked.modelCalls === 0 &&
			parked.toolCalls === 0 &&
			parked.turn === 1 &&
			parked.turnInput === 70_000_000 &&
			parked.familyTurnInput === 0 &&
			parked.cacheReadInput === 0 &&
			parked.uncachedInput === 70_000_000 &&
			near(parked.costCny, 350) &&
			parked.lastModel === '' &&
			typeof parked.disposedAt === 'number' &&
			parked.disposedAt > 0,
		JSON.stringify(parked)
	);
	check(
		'H2 注销之后同一个 id 不再留在 sessions（内存账本放掉了，存档里只留这一份快照）',
		readSaved().sessions?.['persist-root'] === undefined,
		JSON.stringify(readSaved().sessions?.['persist-root'] ?? null)
	);
	check(
		'H2 注销走的还是老规矩：id 同时也在 retired 里（H1 的「不许重放」没被这次改动拆掉）',
		readSaved().retired?.includes('persist-root') === true,
		JSON.stringify(readSaved().retired)
	);
	fs.rmSync(STATE, { force: true });
} else if (mode !== 'migrate') {
	check('启动日志报出恢复了 2 个会话', logs.some(([, text]) => text.includes('已从磁盘恢复 2 个会话')));
	check('恢复后 9.5 亿还没到 10 亿，照常放行', (await call('x'))?.kind !== 'deny');

	// A1：本轮账也必须跟着活过来。turn 没变 → 续账（5 百万 + 1 百万）；turn 变了 → 换轮清零。
	const restored = await usageOf('persist-root');
	check('A1 本轮账跨重启恢复：turnInput 5 百万 也活了过来', restored?.turn?.input === 5_000_000, JSON.stringify(restored?.turn));
	// 契约只写了 payload 里有 model、没写格式（实测是 provider/model），这里只钉「恢复的模型名在里面」。
	check(
		'消耗估算跨重启：costCny / cacheReadInput / uncachedInput / lastModel 都恢复了',
		restored?.cost?.cny === 12.5 &&
			restored?.cost?.cacheReadInput === 2_000_000 &&
			restored?.cost?.uncachedInput === 4_000_000 &&
			typeof restored?.cost?.model === 'string' &&
			restored.cost.model.includes('deepseek-v4-flash'),
		JSON.stringify(restored?.cost)
	);
	charge(session, 1_000_000, 10);
	const continued = await usageOf('persist-root');
	check(
		'A1 turn 相同 → 续账，不清零（500 万 + 100 万 = 600 万）',
		continued?.turn?.input === 6_000_000,
		JSON.stringify(continued?.turn)
	);
	// 消耗估算同样要「接着算」：恢复的 12.5 上再加这一笔（1 百万 input × 平价 5 = 5）→ 17.5。
	// 从 0 重算的话这里会是 5 —— 那就是把重启前花掉的钱忘了。
	check('消耗估算续累：12.5 + 1 百万 × 5 = 17.5（不是从 0 重算）', near(continued?.cost?.cny, 17.5), JSON.stringify(continued?.cost));
	check('消耗估算续累：uncachedInput 从 4 百万涨到 5 百万', continued?.cost?.uncachedInput === 5_000_000, JSON.stringify(continued?.cost));
	check('这一笔只有 input：cacheReadInput 停在恢复的 2 百万', continued?.cost?.cacheReadInput === 2_000_000, JSON.stringify(continued?.cost));
	charge(session, 2_000_000, 11);
	const turned = await usageOf('persist-root');
	check(
		'A1 turn 变了 → 由换轮逻辑清零，本轮账只剩新充的 200 万',
		turned?.turn?.input === 2_000_000,
		JSON.stringify(turned?.turn)
	);

	charge(session, 90_000_000, 11);
	const after = await call('y');
	check(
		'历史 9.5 亿 + 本轮 0.9 亿 → 会话预算拦下',
		after?.kind === 'deny' && after.info.code === 'LOOP_GUARD_SESSION_BUDGET',
		`${after?.kind}/${after?.info?.code ?? '-'}`
	);

	// H1：退休身份跨重启。h1-retired 上一次生命已经 disposed 过（写在 retired 里），
	// 这次又被 session/created 唤醒 —— 它绝不能把 snapshot 里的历史再重放一遍并上卷给祖先。
	const snapshot = (tokens) => [
		{ type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: tokens, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 } } } }
	];
	created({ id: 'h1-retired', header: { origin: 'subagent', parentSession: 'h1-parent' }, snapshotEvents: () => snapshot(400_000_000) });
	const retiredBack = await usageOf('h1-retired');
	const parentQuiet = await usageOf('h1-parent');
	check(
		'H1 已退休 id 跨重启复活：不重放 snapshot 历史（自己仍是 0）',
		retiredBack?.session?.totalInput === 0,
		JSON.stringify(retiredBack?.session)
	);
	check(
		'H1 已退休 id 复活：那 4 亿没有再次上卷给祖先',
		parentQuiet?.session?.familyInput === 0,
		JSON.stringify(parentQuiet?.session)
	);
	// 反证：一个从没退休过的全新 id 必须照常吸收 snapshot 历史，否则上面那条断言可能只是「重放坏了」。
	created({ id: 'h1-fresh', header: { origin: 'subagent', parentSession: 'h1-parent' }, snapshotEvents: () => snapshot(100_000_000) });
	const fresh = await usageOf('h1-fresh');
	const parentFed = await usageOf('h1-parent');
	check(
		'H1 反证：全新 session id 仍会正常吸收 snapshot 历史（1 亿）',
		fresh?.session?.totalInput === 100_000_000,
		JSON.stringify(fresh?.session)
	);
	check(
		'H1 反证：并正常上卷给祖先（familyInput 1 亿）',
		parentFed?.session?.familyInput === 100_000_000,
		JSON.stringify(parentFed?.session)
	);

	// E5：退休名单与只读统计写回盘上；stats 里的数字只该被恢复+累加，不该反过来左右门控
	// （这一轮里唯一的拦截就是上面那条 LOOP_GUARD_SESSION_BUDGET）。
	saveNow({ id: 'h1-fresh' });
	const saved = readSaved();
	check(
		'E5 只读统计跨重启恢复并累加：denied 7 + 本次 1 次拦截 = 8',
		saved.stats?.denied === 8,
		JSON.stringify(saved.stats)
	);
	check(
		'E5 只读统计里的 released / exempted 原样保留（没被门控重算）',
		saved.stats?.released === 1 && saved.stats?.exempted === 2,
		JSON.stringify(saved.stats)
	);
	check(
		'H1 退休名单写回存档：老 id 还在，新退休的也在',
		Array.isArray(saved.retired) && saved.retired.includes('h1-retired') && saved.retired.includes('h1-fresh'),
		JSON.stringify(saved.retired)
	);

	// ── H2：跨进程复活（这一段是这节的承重墙）────────────────────────────────────
	// 上面那份 fixture 里躺着一个 'revive-crashed' 的 parked 快照，它是**上一个进程**
	// （宿主崩溃之前）留下的。这个进程从来没给这个 id 建过账本 —— 计数只可能来自存档。
	// 触发 session/created 时盯两件事：① 13 个字段整体接回来；② snapshotEvents 一次都没被
	// 调用（历史没重放，那 4 亿也没有第二次上卷给祖先）。
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
	/** 用量端点把这 13 个字段摊在 session / turn / cost 三处：还原成存档里那种扁平形状。 */
	const flatUsage = (usage) => ({
		totalInput: usage?.session?.totalInput,
		familyInput: usage?.session?.familyInput,
		output: usage?.session?.output,
		requests: usage?.session?.requests,
		modelCalls: usage?.session?.modelCalls,
		toolCalls: usage?.session?.toolCalls,
		turn: usage?.session?.turn,
		turnInput: usage?.turn?.input,
		familyTurnInput: usage?.turn?.familyTurnInput,
		cacheReadInput: usage?.cost?.cacheReadInput,
		uncachedInput: usage?.cost?.uncachedInput,
		costCny: usage?.cost?.cny,
		lastModel: usage?.cost?.model
	});
	const parkedOnDisk = readSaved().disposed?.find((item) => item?.id === 'revive-crashed');
	check(
		'H2 前置：新进程加载后，崩溃会话的 parked 快照还在存档里（13 个字段都在、disposedAt 是数字）',
		parkedOnDisk !== undefined && H2_FIELDS.every((field) => field in parkedOnDisk) && typeof parkedOnDisk.disposedAt === 'number',
		JSON.stringify(parkedOnDisk)
	);
	let replayed = 0;
	created({
		id: 'revive-crashed',
		header: { origin: 'subagent', parentSession: 'h1-parent' },
		snapshotEvents: () => {
			replayed += 1;
			return [
				{
					type: 'assistant/chunk',
					data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 400_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 } } }
				}
			];
		}
	});
	const revived = flatUsage(await usageOf('revive-crashed'));
	const parentAfterRevive = await usageOf('h1-parent');
	check('H2 跨进程复活：没有重放历史（注入的 snapshotEvents 一次都没被调用）', replayed === 0, `snapshotEvents 调用 ${replayed} 次`);
	check(
		'H2 跨进程复活：13 个计数字段与存档里那份快照逐一相等（金额也接回来了）',
		parkedOnDisk !== undefined &&
			H2_FIELDS.every((field) =>
				typeof parkedOnDisk[field] === 'number' ? near(revived[field], parkedOnDisk[field]) : revived[field] === parkedOnDisk[field]
			),
		JSON.stringify({ actual: revived, expected: parkedOnDisk })
	);
	check(
		'H2 跨进程复活：那 4 亿没有二次上卷给祖先（familyInput 仍是 h1-fresh 那一笔 1 亿）',
		parentAfterRevive?.session?.familyInput === 100_000_000,
		JSON.stringify(parentAfterRevive?.session)
	);
	const reviveLine = logs.map(([, text]) => text).find((text) => text.includes('会话复活，接着算：revive-crashed')) ?? '';
	const reviveBody = reviveLine.slice(reviveLine.indexOf('会话复活，接着算：'));
	check(
		'H2 复活只写一行冻结文案的 info 日志（id + 计数 + 括号里那两句，没有正文 / JSON）',
		reviveBody ===
			'会话复活，接着算：revive-crashed ← 退休前 计费输入 2486 万 token、请求 13 次、轮次 7、金额 ¥95.1、配额豁免 0 项 / 逃生计数 0 条（不重放历史，也不给祖先重复上卷）',
		JSON.stringify(reviveLine)
	);
	// 取回即消费：复活之后账已经活在内存里，写回存档时不该再留一份 parked 快照 ——
	// 同一份存档里长期留两份账，重启第二次就会拿旧快照把新计数盖回去。
	saveNow({ id: 'persist-h2-flush' });
	const afterRevive = readSaved();
	check(
		'H2 取回即消费：写回存档后 revive-crashed 不再留在 disposed（同一份存档不长期留两份账）',
		(afterRevive.disposed ?? []).every((item) => item?.id !== 'revive-crashed'),
		JSON.stringify((afterRevive.disposed ?? []).map((item) => item?.id))
	);
	check(
		'H2 取回即消费：它的账此时在 sessions 里活着（数字接着算，没有从零重数）',
		afterRevive.sessions?.['revive-crashed']?.totalInput === 24_860_000 && afterRevive.sessions?.['revive-crashed']?.requests === 13,
		JSON.stringify(afterRevive.sessions?.['revive-crashed'])
	);
	fs.rmSync(STATE, { force: true });
} else if (mode === 'migrate') {
	const migrated = logs.filter(([, text]) => text.includes('迁移') && text.includes('版本'));
	check(
		'版本不匹配时打一条「迁移」warn，而不是整份丢弃',
		migrated.length > 0,
		logs.map(([, t]) => t).join(' | ').slice(0, 200)
	);
	const first = await call('m1');
	check('迁移保留了 totalInput：9.5 亿还在，没到 10 亿时照常放行', first?.kind !== 'deny', `${first?.kind ?? '-'}`);
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
	// 落盘要看「拦截之后」的那一刻：deny 只改内存里的 stats，不等它下一次写盘是看不到的
	// （dispose 里的 writeState 是无条件的那一次，正好用来把内存账本逼到盘上）。
	saveNow({ id: 'persist-migrated' });
	const saved2 = JSON.parse(fs.readFileSync(STATE, 'utf8'));
	check('迁移后写回的是当前版本号 2', saved2.version === 2, String(saved2.version));
	check(
		'familyInput 与 turn 一起活了下来（下次写盘仍是它们）',
		saved2.sessions?.['persist-root']?.familyInput === 999_999_999 && saved2.sessions?.['persist-root']?.turn === 13,
		JSON.stringify(saved2.sessions?.['persist-root'])
	);
	// E5：stats 只读。它被读回来只为「会话收尾摘要」那一行字，绝不能反过来变成闸门的输入。
	check(
		'E5 stats 只读：denied 被塞成 999999，门控行为完全不变（9.5 亿放行、累加到 10.43 亿才拦，且拦的是会话预算）',
		first?.kind !== 'deny' && after?.kind === 'deny' && after.info.code === 'LOOP_GUARD_SESSION_BUDGET',
		`first=${first?.kind ?? '-'} after=${after?.kind}/${after?.info?.code ?? '-'}`
	);
	check(
		'E5 只读统计跨重启恢复并累加：denied 999999 + 本次 1 次拦截 = 1000000',
		saved2.stats?.denied === 1_000_000,
		JSON.stringify(saved2.stats)
	);
	check(
		'E5 只读统计里的 released / exempted 原样带过来（不是从门控重算的）',
		saved2.stats?.released === 888_888 && saved2.stats?.exempted === 777_777,
		JSON.stringify(saved2.stats)
	);
	fs.rmSync(STATE, { force: true });
}

// ══════════════════════════════════════════════════════════════════════════
// A2 · 状态文件按 profile 分片与迁移
//
// 事故现场：显式给了 DSH_LOOP_GUARD_STATE_FILE 时**绝不能**去动用户的老存档。
//
// profile 名是从 import.meta.url 里抓的（形如
// …\.dsh\profiles\<名字>\node_modules\dsh-loop-guard\lib\index.js），所以这件事没法拿
// 已经加载过的主模块来测：必须在一个临时家目录里把那份目录结构造出来，再把 lib/index.js
// 复制过去、改掉 USERPROFILE/HOME，然后 import 一次。整套仿真都在 test/.persist-a2/ 下。
// ══════════════════════════════════════════════════════════════════════════
if (mode === 'migrate') {
	const LIB_SRC = fileURLToPath(new URL('../lib/index.js', import.meta.url));
	const SIM_HOME = path.join(A2_ROOT, 'home');
	const SIM_DASH = path.join(SIM_HOME, '.dsh');
	const LEGACY = path.join(SIM_DASH, 'loop-guard-state.json');
	const shard = (name) => path.join(SIM_DASH, `loop-guard-state.${name}.json`);
	const profileLib = (name) => path.join(SIM_DASH, 'profiles', name, 'node_modules', 'dsh-loop-guard', 'lib', 'index.js');
	const makeCopy = (file) => {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.copyFileSync(LIB_SRC, file);
	};
	// 仿真时用的「假家目录」env。DSH_PROFILE / DSH_LOOP_GUARD_STATE_FILE 显式删掉，
	// 让副本只能靠 import.meta.url 认 profile（这正是线上 profile 安装时的情形）。
	const SIM_ENV = { USERPROFILE: SIM_HOME, HOME: SIM_HOME, DSH_PROFILE: null, DSH_LOOP_GUARD_STATE_FILE: null };

	/** import 一份模块副本并 apply。env 必须在 import 之前换好（模块加载时只读一次）。 */
	const applyCopy = async (file, env) => {
		const before = new Map();
		for (const [key, value] of Object.entries(env)) {
			before.set(key, process.env[key]);
			if (value === null) delete process.env[key];
			else process.env[key] = value;
		}
		const copyHandlers = new Map();
		const copyLogs = [];
		const copyRoutes = [];
		const copyCtx = {
			on(event, fn) {
				if (!copyHandlers.has(event)) copyHandlers.set(event, []);
				copyHandlers.get(event).push(fn);
			},
			logger: { info: (m) => copyLogs.push(['info', m]), warn: (m) => copyLogs.push(['warn', m]) },
			webServer: {
				register(spec) {
					copyRoutes.push(spec);
					return () => undefined;
				}
			}
		};
		const copyMod = await import(pathToFileURL(file).href);
		copyMod.apply(copyCtx, {});
		return {
			logs: copyLogs,
			pre: copyHandlers.get('tools/pre-execute')[0],
			event: copyHandlers.get('session/event')[0],
			dispose: copyHandlers.get('session/disposed')[0],
			usageOf: (sessionId) => requestUsage(copyRoutes.find((spec) => spec.path === USAGE_PATH), sessionId),
			restore() {
				for (const [key, value] of before) {
					if (value === undefined) delete process.env[key];
					else process.env[key] = value;
				}
			}
		};
	};

	// A2-1 显式 STATE_FILE：绝不迁移、绝不改名。
	{
		fs.rmSync(A2_ROOT, { recursive: true, force: true });
		makeCopy(profileLib('alpha'));
		fs.mkdirSync(SIM_DASH, { recursive: true });
		fs.writeFileSync(LEGACY, JSON.stringify({ version: 2, sessions: { 'a2-old': { totalInput: 7 } } }), 'utf8');
		const legacyBefore = fs.readFileSync(LEGACY, 'utf8');
		const explicit = path.join(A2_ROOT, 'explicit-state.json');
		const copy = await applyCopy(profileLib('alpha'), { ...SIM_ENV, DSH_LOOP_GUARD_STATE_FILE: explicit });
		check(
			'A2 显式 STATE_FILE：老存档没被改名（原文件还在、没有 .migrated 残留）',
			fs.existsSync(LEGACY) && !fs.existsSync(`${LEGACY}.migrated`),
			`legacy=${fs.existsSync(LEGACY)} migrated=${fs.existsSync(`${LEGACY}.migrated`)}`
		);
		check('A2 显式 STATE_FILE：也没有往 profile 分片路径搬一份', !fs.existsSync(shard('alpha')), fs.readdirSync(SIM_DASH).join(','));
		copy.dispose({ id: 'a2-explicit' });
		check(
			'A2 显式 STATE_FILE：落盘落在显式路径上',
			fs.existsSync(explicit) && JSON.parse(fs.readFileSync(explicit, 'utf8')).retired.includes('a2-explicit'),
			fs.existsSync(explicit) ? '' : 'explicit-state.json 不存在'
		);
		check('A2 显式 STATE_FILE：写过盘之后老存档仍然一字未改', fs.readFileSync(LEGACY, 'utf8') === legacyBefore);
		copy.restore();
	}

	// A2-2 默认路径 + 认得出 profile：搬进分片路径、老文件改名 .migrated，且重复执行幂等。
	{
		fs.rmSync(A2_ROOT, { recursive: true, force: true });
		makeCopy(profileLib('beta'));
		makeCopy(profileLib('beta').replace(/index\.js$/, 'second.js'));
		fs.mkdirSync(SIM_DASH, { recursive: true });
		fs.writeFileSync(
			LEGACY,
			JSON.stringify({ version: 2, savedAt: 'x', retired: [], sessions: { 'a2-beta': { totalInput: 123, turn: 1 } } }),
			'utf8'
		);
		const copy = await applyCopy(profileLib('beta'), SIM_ENV);
		check(
			'A2 认出 profile：老存档内容被搬进按 profile 命名的分片文件',
			fs.existsSync(shard('beta')) && fs.readFileSync(shard('beta'), 'utf8').includes('a2-beta'),
			`shard=${fs.existsSync(shard('beta'))}`
		);
		check('A2 认出 profile：搬完把老文件改名为 .migrated', !fs.existsSync(LEGACY) && fs.existsSync(`${LEGACY}.migrated`));
		check('A2 认出 profile：日志明说按 profile 分片', copy.logs.some(([, text]) => text.includes('按 profile 分片')));
		check(
			'A2 认出 profile：搬过去的账真的被读回来了（123 在里面）',
			(await copy.usageOf('a2-beta'))?.session?.totalInput === 123,
			JSON.stringify((await copy.usageOf('a2-beta'))?.session)
		);
		const shardAfter = fs.readFileSync(shard('beta'), 'utf8');
		const migratedAfter = fs.readFileSync(`${LEGACY}.migrated`, 'utf8');
		// 幂等：同一个 profile 再启动一次（同一份目录结构的第二份副本），什么都不该再动。
		const second = await applyCopy(profileLib('beta').replace(/index\.js$/, 'second.js'), SIM_ENV);
		check(
			'A2 迁移幂等：第二次不再搬（分片与 .migrated 都一字未变）',
			fs.readFileSync(shard('beta'), 'utf8') === shardAfter && fs.readFileSync(`${LEGACY}.migrated`, 'utf8') === migratedAfter
		);
		check(
			'A2 迁移幂等：第二次不再打「按 profile 分片」的迁移日志',
			!second.logs.some(([, text]) => text.includes('按 profile 分片'))
		);
		check('A2 迁移幂等：第二次照样从分片文件里读回账（123 还在）', (await second.usageOf('a2-beta'))?.session?.totalInput === 123);
		copy.restore();
		second.restore();
	}

	// A2-3 认不出 profile（路径里没有 profiles/<名字>/node_modules/dsh-loop-guard/）：不迁移、不改名，
	// 老账本照常读回来（只读回退）—— 不许瞎猜一个 profile 名字就动用户的文件。
	{
		fs.rmSync(A2_ROOT, { recursive: true, force: true });
		const plainLib = path.join(A2_ROOT, 'plain-copy', 'lib', 'index.js');
		makeCopy(plainLib);
		fs.mkdirSync(SIM_DASH, { recursive: true });
		fs.writeFileSync(
			LEGACY,
			JSON.stringify({ version: 2, retired: [], sessions: { 'a2-plain': { totalInput: 950_000_000, turn: 1 } } }),
			'utf8'
		);
		const legacyBefore = fs.readFileSync(LEGACY, 'utf8');
		const copy = await applyCopy(plainLib, SIM_ENV);
		check(
			'A2 认不出 profile：不迁移也不改名（老文件原样、没有 .migrated、目录里没多出文件）',
			fs.readFileSync(LEGACY, 'utf8') === legacyBefore &&
				!fs.existsSync(`${LEGACY}.migrated`) &&
				fs.readdirSync(SIM_DASH).filter((name) => name !== path.basename(LEGACY)).length === 0,
			fs.readdirSync(SIM_DASH).join(',')
		);
		check(
			'A2 认不出 profile：老账本仍然读得回来（9.5 亿在里面）',
			(await copy.usageOf('a2-plain'))?.session?.totalInput === 950_000_000,
			JSON.stringify((await copy.usageOf('a2-plain'))?.session)
		);
		copy.restore();
	}

	// A2-4 迁移/写盘失败时不许抛给宿主（apply 不能炸）。
	{
		fs.rmSync(A2_ROOT, { recursive: true, force: true });
		makeCopy(profileLib('gamma'));
		fs.mkdirSync(SIM_DASH, { recursive: true });
		fs.writeFileSync(
			LEGACY,
			JSON.stringify({ version: 2, retired: [], sessions: { 'a2-gamma': { totalInput: 950_000_000, turn: 1 } } }),
			'utf8'
		);
		// 让「写临时文件」这一步必然失败：把 <分片>.tmp 先占成一个目录 → writeFileSync 抛 EISDIR。
		fs.mkdirSync(`${shard('gamma')}.tmp`, { recursive: true });
		const legacyBefore = fs.readFileSync(LEGACY, 'utf8');
		let copy = null;
		let threw = '';
		try {
			copy = await applyCopy(profileLib('gamma'), SIM_ENV);
		} catch (error) {
			threw = String(error?.message ?? error);
		}
		check('A2 迁移失败：apply 不抛给宿主', threw === '', threw);
		check(
			'A2 迁移失败：只打一条「老存档迁移失败」的 warn',
			copy?.logs.some(([level, text]) => level === 'warn' && text.includes('老存档迁移失败')) === true,
			copy?.logs.map(([, text]) => text).join(' | ').slice(0, 200)
		);
		check(
			'A2 迁移失败：老文件保持原样（既没搬走也没改名）',
			fs.readFileSync(LEGACY, 'utf8') === legacyBefore && !fs.existsSync(`${LEGACY}.migrated`)
		);
		// 迁移失败也不能让守卫坏掉：老账本按只读回退读进来，9.5 亿还在 → 再充 0.9 亿就该拦。
		copy.event(
			{ id: 'a2-gamma' },
			{
				type: 'assistant/chunk',
				data: { turn: 2, step: 1, chunk: { type: 'usage', usage: { inputTokens: 90_000_000, outputTokens: 0 } } }
			}
		);
		const verdict = await copy.pre({ name: 'read', arguments: { file_path: 'x' }, agent: { session: { id: 'a2-gamma' } } }, next);
		check(
			'A2 迁移失败：闸门照常基于老账本工作（9.5 亿 + 0.9 亿 → 会话预算拦下）',
			verdict?.kind === 'deny' && verdict.info.code === 'LOOP_GUARD_SESSION_BUDGET',
			`${verdict?.kind}/${verdict?.info?.code ?? '-'}`
		);
		check(
			'A2 迁移失败：连写盘失败也只 warn，不外抛',
			copy?.logs.some(([level, text]) => level === 'warn' && text.includes('计数存档写盘失败')) === true
		);
		copy.restore();
	}
}

// 真账本 / 真日志隔离：这个脚本会主动把预算烧到线上、还会写一份版本对不上的存档，
// 两者都会让守卫记 warn —— 那些 warn 只能落在 test/ 下的临时日志里。
const stateAfter = sha256(REAL_STATE);
const logAfter = sha256(REAL_LOG);
// 本机的活账本是按 profile 分文件的（~/.dsh/loop-guard-state.<profile>.json），旧全局路径通常
// 已经不存在。这时两侧都是 '<absent>'，断言只剩「旧路径没被创建/改写」这一层含义 —— 不跳过
// （计数要留住），但用 SKIP 行如实说明；活账本正被运行中的宿主不断改写，不能拿来当比对靶子。
const stateVacuous = realStateBefore === '<absent>' && stateAfter === '<absent>';
const logVacuous = realLogBefore === '<absent>' && logAfter === '<absent>';
if (stateVacuous) console.log(`SKIP  真账本 ${REAL_STATE} 不存在（本机已改用按 profile 的账本），本断言退化为「旧路径未被创建/改写」`);
if (logVacuous) console.log(`SKIP  真日志 ${REAL_LOG} 不存在，本断言退化为「旧路径未被创建/改写」`);
check(
	stateVacuous
		? `测试全程没有写/改真账本（旧全局路径 ${REAL_STATE} 不存在，本断言退化为「旧路径未被创建/改写」）`
		: `测试全程没有写/改真账本（${REAL_STATE}）`,
	stateAfter === realStateBefore,
	realStateBefore
);
check(
	logVacuous
		? `测试全程没有写/改真日志（旧全局路径 ${REAL_LOG} 不存在，本断言退化为「旧路径未被创建/改写」）`
		: `测试全程没有写/改真日志（${REAL_LOG}）`,
	logAfter === realLogBefore,
	realLogBefore
);

// 自己的临时文件也收掉（状态文件各分支里删过，这里连同临时日志、A2 仿真家目录一起收尾）。
fs.rmSync(LOG, { force: true });
fs.rmSync(STATE, { force: true });
fs.rmSync(A2_ROOT, { recursive: true, force: true });

let failed = 0;
for (const [status, label, extra] of results) {
	if (status === 'FAIL') failed += 1;
	console.log(`${status}  ${label}${extra === '' ? '' : `   [${extra}]`}`);
}
console.log(`[persist/${mode}] 通过 ${results.length - failed}/${results.length}`);
process.exit(failed === 0 ? 0 : 1);
