# powerpi

An opinionated rig for the [pi coding agent](https://github.com/badlogic/pi-mono):
pinned ecosystem packages, fetch-only whitelisted web access, a file-based
memory system, tweakable system prompts, and commit/MR doctrine — installable
on a fresh machine with one script.

pi ships deliberately minimal (no subagents, no permission gates, no web, no
MCP) and expects you to assemble those from its package ecosystem. This repo
is that assembly, plus the reasoning behind every choice.

## Quick start

```bash
git clone https://github.com/IamMaxim/powerpi ~/work/powerpi
~/work/powerpi/bootstrap.sh
```

The script installs pi, merges `settings.baseline.json` into
`~/.pi/agent/settings.json`, symlinks the configs below into `~/.pi/`, and
registers this repo as a local pi package (extensions, skills, prompts).
Re-run it any time; it's idempotent, and because configs are symlinks, edits
in the repo apply live.

Auth (pick one):

- **Self-hosted OpenAI-compatible endpoint** — edit `config/models.json`
  (baseUrl + served model ids), `export POWERPI_WORK_API_KEY=...`
- **OpenRouter, for testing** — `export OPENROUTER_API_KEY=...` (built-in
  provider; no models.json entry needed)

## What's installed, and why

| Package (pinned) | Why |
|---|---|
| `pi-subagents@0.50.0` | Delegation: named agents (reviewer/scout/oracle), parallel fan-out, background runs. The most mature of the four subagent implementations. |
| `@diegopetrucci/pi-permission-gate@0.1.12` | The guardrail philosophy here is "mostly bypass, gate the genuinely dangerous": prompts only on `rm -rf` / `sudo` / `chmod 777`-class commands and writes to `.git`, `node_modules`, `.env*`. No other friction. |
| `pi-web-access@0.23.0` | **Fetch-only, whitelisted.** `web_search` is disabled; `fetch_content` works against an allowlist (github, crates.io, docs.rs, …) with hosted extraction providers pinned off — no URL or query leaves the machine except to the allowlisted host itself. GitHub repo cloning stays on. See `config/web-search.json`. |
| `pi-simplify@0.2.3` | `/simplify` reviews only changed lines (proper `git diff` scoping) for clarity/consistency. |

Versions are pinned deliberately: pi packages run with full system access, so
updates are reviewed diffs, not `pi update --all`. To bump one:
`npm view <pkg> version`, review the changes, edit `settings.baseline.json`,
re-run bootstrap.

## What's in the repo itself

- **`extensions/memory.ts`** + **`skills/remember/`** — persistent file-based
  memory at `~/.pi/agent/memory/`: one file per fact with typed frontmatter,
  a `MEMORY.md` index injected into the system prompt each turn, and a skill
  teaching the agent the write conventions. Same format as my Claude Code
  memory, so the two can share a store later.
- **`system-prompts/APPEND_SYSTEM.md`** — appended to pi's default system
  prompt (symlinked to `~/.pi/agent/APPEND_SYSTEM.md`). Carries the working
  doctrine: think before coding, simplicity first, surgical changes,
  goal-driven execution. A full replacement prompt would go in
  `~/.pi/agent/SYSTEM.md`; keep experiments as files here and re-link.
- **`prompts/commit.md`, `prompts/mr.md`** — `/commit` and `/mr` enforce the
  house style for commit messages and MR descriptions (intent-first subject,
  prose over bullet inventories, mandatory verification sentence).
- **`config/`** — `web-search.json` (the fetch lockdown) and `models.json`
  (provider template), both symlinked into place.
- **`settings.baseline.json`** — telemetry off (`enableInstallTelemetry` is
  the only default-on phone-home in pi), analytics off, pinned packages.

Note pi natively loads `AGENTS.md`/`CLAUDE.md` from `~/.pi/agent/`, ancestor
directories, and the cwd — no extension needed for project instructions.

## Follow-ups (deliberately deferred)

- **`pi-hypa`** — context pruning of noisy tool output. Test and benchmark
  separately before trusting it with context.
- **`pi-mcp-adapter`** — adopt when internal MCP servers become part of the
  workflow; CLI utilities plus a skill describing them cover it so far.
- **`pi-lens`** — LSP/linter feedback loop for the agent; revisit against the
  current `cargo check` + CLI linter habit.
- **`pi-background-tasks`** — add when a slow build/test loop hurts.
- **`web_search`** — currently off; enabling means picking a search provider
  and accepting that queries leave the machine.
- **Vendoring the permission gate** — its dangerous-command patterns are
  hardcoded; fork into `extensions/` if they ever need extending.

## Rejected (so it doesn't get re-litigated)

- `pi-ask` — interactive questioning is handled by answering in the
  transcript directly.
- `pi-acp` — no ACP editor in this setup.
- Notifications — local desktop use; you're at the desk.
- UI/theme suites — live with the stock TUI first, add taste later.
