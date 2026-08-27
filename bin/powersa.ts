#!/usr/bin/env node
/**
 * powersa — one-shot pi subagent for delegation from a frontier orchestrator
 * (Claude Code). Runs `pi -p --mode json` with a role prompt appended, streams
 * tool-call progress to stderr, and prints only the agent's final message to
 * stdout. Sessions are saved under ~/.pi/powersa/sessions for post-mortem.
 *
 * Usage: powersa <role> "<task>" [--cwd <dir>]
 * Model: $POWERSA_MODEL ("provider/model-id"), else the first model of the
 * "work" provider in ~/.pi/agent/models.json.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_DIR = path.dirname(path.dirname(fs.realpathSync(fileURLToPath(import.meta.url))));
const ROLES_DIR = path.join(REPO_DIR, "prompts", "roles");
const SESSION_DIR = path.join(os.homedir(), ".pi", "powersa", "sessions");

function fail(message: string): never {
	process.stderr.write(`powersa: ${message}\n`);
	process.exit(1);
}

function listRoles(): string[] {
	try {
		return fs
			.readdirSync(ROLES_DIR)
			.filter((name) => name.endsWith(".md"))
			.map((name) => name.slice(0, -3));
	} catch {
		return [];
	}
}

function resolveModelArgs(): string[] {
	const override = process.env["POWERSA_MODEL"];
	if (override) return ["--model", override];
	const modelsPath = path.join(os.homedir(), ".pi", "agent", "models.json");
	let id: unknown;
	try {
		const parsed = JSON.parse(fs.readFileSync(modelsPath, "utf8"));
		id = parsed?.providers?.work?.models?.[0]?.id;
	} catch {
		// fall through to the error below
	}
	if (typeof id !== "string" || id.includes("REPLACE")) {
		fail(`no usable model: set POWERSA_MODEL ("provider/model-id") or configure the "work" provider in ${modelsPath}`);
	}
	return ["--provider", "work", "--model", id];
}

interface ContentBlock {
	type: string;
	text?: string;
}

interface PiEvent {
	type: string;
	id?: string;
	toolName?: string;
	args?: Record<string, unknown>;
	message?: { role?: string; stopReason?: string; errorMessage?: string; content?: ContentBlock[] };
}

function progressLine(event: PiEvent): string {
	const args = event.args ?? {};
	const subject = [args["command"], args["path"], args["pattern"], args["agent"]].find(
		(value) => typeof value === "string",
	) as string | undefined;
	const compact = subject ? ` ${subject.replace(/\s+/g, " ").slice(0, 100)}` : "";
	return `· ${event.toolName}${compact}\n`;
}

const argv = process.argv.slice(2);
const positional: string[] = [];
let cwd = process.cwd();
for (let i = 0; i < argv.length; i++) {
	const arg = argv[i]!;
	if (arg === "--cwd") {
		const value = argv[++i] ?? fail("--cwd requires a directory");
		cwd = path.resolve(value);
	} else if (arg === "--help" || arg === "-h") {
		process.stdout.write(`usage: powersa <role> "<task>" [--cwd <dir>]\nroles: ${listRoles().join(", ")}\n`);
		process.exit(0);
	} else {
		positional.push(arg);
	}
}

const [role, ...taskParts] = positional;
const task = taskParts.join(" ").trim();
if (!role || !task) fail(`usage: powersa <role> "<task>" [--cwd <dir>] (roles: ${listRoles().join(", ")})`);
const roleFile = path.join(ROLES_DIR, `${role}.md`);
if (!fs.existsSync(roleFile)) fail(`unknown role "${role}" (available: ${listRoles().join(", ")})`);
if (!fs.statSync(cwd).isDirectory()) fail(`not a directory: ${cwd}`);

fs.mkdirSync(SESSION_DIR, { recursive: true });

const pi = spawn(
	"pi",
	[
		"-p",
		"--mode",
		"json",
		"--session-dir",
		SESSION_DIR,
		"--append-system-prompt",
		roleFile,
		...resolveModelArgs(),
		task,
	],
	{ cwd, stdio: ["ignore", "pipe", "pipe"] },
);

let finalMessage: PiEvent["message"];
let sessionId: string | undefined;
let buffer = "";

// Manual splitting: pi warns that generic line readers mis-split JSONL on
// U+2028/U+2029 inside JSON strings.
pi.stdout.on("data", (chunk: Buffer) => {
	buffer += chunk.toString("utf8");
	const lines = buffer.split("\n");
	buffer = lines.pop() ?? "";
	for (const line of lines) {
		if (!line.trim()) continue;
		let event: PiEvent;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		if (event.type === "session" && event.id) {
			sessionId = event.id;
			process.stderr.write(`session: ${path.join(SESSION_DIR, `${event.id}.jsonl`)}\n`);
		} else if (event.type === "tool_execution_start") {
			process.stderr.write(progressLine(event));
		} else if (event.type === "turn_end" && event.message?.role === "assistant") {
			finalMessage = event.message;
		}
	}
});

pi.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk));

pi.on("error", () => fail("failed to spawn pi — is it installed and on PATH?"));

pi.on("close", (code) => {
	if (code !== 0) fail(`pi exited with code ${code}${sessionId ? "" : " before starting a session"}`);
	if (!finalMessage) fail("pi produced no assistant message");
	if (finalMessage.stopReason === "error") {
		fail(`agent stopped with error: ${finalMessage.errorMessage ?? "unknown"}`);
	}
	const text = (finalMessage.content ?? [])
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n")
		.trim();
	if (!text) fail("final assistant message contained no text");
	process.stdout.write(text + "\n");
});
