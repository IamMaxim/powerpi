/**
 * Recovers turns broken by leaked DSML tool-call markup.
 *
 * The self-hosted DeepSeek endpoint sometimes emits malformed tool-call
 * syntax (`< | DSML | tool calls>`-style tokens, spaces and all) as plain
 * text or thinking instead of a parsed tool call. The turn then stops with
 * no tool call executed and the run dies mid-task — silently in one-shot
 * (powersa) runs. On such a turn this extension queues a follow-up nudge
 * telling the model to re-issue the call properly, capped so a model that
 * keeps leaking can't loop forever.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Tolerant of the corrupted spacing/bars the leak produces: `< | DSML | ...>`, `</ | DSML invoke>`, `<｜DSML｜...`. */
export const DSML_LEAK = /<\s*\/?\s*[|｜]?\s*DSML\b/;

export const MAX_NUDGES = 2;

interface ContentBlock {
	type: string;
	text?: string;
	thinking?: string;
}

interface TurnMessage {
	role: string;
	stopReason?: string;
	content?: unknown;
}

/** True when an assistant message leaked DSML markup instead of producing a tool call. */
export function hasDsmlLeak(message: TurnMessage): boolean {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return false;
	const blocks = message.content as ContentBlock[];
	// A parsed tool call means the turn continues normally — nothing to recover.
	if (blocks.some((block) => block.type === "toolCall")) return false;
	return blocks.some(
		(block) =>
			(block.type === "text" && typeof block.text === "string" && DSML_LEAK.test(block.text)) ||
			(block.type === "thinking" && typeof block.thinking === "string" && DSML_LEAK.test(block.thinking)),
	);
}

const NUDGE =
	"Your previous message leaked malformed DSML tool-call markup as plain text, " +
	"so no tool was executed. Re-issue the intended action as a proper tool call. " +
	"Never write tool-call syntax inside your text or thinking output.";

export default function dsmlGuard(pi: ExtensionAPI) {
	let nudges = 0;
	pi.on("session_start", () => {
		nudges = 0;
	});
	pi.on("turn_end", (event) => {
		const message = event.message as TurnMessage;
		if (!hasDsmlLeak(message)) {
			if (message.role === "assistant") nudges = 0;
			return;
		}
		// Leave error/aborted/length turns to pi's own retry/abort handling.
		if (message.stopReason !== "stop") return;
		if (nudges >= MAX_NUDGES) return;
		nudges++;
		pi.sendMessage(
			{ customType: "dsml-guard", content: NUDGE, display: true },
			{ deliverAs: "followUp", triggerTurn: true },
		);
	});
}
