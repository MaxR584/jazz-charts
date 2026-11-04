# Backend error log

Problems found while building `server/`, and how each was resolved.

## 1. GitHub API / `gh` blocked for audiveris/audiveris
- **Symptom:** `gh api repos/audiveris/audiveris/releases` → `HTTP 403 GitHub access to this repository is not enabled for this session`. `api.github.com` returns 403, and `github.com/.../releases/expanded_assets/...` returns 403 through the proxy.
- **Cause:** the sandbox egress proxy only allows anonymous git reads and release-asset downloads for unattached repos, not the REST API or HTML pages.
- **Fix:** list tags with `git ls-remote --tags https://github.com/audiveris/audiveris` (latest: `5.11.0`). Then download the asset by its conventional name, `releases/download/5.11.0/Audiveris-5.11.0-ubuntu24.04-x86_64.deb`, which returns a 302 to `release-assets.githubusercontent.com` (a wrong name returns 404). The install script builds this URL and accepts `AUDIVERIS_DEB_URL` as an override.
- **Source:** `/root/.ccr/README.md`, https://github.com/audiveris/audiveris/releases

## 2. Install script downloaded a malformed URL
- **Symptom:** `curl: (3) URL rejected: .../download/24.04.5 LTS (Noble Numbat)/...`
- **Cause:** `. /etc/os-release` defines `VERSION`, which overwrote the script's `VERSION` variable.
- **Fix:** read os-release in a subshell: `OS_VER="$( (. /etc/os-release && echo "$ID-$VERSION_ID") )"`.

## 3. Java version for Audiveris
- **Symptom (expected):** system Java is OpenJDK 21. Recent Audiveris releases need a newer JDK to run from the jar.
- **Cause / finding:** the official `.deb` is a jpackage bundle with its own runtime (`lib/runtime/release` → `JAVA_VERSION="25.0.3"`).
- **Fix:** extract the `.deb` with `dpkg-deb -x` into `server/vendor/audiveris` (no root) and run `bin/Audiveris`. The system Java isn't used. `JAVA_TOOL_OPTIONS` from the environment is still picked up, so the server appends `-Djava.awt.headless=true`.
- **Source:** https://github.com/audiveris/audiveris/releases (5.11.0 assets), `vendor/audiveris/lib/runtime/release`

## 4. Audiveris recognized no chord symbols or titles
- **Symptom:** log shows `WARN Languages | *** No installed OCR languages ***` and `TesseractOCR | The collection of supported languages is empty`. The MusicXML has no `<harmony>` elements.
- **Cause:** Audiveris bundles Tesseract but no language data. By default it looks in `~/.config/AudiverisLtd/audiveris/tessdata`.
- **Fix:** the install script downloads `eng.traineddata` from `https://raw.githubusercontent.com/tesseract-ocr/tessdata/main/` into `vendor/audiveris/tessdata` (`github.com/.../raw/...` is 403 through the proxy, but `raw.githubusercontent.com` works). The engine sets `TESSDATA_PREFIX` to that folder, and Audiveris logs `Installed OCR languages: eng`. Chord F1 on the fixture went from 0 to about 0.75.
- **Source:** Audiveris handbook, OCR languages (https://audiveris.github.io/audiveris/_pages/install/languages/); https://github.com/tesseract-ocr/tessdata

## 5. Audiveris chord kinds wrong or missing
- **Symptom:** `Em7b5` exported as `<kind text="m7b5">minor-seventh</kind>` + b5 degree. `D7alt` exported as `<words>`. Every flat-rooted chord (B♭maj7, E♭7, B♭7#11, B♭m7) and `F6/9` missing.
- **Cause:** Audiveris's chord-name grammar and its OCR. The flat glyph in chord roots isn't read.
- **Fix/workaround:** `fixAudiverisHarmonies()` re-parses each harmony's displayed text with our parser and converts `<words>` that are clearly chord symbols into `<harmony>`. This raised chord F1 to 0.84 (PDF) / 0.86 (PNG). Flat-rooted chords were still lost here; fixed by OCR tuning in #14.

## 6. Audiveris output version
- **Symptom:** `<score-partwise version="4.0.3">`, DOCTYPE `MusicXML 4.0.3`.
- **Fix:** relabel `version="4.0"`. The output validates against the 4.0 XSD unchanged.

## 7. MusicXML XSD: wrong branch and remote imports
- **Symptom:** the default branch of w3c/musicxml (`gh-pages`) is the 4.1 draft. `musicxml.xsd` imports `http://www.musicxml.org/xsd/xml.xsd` and `xlink.xsd`, which fails with `xmllint --nonet`.
- **Fix:** take `schema/{musicxml,xml,xlink}.xsd` from tag `v4.0` and rewrite the two `schemaLocation`s to the local files (`server/test/schema/SOURCE.txt`).

## 8. Skill example has `<degree>` before `<bass>`
- **Symptom:** the `musicxml-lead-sheets` skill shows `<degree>` before `<bass>`. The XSD requires `root, kind, inversion?, bass?, degree*`.
- **Fix:** the builder emits `bass` before `degree`. The XSD tests cover `Ebmaj7/G` and similar symbols.

## 9. Durations not integral at divisions = 12
- **Symptom:** 32nd = 1.5 ticks, dotted 16th = 4.5 ticks.
- **Fix:** `chooseDivisions()` doubles divisions (24, 48, …) until every duration is an integer. Tested.

## 10. Verovio prints degrees twice
- **Symptom:** fixture render showed `A7b9(♭9)`, `B♭7#11(add♯11)`, `F6/9(9)`.
- **Cause:** Verovio appends degrees to the `kind/@text` and ignores `<degree print-object="no">`. (OSMD 2.2.1 also ignores `print-object` on degrees and ignores `kind/@text`; checked in its minified build, `readChordSymbol`.)
- **Fix:** the builder keeps degrees, because OSMD needs them (coordinator request: real `kind` + `degree`, `other` only as a last resort). The fixture render script strips hidden degrees before engraving.

## 11. `tsc` can't resolve `playwright` types
- **Symptom:** `TS2307: Cannot find module 'playwright'` in `scripts/render-fixtures.ts`.
- **Cause:** Playwright is installed globally (`/opt/node-tools`) and isn't a package dependency. `require()` works through `NODE_PATH`, but type resolution doesn't.
- **Fix:** load it with `createRequire` and declare a minimal local type for the few methods used.

## 12. `tsx` scratch scripts with top-level await
- **Symptom:** `Top-level await is currently not supported with the "cjs" output format` for a `.ts` file outside the package.
- **Fix:** use `.mts` (or keep scripts inside `server/`, which is `"type": "module"`).

## 13. homr (pip) evaluation
- **Result:** `pip install homr==0.7.0` works on Python 3.13 (requires 3.11–3.15). The venv is about 400 MB (onnxruntime, opencv, rapidocr), and models download on first run. On `fixtures/sample-1.png` it took 19 s on CPU: 17/17 measures, pitch F1 1.00, note+duration F1 0.957, and **chord F1 0**. It has no chord-symbol support and took the first chord ("Fmaj7") as the title. It also read the tie as a slur, dropped the endings, and turned the slash bar into rests.
- **Conclusion:** homr is viable as an offline melody reader, but it adds no value over Audiveris for lead sheets because chord symbols are the main content. Not integrated.
- **Source:** https://pypi.org/project/homr/, https://github.com/liebharc/homr

## 14. Audiveris lost flat-root chords and read the title as a direction
- **Symptom:** on `fixtures/sample-1.{png,pdf}` chord F1 was 0.863 / 0.84. B♭maj7, B♭m7, E♭7 and B♭7#11 were missing. On the PDF, "Blue Lantern" became a `<words>` direction above bar 2, so the score had no title ("Untitled Score", with the title text on top of the chords).
- **Investigation:** I ran `bin/Audiveris -batch -export` directly, unzipped the `.omr` (`sheet#N/sheet#N.xml`: `<sentence role=…>` and `<chord-name value=…>`), and enabled DEBUG for `org.audiveris.omr.text` and `org.audiveris.omr.sig` with a `-Dlogback.configurationFile`. I read the constants with `javap -c -p` on `lib/app/audiveris.jar`.
  - **PDF:** Tesseract reads the flat correctly (`"Bb7#11" conf:0.53`, `"Bbm7" 0.54`, `"Eb7" 0.59`), but under `TesseractOCR.minConfidence` (0.65), so the words were dropped. With that threshold lowered, `SigReducer` still removed them. A chord name's grade is confidence × `Grades.intrinsicRatio` (0.8) = 0.43-0.47, which is under `Grades.minContextualGrade` (0.5). `TextLine.sentenceLowerLength` (10 chars) is too long to boost a chord name.
  - **PNG (upscaled screenshot):** the ♭ came out as `l>`, `I>` or `L` ("Bl>maj7", "BI>7#11", "BLm7"). The chord grammar (`ChordNameInter`, roots `[A-G][b♭#♯]?`, degrees 5/6/7/9/11/13 only, so not `6/9` or `alt`) rejects these, and they became Direction or even CreatorComposer text.
  - **Roles (`TextRole.guess`):** "B♭7#11" ended 9 px from the staff's right end, inside `maxRightDx` (2 interlines), so it was taken for the composer. The title was ~6.6 interlines above the staff, inside `maxStaffDy` (7), so it counted as a direction.
- **Fix:**
  - `AUDIVERIS_CONSTANTS` in `server/src/engines/audiveris.ts`, passed as `-option key=value`:
    - `TesseractOCR.minConfidence=0.45`
    - `Grades.minContextualGrade=0.4`
    - `TesseractOrder.blackList=<>|\{}[]~` (Tesseract then reads ♭ as `b`)
    - `TextRole.maxStaffDy=5` (title becomes role Title → `<movement-title>`)
    - `TextRole.maxRightDx=0.25`
  - Post-processing:
    - `repairOcrChord()` turns `Bl>maj7` / `BI>7#11` / `BLm7` into B♭ chords when converting `<words>`.
    - `promoteTitle()` moves `<movement-title>` to `<work><work-title>` (OSMD would otherwise print it again as a subtitle) and marks the matching credit `credit-type=title`. When Audiveris left the title as a direction, it promotes large (≥1.2× chord size), roughly centred `<words>` in the first system that aren't a known direction to `<work-title>`. It adds no credit, because OSMD prints an extra centred credit as a subtitle.
    - New warnings:
      - chord names Audiveris logged as `No chord below ChordNameInter … TEXT "C7"`;
      - chord-row words that look like a misread chord ("vaaj7" for B♭maj7 on the PDF, `unparsed_chord` with the bar);
      - single-letter rehearsal marks that don't start at A (the PNG's boxed A/B are read as "E" now that their grade passes 0.4).
    - The server temp path in `<source>` / `source-file` is removed, and the DOCTYPE is relabelled 4.0.
  - Tests use a real raw Audiveris output, `fixtures/audiveris-raw-sample-1-pdf.xml` (XSD-checked after post-processing).
- **Result (`npm run eval:audiveris`):**
  - **PDF:** chord F1 0.84 → **0.906**. Notes 0.991, pitches 1.0 (unchanged).
  - **PNG:** chord F1 0.863 → **0.945**. Notes 0.982 → 0.991, pitches 0.99 → 1.0.
  - Both get `<work-title>Blue Lantern</work-title>`.
  - The real-run test now requires chord F1 > 0.88 and Bb7, Bbm7, Eb7 present.
- **Still open:**
  - Audiveris removes a chord name with no note or rest starting under it: m8 beat 3 (C7 over a held half note) and the slash bar m13 (Gm7, C7). These now get a warning.
  - On the 300-dpi PDF, B♭maj7 is still read as "vaaj7" (warned). At `ImageLoading.pdfResolution=400` it is read correctly, but E♭7 becomes "EW" and "Am7 D7alt" merges into one direction, so the resolution stays at 300.
  - The PDF's page-2 Am7 (m12) is not OCR'd.
  - The rehearsal marks in the PNG are read as "E".
- **Sources:** Audiveris 5.11 jar (`TesseractOCR$Constants`, `TesseractOrder$Constants`, `TextLine.getGrade`, `TextRole.guess`, `glyph.Grades$Constants`, `ChordNameInter`); Audiveris handbook, CLI `-option`: https://audiveris.github.io/audiveris/_pages/reference/advanced/cli/ ; OCR languages: https://audiveris.github.io/audiveris/_pages/install/languages/ ; Tesseract `tessedit_char_blacklist`: https://tesseract-ocr.github.io/tessdoc/ImproveQuality.html

## 15. "Too low interline value" on small screenshots

- **Symptom:** Audiveris fails with `Error in export`; its log says
  `With a too low interline value of N pixels ... the picture resolution is too low (try 300 DPI)`.
  The app showed "The staff lines in this image are too small".
- **Cause:** Audiveris needs staff lines at least ~5 px apart. A screenshot of a whole page at
  screen size often has 3–6 px. The old resize (long edge to 2400 px, at most 2×) wasn't enough.
- **Fix:** `estimateInterline()` measures the staff-line spacing from the row-darkness profile
  (matches Audiveris' own measurement: 12 px on sample-1.png, 4 px at 500 px wide). `omrImage()`
  scales so the spacing is ~20 px (up to 6×), and below 10 px also sharpens and converts to
  black and white. If Audiveris still reports a too-low interline, the retry rescales from the
  value it reported. Below 3.5 px the app says the image is too small and how to fix it.
- **Results** (sample-1.png shrunk, notes / chords F1): 500 px wide (4 px spacing) failed → 0.78 / 0.38;
  700 px (6 px) → 0.99 / 0.51; full size unchanged (0.991 / 0.945). 300 px (2.5 px) still fails, with a clear message.
