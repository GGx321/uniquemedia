# Emoji reader fixtures

- `emoji-test-16.0.txt` is the unmodified `emoji-test.txt` of Unicode Emoji 16.0
  (https://unicode.org/Public/emoji/16.0/emoji-test.txt), the version Noto Color Emoji
  v2.051 supports. It is Unicode data, used under the Unicode License v3 (`UNICODE-LICENSE.txt`,
  https://www.unicode.org/license.txt). Copyright (c) 2024 Unicode, Inc.
- `emoji-test-16.0.hb-glyphs.txt` is generated data: the glyph HarfBuzz shapes each
  fully-qualified sequence to. See its header.

The font itself is never committed here. The tests fetch the pinned release into the
gitignored `.cache/` (`emojiFont.testkit.ts`) and check its sha256.
