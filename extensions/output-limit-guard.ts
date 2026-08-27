/**
 * Breaks the truncated-tool-call loop on output-token-capped endpoints.
 *
 * The self-hosted endpoint caps output tokens low, so a file written as one
 * giant tool call hits the cap, pi fails the truncated calls with "re-issue
 * with complete arguments", and the model re-issues the same oversized call —
 * an infinite loop when running unattended.
 *
 * Two layers:
 * 1. Provider level: on a "length" stop, silently repeat the IDENTICAL
 *    request once with the max-tokens cap raised (4k-class default → 64k).
 *    The truncated attempt never reaches the session, so context stays clean.
 * 2. Session level: if even the raised cap truncates, a steering message
 *    tells the model to split the work into a series of small tool calls,
 *    capped so a persistently failing model can't nudge-loop.
 *
 * The provider wrapper applies to $POWERPI_ELASTIC_PROVIDER (default "work");
 * the nudge applies to any provider. Retry cap: $POWERPI_RETRY_MAX_TOKENS.
 */
import {
	type Api,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { appendEvidence, wrapFetchWithEvidence } from "./evidence-log.js";

export const RETRY_MAX_TOKENS = Number(process.env["POWERPI_RETRY_MAX_TOKENS"] ?? 65536);
const PROVIDER = process.env["POWERPI_ELASTIC_PROVIDER"] ?? "work";

export const MAX_NUDGES = 2;

type StreamSimpleFn = (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

/**
 * pi's extension loader remaps the bare "@earendil-works/pi-ai" specifier to
 * its own compat module (which exports the api factories) but chokes on
 * subpath imports, while under plain Node/vitest resolution it's the reverse:
 * the root has no factories, but subpaths resolve. Probe at first use.
 */
let basePromise: Promise<StreamSimpleFn> | undefined;
function loadOpenAICompletionsStreamSimple(): Promise<StreamSimpleFn> {
	basePromise ??= (async () => {
		const root = (await import("@earendil-works/pi-ai")) as Record<string, unknown>;
		const factory = root["openAICompletionsApi"];
		if (typeof factory === "function") {
			return (factory as () => { streamSimple: StreamSimpleFn })().streamSimple;
		}
		const mod = (await import("@earendil-works/pi-ai/api/openai-completions")) as unknown as {
			streamSimple: StreamSimpleFn;
		};
		return mod.streamSimple;
	})();
	return basePromise;
}

/**
 * Wraps a streamSimple implementation: a stream that ends with a "length"
 * stop is retried once — same model, same context — with maxTokens raised.
 */
export function withOutputLimitRetry(
	getBase: () => Promise<StreamSimpleFn>,
	retryMaxTokens = RETRY_MAX_TOKENS,
): StreamSimpleFn {
	return (model, context, options) => {
		const outer = createAssistantMessageEventStream();
		void (async () => {
			try {
				const base = await getBase();
				const withEvidence: SimpleStreamOptions = { ...options, fetch: wrapFetchWithEvidence(options?.fetch) };
				let truncated = false;
				let truncatedOutput = 0;
				for await (const event of base(model, context, withEvidence)) {
					if (event.type === "done" && event.reason === "length") {
						truncated = true;
						truncatedOutput = event.message.usage.output;
						break;
					}
					outer.push(event);
				}
				if (truncated) {
					appendEvidence({
						type: "elastic_retry",
						provider: model.provider,
						model: model.id,
						requestedMaxTokens: options?.maxTokens,
						truncatedAtOutputTokens: truncatedOutput,
						retryMaxTokens,
					});
					// The agent already pushed the first attempt's partial into its
					// context on `start`; skip the retry's `start` so it updates that
					// same partial in place instead of adding a second message.
					for await (const event of base(model, context, { ...withEvidence, maxTokens: retryMaxTokens })) {
						if (event.type !== "start") outer.push(event);
					}
				}
				outer.end();
			} catch (error) {
				// Base streams report their failures as "error" events, so this only
				// catches wrapper bugs — still, surface it instead of hanging the turn.
				outer.push({
					type: "error",
					reason: "error",
					error: {
						role: "assistant",
						content: [],
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "error",
						errorMessage: error instanceof Error ? error.message : String(error),
						timestamp: Date.now(),
					},
				});
				outer.end();
			}
		})();
		return outer;
	};
}

const NUDGE =
	"Your output hit the token limit even after it was raised — do not retry the same oversized call. " +
	"Split the work into a series of small tool calls: create the file with its first section, then add " +
	"the rest with successive edits, keeping each call well under the output limit.";

interface TurnMessage {
	role: string;
	stopReason?: string;
	content?: Array<{ type: string }>;
}

export default function outputLimitGuard(pi: ExtensionAPI) {
	pi.registerProvider(PROVIDER, {
		api: "openai-completions",
		streamSimple: withOutputLimitRetry(loadOpenAICompletionsStreamSimple),
	});

	let nudges = 0;
	pi.on("session_start", () => {
		nudges = 0;
	});
	pi.on("turn_end", (event) => {
		const message = event.message as TurnMessage;
		if (message.role !== "assistant") return;
		if (message.stopReason !== "length") {
			nudges = 0;
			return;
		}
		if (nudges >= MAX_NUDGES) return;
		nudges++;
		// With tool calls present pi fails them and keeps looping, so steer lands
		// before the model's next attempt; without them the run stops, so a
		// follow-up (re)starts it.
		const looping = message.content?.some((block) => block.type === "toolCall") ?? false;
		pi.sendMessage(
			{ customType: "output-limit-guard", content: NUDGE, display: true },
			{ deliverAs: looping ? "steer" : "followUp", triggerTurn: true },
		);
	});
}
