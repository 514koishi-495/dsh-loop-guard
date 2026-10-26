import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const GUARD_HUB = Symbol.for('dsh.loopGuard.state.v1');
const positive = value => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
const reasons = {
  LOOP_GUARD_DAILY_BUDGET: '今天的跨会话预算已用完，后续工作工具已暂停。',
  LOOP_GUARD_BUDGET_EXHAUSTED: '本轮预算已到上限。',
  LOOP_GUARD_SESSION_BUDGET: '当前会话的累计预算已到上限。',
  LOOP_GUARD_FAMILY_BUDGET: '当前会话与子代理的总预算已到上限。',
  LOOP_GUARD_REPEAT: '相同工具调用反复出现，已暂停继续重复。',
  LOOP_GUARD_SAME_ERROR: '同一个错误反复出现，建议先处理错误原因。',
  LOOP_GUARD_CYCLE: '工具调用正在来回循环。',
  LOOP_GUARD_SKELETON: '工具参数虽有变化，执行的操作仍在重复。',
  LOOP_GUARD_SOFT_LANDING: '预算已到上限，目前仅保留收尾能力。',
  LOOP_GUARD_SETTLE_REQUIRED: '长时间持续输出但没有执行工作，已提醒收尾。',
};

export class DailyLedger {
  constructor({ file, persist = true, now = () => Date.now(), timeZone, limitOverride, costEnabled = true } = {}) {
    this.file = file; this.persist = persist && !!file; this.now = now; this.timeZone = timeZone;
    this.limitOverride = limitOverride; this.error = ''; this.state = { version: 1, startedAt: now(), limit: 0, days: {} };
    this.costEnabled = costEnabled;
    if (this.persist && fs.existsSync(file)) {
      try {
        const saved = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
        if (saved.version !== 1 || !saved.days || typeof saved.days !== 'object' || Array.isArray(saved.days)) throw new Error('invalid daily ledger');
        this.state.startedAt = positive(saved.startedAt) || now(); this.state.limit = positive(saved.limit);
        for (const key of Object.keys(saved.days).filter(key => /^\d{4}-\d{2}-\d{2}$/.test(key)).sort().slice(-8)) {
          const day = saved.days[key];
          if (!day || !Number.isFinite(day.totalInput) || !day.rows || Array.isArray(day.rows) || typeof day.rows !== 'object') continue;
          const rows = Object.create(null);
          for (const [id, row] of Object.entries(day.rows).slice(-500)) if (row && typeof row === 'object') rows[id] = { input: positive(row.input), cached: positive(row.cached), uncached: positive(row.uncached), output: positive(row.output), cost: positive(row.cost), seq: positive(row.seq), child: row.child === true };
          this.state.days[key] = { totalInput: positive(day.totalInput), cached: positive(day.cached), uncached: positive(day.uncached), output: positive(day.output), cost: positive(day.cost), rows };
        }
      } catch { this.error = '每日账本无法读取；请检查备份后再修复，当前仅记录新收到的用量。'; }
    }
  }
  key() {
    try { const parts = new Intl.DateTimeFormat('en-CA', { timeZone: this.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(this.now()); return ['year', 'month', 'day'].map(key => parts.find(part => part.type === key).value).join('-'); }
    catch { const d = new Date(this.now()); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
  }
  today() {
    const key = this.key();
    if (!Object.hasOwn(this.state.days, key)) this.state.days[key] = { totalInput: 0, cached: 0, uncached: 0, output: 0, cost: 0, rows: Object.create(null) };
    const keep = new Set([...Object.keys(this.state.days).filter(day => day !== key).sort().slice(-7), key]);
    for (const old of Object.keys(this.state.days)) if (!keep.has(old)) delete this.state.days[old];
    return this.state.days[key];
  }
  limit() { return this.limitOverride === undefined ? this.state.limit : positive(this.limitOverride); }
  setLimit(value) {
    if (this.limitOverride !== undefined) throw new Error('每日预算由设置或环境变量指定，请从原设置修改。');
    if (!Number.isSafeInteger(value) || value < 0 || value > 1e15) throw new Error('请输入不小于零的整数。');
    this.state.limit = value; this.save();
  }
  tripped() { return this.limit() > 0 && this.today().totalInput >= this.limit(); }
  record({ id, seq, input, cached, uncached, output, cost = 0, child = false }) {
    const day = this.today();
    const key = String(id).slice(0, 256);
    let row = Object.hasOwn(day.rows, key) ? day.rows[key] : undefined;
    if (row && positive(seq) > 0 && positive(seq) <= row.seq) return false;
    if (!row) {
      while (Object.keys(day.rows).length >= (day.rows._other ? 500 : 499)) {
        const oldest = Object.keys(day.rows).find(value => value !== '_other');
        const previous = day.rows[oldest]; delete day.rows[oldest];
        const other = day.rows._other || { input: 0, cached: 0, uncached: 0, output: 0, cost: 0, seq: 0, child: false };
        for (const field of ['input', 'cached', 'uncached', 'output', 'cost']) other[field] += positive(previous?.[field]);
        day.rows._other = other;
      }
      row = day.rows[key] = { input: 0, cached: 0, uncached: 0, output: 0, cost: 0, seq: 0, child: !!child };
    }
    for (const [field, value] of Object.entries({ input, cached, uncached, output, cost })) {
      row[field] += positive(value); const total = field === 'input' ? 'totalInput' : field; day[total] += positive(value);
    }
    row.seq = Math.max(row.seq, positive(seq)); this.save(); return true;
  }
  save() {
    if (!this.persist) return;
    const temp = this.file + '.' + process.pid + '.' + randomUUID() + '.tmp';
    try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(temp, JSON.stringify(this.state), { flag: 'wx' }); fs.renameSync(temp, this.file); }
    catch { this.error = '每日账本保存失败；当前内存计数仍在，重启后可能无法恢复。'; }
    finally { try { fs.unlinkSync(temp); } catch {} }
  }
  snapshot() {
    const day = this.today();
    return { day: this.key(), startedAt: this.state.startedAt, totalInput: day.totalInput, cached: day.cached, uncached: day.uncached, output: day.output, ...(this.costEnabled ? { estimatedCostCny: day.cost } : {}), limit: this.limit(), limitLocked: this.limitOverride !== undefined, tripped: this.tripped(), error: this.error,
      ranking: Object.entries(day.rows).sort((a, b) => b[1].input - a[1].input).slice(0, 8).map(([id, row]) => ({ id, label: id === '_other' ? '其他会话合计' : (row.child ? '子代理 ' : '会话 ') + id.slice(-8), input: row.input, cached: row.cached, ...(this.costEnabled ? { estimatedCostCny: row.cost } : {}) })) };
  }
}

export function createGuardFeatures(options) {
  const daily = new DailyLedger(options), denials = [], recent = new Map(), blocked = new Map();
  const instance = randomUUID(); let nextId = 0;
  function recordCall(id, tool, verdict, settlement = false) {
    const history = recent.get(id) || []; history.push({ tool: String(tool || '').slice(0, 64), at: daily.now() }); if (history.length > 8) history.shift(); recent.set(id, history);
    while (recent.size > 500) recent.delete(recent.keys().next().value);
    if (!verdict || verdict.kind !== 'deny') { if (!settlement && tool) blocked.delete(id); return; }
    const code = String(verdict.info?.code || 'LOOP_GUARD_DENIED');
    const old = blocked.get(id);
    if (old?.code === code) { old.count++; return; }
    const notice = { id: instance + ':' + (++nextId), at: daily.now(), sessionId: id, code, message: reasons[code] || '守卫暂停了异常或超出配额的调用，请查看运行状态。', tool: String(tool || '').slice(0, 64), count: 1 };
    blocked.set(id, notice); denials.push(notice); if (denials.length > 30) denials.shift();
    while (blocked.size > 500) blocked.delete(blocked.keys().next().value);
  }
  const paused = id => {
    if (daily.tripped()) return { blocked: true, code: 'LOOP_GUARD_DAILY_BUDGET', message: reasons.LOOP_GUARD_DAILY_BUDGET };
    const value = blocked.get(id);
    return value && value.code !== 'LOOP_GUARD_DAILY_BUDGET' ? { blocked: true, code: value.code, message: value.message } : { blocked: false };
  };
  const hub = { paused };
  return { daily, hub, recordCall, humanTurn(id) { blocked.delete(id); }, snapshot(id = '') { return { daily: daily.snapshot(), notices: denials.filter(value => !id || value.sessionId === id).slice(-8).map(value => ({ ...value })), recentTools: (recent.get(id) || []).map(value => ({ ...value })) }; } };
}

export function sameOriginRequest(req) {
  if (req.headers?.['sec-fetch-site'] === 'cross-site') return false;
  const origin = req.headers?.origin;
  if (!origin) return true;
  try { return new URL(origin).host.toLowerCase() === String(req.headers?.host || '').toLowerCase(); } catch { return false; }
}

export async function handleFeatureRequest(req, res, features) {
  const send = (status, body) => { res.statusCode = status; res.setHeader('content-type', 'application/json; charset=utf-8'); res.setHeader('cache-control', 'no-store'); res.end(JSON.stringify(body)); };
  if (!sameOriginRequest(req)) { send(403, { ok: false, error: '请从当前 DeepSeek 窗口操作。' }); return; }
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/api/loop-guard/details') { send(200, { ok: true, ...features.snapshot((url.searchParams.get('sessionId') || '').slice(0, 256)) }); return; }
  if (req.method !== 'POST' || url.pathname !== '/api/loop-guard/daily-limit') { send(405, { ok: false, error: 'method-not-allowed' }); return; }
  try {
    if (!String(req.headers?.['content-type'] || '').startsWith('application/json')) { send(415, { ok: false, error: 'application/json required' }); return; }
    let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 4096) throw new Error('请求过大。'); }
    const input = JSON.parse(body); features.daily.setLimit(input.limit);
    send(200, { ok: true, daily: features.daily.snapshot() });
  } catch (error) { send(400, { ok: false, error: String(error.message || error) }); }
}
