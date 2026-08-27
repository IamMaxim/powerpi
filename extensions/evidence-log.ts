/**
 * Evidence log for endpoint misbehavior: append-only JSONL at
 * ~/.pi/agent/evidence.jsonl ($POWERPI_EVIDENCE_FILE to override).
 *
 * Three record sources, correlated by timestamp/pid/session:
 * - "http" / "http_error": every request made through the wrapped fetch
 *   (injected into the elastic provider by output-limit-guard) — request body
 *   hash and size, duration, status, response headers, and for non-2xx or
 *   thrown fetches the full response body (capped). This is the ground truth
 *   for what the backend actually returned.
 * - "turn_error" / "truncation": assistant messages finishing with stopReason
 *   error/aborted/length — errorMessage, rawStopReason, usage, plus the hash
 *   of the last provider payload seen for that model.
 * - "dsml_leak": turns where DSML tool-call markup leaked into text/thinking,
 *   with an excerpt around the leak.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { DSML_LEAK, hasDsmlLeak } from "./dsml-guard.js";

const RESPONSE_BODY_CAP = 128 * 1024;
const EXCERPT_RADIUS = 300;

function evidencePath(): string {
	return process.env["POWERPI_EVIDENCE_FILE"] ?? path.join(os.homedir(), ".pi", "agent", "evidence.jsonl");
}

export function appendEvidence(record: Record<string, unknown>): void {
	const file = evidencePath();
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, ...record })}\n`);
	} catch {
		// Evidence collection must never break the agent.
	}
}

export function bodyHash(body: string): string {
	return createHash("sha256").update(body).digest("hex").slice(0, 16);
}

function headersToRecord(headers: Headers): Record<string, string> {
	const result: Record<string, string> = {};
	headers.forEach((value, key) => {
		result[key] = value;
	});
	return result;
}

type FetchFn = typeof globalThis.fetch;

/** Wraps a fetch implementation so every request leaves an evidence record. */
export function wrapFetchWithEvidence(inner?: FetchFn): FetchFn {
	const baseFetch = inner ?? globalThis.fetch;
	return async (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const body = typeof init?.body === "string" ? init.body : undefined;
		const request = {
			url,
			method: init?.method ?? "GET",
			requestBodyHash: body !== undefined ? bodyHash(body) : undefined,
			requestBodyBytes: body !== undefined ? Buffer.byteLength(body) : undefined,
		};
		const started = performance.now();
		let response: Response;
		try {
			response = await baseFetch(input, init);
		} catch (error) {
			appendEvidence({
				type: "http_error",
				...request,
				durationMs: Math.round(performance.now() - started),
				error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
			});
			throw error;
		}
		const durationMs = Math.round(performance.now() - started);
		if (response.ok) {
			appendEvidence({ type: "http", ...request, durationMs, status: response.status });
			return response;
		}
		let responseBody: string;
		try {
			responseBody = await response.clone().text();
		} catch (error) {
			responseBody = `<unreadable: ${error instanceof Error ? error.message : String(error)}>`;
		}
		appendEvidence({
			type: "http_error",
			...request,
			durationMs,
			status: response.status,
			statusText: response.statusText,
			responseHeaders: headersToRecord(response.headers),
			responseBody: responseBody.slice(0, RESPONSE_BODY_CAP),
			responseBodyTruncated: responseBody.length > RESPONSE_BODY_CAP || undefined,
		});
		return response;
	};
}

interface EvidenceMessage {
	role: string;
	stopReason?: string;
	rawStopReason?: string;
	errorMessage?: string;
	provider?: string;
	model?: string;
	usage?: { input?: number; output?: number; totalTokens?: number };
	content?: Array<{ type: string; text?: string; thinking?: string; name?: string }>;
}

function leakExcerpt(message: EvidenceMessage): string | undefined {
	for (const block of message.content ?? []) {
		const text = block.type === "text" ? block.text : block.type === "thinking" ? block.thinking : undefined;
		const index = text?.search(DSML_LEAK) ?? -1;
		if (text && index >= 0) {
			return text.slice(Math.max(0, index - EXCERPT_RADIUS), index + EXCERPT_RADIUS);
		}
	}
	return undefined;
}

function messageFacts(message: EvidenceMessage, payloadHash: string | undefined) {
	return {
		provider: message.provider,
		model: message.model,
		stopReason: message.stopReason,
		rawStopReason: message.rawStopReason,
		errorMessage: message.errorMessage,
		usage: message.usage
			? { input: message.usage.input, output: message.usage.output, totalTokens: message.usage.totalTokens }
			: undefined,
		toolCalls: message.content?.filter((block) => block.type === "toolCall").map((block) => block.name),
		lastPayloadHash: payloadHash,
	};
}

export default function evidenceLog(pi: ExtensionAPI) {
	let sessionId: string | undefined;
	let lastPayloadHash: string | undefined;

	pi.on("session_start", (_event, ctx) => {
		sessionId = ctx.sessionManager.getSessionId();
	});

	pi.on("before_provider_request", (event) => {
		try {
			lastPayloadHash = bodyHash(JSON.stringify(event.payload));
		} catch {
			lastPayloadHash = undefined;
		}
	});

	pi.on("message_end", (event) => {
		const message = event.message as EvidenceMessage;
		if (message.role !== "assistant") return;
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			appendEvidence({ type: "turn_error", sessionId, ...messageFacts(message, lastPayloadHash) });
		} else if (message.stopReason === "length") {
			appendEvidence({ type: "truncation", sessionId, ...messageFacts(message, lastPayloadHash) });
		} else if (hasDsmlLeak(message as Parameters<typeof hasDsmlLeak>[0])) {
			appendEvidence({
				type: "dsml_leak",
				sessionId,
				...messageFacts(message, lastPayloadHash),
				excerpt: leakExcerpt(message),
			});
		}
	});
}
