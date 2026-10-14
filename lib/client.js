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
			"badge.aria": "预算用量",
			"badge.title": "会话累计输入 {sessionInput} token · 本轮（含子代理）{turnInput} token",
			"badge.tripped.turn": "本轮预算已到线",
			"badge.tripped.session": "会话预算已到线",
			"badge.tripped.family": "子代理家族预算已到线"
		};
		const en = {
			"badge.session": "Session",
			"badge.turn": "Turn",
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
				trippedTurn: tripped.turn === true,
				trippedSession: tripped.session === true,
				trippedFamily: tripped.family === true
			};
		}
		//#endregion

		//#region badge component
		/**
		 * Header badge: this session's billed input tokens, re-fetched every
		 * 1.5s. `sessionId` is supplied by the slot host, `t` by the `locale`
		 * dictionary registered below. Failures render nothing at all, and the
		 * poll backs off to 10s while the endpoint stays unhappy.
		 */
		function LoopGuardUsageBadge({ sessionId, t }) {
			const translate = (key, params) => interpolate(typeof t === "function" ? t(key) : zh[key] ?? key, params);
			/** `{ sessionId, data }` — the session a payload belongs to travels with it. */
			const [state, setState] = react.useState(null);

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
					controller = new AbortController();
					try {
						const response = await fetch(`${USAGE_PATH}?sessionId=${encodeURIComponent(sessionId)}`, {
							signal: controller.signal,
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
			const title = [
				translate("badge.title", {
					sessionInput: groupThousands(usage.sessionInput),
					turnInput: groupThousands(usage.turnInput)
				}),
				reasons.length > 0 ? reasons.join(" · ") : null
			].filter((entry) => entry !== null).join(" · ");
			return react_jsx_runtime.jsx("span", {
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
				children: [
					react_jsx_runtime.jsxs("span", { children: [translate("badge.session"), " ", formatTokens(usage.sessionInput)] }, "session"),
					react_jsx_runtime.jsx("span", { children: "·" }, "separator"),
					react_jsx_runtime.jsxs("span", { children: [translate("badge.turn"), " ", formatTokens(usage.turnInput)] }, "turn")
				]
			});
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
		exports.readUsage = readUsage;
		return module.exports;
	}
});
