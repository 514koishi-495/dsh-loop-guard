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
 *    自己烧满 6000 万、再让 8 个子代理各烧 6000 万。
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
 *   DSH_LOOP_GUARD_MAX_TOKENS           单次问答 token 上限（含该轮子代理），默认 60000000（6000 万）；0/负数 = 不设限
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
 *   DSH_LOOP_GUARD_VETO_NEW_TURN=1      会话预算到线后拒绝开新的一轮问答（默认**不**否决：宿主返回的 reject 是空决定，带不了任何解释，闷住用户没有意义）
 *   DSH_LOOP_GUARD_PURE_TALK_TOKENS     同一轮里一次非白名单工具调用都没有、却累计吐了这么多输出 token 才算「纯输出烧钱」，默认 200000；0/负数 = 关掉这道门
 *   DSH_LOOP_GUARD_PURE_TALK_GUARD=0    只关掉纯输出门的动作（停止生成 + 提醒交账），计数与统计照旧（默认开）
 *   DSH_LOOP_GUARD_SAME_ERROR_UNKNOWN_LIMIT 同错误门认不出报错工具名（只能全局拦）时，连续拦几次后受限降级，默认 3；0 = 从不降级
 *   DSH_LOOP_GUARD_STATE_FILE           记账存档路径（默认 ~/.dsh/loop-guard-state.<profile>.json；显式设置时完全不迁移）
 *   DSH_LOOP_GUARD_PERSIST=0            不把计数写进磁盘，也不写诊断日志（默认都写）
 *   DSH_LOOP_GUARD_LOG_FILE             诊断日志路径，默认 ~/.dsh/loop-guard.log
 *   DSH_LOOP_GUARD_SOFT_LANDING=1       到线后只拦探索工具，放过收尾工具
 *   DSH_LOOP_GUARD_COST=0               不再估算本会话消耗金额：端点里不带 cost 键，也不读价目表（默认 1 = 估）
 *   DSH_LOOP_GUARD_PRICE_TABLE          JSON 覆盖内置价目表（形状见 readPriceTable）；解析失败 warn 一声后退回内置表
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
import { createGuardFeatures, GUARD_HUB, handleFeatureRequest } from './daily-features.js';

export const name = 'loop-guard';

/** 不需要注入任何服务：只用 ctx.on / ctx.logger。 */
export const inject = [];

/**
 * 单轮（一个 turn）硬顶：6000 万计费输入 —— 含这一轮生出来的所有子代理。
 *
 * 这个数不是随手定的：常驻纪律 `~/.dsh/harness/harness_state.json` 里那条
 * 「60M 天花板（L5）」就是 6000 万，而且那条自己记着「用户明确要求把硬顶从 1000 万改为
 * 6000 万 token」。插件这边停在 1 亿，等于同一条纪律有两个说法；这次让它跟纪律对齐。
 *
 * DSH_LOOP_GUARD_MAX_TOKENS 显式给了就以它为准（pickLimit 里的覆盖优先级不变）；
 * 设 0 或负数 = 不设限。
 */
const DEFAULT_MAX_TOKENS = 60_000_000;
const DEFAULT_SESSION_MAX_TOKENS = 1_000_000_000;
/**
 * 纯输出门（E1）的默认阈值：同一轮里**一次非白名单工具调用都没有**、却累计吐了这么多
 * 输出 token。取到病态量级（20 万）是刻意的 —— 正常一轮的输出量级是几千到几万，
 * 所以这道门开着也碰不到，只有「一整轮全在说话、什么都不交账」才可能触顶。
 * 0 / 负数 = 关掉这道门（走 pickThreshold 的语义）。
 */
const DEFAULT_PURE_TALK_TOKENS = 200_000;
/** B2：同错误门「认不出报错工具名」这一分支连续拦几次后受限降级。0 = 从不降级。 */
const DEFAULT_SAME_ERROR_UNKNOWN_LIMIT = 3;
/** G6 每会话保留多少条「已结束轮次」的计费输入，用来自比中位数。 */
const TURN_HISTORY = 8;
/** E2「这道门是不是第一次拒绝」的记录上限（只影响文案长短，满了 FIFO 淘汰）。 */
const DENY_SEEN_CAP = 200;


/** 会话/签名类 Map 的容量上限，防止长会话把内存吃掉。 */
const SIGNATURE_CAP = 400;
const ERROR_CAP = 40;
/** callId → 工具名 映射的容量上限。 */
const CALLNAME_CAP = 400;
/** 退休会话 id 的容量上限（用来防止重复上卷）。 */
const RETIRED_CAP = 2000;
/** 已注销账本表（disposed）的容量上限，满了两样都按 FIFO 淘汰最旧的一条。 */
const DISPOSED_CAP = 200;
/**
 * 存档格式版本。v2 新增三样东西（loadState 对 0 / 1 / 2 一律尽力迁移，缺字段用安全默认值）：
 *   · turnInput / familyTurnInput —— 本轮（含该轮子代理）的账也落盘（A1）；
 *   · retired —— 已退休会话 id 名单（H1，不落盘会让退休过的会话复活时重放历史）；
 *   · stats —— 只读聚合统计（E5，**绝不参与任何门控判定**）。
 */
const STATE_VERSION = 2;
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

/**
 * 本会话消耗金额的估算价目表（人民币 / 百万 token）。
 *
 * 数字抄自本机 `@linxin666/dsh-usage` 的 `src/core/pricing.ts:60-70`（FLASH_PRICE / PRO_PRICE），
 * 与该插件引的官方定价页同源。每项两列 = [平价, 峰价]。
 *
 * **这是估算，不是账单**：本机不存在按会话的真账单（宿主只给账号级余额与 token 级用量），
 * 所以只能按 token × 本地价目表推。已知偏差写在这里，别当成精确值用：
 *   · 峰窗口 = 北京时间周一至周五 09:00-12:00 与 14:00-18:00，其余时刻按平价；
 *   · **不处理节假日** —— 节假日按平价算，估算会偏高（官方在节假日不按峰价收）。
 *   · v4-pro 的 PRO 行只适用到 2026-09-14T04:00:00Z（北京时间 2026-09-14 12:00），之后并入 FLASH ——
 *     见 PRO_FOLDED_INTO_FLASH_AT_MS。
 * 用 DSH_LOOP_GUARD_PRICE_TABLE 传一段 JSON 可整体覆盖（形状见 readPriceTable）。
 */
const PRICE_TABLE_BUILTIN = {
	default: { cacheHit: [0.02, 0.04], inputMiss: [1.0, 2.0], output: [4.0, 8.0] },
	pro: { cacheHit: [0.15, 0.3], inputMiss: [4.5, 9.0], output: [13.5, 27.0] }
};
/** 价目表对应的时刻。改上面的表或换覆盖表时要一起改这里。 */
const PRICES_AS_OF = '2026-10';
/**
 * v4-pro 并入 flash 计价的分界时刻（UTC）：2026-09-14T04:00:00Z = 北京时间 2026-09-14 12:00。
 *
 * 抄自同一来源 `@linxin666/dsh-usage` 的 `src/core/pricing.ts`（常量 V4_PRO_FOLDED_INTO_FLASH_AT_MS），
 * 那一行的判据是 `model.includes('v4-pro') && atMs < 该常量`：**该时刻起 v4-pro 不再走 PRO 行**。
 * 今天（2026-10）已在该时刻之后，所以 v4-pro 会话一律按 FLASH 行估。
 */
const PRO_FOLDED_INTO_FLASH_AT_MS = Date.UTC(2026, 8, 14, 4, 0);

/** 峰窗口（北京时间当天第几分钟起，到第几分钟止，左闭右开）；与官方公布的两段一致。 */
const PEAK_WINDOWS = [
	[9 * 60, 12 * 60],
	[14 * 60, 18 * 60]
];
/** 北京常年 UTC+8（没有夏令时），固定偏移就是精确的。 */
const BEIJING_OFFSET_MINUTES = 8 * 60;

/**
 * 一行价目表：cacheHit / inputMiss / output 三项，每项 [平价, 峰价]。
 * 任何一处不是「两个有限非负数」就返回 undefined（调用方据此整体退回内置表）。
 */
function normalizePriceRow(row) {
	if (row === null || typeof row !== 'object') return undefined;
	const pair = (value) => {
		if (!Array.isArray(value) || value.length !== 2) return undefined;
		const off = Number(value[0]);
		const peak = Number(value[1]);
		if (!Number.isFinite(off) || off < 0 || !Number.isFinite(peak) || peak < 0) return undefined;
		return [off, peak];
	};
	const cacheHit = pair(row.cacheHit);
	const inputMiss = pair(row.inputMiss);
	const output = pair(row.output);
	if (cacheHit === undefined || inputMiss === undefined || output === undefined) return undefined;
	return { cacheHit, inputMiss, output };
}

/** 覆盖表的形状：`{ default: <行>, pro: <行> }`。两行都必填 —— 缺一行就整体退回内置表。 */
function normalizePriceTable(parsed) {
	if (parsed === null || typeof parsed !== 'object') return undefined;
	const offPeak = normalizePriceRow(parsed.default);
	const pro = normalizePriceRow(parsed.pro);
	if (offPeak === undefined || pro === undefined) return undefined;
	return { default: offPeak, pro };
}

/**
 * 取生效的价目表：DSH_LOOP_GUARD_PRICE_TABLE 是一段 JSON（形状见 normalizePriceTable）。
 * 解析不了 / 形状不对就 **warn 一声退回内置表** —— 估价这件事既不能让插件加载失败，
 * 也不能静默用错表（宁可报一条日志，也不要给一个没人知道的假数字）。
 */
function readPriceTable(ctx) {
	const raw = process.env.DSH_LOOP_GUARD_PRICE_TABLE;
	if (typeof raw !== 'string' || raw.trim() === '') return PRICE_TABLE_BUILTIN;
	try {
		// raw 来自环境变量（不是磁盘），照同样口径抹一遍 BOM —— 见 stripBom 的注释。
		const table = normalizePriceTable(JSON.parse(stripBom(raw)));
		if (table === undefined) throw new Error('形状不对（要 {"default":{...},"pro":{...}}，每项都是 [平价, 峰价] 两个非负数）');
		return table;
	} catch (error) {
		log(ctx, 'warn', `DSH_LOOP_GUARD_PRICE_TABLE 解析失败，改用内置价目表（金额照常估算，只是价可能不对）：${error instanceof Error ? error.message : String(error)}`);
		return PRICE_TABLE_BUILTIN;
	}
}

/**
 * 这一笔样本按**到达时刻**选平价还是峰价列：返回 0（平价）或 1（峰价）。
 *
 * 用固定的 UTC+8 偏移换算北京时间 —— 北京没有夏令时，这样换是精确的；
 * 周末（周六/周日）整天平价。
 */
function priceColumnAt(epochMs) {
	const beijing = new Date(epochMs + BEIJING_OFFSET_MINUTES * 60_000);
	const weekday = beijing.getUTCDay();
	if (weekday === 0 || weekday === 6) return 0;
	const minuteOfDay = beijing.getUTCHours() * 60 + beijing.getUTCMinutes();
	for (const [from, to] of PEAK_WINDOWS) {
		if (minuteOfDay >= from && minuteOfDay < to) return 1;
	}
	return 0;
}

/**
 * 一笔 usage 样本的估算金额（元）。
 *
 * 口径（与计费输入端一致）：`inputTokens` 单独只是「未命中缓存」的那一份，
 *   cacheRead × cacheHit + (input + cacheWrite) × inputMiss + output × output
 * 价目表行按模型名**与时刻**选：名字里含 pro（不区分大小写）**且早于 PRO_FOLDED_INTO_FLASH_AT_MS**
 * 才用 PRO 表（2026-09-14T04:00:00Z 起 v4-pro 并入 flash 计价），否则（含未知/空）用 FLASH 表。
 */
function costOfSample(usage, epochMs, model) {
	const proPriced = epochMs < PRO_FOLDED_INTO_FLASH_AT_MS;
	const row = proPriced && /pro/i.test(typeof model === 'string' ? model : '') ? priceTable.pro : priceTable.default;
	const column = priceColumnAt(epochMs);
	const price = (pair) => pair[column];
	const cacheRead = numberOr0(usage.cacheReadTokens);
	const uncached = numberOr0(usage.inputTokens) + numberOr0(usage.cacheWriteTokens);
	const output = numberOr0(usage.outputTokens);
	return (cacheRead * price(row.cacheHit) + uncached * price(row.inputMiss) + output * price(row.output)) / 1_000_000;
}

/**
 * 估算金额对外只报 4 位小数：元级别不需要更多位，也顺手抹掉浮点噪声
 * （1e6 cacheRead + 1e6 input + 1e6 output 的平价结果就是干净的 5.02）。
 */
function roundCny(value) {
	return Math.round(numberOr0(value) * 10_000) / 10_000;
}

/**
 * 把一笔 usage 样本的估价拆分累加进账本 —— charge() 与旧账补算（seedLegacyCost）共用同一段算术。
 *
 * 三次累加的顺序与 charge 里原来的内联代码**逐字同序**（cacheRead → uncached → 金额）：
 *   cacheReadTokens → cacheReadInput；inputTokens + cacheWriteTokens → uncachedInput；
 *   costEnabled 时 costCny += costOfSample(usage, epochMs, ledger.lastModel)。
 *
 * **只动这三个金额字段**：totalInput / output 的累加、requests / lastSeen 的记账、
 * chargeAncestors 上卷全都留在 charge 里 —— 旧账补算绝不能把已经算过的 token 再算一遍。
 */
function accrueCost(ledger, usage, epochMs) {
	ledger.cacheReadInput += numberOr0(usage.cacheReadTokens);
	ledger.uncachedInput += numberOr0(usage.inputTokens) + numberOr0(usage.cacheWriteTokens);
	// 每一笔样本按**它自己的到达时刻**选平价/峰价列，不是整天一个价。
	if (costEnabled) ledger.costCny += costOfSample(usage, epochMs, ledger.lastModel);
}

/**
 * 记下这一轮用的是哪个模型（估价的价目表行靠它选）。两个来源（已核实的形状）：
 *   · request/header  → data.header.config.{provider,model}
 *   · request/context → data.{provider,model}
 *
 * **只存裸模型名**（原样，不去大小写、不加 provider 前缀）：契约与端点 payload 的
 * `cost.model`、以及「名字里含 pro 走 PRO 表」都是按这个字符串判的。
 * provider 只在模型名缺失时兜底；两个都空就**不动**上一次的值 ——
 * 宁可留着上一次，也不要被空载荷擦成空。
 */
function noteRoute(ledger, source) {
	if (source === null || typeof source !== 'object') return;
	const provider = typeof source.provider === 'string' ? source.provider.trim() : '';
	const model = typeof source.model === 'string' ? source.model.trim() : '';
	const label = model !== '' ? model : provider;
	if (label === '') return;
	ledger.lastModel = label;
}

/**
 * 旧账补算：**本版装载之前**就已经在记账的会话，存档里没有金额拆分
 * （cacheReadInput / uncachedInput / costCny 全是 0，实测 session-751ec6e6 的
 * totalInput 是 77,652,325 而这三个字段全 0），徽标于是显示「会话 16.2M · 消耗 ¥0.00」。
 * 这里拿宿主留在快照里的历史事件，把这笔旧账的真实拆分补算回来。
 *
 * 遍历顺序与 session/created 的完整重放**逐条同序**（request/header → noteRoute、
 * request/context → noteRoute、usage → accrueCost），因为估价要按「这笔样本到达之前
 * 最后一次请求认到的模型名」选价目表行 —— 顺序错了金额就不对。
 *
 * **只写这四个字段**：cacheReadInput / uncachedInput / costCny / lastModel。
 * totalInput、familyInput、requests、modelCalls、toolCalls、turn、turnInput、
 * familyTurnInput、childFailures 一个都不碰，也**不做** chargeAncestors 上卷 ——
 * 重放历史再次累加 token 或再上卷一次，就是把已经算过的账算第二遍（双重计费）。
 *
 * 幂等靠调用方那道门（拆分不再为 0 就不再进来）；历史里没有 usage 事件时
 * （空快照）它只是一次无害空操作。usage 字段缺失一律按 0 处理 —— 缓存字段缺失时
 * uncachedInput 就是 inputTokens + cacheWriteTokens，这是诚实的退路而不是猜一个拆分。
 */
function seedLegacyCost(ledger, events) {
	for (const event of events ?? []) {
		if (event?.type === 'request/header') noteRoute(ledger, event?.data?.header?.config);
		else if (event?.type === 'request/context') noteRoute(ledger, event?.data);
		const usage = usageOfEvent(event);
		if (usage !== undefined) accrueCost(ledger, usage, Date.now());
	}
}

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
		pureTalkTokens: z.number().default(DEFAULT_PURE_TALK_TOKENS).description('同一轮里一次非白名单工具调用都没有、却累计吐了这么多输出 token，才算「纯输出烧钱」；默认 200000（病态量级，正常用碰不到），0 / 负数 = 关掉这道门'),
		pureTalkGuard: z.number().default(1).description('纯输出门命中后是否动作：停止生成 + 提醒交账（1 = 开，0 = 关；关掉只是不再拦，计数与统计照旧）'),
		sameErrorUnknownLimit: z.number().default(DEFAULT_SAME_ERROR_UNKNOWN_LIMIT).description('同错误门认不出报错工具名（只能全局拦）时，连续拦几次后受限降级为不再拦这一种分支；默认 3，0 = 从不降级'),
		vetoNewTurn: z.number().default(0).description('会话预算到线后，拒绝开新的一轮问答（1 = 开，0 = 关；默认关，见 README 的说明）'),
		softLanding: z.number().default(0).description('到线后只拦探索工具、放过收尾工具（1 = 开）'),
		strictBudget: z.number().default(0).description('预算到线后持续拦截工作工具，不使用周期逃生放行；收尾白名单仍可用（1 = 开，默认保持原行为）'),
		dailyMaxTokens: z.number().default(0).description('每日跨会话计费输入上限，含子代理各自的实际用量；0 = 不设限，可在用量详情中设置'),
		persist: z.number().default(1).description('把计数写进磁盘，重启后接着算（1 = 开，0 = 关）'),
		log: z.number().default(1).description('把守卫的诊断日志（逃生门放行 / 预算门到线 / 盲区自检 / FIFO 淘汰）写进日志文件（1 = 开，0 = 关）'),
		logFile: z.string().default('').description('诊断日志路径；留空 = ~/.dsh/loop-guard.log'),
		cost: z.number().default(1).description('估算本会话消耗金额并显示在会话头徽标里（1 = 估，0 = 不算也不报）；价目表可用 DSH_LOOP_GUARD_PRICE_TABLE 覆盖'),
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
		/** 本轮（含该轮子代理）上限。默认 6000 万（单轮硬顶，与常驻纪律的 60M 天花板对齐）；设 0 或负数 = 不设限，与下面两个上限同义。 */
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
		/** 纯输出门（E1a）：阈值走 pickThreshold —— 0 / 负数 = 关掉这道门。 */
		pureTalkTokens: pickThreshold('DSH_LOOP_GUARD_PURE_TALK_TOKENS', c.pureTalkTokens, DEFAULT_PURE_TALK_TOKENS),
		/** 纯输出门命中后的动作开关（E1b/E1c）。关掉只是不再拦，计数与统计照旧。 */
		pureTalkGuard: pickNumber('DSH_LOOP_GUARD_PURE_TALK_GUARD', c.pureTalkGuard, 1) !== 0,
		/** 同错误门「认不出工具名」分支的受限降级阈值（B2）；Infinity = 从不降级。 */
		sameErrorUnknownLimit: pickThreshold('DSH_LOOP_GUARD_SAME_ERROR_UNKNOWN_LIMIT', c.sameErrorUnknownLimit, DEFAULT_SAME_ERROR_UNKNOWN_LIMIT),
		vetoNewTurn: pickNumber('DSH_LOOP_GUARD_VETO_NEW_TURN', c.vetoNewTurn, 0) !== 0,
		softLanding: pickNumber('DSH_LOOP_GUARD_SOFT_LANDING', c.softLanding, 0) !== 0,
		strictBudget: pickNumber('DSH_LOOP_GUARD_STRICT_BUDGET', c.strictBudget, 0) !== 0,
		dailyMaxTokens: pickNumber('DSH_LOOP_GUARD_DAILY_MAX_TOKENS', c.dailyMaxTokens, 0),
		persist: process.env.DSH_LOOP_GUARD_NO_PERSIST !== '1' && pickNumber('DSH_LOOP_GUARD_PERSIST', c.persist, 1) !== 0,
		/** 诊断日志：路径可由 DSH_LOOP_GUARD_LOG_FILE 覆盖，DSH_LOOP_GUARD_LOG=0 整体关掉。 */
		logFile: pickString('DSH_LOOP_GUARD_LOG_FILE', c.logFile, LOG_DEFAULT_FILE),
		log: process.env.DSH_LOOP_GUARD_LOG !== '0' && pickNumber('DSH_LOOP_GUARD_LOG', c.log, 1) !== 0,
		/** 本会话消耗金额估算（价目表与口径见 PRICE_TABLE_BUILTIN / readPriceTable）。0 = 不算也不报。 */
		cost: pickNumber('DSH_LOOP_GUARD_COST', c.cost, 1) !== 0,
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

// C0 控制字符里只留 `\n` `\t`（换行和缩进是有意义的排版），其余连 DEL 一起换掉。
const LOG_UNSAFE_RE = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

/**
 * 落盘前的日志安全化：把不可见控制字符换成 `·`。
 * 选「替换」而不是「删除」：① 留下「这里原本有个不可见字符」的现场证据，
 * 否则错误正文被悄悄缩短，排查时反而看不出截断从哪来；② 长度大致不变，
 * 日志里的偏移量还对得上。
 * 动因（真实事故）：内部错误指纹用 U+0000 分隔「工具名 / 错误正文」，
 * 原样落盘后整份诊断日志被 grep / tail 判成二进制文件，从此读不出来。
 */
function logSafe(text) {
	return String(text).replace(LOG_UNSAFE_RE, '·');
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
		fs.appendFileSync(logPath, `[${new Date().toISOString()}] [${level}] ${logSafe(text)}\n`, 'utf8');
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
	// 千万量级及以上写成整数「万」：默认硬顶 60_000_000 要读作「6000 万」，不是「6000.0 万」。
	// 不把「亿」的门槛降到 6000 万 —— 中文里这个量级说的就是「六千万」，「0.60 亿」更难读。
	if (n >= 10_000_000) return `${Math.round(n / 10_000)} 万`;
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
	// 表满时按插入顺序淘汰**该前缀下**最旧的一条 —— 但绝不淘汰本次正要返回的那条。
	//
	// P0-2：以前取的是「第一条以 prefix 开头的键」，而它可能正是本次要返回的 key 本身
	// （被反复拦的那个签名必然最老）：删完再累加，本次计数从 1 重新起算 ——
	// 连拦计数一被清零，就白送一次放行。候选只剩本次这条时**不淘汰**：
	// 宁可让表继续涨，也不能多放行一次（表本身的上限由 escapeKeyFor 的调用点与
	// 签名表 SIGNATURE_CAP 一起兜着；被拦的签名总数远小于它）。
	const keys = Object.keys(ledger.escape);
	if (keys.length > ESCAPE_CAP) {
		for (const old of keys) {
			if (old === key) continue;
			if (!old.startsWith(prefix)) continue;
			delete ledger.escape[old];
			// 文案口径：淘汰的是**别的**签名，重新起算的是**它**的计数（对它更宽）；
			// 本次要用的这条计数一个字节都没动。
			fileLog('info', `逃生计数表已满（${ESCAPE_CAP}），淘汰该前缀下最旧的一条 ${old} —— 该签名重新计数（只会更严，不会锁死）；本次要用的 ${key} 不受影响`);
			break;
		}
	}
	return key;
}

/**
 * 记一次「**确实要执行**」的工具调用。两个计数分工不同，别混：
 *
 *   · `toolCalls` = **已执行**工具调用总数。口径是「真的跑了」而不是「真的干过活」，
 *     所以**含交账白名单**（update_goal / todo_write / job_kill / get_goal /
 *     ask_user_question / acp_status …）。消费者：④ 子代理工具配额、收尾摘要/徽标展示、
 *     盲区自检（「跑了 20 次工具却没有一个带 turn 的 usage 样本」）。
 *     以前白名单工具被那一行直接 return 掉、一次都不计，徽标与盲区自检因此偏小 —— 本版修正。
 *   · `turnToolCalls` = **本轮真的干过活**（非白名单工具已执行）的次数。现在是**统计/展示口径**，
 *     不再参与任何判定：E1a 纯输出门已改成看 `turnOutputAtLastTool`（见下）。
 *     所以白名单那一行**故意**不传 `worked` —— 交账工具是「这一轮该怎么收尾」，不是「这一轮在干活」；
 *     把它算进来，展示口径就分不出「真的干活」与「只是收尾」了。
 *   · `turnOutputAtLastTool` = **本轮最后一次干活时**的 `turnOutput` 水位（游标）。只服务一道门：
 *     ⓪ E1a 纯输出门（`pureTalkHit`：`turnOutput - turnOutputAtLastTool` 到量）。
 *     由 `countExecutedTool(ledger, worked = true)` **在 `worked === true` 时**推到当前
 *     `ledger.turnOutput`；白名单那一行传 `worked = false`，**不动**游标（收尾动作不是干活）。
 *
 * P1-1（第二轮）：口径回到 1.1.6 的「**执行了**才记一次」，并且**改成按放行出口记账**。
 * 第一轮把入口那个记账点放在了判定中途（⓪ 纯输出门之后、⑤⑥ 出生闸门与 ⑧⑨⑩⑪ 之前），
 * 于是**被那些门拦下、根本没有执行**的调用也被记了进去，三条后果：
 *   ① ④ 子代理工具配额读 `ledger.toolCalls`，被拦下的尝试会把配额提前吃满，
 *      连一次性豁免都会花在没执行过的调用上；
 *   ② 徽标与收尾摘要把没执行的调用算成工具调用；
 *   ③ 一次被拦的调用会把 E1a 纯输出门（旧口径要求 `turnToolCalls === 0`）在这一轮里整轮关掉。
 * 现在：**每一个「这次调用确实要执行」的出口恰好记一次**，所有 deny 出口一律不记账。
 * 计数的写入只在 `countExecutedTool` 一处；它的文本调用点一共三处 —— `allowExecuted` 内、
 * 白名单那一行、以及末尾的回落放行（那一条用「先记再 return」的内联等价形式，理由见下）。
 * 按语义分两类，绝不在同一次调用上各写一遍（同一次 +2 更难查）：
 *
 *   ① 非白名单放行 —— 共四条放行出口，全部经 `allowExecuted(ledger)`（或与之等价的
 *      「先 countExecutedTool 再 return」，见下面回落放行那一条的注释）：
 *      回落放行（judgeGates 末尾）、⑨ 乒乓门消费豁免、⑩ 同骨架门逃生放行（落到末尾那一条）、
 *      ⑪ 同签名门消费豁免 / 逃生门放行。**两个计数都 +1**（非白名单放行 = 真的干活）。
 *   ② 白名单那一行（`if (toolName === '') return undefined; / if (NEVER_BLOCK.has(toolName))`）：
 *      NEVER_BLOCK 里的工具走的是它自己那条出口，走不到 ①，而它们**真的会执行**，
 *      所以在返回前单独记一次 —— `countExecutedTool(ledger, false)`：只记 `toolCalls`。
 *
 * 为什么记账点落在「放行出口」上是等价的、也不会漏账：
 *   · 出口一定在 ⓪ 之后：被 ⓪ 纯输出门拦下的调用走不到任何出口，所以一次都不记 ——
 *     这正是 E1a（`pureTalkHit` 看「距上一次真的执行过工具调用以来吐了多少」）要的语义：
 *     只有**真的执行过**的非白名单调用才把游标推到当前水位，从而重新起算这一轮；
 *     先记会让它命中后只剩第一击有效
 *     （test/smoke.mjs 的 E1 用例钉住了这一点）；
 *   · 出口同时也在 ④ 子代理配额之后，这是对的：④ 读 `ledger.toolCalls` 时读到的是
 *     「**到现在为止真的执行过**」的次数，被 ④/⑤/⑥/⑧/⑨/⑩/⑪ 拦下的尝试不吃配额、
 *     也不花一次性豁免 —— 上面那三条后果的根因就在这儿；
 *   · `toolName === ''`（非工具步骤）走的是 `if (toolName === '')` 那条 early return，
 *     落不到任何出口，两个计数都不加 —— 它压根不是工具调用。
 */
function countExecutedTool(ledger, worked = true) {
	ledger.toolCalls += 1;
	// worked=false 只出现在交账白名单那一行：记配额账与展示账，但不算「本轮干过活」，
	// 也**不动** E1a 的水位游标。
	if (worked) {
		ledger.turnToolCalls += 1;
		ledger.turnOutputAtLastTool = ledger.turnOutput;
	}
}

/** 放行出口专用：记一次已执行的工具调用，然后返回「放行」。 */
function allowExecuted(ledger) {
	countExecutedTool(ledger);
	return undefined;
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
/**
 * 已注销账本的计数快照：session id → 扁平对象（FIFO，上限 DISPOSED_CAP）。
 *
 * 为什么要有这张表：宿主崩溃 / 重启会把**在跑的会话逐个** session/disposed。以前这里是
 * 「ledgers.delete(id) → retired.add(id) → writeState()」，于是这些会话的计数从存档里
 * 消失；重启后同一个 id 复活时又被 retired 那道守卫挡住、不许重放，新账本只能从 0
 * 重新数（真机实测：本会话累计 2485.7 万 token，重启后存档里只剩 260 万 / 13 次请求）。
 *
 * 现在把快照留在这里并落盘，同一个 id 复活时**直接接着算**：不重放历史、也不给祖先
 * 重复上卷（上卷早在 charge 时就做过了，见 chargeAncestors）。字段是扁平的固定形状，
 * 与 retire 之前的账本一一对应（见 disposedSnapshot）。
 */
const disposed = new Map();

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

/**
 * E5/E6：跨重启的只读聚合统计（存档里的 `stats` 段）。
 *
 * **绝不参与任何门控判定** —— 它只是观察值，用来让人看见守卫一共拦了多少、放行了多少。
 * E6 的纪律同样落在这里：阈值不因这些观测值自动收紧或放宽，只做只读观察。
 */
const stateStats = { sessions: 0, denied: 0, released: 0, exempted: 0, updatedAt: '' };
/** loadState 正在按存档重建账本 —— 那不算「这个会话出现过」，别把 sessions 计数灌水。 */
let inLoadState = false;

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
			/**
			 * 估价的输入原始拆分：缓存命中 / 未命中（未命中含缓存写）。
			 * **纯增量：不参与任何门控判定**，只是 charge 时顺手累加、端点里报出去。
			 */
			cacheReadInput: 0,
			uncachedInput: 0,
			/** 本会话累计的**估算**金额（元）。不是账单，见 PRICE_TABLE_BUILTIN。 */
			costCny: 0,
			/** 最近一次认到的模型名（原样，来自 request 事件）；空串 = 还不知道。 */
			lastModel: '',
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
			turnWarned: false,
			/** E2：哪些门已经给过完整拒绝文案（key 是门名 / 门名+轮次 / 门名+签名散列）。 */
			denySeen: {},
			/** E4 交账统计：被拦 / 逃生门放行 / 配额豁免。 */
			gateStats: { denied: 0, released: 0, exempted: 0 },
			/** E1a 纯输出门：本轮累计的 output token（按 charge 的换轮逻辑清零）。 */
			turnOutput: 0,
			/** E1a 纯输出门：本轮**非白名单**工具调用次数（展示/统计口径，已不参与判定）。 */
			turnToolCalls: 0,
			/**
			 * E1a 纯输出门的**水位游标**：本轮最后一次「真的执行过」非白名单工具调用时的 `turnOutput`。
			 * 判据是「距那一次以来又吐了多少」，所以它由 `countExecutedTool(ledger, worked = true)` 推进。
			 * **刻意不进 parked 快照**（见 `disposedSnapshot`）：复活或重启后从 0 起算，
			 * 等价于「这一轮还没干过活」—— 只会更严，不会放松。
			 */
			turnOutputAtLastTool: 0,
			/** 纯输出门这一轮是否已经吼过（reject 是空决定，日志是唯一痕迹）。 */
			pureTalkWarnedTurn: undefined,
			/** B2：同错误门「认不出报错工具名」分支的连续拦次数 + 是否已受限降级（内存态，不落盘）。 */
			unknownToolDenials: 0,
			unknownToolDegraded: false,
			/** G6：最近 TURN_HISTORY 个已结束轮次的计费输入（内存态，不落盘，只用来自己跟自己比）。 */
			recentTurns: [],
			/** G6 每轮只吼一次。 */
			selfWarnTurn: undefined
		};
		ledgers.set(sessionId, ledger);
		// E5：这里才是「这个会话出现过」—— 从存档重建账本时不算（见 inLoadState）。
		if (!inLoadState) stateStats.sessions += 1;
	}
	return ledger;
}

// ────────────────────────── 计数持久化（重启接着算） ──────────────────────────

/**
 * 插件和 DSH 宿主同生共死，一重启账本就清零 —— 而「一次问答」很容易跨一次重启。
 * 所以把累计计数落一份盘。只存数字，不存任何对话内容。
 *
 * 路径分三层（A2）：
 *   ① `DSH_LOOP_GUARD_STATE_FILE` 最高优先（测试靠它隔离），此时**不迁移、不改名**；
 *   ② 默认路径按 profile 分片 `loop-guard-state.<profile>.json` —— 多 profile / 多实例
 *      同时开的时候，以前共用一份存档会互相整体覆盖（谁最后写谁赢）；
 *   ③ profile 认不出来就退回老的单文件名，**不瞎猜**一个名字出来。
 */
const LEGACY_STATE_FILE = path.join(os.homedir(), '.dsh', 'loop-guard-state.json');

/**
 * 从环境变量或模块自身路径里认出 profile 名。
 *
 * 两条路都要（已核实：本机 `DSH_PROFILE=desktop`、`DSH_PROFILE_DIR=~/.dsh/profiles/desktop`）：
 *   · `DSH_PROFILE` —— 宿主注入的最直接线索；
 *   · `import.meta.url` —— 装进 profile 后模块就在
 *     `<profile>/node_modules/dsh-loop-guard/lib/index.js`，路径里天然带 profile 名。
 * 两条都拿不到 → 返回 '' → 保持老的单文件名行为，绝不猜。
 */
function detectProfile() {
	const fromEnv = typeof process.env.DSH_PROFILE === 'string' ? process.env.DSH_PROFILE.trim() : '';
	if (/^[A-Za-z0-9._-]{1,64}$/.test(fromEnv)) return fromEnv;
	try {
		const match = /[\\/]profiles[\\/]([^\\/]+?)[\\/]node_modules[\\/]dsh-loop-guard[\\/]/i.exec(import.meta.url);
		let name = match?.[1] ?? '';
		try {
			name = decodeURIComponent(name);
		} catch {
			/* 解不开就用原样 */
		}
		if (/^[A-Za-z0-9._-]{1,64}$/.test(name)) return name;
	} catch {
		/* 认不出就退回单文件名 */
	}
	return '';
}

const PROFILE_NAME = detectProfile();
/** 显式覆盖（测试 / 多实例隔离）：只要给了值就一律优先，且**完全不做迁移**。 */
const STATE_FILE_OVERRIDE =
	typeof process.env.DSH_LOOP_GUARD_STATE_FILE === 'string' && process.env.DSH_LOOP_GUARD_STATE_FILE !== ''
		? process.env.DSH_LOOP_GUARD_STATE_FILE
		: null;
const STATE_FILE =
	STATE_FILE_OVERRIDE ??
	(PROFILE_NAME === ''
		? LEGACY_STATE_FILE
		: path.join(path.dirname(LEGACY_STATE_FILE), `loop-guard-state.${PROFILE_NAME}.json`));
/**
 * 只有「走默认路径 + 认出了 profile」才迁移。
 *
 * 显式指定 `DSH_LOOP_GUARD_STATE_FILE` 时**绝不碰老文件** —— 存档被指到别处
 * （测试、隔离实例）根本不代表可以把用户的老存档改名搬走。这条以前漏了，
 * 结果是测试进程一 apply 就把真账本改成了 `.migrated`。
 */
const MIGRATE_FROM =
	STATE_FILE_OVERRIDE !== null || STATE_FILE === LEGACY_STATE_FILE ? null : LEGACY_STATE_FILE;
let cfgPersist = true;
let lastSaveAt = 0;
/**
 * 估价的两个模块级状态，apply() 里按 env / 设置面板定一次。
 *
 * 为什么不塞进 cfg：charge() 与 usagePayload() 都要用它，而 charge 那条路径
 * 拿到的 cfg 可能是 undefined（见 charge 里 `cfg !== undefined` 那处）——
 * 与 cfgPersist / logPath 同样的理由。
 */
let costEnabled = true;
let priceTable = PRICE_TABLE_BUILTIN;

/**
 * 老存档（单文件名）→ 新存档（按 profile 分片）的一次性迁移（A2）。
 *
 * 用「把旧文件改名成 `.migrated`」当原子锁：谁先改名成功谁就是迁移者，另一个进程
 * 的 rename 会因为源已消失而失败 —— 安静跳过，不需要任何锁文件。目标文件已存在
 * （别人先做完了）同样静默跳过。**任何异常都不许抛给宿主。**
 */
function migrateLegacyState(ctx) {
	if (!cfgPersist || MIGRATE_FROM === null) return;
	try {
		if (fs.existsSync(STATE_FILE) || !fs.existsSync(MIGRATE_FROM)) return;
		const raw = fs.readFileSync(MIGRATE_FROM, 'utf8');
		// 内容原样搬过去：版本 0 / 1 / 2 的字段迁移交给 loadState，这里不做任何解释。
		const tmp = `${STATE_FILE}.tmp`;
		fs.writeFileSync(tmp, raw, 'utf8');
		fs.renameSync(tmp, STATE_FILE);
		const done = `${MIGRATE_FROM}.migrated`;
		if (fs.existsSync(done)) {
			fileLog('info', `老存档已经在 ${done}，只把内容搬进 ${STATE_FILE}（旧文件保持原样）`);
			return;
		}
		try {
			fs.renameSync(MIGRATE_FROM, done);
			log(ctx, 'info', `记账存档按 profile 分片：已把 ${MIGRATE_FROM} 迁移到 ${STATE_FILE}，旧文件改名为 ${done}`);
		} catch {
			/* 另一个进程抢先改名了 —— 它就是迁移者，这里安静跳过 */
		}
	} catch (error) {
		log(ctx, 'warn', `老存档迁移失败（闸门不受影响，读取时会退回老路径）：${error instanceof Error ? error.message : String(error)}`);
	}
}

/**
 * 抹掉正文开头的 U+FEFF（BOM）。
 *
 * 为什么必须做：`JSON.parse` 不认 BOM —— 文件开头多一个看不见的字节就抛错，
 * 而读取侧几乎都是「catch 里当第一次跑」的形状（见 loadState 末尾那个空 catch），于是存档**静默**读不回来、
 * 计数归零、配置退回默认值。安全装置被一个不可见字节关掉，正是本项目最该防的那类事故
 * （Windows 上的记事本、某些编辑器 / 复制粘贴都会顺手写上 BOM）。
 *
 * 只动**读取**：写入侧照旧写不带 BOM 的 UTF-8（见 writeState 的 fs.writeFileSync）。
 */
function stripBom(text) {
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** 读存档正文：默认路径模式下新文件还没出现时，退回读老存档（**只读、不改名**）。
 *
 * 两条路径的正文都在这里过一遍 `stripBom` —— 这是存档读入的唯一入口，
 * 所以「带 BOM 的存档」不会漏到 `JSON.parse`（见 stripBom 的注释）。
 */
function readStateRaw() {
	try {
		return stripBom(fs.readFileSync(STATE_FILE, 'utf8'));
	} catch (error) {
		if (MIGRATE_FROM !== null && fs.existsSync(MIGRATE_FROM)) {
			fileLog('info', `新路径 ${STATE_FILE} 还没有存档，按老路径 ${MIGRATE_FROM} 读取（只读，不改名）`);
			return stripBom(fs.readFileSync(MIGRATE_FROM, 'utf8'));
		}
		throw error;
	}
}

/** 逃生计数表（ledger.escape）的拷贝：只认「字符串键 → 有限数字」，别的形状一律当没有。 */
function copyEscapeCounts(source) {
	const out = {};
	if (source === null || typeof source !== 'object') return out;
	for (const key of Object.keys(source)) {
		const value = source[key];
		if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
	}
	return out;
}

/** 一次性豁免记录（ledger.quotaExempted）的拷贝：只认「字符串键 → true」。 */
function copyQuotaExempted(source) {
	const out = {};
	if (source === null || typeof source !== 'object') return out;
	for (const key of Object.keys(source)) {
		if (source[key] === true) out[key] = true;
	}
	return out;
}

/**
 * 把一份账本（或存档里的一条 disposed 记录）读成**扁平固定形状**的快照。
 * 两个方向共用：session/disposed 存进去、loadState 读回来 —— 形状只写一次，
 * 免得两边字段清单漂移（漏一个字段就是「重启后这个计数归零」）。
 * 缺字段按 0 / '' 兜底：存档可能是手工改过的，或来自还没有某个字段的旧版。
 *
 * P0-1：光有计数不够 —— 门的「记忆」必须一起过桥，否则同一 id 注销/复活一次
 * 就能把每道配额门的一次性豁免再领一遍、连拦计数从零数
 * （与 README「首超那一次 warn + 放行一次，此后每次都拦」直接冲突）。
 * 所以下面四个字段跟着一起进出：
 *   · quotaExempted —— 配额类门的一次性豁免记录（缺字段 → {}，语义与今天完全一致）；
 *   · escape / escapeSig / escapeSigUsed —— 重复类门的连拦计数与「照原样再发一次」的豁免槽
 *     （缺字段 → 空表 / '' / false）。escape **全量**存：键数上限由 ESCAPE_CAP 兜着。
 */
function disposedSnapshot(source, disposedAt) {
	return {
		disposedAt: numberOr0(disposedAt),
		totalInput: numberOr0(source?.totalInput),
		familyInput: numberOr0(source?.familyInput),
		output: numberOr0(source?.output),
		requests: numberOr0(source?.requests),
		modelCalls: numberOr0(source?.modelCalls),
		toolCalls: numberOr0(source?.toolCalls),
		turn: numberOr0(source?.turn),
		turnInput: numberOr0(source?.turnInput),
		familyTurnInput: numberOr0(source?.familyTurnInput),
		cacheReadInput: numberOr0(source?.cacheReadInput),
		uncachedInput: numberOr0(source?.uncachedInput),
		costCny: numberOr0(source?.costCny),
		lastModel: typeof source?.lastModel === 'string' ? source.lastModel : '',
		// P0-1：门的记忆（详见上面的函数注释）。旧存档没有这四个字段 → 空表 / '' / false。
		quotaExempted: copyQuotaExempted(source?.quotaExempted),
		escape: copyEscapeCounts(source?.escape),
		escapeSig: typeof source?.escapeSig === 'string' ? source.escapeSig : '',
		escapeSigUsed: source?.escapeSigUsed === true
	};
}

function loadState(ctx) {
	try {
		const parsed = JSON.parse(stripBom(readStateRaw()));
		if (parsed === null || typeof parsed !== 'object') return;
		const sessions = parsed.sessions ?? {};
		// 版本不认识**不整份丢弃**：v0（连 version 字段都没有）/ v1 / v2 的已知字段含义都没变过，
		// 尽力迁移比「清零重来」安全得多 —— 丢掉的不是格式，是「这个会话已经花掉多少钱」这个事实。
		if (parsed.version !== STATE_VERSION) {
			log(ctx, 'warn', `计数存档版本 ${String(parsed.version)} 与当前 v${STATE_VERSION} 不一致，按已知字段尽力迁移（totalInput / familyInput / turnInput / turn / retired / stats），不再整份丢弃`);
		}
		let restored = 0;
		// 这段里 ledgerOf() 会建账本，但那不算「会话出现过」—— 用标志让 stats.sessions 不灌水。
		inLoadState = true;
		try {
			for (const id of Object.keys(sessions)) {
				const snap = sessions[id];
				if (snap === null || typeof snap !== 'object') continue;
				const ledger = ledgerOf(id);
				ledger.totalInput = numberOr0(snap.totalInput);
				ledger.familyInput = numberOr0(snap.familyInput);
				ledger.output = numberOr0(snap.output);
				// 1.1.7 增量四个字段：**不加版本号**（仍是 v2），缺省 0 / '' ——
				// 老存档读进来就是「还没估过」，重启后从这一刻接着累加。
				ledger.cacheReadInput = numberOr0(snap.cacheReadInput);
				ledger.uncachedInput = numberOr0(snap.uncachedInput);
				ledger.costCny = numberOr0(snap.costCny);
				ledger.lastModel = typeof snap.lastModel === 'string' ? snap.lastModel : '';
				ledger.requests = numberOr0(snap.requests);
				ledger.modelCalls = numberOr0(snap.modelCalls);
				ledger.toolCalls = numberOr0(snap.toolCalls);
				// A1：本轮（含该轮子代理）的账也恢复。turn 相同就是续账，换轮时由 charge 清零。
				ledger.turnInput = numberOr0(snap.turnInput);
				ledger.familyTurnInput = numberOr0(snap.familyTurnInput);
				ledger.turn = typeof snap.turn === 'number' ? snap.turn : undefined;
				restored += 1;
			}
		} finally {
			inLoadState = false;
		}
		// H1：退休会话 id 也落盘 —— 不落盘的话「先退休 → DSH 重启 → 同一 session id 复活」
		// 会让 session/created 的两道守卫同时失效，整段历史被重放、再上卷一次给祖先（凭空多扣钱）。
		if (Array.isArray(parsed.retired)) {
			for (const id of parsed.retired) {
				if (typeof id === 'string' && id !== '') retired.add(id);
			}
			while (retired.size > RETIRED_CAP) evictOldest(retired, '退休会话表');
		}
		// 已注销账本也落盘（纯加字段，版本号仍是 v2）：老存档没有 disposed 这个键，
		// 读进来就是空表 —— 行为与修复前完全一致，不会因为缺字段而炸。
		// **按数组顺序重建 Map**：顺序就是淘汰顺序，存成对象的话 JSON 键序不保证。
		if (Array.isArray(parsed.disposed)) {
			for (const item of parsed.disposed) {
				if (item === null || typeof item !== 'object') continue;
				const id = item.id;
				if (typeof id !== 'string' || id === '' || disposed.has(id)) continue;
				disposed.set(id, disposedSnapshot(item, item.disposedAt));
			}
			while (disposed.size > DISPOSED_CAP) evictOldest(disposed, '已注销账本表');
		}
		// E5：只读聚合统计。**绝不参与任何门控判定**（E6）。
		const stats = parsed.stats;
		if (stats !== null && typeof stats === 'object') {
			stateStats.sessions = numberOr0(stats.sessions);
			stateStats.denied = numberOr0(stats.denied);
			stateStats.released = numberOr0(stats.released);
			stateStats.exempted = numberOr0(stats.exempted);
			stateStats.updatedAt = typeof stats.updatedAt === 'string' ? stats.updatedAt : '';
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
				turn: ledger.turn,
				// A1：把「本轮」的账也写进去 —— 一次问答很容易跨一次重启，
				// 只落盘整数累计的话，重启后本轮预算从零起算（正是这道门要防的事）。
				turnInput: Math.round(ledger.turnInput),
				familyTurnInput: Math.round(ledger.familyTurnInput),
				// 估价（1.1.7 增量，版本号仍是 v2）：原始拆分、累计金额、最近一次路由。
				cacheReadInput: Math.round(ledger.cacheReadInput),
				uncachedInput: Math.round(ledger.uncachedInput),
				costCny: roundCny(ledger.costCny),
				lastModel: ledger.lastModel
			};
		}
		stateStats.updatedAt = new Date().toISOString();
		const payload = JSON.stringify({
			version: STATE_VERSION,
			savedAt: stateStats.updatedAt,
			// H1：已退休的会话 id（FIFO，上限 RETIRED_CAP）。它们的账本已经不在内存里，
			// 只有这份名单能阻止同一个 id 复活时把整段历史重放第二遍。
			retired: [...retired],
			// 已注销账本的计数快照（FIFO，上限 DISPOSED_CAP）。**按 Map 插入顺序输出成数组**
			// —— 顺序本身就是淘汰顺序，输出成对象的话 JSON 键序不保证，重启后重建的
			// Map 顺序会变、被淘汰的就不是最旧那条了。
			disposed: [...disposed.entries()].map(([id, snap]) => ({ id, ...snap })),
			sessions,
			// E5：只读聚合统计，**绝不参与任何门控判定**。
			stats: { ...stateStats }
		});
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

/**
 * 沿父子链把这一笔消耗上卷给每个祖先。
 *
 * 只上卷 `billed`（计费输入）与 familyTurnInput —— 家族维度的门盯的就是输入侧；
 * 输出侧不参与任何家族判定，所以这里**不接** output 形参：留着它只会让人以为
 * 祖先那边少算了什么。哪天家族门要按输出算，再加回来并写清用途。
 */
function chargeAncestors(sessionId, billed) {
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
 *   ③ 显式解锁：调高对应上限，或把 `DSH_LOOP_GUARD_<X>_MAX_TOKENS` 设为 0（= 关掉这道门）。
 *
 * 存档路径见上面 A2 那段：默认是 `~/.dsh/loop-guard-state.<profile>.json`，认不出 profile 时才退回
 * 老的单文件名 `loop-guard-state.json`；首次迁移之后老文件已改名成 `loop-guard-state.json.migrated`，
 * 那是残留、别去改它。重启也不是解锁：loadState 会从当前存档恢复 totalInput，现在 turnInput 也落盘，
 * 本轮账一起续着走。要手工清账只能对着当前那份分片文件、并且趁宿主停着改（否则内存里的账本会写回去）。
 */

function charge(sessionId, ledger, usage, turn, cfg) {
	if (usage === null || typeof usage !== 'object') return;
	if (turn !== undefined && turn !== ledger.turn) {
		// 换轮之前先把「上一轮花了多少」记进最近 TURN_HISTORY 轮 —— 那是 G6 自己跟自己比的分母。
		if (typeof ledger.turn === 'number' && ledger.turnInput > 0) {
			ledger.recentTurns.push(ledger.turnInput);
			while (ledger.recentTurns.length > TURN_HISTORY) ledger.recentTurns.shift();
		}
		ledger.turn = turn;
		ledger.turnInput = 0;
		ledger.familyTurnInput = 0;
		// E1a 纯输出门的三个本轮计数，与 turnInput 同一套换轮清零逻辑。
		ledger.turnOutput = 0;
		ledger.turnToolCalls = 0;
		ledger.turnOutputAtLastTool = 0;
		ledger.pureTalkWarnedTurn = undefined;
		ledger.selfWarnTurn = undefined;
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
	// 估价用的输入原始拆分与金额（算术见 accrueCost；output 上面已经累加过，这里不再重复）。
	// **不参与任何门控**，也**不在换轮时清零** —— 它是会话级的累计金额，重启后接着涨。
	accrueCost(ledger, usage, Date.now());
	// E1a：纯输出门只看这一轮吐了多少 —— 与 turnInput 同一套换轮清零。
	ledger.turnOutput += output;
	ledger.requests += 1;
	ledger.lastSeen = Date.now();
	chargeAncestors(sessionId, billed);
	// G6：本轮计费输入 vs 本会话已结束轮次的中位数。只告警，不拦、不改任何阈值（E6）。
	if (cfg !== undefined) maybeWarnSelfOutlier(ledger, sessionId, cfg);
	scheduleSave();
}

/**
 * G6：每轮自己跟自己比 —— 本轮计费输入是不是远超「本会话已经结束的那些轮次」的中位数。
 *
 * 复用横向异常那套判据（outlierRatio 默认 5 倍 + outlierFloorTokens 默认 500 万地板），
 * 但**只写一条 warn，不新增任何拦截**：兄弟会话横向对比那套逻辑一个字都不动
 * （README 明确它不比顶层会话，这里补的是「同一会话跨轮」这个死角）。
 * 阈值同样不因为观测值自动变化（E6：只做只读观察）。
 */
function maybeWarnSelfOutlier(ledger, sessionId, cfg) {
	if (ledger.recentTurns.length === 0) return;
	if (ledger.selfWarnTurn === ledger.turn) return;
	const current = ledger.turnInput;
	if (current < cfg.outlierFloorTokens) return;
	const sorted = [...ledger.recentTurns].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	const median = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
	if (!(median > 0)) return;
	if (current <= median * cfg.outlierRatio) return;
	ledger.selfWarnTurn = ledger.turn;
	log(activeCtx, 'warn', `[${sessionId}] 本轮计费输入 ${human(current)} token 是本会话已结束轮次中位数 ${human(median)} 的 ${(current / median).toFixed(1)} 倍（阈值 ${cfg.outlierRatio} 倍、地板 ${human(cfg.outlierFloorTokens)}）—— 只告警不拦截，阈值也不会自动调整（G6 / E6）`);
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
	if (tool !== '') {
		ledger.lastErrorTool = tool;
		// B2：又认出了具体工具名 → 受限降级的计数与标记一起清零。
		// （这两个计数器本来就不落盘，重启即恢复；这里管的是同一进程内的自恢复。）
		if (ledger.unknownToolDenials !== 0 || ledger.unknownToolDegraded) {
			ledger.unknownToolDenials = 0;
			ledger.unknownToolDegraded = false;
			fileLog('info', '同错误门又认出了具体的报错工具名，受限降级的计数与标记已清零');
		}
	}
	if (count >= cfg.sameErrorLimit) ledger.sameErrorTripped = true;
}

/**
 * E2 短版文案的统一形状：门类别 + 关键数值 + 要它做什么。
 * 短版只省掉「为什么」，绝不省掉模型接下来该做什么。
 */
function shortLine(label, numbers, action) {
	return `【防烧钱 · ${label}】${numbers}。${action}`;
}

/**
 * E4：拒绝计数。被拦的次数在 deny / tryDeny / quotaExempt 三处记，
 * **同时记进两边** —— ledger.gateStats 是本会话的（disposed 时写摘要），
 * stateStats 是跨重启的只读聚合（E5，写进存档 stats 段）。
 */
function deny(reason, code, ledger) {
	if (ledger !== undefined) {
		ledger.gateStats.denied += 1;
		stateStats.denied += 1;
	}
	return { kind: 'deny', reason, info: { name: 'LoopGuard', code, reason } };
}

/**
 * E2：同一道门第一次拒绝给完整文案，之后给一行短版。
 *
 * key 是「门名」（轮级门带轮号、签名级门带签名散列），不是调用签名 ——
 * 「同一道门」才是分组单位。denySeen 满了只做 FIFO 淘汰：那最多让某道门重新
 * 给一次完整文案，不改变任何判定。
 */
function gateText(ledger, gate, full, short) {
	const seen = ledger.denySeen;
	if (seen[gate] === true) return short;
	const keys = Object.keys(seen);
	if (keys.length >= DENY_SEEN_CAP) delete seen[keys[0]];
	seen[gate] = true;
	return full;
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
		ledger.gateStats.released += 1;
		stateStats.released += 1;
		log(ctx, 'warn', `${label}：已连拦 ${cfg.maxDenials} 次，按逃生门放行一次 —— 这是保险丝，不是刹车（agent 不能被永久锁死）；如果它一直撞这一处，请人工看一眼它到底卡在哪，或者调高对应的上限（环境变量 DSH_LOOP_GUARD_* / 设置面板里同一个字段）`);
		return false;
	}
	ledger.escape[key] = used + 1;
	return true;
}

// Strictness applies only to budget gates. Repetition gates keep their escape
// behavior, and the existing settlement whitelist is evaluated before budgets.
function tryBudgetDeny(ctx, ledger, key, cfg, label) {
	return cfg.strictBudget || tryDeny(ctx, ledger, key, cfg, label);
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
	ledger.gateStats.exempted += 1;
	stateStats.exempted += 1;
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
		'除交账白名单（todo_write / update_goal / get_goal / job_kill / job_list / job_output / ask_user_question / acp_status / acp_cache / search_context 等）以外，所有工具调用都会被拦住。不要重试、不要换工具绕、不要重新规划、不要道歉铺垫。',
		'立刻直接输出一份交账报告，必须包含三部分：',
		'1) 已经做完什么 —— 具体到文件路径、命令、拿到的结论；',
		'2) 还剩什么没做 —— 具体到下一步该做什么；',
		'3) 建议用户怎么继续 —— 最多三句话。'
	].join('\n');
}

/** E2 短版：门类别 + 关键数值 + 要它做什么。 */
function turnBudgetShortText(ledger, cfg) {
	return shortLine(
		'本轮预算用尽',
		`本轮计费输入 ${human(ledger.turnInput + ledger.familyTurnInput)} / ${human(cfg.maxTokens)} token${turnSpendNote(ledger)}`,
		'除交账白名单外工具调用一律被拦；立刻直接输出交账报告（做完什么 / 还剩什么 / 建议用户怎么继续）。'
	);
}

function softLandingText(ledger, cfg, toolName) {
	return [
		'【防烧钱 · 预算用尽，软着陆中】',
		`这一轮累计计费输入 ${human(ledger.turnInput + ledger.familyTurnInput)} token${turnSpendNote(ledger)}，已到上限 ${human(cfg.maxTokens)}。`,
		`「${toolName}」属于继续探索/继续花钱的工具，被拦下了；但 read / write / edit / todo_write 这类收尾工具还能用。`,
		'现在不要再开新战线。用还能用的工具把手上这件事写完、把结论落进文件或回复里，然后交账：做了多少 / 还剩什么。'
	].join('\n');
}

/** E2 短版。 */
function softLandingShortText(ledger, cfg, toolName) {
	return shortLine(
		'预算用尽，软着陆中',
		`本轮 ${human(ledger.turnInput + ledger.familyTurnInput)} / ${human(cfg.maxTokens)} token，「${toolName}」属探索类被拦`,
		'用 read / write / edit / todo_write 这类收尾工具把这件事写完，然后交账：做了多少 / 还剩什么。'
	);
}

/** 整个会话的预算也用光了——这时候要劝人开新对话。 */
function sessionBudgetText(ledger, cfg) {
	return [
		'【防烧钱 · 整个会话的预算也用尽，已硬停手】',
		`这个会话累计计费输入 ${human(ledger.totalInput)} token，到达会话上限 ${human(cfg.sessionMaxTokens)}（本轮 ${human(ledger.turnInput)}，模型请求 ${ledger.requests} 次）。`,
		'除交账白名单外，所有工具调用都会被拦住。别再试了，直接输出交账报告：',
		'1) 已经做完什么；2) 还剩什么没做；3) 明确告诉用户：这个会话该开新的了，把上面的结论带过去。'
	].join('\n');
}

/** E2 短版。 */
function sessionBudgetShortText(ledger, cfg) {
	return shortLine(
		'整个会话的预算用尽',
		`会话累计 ${human(ledger.totalInput)} / ${human(cfg.sessionMaxTokens)} token`,
		'除交账白名单外工具调用一律被拦；直接输出交账报告，并告诉用户这个会话该开新的了。'
	);
}

function familyBudgetText(ledger, cfg) {
	const total = ledger.totalInput + ledger.familyInput;
	return [
		'【防烧钱 · 家族总预算用尽，已硬停手】',
		`这个会话连同它生出来的所有子代理，累计计费输入 ${human(total)} token（自己 ${human(ledger.totalInput)} + 后代 ${human(ledger.familyInput)}），到达家族上限 ${human(cfg.familyMaxTokens)}。`,
		'除交账白名单外，所有成员的工具调用都会拦住。直接输出交账报告：1) 已经做完什么；2) 还剩什么没做；3) 如果还要继续，请让用户把上限调高或开新会话。'
	].join('\n');
}

/** E2 短版。 */
function familyBudgetShortText(ledger, cfg) {
	return shortLine(
		'家族总预算用尽',
		`自己 + 所有后代 ${human(ledger.totalInput + ledger.familyInput)} / ${human(cfg.familyMaxTokens)} token`,
		'除交账白名单外，所有成员的工具调用一律被拦；直接输出交账报告。'
	);
}

function requestBudgetText(ledger, cfg) {
	return [
		'【防烧钱 · 子代理请求数到顶】',
		`这个子代理已经发出 ${ledger.modelCalls} 次模型请求，超过子代理上限 ${cfg.maxSubagentRequests}（累计计费输入 ${human(ledger.totalInput)}）。`,
		'停下来，别再加轮次。用最少的动作把手上已经拿到的结论整理出来并返回，明确说清「做到哪一步、什么没验证过」。',
		'这是硬上限：重发不会被放行（首次超限那一次已经豁免掉了）。要真继续，请调高 DSH_LOOP_GUARD_MAX_SUBAGENT_REQUESTS，或开新会话。'
	].join('\n');
}

/**
 * E2 短版。配额类门的文案**不写**「原样再发一次会被放行」——那是重复签名类门的承诺，
 * 配额门只有一次性豁免，写上去就是把两种语义混成一句。
 */
function requestBudgetShortText(ledger, cfg) {
	return shortLine(
		'子代理请求数到顶',
		`已发 ${ledger.modelCalls} 次模型请求 / 上限 ${cfg.maxSubagentRequests}`,
		'重发不会被放行（一次性豁免已经用掉）；用最少的动作把结论整理出来返回。'
	);
}

function toolBudgetText(ledger, cfg) {
	return [
		'【防烧钱 · 子代理工具调用数到顶】',
		`这个子代理已经调用工具 ${ledger.toolCalls} 次，超过上限 ${cfg.maxSubagentTools}。`,
		'这通常意味着它在原地打转。停止探索，立刻把现有结果整理成最终回复返回。'
	].join('\n');
}

/** E2 短版（配额类：不写「原样再发会被放行」）。 */
function toolBudgetShortText(ledger, cfg) {
	return shortLine(
		'子代理工具调用数到顶',
		`已调用 ${ledger.toolCalls} 次 / 上限 ${cfg.maxSubagentTools}`,
		'停止探索，立刻把现有结果整理成最终回复返回。'
	);
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

/** E2 短版（重复类门：保留「放行那一次紧接着原样再发也放行」这个承诺）。 */
function outlierShortText(ledger, cfg, info) {
	return shortLine(
		'这个子代理单次请求花得离谱',
		`每次请求 ${human(info.own)} vs 兄弟中位数 ${human(info.median)}（${info.ratio.toFixed(1)} 倍）`,
		'收敛返回，或先说清为什么它和别的子代理不一样 —— 同一处连拦到上限（默认 3 次）后放行一次，放行那一次紧接着原样再发也放行。'
	);
}

/**
 * 拆开内部错误指纹（`工具名\u0000错误正文`）：U+0000 只是分隔符，
 * 展示给人看之前必须拆开，别把前缀糊在正文里、更别把 NUL 原样写进日志。
 * 指纹里没有分隔符时，整串都算正文，tool 为空串。
 */
function fingerprintParts(raw) {
	const text = String(raw === undefined || raw === null ? '' : raw);
	const cut = text.indexOf('\u0000');
	if (cut === -1) return { tool: '', body: text };
	return { tool: text.slice(0, cut), body: text.slice(cut + 1) };
}

function sameErrorText(ledger, cfg) {
	const body = fingerprintParts(ledger.lastError).body;
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

/** E2 短版。 */
function sameErrorShortText(ledger, cfg) {
	const who = ledger.lastErrorTool === '' ? '某个工具' : ledger.lastErrorTool;
	return shortLine(
		'同一个错误反复出现',
		`${who} 的同一错误已出现 ${ledger.lastErrorCount} 次（阈值 ${cfg.sameErrorLimit}）`,
		'停下来说出根因，换一个假设再动手；这道门只拦它自己，读文件/查日志/看代码照常。'
	);
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

/** E2 短版。 */
function cycleShortText(cfg, left, right) {
	return shortLine(
		'乒乓循环',
		`最近在两种写法之间来回 ${cfg.cycleLimit} 轮以上（A: ${left.slice(0, 60)} / B: ${right.slice(0, 60)}）`,
		'先说清 A 和 B 各自证明了什么，再决定下一步；答案大概率在第三个方向上。'
	);
}

function skeletonText(toolName, count, limit, skeleton) {
	return [
		'【防烧钱 · 换个写法做同一件事，本次调用被拦】',
		`把路径、数字、引号抹平之后，「${skeleton}」这个骨架已经出现过 ${count} 次（阈值 ${limit}），这次是 ${toolName}。`,
		'换一个路径、换一个数字再跑一遍，和原样重跑没有区别。',
		'二选一：1) 换成真正不同的做法（不同的工具、不同的假设）；2) 说明为什么前面那些结果都不能用 —— 同一处累计连拦到上限（默认 3 次）后会自动放行一次，放行那一次紧接着再原样发一次也放行。'
	].join('\n');
}

/** E2 短版（重复类门：保留那句承诺）。 */
function skeletonShortText(toolName, count, limit, skeleton) {
	return shortLine(
		'换个写法做同一件事',
		`骨架「${skeleton.slice(0, 60)}」已出现 ${count} 次（阈值 ${limit}），这次是 ${toolName}`,
		'换真正不同的做法；同一处连拦到上限（默认 3 次）后放行一次，放行那一次紧接着原样再发也放行。'
	);
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

/** E2 短版（配额类）。 */
function breakerShortText(info, cfg) {
	return shortLine(
		'熔断',
		`已有 ${info.failures} / ${info.need} 个子代理「烧多吐少」`,
		'不再允许开新子代理：自己直接做，或把任务拆得更小、更明确再派。'
	);
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

/** E2 短版（配额类）。 */
function fanoutShortText(alive, cfg) {
	return shortLine(
		'扇出到顶',
		`同时活着 ${alive} / ${cfg.maxFanout} 个子代理`,
		'先等现有子代理返回，或把几个小任务合并成一个子代理。'
	);
}

function workflowText(info, cfg) {
	return [
		'【防烧钱 · workflow 扇出过大】',
		`这个 workflow 脚本里有 ${info.calls} 处 agent() 调用，再乘上条目数 ${info.multiplier}，预计会扇出约 ${info.estimated} 个子代理，超过允许的 ${cfg.maxWorkflowAgents}。`,
		'一个脚本就能一次性扇出几十个子代理，是总消耗失控最隐蔽的入口。',
		'请先把规模降下来（分批跑、或减少条目数），确认单批消耗之后再放大。确实需要这么大，就调高 DSH_LOOP_GUARD_MAX_WORKFLOW_AGENTS。'
	].join('\n');
}

/** E2 短版（配额类）。 */
function workflowShortText(info, cfg) {
	return shortLine(
		'workflow 扇出过大',
		`预计扇出约 ${info.estimated} / 上限 ${cfg.maxWorkflowAgents} 个子代理`,
		'分批跑或减少条目数，确认单批消耗之后再放大。'
	);
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

/** E2 短版（重复签名类门：保留那句承诺）。 */
function repeatShortText(toolName, record, limit, signature) {
	return shortLine(
		'疑似死循环',
		`同一个调用（${toolName}）已执行 ${record.count} 次 / 阈值 ${limit}，签名 ${signature.slice(0, 80)}`,
		'换打法（不同命令 / 路径 / 思路）；同一处连拦到上限（默认 3 次）后放行一次，放行那一次紧接着原样再发也放行。'
	);
}

// ───────────────────── 纯输出门（E1）：一轮只有输出，什么都没交账 ─────────────────────

/**
 * E1a 判据：**自本轮最后一次「真的执行过」的非白名单工具调用以来**，输出量是否到量。
 *
 * 为什么看「距上一次干活以来」而不是「本轮有没有干过活」：旧口径要求 `turnToolCalls === 0`，
 * 于是只要这一轮**随便真执行过一次工具调用**，这道门就整轮失效 ——
 * 「先调一次工具、再狂喷输出打转」可以直接绕过去。而这道门想抓的是
 * 「**没有产出、只在输出上打转**」：干活与产出必须交替，而不是干一次就买到无限输出的额度。
 * 判据改成水位差之后，一轮里一次工具都没执行过时游标停在 0，等价于原来的
 * `turnOutput >= 阈值` —— 新判据涵盖旧判据，只会更严，不会放松。
 *
 * 为什么不能只看 output：会误伤「读了几个文件、然后写了一篇长报告」的正常轮次
 * （那种轮次里每次干活都会把游标推到当时的水位，报告那一段的输出量根本到不了阈值）。
 * 阈值取到病态量级（默认 20 万），正常使用根本碰不到。
 */
function pureTalkHit(ledger, cfg) {

	// 判定的两个调用点：用工具的那一侧见「⓪ E1 纯输出门」（judge 里 return deny 那一段），
	// 换轮那一侧见 `if (ledger === undefined || !pureTalkHit(ledger, cfg)) return undefined;`
	// （agent/pre-step）。两处共用这一个判据，改口径只改这里。
	//
	// 游标 `turnOutputAtLastTool` 只在**放行出口**推进（`countExecutedTool(ledger, true)`），
	// 被拦下的调用不动它 —— 否则一次被拦的尝试就会把这道门在本轮里整轮关掉（P1-1 第二轮的缺陷 ③）。
	// `turnToolCalls` 已不参与判定（见 countExecutedTool 的注释：它现在是展示/统计口径）。
	return ledger.turnOutput - ledger.turnOutputAtLastTool >= cfg.pureTalkTokens;
}

/** 纯输出门命中只吼一次（每轮）：agent/pre-step 的 reject 是空决定，日志是唯一痕迹。 */
function warnPureTalkOnce(ctx, ledger, sessionId, cfg, where) {
	if (ledger.pureTalkWarnedTurn === ledger.turn) return;
	ledger.pureTalkWarnedTurn = ledger.turn;
	log(ctx, 'warn', `[${sessionId}] 纯输出门命中（${where}）：距上一次真的执行过工具调用以来已输出 ${human(ledger.turnOutput - ledger.turnOutputAtLastTool)} / ${human(cfg.pureTalkTokens)} token，期间没有再执行过工具 —— 停止生成并提醒交账（除交账白名单外一律 deny）`);
}

/** E1c 给模型的完整提醒：这是唯一能把话带回去的通路（deny 的 reason）。 */
function pureTalkText(ledger, cfg) {
	const since = ledger.turnOutput - ledger.turnOutputAtLastTool;
	return [
		'【防烧钱 · 本轮只有输出，没有任何交账动作】',
		`自本轮上一次真的执行过工具调用以来，已经累计输出 ${human(since)} token（阈值 ${human(cfg.pureTalkTokens)}），这期间没有再执行过工具 —— 也就是说这段钱全花在说话上，没有换来任何可核查的进展。`,
		'从现在起：交账白名单（todo_write / todo_read / job_list / job_output / job_kill / ask_user_question / update_goal / get_goal / acp_status / acp_cache / search_context）照常可用，**其余工具调用都会被拦**。',
		'请立刻做两件事：1) 用 todo_write / update_goal 把「已经做完什么 / 还剩什么」交账落下来；2) 停止继续铺陈，把结论收敛成可以直接用的东西。',
		'这道门是提醒交账的门，不是预算门：交了账、进入新一轮（新 turn）就重新起算。'
	].join('\n');
}

/** E2 短版。 */
function pureTalkShortText(ledger, cfg) {
	return shortLine(
		'本轮只有输出，没有交账',
		`距上一次真的执行过工具调用以来已输出 ${human(ledger.turnOutput - ledger.turnOutputAtLastTool)} / ${human(cfg.pureTalkTokens)} token，期间没有再执行过工具`,
		'先用 todo_write / update_goal 交账，停止继续铺陈；除交账白名单外工具调用一律会被拦。'
	);
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
 * 判定一次工具调用（原 judge 的函数体；对外出口见下面的 judge 包装器）。
 * @returns 拦截对象，或 undefined 表示放行（放行 = 这次调用真的执行，记账见 countExecutedTool）。
 */
function judgeGates(ctx, cfg, exec) {
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
	// 口径变化（P1-1）：NEVER_BLOCK 里的工具**真的执行**，从本版起计入 `toolCalls`
	// （配额门 / 收尾摘要 / 盲区自检用）。以前它们被这一行直接 return 掉、一次都不计。
	// 非工具步骤（toolName === ''）仍然不计：它不是工具调用。
	//
	// **故意**传 worked = false：只记 `toolCalls`，不记 `turnToolCalls`、也不推 E1a 的水位游标。
	// `turnToolCalls` 的语义是「本轮真的干过活」（现在是展示/统计口径）；
	// 交账工具（update_goal / todo_write / …）算进来的话，展示口径就分不出「干活」与「收尾」，
	// 而它恰恰是收尾动作、不是干活。
	//
	// 为什么记账写在这一行**里面**：它是一条独立的放行出口（排在所有闸门之前），
	// 走不到下面任何一条「非白名单放行出口」（见 countExecutedTool / allowExecuted 的注释），
	// 而白名单工具**真的会执行**，所以只能在返回前单独记一次。
	// 它不影响任何门：白名单排在所有闸门之前，这条路径本来就不进 ④ 的配额判定。
	if (toolName === '') return undefined;
	if (NEVER_BLOCK.has(toolName)) {
		countExecutedTool(ledger, false);
		return undefined;
	}

	// ⓪ E1 纯输出门：**自本轮上一次真的执行过工具调用以来**的累计输出到量。
	//   判据本体在 `pureTalkHit`（上面 `function pureTalkHit(ledger, cfg)` 那一段的注释：
	//   两个调用点、改口径只改那里）；这一处是**拦工具**的出口，另一处在 agent/pre-step。
	//
	// 这是**提醒交账**的门，不是预算门：只 deny，不设任何粘性标志（不碰 tripped / escape），
	// 也不进逃生门 —— 交了账、进入新一轮（新 turn）就重新起算。
	// 「白名单永远放行」由上面那一行 return 保证：它排在**所有**闸门之前，
	// 否则连 todo_write / update_goal 这些交账手段和诊断手段会一起被堵死（E1c 的硬要求）。
	// 命中后留在这一轮里，每一条非白名单工具调用都会被拦（一律 deny）—— 这是刻意的：
	// 只要这一轮还是「纯输出轮」，就不该再放它去干活，除非它先用白名单交账。
	if (cfg.pureTalkGuard && pureTalkHit(ledger, cfg)) {
		warnPureTalkOnce(ctx, ledger, sessionId, cfg, 'tools/pre-execute');
		log(ctx, 'warn', `[${sessionId}] 纯输出门：拦下 ${toolName}（距上一次真的执行过工具调用以来已输出 ${human(ledger.turnOutput - ledger.turnOutputAtLastTool)} token、期间没有执行过工具）`);
		return deny(
			gateText(ledger, `pure-talk#${String(ledger.turn)}`, pureTalkText(ledger, cfg), pureTalkShortText(ledger, cfg)),
			'LOOP_GUARD_SETTLE_REQUIRED',
			ledger
		);
	}

	// 调用签名（工具名 + 折叠过参数的散列）。④ 的逃生门放行时要用它记豁免，
	// 所以从原来的位置（⑧ 之前）提到了这里；纯函数、无副作用。
	const signature = signatureOf(toolName, args);
	// E10：**继承自上一轮调用**的豁免在这里算一次，后面所有门共用（④ ⑩ ⑪）。
	//
	// 必须在 ④ outlier 门**之前**算：④ 的逃生分支自己也会新开一个槽（下面的 escapeSig
	// 赋值）。如果在 ④ 之后才算，「继承」就会把本次刚开的槽误当成上一次留下的，
	// 末尾一消费就没了 —— 「放行那一次紧接着原样再发也放行」当场落空
	// （实测 拦 拦 拦 放行 拦 拦，期望 拦 拦 拦 放行 放行 拦）。
	const exemptIn = ledger.escapeSig === signature && ledger.escapeSigUsed !== true;

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
		if (tryBudgetDeny(ctx, ledger, `session-budget#${String(ledger.trippedSessionTurn)}`, cfg, '会话预算用尽')) {
			return deny(gateText(ledger, 'session-budget', sessionBudgetText(ledger, cfg), sessionBudgetShortText(ledger, cfg)), 'LOOP_GUARD_SESSION_BUDGET', ledger);
		}
	}

	// ② 本轮预算：自己这一轮 + 这一轮生出来的所有子代理。到线硬停手（或软着陆），逼出交账报告。
	//
	// 「一次问答」的消耗必须连子代理一起算。只算自己的话，一次对话可以自己烧满 6000 万，
	// 再让 8 个子代理各烧 6000 万 —— 单轮上限就形同虚设。
	const turnTotal = ledger.turnInput + ledger.familyTurnInput;
	if (ledger.tripped || turnTotal >= cfg.maxTokens) {
		// 这道门也走逃生门（软着陆分支同理）：到线后连拦 maxDenials 次必须放行一次，
		// 否则「本轮」这一层同样能把会话锁死。key 带轮号 —— 下一轮是新预算、新计数。
		const turnKey = `turn-budget#${String(ledger.turn)}`;
		if (cfg.softLanding) {
			if (!SOFT_ALLOW.has(toolName) && toolName !== '') {
				if (tryBudgetDeny(ctx, ledger, `${turnKey}-soft`, cfg, '软着陆')) {
					log(ctx, 'warn', `[${sessionId}] 软着陆：拦下 ${toolName}`);
					return deny(gateText(ledger, `soft-landing#${String(ledger.turn)}`, softLandingText(ledger, cfg, toolName), softLandingShortText(ledger, cfg, toolName)), 'LOOP_GUARD_SOFT_LANDING', ledger);
				}
			}
		} else {
			if (!ledger.tripped) {
				ledger.tripped = true;
				log(ctx, 'warn', `[${sessionId}] 本轮预算用尽：${human(turnTotal)} / ${human(cfg.maxTokens)}${turnSpendNote(ledger)} —— 硬停手`);
			}
			if (tryBudgetDeny(ctx, ledger, turnKey, cfg, '本轮预算用尽')) {
				return deny(gateText(ledger, turnKey, turnBudgetText(ledger, cfg), turnBudgetShortText(ledger, cfg)), 'LOOP_GUARD_BUDGET_EXHAUSTED', ledger);
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
		if (tryBudgetDeny(ctx, ledger, `family-budget#${String(ledger.trippedFamilyAt)}`, cfg, '家族预算用尽')) {
			return deny(gateText(ledger, 'family-budget', familyBudgetText(ledger, cfg), familyBudgetShortText(ledger, cfg)), 'LOOP_GUARD_FAMILY_BUDGET', ledger);
		}
	}

	// ④ 子代理专属：请求数、工具数、横向异常。
	//    请求数 / 工具数是**配额**门 → 一次性豁免（quotaExempt）；横向异常是
	//    「你比别人离谱」→ 重复类语义，仍然走 tryDeny。
	if (ledger.isSubagent) {
		if (ledger.modelCalls >= cfg.maxSubagentRequests && !quotaExempt(ctx, ledger, 'requests', `[${sessionId}] 子代理请求数到顶`)) {
			log(ctx, 'warn', `[${sessionId}] 子代理请求数到顶：${ledger.modelCalls} —— 拦`);
			return deny(gateText(ledger, 'subagent-requests', requestBudgetText(ledger, cfg), requestBudgetShortText(ledger, cfg)), 'LOOP_GUARD_SUBAGENT_REQUESTS', ledger);
		}
		if (ledger.toolCalls >= cfg.maxSubagentTools && !quotaExempt(ctx, ledger, 'tools', `[${sessionId}] 子代理工具数到顶`)) {
			log(ctx, 'warn', `[${sessionId}] 子代理工具数到顶：${ledger.toolCalls} —— 拦`);
			return deny(gateText(ledger, 'subagent-tools', toolBudgetText(ledger, cfg), toolBudgetShortText(ledger, cfg)), 'LOOP_GUARD_SUBAGENT_TOOLS', ledger);
		}
		const outlier = outlierOf(ledger, sessionId, cfg);
		// E10：④ 也认「继承自上一轮调用」的豁免（!exemptIn）。否则上一道门刚放行的那一次
		// 会被 ④ 拦回去，与 ⑩/⑪ 的契约 C6 不一致。这里判的是**继承来的**豁免，
		// ④ 自己开的新槽（下面）不算 —— 那是留给紧接着的下一次调用的。
		if (outlier !== undefined && !exemptIn) {
			if (tryDeny(ctx, ledger, 'outlier', cfg, '横向异常')) {
				log(ctx, 'warn', `[${sessionId}] 横向异常：每次请求 ${human(outlier.own)} vs 兄弟中位数 ${human(outlier.median)}（${outlier.ratio.toFixed(1)} 倍）—— 拦`);
				return deny(gateText(ledger, 'outlier', outlierText(ledger, cfg, outlier), outlierShortText(ledger, cfg, outlier)), 'LOOP_GUARD_OUTLIER', ledger);
			}
			// E10：逃生门放行了这一次 —— 和同骨架门 / 同签名门一样记下签名，兑现
			// 「放行那一次紧接着原样再发也放行」。单槽语义保持不变：只豁免紧接着的同签名一次。
			//
			// **这个槽是开给下一次调用的**：末尾的消费只看 exemptIn（继承自上一轮），
			// 所以这里刚开的槽一定活到紧接着的那次同签名调用。
			ledger.escapeSig = signature;
			ledger.escapeSigUsed = false;
		}
	}

	// ★ P1-1 第二轮：**从本行往下全是闸门 —— deny 一律不记账，记账收口在放行出口上**
	// （`return allowExecuted(ledger)`，见 countExecutedTool / allowExecuted 的注释）。
	// 判定入口（上面）不是记账点：⑤⑥ 出生闸门、⑧ 同错误门、⑨ 乒乓门、⑩ 同骨架门、
	// ⑪ 同签名门都会 deny，被它们拦下的调用**根本没有执行**，两个计数都不该加 ——
	// 旧写法把记账放在这里（= 这些门之前），于是被拦的尝试也进了账，
	// ④ 子代理工具配额、徽标与 E1a 纯输出门三处一起被污染。
	// 口径就是「**执行了**才记一次」：deny 出口不记，四条放行出口各记一次。

	// ⑤⑥ 出生闸门：熔断 + 扇出 + workflow 估数。三者都是**配额**门 → 一次性豁免。
	if (SPAWN_TOOLS.has(toolName)) {
		const root = rootOf(sessionId);
		const breaker = breakerOf(root, cfg);
		if (breaker !== undefined && !quotaExempt(ctx, ledger, 'breaker', `[${root}] 熔断`)) {
			log(ctx, 'warn', `[${root}] 熔断：已有 ${breaker.failures} 个子代理烧多吐少 —— 拦下新的 spawn`);
			return deny(gateText(ledger, 'breaker', breakerText(breaker, cfg), breakerShortText(breaker, cfg)), 'LOOP_GUARD_BREAKER', ledger);
		}
		const alive = liveDescendants(root, cfg);
		if (alive >= cfg.maxFanout && !quotaExempt(ctx, ledger, 'fanout', `[${root}] 扇出到顶`)) {
			log(ctx, 'warn', `[${root}] 扇出到顶：同时活着 ${alive} 个子代理 —— 拦下新的 spawn`);
			return deny(gateText(ledger, 'fanout', fanoutText(alive, cfg), fanoutShortText(alive, cfg)), 'LOOP_GUARD_FANOUT', ledger);
		}
		if (toolName === 'workflow') {
			const estimate = estimateAgents(args?.script, args?.args ?? args);
			if (estimate.estimated > cfg.maxWorkflowAgents && !quotaExempt(ctx, ledger, 'workflow', `[${sessionId}] workflow 扇出过大`)) {
				log(ctx, 'warn', `[${sessionId}] workflow 扇出估计 ${estimate.estimated} 个子代理（${estimate.calls} 处 agent() × ${estimate.multiplier}）—— 拦`);
				return deny(gateText(ledger, 'workflow', workflowText(estimate, cfg), workflowShortText(estimate, cfg)), 'LOOP_GUARD_WORKFLOW_FANOUT', ledger);
			}
		}
	}

	// ⑧ 同一个错误又冒出来了 —— 最典型的「原地打转」，前面每一次尝试都白花了钱。
	//
	// **只拦报错的那个工具。** 指纹本来就带工具名，拦的时候也得对得上：
	// 事故里最难受的一段就是「pwsh 反复失败 → 连读个文件都被拦」，
	// 而读文件恰恰是它诊断失败原因所必需的动作 —— 想让它换假设，
	// 就不能顺手把它换假设要用的工具一起堵死。别的工具出错两次，会去拦那个工具。
	//
	// B2 受限降级：连报错工具名都认不出来（lastErrorTool === ''，工具名缺失/事件没带）
	// 的时候，上面那条原则就无从落地 —— 只能全局拦，于是诊断用的读文件也会被堵死。
	// 这种**分支**单独计数：同一会话连续够 cfg.sameErrorUnknownLimit 次（默认 3）之后，
	// 只让这一种分支失效（其余同错误门照常按 lastErrorTool 拦）。
	// 恢复：noteToolResult 一旦拿到非空工具名，计数与降级标记一起清零。
	// 计数与标记都不落盘（重启即恢复），也不进状态文件 —— 它们是内存态的临时止损。
	if (ledger.sameErrorTripped) {
		const unknownToolBranch = ledger.lastErrorTool === '';
		const branchActive = unknownToolBranch ? !ledger.unknownToolDegraded : toolName === ledger.lastErrorTool;
		if (branchActive) {
			if (tryDeny(ctx, ledger, 'sameError', cfg, '同一个错误反复出现')) {
				if (unknownToolBranch) {
					ledger.unknownToolDenials += 1;
					if (ledger.unknownToolDenials >= cfg.sameErrorUnknownLimit) {
						ledger.unknownToolDegraded = true;
						fileLog('info', `[${sessionId}] 同错误门认不出报错工具名，已连拦 ${ledger.unknownToolDenials} 次 —— 已受限降级：这一分支不再拦，其余同错误门照常按 lastErrorTool 拦`);
						log(ctx, 'warn', `[${sessionId}] 同错误门认不出报错工具名（只能全局拦），已连拦 ${ledger.unknownToolDenials} 次 —— 已受限降级：停止拦这一种分支（其余同错误门照常拦对应工具）`);
					}
				}
				// 指纹是内部格式，进日志前拆开拼成「工具名 — 正文」（正文照旧截断 120 字符）；
				// 没有分隔符时原样输出，并且绝不能把 U+0000 落进日志（会把日志变成二进制文件）。
				const fingerprint = fingerprintParts(ledger.lastError);
				const shown = fingerprint.tool === ''
					? fingerprint.body.slice(0, 120)
					: `${fingerprint.tool} — ${fingerprint.body.slice(0, 120)}`;
				log(ctx, 'warn', `[${sessionId}] 同一个错误已出现 ${ledger.lastErrorCount} 次 —— 拦：${shown}`);
				return deny(gateText(ledger, 'same-error', sameErrorText(ledger, cfg), sameErrorShortText(ledger, cfg)), 'LOOP_GUARD_SAME_ERROR', ledger);
			}
			ledger.sameErrorTripped = false;
		}
	}

	// ⑨ A-B-A-B 乒乓循环：每一步都是「新的」，整体却在原地转。
	//
	// P1-2：本门也要认豁免（与 ⑩ 的 exemptIn 分支同款）。契约 C6 要求
	// 「逃生门放行的那一次，不能被紧接着的同骨架门 / 同签名门 / ④ 横向异常门拒掉」——
	// 乒乓门排在 ⑩/⑪ 之前，少了这一支，⑪ 刚放行的那一次原样再发就会被乒乓门拦回去，
	// 「说明理由后照原样再发一次会被放行」当场变成空话（所有门必须一起让路）。
	//
	// 顺序（别改）：exemptIn 在 judge 入口算好（`ledger.escapeSig === signature &&
	// escapeSigUsed !== true`），⑨ 排在 ⑩ 与 ⑪ 之前。豁免在这里一被消费
	// （escapeSigUsed = true）就立刻 return，后面所有门连同 ⑪ 的消费分支都走不到 ——
	// 所以一次调用里豁免**最多**被消费一次，不可能被两个门各消费一遍。
	const cycle = cycleOf(ledger, signature, cfg);
	if (cycle !== undefined) {
		if (exemptIn) {
			ledger.escapeSigUsed = true;
			fileLog('info', `[${sessionId}] 乒乓循环门消费掉上一次的豁免（照原样再发一次）：${signature.slice(0, 120)}`);
			// 放行出口（⑨ 消费豁免）：这次调用真的执行，恰好记一次。
			return allowExecuted(ledger);
		}
		if (tryDeny(ctx, ledger, 'cycle', cfg, '乒乓循环')) {
			const [left, right] = cycle.split('\u0000');
			log(ctx, 'warn', `[${sessionId}] 乒乓循环 ${cfg.cycleLimit} 轮 —— 拦`);
			return deny(gateText(ledger, 'cycle', cycleText(cfg, left, right), cycleShortText(cfg, left, right)), 'LOOP_GUARD_CYCLE', ledger);
		}
	}

	// ⑩ 同骨架：换路径、换数字、换引号接着做同一件事。一级指纹抓不住它。
	//
	// 契约（和 ⑪ 一起看）：文档承诺的「照原样再发一次会被放行」必须**所有门同时成立**
	// 才算数 —— 逃生门放行的那一次，不能被紧接着的同骨架门 / 同签名门 / ④ 的横向异常门拒掉。
	// 实现：逃生门放行时把签名记进 ledger.escapeSig（槽），紧接着的同签名调用整体豁免一次；
	// 这个豁免在 judge 入口算成 exemptIn，全场判定共用，末尾只消费**上一轮留下的**那个槽。
	const skeleton = skeletonFor(toolName, signature);
	const skeletonRecord = ledger.skeletons.get(skeleton) ?? { count: 0 };
	if (skeletonRecord.count >= cfg.skeletonLimit) {
		// B1：逃生计数**按骨架散列分键**（和 ⑪ 的 `repeat#<签名散列>` 同一套做法）。
		// 以前用的是固定键 'skeleton'：骨架 A 连拦到上限被放行之后，全新骨架 B 的
		// 第 1 次也会被放行 —— 一个门被另一个骨架的连拦次数顶开了。
		// 键仍住在会话级 escape 表里（ESCAPE_CAP = 400，满了 FIFO 淘汰），计数不跟骨架记录走。
		const skeletonKey = escapeKeyFor(ledger, 'skeleton#', skeleton);
		if (exemptIn) {
			fileLog('info', `[${sessionId}] 同骨架门为刚被逃生门放行的同签名调用让路：${skeleton.slice(0, 120)}`);
		} else if (tryDeny(ctx, ledger, skeletonKey, cfg, '同骨架重复')) {
			log(ctx, 'warn', `[${sessionId}] 同骨架调用第 ${skeletonRecord.count + 1} 次 —— 拦：${skeleton.slice(0, 120)}`);
			return deny(gateText(ledger, `skeleton#${shortHash(skeleton)}`, skeletonText(toolName, skeletonRecord.count, cfg.skeletonLimit, skeleton), skeletonShortText(toolName, skeletonRecord.count, cfg.skeletonLimit, skeleton)), 'LOOP_GUARD_SKELETON', ledger);
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
		if (exemptIn) {
			// 上一次就是它被放行的 —— 这一次照原样再发，所有门一起让路，豁免用掉。
			ledger.escapeSigUsed = true;
			record.count += 1;
			ledger.signatures.set(signature, record);
			fileLog('info', `[${sessionId}] 同签名门消费掉上一次的豁免（照原样再发一次）：${signature.slice(0, 120)}`);
			// 放行出口（⑪ 消费豁免）：这次调用真的执行，恰好记一次。
			return allowExecuted(ledger);
		}
		if (tryDeny(ctx, ledger, escapeKey, cfg, '同一签名重复')) {
			log(ctx, 'warn', `[${sessionId}] 拦下第 ${record.count + 1} 次同签名调用：${signature.slice(0, 160)}`);
			return deny(gateText(ledger, `repeat#${shortHash(signature)}`, repeatText(toolName, record, limit, signature), repeatShortText(toolName, record, limit, signature)), 'LOOP_GUARD_REPEAT', ledger);
		}
		// 逃生门放行了这一次 —— 记住签名，让紧接着的同签名调用也整体豁免一次（契约 C6）。
		record.count += 1;
		ledger.signatures.set(signature, record);
		ledger.escapeSig = signature;
		ledger.escapeSigUsed = false;
		// 放行出口（⑪ 逃生门放行）：这次调用真的执行，恰好记一次。
		return allowExecuted(ledger);
	}

	record.count += 1;
	if (ledger.signatures.size > SIGNATURE_CAP && !ledger.signatures.has(signature)) evictOldest(ledger.signatures, '签名表');
	ledger.signatures.set(signature, record);
	// 只消费**上一轮调用留下的**那个槽（exemptIn）。本次调用里刚开的槽（④ 的逃生分支、
	// 上面的同骨架门分支）绝不能在这一次内被消掉 —— 那正是 E10 之前的 bug。
	if (exemptIn) ledger.escapeSigUsed = true;
	// E1a：这一轮**真的执行了**一次非白名单工具调用 —— 纯输出门把水位游标推到当前
	// `turnOutput`（在 countExecutedTool 里做），此后只按「距这次又吐了多少」判定。
	// 记账收口在放行出口上（见 allowExecuted）：**本行之下就是「回落放行」
	// 这条出口的记账**，只是这里不写 `return allowExecuted(ledger)` —— 紧接着的那道自检要读
	// `ledger.toolCalls`，必须保住「含本次」的口径（与记账点搬走之前一致），
	// 所以先记、再自检、最后由函数末尾那条 return 放行。
	countExecutedTool(ledger);

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
 * judge 的记账包装器：判定的主体在 judgeGates（原 judge 函数体，一行没动）。
 * 本包装器只负责「把 gate 判定转交出去」，**自己不记账** —— 记账收口在 judgeGates 内部的
 * **放行出口**上，见 countExecutedTool / allowExecuted 的注释：
 *   · 白名单那一行：NEVER_BLOCK 里的工具 **真的执行**，只记 `toolCalls`（不记 `turnToolCalls`、不推水位游标）；
 *   · 四条非白名单放行出口：回落放行（judgeGates 末尾）、⑨ 乒乓门消费豁免、
 *     ⑩ 同骨架门逃生放行（落到末尾那一条）、⑪ 同签名门消费豁免 / 逃生门放行。
 * 因此 ⓪/①/②/③/④/⑤/⑥/⑧/⑨/⑩/⑪ 里的**任何一条 deny 出口都不记账**：
 * 被拦下的调用没有执行，不该吃配额、不该推 E1a 的水位游标、也不该进徽标。
 * 改了函数名（judge → judgeGates）之后这里的调用仍然是同一处，gate 语义不变；
 * 记账时机则从「判定中途的入口」搬到了「放行出口」（P1-1 第二轮）。
 */
function judge(ctx, cfg, exec) {
	return judgeGates(ctx, cfg, exec);
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

/**
 * E1b：纯输出门命中 → 停止生成。
 *
 * 和 vetoNewTurn 走同一个 hook（agent/pre-step），但判据完全不同：那边看会话总预算，
 * 这边看「这一轮是不是只有输出、什么都没交账」。reject 是**空决定**，带不了任何文案 ——
 * 所以这里必须自己写日志留痕，给模型的提醒只能走 tools/pre-execute 的 deny（E1c）。
 */
function pureTalkVeto(ctx, cfg, payload) {
	if (!cfg.pureTalkGuard) return undefined;
	const agent = payload?.agent;
	const sessionId = String(agent?.session?.id ?? agent?.sessionId ?? 'unknown');
	const ledger = ledgers.get(sessionId);
	if (ledger === undefined || !pureTalkHit(ledger, cfg)) return undefined;
	warnPureTalkOnce(ctx, ledger, sessionId, cfg, 'agent/pre-step');
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
		limits: { maxTokens: jsonLimit(cfg?.maxTokens), sessionMaxTokens: jsonLimit(cfg?.sessionMaxTokens), strictBudget: cfg?.strictBudget === true },
		tripped: {
			turn: ledger?.tripped === true,
			session: ledger?.trippedSession === true,
			family: ledger?.trippedFamily === true
		},
		updatedAt: Date.now(),
		// 估价（**可以关**：DSH_LOOP_GUARD_COST=0 时这个键整个不出现 ——
		// 「没有这张表」和「这张表花了 0 元」是两件事，客户端按缺键渲染成「不显示」）。
		...(costEnabled
			? {
					cost: {
						cny: roundCny(ledger?.costCny),
						estimated: true,
						model: typeof ledger?.lastModel === 'string' ? ledger.lastModel : '',
						cacheReadInput: numberOr0(ledger?.cacheReadInput),
						uncachedInput: numberOr0(ledger?.uncachedInput),
						output: numberOr0(ledger?.output),
						pricesAsOf: PRICES_AS_OF
					}
				}
				: {})
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
	const features = createGuardFeatures({ file: STATE_FILE + '.daily.json', persist: cfg.persist, limitOverride: process.env.DSH_LOOP_GUARD_DAILY_MAX_TOKENS !== undefined || cfg.dailyMaxTokens > 0 ? cfg.dailyMaxTokens : undefined, costEnabled: cfg.cost });
	globalThis[GUARD_HUB] = features.hub;
	if (typeof ctx.effect === 'function') ctx.effect(() => () => { if (globalThis[GUARD_HUB] === features.hub) delete globalThis[GUARD_HUB]; }, 'loop-guard: optional interaction hub');
	cfgPersist = cfg.persist;
	// 估价开关与价目表同样只在 apply 里定（charge 那条路径没有 cfg）。
	// 关掉时连价目表都不解析 —— 免得为一个用不上的表往日志里塞一条 warn。
	costEnabled = cfg.cost;
	priceTable = costEnabled ? readPriceTable(ctx) : PRICE_TABLE_BUILTIN;
	// 诊断日志的开关/路径只在 apply 里定：模块级函数（charge → writeState、
	// 闸门里的 fileLog）没有 cfg，只能读这两个模块变量。
	activeCtx = ctx;
	logPath = cfg.logFile === '' ? LOG_DEFAULT_FILE : cfg.logFile;
	// 诊断日志还跟记账共用一道闸：记账关掉的调用方（测试桩、一次性脚本）不该往
	// 用户的 ~/.dsh 里塞日志。DSH_LOOP_GUARD_LOG=0 则是显式的单独关掉。
	logEnabled = cfg.log !== false && cfgPersist;
	if (cfgPersist) {
		// A2：默认路径模式下，先把老的单文件存档搬到新路径（幂等、多进程只迁一次、异常不外抛）。
		migrateLegacyState(ctx);
		loadState(ctx);
	}

	// 记账：每个 usage 样本都是一次模型请求的账单。
	ctx.on('session/event', (session, event) => {
		try {
			const sessionId = String(session?.id ?? 'unknown');
			const ledger = ledgerOf(sessionId);
			learnSession(session);
			if (event?.type === 'user/message' && !['plugin', 'dsh-purge'].includes(event.data?.source?.kind)) features.humanTurn(sessionId);
			// 模型归属：从 request 事件记最近一次路由，估价按它选价目表（名字里含 pro → PRO 表）。
			if (event?.type === 'request/header') noteRoute(ledger, event?.data?.header?.config);
			else if (event?.type === 'request/context') noteRoute(ledger, event?.data);
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
			const costBefore = numberOr0(ledger.costCny);
			charge(sessionId, ledger, usage, turnOfEvent(event), cfg);
			features.daily.record({ id: sessionId, seq: event.seq, input: billedInputOf(usage), cached: numberOr0(usage.cacheReadTokens), uncached: numberOr0(usage.inputTokens) + numberOr0(usage.cacheWriteTokens), output: numberOr0(usage.outputTokens), cost: cfg.cost ? Math.max(0, numberOr0(ledger.costCny) - costBefore) : 0, child: isSubagentSession(session) });
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
			// 复活接着算（必须在 retired 那道守卫**之前**）：宿主崩溃 / 重启会把在跑的
			// 会话逐个注销过，它们的计数留在 disposed 里（并已落盘）。这里把 13 个计数字段
			// 整体拷回来，然后**不 return**，继续往下走 —— 恢复后 requests > 0，下面的
			// 「旧账金额补算」分支照旧判定并 return，所以既不会重放历史，也不会给祖先
			// 重复上卷。只从内存里取回：下一次 writeState 自然就把它从存档里摘掉了。
			//
			// 只有 requests === 0 时（这个会话从没记过账）才会落到重放路径 ——
			// 那时候本来就没有可重复计的东西。
			const parked = disposed.get(sessionId);
			if (parked !== undefined) {
				ledger.totalInput = parked.totalInput;
				ledger.familyInput = parked.familyInput;
				ledger.output = parked.output;
				ledger.requests = parked.requests;
				ledger.modelCalls = parked.modelCalls;
				ledger.toolCalls = parked.toolCalls;
				ledger.turn = parked.turn;
				ledger.turnInput = parked.turnInput;
				ledger.familyTurnInput = parked.familyTurnInput;
				ledger.cacheReadInput = parked.cacheReadInput;
				ledger.uncachedInput = parked.uncachedInput;
				ledger.costCny = parked.costCny;
				ledger.lastModel = parked.lastModel;
				// P0-1：门的记忆一起灌回来 —— 计数和「拦了没有」是同一件事的两半。
				// 少了这四行，同一 id 注销/复活一次就能把每道配额门的一次性豁免再领一遍、
				// 连拦计数从零数（宿主机重启会把在跑的会话逐个 disposed，所以这不是边角情况）。
				//
				// quotaExempted 必须是**独立的一次性豁免记录**，与 maxDenials / escape 无关
				// （见 quotaExempt 的注释）；escape 在原账本里就是普通对象（不是 Map），
				// 照原样并回来即可 —— escapeKeyFor 用 Object.keys 取插入顺序做 FIFO。
				ledger.quotaExempted = { ...parked.quotaExempted };
				Object.assign(ledger.escape, parked.escape);
				ledger.escapeSig = parked.escapeSig === '' ? undefined : parked.escapeSig;
				ledger.escapeSigUsed = parked.escapeSigUsed === true;
				disposed.delete(sessionId);
				const message = `会话复活，接着算：${sessionId} ← 退休前 计费输入 ${human(ledger.totalInput)} token、请求 ${ledger.requests} 次、轮次 ${ledger.turn}、金额 ¥${roundCny(ledger.costCny)}、配额豁免 ${Object.keys(ledger.quotaExempted).length} 项 / 逃生计数 ${Object.keys(ledger.escape).length} 条（不重放历史，也不给祖先重复上卷）`;
				log(ctx, 'info', message);
				fileLog('info', message);
			}
			// 「退休就不许重放」在这里收紧成「**没有可恢复的计数时**才不许重放」。
			//
			// 为什么不能写成 `if (retired.has(sessionId)) return;`：注销那一步是
			// 「先 park、再 retired.add」（见 session/disposed），所以**凡是有 parked 快照的
			// id 一定也在 retired 里** —— 照旧写法，恢复完立刻在这里被挡回去，下面那段
			// 「旧账金额补算」永远跑不到。而这一版要救的恰恰就是这批会话：本版装载之前就
			// 开始记账的会话（真机 session-751ec6e6… 累计 7765.2 万 token / 719 次请求），
			// 它们存档里的金额拆分全是 0，被注销 → park（快照里金额也是 0）→ 复活时 token
			// 总数回来了、金额仍是 0，徽标又是「会话 7765 万 · 消耗 ¥0.00」，而且**再没有
			// 第二次补算机会**。
			//
			// H1 的保护一点没变：只有 retired 名单、**没有** parked 快照的 id 依旧完全不重放。
			// 有快照的会话继续往下走：requests > 0 ⇒ 走金额补算（只补金额，token 一概不动）
			// 并 return；万一是 parked.requests === 0（该会话从没记过账），落到重放路径上
			// 也没有可重复计的东西。
			if (parked === undefined && retired.has(sessionId)) return;
			if (ledger.requests > 0) {
				// 旧账补算（只补金额，token 一概未动）：存档里已经在记账、却没有金额拆分的会话
				// ——那是本版装载之前就开始的账。**只在这些拆分真的全 0 时**补一次，
				// 补完照样 return：完整重放会把历史 token 再加一遍，那是双重计费。
				if (costEnabled && ledger.cacheReadInput + ledger.uncachedInput === 0) {
					const legacy = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : [];
					seedLegacyCost(ledger, legacy);
					const message = `旧账补算 会话 ${sessionId}：历史 ${legacy?.length ?? 0} 条 → cacheRead=${ledger.cacheReadInput} uncached=${ledger.uncachedInput} 金额=${roundCny(ledger.costCny)}（只补金额，token 一概未动）`;
					log(ctx, 'info', message);
					fileLog('info', message);
				}
				return;
			}
			const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : [];
			for (const event of events ?? []) {
				if (event?.type === 'request/header') noteRoute(ledger, event?.data?.header?.config);
				else if (event?.type === 'request/context') noteRoute(ledger, event?.data);
				if (event?.type === 'assistant/message') ledger.modelCalls += 1;
				if (event?.type === 'tool/call') noteToolCall(ledger, event);
				if (event?.type === 'tool/result') noteToolResult(ledger, event, cfg);
				const usage = usageOfEvent(event);
				if (usage !== undefined) charge(sessionId, ledger, usage, turnOfEvent(event), cfg);
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
			// E4：收尾写一条交账摘要（被拦 / 放行 / 豁免 / 请求数 / 轮次 / token 量）。
			// log 走宿主日志，fileLog 走诊断日志文件 —— 两边都要有，收尾数字才查得到。
			if (ledger !== undefined) {
				const summary = `[${id}] 会话收尾摘要：被拦 ${ledger.gateStats.denied} 次、逃生门放行 ${ledger.gateStats.released} 次、配额豁免 ${ledger.gateStats.exempted} 次；模型请求 ${ledger.requests} 次（modelCalls ${ledger.modelCalls}）、工具 ${ledger.toolCalls} 次；轮次 ${String(ledger.turn)}；累计计费输入 ${human(ledger.totalInput)} token、输出 ${human(ledger.output)} token`;
				log(ctx, 'info', summary);
				fileLog('info', summary);
			}
			// H2：死亡不是失忆 —— 把这份账本存进 disposed 再删内存。必须**先存后删**：
			// ledgers.delete 之后这里只剩 undefined，计数就再也找不回来了。
			// 同一个 session id 复活时 session/created 会把这些计数原样接回来
			// （不重放历史、也不给祖先重复上卷）。
			if (ledger !== undefined) {
				disposed.set(id, disposedSnapshot(ledger, Date.now()));
				while (disposed.size > DISPOSED_CAP) evictOldest(disposed, '已注销账本表');
			}
			ledgers.delete(id);
			childrenOf.delete(id);
			parents.delete(id);
			// H1：退休名单必须在 writeState **之前**记上 —— 否则这一次的退休身份没落盘，
			// 同一个 session id 重启后复活时，session/created 的两道守卫都会失效，
			// 于是整段历史被重放、历史每一笔 usage 再上卷一次给祖先（凭空多扣钱）。
			retired.add(id);
			// A3：满了按 FIFO 淘汰最旧一条。以前是整体 clear()：那会让**所有**已退休 id
			// 一起复活成新会话，而且和文件里其他表（签名表 / 骨架表）的淘汰原则不一致。
			while (retired.size > RETIRED_CAP) evictOldest(retired, '退休会话表');
			writeState();
		} catch {
			/* 清账失败不能影响别的东西 */
		}
	});

	// 核心：工具调用闸门（瀑布流，返回判定对象即否决）。
	ctx.on('tools/pre-execute', async (exec, next) => {
		try {
			const id = sessionIdOf(exec), tool = typeof exec?.name === 'string' ? exec.name : '';
			const settlement = NEVER_BLOCK.has(tool) || tool === '';
			const verdict = !settlement && features.daily.tripped() ? deny('今天的跨会话预算已到上限。请先汇报进度，或由用户修改每日预算。', 'LOOP_GUARD_DAILY_BUDGET', ledgerOf(id)) : judge(ctx, cfg, exec);
			features.recordCall(id, tool, verdict, settlement);
			if (verdict !== undefined) return verdict;
		} catch (error) {
			log(ctx, 'warn', `判定出错，放行：${error instanceof Error ? error.message : String(error)}`);
		}
		return next();
	});

	// 会话预算到线后不给开新轮（见 vetoNewTurn）；纯输出门命中时停止生成（见 pureTalkVeto）。
	//
	// **无条件注册**：vetoNewTurn 自己判断 trippedSession（原有语义没变，只是不再靠注册开关
	// 实现），纯输出门也走同一个口。以前整段被 `if (cfg.vetoNewTurn)` 包着，而这个开关默认 0，
	// 于是「停止生成」这条路径默认根本不存在 —— 纯输出门只能靠 tools/pre-execute 提醒模型（E1b）。
	ctx.on('agent/pre-step', async (payload, next) => {
		try {
			const verdict = vetoNewTurn(ctx, cfg, payload) ?? pureTalkVeto(ctx, cfg, payload);
			if (verdict !== undefined) return verdict;
		} catch (error) {
			log(ctx, 'warn', `新一轮判定出错，放行：${error instanceof Error ? error.message : String(error)}`);
		}
		return next();
	});

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
	const featureRoutes = ['/api/loop-guard/details', '/api/loop-guard/daily-limit'].map(route => ({ kind: 'exact', path: route, handler: (req, res) => handleFeatureRequest(req, res, features) }));
	const routes = [usageRoute, ...featureRoutes];
	const mountUsageRoute = (holder) => {
		const mount = () => { const disposers = routes.map(route => holder.register(route)); return () => disposers.forEach(dispose => { if (typeof dispose === 'function') dispose(); }); };
		if (typeof ctx?.effect === 'function') ctx.effect(mount, 'loop-guard: usage route');
		else mount();
	};
	try {
		if (typeof ctx?.inject === 'function') {
			ctx.inject(['webServer'], (webCtx) => {
				try {
					const webServer = webCtx?.webServer ?? webCtx?.reflect?.get?.('webServer');
					if (webServer === undefined || typeof webServer.register !== 'function') return;
					const mount = () => { const disposers = routes.map(route => webServer.register(route)); return () => disposers.forEach(dispose => { if (typeof dispose === 'function') dispose(); }); };
					if (typeof webCtx?.effect === 'function') webCtx.effect(mount, 'loop-guard: usage routes');
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
			`纯输出门 ${cfg.pureTalkGuard ? `开（一轮纯输出 ${human(cfg.pureTalkTokens)} token 触发）` : '关（只计数不拦）'}，` +
			`同错误「认不出工具名」分支连拦 ${cap(cfg.sameErrorUnknownLimit)} 次后受限降级；` +
			`软着陆 ${cfg.softLanding ? '开' : '关'}，跨重启记账 ${cfg.persist ? '开' : '关'}，` +
			`记账存档 ${cfg.persist ? STATE_FILE : '关'}，诊断日志 ${cfg.log ? cfg.logFile : '关'}` +
			(pendingLoadNote === '' ? '' : `；已从磁盘恢复 ${pendingLoadNote}`)
	);
}
