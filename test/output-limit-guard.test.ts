import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Api, AssistantMessage, AssistantMessageEvent, Context, Model } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeAll, describe, expect, test, vi } from "vitest";

// Retry paths append evidence records; keep them out of the real log.
beforeAll(() => {
	process.env["POWERPI_EVIDENCE_FILE"] = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "olg-")), "evidence.jsonl");
});

import outputLimitGuard, { MAX_NUDGES, withOutputLimitRetry } from "../extensions/output-limit-guard.js";

const model = { api: "openai-completions", provider: "work", id: "test-model" } as unknown as Model<Api>;
const context = { messages: [] } as unknown as Context;

function assistantMessage(text: string, stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "work",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: 0,
	};
}

function streamOf(events: AssistantMessageEvent[]) {
	const stream = createAssistantMessageEventStream();
	for (const event of events) stream.push(event);
	stream.end();
	return stream;
}

function attempt(text: string, reason: "stop" | "length"): AssistantMessageEvent[] {
	const message = assistantMessage(text, reason === "stop" ? "stop" : "length");
	return [
		{ type: "start", partial: message },
		{ type: "text_delta", contentIndex: 0, delta: text, partial: message },
		{ type: "done", reason, message },
	];
}

async function collect(stream: AsyncIterable<AssistantMessageEvent>) {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

describe("withOutputLimitRetry", () => {
	test("passes a successful stream through with a single attempt", async () => {
		const base = vi.fn(() => streamOf(attempt("ok", "stop")));
		const events = await collect(withOutputLimitRetry(async () => base, 64000)(model, context, { maxTokens: 4096 }));
		expect(base).toHaveBeenCalledTimes(1);
		expect(events.map((event) => event.type)).toEqual(["start", "text_delta", "done"]);
	});

	test("retries a length-stop once with the same context and a raised cap", async () => {
		const base = vi.fn((_model: Model<Api>, _context: Context, options?: { maxTokens?: number }) =>
			options?.maxTokens === 64000 ? streamOf(attempt("full output", "stop")) : streamOf(attempt("trunc", "length")),
		);
		const events = await collect(withOutputLimitRetry(async () => base, 64000)(model, context, { maxTokens: 4096 }));

		expect(base).toHaveBeenCalledTimes(2);
		expect(base.mock.calls[1]?.[1]).toBe(context);
		expect(base.mock.calls[1]?.[2]).toMatchObject({ maxTokens: 64000 });

		// One start (from attempt 1), no leaked attempt-1 done(length), final done from attempt 2.
		expect(events.filter((event) => event.type === "start")).toHaveLength(1);
		const done = events.at(-1);
		expect(done).toMatchObject({ type: "done", reason: "stop" });
		expect(done?.type === "done" && done.message.content).toEqual([{ type: "text", text: "full output" }]);
	});

	test("gives up after the second length-stop and forwards it", async () => {
		const base = vi.fn(() => streamOf(attempt("trunc", "length")));
		const events = await collect(withOutputLimitRetry(async () => base, 64000)(model, context));
		expect(base).toHaveBeenCalledTimes(2);
		expect(events.at(-1)).toMatchObject({ type: "done", reason: "length" });
	});
});

type Handler = (event: { message: unknown }) => void;

function makePi() {
	const handlers = new Map<string, Handler>();
	const sendMessage = vi.fn();
	const registerProvider = vi.fn();
	const pi = {
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		sendMessage,
		registerProvider,
	} as unknown as ExtensionAPI;
	outputLimitGuard(pi);
	return { sendMessage, registerProvider, emitTurnEnd: (message: unknown) => handlers.get("turn_end")?.({ message }) };
}

function lengthTurn(withToolCall: boolean) {
	return {
		role: "assistant",
		stopReason: "length",
		content: withToolCall
			? [{ type: "text" }, { type: "toolCall" }]
			: [{ type: "text" }],
	};
}

describe("outputLimitGuard nudge", () => {
	test("registers the elastic provider wrapper", () => {
		const { registerProvider } = makePi();
		expect(registerProvider).toHaveBeenCalledWith(
			"work",
			expect.objectContaining({ api: "openai-completions", streamSimple: expect.any(Function) }),
		);
	});

	test("steers when the truncated message has tool calls, follows up when it does not", () => {
		const { sendMessage, emitTurnEnd } = makePi();
		emitTurnEnd(lengthTurn(true));
		expect(sendMessage.mock.calls[0]?.[1]).toMatchObject({ deliverAs: "steer", triggerTurn: true });
		emitTurnEnd(lengthTurn(false));
		expect(sendMessage.mock.calls[1]?.[1]).toMatchObject({ deliverAs: "followUp", triggerTurn: true });
	});

	test("caps nudges and resets on a non-length assistant turn", () => {
		const { sendMessage, emitTurnEnd } = makePi();
		for (let i = 0; i < MAX_NUDGES + 2; i++) emitTurnEnd(lengthTurn(true));
		expect(sendMessage).toHaveBeenCalledTimes(MAX_NUDGES);
		emitTurnEnd({ role: "assistant", stopReason: "stop", content: [{ type: "text" }] });
		emitTurnEnd(lengthTurn(true));
		expect(sendMessage).toHaveBeenCalledTimes(MAX_NUDGES + 1);
	});
});
