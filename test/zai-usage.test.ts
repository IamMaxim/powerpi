import { describe, expect, test } from "vitest";

import {
	formatCountdown,
	formatPct,
	parseZaiQuota,
	usageStatusText,
	widgetLines,
	type ZaiQuota,
} from "../extensions/zai-usage.js";

// Captured live from https://api.z.ai/api/monitor/usage/quota/limit (max plan,
// credits system, 2026-09-25): percentages report 1 but used/total is ~0.4%.
const LIVE_CREDITS_BODY = {
	code: 200,
	msg: "Operation successful",
	success: true,
	data: {
		limits: [
			{
				type: "CREDIT_LIMIT",
				unit: 3,
				number: 5,
				usage: 28000,
				currentValue: 102,
				remaining: 27897,
				percentage: 1,
				nextResetTime: 1790374987647,
			},
			{
				type: "CREDIT_LIMIT",
				unit: 6,
				number: 1,
				usage: 140000,
				currentValue: 150,
				remaining: 139849,
				percentage: 1,
				nextResetTime: 1790700393983,
			},
		],
		level: "max",
	},
};

// Shape reported by legacy token-window plans, plus a tool quota limit.
const LEGACY_TOKENS_BODY = {
	success: true,
	data: {
		limits: [
			{
				type: "TOKENS_LIMIT",
				unit: 3,
				number: 5,
				usage: 100000,
				currentValue: 71500,
				percentage: 72,
				nextResetTime: 1790374987647,
			},
			{ type: "TOKENS_LIMIT", unit: 6, usage: 500000, currentValue: 100000, percentage: 20 },
			{ type: "TIME_LIMIT", unit: 5, usage: 1000, currentValue: 250, percentage: 25, nextResetTime: 1790700393983 },
		],
		level: "pro",
	},
};

const NOW = 1_790_300_000_000;

describe("parseZaiQuota", () => {
	test("parses the live credits shape with recomputed percentages", () => {
		const quota = parseZaiQuota(LIVE_CREDITS_BODY, NOW);
		expect(quota).not.toBeNull();
		expect(quota!.level).toBe("max");
		expect(quota!.windowHours).toBe(5);
		expect(quota!.fiveHour).toEqual({
			used: 102,
			total: 28000,
			percentage: (102 / 28000) * 100,
			resetMs: 1790374987647,
		});
		expect(quota!.weekly).toEqual({
			used: 150,
			total: 140000,
			percentage: (150 / 140000) * 100,
			resetMs: 1790700393983,
		});
		expect(quota!.tools).toBeNull();
		expect(quota!.queriedAt).toBe(NOW);
	});

	test("parses legacy TOKENS_LIMIT windows and TIME_LIMIT tools", () => {
		const quota = parseZaiQuota(LEGACY_TOKENS_BODY, NOW)!;
		expect(quota.level).toBe("pro");
		expect(quota.fiveHour!.percentage).toBeCloseTo(71.5, 6);
		expect(quota.weekly!.percentage).toBeCloseTo(20, 6);
		expect(quota.weekly!.resetMs).toBeNull();
		expect(quota.tools!.used).toBe(250);
		expect(quota.tools!.total).toBe(1000);
	});

	test("rejects bodies without usable data", () => {
		expect(parseZaiQuota({ success: false })).toBeNull();
		expect(parseZaiQuota({ data: {} })).toBeNull();
		expect(parseZaiQuota(null)).toBeNull();
	});

	test("falls back to API percentage when no total is reported", () => {
		const quota = parseZaiQuota(
			{ data: { level: "lite", limits: [{ type: "CREDIT_LIMIT", unit: 3, currentValue: 0, percentage: 3 }] } },
			NOW,
		)!;
		expect(quota.fiveHour!.total).toBe(0);
		expect(quota.fiveHour!.percentage).toBe(3);
	});
});

describe("formatPct / formatCountdown", () => {
	test("keeps a decimal below 10%, rounds above", () => {
		expect(formatPct(0.364)).toBe("0.4%");
		expect(formatPct(9.96)).toBe("10.0%");
		expect(formatPct(37.2)).toBe("37%");
		expect(formatPct(99.96)).toBe("100%");
	});

	test("formats compact countdowns", () => {
		expect(formatCountdown(45 * 60_000)).toBe("45m");
		expect(formatCountdown(60_000)).toBe("1m");
		expect(formatCountdown((60 + 22) * 60_000)).toBe("1h22m");
		expect(formatCountdown(3 * 24 * 60 * 60_000)).toBe("3d");
		expect(formatCountdown((3 * 24 + 4) * 60 * 60_000)).toBe("3d4h");
		expect(formatCountdown(-1000)).toBe("0m");
	});
});

describe("usageStatusText", () => {
	test("renders tier, 5h window, and weekly quota", () => {
		const quota = parseZaiQuota(LIVE_CREDITS_BODY, NOW)!;
		expect(usageStatusText(quota)).toBe("z.ai max: 5h 0.4% · wk 0.1%");
	});

	test("adapts to missing windows, tier, and tool quota", () => {
		const lite = parseZaiQuota(
			{ data: { level: "lite", limits: [{ type: "CREDIT_LIMIT", unit: 3, number: 5, usage: 100, currentValue: 50 }] } },
			NOW,
		)!;
		expect(usageStatusText(lite)).toBe("z.ai lite: 5h 50%");
		expect(usageStatusText({ ...lite, level: null })).toBe("z.ai: 5h 50%");
		const legacy = parseZaiQuota(LEGACY_TOKENS_BODY, NOW)!;
		expect(usageStatusText(legacy)).toBe("z.ai pro: 5h 72% · wk 20% · tools 25%");
		const empty: ZaiQuota = { level: null, fiveHour: null, weekly: null, tools: null, windowHours: 5, queriedAt: NOW };
		expect(usageStatusText(empty)).toBe("z.ai");
	});
});

describe("widgetLines", () => {
	test("lists each window with credits and reset countdown", () => {
		const quota = parseZaiQuota(LIVE_CREDITS_BODY, NOW)!;
		const theme = { fg: (_c: string, t: string) => t };
		const lines = widgetLines(quota, theme, NOW);
		expect(lines[0]).toBe("Z.AI Coding Plan — max");
		expect(lines[1]).toContain("5h window");
		expect(lines[1]).toContain("0.4% used (102 / 28,000 cr)");
		expect(lines[1]).toContain("resets in ");
		expect(lines[2]).toContain("weekly");
		expect(lines[3]).toContain("fetched 0m ago");
	});
});
