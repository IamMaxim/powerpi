#!/usr/bin/env bash
# Idempotent setup: install pi, merge baseline settings, link configs, register
# this repo as a local pi package. Safe to re-run after editing repo files.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# One coherent era: pi and its packages must match (extension API moves fast),
# and everything must predate npm-proxy quarantine windows (~2 weeks).
PI_VERSION=0.83.0
PI_AGENT_DIR="$HOME/.pi/agent"

command -v npm >/dev/null || { echo "error: npm not found — install Node.js first" >&2; exit 1; }
node -e 'const [maj,min]=process.versions.node.split(".").map(Number); process.exit(maj>22||(maj===22&&min>=19)?0:1)' \
	|| { echo "error: pi requires Node >= 22.19 (current: $(node --version))" >&2; exit 1; }

INSTALLED_PI_VERSION="$(pi --version 2>/dev/null || true)"
if [ "$INSTALLED_PI_VERSION" != "$PI_VERSION" ]; then
	NPM_PREFIX="$(npm prefix -g)"
	if [ ! -w "$NPM_PREFIX/bin" ] || { [ -d "$NPM_PREFIX/lib/node_modules" ] && [ ! -w "$NPM_PREFIX/lib/node_modules" ]; }; then
		cat >&2 <<ERR
error: npm global prefix ($NPM_PREFIX) is not user-writable (system Node install).
Do NOT chmod/sudo it — install Node in userspace instead. Either:
  - nvm (recommended, also gets you Node >= 22.19):
      curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
      exec \$SHELL; nvm install 22
  - or keep system Node (if >= 22.19) with a user prefix:
      npm config set prefix ~/.npm-global
      export PATH=~/.npm-global/bin:\$PATH   # add to your shell rc too
Then re-run this script.
ERR
		exit 1
	fi
	echo "==> Installing pi $PI_VERSION (current: ${INSTALLED_PI_VERSION:-not installed})"
	npm install -g --ignore-scripts "@earendil-works/pi-coding-agent@$PI_VERSION"
else
	echo "==> pi already pinned at $PI_VERSION"
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
const fromBaseline = new Set(baseline.packages.map(identity));
settings.packages = [
	...baseline.packages,
	...(settings.packages ?? []).filter((p) => !fromBaseline.has(identity(p))),
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
# Custom-themes dir (not the package registration) so pi live-reloads edits.
mkdir -p "$PI_AGENT_DIR/themes"
link "$REPO_DIR/themes/pitcock.json" "$PI_AGENT_DIR/themes/pitcock.json"
# powersa rides Node >= 22.19 type stripping, so the .ts file runs directly.
link "$REPO_DIR/bin/powersa.ts" "$(npm prefix -g)/bin/powersa"

echo "==> Registering this repo as a pi package"
pi install "$REPO_DIR"

cat <<MSG

Done. Before first run:
  - Work endpoint: edit config/models.json (baseUrl + model ids), export POWERPI_WORK_API_KEY
  - OpenRouter (testing): export OPENROUTER_API_KEY — built-in provider, no models.json entry needed
Then: pi
MSG
