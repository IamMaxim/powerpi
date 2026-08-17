/**
 * File-based persistent memory.
 *
 * Injects the memory index (~/.pi/agent/memory/MEMORY.md) into the system
 * prompt each turn, plus short instructions on how to save new memories.
 * One file per fact; the index holds one pointer line per memory.
 * Writing conventions live in the `remember` skill.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MEMORY_DIR = path.join(os.homedir(), ".pi", "agent", "memory");
const INDEX_PATH = path.join(MEMORY_DIR, "MEMORY.md");

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event) => {
		let index = "";
		try {
			index = fs.readFileSync(INDEX_PATH, "utf8").trim();
		} catch {
			// No memory dir yet — bootstrap creates it; stay silent until then.
			return;
		}

		const block = [
			"",
			"# Memory",
			"",
			`You have a persistent file-based memory at \`${MEMORY_DIR}/\`.`,
			"Each memory is one markdown file holding one fact. `MEMORY.md` is the index:",
			"one pointer line per memory, loaded below. Read a memory file when its index",
			"line looks relevant to the task at hand.",
			"",
			"To save something durable (user preference, correction, project constraint,",
			"hard-won gotcha), follow the `remember` skill. Update or delete existing",
			"memories rather than duplicating them.",
			"",
			"## Index",
			"",
			index.length > 0 ? index : "(no memories yet)",
			"",
		].join("\n");

		return { systemPrompt: event.systemPrompt + block };
	});
}
