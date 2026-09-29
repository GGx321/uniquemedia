#!/usr/bin/env bash
# Regenerates emoji-test-<version>.hb-glyphs.txt: the glyph HarfBuzz shapes every fully-qualified sequence of an
# emoji-test.txt to, in a given font. Updating the font or the Unicode list is then mechanical:
#
#   fixtures/makeHbGlyphs.sh <NotoColorEmoji.ttf> fixtures/emoji-test-17.0.txt > fixtures/emoji-test-17.0.hb-glyphs.txt
#
# Needs hb-shape (HarfBuzz 14.4.0 made the committed file) and python3. Fails if any sequence does not shape to
# exactly one glyph, since the property test's oracle is only meaningful for such lines.
set -euo pipefail
font="${1:?usage: makeHbGlyphs.sh <font.ttf> <emoji-test.txt>}"
list="${2:?usage: makeHbGlyphs.sh <font.ttf> <emoji-test.txt>}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
grep '; fully-qualified' "$list" | sed 's/ *;.*//' > "$work/keys.txt"
python3 -c "
import sys
for line in open(sys.argv[1]):
    print(''.join(chr(int(x, 16)) for x in line.split()))
" "$work/keys.txt" > "$work/lines.txt"
hb-shape --shapers=ot --no-glyph-names --no-positions --no-clusters "$font" < "$work/lines.txt" > "$work/shaped.txt"
if [ "$(wc -l < "$work/keys.txt")" != "$(wc -l < "$work/shaped.txt")" ] || grep -qv '^\[[0-9]*\]$' "$work/shaped.txt" || grep -q '^\[0\]$' "$work/shaped.txt"; then
  echo "makeHbGlyphs: some sequence does not shape to exactly one non-.notdef glyph" >&2
  exit 1
fi
version="$(hb-shape --version | head -1 | sed 's/.*) //')"
echo "# Glyph ids HarfBuzz ${version} (hb-shape --shapers=ot) gives each fully-qualified sequence of"
echo "# $(basename "$list") in NotoColorEmoji.ttf v2.051 (sha256 72a635cb...fd6e27b). Every line shapes to"
echo "# exactly one glyph. Format: <code points, hex> ; <glyph id>. An independent oracle for the GSUB pass."
echo "# Made by turning each list line into a UTF-8 string and running"
echo "#   hb-shape --shapers=ot --no-glyph-names --no-positions --no-clusters NotoColorEmoji.ttf < lines.txt"
paste -d';' "$work/keys.txt" "$work/shaped.txt" | tr -d '[]' | awk -F';' '{print $1 "; " $2}'
