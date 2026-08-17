#!/usr/bin/env bash
# Idempotent setup: install pi, merge baseline settings, link configs, register
# this repo as a local pi package. Safe to re-run after editing repo files.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PI_AGENT_DIR="$HOME/.pi/agent"

command -v npm >/dev/null || { echo "error: npm not found — install Node.js first" >&2; exit 1; }
node -e 'const [maj,min]=process.versions.node.split(".").map(Number); process.exit(maj>22||(maj===22&&min>=19)?0:1)' \
	|| { echo "error: pi requires Node >= 22.19 (current: $(node --version))" >&2; exit 1; }

if ! command -v pi >/dev/null; then
	echo "==> Installing pi"
	npm install -g --ignore-scripts @earendil-works/pi-coding-agent
else
	echo "==> pi already installed ($(pi --version 2>/dev/null || echo unknown))"
fi

echo "==> Preparing memory dir"
mkdir -p "$PI_AGENT_DIR/memory"
[ -f "$PI_AGENT_DIR/memory/MEMORY.md" ] || : > "$PI_AGENT_DIR/memory/MEMORY.md"

echo "==> Merging settings.baseline.json into $PI_AGENT_DIR/settings.json"
node - "$REPO_DIR/settings.baseline.json" "$PI_AGENT_DIR/settings.json" <<'EOF'
const fs = require("fs");
const [baselinePath, settingsPath] = process.argv.slice(2); // argv[1] is "-" (script from stdin)
const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
let settings = {};
try { settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")); } catch {}

// npm package identity = name without the pinned version
const identity = (p) => {
	const s = typeof p === "string" ? p : p.source ?? "";
	return s.replace(/^npm:/, "").replace(/(.+)@.*$/, "$1");
};
const existing = new Set((settings.packages ?? []).map(identity));
settings.packages = [
	...(settings.packages ?? []),
	...baseline.packages.filter((p) => !existing.has(identity(p))),
];
for (const [k, v] of Object.entries(baseline)) if (k !== "packages") settings[k] = v;

fs.mkdirSync(require("path").dirname(settingsPath), { recursive: true });
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, "\t") + "\n");
EOF

link() { # link <repo-file> <target>; backs up a pre-existing regular file
	local src="$1" dst="$2"
	if [ -e "$dst" ] && [ ! -L "$dst" ]; then
		echo "    backing up $dst -> $dst.bak"
		mv "$dst" "$dst.bak"
	fi
	ln -sfn "$src" "$dst"
	echo "    $dst -> $src"
}

echo "==> Linking configs"
link "$REPO_DIR/config/web-search.json" "$HOME/.pi/web-search.json"
link "$REPO_DIR/config/models.json" "$PI_AGENT_DIR/models.json"
link "$REPO_DIR/system-prompts/APPEND_SYSTEM.md" "$PI_AGENT_DIR/APPEND_SYSTEM.md"

echo "==> Registering this repo as a pi package"
pi install "$REPO_DIR"

cat <<MSG

Done. Before first run:
  - Work endpoint: edit config/models.json (baseUrl + model ids), export POWERPI_WORK_API_KEY
  - OpenRouter (testing): export OPENROUTER_API_KEY — built-in provider, no models.json entry needed
Then: pi
MSG
