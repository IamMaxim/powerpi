import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, test, vi } from "vitest";

import dsmlGuard, { hasDsmlLeak, MAX_NUDGES } from "../extensions/dsml-guard.js";

const LEAK_SAMPLES = [
	"< | DSML | tool calls>\n< | DSML invoke name=\"bash\">\n...\n</ | DSML | invoke >\n</ | DSML | tool_calls >",
	"<｜DSML｜invoke name=\"bash\">",
	"some text then\n</ | DSML | tool_calls >",
	"<DSML invoke name=\"read\">",
];

function assistant(content: Array<Record<string, unknown>>, stopReason = "stop") {
	return { role: "assistant", stopReason, content };
}

describe("hasDsmlLeak", () => {
	test("matches leaked markup variants in text blocks", () => {
		for (const sample of LEAK_SAMPLES) {
			expect(hasDsmlLeak(assistant([{ type: "text", text: sample }])), sample).toBe(true);
		}
	});

	test("matches leaks inside thinking blocks", () => {
		const message = assistant([
			{ type: "thinking", thinking: `Let me run it.\n< | DSML | tool calls>` },
			{ type: "text", text: "" },
		]);
		expect(hasDsmlLeak(message)).toBe(true);
	});

	test("ignores clean answers, prose mentions of DSML, and non-assistant messages", () => {
		expect(hasDsmlLeak(assistant([{ type: "text", text: "All tests pass." }]))).toBe(false);
		expect(hasDsmlLeak(assistant([{ type: "text", text: "DSML is DeepSeek's markup." }]))).toBe(false);
		expect(hasDsmlLeak({ role: "user", content: [{ type: "text", text: "< | DSML | tool calls>" }] })).toBe(false);
		expect(hasDsmlLeak({ role: "custom", content: "< | DSML |" })).toBe(false);
	});

	test("does not fire when a real tool call was parsed alongside the leak", () => {
		const message = assistant([
			{ type: "text", text: "< | DSML | tool calls>" },
			{ type: "toolCall", id: "1", name: "bash", arguments: {} },
		]);
		expect(hasDsmlLeak(message)).toBe(false);
	});
});

type Handler = (event: { message: unknown }) => void;

function makePi() {
	const handlers = new Map<string, Handler>();
	const sendMessage = vi.fn();
	const pi = {
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		sendMessage,
	} as unknown as ExtensionAPI;
	dsmlGuard(pi);
	const emitTurnEnd = (message: unknown) => handlers.get("turn_end")?.({ message });
	const emitSessionStart = () => handlers.get("session_start")?.({ message: undefined });
	return { sendMessage, emitTurnEnd, emitSessionStart };
}

const leakMessage = () => assistant([{ type: "text", text: "< | DSML | tool calls>" }]);

describe("dsmlGuard", () => {
	test("queues a follow-up nudge on a leaked turn", () => {
		const { sendMessage, emitTurnEnd } = makePi();
		emitTurnEnd(leakMessage());
		expect(sendMessage).toHaveBeenCalledTimes(1);
		const [message, options] = sendMessage.mock.calls[0] ?? [];
		expect(message).toMatchObject({ customType: "dsml-guard" });
		expect(options).toMatchObject({ deliverAs: "followUp", triggerTurn: true });
	});

	test("gives up after MAX_NUDGES consecutive leaks", () => {
		const { sendMessage, emitTurnEnd } = makePi();
		for (let i = 0; i < MAX_NUDGES + 3; i++) emitTurnEnd(leakMessage());
		expect(sendMessage).toHaveBeenCalledTimes(MAX_NUDGES);
	});

	test("a clean assistant turn resets the cap", () => {
		const { sendMessage, emitTurnEnd } = makePi();
		for (let i = 0; i < MAX_NUDGES; i++) emitTurnEnd(leakMessage());
		emitTurnEnd(assistant([{ type: "text", text: "done" }]));
		emitTurnEnd(leakMessage());
		expect(sendMessage).toHaveBeenCalledTimes(MAX_NUDGES + 1);
	});

	test("leaves error/aborted turns to pi's own handling", () => {
		const { sendMessage, emitTurnEnd } = makePi();
		emitTurnEnd(assistant([{ type: "text", text: "< | DSML | tool calls>" }], "error"));
		emitTurnEnd(assistant([{ type: "text", text: "< | DSML | tool calls>" }], "aborted"));
		expect(sendMessage).not.toHaveBeenCalled();
	});
});
