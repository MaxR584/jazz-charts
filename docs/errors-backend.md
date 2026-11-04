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
- **Fix/workaround:** `fixAudiverisHarmonies()` re-parses each harmony's displayed text with our parser and converts `<words>` that are clearly chord symbols into `<harmony>`. This raised chord F1 to 0.84 (PDF) / 0.86 (PNG). Flat-rooted chords are still lost, so use the Claude engine for chord-heavy charts.

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
