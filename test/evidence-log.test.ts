import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import evidenceLog, { bodyHash, wrapFetchWithEvidence } from "../extensions/evidence-log.js";

let evidenceFile: string;

beforeEach(() => {
	evidenceFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "evidence-")), "evidence.jsonl");
	process.env["POWERPI_EVIDENCE_FILE"] = evidenceFile;
});

afterEach(() => {
	delete process.env["POWERPI_EVIDENCE_FILE"];
});

function records(): Array<Record<string, unknown>> {
	if (!fs.existsSync(evidenceFile)) return [];
	return fs
		.readFileSync(evidenceFile, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

describe("wrapFetchWithEvidence", () => {
	test("logs request hash and status for a successful request, without the body", async () => {
		const wrapped = wrapFetchWithEvidence(async () => new Response("streamed", { status: 200 }));
		await wrapped("https://backend.local/v1/chat/completions", { method: "POST", body: '{"x":1}' });

		const [record] = records();
		expect(record).toMatchObject({
			type: "http",
			url: "https://backend.local/v1/chat/completions",
			method: "POST",
			requestBodyHash: bodyHash('{"x":1}'),
			requestBodyBytes: 7,
			status: 200,
		});
		expect(record).not.toHaveProperty("responseBody");
	});

	test("logs the full response body, headers, and status for a non-2xx response", async () => {
		const wrapped = wrapFetchWithEvidence(
			async () =>
				new Response('{"error":"max_tokens exceeds limit"}', {
					status: 400,
					statusText: "Bad Request",
					headers: { "x-request-id": "req-42" },
				}),
		);
		const response = await wrapped("https://backend.local/v1/chat/completions", { method: "POST", body: "{}" });

		expect(response.status).toBe(400);
		// The original body must remain readable by the caller (SDK error path).
		expect(await response.text()).toContain("max_tokens");
		expect(records()[0]).toMatchObject({
			type: "http_error",
			status: 400,
			statusText: "Bad Request",
			responseHeaders: expect.objectContaining({ "x-request-id": "req-42" }),
			responseBody: '{"error":"max_tokens exceeds limit"}',
		});
	});

	test("logs and rethrows fetch exceptions", async () => {
		const wrapped = wrapFetchWithEvidence(async () => {
			throw new TypeError("fetch failed");
		});
		await expect(wrapped("https://backend.local/v1", { method: "POST" })).rejects.toThrow("fetch failed");
		expect(records()[0]).toMatchObject({ type: "http_error", error: "TypeError: fetch failed" });
	});
});

type Handler = (event: Record<string, unknown>, ctx: unknown) => void;

function makePi() {
	const handlers = new Map<string, Handler>();
	const pi = {
		on: (event: string, handler: Handler) => handlers.set(event, handler),
	} as unknown as ExtensionAPI;
	evidenceLog(pi);
	const ctx = { sessionManager: { getSessionId: () => "session-1" } };
	handlers.get("session_start")?.({}, ctx);
	return {
		emit: (event: string, payload: Record<string, unknown>) => handlers.get(event)?.(payload, ctx),
	};
}

describe("evidenceLog session records", () => {
	test("records turn errors with the last payload hash", () => {
		const { emit } = makePi();
		emit("before_provider_request", { payload: { model: "m", messages: [] } });
		emit("message_end", {
			message: {
				role: "assistant",
				stopReason: "error",
				rawStopReason: "upstream_error",
				errorMessage: "500 from backend",
				provider: "work",
				model: "deepseek",
				usage: { input: 10, output: 0, totalTokens: 10 },
				content: [],
			},
		});
		expect(records()[0]).toMatchObject({
			type: "turn_error",
			sessionId: "session-1",
			errorMessage: "500 from backend",
			rawStopReason: "upstream_error",
			lastPayloadHash: bodyHash(JSON.stringify({ model: "m", messages: [] })),
		});
	});

	test("records truncations and DSML leaks, ignores clean turns", () => {
		const { emit } = makePi();
		emit("message_end", {
			message: { role: "assistant", stopReason: "length", content: [{ type: "text", text: "cut off" }] },
		});
		emit("message_end", {
			message: {
				role: "assistant",
				stopReason: "stop",
				content: [{ type: "text", text: "before < | DSML | tool calls> after" }],
			},
		});
		emit("message_end", {
			message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "all fine" }] },
		});
		const types = records().map((record) => record["type"]);
		expect(types).toEqual(["truncation", "dsml_leak"]);
		expect(records()[1]?.["excerpt"]).toContain("< | DSML | tool calls>");
	});
});
