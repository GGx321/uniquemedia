# Emoji reader fixtures

- `emoji-test-17.0.txt` is the unmodified `emoji-test.txt` of Unicode Emoji 17.0
  (https://unicode.org/Public/17.0.0/emoji/emoji-test.txt, dated 2025-08-04). Noto Color Emoji
  v2.051 covers every fully-qualified sequence of it. Emoji 18.0 (19 fully-qualified sequences
  more) is not covered by that font release. The file is Unicode data, used under the
  Unicode License v3 (`UNICODE-LICENSE.txt`, https://www.unicode.org/license.txt).
  Copyright (c) 2025 Unicode, Inc.
- `emoji-test-17.0.hb-glyphs.txt` is generated data: the glyph HarfBuzz shapes each
  fully-qualified sequence to. See its header. `makeHbGlyphs.sh <font> <emoji-test.txt>` regenerates it
  (needs `hb-shape` and `python3`), so moving to a new font or Unicode list is mechanical.

The font itself is not here: the tests read the committed `studio/assets/fonts/NotoColorEmoji.ttf`
through `loadEmojiFont`, which checks its sha256 (`emojiFont.testkit.ts`).
