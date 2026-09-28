#!/bin/sh
# Usage: spike/text-raster/run-electron.sh <script.ts> [args...]
# Bundles the script to plain ESM (Electron's Node cannot run .ts) and runs it in Electron's Node 24.
set -e
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
name="$(basename "$1" .ts)"
shift
mkdir -p "$root/.cache/text-raster/dist"
bun build "$here/$name.ts" --target=node --format=esm --outfile="$root/.cache/text-raster/dist/$name.mjs" >/dev/null
ELECTRON_RUN_AS_NODE=1 "$root/node_modules/.bin/electron" "$root/.cache/text-raster/dist/$name.mjs" "$@"
