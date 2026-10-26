/**
 * dsh-loop-guard — browser half.
 *
 * Hand-written `__ModuleLoader__` bundle (no build step): one compact badge in
 * the session header's action row showing this session's billed input tokens
 * (session total · current turn, subagents included). Data comes from the
 * server half's same-origin `GET /api/loop-guard/usage` endpoint, polled every
 * 1.5s with a simple backoff. Any failure renders nothing: a guard's badge must
 * never be the thing that breaks a session header.
 */
window.__ModuleLoader__.load({
	id: "dsh-loop-guard",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");

		//#region constants
		const NS = "loop-guard";
		const USAGE_PATH = "/api/loop-guard/usage";
		/** Poll cadence while the endpoint answers, and the backoff ceiling after failures. */
		const POLL_MS = 1500;
		const POLL_MAX_MS = 10000;
		/** A poll that neither answers nor fails must not wedge the badge: give up on it after this. */
		const FETCH_TIMEOUT_MS = 10000;
		/** Flip to true to trace poll failures in the console; off by default. */
		const DEBUG = false;
		//#endregion

		//#region formatting
		/** Group thousands for the hover title. */
		function groupThousands(value) {
			return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
		}

		/** Compact form: `999` → "999", `12345` → "12.3K", `1.6e6` → "1.6M", `2.5e9` → "2.5B". */
		function formatTokens(value) {
			const n = typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
			if (n < 1000) return String(n);
			if (n < 1000000) return `${(n / 1000).toFixed(1)}K`;
			if (n < 1000000000) return `${(n / 1000000).toFixed(1)}M`;
			return `${(n / 1000000000).toFixed(1)}B`;
		}

		/** Estimated spend: two decimals behind a yuan sign — `0.02` → "¥0.02", `12.34` → "¥12.34". */
		function formatCny(value) {
			const n = typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
			return `¥${n.toFixed(2)}`;
		}

		/** Locale-safe template interpolation: `translate("key", {a})` replaces `{a}`. */
		function interpolate(template, params) {
			if (typeof template !== "string" || params === void 0) return template;
			return template.replace(/\{(\w+)\}/g, (match, key) => (Object.hasOwn(params, key) ? String(params[key]) : match));
		}
		//#endregion

		//#region dictionaries
		const zh = {
			"badge.session": "会话",
			"badge.turn": "本轮",
			"badge.cost": "消耗",
			"badge.costTitle": "估算 {cny}",
			"badge.round": "第 {n} 轮",
			"badge.aria": "预算用量",
			"badge.title": "会话累计输入 {sessionInput} token · 本轮（含子代理）{turnInput} token",
			"badge.tripped.turn": "本轮预算已到线",
			"badge.tripped.session": "会话预算已到线",
			"badge.tripped.family": "子代理家族预算已到线"
		};
		const en = {
			"badge.session": "Session",
			"badge.turn": "Turn",
			"badge.cost": "Cost",
			"badge.costTitle": "estimate {cny}",
			"badge.round": "round {n}",
			"badge.aria": "Budget usage",
			"badge.title": "Session input {sessionInput} tokens · this turn, subagents included {turnInput} tokens",
			"badge.tripped.turn": "turn budget reached",
			"badge.tripped.session": "session budget reached",
			"badge.tripped.family": "subagent-family budget reached"
		};
		//#endregion

		//#region usage payload
		/** Tolerant number read: a missing or non-numeric counter reads as 0. */
		function numberOr0(value) {
			return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
		}

		/**
		 * Estimated spend out of a payload's `cost` block, or null when there is
		 * none — an older server, or `DSH_LOOP_GUARD_COST` turned off. Absent
		 * means "render no cost at all", never a zero.
		 */
		function readCost(raw) {
			if (raw === null || typeof raw !== "object") return null;
			if (typeof raw.cny !== "number" || !Number.isFinite(raw.cny)) return null;
			return {
				cny: Math.max(0, raw.cny),
				model: typeof raw.model === "string" ? raw.model : "",
				pricesAsOf: typeof raw.pricesAsOf === "string" ? raw.pricesAsOf : ""
			};
		}

		/**
		 * Pick the headline counters out of a usage payload, or null when the
		 * payload is not a usable one. The server half owns the shape; the
		 * fields may all be absent while it is not mounted yet.
		 */
		function readUsage(payload) {
			if (payload === null || typeof payload !== "object" || payload.ok !== true) return null;
			const session = payload.session !== null && typeof payload.session === "object" ? payload.session : {};
			const turn = payload.turn !== null && typeof payload.turn === "object" ? payload.turn : {};
			const tripped = payload.tripped !== null && typeof payload.tripped === "object" ? payload.tripped : {};
			return {
				sessionInput: numberOr0(session.totalInput),
				turnInput: numberOr0(turn.total),
				// The turn number the host stamped on the request — the same counter the
				// context window itself advances by. 0 means "no turn charged yet".
				turnNo: numberOr0(session.turn),
				cost: readCost(payload.cost),
				trippedTurn: tripped.turn === true,
				trippedSession: tripped.session === true,
				trippedFamily: tripped.family === true
			};
		}
		//#endregion

		//#region badge component
		function GuardDetails({ sessionId }) {
			const h = react.createElement;
			const [data, setData] = react.useState(null), [error, setError] = react.useState(""), [limit, setLimit] = react.useState(null), [saving, setSaving] = react.useState(false);
			react.useEffect(() => {
				let stopped = false, controller = null, inFlight = false;
				const load = async () => {
					if (inFlight) return; inFlight = true; controller = new AbortController();
					const timeout = window.setTimeout(() => controller?.abort(), 8000);
					try { const response = await fetch("/api/loop-guard/details?sessionId=" + encodeURIComponent(sessionId), { cache: "no-store", signal: controller.signal }); if (!response.ok) throw new Error(response.status === 404 ? "请重启 DeepSeek 加载用量详情。" : "用量详情暂时无法读取。"); const next = await response.json(); if (!stopped) { setData(next); setError(""); setLimit(value => value === null ? String(next.daily.limit) : value); } }
					catch (failure) { if (!stopped) setError(String(failure.message || failure)); }
					finally { window.clearTimeout(timeout); inFlight = false; }
				};
				void load(); const timer = window.setInterval(load, 3000);
				return () => { stopped = true; window.clearInterval(timer); controller?.abort(); };
			}, [sessionId]);
			const save = async event => {
				event.preventDefault(); setSaving(true);
				try { const response = await fetch("/api/loop-guard/daily-limit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ limit: Number(limit) }) }); const result = await response.json(); if (!response.ok) throw new Error(result.error || "保存失败。"); setData(old => ({ ...old, daily: result.daily })); setError("已保存每日预算。"); }
				catch (failure) { setError(String(failure.message || failure)); } finally { setSaving(false); }
			};
			const section = { margin: "12px 0 0", paddingTop: 10, borderTop: "1px solid #8884" };
			const day = data?.daily, latest = data?.notices?.slice(-1)[0];
			return h("div", { role: "region", "aria-label": "预算与拦截详情", style: { position: "absolute", right: 0, top: "100%", marginTop: 8, width: "min(360px, calc(100vw - 24px))", maxHeight: "65vh", overflowY: "auto", zIndex: 1000, padding: 16, borderRadius: 10, border: "1px solid #8886", boxShadow: "0 8px 24px #0002", background: "var(--dsw-alias-bg-base, Canvas)", color: "var(--dsw-alias-label-primary, CanvasText)", fontSize: 12, lineHeight: 1.6, whiteSpace: "normal" } },
				h("strong", { style: { fontSize: 14 } }, "预算与拦截详情"),
				h("div", { "aria-live": "polite" }, error || (!data ? "正在读取…" : "")),
				day ? h("section", { style: section }, h("strong", null, "今日全部会话"), h("div", null, day.day + "　" + formatTokens(day.totalInput) + " token"), day.limit > 0 ? h("progress", { value: day.totalInput, max: day.limit, "aria-label": "每日预算已用比例", style: { width: "100%", accentColor: day.tripped ? "#BA4141" : "#316FC4" } }) : null,
					h("form", { onSubmit: save, style: { display: "flex", gap: 7, alignItems: "center", marginTop: 8 } }, h("label", null, "每日上限 ", h("input", { type: "number", min: 0, step: 1, value: limit ?? "", disabled: day.limitLocked || saving, onChange: event => setLimit(event.target.value), "aria-label": "每日 token 上限，零表示不限", style: { width: 120, font: "inherit", color: "inherit", background: "transparent", border: "1px solid #8886", borderRadius: 5, padding: 4 } })), h("button", { type: "submit", disabled: day.limitLocked || saving, style: { font: "inherit", padding: "4px 9px" } }, saving ? "保存中…" : "保存")),
					h("p", { style: { opacity: .72, margin: "6px 0 0" } }, day.limitLocked ? "上限由插件设置或环境变量指定。" : "零表示不限。仅统计此功能启用后收到的实时用量。"),
					day.error ? h("p", { role: "status" }, day.error) : null) : null,
				day ? h("section", { style: section }, h("strong", null, "消耗构成"), h("div", null, "缓存输入 " + formatTokens(day.cached) + "　其他输入 " + formatTokens(day.uncached)), h("div", null, "输出 " + formatTokens(day.output) + (typeof day.estimatedCostCny === "number" ? "　估算 " + formatCny(day.estimatedCostCny) : "")), h("ol", { style: { paddingLeft: 20, marginBottom: 0 } }, ...day.ranking.map(row => h("li", { key: row.id }, row.label + "：" + formatTokens(row.input) + " token")))) : null,
				h("section", { style: section }, h("strong", null, "当前会话的拦截原因"), h("p", { style: { margin: "6px 0" } }, latest ? latest.message + "　累计 " + latest.count + " 次。" : "暂时没有拦截记录。"), data?.recentTools?.length ? h("div", { style: { opacity: .72 } }, "最近工具：" + data.recentTools.map(item => item.tool || "文本输出").join(" → ")) : null));
		}
		/**
		 * Header badge: this session's billed input tokens, re-fetched every
		 * 1.5s, plus the estimated spend when the payload carries a cost. The
		 * cost segment is absent — not blank — while the endpoint sends none.
		 * `sessionId` is supplied by the slot host, `t` by the `locale`
		 * dictionary registered below. Failures render nothing at all, and the
		 * poll backs off to 10s while the endpoint stays unhappy.
		 */
		function LoopGuardUsageBadge({ sessionId, t }) {
			const translate = (key, params) => interpolate(typeof t === "function" ? t(key) : zh[key] ?? key, params);
			/** `{ sessionId, data }` — the session a payload belongs to travels with it. */
			const [state, setState] = react.useState(null);
			const [detailsOpen, setDetailsOpen] = react.useState(false);

			react.useEffect(() => {
				if (typeof sessionId !== "string" || sessionId === "") {
					setState(null);
					return void 0;
				}
				let cancelled = false;
				let inFlight = false;
				let failures = 0;
				let delay = POLL_MS;
				let timer = null;
				let controller = null;

				/** Re-arm the interval at the current delay; called after every attempt. */
				const arm = () => {
					if (cancelled) return;
					if (timer !== null) window.clearInterval(timer);
					timer = window.setInterval(() => { void load(); }, delay);
				};

				const load = async () => {
					if (cancelled || inFlight) return;
					inFlight = true;
					const attempt = new AbortController();
					controller = attempt;
					// A hung endpoint never settles the fetch, so the `finally` below would
					// never run and `inFlight` would stay true forever — abort it instead and
					// let it take the ordinary failure path.
					const guard = window.setTimeout(() => { attempt.abort(); }, FETCH_TIMEOUT_MS);
					try {
						const response = await fetch(`${USAGE_PATH}?sessionId=${encodeURIComponent(sessionId)}`, {
							signal: attempt.signal,
							headers: { accept: "application/json" }
						});
						if (!response.ok) throw new Error(`HTTP ${response.status}`);
						const next = readUsage(await response.json());
						if (next === null) throw new Error("unusable payload");
						if (cancelled) return;
						failures = 0;
						delay = POLL_MS;
						setState({ sessionId, data: next });
					} catch (error) {
						if (cancelled) return;
						failures += 1;
						delay = Math.min(POLL_MS * 2 ** Math.min(failures, 6), POLL_MAX_MS);
						setState(null);
						if (DEBUG) console.debug("[loop-guard] usage poll failed", error);
					} finally {
						window.clearTimeout(guard);
						inFlight = false;
						controller = null;
						arm();
					}
				};

				void load();
				arm();
				return () => {
					cancelled = true;
					if (timer !== null) window.clearInterval(timer);
					if (controller !== null) controller.abort();
				};
			}, [sessionId]);

			// A payload stamped with another session is stale: render nothing instead
			// of the previous session's numbers while the new poll is still in flight.
			const usage = state !== null && state.sessionId === sessionId ? state.data : null;
			if (usage === null) return null;
			const tripped = usage.trippedTurn || usage.trippedSession || usage.trippedFamily;
			const reasons = [
				usage.trippedTurn ? translate("badge.tripped.turn") : null,
				usage.trippedSession ? translate("badge.tripped.session") : null,
				usage.trippedFamily ? translate("badge.tripped.family") : null
			].filter((entry) => entry !== null);
			const cost = usage.cost;
			// The turn the context is currently on. Absent until the host charges a
			// first request, so 0 renders nothing rather than "第 0 轮".
			const round = usage.turnNo >= 1 ? usage.turnNo : null;
			const title = [
				translate("badge.title", {
					sessionInput: groupThousands(usage.sessionInput),
					turnInput: groupThousands(usage.turnInput)
				}),
				round !== null ? translate("badge.round", { n: round }) : null,
				reasons.length > 0 ? reasons.join(" · ") : null,
				cost !== null ? translate("badge.costTitle", { cny: formatCny(cost.cny) }) : null
			].filter((entry) => entry !== null).join(" · ");
			const cells = [
				react_jsx_runtime.jsxs("span", { children: [translate("badge.session"), " ", formatTokens(usage.sessionInput)] }, "session"),
				react_jsx_runtime.jsx("span", { children: "·" }, "separator"),
				react_jsx_runtime.jsxs("span", { children: [translate("badge.turn"), " ", formatTokens(usage.turnInput)] }, "turn")
			];
			// Two optional segments, each carrying its own separator: a segment that
			// does not render must not leave a dangling dot behind it. The round comes
			// before the spend — the badge reads scale first, then what it cost.
			if (round !== null) {
				cells.push(react_jsx_runtime.jsx("span", { children: "·" }, "round-separator"));
				cells.push(react_jsx_runtime.jsx("span", { children: translate("badge.round", { n: round }) }, "round"));
			}
			if (cost !== null) {
				cells.push(react_jsx_runtime.jsx("span", { children: "·" }, "cost-separator"));
				cells.push(react_jsx_runtime.jsxs("span", { children: [translate("badge.cost"), " ", formatCny(cost.cny)] }, "cost"));
			}
			const badge = react_jsx_runtime.jsx("span", {
				className: "dsh-loop-guard-badge",
				title,
				"data-tripped": tripped ? "true" : "false",
				"aria-label": `${translate("badge.aria")} ${title}`,
				style: {
					display: "inline-flex",
					alignItems: "center",
					gap: "4px",
					height: "20px",
					padding: "0 6px",
					borderRadius: "6px",
					fontSize: "11px",
					lineHeight: "20px",
					fontVariantNumeric: "tabular-nums",
					whiteSpace: "nowrap",
					color: tripped ? "var(--dsw-alias-state-error-primary)" : "var(--dsw-alias-label-tertiary)"
				},
				children: cells
			});
			return react.createElement("details", { className: "dsh-loop-guard-details", style: { position: "relative", display: "inline-block" }, onToggle: event => setDetailsOpen(event.currentTarget.open), onKeyDown: event => { if (event.key === "Escape") { event.currentTarget.open = false; setDetailsOpen(false); } } }, react.createElement("summary", { style: { cursor: "pointer", listStyle: "none" }, "aria-label": "展开预算与拦截详情" }, badge), detailsOpen ? react.createElement(GuardDetails, { sessionId }) : null);
		}
		//#endregion

		//#region plugin body
		/** Services required by the client plugin body. */
		const inject = ["slots", "locale"];

		/**
		 * Client plugin body: register the dictionaries and the header badge.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "loop-guard: dictionaries");
			ctx.effect(() => ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
				name: "conversation.session.header.actions",
				id: "loop-guard",
				order: 60,
				locale: NS
			}, LoopGuardUsageBadge)), "loop-guard: usage badge");
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		exports.LoopGuardUsageBadge = LoopGuardUsageBadge;
		exports.formatTokens = formatTokens;
		exports.formatCny = formatCny;
		exports.readUsage = readUsage;
		exports.readCost = readCost;
		return module.exports;
	}
});
