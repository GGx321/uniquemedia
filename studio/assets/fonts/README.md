# Bundled fonts

The fonts Studio draws on-video text with. All are SIL Open Font License 1.1; each licence
text sits next to its font. The manifest that pins every file by size and sha256 is
`studio/engine/text/fonts.ts` (`TEXT_FONTS`, `EMOJI_FONT`); a file that does not match it is
refused at load. `recipe/` (not shipped) rebuilds the three instances.

| File | Family, weight | Origin | Licence |
|---|---|---|---|
| `Manrope-800.ttf` | Manrope ExtraBold (800) | instance of the variable font | `Manrope-OFL.txt` |
| `PlayfairDisplay-600.ttf` | Playfair Display SemiBold (600) | **official static** (Reserved Font Name) | `PlayfairDisplay-OFL.txt` |
| `Oswald-600.ttf` | Oswald SemiBold (600) | instance of the variable font | `Oswald-OFL.txt` |
| `PTMono-400.ttf` | PT Mono Regular (400) | **official static**, unmodified (Reserved Font Names) | `PTMono-OFL.txt` |
| `Caveat-600.ttf` | Caveat SemiBold (600) | instance of the variable font, names rewritten | `Caveat-OFL.txt` |
| `NotoColorEmoji.ttf` | Noto Color Emoji, CBDT | noto-emoji v2.051, unmodified | `NotoColorEmoji-OFL.txt` |

## Provenance

- **Why statics:** resvg 2.6.x does not instantiate variable fonts.
- **Reserved Font Names:** OFL forbids a Reserved Font Name on a modified version, so Playfair
  Display and PT Mono are never re-cut.
  - Playfair: `static/PlayfairDisplay-SemiBold.ttf` from Google Fonts' own download for the
    family (`https://fonts.google.com/download/list?family=Playfair%20Display`), which names
    `https://fonts.gstatic.com/s/playfairdisplay/v40/nuFvD-vYSZviVYUb_rj3ij__anPXJzDwcbmjWBN2PKebukDQZNLo_U2r.ttf`.
    sha256 `0f8ae66ea018739838dac8fc0a70f9dd6fe8806bf4f63bb35b3c643480221d31`.
  - PT Mono: ParaType's `PTM55FT.ttf`, from the `google/fonts` repo, `ofl/ptmono/`.
- **Instances** (Manrope, Oswald, Caveat have no Reserved Font Name): the variable TTFs of
  `google/fonts` commit `23e54b51ddffbc7713c583748e3bd86f62b1fa4a`
  (`ofl/<family>/<Family>[wght].ttf`), cut by `recipe/make-statics.sh SRC_DIR OUT_DIR`:
  - `fonttools varLib.instancer <font> wght=<weight> --update-name-table --no-recalc-timestamp`
    with fontTools **4.66.1** (weights 800, 600, 600). `--update-name-table` names the instance
    from STAT ("Manrope ExtraBold", "Oswald SemiBold"); `--no-recalc-timestamp` keeps
    `head.modified` out, so a rebuild gives the same sha256 (two runs were compared).
  - Caveat's STAT has no wght=600 axis value, so `--update-name-table` refuses it;
    `recipe/fix-caveat-names.py` sets its name table to "Caveat SemiBold" (family "Caveat").
  - Without those flags the instances kept the variable font's default names ("Manrope
    ExtraLight", "Oswald Regular"), which the tests now forbid.
- **Emoji:** `fonts/NotoColorEmoji.ttf` of the `googlefonts/noto-emoji` tag `v2.051`. resvg 2.6.2
  draws no variant of this font; the engine's own reader (3b.4a) takes the bitmaps out of it.
- **Licence texts:** `OFL.txt` of each family in `google/fonts` at the commit above; the emoji
  one is `fonts/LICENSE` of the noto-emoji tag.

Checks in `studio/engine/text/fonts.test.ts`: every text font's `cmap` covers printable ASCII, the
typographic marks ’ ‘ “ ” – — … and the Russian alphabet (invariant 22); every name table gives the
manifest's family, weight and full name; none still carries an `fvar` table.
