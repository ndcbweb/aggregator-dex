#!/usr/bin/env bash
# Builds dist/aggregator.tar.gz, which aggregator hosts download and run with node:22-alpine.
set -euo pipefail
cd "$(dirname "$0")/.."

(cd web && npm ci && NODE_ENV=production npm run build)
(cd server && npm ci --omit=dev)

rm -rf dist
mkdir -p dist/aggregator/web
cp -R server dist/aggregator/server
rm -rf dist/aggregator/server/.data dist/aggregator/server/test
cp -R web/out dist/aggregator/web/out
cp -R artifacts dist/aggregator/artifacts
cp -R presets dist/aggregator/presets
cp run.sh dist/aggregator/run.sh
tar -czf dist/aggregator.tar.gz -C dist aggregator
echo "Built $(pwd)/dist/aggregator.tar.gz"
