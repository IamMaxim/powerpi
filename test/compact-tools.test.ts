import {
	AssistantMessageComponent,
	type ExtensionAPI,
	initTheme,
	type Theme,
	ToolExecutionComponent,
	type ToolDefinition,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { Text, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";

import compactTools, { installCompactToolRows } from "../extensions/compact-tools.js";

initTheme("dark");

const calls: Record<string, unknown> = {
	bash: { command: "npm test" },
	edit: { edits: [{ newText: "new", oldText: "old" }], path: "src/index.ts" },
	find: { path: "src", pattern: "*.ts" },
	grep: { path: "src", pattern: "registerTool" },
	ls: { path: "src" },
	read: { path: "src/index.ts" },
	write: { content: "one\ntwo\nthree", path: "src/new.ts" },
	subagent: { agent: "reviewer", task: "Inspect the current UI" },
};

function toolRow(name: string, args: unknown, tool?: ToolDefinition): ToolExecutionComponent {
	const tui = { requestRender: vi.fn() } as unknown as TUI;
	const row = new ToolExecutionComponent(name, "tool-1", args, {}, tool, tui, "/tmp/example");
	row.setArgsComplete();
	row.markExecutionStarted();
	return row;
}

describe("compact built-in tools", () => {
	test("does not replace executable tool definitions", () => {
		const registerTool = vi.fn();
		let shutdown: (() => void) | undefined;
		const pi = {
			on: (event: string, handler: () => void) => {
				if (event === "session_shutdown") shutdown = handler;
			},
			registerTool,
		} as unknown as ExtensionAPI;

		compactTools(pi);
		expect(registerTool).not.toHaveBeenCalled();
		shutdown?.();
	});

	test("renders every built-in call as one bounded line", () => {
		const restore = installCompactToolRows();
		try {
			for (const [name, args] of Object.entries(calls)) {
				const lines = toolRow(name, args).render(24);
				expect(lines, name).toHaveLength(1);
				expect(visibleWidth(lines[0] ?? ""), name).toBeLessThanOrEqual(24);
			}
		} finally {
			restore();
		}
	});

	test("summarizes collapsed writes and expands their content", () => {
		const restore = installCompactToolRows();
		try {
			const row = toolRow("write", calls.write);
			row.updateResult({ content: [{ type: "text", text: "Successfully wrote 13 bytes" }], isError: false }, false);
			expect(row.render(80)).toEqual([expect.stringContaining("✓")]);
			expect(row.render(80).join("")).toContain("write");
			expect(row.render(80).join("")).toContain("src/new.ts");
			expect(row.render(80).join("")).toContain("3 lines");
			expect(row.render(80).join("")).not.toContain("one");

			row.setExpanded(true);
			const expanded = row.render(80).map((line) => line.trimEnd()).join("\n");
			const plain = expanded.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
			expect(plain).toContain("one\ntwo\nthree");
		} finally {
			restore();
		}
	});

	test("shows colored edit diffs without expanding the tool row", () => {
		const restore = installCompactToolRows();
		try {
			const row = toolRow("edit", calls.edit);
			row.updateResult(
				{
					content: [{ type: "text", text: "Successfully replaced 1 block" }],
					details: {
						diff: "-1 const oldValue = true;\n+1 const newValue = true;",
						patch: "",
						firstChangedLine: 1,
					},
					isError: false,
				},
				false,
			);
			const rendered = row.render(80).join("\n");
			const plain = rendered.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
			expect(plain).toContain("edit");
			expect(plain).toContain("+1 −1");
			expect(plain).toContain("const oldValue = true;");
			expect(plain).toContain("const newValue = true;");
			expect(rendered).toContain("\x1b[");
		} finally {
			restore();
		}
	});

	test("shows subagent tool, token, and duration facts", () => {
		const restore = installCompactToolRows();
		try {
			const row = toolRow("subagent", calls.subagent);
			row.updateResult(
				{
					content: [{ type: "text", text: "Review complete" }],
					details: {
						results: [{ progressSummary: { toolCount: 3, tokens: 12400, durationMs: 12_345 } }],
					},
					isError: false,
				},
				false,
			);
			const line = row.render(80).join("");
			expect(line).toContain("✓");
			expect(line).toContain("subagent");
			expect(line).toContain("reviewer");
			expect(line).toContain("3 tools · 12.4k tokens · 12.3s");

			row.updateResult(
				{
					content: [{ type: "text", text: "Working" }],
					details: { progress: [{ toolCount: 2, tokens: 8200, durationMs: 6400 }] },
					isError: false,
				},
				true,
			);
			const liveLine = row.render(80).join("");
			expect(liveLine).toContain("·");
			expect(liveLine).toContain("2 tools · 8.2k tokens · 6.4s");
		} finally {
			restore();
		}
	});

	test("summarizes errors on the call row", () => {
		const restore = installCompactToolRows();
		try {
			const row = toolRow("bash", calls.bash);
			row.updateResult(
				{ content: [{ type: "text", text: "test output\n\nCommand exited with code 1" }], isError: true },
				false,
			);
			const line = row.render(80).join("");
			expect(line).toContain("✕");
			expect(line).toContain("bash");
			expect(line).toContain("Command exited with code 1");
		} finally {
			restore();
		}
	});
});

describe("transparent user messages", () => {
	const railTheme = {
		bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
		fg: (_color: string, text: string) => `\x1b[35m${text}\x1b[39m`,
	} as Theme;

	test("renders a compact bold rail without a background", () => {
		const restore = installCompactToolRows(() => railTheme);
		try {
			const lines = new UserMessageComponent("Review this change").render(40);
			const plain = lines.map((line) => line.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*\x07)/g, ""));
			expect(plain).toEqual(["", " ┃ Review this change", ""]);
			expect(lines[1]).toContain("\x1b[1m");
			expect(lines.join("\n")).not.toMatch(/\x1b\[(?:4[0-9]|10[0-7]|48;)/);
		} finally {
			restore();
		}
	});

	test("keeps wrapped message lines within the terminal width", () => {
		const restore = installCompactToolRows(() => railTheme);
		try {
			const lines = new UserMessageComponent("A deliberately long user message that must wrap cleanly").render(24);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(24);
			for (const line of lines.slice(1, -1)) expect(line).toContain("┃");
		} finally {
			restore();
		}
	});
});

describe("assistant-to-tool spacing", () => {
	test.each([
		[{ type: "text", text: "I will inspect this." }],
		[{ type: "thinking", thinking: "Inspecting the files" }],
	])("adds one trailing separator before the first tool", (visibleContent) => {
		const restore = installCompactToolRows();
		try {
			const message = {
				content: [visibleContent, { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "file.ts" } }],
				role: "assistant",
				stopReason: "toolUse",
			};
			const rendered = new AssistantMessageComponent(message as never).render(80);
			expect(rendered.at(-1)).toBe("");
			expect(rendered.at(-2)).not.toBe("");
		} finally {
			restore();
		}
	});

	test("does not create a separator for a tool-only assistant message", () => {
		const restore = installCompactToolRows();
		try {
			const message = {
				content: [{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "file.ts" } }],
				role: "assistant",
				stopReason: "toolUse",
			};
			expect(new AssistantMessageComponent(message as never).render(80)).toEqual([]);
		} finally {
			restore();
		}
	});
});

describe("third-party tool rows", () => {
	const thirdParty: ToolDefinition = {
		name: "third_party",
		label: "Third party",
		description: "test tool",
		parameters: {} as ToolDefinition["parameters"],
		async execute() {
			return { content: [{ type: "text", text: "detail one\ndetail two" }], details: undefined };
		},
		renderCall() {
			return new Text("\x1b[1;41mthird_party action\x1b[0m", 0, 0);
		},
		renderResult() {
			return new Text("detail one\ndetail two", 0, 0);
		},
	};

	test("keeps one useful status line and strips combined backgrounds", () => {
		const restore = installCompactToolRows();
		try {
			const row = toolRow("third_party", { action: "run" }, thirdParty);
			row.updateResult({ content: [{ type: "text", text: "detail one\ndetail two" }], isError: false }, false);
			const lines = row.render(80);
			expect(lines).toHaveLength(1);
			expect(lines[0]).toContain("✓");
			expect(lines[0]).toContain("third_party action");
			expect(lines[0]).not.toContain("detail one");
			expect(lines[0]).not.toContain("41m");
			expect(lines[0]).toContain("\x1b[1m");
		} finally {
			restore();
		}
	});

	test("adds an argument digest for tools without custom renderers", () => {
		const fallbackTool: ToolDefinition = {
			name: "fallback_tool",
			label: thirdParty.label,
			description: thirdParty.description,
			parameters: thirdParty.parameters,
			execute: thirdParty.execute,
		};
		const restore = installCompactToolRows();
		try {
			const line = toolRow("fallback_tool", { action: "run", items: [1, 2] }, fallbackTool).render(80).join("");
			expect(line).toContain("fallback_tool");
			expect(line).toContain("action:run");
			expect(line).toContain("items:[2]");
		} finally {
			restore();
		}
	});

	test("preserves native detail when expanded", () => {
		const restore = installCompactToolRows();
		try {
			const row = toolRow("third_party", { action: "run" }, thirdParty);
			row.updateResult({ content: [{ type: "text", text: "detail one\ndetail two" }], isError: false }, false);
			row.setExpanded(true);
			const lines = row.render(80).join("\n");
			expect(lines).toContain("third_party action");
			expect(lines).toContain("detail one");
			expect(lines).toContain("detail two");
		} finally {
			restore();
		}
	});
});
