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

Requirements: Node >= 22.19 with a **user-writable npm global prefix**. On
Linux with distro-packaged Node the prefix is `/usr` — don't sudo/chmod it;
install Node via nvm instead (`nvm install 22`), or point npm at a user prefix
(`npm config set prefix ~/.npm-global` + PATH). Bootstrap checks both and
tells you which fix applies.

Auth (pick one):

- **Self-hosted OpenAI-compatible endpoint** — edit `config/models.json`
  (baseUrl + served model ids), `export POWERPI_WORK_API_KEY=...`
- **OpenRouter, for testing** — `export OPENROUTER_API_KEY=...` (built-in
  provider; no models.json entry needed)

Keep secrets out of tracked dotfiles: put the exports in a chmod-600 file
(e.g. `~/.config/powerpi/env`) and source it from your shell rc.

### Corporate networks

A bare `Error: Connection error.` from pi is the OpenAI SDK swallowing the
real cause. Triage: `curl -v "$BASE_URL/models"` first; if curl works but pi
doesn't, it's Node-specific — almost always one of:

- **TLS interception / private CA** — Node ignores the system trust store.
  `export NODE_EXTRA_CA_CERTS=/path/to/corp-ca.pem` (alongside the API key in
  the env file).
- **Proxy env** — pi honors `HTTPS_PROXY`, which can route an *internal*
  endpoint through a proxy that can't reach it: set `NO_PROXY` (and lowercase
  `no_proxy`) for the endpoint host. The inverse applies if the endpoint is
  only reachable via the proxy.

For the raw cause: `NODE_DEBUG=undici,net,tls pi -p "hi"`.

Artifactory-style registries quarantine package versions for ~2 weeks from
the **first request**, not from npm publish — so pin-downgrading chases a
moving target. Request the pinned versions once, wait out the window (or ask
infra to release them), or install pi packages from git sources instead.

## What's installed, and why

| Package (pinned) | Why |
|---|---|
| `pi-subagents@0.40.0` | Delegation: named agents (reviewer/scout/oracle), parallel fan-out, background runs. The most mature of the four subagent implementations. |
| `@diegopetrucci/pi-permission-gate@0.1.11` | The guardrail philosophy here is "mostly bypass, gate the genuinely dangerous": prompts only on `rm -rf` / `sudo` / `chmod 777`-class commands and writes to `.git`, `node_modules`, `.env*`. No other friction. |
| `pi-web-access@0.17.1` | **Fetch-only, whitelisted.** `web_search` is disabled; `fetch_content` works against an allowlist (github, crates.io, docs.rs, …) with hosted extraction providers pinned off — no URL or query leaves the machine except to the allowlisted host itself. GitHub repo cloning stays on. See `config/web-search.json`. |
| `pi-simplify@0.2.3` | `/simplify` reviews only changed lines (proper `git diff` scoping) for clarity/consistency. |
| `pi-open-tui@0.2.10` | Replaces pi's header/footer/editor chrome: model + thinking level + cwd up top, git state / context gauge / token counts / cost in the footer, framed editor. Public extension APIs only, no prototype patching, no network calls (its "telemetry" is on-screen turn stats). All of it paints through the active theme's named colors, which is what makes the pitcock theme below carry the whole UI. Configure via `/open-tui`. |

Versions are pinned deliberately, and to one coherent era — pi's extension
API moves fast enough that packages break against a pi from a different month
(`bootstrap.sh` pins pi itself for the same reason). The current set also
predates 2026-08-04, clearing npm-proxy quarantine windows (~2 weeks) on
corporate registries. pi packages run with full system access, so updates are
reviewed diffs, not `pi update --all`. To bump one:
`npm view <pkg> version`, review the changes, edit `settings.baseline.json`,
re-run bootstrap.

## What's in the repo itself

- **`extensions/memory.ts`** + **`skills/remember/`** — persistent file-based
  memory at `~/.pi/agent/memory/`: one file per fact with typed frontmatter,
  a `MEMORY.md` index injected into the system prompt each turn, and a skill
  teaching the agent the write conventions. Same format as my Claude Code
  memory, so the two can share a store later.
- **`extensions/compact-tools.ts`** + **`extensions/goal-ui.ts`** — trace-UI fork of
  [`pi-minimalist-ui`](https://github.com/zackerydev/pi-minimalist-ui): Pi's
  built-ins collapse to a single status/path/summary row, except `edit`, which
  keeps its colored diff visible for live review. `Ctrl+O` retains full output
  for the remaining tools. A defensive row-level adapter also compacts
  third-party tools without replacing their execution or expanded renderers.
  User messages use a transparent background with a compact bold purple rail;
  goal lifecycle messages are transparent compact rows that include the current
  objective, while `Ctrl+O` retains usage details. Editor, footer, and working
  indicator remain owned by `pi-open-tui`. The
  upstream MIT notice is retained in `LICENSES/pi-minimalist-ui.txt`.
- **`extensions/dsml-guard.ts`** — recovers turns broken by leaked DSML
  tool-call markup. The self-hosted DeepSeek endpoint sometimes emits
  malformed tool-call syntax (`< | DSML | tool calls>`-style tokens) as plain
  text or thinking instead of a parsed tool call; the turn then stops with
  nothing executed — silently fatal in one-shot runs. On such a turn the
  guard queues a follow-up message telling the model to re-issue the call,
  capped at 2 consecutive nudges so a persistently broken model can't loop.
- **`extensions/output-limit-guard.ts`** — breaks the truncated-tool-call
  loop on output-capped endpoints. When the self-hosted endpoint cuts a
  response at its output-token limit (typically one giant file-write call),
  pi fails the truncated calls and the model re-issues the same oversized
  call forever. Layer one wraps the `work` provider's stream
  (`$POWERPI_ELASTIC_PROVIDER` to change): a "length" stop silently repeats
  the *identical* request once with the cap raised to 64k
  (`$POWERPI_RETRY_MAX_TOKENS`), so the truncated attempt never enters the
  session. Layer two, any provider: if even that truncates, a steering
  message tells the model to split the work into a series of small tool
  calls, capped at 2 nudges per incident. The in-provider retry needs a real
  length-stop to verify end-to-end — unit-tested here, live behavior
  confirmed only up to extension load and provider composition.
- **`extensions/evidence-log.ts`** — append-only JSONL evidence at
  `~/.pi/agent/evidence.jsonl` (`$POWERPI_EVIDENCE_FILE` to move it) for
  diagnosing endpoint misbehavior constructively instead of by anecdote.
  Every request through the elastic provider leaves an `http` line (request
  body hash/size, duration, status); non-2xx and thrown fetches become
  `http_error` lines with the full response body and headers — ground truth
  for what the backend returned. Session-level lines capture `turn_error` /
  `truncation` (stopReason, rawStopReason, errorMessage, usage, last payload
  hash), `dsml_leak` (with an excerpt around the leak), and `elastic_retry`
  (the silent in-provider retry, which otherwise never reaches the session).
  A clean run writes nothing.
- **`extensions/zai-usage.ts`** — Z.AI GLM Coding Plan quota in the footer: plan tier plus 5-hour-window and weekly percentages (`z.ai max: 5h 0.4% · wk 0.1%`), straight from the server via `GET /api/monitor/usage/quota/limit` (undocumented, but the same call the Z.AI console makes; Bearer key resolved from the provider auth chain, `$ZAI_API_KEY` fallback). Handles both the current `CREDIT_LIMIT` shape and legacy `TOKENS_LIMIT` plans, recomputes percentages from used/total because the API rounds sub-1% values up, and auto-switches to `open.bigmodel.cn` for `-cn` providers (`$POWERPI_ZAI_USAGE_BASE`/`$POWERPI_ZAI_USAGE_PROVIDER` to override). The line goes through `ctx.ui.setStatus`, which pi-open-tui renders in its extension-status footer segment; `/zai-usage` toggles a detail widget (credits used/total, reset countdowns, tool quota). Refreshes at session start, after each assistant message (30s throttle), and every 2 minutes; gated on `ctx.hasUI` so powersa/subagent one-shots make no extra network calls.
- **`bin/powersa.ts`** + **`prompts/roles/`** — `powersa <role> "<task>"
  [--cwd <dir>]`: one-shot pi subagents for delegation from a frontier
  orchestrator (Claude Code), so cheap self-hosted models absorb exploration
  and routine edits while the frontier model keeps the reasoning. Runs
  `pi -p --mode json` with the role prompt (`scout` read-only exploration,
  `worker` well-specified changes) appended to pi's normal system prompt;
  prints only the agent's final message to stdout, tool-call progress and the
  session path to stderr, exits non-zero if the agent errored out. Sessions
  land in `~/.pi/powersa/sessions` for post-mortem, out of the interactive
  `--resume` list. Model: `$POWERSA_MODEL` ("provider/model-id"), else the
  first model of the `work` provider in `models.json`. Bootstrap symlinks it
  into the npm global bin. From Claude Code, run it via background Bash with
  a self-contained task brief — the subagent sees none of the caller's
  context, and the caller sees only the final report.
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
- **`themes/pitcock.json`** — the default theme, ported from the pitcock
  design language: warm near-black surfaces, ivory text, a single amber
  accent (borders, selection, headings), semantic hues reserved for meaning
  (green success, red error, purple custom messages), and a warm "heat ramp"
  for thinking levels. Syntax highlighting is classic Monokai. Symlinked into
  `~/.pi/agent/themes/` (rather than shipped via the package registration) so
  pi live-reloads edits; switch away with `/theme`, but note the baseline
  resets `theme` on each bootstrap run.
- **`settings.baseline.json`** — telemetry off (`enableInstallTelemetry` is
  the only default-on phone-home in pi), analytics off, pinned packages, and a
  widened `retry` policy. pi's defaults tolerate only ~14s of provider errors
  (3 turn retries, and **zero** HTTP-level retries on OpenAI-compatible
  endpoints), so a sustained 429 kills subagent fan-outs. The baseline sets 6
  turn retries × 6 requests each with `Retry-After` honored up to 120s —
  minutes of tolerance. Subagents inherit it automatically: they are plain
  `pi` child processes reading the same settings.

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
