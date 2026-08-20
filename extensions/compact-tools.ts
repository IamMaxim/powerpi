import {
	type AgentToolResult,
	AssistantMessageComponent,
	type EditToolDetails,
	type ExtensionAPI,
	type Theme,
	ToolExecutionComponent,
	type ToolDefinition,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";

interface CompactCall {
	subject: string;
	meta?: string;
}

interface CompactToolState {
	line?: SingleLine;
}

interface CompactRenderer {
	call: (args: any) => CompactCall;
	summary?: (result: AgentToolResult<any>, args: any) => string | undefined;
	expanded?: (result: AgentToolResult<any>, args: any, isError: boolean) => string;
}

type RenderCall = NonNullable<ToolDefinition["renderCall"]>;
type RenderResult = NonNullable<ToolDefinition["renderResult"]>;

class SingleLine implements Component {
	constructor(private text: string) {}

	setText(text: string): void {
		this.text = text;
	}

	render(width: number): string[] {
		return width > 0 ? [truncateToWidth(this.text, width, "…")] : [];
	}

	invalidate(): void {}
}

function sanitizeTerminalText(text: string): string {
	return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "�");
}

function compactText(value: unknown, fallback = "…"): string {
	if (typeof value !== "string") return fallback;
	const compact = value.replace(/\s+/g, " ").trim();
	return sanitizeTerminalText(compact) || fallback;
}

function textOutput(result: AgentToolResult<unknown>): string {
	return result.content
		.flatMap((part) => (part.type === "text" ? [part.text] : []))
		.join("\n")
		.trimEnd();
}

function lineCount(text: string): number {
	return text ? text.split("\n").length : 0;
}

function errorSummary(result: AgentToolResult<unknown>): string | undefined {
	const lines = textOutput(result)
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	return lines.length > 0 ? compactText(lines.at(-1)) : undefined;
}

function styleOutput(text: string, theme: Theme, isError: boolean): string {
	const color = isError ? "error" : "toolOutput";
	return text
		.split("\n")
		.map((line) => theme.fg(color, line))
		.join("\n");
}

function renderLine(
	name: string,
	call: CompactCall,
	theme: Theme,
	state: { isPartial: boolean; isError: boolean },
	summary?: string,
): string {
	const status = state.isPartial
		? theme.fg("muted", "·")
		: state.isError
			? theme.fg("error", "✕")
			: theme.fg("success", "✓");
	let text = `${status} ${theme.fg("toolTitle", theme.bold(name))} ${theme.fg("accent", compactText(call.subject))}`;
	if (call.meta) text += theme.fg("muted", ` ${compactText(call.meta, "")}`);
	if (summary) text += theme.fg(state.isError ? "error" : "muted", ` — ${compactText(summary, "")}`);
	return text;
}

function formatCount(value: number): string {
	if (value < 1000) return String(value);
	if (value < 1_000_000) return `${(value / 1000).toFixed(value < 100_000 ? 1 : 0)}k`;
	return `${(value / 1_000_000).toFixed(1)}m`;
}

function formatDuration(durationMs: number): string {
	if (durationMs < 1000) return `${durationMs}ms`;
	if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)}s`;
	return `${Math.floor(durationMs / 60_000)}m${Math.floor((durationMs % 60_000) / 1000)}s`;
}

interface SubagentFacts {
	toolCount?: number;
	tokens?: number;
	durationMs?: number;
}

function subagentSummary(result: AgentToolResult<unknown>): string | undefined {
	const details = result.details as {
		progress?: SubagentFacts[];
		results?: Array<{ progressSummary?: SubagentFacts }>;
	} | undefined;
	const progress = details?.progress;
	const summaries = progress?.length
		? progress
		: details?.results?.map((entry) => entry.progressSummary).filter((entry): entry is SubagentFacts => Boolean(entry));
	if (!summaries || summaries.length === 0) return undefined;
	const toolCount = summaries.reduce((total, entry) => total + (entry.toolCount ?? 0), 0);
	const tokens = summaries.reduce((total, entry) => total + (entry.tokens ?? 0), 0);
	const durationMs = summaries.reduce((total, entry) => total + (entry.durationMs ?? 0), 0);
	const facts = [`${toolCount} tools`, `${formatCount(tokens)} tokens`, formatDuration(durationMs)];
	return facts.join(" · ");
}

function countDiff(details: EditToolDetails | undefined): string | undefined {
	if (!details?.diff) return undefined;
	let additions = 0;
	let removals = 0;
	for (const line of details.diff.split("\n")) {
		if (line.startsWith("+") && !line.startsWith("+++")) additions++;
		if (line.startsWith("-") && !line.startsWith("---")) removals++;
	}
	return `+${additions} −${removals}`;
}

const compactRenderers: Record<string, CompactRenderer> = {
	read: {
		call: (args) => {
			const start = args.offset;
			const end = start !== undefined && args.limit !== undefined ? start + args.limit - 1 : undefined;
			const range = start !== undefined ? `lines ${start}${end !== undefined ? `–${end}` : "+"}` : undefined;
			return { subject: compactText(args.path), ...(range ? { meta: range } : {}) };
		},
		summary: (result) => {
			const count = lineCount(textOutput(result));
			return count > 0 ? `${count} lines${result.details?.truncation?.truncated ? ", truncated" : ""}` : undefined;
		},
	},
	bash: {
		call: (args) => ({
			subject: compactText(args.command),
			...(args.timeout !== undefined ? { meta: `timeout ${args.timeout}s` } : {}),
		}),
	},
	edit: {
		call: (args) => ({
			subject: compactText(args.path),
			...(Array.isArray(args.edits) ? { meta: `${args.edits.length} block${args.edits.length === 1 ? "" : "s"}` } : {}),
		}),
		summary: (result) => countDiff(result.details),
		expanded: (result, _args, isError) => (isError ? textOutput(result) : (result.details?.diff ?? textOutput(result))),
	},
	write: {
		call: (args) => {
			const count = typeof args.content === "string" ? lineCount(args.content) : 0;
			return {
				subject: compactText(args.path),
				...(count > 0 ? { meta: `${count} line${count === 1 ? "" : "s"}` } : {}),
			};
		},
		expanded: (result, args, isError) =>
			isError ? textOutput(result) : typeof args.content === "string" ? args.content : textOutput(result),
	},
	grep: {
		call: (args) => {
			const path = compactText(args.path, ".");
			const glob = args.glob ? ` ${compactText(args.glob, "")}` : "";
			return { subject: `/${compactText(args.pattern, "")}/`, meta: `in ${path}${glob}` };
		},
		summary: (result) => {
			const count = lineCount(textOutput(result));
			return count > 0 ? `${count} lines` : undefined;
		},
	},
	find: {
		call: (args) => ({ subject: compactText(args.pattern), meta: `in ${compactText(args.path, ".")}` }),
		summary: (result) => {
			const count = lineCount(textOutput(result));
			return count > 0 ? `${count} files` : undefined;
		},
	},
	ls: {
		call: (args) => ({ subject: compactText(args.path, ".") }),
		summary: (result) => {
			const count = lineCount(textOutput(result));
			return count > 0 ? `${count} entries` : undefined;
		},
	},
	subagent: {
		call: (args) => ({ subject: compactText(args.agent ?? args.action, "run") }),
		summary: subagentSummary,
	},
};

function compactCallRenderer(name: string, renderer: CompactRenderer): RenderCall {
	return (args, theme, context) => {
		const line = context.lastComponent instanceof SingleLine ? context.lastComponent : new SingleLine("");
		(context.state as CompactToolState).line = line;
		line.setText(
			renderLine(name, renderer.call(args), theme, {
				isError: context.isError,
				isPartial: context.isPartial,
			}),
		);
		return line;
	};
}

function compactResultRenderer(name: string, renderer: CompactRenderer): RenderResult {
	return (result, { expanded }, theme, context) => {
		const summary = context.isError ? errorSummary(result) : renderer.summary?.(result, context.args);
		(context.state as CompactToolState).line?.setText(
			renderLine(
				name,
				renderer.call(context.args),
				theme,
				{ isError: context.isError, isPartial: context.isPartial },
				summary,
			),
		);

		if (!expanded) return new Container();
		const output = renderer.expanded?.(result, context.args, context.isError) ?? textOutput(result);
		return output ? new Text(styleOutput(output, theme, context.isError), 0, 0) : new Container();
	};
}

const ANSI_ESCAPE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g;
const SGR = /\x1b\[([0-9;:]*)m/g;

function isVisibleLine(line: string): boolean {
	return line.replace(ANSI_ESCAPE, "").trim().length > 0;
}

function removeBackground(line: string): string {
	const withoutBackground = line.replace(SGR, (_sequence, raw: string) => {
		const params = raw === "" ? ["0"] : raw.split(";");
		const kept: string[] = [];
		for (let index = 0; index < params.length; index++) {
			const param = params[index] ?? "";
			const value = Number(param.split(":", 1)[0]);
			if ((value >= 40 && value <= 49) || (value >= 100 && value <= 107)) continue;
			if (value === 48) {
				const mode = Number(params[index + 1]);
				index += mode === 2 ? 4 : mode === 5 ? 2 : 0;
				continue;
			}
			kept.push(param);
		}
		return kept.length > 0 ? `\x1b[${kept.join(";")}m` : "";
	});
	return withoutBackground.replace(/\s+(?=(?:\x1b\[[0-9;]*m)*$)/, "");
}

function compactArgs(args: unknown): string {
	if (!args || typeof args !== "object" || Array.isArray(args)) return "";
	const parts: string[] = [];
	for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
		if (value === undefined || value === null || value === "") continue;
		const rendered =
			typeof value === "string"
				? compactText(value, "")
				: Array.isArray(value)
					? value.length === 1
						? compactText(String(value[0] ?? ""), "")
						: `[${value.length}]`
					: typeof value === "object"
						? ""
						: String(value);
		if (rendered) parts.push(`${compactText(key)}:${rendered}`);
	}
	return parts.join(" ");
}

interface ToolRowInternals {
	args?: unknown;
	expanded: boolean;
	isPartial: boolean;
	result?: { isError?: boolean };
	toolName?: string;
	getCallRenderer(): RenderCall | undefined;
	getResultRenderer(): RenderResult | undefined;
	getRenderShell(): "default" | "self";
}

interface ToolRowPrototype {
	render(width: number): string[];
	getCallRenderer(): RenderCall | undefined;
	getResultRenderer(): RenderResult | undefined;
	getRenderShell(): "default" | "self";
}

interface AssistantMessageInternals {
	hasToolCalls: boolean;
}

interface AssistantMessagePrototype {
	render(width: number): string[];
}

interface UserMessagePrototype {
	render(width: number): string[];
}

/**
 * Installs compact built-in renderers without replacing tool execution, then
 * collapses third-party shells to one useful line. Expanded third-party rows
 * retain their original renderer output. Assistant text keeps one separator
 * before its first tool, while consecutive tools remain tightly grouped.
 */
export function installCompactToolRows(getTheme: () => Theme | undefined = () => undefined): () => void {
	const prototype = ToolExecutionComponent.prototype as unknown as ToolRowPrototype;
	const assistantPrototype = AssistantMessageComponent.prototype as unknown as AssistantMessagePrototype;
	const userPrototype = UserMessageComponent.prototype as unknown as UserMessagePrototype;
	const originalRender = prototype.render;
	const originalCall = prototype.getCallRenderer;
	const originalResult = prototype.getResultRenderer;
	const originalShell = prototype.getRenderShell;
	const originalAssistantRender = assistantPrototype.render;
	const originalUserRender = userPrototype.render;

	const compactCalls = new Map(Object.entries(compactRenderers).map(([name, renderer]) => [name, compactCallRenderer(name, renderer)]));
	const compactResults = new Map(
		Object.entries(compactRenderers).map(([name, renderer]) => [name, compactResultRenderer(name, renderer)]),
	);

	const patchedCall = function (this: ToolRowInternals): RenderCall | undefined {
		return (this.toolName && compactCalls.get(this.toolName)) || originalCall.call(this);
	};
	const patchedResult = function (this: ToolRowInternals): RenderResult | undefined {
		const compact = this.toolName && compactResults.get(this.toolName);
		if (this.toolName !== "edit" || !compact) return compact || originalResult.call(this);

		const native = originalResult.call(this);
		return (result, options, theme, context) => {
			compact(result, options, theme, context);
			return native?.(result, options, theme, context) ?? new Container();
		};
	};
	const patchedShell = function (this: ToolRowInternals): "default" | "self" {
		return this.toolName && compactRenderers[this.toolName] ? "self" : originalShell.call(this);
	};
	const patchedUserRender = function (this: UserMessageComponent, width: number): string[] {
		const rendered = originalUserRender.call(this, Math.max(1, width - 2)).map(removeBackground);
		const currentTheme = getTheme();
		const pipe = currentTheme
			? currentTheme.bold(currentTheme.fg("customMessageLabel", "┃"))
			: "\x1b[1m┃\x1b[22m";
		return rendered.map((line, index) => {
			if (index === 0 || index === rendered.length - 1) return line;
			const content = line.replace(/^((?:\x1b\[[0-?]*[ -/]*[@-~])*) /, "$1");
			return truncateToWidth(` ${pipe} ${content}`, width, "");
		});
	};
	const patchedAssistantRender = function (this: AssistantMessageComponent, width: number): string[] {
		const rendered = originalAssistantRender.call(this, width);
		const message = this as unknown as AssistantMessageInternals;
		if (message.hasToolCalls && rendered.length > 0 && rendered.at(-1) !== "") return [...rendered, ""];
		return rendered;
	};
	const patchedRender = function (this: ToolExecutionComponent, width: number): string[] {
		const row = this as unknown as ToolRowInternals;
		if (row.toolName === "subagent" && !row.expanded) {
			const renderer = compactRenderers.subagent!;
			const call = renderer.call(row.args);
			const summary = row.result && !row.result.isError
				? subagentSummary(row.result as AgentToolResult<unknown>)
				: row.result?.isError
					? errorSummary(row.result as AgentToolResult<unknown>)
					: undefined;
			const currentTheme = getTheme() ?? ({
				fg: (_color: string, text: string) => text,
				bold: (text: string) => text,
			} as Theme);
			return [truncateToWidth(renderLine("subagent", call, currentTheme, {
				isError: row.result?.isError ?? false,
				isPartial: row.isPartial,
			}, summary), width, "…")];
		}
		const rendered = originalRender.call(this, width);
		const withoutOuterSpacer = rendered[0] === "" ? rendered.slice(1) : rendered;
		if (row.expanded || (row.toolName === "edit" && row.result && !row.result.isError)) return withoutOuterSpacer;

		const first = withoutOuterSpacer.find(isVisibleLine);
		if (!first) return [];
		if (row.getRenderShell() === "self") return [truncateToWidth(first, width, "…")];

		const status = row.result?.isError ? "✕" : row.isPartial ? "·" : "✓";
		const call = removeBackground(first).trimStart();
		const plainCall = call.replace(ANSI_ESCAPE, "").trim();
		const args = row.toolName && plainCall === row.toolName ? compactArgs(row.args) : "";
		return [truncateToWidth(`${status} ${call}${args ? ` ${args}` : ""}`, width, "…")];
	};

	prototype.getCallRenderer = patchedCall;
	prototype.getResultRenderer = patchedResult;
	prototype.getRenderShell = patchedShell;
	prototype.render = patchedRender;
	assistantPrototype.render = patchedAssistantRender;
	userPrototype.render = patchedUserRender;

	return () => {
		if (userPrototype.render === patchedUserRender) userPrototype.render = originalUserRender;
		if (assistantPrototype.render === patchedAssistantRender) assistantPrototype.render = originalAssistantRender;
		if (prototype.render === patchedRender) prototype.render = originalRender;
		if (prototype.getCallRenderer === patchedCall) prototype.getCallRenderer = originalCall;
		if (prototype.getResultRenderer === patchedResult) prototype.getResultRenderer = originalResult;
		if (prototype.getRenderShell === patchedShell) prototype.getRenderShell = originalShell;
	};
}

export default function compactTools(pi: ExtensionAPI) {
	let activeTheme: Theme | undefined;
	const restoreRows = installCompactToolRows(() => activeTheme);
	pi.on("session_start", (_event, ctx) => {
		activeTheme = ctx.ui.theme;
	});
	pi.on("session_shutdown", restoreRows);
}
