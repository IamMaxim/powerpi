import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, test, vi } from "vitest";

import goalUi from "../extensions/goal-ui.js";

const theme = {
	bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
	fg: (_color: string, text: string) => text,
} as Theme;

describe("goal message rendering", () => {
	test("shows the collapsed objective without a background", () => {
		const registerMessageRenderer = vi.fn();
		goalUi({ registerMessageRenderer } as unknown as ExtensionAPI);
		const renderer = registerMessageRenderer.mock.calls[0]?.[1] as Function;
		const component = renderer(
			{
				details: { kind: "active", goal: { objective: "Finish the migration" } },
			},
			{ expanded: false, outputPad: 1 },
			theme,
		);
		const lines = component.render(80).join("\n");
		expect(lines).toContain("goal");
		expect(lines).toContain("active");
		expect(lines).toContain("Finish the migration");
		expect(lines).not.toMatch(/\x1b\[48/);
	});
});
