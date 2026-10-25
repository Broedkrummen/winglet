#!/usr/bin/env bash
# Build the web app and bundle it into the plugin (plugin/web), which serves it to phones.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
python3 "$ROOT/scripts/generate_third_party_notices.py"
cd "$ROOT/app"
[ -d node_modules ] || npm ci
rm -rf dist
# --clear: Metro caches the app config it inlines, so without it the bundle can carry an old version.
npx expo export --platform web --clear
rm -rf "$ROOT/plugin/web"
cp -r dist "$ROOT/plugin/web"
echo "Bundled web app into plugin/web ($(du -sh "$ROOT/plugin/web" | cut -f1))"
