#!/usr/bin/env bash
# Rebuilds the three instanced statics, byte for byte (fontTools 4.66.1 through uvx).
#   make-statics.sh SRC_DIR OUT_DIR
# SRC_DIR holds the variable fonts of google/fonts commit 23e54b51ddffbc7713c583748e3bd86f62b1fa4a:
#   ofl/manrope/Manrope[wght].ttf, ofl/oswald/Oswald[wght].ttf, ofl/caveat/Caveat[wght].ttf
# --no-recalc-timestamp keeps `head.modified` out of the output, so two runs give the same sha256.
set -euo pipefail
src=$1
out=$2
mkdir -p "$out"
here=$(cd "$(dirname "$0")" && pwd)
ft() { uvx --from fonttools==4.66.1 "$@"; }
ft fonttools varLib.instancer "$src/Manrope[wght].ttf" wght=800 --update-name-table --no-recalc-timestamp -o "$out/Manrope-800.ttf"
ft fonttools varLib.instancer "$src/Oswald[wght].ttf" wght=600 --update-name-table --no-recalc-timestamp -o "$out/Oswald-600.ttf"
ft fonttools varLib.instancer "$src/Caveat[wght].ttf" wght=600 --no-recalc-timestamp -o "$out/Caveat-raw.ttf"
ft python "$here/fix-caveat-names.py" "$out/Caveat-raw.ttf" "$out/Caveat-600.ttf"
rm "$out/Caveat-raw.ttf"
