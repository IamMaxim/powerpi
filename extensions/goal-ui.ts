import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

type GoalKind = "active" | "continuation" | "resumed" | "budget_limited" | "paused" | "cleared" | "complete";

interface GoalState {
	objective: string;
	timeUsedSeconds?: number;
	tokensUsed?: number;
	tokenBudget?: number | null;
}

interface GoalMessage {
	details?: {
		kind?: GoalKind;
		goal?: GoalState | null;
	};
}

function status(kind: GoalKind): { icon: string; label: string } {
	switch (kind) {
		case "complete":
			return { icon: "✓", label: "achieved" };
		case "paused":
			return { icon: "‖", label: "paused" };
		case "cleared":
			return { icon: "×", label: "cleared" };
		case "budget_limited":
			return { icon: "!", label: "budget limited" };
		case "continuation":
			return { icon: "·", label: "continuing" };
		case "resumed":
			return { icon: "·", label: "resumed" };
		default:
			return { icon: "·", label: "active" };
	}
}

function usage(state: GoalState): string {
	const time = state.timeUsedSeconds === undefined ? undefined : `${state.timeUsedSeconds}s`;
	const tokens = state.tokensUsed === undefined ? undefined : `${state.tokensUsed} tokens`;
	const budget = state.tokenBudget == null ? undefined : `/${state.tokenBudget}`;
	return [time, tokens ? `${tokens}${budget ?? ""}` : undefined].filter(Boolean).join(" · ");
}

export default function goalUi(pi: ExtensionAPI) {
	pi.registerMessageRenderer("pi-goal", (message, { expanded }, theme: Theme) => {
		const details = (message as GoalMessage).details;
		const kind = details?.kind ?? "continuation";
		const state = details?.goal;
		const marker = status(kind);
		const iconColor = kind === "complete" ? "success" : kind === "budget_limited" ? "warning" : "customMessageLabel";
		const label = theme.fg("customMessageLabel", theme.bold("goal"));
		const icon = theme.fg(iconColor, marker.icon);
		if (!expanded) {
			const objective = state?.objective ? theme.fg("dim", ` — ${state.objective}`) : "";
			return new Text(`${icon} ${label} ${theme.fg("customMessageText", marker.label)}${objective}`, 0, 0);
		}

		const lines = [
			`${icon} ${label} ${theme.fg("customMessageText", marker.label)}`,
			state?.objective ? `${theme.fg("dim", "Goal: ")}${theme.fg("customMessageText", state.objective)}` : undefined,
			state && usage(state) ? `${theme.fg("dim", "Usage: ")}${theme.fg("customMessageText", usage(state))}` : undefined,
		].filter((line): line is string => Boolean(line));
		return new Text(lines.join("\n"), 0, 0);
	});
}
