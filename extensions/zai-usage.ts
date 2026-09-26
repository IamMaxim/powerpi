/**
 * Z.AI GLM Coding Plan quota in the footer status line: plan tier plus the
 * 5-hour rolling window and weekly quota percentages, taken straight from
 * the server (`GET /api/monitor/usage/quota/limit`, Bearer key) so they are
 * accurate across devices and tools. The line goes through ctx.ui.setStatus;
 * pi-open-tui renders those in its extension-status footer segment.
 *
 * The endpoint backs Z.AI's own console and is not in the public API docs.
 * Current plans report CREDIT_LIMIT entries (credits system), legacy ones
 * TOKENS_LIMIT — both are parsed, distinguished by unit: 3 = 5-hour window,
 * 6 = weekly. TIME_LIMIT (tool/search quota) is shown when present.
 * Percentages are recomputed from used/total because the API rounds small
 * values up to 1%.
 *
 * Refresh triggers: session start, after each assistant message (throttled
 * to one request per 30s), and every 2 minutes while idle (windows slide,
 * resets land). Active only when a UI is attached (ctx.hasUI) so powersa
 * one-shots make no extra network calls.
 *
 * `/zai-usage` toggles a detail widget: credits used/total per window, reset
 * countdowns, tool quota, fetch age.
 *
 * Env:
 *   $POWERPI_ZAI_USAGE_BASE      quota host override (default: provider-aware
 *                                api.z.ai, or open.bigmodel.cn for *-cn/bigmodel providers)
 *   $POWERPI_ZAI_USAGE_PROVIDER  provider id whose key is used (default "zai")
 */
import type { ExtensionAPI, ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "zai-usage";
const WIDGET_KEY = "zai-usage";
const FETCH_TIMEOUT_MS = 15_000;
const MESSAGE_THROTTLE_MS = 30_000;
const PERIODIC_REFRESH_MS = 120_000;

export interface QuotaLimit {
	used: number;
	total: number;
	percentage: number;
	resetMs: number | null;
}

export interface ZaiQuota {
	level: string | null;
	fiveHour: QuotaLimit | null;
	weekly: QuotaLimit | null;
	tools: QuotaLimit | null;
	windowHours: number;
	queriedAt: number;
}

interface RawLimit {
	type?: string;
	unit?: number;
	number?: number;
	usage?: number;
	currentValue?: number;
	percentage?: number;
	nextResetTime?: number | string;
}

function toLimit(lim: RawLimit): QuotaLimit {
	const used = Number(lim.currentValue) || 0;
	const total = Number(lim.usage) || 0;
	const reset =
		typeof lim.nextResetTime === "number"
			? lim.nextResetTime
			: typeof lim.nextResetTime === "string"
				? Date.parse(lim.nextResetTime)
				: null;
	return {
		used,
		total,
		// The API's own percentage rounds sub-1% values up; use it only as a
		// fallback when no total is reported to divide by.
		percentage: total > 0 ? (used / total) * 100 : Number(lim.percentage) || 0,
		resetMs: Number.isNaN(reset) ? null : reset,
	};
}

/** Parses the quota endpoint response body; null when it carries no usable data. */
export function parseZaiQuota(body: unknown, queriedAt = Date.now()): ZaiQuota | null {
	const data = (body as { success?: boolean; data?: { level?: unknown; limits?: unknown } })?.data;
	if (!data || !Array.isArray(data.limits)) return null;

	let fiveHour: QuotaLimit | null = null;
	let weekly: QuotaLimit | null = null;
	let tools: QuotaLimit | null = null;
	let windowHours = 5;
	for (const raw of data.limits as RawLimit[]) {
		const tokensLike = raw.type === "CREDIT_LIMIT" || raw.type === "TOKENS_LIMIT";
		if (tokensLike && raw.unit === 3 && !fiveHour) {
			fiveHour = toLimit(raw);
			windowHours = Number(raw.number) || 5;
		} else if (tokensLike && raw.unit === 6 && !weekly) {
			weekly = toLimit(raw);
		} else if (raw.type === "TIME_LIMIT" && !tools) {
			tools = toLimit(raw);
		}
	}
	return {
		level: typeof data.level === "string" && data.level ? data.level : null,
		fiveHour,
		weekly,
		tools,
		windowHours,
		queriedAt,
	};
}

export async function fetchZaiQuota(baseUrl: string, apiKey: string): Promise<ZaiQuota | null> {
	let resp: Response;
	try {
		resp = await fetch(`${baseUrl}/api/monitor/usage/quota/limit`, {
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
				"Accept-Language": "en-US,en",
			},
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
	} catch {
		return null;
	}
	if (!resp.ok) return null;
	try {
		return parseZaiQuota(await resp.json());
	} catch {
		return null;
	}
}

export function formatPct(pct: number): string {
	return `${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`;
}

/** Compact countdown: "45m", "1h22m", "3d4h". */
export function formatCountdown(msRemaining: number): string {
	const minutes = Math.max(0, Math.round(msRemaining / 60_000));
	const days = Math.floor(minutes / 1440);
	const hours = Math.floor((minutes % 1440) / 60);
	const mins = minutes % 60;
	if (days > 0) return mins > 0 ? `${days}d${hours}h` : `${days}d${hours > 0 ? `${hours}h` : ""}`;
	if (hours > 0) return `${hours}h${mins > 0 ? `${mins}m` : ""}`;
	return `${mins}m`;
}

/** Footer status text, e.g. "z.ai max: 5h 0.4% · wk 0.1%". */
export function usageStatusText(quota: ZaiQuota): string {
	const parts: string[] = [];
	if (quota.fiveHour) parts.push(`${quota.windowHours}h ${formatPct(quota.fiveHour.percentage)}`);
	if (quota.weekly) parts.push(`wk ${formatPct(quota.weekly.percentage)}`);
	if (quota.tools) parts.push(`tools ${formatPct(quota.tools.percentage)}`);
	if (parts.length === 0) return "z.ai";
	const prefix = quota.level ? `z.ai ${quota.level}: ` : "z.ai: ";
	return prefix + parts.join(" · ");
}

type ThemeLike = Pick<Theme, "fg">;

function limitLine(label: string, limit: QuotaLimit, theme: ThemeLike, now: number): string {
	const stress: ThemeColor = limit.percentage >= 90 ? "error" : limit.percentage >= 70 ? "warning" : "success";
	const credits =
		limit.total > 0 ? ` (${limit.used.toLocaleString("en-US")} / ${limit.total.toLocaleString("en-US")} cr)` : "";
	const reset = limit.resetMs !== null ? ` · resets in ${formatCountdown(limit.resetMs - now)}` : "";
	return `${theme.fg("dim", `${label}: `)}${theme.fg(stress, `${formatPct(limit.percentage)} used`)}${theme.fg("dim", `${credits}${reset}`)}`;
}

/** Detail widget lines for `/zai-usage`. */
export function widgetLines(quota: ZaiQuota, theme: ThemeLike, now = Date.now()): string[] {
	const lines = [theme.fg("accent", `Z.AI Coding Plan${quota.level ? ` — ${quota.level}` : ""}`)];
	if (quota.fiveHour) lines.push(limitLine(`${quota.windowHours}h window`, quota.fiveHour, theme, now));
	if (quota.weekly) lines.push(limitLine("weekly", quota.weekly, theme, now));
	if (quota.tools) lines.push(limitLine("tools", quota.tools, theme, now));
	lines.push(theme.fg("dim", `fetched ${formatCountdown(now - quota.queriedAt)} ago`));
	return lines;
}

type QuotaContext = Pick<ExtensionContext, "ui" | "model" | "hasUI"> & {
	modelRegistry?: { getApiKeyForProvider(provider: string): Promise<string | undefined> };
};

function quotaBaseUrl(ctx: QuotaContext): string {
	if (process.env["POWERPI_ZAI_USAGE_BASE"]) return process.env["POWERPI_ZAI_USAGE_BASE"];
	const provider = ctx.model?.provider ?? "";
	return provider.includes("cn") || provider.includes("bigmodel")
		? "https://open.bigmodel.cn"
		: "https://api.z.ai";
}

async function resolveApiKey(ctx: QuotaContext): Promise<string | undefined> {
	const provider = process.env["POWERPI_ZAI_USAGE_PROVIDER"] ?? "zai";
	try {
		const key = await ctx.modelRegistry?.getApiKeyForProvider(provider);
		if (key) return key;
	} catch {
		// Fall through to the environment.
	}
	return process.env["ZAI_API_KEY"];
}

export default function zaiUsage(pi: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | undefined;
	let widgetOpen = false;
	let quota: ZaiQuota | null = null;
	let lastCtx: QuotaContext | undefined;
	let lastFetch = 0;
	let fetching = false;

	async function refresh(ctx: QuotaContext, force = false): Promise<void> {
		if (fetching) return;
		if (!force && quota && Date.now() - lastFetch < MESSAGE_THROTTLE_MS) return;
		fetching = true;
		lastFetch = Date.now();
		try {
			const key = await resolveApiKey(ctx);
			if (!key) return;
			const fetched = await fetchZaiQuota(quotaBaseUrl(ctx), key);
			if (fetched) {
				quota = fetched;
				try {
					ctx.ui.setStatus(STATUS_KEY, usageStatusText(fetched));
					if (widgetOpen) ctx.ui.setWidget(WIDGET_KEY, widgetLines(fetched, ctx.ui.theme));
				} catch {
					// The session may have been replaced/reloaded mid-fetch; the
					// next refresh runs against the new runtime.
				}
			}
		} finally {
			fetching = false;
		}
	}

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		lastCtx = ctx;
		void refresh(ctx, true);
		if (!timer) {
			timer = setInterval(() => {
				if (lastCtx) void refresh(lastCtx);
			}, PERIODIC_REFRESH_MS);
		}
	});

	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "assistant") return;
		if (!ctx.hasUI) return;
		lastCtx = ctx;
		void refresh(ctx);
	});

	pi.on("session_shutdown", () => {
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
		widgetOpen = false;
	});

	pi.registerCommand("zai-usage", {
		description: "Toggle Z.AI Coding Plan quota details (5h window, weekly, tools)",
		handler: async (_args, ctx) => {
			widgetOpen = !widgetOpen;
			if (!widgetOpen) {
				ctx.ui.setWidget(WIDGET_KEY, undefined);
				return;
			}
			await refresh(ctx, true);
			if (quota) {
				ctx.ui.setWidget(WIDGET_KEY, widgetLines(quota, ctx.ui.theme));
			} else {
				widgetOpen = false;
				ctx.ui.notify("Z.AI quota unavailable (no key or endpoint unreachable)", "error");
			}
		},
	});
}
