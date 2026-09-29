# Bundled fonts

The fonts Studio draws on-video text with. All are SIL Open Font License 1.1; each licence
text sits next to its font. The manifest that pins every file by size and sha256 is
`studio/engine/text/fonts.ts` (`TEXT_FONTS`, `EMOJI_FONT`); a file that does not match it is
refused at load.

| File | Family, weight | Origin | Licence |
|---|---|---|---|
| `Manrope-800.ttf` | Manrope 800 | instance of the variable font | `Manrope-OFL.txt` |
| `PlayfairDisplay-600.ttf` | Playfair Display SemiBold (600) | **official static** (Reserved Font Name) | `PlayfairDisplay-OFL.txt` |
| `Oswald-600.ttf` | Oswald 600 | instance of the variable font | `Oswald-OFL.txt` |
| `PTMono-400.ttf` | PT Mono 400 | **official static**, unmodified (Reserved Font Names) | `PTMono-OFL.txt` |
| `Caveat-600.ttf` | Caveat 600 | instance of the variable font | `Caveat-OFL.txt` |
| `NotoColorEmoji.ttf` | Noto Color Emoji, CBDT | noto-emoji v2.051, unmodified | `NotoColorEmoji-OFL.txt` |

## Provenance

- **Why statics:** resvg 2.6.x does not instantiate variable fonts.
- **Reserved Font Names:** OFL forbids a Reserved Font Name on a modified version, so Playfair
  Display and PT Mono are never re-cut.
  - Playfair: `static/PlayfairDisplay-SemiBold.ttf` from Google Fonts' own download for the
    family (`fonts.gstatic.com`, v40).
  - PT Mono: ParaType's `PTM55FT.ttf`, from the `google/fonts` repo, `ofl/ptmono/`.
- **Instances** (Manrope, Oswald, Caveat have no Reserved Font Name): the variable TTFs from
  `google/fonts` commit `23e54b51ddffbc7713c583748e3bd86f62b1fa4a` (`ofl/<family>/<Family>[wght].ttf`),
  cut with `uvx --from fonttools fonttools varLib.instancer "<Family>[wght].ttf" wght=<weight> -o <Family>-<weight>.ttf`
  (fontTools 4.66.1; weights 800, 600, 600).
- **Emoji:** `fonts/NotoColorEmoji.ttf` of the `googlefonts/noto-emoji` tag `v2.051`. resvg 2.6.2
  draws no variant of this font; the engine's own reader (3b.4a) takes the bitmaps out of it.
- **Licence texts:** `OFL.txt` of each family in `google/fonts` at the commit above; the emoji
  one is `fonts/LICENSE` of the noto-emoji tag.

Coverage (invariant 22) is a test: `studio/engine/text/fonts.test.ts` checks every text font's
`cmap` for printable ASCII, the typographic marks ’ ‘ “ ” – — … and the Russian alphabet.
