/**
 * dsh-loop-guard —— 防烧钱守卫
 *
 * 六道闸门，都在「模型要发工具调用」的那一刻判定，全部是查表 + 计数，
 * 不花一分钱 token，也不调用模型：
 *
 * 1. 本轮预算硬停手。一次问答（一个 turn）累计计费输入到达上限 —— **含这一轮
 *    生出来的所有子代理** —— 之后所有工具调用都被拦，只在理由里要求模型立刻
 *    交账：已经做完什么 / 还剩什么 / 建议用户怎么继续。软着陆模式下改成
 *    「只拦继续探索的工具，放过收尾工具」。子代理必须算进来，否则一次对话可以
 *    自己烧满 1 亿、再让 8 个子代理各烧 1 亿。
 * 2. 家族总预算。一个会话的账除了记自己，还沿 parentSession 往上给每个祖先
 *    加一笔，于是祖先的 familyInput 天然等于「自己 + 所有后代」。默认关闭。
 *    注意它和 1 的分工：1 是「本轮含后代」，2 是「整场含后代」。
 * 3. 子代理请求数 / 工具数上限。这两个数不依赖 usage 事件，字段改名也数得到。
 * 4. 横向异常判定。同一个父下面的兄弟子代理取花费中位数，谁比中位数高好几倍
 *    就单独掐它 —— 这才是「异常」唯一有意义的定义。
 * 5. 熔断。子代理烧了一大笔却只吐回一丁点输出，记一次失败；同一个父下面失败
 *    够多次，就不再允许它生新的子代理。
 * 6. 扇出上限。subagent / subagent_fork / workflow 出生那一刻就查并发数，
 *    子代理是乘数，卡住入口比等它烧完再拦便宜得多。
 *
 * 所有「拦」都带逃生门，分两种语义（见 tryDeny / quotaExempt 的注释）：
 * 重复类闸门最多拦 N 次（默认 3）之后放行一次；配额类闸门只给一次豁免。
 * 无论哪种，**绝不把 agent 锁死**。
 *
 * 环境变量：
 *   DSH_LOOP_GUARD_MAX_TOKENS           单次问答 token 上限（含该轮子代理），默认 100000000（1 亿）；0/负数 = 不设限
 *   DSH_LOOP_GUARD_SESSION_MAX_TOKENS   整个会话跨轮累计上限（只算自己），默认 1000000000（10 亿）
 *   DSH_LOOP_GUARD_FAMILY_MAX_TOKENS    家族（自己+后代）累计上限，默认关闭；设成 10 亿即「会话含后代」
 *   DSH_LOOP_GUARD_WARN_RATIO           预警比例，默认 0.7
 *   DSH_LOOP_GUARD_REPEAT_LIMIT         同签名允许执行次数，默认 4（第 5 次拦）
 *   DSH_LOOP_GUARD_READ_REPEAT_LIMIT    read 工具的阈值，默认 5
 *   DSH_LOOP_GUARD_SKELETON_LIMIT       同骨架（抹掉数字与字符串后同形）允许次数，默认 10
 *   DSH_LOOP_GUARD_CYCLE_LIMIT          乒乓循环：同一对调用重复几轮算循环，默认 3
 *   DSH_LOOP_GUARD_SAME_ERROR_LIMIT     同一个错误重复出现几次算原地打转，默认 2
 *   DSH_LOOP_GUARD_MAX_DENIALS          同一处最多拦几次后放行，默认 3
 *   DSH_LOOP_GUARD_MAX_FANOUT           同时存活的子代理数上限，默认 8
 *   DSH_LOOP_GUARD_FANOUT_TTL_MS        子代理多久没动静就不再算它活着，默认 20 分钟
 *   DSH_LOOP_GUARD_MAX_WORKFLOW_AGENTS  一个 workflow 预计扇出多少个子代理的上限，默认 24
 *   DSH_LOOP_GUARD_MAX_SUBAGENT_REQUESTS 子代理模型请求数上限，默认 150
 *   DSH_LOOP_GUARD_MAX_SUBAGENT_TOOLS   子代理工具调用数上限，默认 250
 *   DSH_LOOP_GUARD_OUTLIER_RATIO        超过兄弟「每次请求均值」几倍算异常，默认 5
 *   DSH_LOOP_GUARD_OUTLIER_MIN_SIBLINGS 至少几个兄弟才做横向比较，默认 3
 *   DSH_LOOP_GUARD_OUTLIER_FLOOR_TOKENS 低于这个花费不判异常，默认 5000000
 *   DSH_LOOP_GUARD_EMPTY_RESULT_TOKENS  烧超过多少算「烧了钱」，默认 20000000
 *   DSH_LOOP_GUARD_EMPTY_RESULT_OUTPUT  输出低于多少算「吐得少」，默认 500
 *   DSH_LOOP_GUARD_MAX_BATCH_FAILURES   同批失败几次后不再开新子代理，默认 3
 *   DSH_LOOP_GUARD_VETO_NEW_TURN=0      会话预算到线后不再拒绝新的一轮问答（默认拒绝）
 *   DSH_LOOP_GUARD_PERSIST=0            不把计数写进磁盘，也不写诊断日志（默认都写）
 *   DSH_LOOP_GUARD_LOG_FILE             诊断日志路径，默认 ~/.dsh/loop-guard.log
 *   DSH_LOOP_GUARD_SOFT_LANDING=1       到线后只拦探索工具，放过收尾工具
 *   DSH_LOOP_GUARD_OFF=1                关掉守卫
 *
 * 上面每一项也都能在 DSH 的设置面板里改（见文件末尾的 Config）；
 * 环境变量优先级最高，方便临时调。
 *
 * @module dsh-loop-guard
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

export const name = 'loop-guard';

/** 不需要注入任何服务：只用 ctx.on / ctx.logger。 */
export const inject = [];

const DEFAULT_MAX_TOKENS = 100_000_000;
const DEFAULT_SESSION_MAX_TOKENS = 1_000_000_000;


/** 会话/签名类 Map 的容量上限，防止长会话把内存吃掉。 */
const SIGNATURE_CAP = 400;
const ERROR_CAP = 40;
/** callId → 工具名 映射的容量上限。 */
const CALLNAME_CAP = 400;
/** 退休会话 id 的容量上限（用来防止重复上卷）。 */
const RETIRED_CAP = 2000;
const STATE_VERSION = 1;
const STATE_SAVE_INTERVAL_MS = 10_000;

/**
 * 守卫自己的诊断日志（默认 ~/.dsh/loop-guard.log）。
 *
 * 为什么必须落盘：所有 warn 都只走 ctx.logger，而 ~/.dsh 下没有任何 loop-guard
 * 的日志文件 —— 逃生门放行、预算门首次到线、盲区自检这些「守卫正在放行」的信号
 * 用户根本看不见，守卫失守时没有任何痕迹。
 *
 * 口径（极简、无第三方依赖）：
 *   · 追加写，每行 `[ISO 时间] [level] 文本`；
 *   · 路径由 DSH_LOOP_GUARD_LOG_FILE 覆盖，DSH_LOOP_GUARD_LOG=0 整体关掉；
 *   · 按事件文本节流 10 秒（同一句话 10 秒内只写第一条）；
 *   · 单文件上限 2MB，超了整体轮转成 loop-guard.log.1（只留一份，旧的一份被覆盖）；
 *   · **任何失败都静默降级为 log()**，绝不让日志写失败影响闸门（见 fileLog）。
 */
const LOG_DEFAULT_FILE = path.join(os.homedir(), '.dsh', 'loop-guard.log');
const LOG_MAX_BYTES = 2 * 1024 * 1024;
const LOG_THROTTLE_MS = 10_000;
/** 逃生计数表的容量上限（key 是签名散列，见 escapeKeyFor）。 */
const ESCAPE_CAP = 400;

/** 这些工具重复调用是正常的，永不拦。 */
const NEVER_BLOCK = new Set([
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
]);

/** 出生就要查并发的工具：子代理是乘数。 */
const SPAWN_TOOLS = new Set(['subagent', 'subagent_fork', 'workflow']);

/** 软着陆时放过这些「收尾工具」——已经烧掉的钱至少换回一个完整结果。 */
const SOFT_ALLOW = new Set([
	'read',
	'write',
	'edit',
	'glob',
	'grep',
	'todo_write',
	'todo_read',
	'ask_user_question',
	'job_list',
	'job_output',
	'job_kill',
	'update_goal',
	'get_goal'
]);

// ────────────────────────────── 配置 ──────────────────────────────

/**
 * 设置面板用的 schema。
 *
 * 用 createRequire 同步取 schemastery：插件装在 profile 里时
 * `node_modules/@deepseek-ai/schemastery` 就在上层的 node_modules 里，能解析到；
 * 从源码目录（`.dsh/local-plugins/`）直接跑冒烟测试时解析不到，
 * 这时整块退化成 `Config = undefined` —— 插件照常工作，只是没有图形设置界面。
 * 绝不能让「没装 schemastery」把守卫整个弄哑。
 */
let Config;
try {
	const require_ = createRequire(import.meta.url);
	const z = require_('@deepseek-ai/schemastery');
	Config = z.object({
		maxTokens: z.number().default(DEFAULT_MAX_TOKENS).description('单次问答（一个 turn）累计计费输入上限，含这一轮生出来的子代理；计费输入 = 未命中输入 + 缓存读 + 缓存写'),
		sessionMaxTokens: z.number().default(DEFAULT_SESSION_MAX_TOKENS).description('整个会话跨轮累计上限，只算本会话自己（不含子代理）。到线后本轮仍可收尾交账，但拒绝再开新一轮'),
		familyMaxTokens: z.number().default(0).description('家族（自己 + 所有后代）累计上限；0 = 不设限。想把会话上限也算上后代就设成和 sessionMaxTokens 一样的值'),
		warnRatio: z.number().default(0.7).description('到线前多少比例时在日志里预警一次'),
		repeatLimit: z.number().default(4).description('同一个调用（同工具同参数）允许执行几次，超过就拦'),
		readRepeatLimit: z.number().default(5).description('read 工具的重复阈值（读文件重读更常见，给宽一点）'),
		skeletonLimit: z.number().default(10).description('同骨架（抹掉数字与字符串后同形）允许几次'),
		cycleLimit: z.number().default(3).description('乒乓循环：同一对调用重复几轮算循环，默认 3 轮'),
		sameErrorLimit: z.number().default(2).description('同一个错误重复出现几次算原地打转'),
		maxDenials: z.number().default(3).description('同一处最多拦几次后强制放行（绝不把 agent 锁死）'),
		maxFanout: z.number().default(8).description('同时活着的子代理数上限'),
		fanoutTtlMs: z.number().default(1_200_000).description('子代理多久没动静就不再算它活着（毫秒）'),
		maxWorkflowAgents: z.number().default(24).description('一个 workflow 预计扇出的子代理数上限'),
		maxSubagentRequests: z.number().default(150).description('单个子代理模型请求数上限'),
		maxSubagentTools: z.number().default(250).description('单个子代理工具调用数上限'),
		outlierRatio: z.number().default(5).description('超过兄弟「每次请求均值」几倍算异常'),
		outlierMinSiblings: z.number().default(3).description('至少几个兄弟才做横向比较'),
		outlierFloorTokens: z.number().default(5_000_000).description('低于这个花费不判异常'),
		emptyResultTokens: z.number().default(20_000_000).description('烧超过多少算「烧了钱」'),
		emptyResultOutput: z.number().default(500).description('输出低于多少算「吐得少」'),
		maxBatchFailures: z.number().default(3).description('同批几个子代理烧多吐少之后，不再允许开新的'),
		vetoNewTurn: z.number().default(0).description('会话预算到线后，拒绝开新的一轮问答（1 = 开，0 = 关；默认关，见 README 的说明）'),
		softLanding: z.number().default(0).description('到线后只拦探索工具、放过收尾工具（1 = 开）'),
		persist: z.number().default(1).description('把计数写进磁盘，重启后接着算（1 = 开，0 = 关）'),
		log: z.number().default(1).description('把守卫的诊断日志（逃生门放行 / 预算门到线 / 盲区自检 / FIFO 淘汰）写进日志文件（1 = 开，0 = 关）'),
		logFile: z.string().default('').description('诊断日志路径；留空 = ~/.dsh/loop-guard.log'),
		off: z.number().default(0).description('总开关：1 = 整个插件不装任何钩子；等价于 DSH_LOOP_GUARD_OFF=1（改完要重载插件才生效）')
	});
} catch {
	Config = undefined;
}
export { Config };

/** 环境变量优先（方便临时改），其次设置面板，最后内置默认。 */
function pickNumber(envKey, configValue, fallback) {
	const raw = process.env[envKey];
	if (typeof raw === 'string' && raw.trim() !== '') {
		const fromEnv = Number(raw);
		if (Number.isFinite(fromEnv)) return fromEnv;
	}
	if (typeof configValue === 'number' && Number.isFinite(configValue)) return configValue;
	return fallback;
}

/** 可选上限：没设 / 0 / 负数 / 非法 → Infinity（= 这项限制关掉）。 */
function pickLimit(envKey, configValue, fallback) {
	const value = pickNumber(envKey, configValue, fallback);
	return Number.isFinite(value) && value > 0 ? value : Number.POSITIVE_INFINITY;
}

/** 可选字符串：环境变量优先，其次设置面板，最后内置默认。 */
function pickString(envKey, configValue, fallback) {
	const raw = process.env[envKey];
	if (typeof raw === 'string' && raw.trim() !== '') return raw.trim();
	if (typeof configValue === 'string' && configValue.trim() !== '') return configValue.trim();
	return fallback;
}

/**
 * 计数类阈值：<= 0 一律当成「关掉这道门」（Infinity = 永远不触发）。
 *
 * 为什么必须钳：所有判据都是 `已发生次数 >= 阈值`，阈值 = 0 时 `seen >= 0`
 * 恒真 —— 每走一步都被拦（`DSH_LOOP_GUARD_CYCLE_LIMIT=0` 会让整个会话报废）。
 * 「0 = 关闭」也正是 sessionMaxTokens / familyMaxTokens 早就有的语义，
 * 这里只是把同一套语义补齐到计数类阈值上。
 */
function pickThreshold(envKey, configValue, fallback) {
	const value = pickNumber(envKey, configValue, fallback);
	return Number.isFinite(value) && value > 0 ? value : Number.POSITIVE_INFINITY;
}

function readConfig(config) {
	const c = config ?? {};
	return {
		/** 本轮（含该轮子代理）上限。默认 1 亿；设 0 或负数 = 不设限，与下面两个上限同义。 */
		maxTokens: pickLimit('DSH_LOOP_GUARD_MAX_TOKENS', c.maxTokens, DEFAULT_MAX_TOKENS),
		/** 会话跨轮累计上限。默认 10 亿；设 0 或负数 = 不设限。 */
		sessionMaxTokens: pickLimit('DSH_LOOP_GUARD_SESSION_MAX_TOKENS', c.sessionMaxTokens, DEFAULT_SESSION_MAX_TOKENS),
		/** 家族（自己 + 所有后代）累计上限。默认 Infinity = 不设限。 */
		familyMaxTokens: pickLimit('DSH_LOOP_GUARD_FAMILY_MAX_TOKENS', c.familyMaxTokens),
		warnRatio: pickNumber('DSH_LOOP_GUARD_WARN_RATIO', c.warnRatio, 0.7),
		repeatLimit: pickThreshold('DSH_LOOP_GUARD_REPEAT_LIMIT', c.repeatLimit, 4),
		readRepeatLimit: pickThreshold('DSH_LOOP_GUARD_READ_REPEAT_LIMIT', c.readRepeatLimit, 5),
		skeletonLimit: pickThreshold('DSH_LOOP_GUARD_SKELETON_LIMIT', c.skeletonLimit, 10),
		cycleLimit: pickThreshold('DSH_LOOP_GUARD_CYCLE_LIMIT', c.cycleLimit, 3),
		sameErrorLimit: pickThreshold('DSH_LOOP_GUARD_SAME_ERROR_LIMIT', c.sameErrorLimit, 2),
		/**
		 * maxDenials 是**逃生门**的门槛，不是闸门：0（或负数）会让门永远打不开，
		 * 也就是把整个会话永久锁死。所以这里钳到最小 1 ——
		 * 语义仍然是「关掉『按次数循环拦』」，但最保守也一定放行一次。
		 */
		maxDenials: Math.max(1, pickNumber('DSH_LOOP_GUARD_MAX_DENIALS', c.maxDenials, 3)),
		maxFanout: pickThreshold('DSH_LOOP_GUARD_MAX_FANOUT', c.maxFanout, 8),
		fanoutTtlMs: pickNumber('DSH_LOOP_GUARD_FANOUT_TTL_MS', c.fanoutTtlMs, 20 * 60 * 1000),
		maxWorkflowAgents: pickThreshold('DSH_LOOP_GUARD_MAX_WORKFLOW_AGENTS', c.maxWorkflowAgents, 24),
		maxSubagentRequests: pickThreshold('DSH_LOOP_GUARD_MAX_SUBAGENT_REQUESTS', c.maxSubagentRequests, 150),
		maxSubagentTools: pickThreshold('DSH_LOOP_GUARD_MAX_SUBAGENT_TOOLS', c.maxSubagentTools, 250),
		outlierRatio: pickNumber('DSH_LOOP_GUARD_OUTLIER_RATIO', c.outlierRatio, 5),
		outlierMinSiblings: pickThreshold('DSH_LOOP_GUARD_OUTLIER_MIN_SIBLINGS', c.outlierMinSiblings, 3),
		outlierFloorTokens: pickNumber('DSH_LOOP_GUARD_OUTLIER_FLOOR_TOKENS', c.outlierFloorTokens, 5_000_000),
		emptyResultTokens: pickNumber('DSH_LOOP_GUARD_EMPTY_RESULT_TOKENS', c.emptyResultTokens, 20_000_000),
		emptyResultOutput: pickNumber('DSH_LOOP_GUARD_EMPTY_RESULT_OUTPUT', c.emptyResultOutput, 500),
		maxBatchFailures: pickThreshold('DSH_LOOP_GUARD_MAX_BATCH_FAILURES', c.maxBatchFailures, 3),
		vetoNewTurn: pickNumber('DSH_LOOP_GUARD_VETO_NEW_TURN', c.vetoNewTurn, 0) !== 0,
		softLanding: pickNumber('DSH_LOOP_GUARD_SOFT_LANDING', c.softLanding, 0) !== 0,
		persist: process.env.DSH_LOOP_GUARD_NO_PERSIST !== '1' && pickNumber('DSH_LOOP_GUARD_PERSIST', c.persist, 1) !== 0,
		/** 诊断日志：路径可由 DSH_LOOP_GUARD_LOG_FILE 覆盖，DSH_LOOP_GUARD_LOG=0 整体关掉。 */
		logFile: pickString('DSH_LOOP_GUARD_LOG_FILE', c.logFile, LOG_DEFAULT_FILE),
		log: process.env.DSH_LOOP_GUARD_LOG !== '0' && pickNumber('DSH_LOOP_GUARD_LOG', c.log, 1) !== 0,
		off: process.env.DSH_LOOP_GUARD_OFF === '1' || pickNumber('DSH_LOOP_GUARD_OFF', c.off, 0) !== 0

	};
}

// ────────────────────────────── 工具函数 ──────────────────────────────

/**
 * 最近一次 apply 的 ctx。只给「模块级函数」用：charge → scheduleSave → writeState
 * 这条链上没有 ctx 参数，但它们出错时同样必须能喊到宿主日志里。
 */
let activeCtx = null;

function log(ctx, level, message) {
	try {
		const logger = ctx?.logger;
		const sink = typeof logger?.[level] === 'function' ? logger[level].bind(logger) : console[level]?.bind(console) ?? console.log;
		sink(`[loop-guard] ${message}`);
	} catch {
		/* 日志永远不能影响主流程 */
	}
	// warn / error 同时落一份盘：宿主日志用户看不见（~/.dsh 下从来没有 loop-guard
	// 的日志文件），而「逃生门放行 / 预算门到线 / 盲区自检」这些信号必须留痕。
	if (level === 'warn' || level === 'error') fileLog(level, message);
}

/** 日志文件写坏过一次就彻底闭嘴（只降级、不重试），避免每次判定都去撞磁盘。 */
let fileLogBroken = false;
/** 日志是否开启 / 写到哪儿 —— 由 readConfig + apply 设定（不在模块加载时读环境变量）。 */
let logEnabled = true;
let logPath = LOG_DEFAULT_FILE;
/** 同一句话 10 秒内只写一次：事件文本前 64 字当节流键。 */
const logThrottle = new Map();

/** 单文件超过 2MB 就整体轮转成 .1（只留一份，旧的被覆盖）。 */
function rotateLogIfNeeded() {
	try {
		const stat = fs.statSync(logPath);
		if (stat.size < LOG_MAX_BYTES) return;
		fs.renameSync(logPath, `${logPath}.1`);
	} catch {
		/* 文件不存在 = 没什么可轮转的 */
	}
}

/**
 * 追加写诊断日志。**任何失败都静默降级**（先置 fileLogBroken 再喊一声，
 * 否则 log() → fileLog() 会递归）。
 */
function fileLog(level, message) {
	if (fileLogBroken || !logEnabled) return;
	try {
		const text = String(message);
		const key = text.slice(0, 64);
		const now = Date.now();
		const last = logThrottle.get(key);
		if (last !== undefined && now - last < LOG_THROTTLE_MS) return;
		if (logThrottle.size > 200) logThrottle.clear();
		logThrottle.set(key, now);
		const dir = path.dirname(logPath);
		if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
		rotateLogIfNeeded();
		fs.appendFileSync(logPath, `[${new Date().toISOString()}] [${level}] ${text}\n`, 'utf8');
	} catch (error) {
		fileLogBroken = true;
		log(activeCtx, 'warn', `诊断日志写不进去（${error instanceof Error ? error.message : String(error)}），降级为只走宿主日志`);
	}
}

/** 人类可读的 token 数量。 */
function human(n) {
	if (!Number.isFinite(n)) return '不设限';
	if (n <= 0) return '0';
	if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(2)} 亿`;
	if (n >= 10_000) return `${(n / 10_000).toFixed(1)} 万`;
	return String(Math.round(n));
}

function collapse(text) {
	return String(text === undefined || text === null ? '' : text).replace(/\s+/g, ' ').trim();
}

/**
 * 表满时按插入顺序淘汰**最旧的一条** —— 绝不整体 clear()。
 *
 * 为什么不能用 clear()：这些表旁边全都挂着「拦 N 次后放行一次」的命门。
 * 一次 clear() 会把整张表连同里面的逃生计数一次性抹平，于是同一个错误 /
 * 同一个签名可以无限重复（拦满 → 清表 → 又能重来一遍）。淘汰最旧的一条
 * 只影响那一条；而会话级的逃生计数住在 ledger.escape 里，FIFO 根本碰不到它。
 *
 * 只写日志文件，不吵 ctx.logger：表一满之后每次调用都会淘汰一条。
 */
function evictOldest(map, label) {
	const oldest = map.keys().next();
	if (oldest.done === true) return;
	map.delete(oldest.value);
	fileLog('info', `${label} 已满，按插入顺序淘汰最旧的一条（不整体清空；会话级逃生计数不受影响）`);
}

/** 32 位字符串散列（FNV-1a 变体）：只用来把逃生计数的 key 压短，没有任何安全用途。 */
function shortHash(text) {
	let hash = 0x811c9dc5;
	const value = String(text);
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(36);
}

/**
 * 按签名取一个稳定的逃生计数 key。
 *
 * 为什么不再把「拦了几次」塞进签名记录里：那张表满了要 FIFO 淘汰，
 * 淘汰会把记录连同它的计数一起丢掉 —— 逃生计数一旦被淘汰重置，
 * 「照原样再发一次会被放行」这个契约就不成立了。放到会话级的 escape 表里，
 * 淘汰签名记录不会碰到它。
 */
function escapeKeyFor(ledger, prefix, signature) {
	const key = `${prefix}${shortHash(signature)}`;
	const keys = Object.keys(ledger.escape);
	if (keys.length > ESCAPE_CAP) {
		for (const old of keys) {
			if (old.startsWith(prefix)) {
				delete ledger.escape[old];
				fileLog('info', `逃生计数表已满（${ESCAPE_CAP}），淘汰最旧的一条 ${old} —— 该签名重新计数（只会更严，不会锁死）`);
				break;
			}
		}
	}
	return key;
}

/** 把命令里的易变片段抹平，好让「同一件事」算出同一个签名。 */
function normalizeCommand(command) {
	return collapse(command)
		.replace(/[0-9a-f]{16,}/gi, '<hash>')
		.replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g, '<time>')
		.replace(/\b\d{10,13}\b/g, '<epoch>')
		.replace(/\b(?:pid|id)\b\s*[:=#]?\s*\d+\b/gi, '<pid>')
		.replace(/\$\$|\$PID\b|\$env:PID\b/g, '<pid>')
		.replace(/[A-Za-z]:\\[^"'\s|;]*\.mtemp\\[^"'\s\\|;]+/gi, '<tmp>')
		.replace(/\/tmp\/[^\s"']+/g, '<tmp>')
		// 易变文件名只折叠「整个文件名就是易变标记」的形状：纯数字名（11111111.log）
		// 与时间戳名。为什么收窄：原来把 [\w.$-]{4,}\.(log|tmp|out|err|bak|dat) 一律
		// 折成 <tmpfile>，于是 `Get-Content build1.log` … `Get-Content build5.log`
		// 五条**不同**命令撞成同一签名，被当成「同一件事重跑了 5 次」——读五个不同的
		// 日志文件是正常干活，那是误判。而「同一份日志反复取」根本不需要折叠：
		// 名字一模一样的时候签名本来就相同。
		.replace(/\b\d{4,}\.(?:tmp|log|out|err|bak|dat)\b/gi, '<tmpfile>')
		.replace(/\b\d{4}-\d{2}-\d{2}[T_ -]?\d{0,6}\.(?:tmp|log|out|err|bak|dat)\b/gi, '<tmpfile>');
}

/**
 * 二级指纹：把字符串字面量和数字全抹掉之后的「骨架」。
 *
 * 同一条命令换个引号、换个路径、换个数字，签名就变了，一级指纹抓不住；
 * 但骨架一样，说明它其实在做同一件事。这是「换个写法接着绕」的兜底。
 */
function skeletonOf(signature) {
	return collapse(String(signature)).replace(/'[^']*'|"[^"]*"/g, '<s>').replace(/\d+/g, '#').slice(0, 200);
}

function isShell(toolName) {
	return toolName === 'pwsh' || toolName === 'bash' || toolName === 'shell' || toolName === 'ssh_exec' || toolName === 'ssh_cluster';
}

/**
 * 骨架指纹只对「换了数字/引号还是同一件事」的工具有意义 —— 也就是命令行。
 *
 * 结构化工具（edit / write / subagent / workflow / …）的签名是带引号的 JSON，
 * 而通用骨架会把每个值都抹成 `<s>`，于是「改 11 个不同的文件」和「改同一个文件 11 次」
 * 会撞成同一个骨架 —— 那是误伤，不是防重复。对它们，骨架就等于精确签名，
 * 真重复交给同签名那条兜底。
 */
function skeletonFor(toolName, signature) {
	if (isShell(toolName)) return skeletonOf(signature);
	if (toolName === 'read') {
		// 换着 offset/limit 反复读同一个文件才是循环；而路径必须原样保留，
		// 否则 chapter1.txt … chapter11.txt 会被折成同一个骨架。
		const [head, path, window] = String(signature).split('::');
		return collapse(`${head}::${path}::${String(window ?? '').replace(/\d+/g, '#')}`).slice(0, 200);
	}
	return String(signature).slice(0, 200);
}

/** 一个调用「做了什么」的指纹。 */
function signatureOf(toolName, args) {
	if (args === null || typeof args !== 'object') return `${toolName}::`;
	if (isShell(toolName)) {
		return `${toolName}::${normalizeCommand(args.command ?? args.cmd ?? '').slice(0, 400)}`;
	}
	if (toolName === 'read') {
		return `read::${collapse(args.file_path ?? args.path)}::${args.offset ?? ''}:${args.limit ?? ''}`;
	}
	if (toolName === 'grep') {
		return `grep::${collapse(args.pattern)}::${collapse(args.path)}::${collapse(args.include)}`;
	}
	if (toolName === 'glob') {
		return `glob::${collapse(args.pattern)}::${collapse(args.path)}`;
	}
	try {
		return `${toolName}::${collapse(JSON.stringify(args)).slice(0, 300)}`;
	} catch {
		return `${toolName}::<unserializable>`;
	}
}

/**
 * 把字符串字面量和注释抠掉，免得把字符串里的 "agent(" 当成真调用。
 *
 * 顺序：**先剥字符串，再剥注释**。为什么不能反过来：
 *   log("https://x"); await agent("do it");
 * 里注释剥离会把 `//x"); await agent("do it");` 整段当成行注释吃掉 ——
 * 字符串里一出现 URL，这一行后面真正的 agent() 就数不到了（扇出被低估 = 闸门失灵）。
 * 单引号前面加 `(^|[^\w$])` 是为了不把 `don't` 这种英文缩写里的撇号当成字符串开头
 * （否则它会吃到后面下一个撇号之间的全部真代码）。正则字面量（/a\/b/）的处理与改前
 * 一致：本函数不做词法分析，只有出现连续 `//` 才当注释。
 */
function stripCodeLiterals(script) {
	return String(script)
		.replace(/(^|[^\w$])'(?:\\.|[^'\\])*'/g, "$1''")
		.replace(/"(?:\\.|[^"\\])*"/g, '""')
		.replace(/`(?:\\.|[^`\\])*`/g, '``')
		.replace(/\/\*[\s\S]*?\*\//g, ' ')
		.replace(/\/\/[^\n]*/g, ' ');
}

/**
 * 粗估一个 workflow 脚本会扇出多少个子代理。
 *
 * 不是精确解析，目标是「宁可高估，不可漏放」：
 *   · 先抠掉注释和字符串字面量，别把字符串里的 agent( 当真；
 *   · pipeline/parallel 会对每个条目把每个 stage 跑一遍，所以如果脚本里读到
 *     `args.<键>`（或 `args["<键>"]`），而这次 tool 调用的 args 里那个键是数组，
 *     就拿它的长度当乘数。以前只看 `agent(` 出现次数，一个 `pipeline(files, ...)`
 *     就能把 50 个子代理估成 1 个，等于没防。
 */
function estimateAgents(script, payload) {
	if (typeof script !== 'string') return { estimated: 0, calls: 0, multiplier: 1 };
	const bare = stripCodeLiterals(script);
	const calls = (bare.match(/\bagent\s*\(/g) ?? []).length;
	if (calls === 0) return { estimated: 0, calls: 0, multiplier: 1 };
	let multiplier = 1;
	// 乘数来源：脚本里存在「按条目逐个跑」的形状 —— pipeline/parallel，或者
	// `for (const f of args.files)` 这种显式迭代。以前只认 pipeline|parallel，
	// 于是 `for (const f of args.files) agent(...)` 的 50 路扇出被估成 1 个，
	// 等于没有这道闸门。数组长度从这次工具调用的 args 里取（args.<键> / args["<键>"]）。
	const iterated =
		/\b(?:pipeline|parallel)\s*\(/.test(bare) ||
		/\bfor\s*\(\s*(?:const|let|var)\s+[\w$]+\s+of\s+/.test(bare) ||
		/\bfor\s*\(\s*(?:const|let|var)\s*\[/.test(bare);
	if (iterated) {
		for (const match of bare.matchAll(/\bargs(?:\.([A-Za-z_$][\w$]*)|\[\s*['"]([^'"]+)['"]\s*\])/g)) {
			const value = payload?.[match[1] ?? match[2]];
			if (Array.isArray(value)) multiplier = Math.max(multiplier, value.length);
		}
		if (Array.isArray(payload)) multiplier = Math.max(multiplier, payload.length);
	}
	const capped = Math.min(multiplier, 1000);
	return { estimated: calls * capped, calls, multiplier: capped };
}

/** 从工具结果的 content 里抠出纯文本（字符串 / 内容块数组 / {text} 都认）。 */
function messageTextOf(content) {
	if (typeof content === 'string') return content;
	if (Array.isArray(content)) {
		const parts = [];
		for (const block of content) {
			if (typeof block === 'string') parts.push(block);
			else if (block !== null && typeof block === 'object' && typeof block.text === 'string') parts.push(block.text);
		}
		return parts.join(' ');
	}
	if (content !== null && typeof content === 'object' && typeof content.text === 'string') return content.text;
	return '';
}

/** 把错误文本归一成指纹：路径、hex、数字、空白全部抹平。太短的不算。 */
function errorKeyOf(text) {
	const flat = collapse(text)
		.replace(/[A-Za-z]:\\[^\s"']+/g, '<path>')
		.replace(/\/[^\s"']{6,}/g, '<path>')
		.replace(/[0-9a-f]{8,}/gi, '<hex>')
		.replace(/\d+/g, '#');
	if (flat.length < 8) return '';
	return flat.slice(0, 180);
}

// ────────────────────────── 会话谱系（父子、兄弟） ──────────────────────────

/** 子会话 id → 父会话 id。只在 origin === 'subagent' 时登记，避免和 fork 混淆。 */
const parents = new Map();
/** 父会话 id → 活着的子会话 id 集合。 */
const childrenOf = new Map();
/** 已经清账退休的会话 id：防止同一 id 复活时把历史重放第二遍。 */
const retired = new Set();

function isSubagentSession(session) {
	// 只看 origin。单凭 parentSession 有歧义：会话分叉（fork）也会带 parentSession。
	return session?.header?.origin === 'subagent';
}

function sessionIdOfSession(session) {
	const id = session?.id;
	return id === undefined || id === null ? undefined : String(id);
}

function linkTo(parentId, childId) {
	if (typeof parentId !== 'string' || parentId === '' || parentId === childId) return;
	if (parents.get(childId) === parentId) return;
	parents.set(childId, parentId);
	let set = childrenOf.get(parentId);
	if (set === undefined) {
		set = new Set();
		childrenOf.set(parentId, set);
	}
	set.add(childId);
}

/** 从会话对象里学父子关系；usage 事件和 session/created 都会调它。 */
function learnSession(session) {
	try {
		if (!isSubagentSession(session)) return;
		const id = sessionIdOfSession(session);
		if (id === undefined) return;
		const parent = session.header?.parentSession;
		if (parent === undefined || parent === null) return;
		linkTo(String(parent), id);
		ledgerOf(id).isSubagent = true;
	} catch {
		/* 学不到就退化成「没有子代理关系」，不能因此拦住会话 */
	}
}

function rootOf(sessionId) {
	let id = sessionId;
	let hops = 0;
	const seen = new Set([sessionId]);
	while (hops < 16) {
		const parent = parents.get(id);
		if (parent === undefined || seen.has(parent)) return id;
		seen.add(parent);
		id = parent;
		hops += 1;
	}
	return id;
}

/** 活着的后代数量（含孙辈）。太久没动静的不算。 */
function liveDescendants(rootId, cfg) {
	const now = Date.now();
	const seen = new Set();
	let frontier = [rootId];
	let total = 0;
	let depth = 0;
	while (frontier.length > 0 && depth < 8) {
		const next = [];
		for (const id of frontier) {
			const kids = childrenOf.get(id);
			if (kids === undefined) continue;
			for (const kid of kids) {
				if (seen.has(kid)) continue;
				seen.add(kid);
				const ledger = ledgers.get(kid);
				if (ledger !== undefined && now - (ledger.lastSeen ?? 0) > cfg.fanoutTtlMs) continue;
				total += 1;
				next.push(kid);
			}
		}
		frontier = next;
		depth += 1;
	}
	return total;
}

// ────────────────────────────── 账本 ──────────────────────────────

const ledgers = new Map();

function ledgerOf(sessionId) {
	let ledger = ledgers.get(sessionId);
	if (ledger === undefined) {
		ledger = {
			/** 当前 turn 的累计计费输入 —— 这就是「一次问答」的消耗。 */
			turnInput: 0,
			/** 自己这个会话的累计，也是会话/子代理上限的依据。 */
			totalInput: 0,
			/** 所有后代累计上卷到这里的量。自己 + familyInput = 家族总量。 */
			familyInput: 0,
			/**
			 * 后代在**本轮**上卷过来的量。「一次问答」的预算是自己这一轮 + 这一轮生出来的
			 * 所有子代理，否则一次对话可以自己烧满上限、再让每个子代理各烧满一次。
			 * 跟着自己的 turn 一起清零（见 charge）。
			 */
			familyTurnInput: 0,
			output: 0,
			/** 收到过 usage 样本的模型请求数。 */
			requests: 0,
			/** 模型请求数，不依赖 usage 事件，字段改名也数得到。 */
			modelCalls: 0,
			toolCalls: 0,
			/** 最近一次 usage 样本所属的 turn，用来判断换没换问答。 */
			turn: undefined,
			/** 最近一次有动静的时间，用来判断子代理还算不算活着。 */
			lastSeen: Date.now(),
			signatures: new Map(),
			/** 二级指纹：抹掉数字与字符串后的骨架 → 计数。 */
			skeletons: new Map(),
			/** 最近的签名序列（只留尾巴），用来抓 A-B-A-B 乒乓循环。 */
			recent: [],
			/** 归一化后的错误文本 → 出现次数。 */
			errors: new Map(),
			lastError: '',
			lastErrorCount: 0,
			/** 真正报错的工具名（不是「这一次调的是谁」）。 */
			lastErrorTool: '',
			/** callId → 工具名，用来在 tool/result 里认出是谁失败了。 */
			callNames: new Map(),
			sameErrorTripped: false,
			/**
			 * 各种「拦 N 次后放行」的逃生计数。
			 *
			 * **会话级，不在换轮时清空** —— 见 charge() 里的注释，这是一次真实事故。
			 * key 大多是固定名（sameError/skeleton/requests/…）或「门名 + 到线轮次」
			 * （session-budget#<轮次> / turn-budget#<轮次> / family-budget#<轮次>）；
			 * **只有** repeat#<签名散列> 这一个键走 escapeKeyFor，所以也只有它
			 * 受 escapeKeyFor 里 ESCAPE_CAP 的 FIFO 约束。
			 */
			escape: {},
			/**
			 * 「上一次被逃生门放行」的那个签名 + 它有没有被消费掉。
			 *
			 * 契约 C6：某个门放行的那一次调用，**紧接着的同签名调用必须整体豁免一次**
			 * （同骨架门与同签名门一起让路）。理由：拒绝文案里对模型承诺过
			 * 「说明理由后照原样再发一次会被放行」——如果紧接着的同骨架门把它拦回去，
			 * 这句承诺就是空话，模型只会学到「说了也没用」。
			 * 标记必须**跨调用**传递而不是「本次判定内」：⑩ 同骨架门排在 ⑪ 同签名门
			 * 前面，同一次调用里排在后面的门还没说话，前面那道门根本看不到。
			 */
			escapeSig: undefined,
			escapeSigUsed: false,
			/**
			 * 配额类闸门的一次性豁免记录（key 如 'requests' / 'fanout' / 'breaker'）。
			 * 与 escape 分开：它**不**受 maxDenials 影响，每个门最多豁免一次。
			 */
			quotaExempted: {},
			isSubagent: false,
			childFailures: 0,
			tripped: false,
			trippedSession: false,
			/** 会话预算第一次是在哪一轮到线的：那一轮要放它走完，也好当逃生门的 key。 */
			trippedSessionTurn: undefined,
			/** 家族预算第一次是在哪一轮到线的（同上）。 */
			trippedFamilyAt: undefined,
			trippedFamily: false,
			warned: false,
			warnedSession: false,
			blindWarned: false,
			/** 收到过多少个 usage 样本 / 其中多少个带 turn 字段（用来发现「字段没了」的盲区）。 */
			usageSamples: 0,
			turnSamples: 0,
			/** 「usage 样本没有 turn 字段」只吼一次。 */
			turnWarned: false
		};
		ledgers.set(sessionId, ledger);
	}
	return ledger;
}

// ────────────────────────── 计数持久化（重启接着算） ──────────────────────────

/**
 * 插件和 DSH 宿主同生共死，一重启账本就清零 —— 而「一次问答」很容易跨一次重启。
 * 所以把累计计数落一份盘。只存数字，不存任何对话内容。
 */
const STATE_FILE = process.env.DSH_LOOP_GUARD_STATE_FILE ?? path.join(os.homedir(), '.dsh', 'loop-guard-state.json');
let cfgPersist = true;
let lastSaveAt = 0;

function loadState(ctx) {
	try {
		const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
		if (parsed === null || typeof parsed !== 'object') return;
		const sessions = parsed.sessions ?? {};
		// 版本不匹配**不再整份丢弃**：下面这几个字段的含义从 v1 起就没变过，
		// 尽力迁移比「清零重来」安全得多（把历史计数丢了 = 预算门形同虚设，
		// 而且以前是静默丢弃，谁也不知道发生过）。
		if (parsed.version !== STATE_VERSION) {
			log(ctx, 'warn', `计数存档版本 ${String(parsed.version)} 与当前 v${STATE_VERSION} 不一致，按已知字段尽力迁移（totalInput / familyInput / turn 等），不再整份丢弃`);
		}
		let restored = 0;
		for (const id of Object.keys(sessions)) {
			const snap = sessions[id];
			if (snap === null || typeof snap !== 'object') continue;
			const ledger = ledgerOf(id);
			ledger.totalInput = numberOr0(snap.totalInput);
			ledger.familyInput = numberOr0(snap.familyInput);
			ledger.output = numberOr0(snap.output);
			ledger.requests = numberOr0(snap.requests);
			ledger.modelCalls = numberOr0(snap.modelCalls);
			ledger.toolCalls = numberOr0(snap.toolCalls);
			ledger.turn = typeof snap.turn === 'number' ? snap.turn : undefined;
			restored += 1;
		}
		if (restored > 0) pendingLoadNote = `${restored} 个会话的历史计数`;
	} catch {
		/* 没有存档、存档坏了、路径不可写 —— 一律当第一次跑 */
	}
}

let pendingLoadNote = '';

function writeState() {
	if (!cfgPersist) return;
	try {
		const dir = path.dirname(STATE_FILE);
		if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
		const sessions = {};
		const top = [...ledgers.entries()].sort((a, b) => b[1].totalInput - a[1].totalInput).slice(0, 200);
		for (const [id, ledger] of top) {
			sessions[id] = {
				totalInput: Math.round(ledger.totalInput),
				familyInput: Math.round(ledger.familyInput),
				output: Math.round(ledger.output),
				requests: ledger.requests,
				modelCalls: ledger.modelCalls,
				toolCalls: ledger.toolCalls,
				turn: ledger.turn
			};
		}
		const payload = JSON.stringify({ version: STATE_VERSION, savedAt: new Date().toISOString(), sessions });
		const tmp = `${STATE_FILE}.tmp`;
		fs.writeFileSync(tmp, payload, 'utf8');
		fs.renameSync(tmp, STATE_FILE);
	} catch (error) {
		// 写不进去也绝不影响会话，但必须留痕（以前是静默吞掉）：
		// 存档失败意味着重启后计数归零、预算门重新起算，用户有权知道。
		log(activeCtx, 'warn', `计数存档写盘失败（${error instanceof Error ? error.message : String(error)}）：${STATE_FILE} —— 重启后这些计数会丢，守卫本身照常工作`);
	}
}

/** 节流保存：每 10 秒最多写一次盘（写盘失败由 writeState 自己 warn + 落盘，不往上抛）。 */
function scheduleSave() {
	if (!cfgPersist) return;
	const now = Date.now();
	if (now - lastSaveAt < STATE_SAVE_INTERVAL_MS) return;
	lastSaveAt = now;
	writeState();
}

function numberOr0(value) {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * 计费输入 = 非缓存输入 + 缓存读 + 缓存写。
 * `inputTokens` 单独只是「未命中缓存」的那一份，不能拿来当总输入。
 */
function billedInputOf(usage) {
	return numberOr0(usage.inputTokens) + numberOr0(usage.cacheReadTokens) + numberOr0(usage.cacheWriteTokens);
}

/** 从会话事件里抠出 usage 样本，字段语义见 dsh-usage-stats 的 sampleOf()。 */
function usageOfEvent(event) {
	if (event === null || typeof event !== 'object') return undefined;
	if (event.type === 'assistant/chunk' && event.data?.chunk?.type === 'usage') return event.data.chunk.usage;
	if (event.type === 'assistant/message' && event.data?.usage !== undefined) return event.data.usage;
	return undefined;
}

function turnOfEvent(event) {
	const turn = event?.data?.turn;
	return typeof turn === 'number' ? turn : undefined;
}

/** 沿父子链把这一笔消耗上卷给每个祖先。 */
function chargeAncestors(sessionId, billed, output) {
	let id = parents.get(sessionId);
	let hops = 0;
	while (id !== undefined && hops < 16) {
		const ancestor = ledgerOf(id);
		ancestor.familyInput += billed;
		ancestor.familyTurnInput += billed;
		ancestor.lastSeen = Date.now();
		id = parents.get(id);
		hops += 1;
	}
}

/**
 * 预算到线 = 保险丝。`trippedSession` / `trippedFamily` 是**粘性**的：
 * 换轮不复位、重启也不复位 —— 它们表达的是「这个会话已经把终身预算花掉了」
 * 这个事实，而不是「这一刻正在超支」。
 *
 * 于是必须有**三条明确的释放路径**，否则会话会被永久锁死（连 update_goal /
 * job_kill 都发不出去）：
 *   ① 逃生门：同一道门连拦 maxDenials（默认 3）次之后放行一次，并 warn
 *      —— 见 tryDeny；
 *   ② 白名单：NEVER_BLOCK 里的工具（update_goal / get_goal / job_kill /
 *      ask_user_question / todo_write / acp_status …）在**所有**预算门之前判定，
 *      永远可用 —— 见 judge 开头；
 *   ③ 显式解锁：调高对应上限、把 `DSH_LOOP_GUARD_<X>_MAX_TOKENS` 设为 0
 *      （= 关掉这道门），或者在重启前从 loop-guard-state.json 里删掉该会话条目
 *      （重启后 totalInput 从零起算）。
 *
 * 注意 loadState 会从 loop-guard-state.json 恢复 totalInput，所以「重启即解锁」
 * 对会话门/家族门并不成立 —— 解锁只能走上面三条路径之一。
 */

function charge(sessionId, ledger, usage, turn) {
	if (usage === null || typeof usage !== 'object') return;
	if (turn !== undefined && turn !== ledger.turn) {
		ledger.turn = turn;
		ledger.turnInput = 0;
		ledger.familyTurnInput = 0;
		ledger.warned = false;
		// 新一轮问答 = 新预算。本轮（turn）预算的到线判定绝不能跨轮继承，
		// 否则会话被永久锁死。注意：trippedSession / trippedFamily 是**粘性**的，
		// 不在这里复位 —— 它们表达的是「终身预算已花掉」，释放路径见上面的注释。
		ledger.tripped = false;
		// 逃生计数**也不在这里清空**：它是会话级的，不是轮级的。
		//
		// 一次真实事故：sameErrorTripped 是粘住的（只能靠逃生门放行才清），
		// 而 escape 每换一轮就归零 —— 粘住的标志配上一把永远清零的计数器，
		// 就等于「拦 N 次放行一次」这条命门永远是 1，会话被永久锁死，
		// 连读文件都读不了（除了 NEVER_BLOCK 里那几个工具）。
		// 教训：逃生计数必须活到比它所解锁的那个标志更久。
	}
	ledger.usageSamples += 1;
	if (turn !== undefined) {
		ledger.turnSamples += 1;
	} else if (!ledger.turnWarned) {
		// 本轮预算靠 data.turn 换轮清零。字段丢了的话 turnInput 会静默累积到线，
		// 而且永远不会换轮；这里至少要吼一声 —— 不能假装在保护。
		ledger.turnWarned = true;
		log(activeCtx, 'warn', `[${sessionId}] usage 样本里没有 turn 字段：本轮预算无法按轮清零，turnInput 会一直累加到线（建议用 DSH_LOOP_GUARD_SESSION_MAX_TOKENS 兜底，并检查 assistant/chunk 的 usage 事件）`);
	}
	const billed = billedInputOf(usage);
	const output = numberOr0(usage.outputTokens);
	ledger.turnInput += billed;
	ledger.totalInput += billed;
	ledger.output += output;
	ledger.requests += 1;
	ledger.lastSeen = Date.now();
	chargeAncestors(sessionId, billed, output);
	scheduleSave();
}

function sessionIdOf(exec) {
	const agent = exec?.agent;
	const id = agent?.session?.id ?? agent?.sessionId ?? exec?.sessionId ?? exec?.session?.id;
	return id === undefined || id === null ? 'unknown' : String(id);
}

/**
 * 记一次工具「失败」。
 *
 * 同一个错误反复出现 = 原地打转，这是最该拦、也最容易被「同签名重复」漏掉的一类：
 * 每次命令都略有不同（换个路径、换个参数），签名不撞，但错得一模一样。
 *
 * 事件形状（已核实）：`session/event` 的 `tool/result`，`event.data = { turn, step, message, error?, meta? }`，
 * `message.content` 是内容块数组、`message.isError` 标失败，
 * `error` 是 `{ name, code, reason? }`。优先用 error.reason 当指纹（最干净），
 * 拿不到才退回正文文本。
 */
/**
 * 插件自己吐出来的拒绝文本，全部以这个开头 —— 用来把「被拦」排除在错误指纹之外。
 */
const DENY_MARK = '【防烧钱';

/**
 * 瞬时 / 外部故障：重试一次是合理的，不该算「同一个错误反复出现」。
 *
 * 一次真实事故：Hindsight 记忆库两次取数失败（正文形如 `Error: {"error":"GET https://…"}`），
 * 被当成死循环，把整个会话锁死；而它真正的成因只是网络抽了一下。
 * 判据取「网络层字样 + HTTP 方法后跟 URL + 4xx/5xx + 超时」，宁松勿严：
 * 漏记一次瞬时错误只是少拦一次，误判一次就把人锁住。
 */
const TRANSIENT_RE =
	/(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|socket hang up|fetch failed|\b(?:GET|POST|PUT|PATCH|DELETE) https?:\/\/|\b429\b|\b50[0234]\b|rate limit|timed out|timeout of)/i;

/** 从 tool/result 的载荷里抠出错误正文：优先 error.reason，拿不到才退回正文文本。 */
/**
 * 把 tool/result 载荷里的失败信息摊平成一种形状。
 *
 * 实测见过两种（dsh 不同版本/不同失败路径会各走一种），两条路都要认，认错一个口子就漏：
 *   甲、**摊在顶层**：`data.name` / `data.code` / `data.reason`
 *       —— `dsh-agent-loop` 把 `error.info` 展开进 `session.append('tool/result', …)` 的载荷。
 *   乙、**收在 data.error 下面**：`data.error.name` / `.code` / `.reason`。
 * 顶层的 `data.name` 还可能装的是错误类名（`ToolError`）而不是工具名，所以只把它当兜底。
 */
function failureInfoOf(data) {
	const nested = data?.error;
	const pick = (key) => {
		const fromNested = nested?.[key];
		if (typeof fromNested === 'string' && fromNested !== '') return fromNested;
		const fromTop = data?.[key];
		return typeof fromTop === 'string' ? fromTop : '';
	};
	return { name: pick('name'), code: pick('code'), reason: pick('reason') };
}

/** 从 tool/result 的载荷里抠出错误正文：优先 reason，拿不到才退回正文文本。 */
function errorTextOf(info, message) {
	return info.reason !== '' ? info.reason : messageTextOf(message?.content);
}

/**
 * 从 tool/result 里认出「真正失败的那个工具」。认不出来返回 `''`。
 *
 * 返回空串而不是「未知工具」这种占位名：调用方要拿它跟当前工具做**相等**比较来决定拦不拦，
 * 一个假的占位名会永远不等于任何真工具，等于把闸门悄悄关掉。
 *
 * 先查 callId → 工具名 映射，再退回载荷里的 `name`：
 * `name` 在某些失败形状里装的是错误类名（`ToolError`）而不是工具名，靠不住。
 */
function toolNameOfResult(ledger, data) {
	const callId = data?.message?.toolCallId ?? data?.message?.source?.callId ?? data?.callId;
	if (callId !== undefined && ledger.callNames.has(String(callId))) {
		return ledger.callNames.get(String(callId));
	}
	const direct = typeof data?.name === 'string' ? data.name : '';
	if (direct !== '' && direct !== 'LoopGuard' && direct !== 'ToolError') return direct;
	return '';
}

/** 记下 callId → 工具名，好在 tool/result 里认出是谁失败了。 */
function noteToolCall(ledger, event) {
	const data = event?.data;
	if (data === null || typeof data !== 'object') return;
	const callId = data.callId ?? data.message?.toolCallId ?? data.message?.source?.callId;
	const name = typeof data.name === 'string' ? data.name : '';
	if (callId === undefined || name === '') return;
	// FIFO 淘汰而不是整表 clear()：清表会把近期 callId → 工具名 的映射一起丢掉，
	// 于是 toolNameOfResult 退回 ''，同错误闸门（judge ⑧）就从「只拦报错的那个工具」
	// 退化成「拦所有工具」——连读文件诊断都被堵死。
	if (ledger.callNames.size > CALLNAME_CAP && !ledger.callNames.has(String(callId))) evictOldest(ledger.callNames, 'callId→工具名表');
	ledger.callNames.set(String(callId), name);
}

function noteToolResult(ledger, event, cfg) {
	const data = event?.data;
	if (data === null || typeof data !== 'object') return;
	const message = data.message;
	const info = failureInfoOf(data);
	// 失败判据三条：`message.isError`（权威）、`data.error` 存在、或摊在顶层的 `code` 非空
	// —— 第三种是「摊在顶层」那种形状唯一能靠的失败信号。
	const failed = message?.isError === true || data.error !== undefined || info.code !== '';
	if (!failed) {
		// ⑥ 报错的那个工具这次成功了 → 它已经脱困，把「原地打转」的标志放下。
		//    没有这一步，标志就是纯粘性的：一旦立起来，只能靠逃生门放行才清，
		//    而放行本身又要等逃生计数凑满 —— 两次意外的失败就能让整个会话长期带病运行。
		//    只认「同一个工具成功」，别的工具跑通不代表这个坑填上了。
		if (
			ledger.sameErrorTripped &&
			ledger.lastErrorTool !== '' &&
			toolNameOfResult(ledger, data) === ledger.lastErrorTool
		) {
			ledger.sameErrorTripped = false;
			ledger.lastErrorCount = 0;
			ledger.lastError = '';
		}
		return;
	}

	// ① 插件自己的拒绝不算「同一个错误」。
	//    不排除它就会自我喂养：拒绝 → 工具失败 → 新的错误指纹 → 再拒绝；
	//    更糟的是拒绝文本里嵌着上一次的拒绝文本，一层套一层越滚越长
	//    （真实事故：套娃到五层、上万字，会话被锁死）。
	if (info.name === 'LoopGuard' || info.code.startsWith('LOOP_GUARD')) return;
	const text = errorTextOf(info, message);
	// 只看开头一小段：正文可能被工具层包一层 `Error: `，用 startsWith 会漏。
	if (text.slice(0, 48).includes(DENY_MARK)) return;

	// ② 瞬时 / 外部故障不计入：那不是 agent 在原地打转。
	if (TRANSIENT_RE.test(text)) return;

	// ③ 指纹带上工具名：A 工具的错误不该把 B 工具拦住
	//    （真实事故：记忆库的接口错，把读文件也拦了）。
	const tool = toolNameOfResult(ledger, data);
	const key = errorKeyOf(`${tool}\u0000${text}`);
	if (key === '') return;
	const count = (ledger.errors.get(key) ?? 0) + 1;
	if (ledger.errors.size > ERROR_CAP && !ledger.errors.has(key)) evictOldest(ledger.errors, '错误指纹表');
	ledger.errors.set(key, count);
	ledger.lastError = key;
	ledger.lastErrorCount = count;
	// ④ 记下真正报错的那个工具 —— 理由要说清「谁在报错」，而不是「这一次调的是谁」。
	//    认不出来（tool === ''）时**不要覆盖**上一次认出来的工具名：把 lastErrorTool
	//    写成 '' 会让 ⑧ 的同错误闸门从「只拦报错工具」变成「拦所有工具」。
	if (tool !== '') ledger.lastErrorTool = tool;
	if (count >= cfg.sameErrorLimit) ledger.sameErrorTripped = true;
}

function deny(reason, code) {
	return { kind: 'deny', reason, info: { name: 'LoopGuard', code, reason } };
}

/**
 * 「拦 N 次后放行」的逃生门（**重复类**闸门用）：返回 true = 这次可以拦，
 * false = 必须放行。
 *
 * 重复类说的是「你正在做同一件事」：反复提醒才有意义，所以拦 N 次放行一次，
 * N = maxDenials（默认 3）。配额类的语义不同，见 quotaExempt。
 *
 * 放行的时候一定要吼一声 —— 逃生门本来是防止 agent 被锁死的，但如果某个 agent
 * 一而再再而三地撞同一个闸门，那说明它真的卡住了，静默放行等于偷偷烧钱。
 */
function tryDeny(ctx, ledger, key, cfg, label) {
	const used = numberOr0(ledger.escape[key]);
	if (used >= cfg.maxDenials) {
		ledger.escape[key] = 0;
		log(ctx, 'warn', `${label}：已连拦 ${cfg.maxDenials} 次，按逃生门放行一次 —— 这是保险丝，不是刹车（agent 不能被永久锁死）；如果它一直撞这一处，请人工看一眼它到底卡在哪，或者调高对应的上限（环境变量 DSH_LOOP_GUARD_* / 设置面板里同一个字段）`);
		return false;
	}
	ledger.escape[key] = used + 1;
	return true;
}

/**
 * 配额类闸门的**一次性豁免**：达到或超过配额的那一次 warn + 放行，此后每次都拦。
 *
 * 与重复类逃生门（tryDeny）的区别 —— 这就是为什么要分成两个函数：
 *   · 重复类 = 「你在做同一件事」→ 拦 maxDenials 次放行一次，反复提醒才有意义；
 *   · 配额类（子代理请求数 / 工具数 / 扇出 / workflow 扇出 / 熔断）= 「额度用完了」，
 *     再拦几次额度也不会变好；按 maxDenials 循环放行等于把上限变成
 *     「1/4 速率继续烧钱」，「上限」两个字就废了。
 * 所以配额类只豁免一次，而且**与 maxDenials / ledger.escape 完全无关**
 * （quotaExempted 是独立的一次性豁免记录）。要真继续，只能调高上限。
 *
 * @returns true = 这次放行（豁免），false = 这次拦下
 */
function quotaExempt(ctx, ledger, key, label) {
	if (ledger.quotaExempted[key] === true) return false;
	ledger.quotaExempted[key] = true;
	log(ctx, 'warn', `${label}：配额已用完，按一次性豁免放行这一次（只豁免一次，之后每一次超配额都会拦；与 maxDenials 无关）—— 这是保险丝，不是刹车；要真继续，请调高对应的上限（DSH_LOOP_GUARD_* 环境变量或设置面板里同一个字段）`);
	return true;
}

/**
 * 乒乓循环：每一步签名都是「新的」，但整体在原地转（A B A B A B...）。
 * 只看签名计数永远抓不到它，所以额外维护一个最近签名序列，数「相邻二元组」。
 */
function cycleOf(ledger, signature, cfg) {
	const recent = ledger.recent;
	recent.push(signature);
	while (recent.length > 12) recent.shift();
	if (recent.length < 6) return undefined;
	const counts = new Map();
	for (let index = 1; index < recent.length; index += 1) {
		// 自己接自己不算乒乓，那种重复由「同签名」闸门负责。
		if (recent[index - 1] === recent[index]) continue;
		const key = `${recent[index - 1]}\u0000${recent[index]}`;
		const seen = (counts.get(key) ?? 0) + 1;
		if (seen >= cfg.cycleLimit) return key;
		counts.set(key, seen);
	}
	return undefined;
}

// ────────────────────────── 横向异常：同父兄弟比一比 ──────────────────────────

/**
 * 每次模型请求的平均花费。
 *
 * 直接比 totalInput 是不公平的：跑得久、活得长的子代理总量天然更大，
 * 会被误判成「异常」。比「每次请求平均花多少」才问对了问题 ——
 * 单次请求就比别人贵好几倍，那才是真的有问题。
 */
function perRequestOf(ledger) {
	const denominator = Math.max(1, ledger.requests, ledger.modelCalls);
	return ledger.totalInput / denominator;
}

function outlierOf(ledger, sessionId, cfg) {
	const parent = parents.get(sessionId);
	if (parent === undefined) return undefined;
	const siblings = childrenOf.get(parent);
	if (siblings === undefined || siblings.size < cfg.outlierMinSiblings) return undefined;
	const values = [];
	for (const id of siblings) values.push(perRequestOf(ledgerOf(id)));
	if (values.length < cfg.outlierMinSiblings) return undefined;
	// 总花费太低的不判异常，免得把正常的小任务误伤。
	if (ledger.totalInput < cfg.outlierFloorTokens) return undefined;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	const median = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
	if (!(median > 0)) return undefined;
	const own = perRequestOf(ledger);
	if (own <= median * cfg.outlierRatio) return undefined;
	return {
		median,
		own,
		ratio: own / median,
		siblings: values.length,
		totalInput: ledger.totalInput,
		requests: Math.max(ledger.requests, ledger.modelCalls)
	};
}

// ────────────────────────── 熔断：烧多吐少 = 失败 ──────────────────────────

function breakerOf(rootId, cfg) {
	const ledger = ledgerOf(rootId);
	if (ledger.childFailures < cfg.maxBatchFailures) return undefined;
	return { failures: ledger.childFailures, need: cfg.maxBatchFailures };
}

// ────────────────────────────── 拦下时说的话 ──────────────────────────────

/** 本轮消耗的拆解说明 —— 只有真的带了子代理才多这一句。 */
function turnSpendNote(ledger) {
	return ledger.familyTurnInput > 0
		? `（自己 ${human(ledger.turnInput)} + 子代理 ${human(ledger.familyTurnInput)}）`
		: '';
}

function turnBudgetText(ledger, cfg) {
	return [
		'【防烧钱 · 预算用尽，已硬停手】',
		`这一轮问答累计计费输入 ${human(ledger.turnInput + ledger.familyTurnInput)} token${turnSpendNote(ledger)}，到达上限 ${human(cfg.maxTokens)}（会话累计 ${human(ledger.totalInput)}，模型请求 ${ledger.requests} 次，工具调用 ${ledger.toolCalls} 次）。`,
		'从现在起所有工具调用都会被拦住。不要重试、不要换工具绕、不要重新规划、不要道歉铺垫。',
		'立刻直接输出一份交账报告，必须包含三部分：',
		'1) 已经做完什么 —— 具体到文件路径、命令、拿到的结论；',
		'2) 还剩什么没做 —— 具体到下一步该做什么；',
		'3) 建议用户怎么继续 —— 最多三句话。'
	].join('\n');
}

function softLandingText(ledger, cfg, toolName) {
	return [
		'【防烧钱 · 预算用尽，软着陆中】',
		`这一轮累计计费输入 ${human(ledger.turnInput + ledger.familyTurnInput)} token${turnSpendNote(ledger)}，已到上限 ${human(cfg.maxTokens)}。`,
		`「${toolName}」属于继续探索/继续花钱的工具，被拦下了；但 read / write / edit / todo_write 这类收尾工具还能用。`,
		'现在不要再开新战线。用还能用的工具把手上这件事写完、把结论落进文件或回复里，然后交账：做了多少 / 还剩什么。'
	].join('\n');
}

/** 整个会话的预算也用光了——这时候要劝人开新对话。 */
function sessionBudgetText(ledger, cfg) {
	return [
		'【防烧钱 · 整个会话的预算也用尽，已硬停手】',
		`这个会话累计计费输入 ${human(ledger.totalInput)} token，到达会话上限 ${human(cfg.sessionMaxTokens)}（本轮 ${human(ledger.turnInput)}，模型请求 ${ledger.requests} 次）。`,
		'所有工具调用都会被拦住。别再试了，直接输出交账报告：',
		'1) 已经做完什么；2) 还剩什么没做；3) 明确告诉用户：这个会话该开新的了，把上面的结论带过去。'
	].join('\n');
}

function familyBudgetText(ledger, cfg) {
	const total = ledger.totalInput + ledger.familyInput;
	return [
		'【防烧钱 · 家族总预算用尽，已硬停手】',
		`这个会话连同它生出来的所有子代理，累计计费输入 ${human(total)} token（自己 ${human(ledger.totalInput)} + 后代 ${human(ledger.familyInput)}），到达家族上限 ${human(cfg.familyMaxTokens)}。`,
		'所有成员的工具调用都会拦住。直接输出交账报告：1) 已经做完什么；2) 还剩什么没做；3) 如果还要继续，请让用户把上限调高或开新会话。'
	].join('\n');
}

function requestBudgetText(ledger, cfg) {
	return [
		'【防烧钱 · 子代理请求数到顶】',
		`这个子代理已经发出 ${ledger.modelCalls} 次模型请求，超过子代理上限 ${cfg.maxSubagentRequests}（累计计费输入 ${human(ledger.totalInput)}）。`,
		'停下来，别再加轮次。用最少的动作把手上已经拿到的结论整理出来并返回，明确说清「做到哪一步、什么没验证过」。',
		'这是硬上限：重发不会被放行（首次超限那一次已经豁免掉了）。要真继续，请调高 DSH_LOOP_GUARD_MAX_SUBAGENT_REQUESTS，或开新会话。'
	].join('\n');
}

function toolBudgetText(ledger, cfg) {
	return [
		'【防烧钱 · 子代理工具调用数到顶】',
		`这个子代理已经调用工具 ${ledger.toolCalls} 次，超过上限 ${cfg.maxSubagentTools}。`,
		'这通常意味着它在原地打转。停止探索，立刻把现有结果整理成最终回复返回。'
	].join('\n');
}

function outlierText(ledger, cfg, info) {
	return [
		'【防烧钱 · 这个子代理单次请求花得明显离谱】',
		`它已经花了 ${human(info.totalInput)} token（${info.requests} 次模型请求），每次请求平均 ${human(info.own)}；而同一个父下面 ${info.siblings} 个兄弟每次请求的中位数只有 ${human(info.median)} —— 它是兄弟的 ${info.ratio.toFixed(1)} 倍。`,
		'判定为异常消耗，本次调用被拦。二选一：',
		'1) 立刻收敛，把已有结果返回，不要再开新的探索；',
		'2) 如果确实需要这么多，先用一句话说明为什么它和别的子代理不一样 —— 同一处累计连拦到上限（默认 3 次）后会自动放行一次，放行那一次紧接着再原样发一次也放行。'
	].join('\n');
}

function sameErrorText(ledger, cfg) {
	// 指纹里带了工具名做前缀（`工具名\u0000错误正文`），展示时拆开，别把前缀糊在正文里。
	const raw = ledger.lastError;
	const cut = raw.indexOf('\u0000');
	const body = cut === -1 ? raw : raw.slice(cut + 1);
	const who = ledger.lastErrorTool === '' ? '某个工具' : ledger.lastErrorTool;
	return [
		'【防烧钱 · 同一个错误反复出现，判定原地打转】',
		`${who} 报的同一个错误已经出现 ${ledger.lastErrorCount} 次（阈值 ${cfg.sameErrorLimit}）：`,
		`  ${body.slice(0, 160)}`,
		'同一个错误重复出现，意味着前面每一次尝试都白花了钱。现在请：',
		'1) 停下来，用一句话说出你认为的根因是什么；',
		'2) 换一个**假设**再动手（不是换一个写法）；',
		'3) 连续两次同一个错误之后，就不要再自己猜了 —— 把错误原文和已经试过的方法列出来，交给用户或换一个方向。',
		`注意：这道闸门只拦 ${who} —— 别的工具照常能用，`,
		'诊断这个坑所需要的读文件、查日志、看代码，都不受影响。'
	].join('\n');
}

function cycleText(cfg, left, right) {
	return [
		'【防烧钱 · 乒乓循环，本次调用被拦】',
		`最近的操作在两种写法之间来回打转 ${cfg.cycleLimit} 轮以上：`,
		`  A: ${left.slice(0, 120)}`,
		`  B: ${right.slice(0, 120)}`,
		'每一步看起来都是「新的」，但整体在原地转，继续下去只是重复烧钱。',
		'停下来，先说清「A 和 B 各自证明了什么」，再决定下一步 —— 如果两个方向都已经排除了，那正确答案大概率在第三个方向上。'
	].join('\n');
}

function skeletonText(toolName, count, limit, skeleton) {
	return [
		'【防烧钱 · 换个写法做同一件事，本次调用被拦】',
		`把路径、数字、引号抹平之后，「${skeleton}」这个骨架已经出现过 ${count} 次（阈值 ${limit}），这次是 ${toolName}。`,
		'换一个路径、换一个数字再跑一遍，和原样重跑没有区别。',
		'二选一：1) 换成真正不同的做法（不同的工具、不同的假设）；2) 说明为什么前面那些结果都不能用 —— 同一处累计连拦到上限（默认 3 次）后会自动放行一次，放行那一次紧接着再原样发一次也放行。'
	].join('\n');
}

function breakerText(info, cfg) {
	return [
		'【防烧钱 · 熔断】',
		`这个会话下面已经有 ${info.failures} 个子代理属于「烧了一大笔、只吐回一丁点」，达到熔断线 ${info.need}。`,
		'现在不再允许开新的子代理。请改用两种办法之一：',
		'1) 自己直接做（父代理已经带着全部上下文，通常比再派一个更省）；',
		'2) 换一个更小、更明确的任务再派，并且先把任务拆到足够具体。'
	].join('\n');
}

function fanoutText(alive, cfg) {
	return [
		'【防烧钱 · 扇出到顶】',
		`现在同时活着的子代理已经有 ${alive} 个，到达上限 ${cfg.maxFanout}。`,
		'子代理是乘数，同时跑太多会让总消耗失控。请：',
		'1) 先等现有子代理返回，收完结果再派新的；',
		'2) 或者把几个小任务合并成一个子代理去做。'
	].join('\n');
}

function workflowText(info, cfg) {
	return [
		'【防烧钱 · workflow 扇出过大】',
		`这个 workflow 脚本里有 ${info.calls} 处 agent() 调用，再乘上条目数 ${info.multiplier}，预计会扇出约 ${info.estimated} 个子代理，超过允许的 ${cfg.maxWorkflowAgents}。`,
		'一个脚本就能一次性扇出几十个子代理，是总消耗失控最隐蔽的入口。',
		'请先把规模降下来（分批跑、或减少条目数），确认单批消耗之后再放大。确实需要这么大，就调高 DSH_LOOP_GUARD_MAX_WORKFLOW_AGENTS。'
	].join('\n');
}

function repeatText(toolName, record, limit, signature) {
	return [
		'【防烧钱 · 疑似死循环，本次调用被拦】',
		`同一个调用（${toolName}）已经执行过 ${record.count} 次，阈值是 ${limit}，这一次被拦下。`,
		`签名：${signature.slice(0, 200)}`,
		'停一下，二选一：',
		'1) 换打法 —— 不同的命令、不同的路径、不同的思路；',
		'2) 如果确实必须重跑，先用一句话说明为什么前面的结果不能用 —— 同一处累计连拦到上限（默认 3 次）后会自动放行一次，放行那一次紧接着再原样发一次也放行。',
		'不要装作没被拦过、原样再发一遍。'
	].join('\n');
}

/** 预警只在越过阈值的那一刻喊一次。 */
function maybeWarn(ctx, cfg, ledger, sessionId) {
	const turnTotal = ledger.turnInput + ledger.familyTurnInput;
	// 本轮到线时把 tripped 立起来 —— 只读端点和 veto 都看这个标志，
	// 而它们可能在「到线之后还没有任何工具调用」的时候被问到
	// （例如客户端徽标轮询、agent/pre-step 开新一轮）。
	if (turnTotal >= cfg.maxTokens) ledger.tripped = true;
	if (!ledger.warned && turnTotal >= cfg.maxTokens * cfg.warnRatio) {
		ledger.warned = true;
		const percent = Math.round((turnTotal / cfg.maxTokens) * 100);
		log(ctx, 'warn', `[${sessionId}] 本轮已用 ${human(turnTotal)} / ${human(cfg.maxTokens)}（${percent}%）${turnSpendNote(ledger)}`);
	}
	// 会话累计也要预警一次。只预警本轮的话，那种每轮都不超但一路慢慢烧的会话，
	// 会一直没人喊，直到某一轮突然到线才硬停手。
	if (!ledger.warnedSession && Number.isFinite(cfg.sessionMaxTokens) && ledger.totalInput >= cfg.sessionMaxTokens * cfg.warnRatio) {
		ledger.warnedSession = true;
		const percent = Math.round((ledger.totalInput / cfg.sessionMaxTokens) * 100);
		log(ctx, 'warn', `[${sessionId}] 整个会话已用 ${human(ledger.totalInput)} / ${human(cfg.sessionMaxTokens)}（${percent}%）—— 到线后会硬停手`);
	}
}

// ────────────────────────────── 主判定 ──────────────────────────────

/**
 * 判定一次工具调用。
 * @returns 拦截对象，或 undefined 表示放行。
 */
function judge(ctx, cfg, exec) {
	const toolName = typeof exec?.name === 'string' ? exec.name : '';
	const args = exec?.arguments ?? exec?.args ?? {};


	const sessionId = sessionIdOf(exec);
	const ledger = ledgerOf(sessionId);

	// 顺手学一下「这个会话是不是子代理」。
	const execSession = exec?.agent?.session;
	if (execSession !== undefined && execSession !== null) {
		if (isSubagentSession(execSession)) {
			ledger.isSubagent = true;
			const parent = execSession.header?.parentSession;
			if (parent !== undefined && parent !== null) linkTo(String(parent), sessionId);
		}
	}
	ledger.lastSeen = Date.now();
	// 注意：这里**不能**清 ledger.escapeSig —— 它是「上一次逃生门放行了哪个签名」，
	// 要留到紧接着的下一次同签名调用才生效/消费（见 ⑩/⑪ 的契约 C6 注释）。

	// ⑦ 预警：到线前先在日志里喊一声。
	maybeWarn(ctx, cfg, ledger, sessionId);

	// 白名单必须排在**所有**闸门（包括后面四道预算门）之前。
	// 以前它在预算门之后，于是「预算用尽」会把 job_kill / update_goal /
	// ask_user_question / get_goal 一起堵死 —— 而那几件恰恰是把会话从死局里
	// 拉出来的动作（交账、关掉跑飞的 job、问用户要不要开新会话）。
	// 非工具步骤（toolName === ''）同理放行。
	// **不要往这张表里加别的工具**：它现在是预算门的例外通道，加错一个等于开天窗。
	if (toolName === '' || NEVER_BLOCK.has(toolName)) return undefined;

	// ① 会话总预算：只算本会话自己（不含后代）。默认 1e9（10 亿）。
	// 想要「连同所有后代」的版本，用 ③ 的 DSH_LOOP_GUARD_FAMILY_MAX_TOKENS。
	//
	// 这道门以前是裸 return deny(...)：粘性标志 + 永远不清的计数 = 到线即永久锁死。
	// 现在它和其他门一样走逃生门（连拦 maxDenials 次放行一次并 warn）；
	// trippedSession 仍然保持粘性，释放路径见 charge 上面的注释（三条）。
	if (ledger.trippedSession || ledger.totalInput >= cfg.sessionMaxTokens) {
		if (!ledger.trippedSession) {
			ledger.trippedSession = true;
			// 记住是在哪一轮到线的：那一轮要放它走完，好让模型把交账报告吐出来；
			// 这个轮号同时是逃生门的稳定 key（同一轮里的多次到线共用一个计数）。
			ledger.trippedSessionTurn = ledger.turn;
			log(ctx, 'warn', `[${sessionId}] 会话预算用尽：${human(ledger.totalInput)} / ${human(cfg.sessionMaxTokens)} —— 硬停手，并拒绝再开新一轮`);
		}
		if (tryDeny(ctx, ledger, `session-budget#${String(ledger.trippedSessionTurn)}`, cfg, '会话预算用尽')) {
			return deny(sessionBudgetText(ledger, cfg), 'LOOP_GUARD_SESSION_BUDGET');
		}
	}

	// ② 本轮预算：自己这一轮 + 这一轮生出来的所有子代理。到线硬停手（或软着陆），逼出交账报告。
	//
	// 「一次问答」的消耗必须连子代理一起算。只算自己的话，一次对话可以自己烧满 1 亿，
	// 再让 8 个子代理各烧 1 亿 —— 单轮上限就形同虚设。
	const turnTotal = ledger.turnInput + ledger.familyTurnInput;
	if (ledger.tripped || turnTotal >= cfg.maxTokens) {
		// 这道门也走逃生门（软着陆分支同理）：到线后连拦 maxDenials 次必须放行一次，
		// 否则「本轮」这一层同样能把会话锁死。key 带轮号 —— 下一轮是新预算、新计数。
		const turnKey = `turn-budget#${String(ledger.turn)}`;
		if (cfg.softLanding) {
			if (!SOFT_ALLOW.has(toolName) && toolName !== '') {
				if (tryDeny(ctx, ledger, `${turnKey}-soft`, cfg, '软着陆')) {
					log(ctx, 'warn', `[${sessionId}] 软着陆：拦下 ${toolName}`);
					return deny(softLandingText(ledger, cfg, toolName), 'LOOP_GUARD_SOFT_LANDING');
				}
			}
		} else {
			if (!ledger.tripped) {
				ledger.tripped = true;
				log(ctx, 'warn', `[${sessionId}] 本轮预算用尽：${human(turnTotal)} / ${human(cfg.maxTokens)}${turnSpendNote(ledger)} —— 硬停手`);
			}
			if (tryDeny(ctx, ledger, turnKey, cfg, '本轮预算用尽')) {
				return deny(turnBudgetText(ledger, cfg), 'LOOP_GUARD_BUDGET_EXHAUSTED');
			}
		}
	}

	// ③ 家族总预算（默认关闭）。祖先账本里已经上卷了所有后代的消耗。
	// 同样走逃生门；trippedFamily 保持粘性，释放路径见 charge 上面的注释。
	const familyTotal = ledger.totalInput + ledger.familyInput;
	if (ledger.trippedFamily || familyTotal >= cfg.familyMaxTokens) {
		if (!ledger.trippedFamily) {
			ledger.trippedFamily = true;
			ledger.trippedFamilyAt = ledger.turn;
			log(ctx, 'warn', `[${sessionId}] 家族预算用尽：${human(familyTotal)} / ${human(cfg.familyMaxTokens)} —— 硬停手`);
		}
		if (tryDeny(ctx, ledger, `family-budget#${String(ledger.trippedFamilyAt)}`, cfg, '家族预算用尽')) {
			return deny(familyBudgetText(ledger, cfg), 'LOOP_GUARD_FAMILY_BUDGET');
		}
	}

	// ④ 子代理专属：请求数、工具数、横向异常。
	//    请求数 / 工具数是**配额**门 → 一次性豁免（quotaExempt）；横向异常是
	//    「你比别人离谱」→ 重复类语义，仍然走 tryDeny。
	if (ledger.isSubagent) {
		if (ledger.modelCalls >= cfg.maxSubagentRequests && !quotaExempt(ctx, ledger, 'requests', `[${sessionId}] 子代理请求数到顶`)) {
			log(ctx, 'warn', `[${sessionId}] 子代理请求数到顶：${ledger.modelCalls} —— 拦`);
			return deny(requestBudgetText(ledger, cfg), 'LOOP_GUARD_SUBAGENT_REQUESTS');
		}
		if (ledger.toolCalls >= cfg.maxSubagentTools && !quotaExempt(ctx, ledger, 'tools', `[${sessionId}] 子代理工具数到顶`)) {
			log(ctx, 'warn', `[${sessionId}] 子代理工具数到顶：${ledger.toolCalls} —— 拦`);
			return deny(toolBudgetText(ledger, cfg), 'LOOP_GUARD_SUBAGENT_TOOLS');
		}
		const outlier = outlierOf(ledger, sessionId, cfg);
		if (outlier !== undefined && tryDeny(ctx, ledger, 'outlier', cfg, '横向异常')) {
			log(ctx, 'warn', `[${sessionId}] 横向异常：每次请求 ${human(outlier.own)} vs 兄弟中位数 ${human(outlier.median)}（${outlier.ratio.toFixed(1)} 倍）—— 拦`);
			return deny(outlierText(ledger, cfg, outlier), 'LOOP_GUARD_OUTLIER');
		}
	}

	// ⑤⑥ 出生闸门：熔断 + 扇出 + workflow 估数。三者都是**配额**门 → 一次性豁免。
	if (SPAWN_TOOLS.has(toolName)) {
		const root = rootOf(sessionId);
		const breaker = breakerOf(root, cfg);
		if (breaker !== undefined && !quotaExempt(ctx, ledger, 'breaker', `[${root}] 熔断`)) {
			log(ctx, 'warn', `[${root}] 熔断：已有 ${breaker.failures} 个子代理烧多吐少 —— 拦下新的 spawn`);
			return deny(breakerText(breaker, cfg), 'LOOP_GUARD_BREAKER');
		}
		const alive = liveDescendants(root, cfg);
		if (alive >= cfg.maxFanout && !quotaExempt(ctx, ledger, 'fanout', `[${root}] 扇出到顶`)) {
			log(ctx, 'warn', `[${root}] 扇出到顶：同时活着 ${alive} 个子代理 —— 拦下新的 spawn`);
			return deny(fanoutText(alive, cfg), 'LOOP_GUARD_FANOUT');
		}
		if (toolName === 'workflow') {
			const estimate = estimateAgents(args?.script, args?.args ?? args);
			if (estimate.estimated > cfg.maxWorkflowAgents && !quotaExempt(ctx, ledger, 'workflow', `[${sessionId}] workflow 扇出过大`)) {
				log(ctx, 'warn', `[${sessionId}] workflow 扇出估计 ${estimate.estimated} 个子代理（${estimate.calls} 处 agent() × ${estimate.multiplier}）—— 拦`);
				return deny(workflowText(estimate, cfg), 'LOOP_GUARD_WORKFLOW_FANOUT');
			}
		}
	}

	const signature = signatureOf(toolName, args);

	// ⑧ 同一个错误又冒出来了 —— 最典型的「原地打转」，前面每一次尝试都白花了钱。
	//
	// **只拦报错的那个工具。** 指纹本来就带工具名，拦的时候也得对得上：
	// 事故里最难受的一段就是「pwsh 反复失败 → 连读个文件都被拦」，
	// 而读文件恰恰是它诊断失败原因所必需的动作 —— 想让它换假设，
	// 就不能顺手把它换假设要用的工具一起堵死。别的工具出错两次，会去拦那个工具。
	if (ledger.sameErrorTripped && (ledger.lastErrorTool === '' || toolName === ledger.lastErrorTool)) {
		if (tryDeny(ctx, ledger, 'sameError', cfg, '同一个错误反复出现')) {
			log(ctx, 'warn', `[${sessionId}] 同一个错误已出现 ${ledger.lastErrorCount} 次 —— 拦：${ledger.lastError.slice(0, 120)}`);
			return deny(sameErrorText(ledger, cfg), 'LOOP_GUARD_SAME_ERROR');
		}
		ledger.sameErrorTripped = false;
	}

	// ⑨ A-B-A-B 乒乓循环：每一步都是「新的」，整体却在原地转。
	const cycle = cycleOf(ledger, signature, cfg);
	if (cycle !== undefined && tryDeny(ctx, ledger, 'cycle', cfg, '乒乓循环')) {
		const [left, right] = cycle.split('\u0000');
		log(ctx, 'warn', `[${sessionId}] 乒乓循环 ${cfg.cycleLimit} 轮 —— 拦`);
		return deny(cycleText(cfg, left, right), 'LOOP_GUARD_CYCLE');
	}

	// ⑩ 同骨架：换路径、换数字、换引号接着做同一件事。一级指纹抓不住它。
	//
	// 契约（和 ⑪ 一起看）：文档承诺的「照原样再发一次会被放行」必须**两个门同时成立**
	// 才算数 —— 逃生门放行的那一次，不能被紧接着的同骨架门拒掉；反之亦然。
	// 实现：逃生门放行时把签名记进 ledger.escapeSig，紧接着的同签名调用整体豁免一次
	// （⑩ 与 ⑪ 一起让路，由 ⑪ 消费掉这个标记）。
	const skeleton = skeletonFor(toolName, signature);
	const skeletonRecord = ledger.skeletons.get(skeleton) ?? { count: 0 };
	const exempt = ledger.escapeSig === signature && ledger.escapeSigUsed !== true;
	if (skeletonRecord.count >= cfg.skeletonLimit) {
		if (exempt) {
			fileLog('info', `[${sessionId}] 同骨架门为刚被逃生门放行的同签名调用让路：${skeleton.slice(0, 120)}`);
		} else if (tryDeny(ctx, ledger, 'skeleton', cfg, '同骨架重复')) {
			log(ctx, 'warn', `[${sessionId}] 同骨架调用第 ${skeletonRecord.count + 1} 次 —— 拦：${skeleton.slice(0, 120)}`);
			return deny(skeletonText(toolName, skeletonRecord.count, cfg.skeletonLimit, skeleton), 'LOOP_GUARD_SKELETON');
		} else {
			// 同骨架门的逃生门放行了这一次：记下签名，让紧接着的同签名调用也整体豁免。
			ledger.escapeSig = signature;
			ledger.escapeSigUsed = false;
		}
	}
	skeletonRecord.count += 1;
	if (ledger.skeletons.size > SIGNATURE_CAP && !ledger.skeletons.has(skeleton)) evictOldest(ledger.skeletons, '骨架指纹表');
	ledger.skeletons.set(skeleton, skeletonRecord);

	// ⑪ 同签名重复。
	const limit = toolName === 'read' ? cfg.readRepeatLimit : cfg.repeatLimit;
	const record = ledger.signatures.get(signature) ?? { count: 0 };

	if (record.count >= limit) {
		// 逃生计数住在会话级 escape 表（key 带签名散列），不放在签名记录里：
		// 签名表满了按 FIFO 淘汰，计数若跟着记录走会被一起清掉，
		// 「照原样再发一次会被放行」这条契约就不成立了。
		const escapeKey = escapeKeyFor(ledger, 'repeat#', signature);
		if (exempt) {
			// 上一次就是它被放行的 —— 这一次照原样再发，两个门一起让路，豁免用掉。
			ledger.escapeSigUsed = true;
			record.count += 1;
			ledger.signatures.set(signature, record);
			fileLog('info', `[${sessionId}] 同签名门消费掉上一次的豁免（照原样再发一次）：${signature.slice(0, 120)}`);
			return undefined;
		}
		if (tryDeny(ctx, ledger, escapeKey, cfg, '同一签名重复')) {
			log(ctx, 'warn', `[${sessionId}] 拦下第 ${record.count + 1} 次同签名调用：${signature.slice(0, 160)}`);
			return deny(repeatText(toolName, record, limit, signature), 'LOOP_GUARD_REPEAT');
		}
		// 逃生门放行了这一次 —— 记住签名，让紧接着的同签名调用也整体豁免一次（契约 C6）。
		record.count += 1;
		ledger.signatures.set(signature, record);
		ledger.escapeSig = signature;
		ledger.escapeSigUsed = false;
		return undefined;
	}

	record.count += 1;
	if (ledger.signatures.size > SIGNATURE_CAP && !ledger.signatures.has(signature)) evictOldest(ledger.signatures, '签名表');
	ledger.signatures.set(signature, record);
	// 两个门都没到线：把上一次留下的豁免标记消费掉，别让它漏到更后面的调用上去。
	if (exempt) ledger.escapeSigUsed = true;
	ledger.toolCalls += 1;

	// 自检：跑了这么多工具，却没有任何**带 turn 的** usage 样本 —— 说明记账的口子对不上
	// （DSH 换了事件名/字段名，或者样本里没有 turn 字段）。以前只要求 requests === 0，
	// 于是「样本收到了、但没有 turn 字段」这种情况永远不触发：turnInput 静默累积到线，
	// 而没有任何告警。宁可吼一声，也不能假装在保护。
	if (!ledger.blindWarned && ledger.toolCalls >= 20 && (ledger.requests === 0 || ledger.turnSamples === 0)) {
		ledger.blindWarned = true;
		log(ctx, 'warn', `[${sessionId}] 已经跑了 ${ledger.toolCalls} 次工具调用，却没有一个「带 turn 的 usage 样本」（收到的 usage 样本 ${ledger.usageSamples} 个，其中带 turn 的 ${ledger.turnSamples} 个）—— 本轮预算按轮清零失效、计数可能是空的，请检查 assistant/chunk 的 usage 事件（请求数/工具数/签名类闸门仍然有效）`);
	}
	return undefined;
}

/**
 * 会话预算到线之后，拒绝开新的一轮问答。
 *
 * 为什么必须有这道闸门：只拦工具调用是拦不住烧钱的 —— 模型完全可以在「不调工具」
 * 的情况下一直说话，而每一轮都会把完整上下文重新发一遍，钱照烧。
 * 换一个 turn 就等于换了一份新预算，所以「会话级」的上限必须跨轮才守得住。
 *
 * agent/pre-step 的 reject 是**空决定**（只有 `{kind:'reject'}`，没有 reason 能带给模型），
 * 所以到线的那一轮一定要放它走完 —— 模型的交账报告是在那一轮生成的。
 */
function vetoNewTurn(ctx, cfg, payload) {
	const agent = payload?.agent;
	const sessionId = String(agent?.session?.id ?? agent?.sessionId ?? 'unknown');
	const ledger = ledgers.get(sessionId);
	if (ledger === undefined || !ledger.trippedSession) return undefined;
	const turn = typeof payload?.turn === 'number' ? payload.turn : undefined;
	if (turn === undefined || ledger.trippedSessionTurn === undefined) return undefined;
	if (turn <= ledger.trippedSessionTurn) return undefined;
	log(ctx, 'warn', `[${sessionId}] 会话预算已用尽（${human(ledger.totalInput)} / ${human(cfg.sessionMaxTokens)}），拒绝开新一轮问答（turn ${turn}）`);
	return { kind: 'reject' };
}

// ────────────────────────── 只读用量端点 ──────────────────────────

/**
 * 给客户端会话头徽标用的只读端点：`GET /api/loop-guard/usage?sessionId=<id>`。
 *
 * 只读内存账本 —— **不读文件、不落盘、不新建账本、不返回任何密钥**。
 * sessionId 只从 query 参数拿；未知会话返回全 0 而不是 404（徽标只需要能画出来的数）。
 */
const USAGE_ROUTE_PATH = '/api/loop-guard/usage';

/** 上限在 JSON 里不能是 Infinity（会变成 null）：不设限统一报 0，契约里 0 = 不设限。 */
function jsonLimit(value) {
	return Number.isFinite(value) ? value : 0;
}

function usagePayload(sessionId, cfg) {
	// 注意是 ledgers.get，不是 ledgerOf：一个 GET 不该凭空建出一条账本。
	const ledger = ledgers.get(sessionId);
	const turnInput = numberOr0(ledger?.turnInput);
	const familyTurnInput = numberOr0(ledger?.familyTurnInput);
	return {
		ok: true,
		sessionId,
		session: {
			totalInput: numberOr0(ledger?.totalInput),
			familyInput: numberOr0(ledger?.familyInput),
			output: numberOr0(ledger?.output),
			requests: numberOr0(ledger?.requests),
			modelCalls: numberOr0(ledger?.modelCalls),
			toolCalls: numberOr0(ledger?.toolCalls),
			turn: numberOr0(ledger?.turn),
			lastSeen: numberOr0(ledger?.lastSeen)
		},
		turn: { input: turnInput, familyTurnInput, total: turnInput + familyTurnInput },
		limits: { maxTokens: jsonLimit(cfg?.maxTokens), sessionMaxTokens: jsonLimit(cfg?.sessionMaxTokens) },
		tripped: {
			turn: ledger?.tripped === true,
			session: ledger?.trippedSession === true,
			family: ledger?.trippedFamily === true
		},
		updatedAt: Date.now()
	};
}

function writeJson(res, status, body) {
	try {
		res.statusCode = status;
		res.setHeader('content-type', 'application/json; charset=utf-8');
		res.setHeader('cache-control', 'no-store');
		res.end(JSON.stringify(body));
	} catch {
		/* 端点写不出去不该影响别的任何东西 */
	}
}

function handleUsageRequest(req, res, cfg) {
	if (typeof req?.method === 'string' && req.method !== 'GET') {
		writeJson(res, 405, { ok: false, error: 'method-not-allowed' });
		return;
	}
	let sessionId = '';
	try {
		sessionId = new URL(String(req?.url ?? '/'), 'http://127.0.0.1').searchParams.get('sessionId') ?? '';
	} catch {
		sessionId = '';
	}
	if (sessionId === '') {
		writeJson(res, 400, { ok: false, error: 'sessionId-required' });
		return;
	}
	writeJson(res, 200, usagePayload(sessionId, cfg));
}

// ────────────────────────────── 注册 ──────────────────────────────

export function apply(ctx, config) {
	const cfg = readConfig(config);
	if (cfg.off) {
		log(ctx, 'info', '已被 DSH_LOOP_GUARD_OFF=1 关掉');
		return;
	}
	cfgPersist = cfg.persist;
	// 诊断日志的开关/路径只在 apply 里定：模块级函数（charge → writeState、
	// 闸门里的 fileLog）没有 cfg，只能读这两个模块变量。
	activeCtx = ctx;
	logPath = cfg.logFile === '' ? LOG_DEFAULT_FILE : cfg.logFile;
	// 诊断日志还跟记账共用一道闸：记账关掉的调用方（测试桩、一次性脚本）不该往
	// 用户的 ~/.dsh 里塞日志。DSH_LOOP_GUARD_LOG=0 则是显式的单独关掉。
	logEnabled = cfg.log !== false && cfgPersist;
	if (cfgPersist) loadState(ctx);

	// 记账：每个 usage 样本都是一次模型请求的账单。
	ctx.on('session/event', (session, event) => {
		try {
			const sessionId = String(session?.id ?? 'unknown');
			const ledger = ledgerOf(sessionId);
			learnSession(session);
			// 请求数不依赖 usage 事件：assistant/message 一到就记一笔。
			if (event?.type === 'assistant/message') {
				ledger.modelCalls += 1;
				ledger.lastSeen = Date.now();
			}
			// 记下「这次调用是谁」和「它失败了没有」，两者配对才能认出是谁报的错。
			if (event?.type === 'tool/call') noteToolCall(ledger, event);
			if (event?.type === 'tool/result') noteToolResult(ledger, event, cfg);
			const usage = usageOfEvent(event);
			if (usage === undefined) return;
			charge(sessionId, ledger, usage, turnOfEvent(event));
			// 一越过阈值就喊，不等下一次工具调用。
			maybeWarn(ctx, cfg, ledger, sessionId);
		} catch {
			/* 记账失败不能拦住会话 */
		}
	});

	// 新会话：登记父子关系，并把历史事件重放一遍。
	ctx.on('session/created', (session) => {
		try {
			learnSession(session);
			const sessionId = String(session?.id ?? 'unknown');
			const ledger = ledgerOf(sessionId);
			if (ledger.requests > 0 || retired.has(sessionId)) return;
			const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : [];
			for (const event of events ?? []) {
				if (event?.type === 'assistant/message') ledger.modelCalls += 1;
				if (event?.type === 'tool/call') noteToolCall(ledger, event);
				if (event?.type === 'tool/result') noteToolResult(ledger, event, cfg);
				const usage = usageOfEvent(event);
				if (usage !== undefined) charge(sessionId, ledger, usage, turnOfEvent(event));
			}
		} catch {
			/* 重放失败就只从此刻开始算 */
		}
	});

	// 会话结束：记「烧多吐少」的失败，然后**把账本从内存里放掉**。
	//
	// 为什么不丢账：家族额度是每次 charge 时上卷给祖先的（chargeAncestors），
	// 内存里那份子账本只是「还没来得及上卷的暂存」，删掉不会让祖先少算。
	// 不删的代价则是：跑一个 workflow 起几十个子会话，ledgers / parents / childrenOf
	// 会一直涨，插件自己变成内存泄漏。
	ctx.on('session/disposed', (session) => {
		try {
			const id = sessionIdOfSession(session);
			if (id === undefined) return;
			const parent = parents.get(id);
			const ledger = ledgers.get(id);
			if (parent !== undefined) {
				const siblings = childrenOf.get(parent);
				if (siblings !== undefined) siblings.delete(id);
				if (ledger !== undefined && ledger.totalInput >= cfg.emptyResultTokens && ledger.output < cfg.emptyResultOutput) {
					const parentLedger = ledgerOf(parent);
					parentLedger.childFailures += 1;
					log(ctx, 'warn', `[${parent}] 子代理 ${id} 烧了 ${human(ledger.totalInput)} 却只吐回 ${ledger.output} token 输出，记一次失败（累计 ${parentLedger.childFailures}/${cfg.maxBatchFailures}）`);
				}
			}
			ledgers.delete(id);
			childrenOf.delete(id);
			parents.delete(id);
			retired.add(id);
			if (retired.size > RETIRED_CAP) retired.clear();
			writeState();
		} catch {
			/* 清账失败不能影响别的东西 */
		}
	});

	// 核心：工具调用闸门（瀑布流，返回判定对象即否决）。
	ctx.on('tools/pre-execute', async (exec, next) => {
		try {
			const verdict = judge(ctx, cfg, exec);
			if (verdict !== undefined) return verdict;
		} catch (error) {
			log(ctx, 'warn', `判定出错，放行：${error instanceof Error ? error.message : String(error)}`);
		}
		return next();
	});

	// 会话预算到线后，连新的一轮问答都不给开（见 vetoNewTurn 的注释）。
	if (cfg.vetoNewTurn) {
		ctx.on('agent/pre-step', async (payload, next) => {
			try {
				const verdict = vetoNewTurn(ctx, cfg, payload);
				if (verdict !== undefined) return verdict;
			} catch (error) {
				log(ctx, 'warn', `新一轮判定出错，放行：${error instanceof Error ? error.message : String(error)}`);
			}
			return next();
		});
	}

	// 只读用量端点：webServer **可选注入** —— 宿主没有这个服务时插件照常加载、
	// 闸门照常工作，只是没有这个端点（安全插件绝不能因为缺服务而加载失败）。
	// 可选注入的写法出处（已核实）：
	//   · <profile>\node_modules\@changfenhuang\dsh-genui\lib\index.js:5264
	//     `ctx.inject(["webServer"], (webCtx) => { const webServer = webCtx.reflect.get("webServer");
	//      webCtx.effect(() => webServer.register({ kind, path, handler }), "…") })`
	//   · <profile>\node_modules\billion-context\dist\agent\dsh-native.js:134
	//     同一形状，另加「没有 ctx.inject 就退回 ctx.webServer」的兜底。
	// inject() 只在服务真的可用时才执行回调，所以「没有 webServer」= 回调不跑 = 没有端点。
	const usageRoute = { kind: 'exact', path: USAGE_ROUTE_PATH, handler: (req, res) => handleUsageRequest(req, res, cfg) };
	const mountUsageRoute = (holder) => {
		const mount = () => holder.register(usageRoute);
		if (typeof ctx?.effect === 'function') ctx.effect(mount, 'loop-guard: usage route');
		else mount();
	};
	try {
		if (typeof ctx?.inject === 'function') {
			ctx.inject(['webServer'], (webCtx) => {
				try {
					const webServer = webCtx?.webServer ?? webCtx?.reflect?.get?.('webServer');
					if (webServer === undefined || typeof webServer.register !== 'function') return;
					if (typeof webCtx?.effect === 'function') webCtx.effect(() => webServer.register(usageRoute), 'loop-guard: usage route');
					else mountUsageRoute(webServer);
				} catch (error) {
					log(ctx, 'warn', `用量端点注册失败（闸门不受影响）：${error instanceof Error ? error.message : String(error)}`);
				}
			});
		} else if (ctx?.webServer !== undefined && typeof ctx.webServer?.register === 'function') {
			mountUsageRoute(ctx.webServer);
		}
	} catch (error) {
		log(ctx, 'warn', `用量端点注册失败（闸门不受影响）：${error instanceof Error ? error.message : String(error)}`);
	}

	const cap = (value) => (Number.isFinite(value) ? human(value) : '不设限');
	log(
		ctx,
		'info',
		`已武装：本轮预算 ${human(cfg.maxTokens)} token（含该轮子代理），会话累计 ${cap(cfg.sessionMaxTokens)}，家族累计 ${cap(cfg.familyMaxTokens)}；` +
			`扇出上限 ${cfg.maxFanout} 个，workflow 内 ${cfg.maxWorkflowAgents} 个子代理，` +
			`子代理请求 ${cfg.maxSubagentRequests} 次 / 工具 ${cfg.maxSubagentTools} 次，` +
			`横向异常 ${cfg.outlierRatio} 倍（至少 ${cfg.outlierMinSiblings} 个兄弟），熔断 ${cfg.maxBatchFailures} 次；` +
			`同签名超 ${cfg.repeatLimit} 次拦、read 超 ${cfg.readRepeatLimit} 次拦、同骨架超 ${cfg.skeletonLimit} 次拦、` +
			`同错误超 ${cfg.sameErrorLimit} 次拦、乒乓循环 ${cfg.cycleLimit} 轮拦；` +
			`重复类拦 ${cfg.maxDenials} 次后放行一次、配额类（请求/工具/扇出/workflow/熔断）只豁免一次；` +
			`软着陆 ${cfg.softLanding ? '开' : '关'}，跨重启记账 ${cfg.persist ? '开' : '关'}，` +
			`诊断日志 ${cfg.log ? cfg.logFile : '关'}` +
			(pendingLoadNote === '' ? '' : `；已从磁盘恢复 ${pendingLoadNote}`)
	);
}
