# Frontend error log

Problems hit while building `frontend/`, with cause and fix. Newest last.

## 1. `npm install vitest@5.0.5` crashes: `Cannot read properties of null (reading 'edgesOut')`
- **Symptom:** `npm install --save-exact -D vitest@5.0.5` (npm 10.9.9, Node 22.23) aborts. Stack: `#loadPeerSet` in `@npmcli/arborist/lib/arborist/build-ideal-tree.js:1289`. It happened after jsdom was already installed and vitest's optional peers (`jsdom`, `happy-dom`, `@vitest/browser-*`…) were being resolved.
- **Cause:** a known npm Arborist bug: `node.parent` comes back `null` while `#loadPeerSet` recurses over a peer set. The bug is in npm, not in our packages.
- **Fix:** installed that one package with `npm install --save-exact -D vitest@5.0.5 --legacy-peer-deps`. The lockfile it wrote is fine: `npm ci` and a plain `npm install` from `package.json` + `package-lock.json` both pass in a clean directory, so no `.npmrc` is needed.
- **Sources:** https://github.com/npm/cli/issues/8261 · https://github.com/npm/cli/pull/6604 · https://forums.expo.dev/t/eas-build-fail-showing-cannot-read-properties-of-null-reading-children/69412/13

## 2. OSMD spells +6 semitones from C as F♯ (not G♭), so the display and download disagree
- **Symptom:** the app prefers flat keys (Db, Gb, Ab). OSMD's `TransposeCalculator.transposeKey` uses a fixed table `keyMapping=[0,-5,2,-3,4,-1,6,1,-4,3,-2,5]` (indexed by semitone). It always gives 6 sharps for the tritone. `IntervalTransposeCalculator` gets its letter steps from that key, so the notes would come out in F♯ while the downloaded file is in G♭.
- **Cause:** `IntervalTransposeCalculator.transposeKey` delegates to its `fallback` (default `TransposeCalculator`). Found by reading `node_modules/opensheetmusicdisplay/build/opensheetmusicdisplay.min.js` and `build/dist/src/Plugins/Transpose/*.d.ts`.
- **Fix:** `KeyChoiceCalculator extends TransposeCalculator` (in `frontend/src/viewer.ts`) overrides `transposeKey` to set `Key = keyTypeOriginal + fifthsDelta`. `fifthsDelta` comes from the same `targetFifths()` that the export uses. It is passed as the fallback: `new IntervalTransposeCalculator(new KeyChoiceCalculator())`. With that, the display and the export use the same key spelling and the same interval.

## 3. OSMD ignores `<kind text="…">` and shows only the root for `kind="other"`
- **Symptom:** a chord written as `<kind text="7alt">other</kind>` renders as just `C`. `kind="major-sixth"` renders as `Cmaj6`.
- **Cause:** `ChordSymbolReader.readChordSymbol` reads `text` only to tell `aug`/`dim` apart. Otherwise it maps the kind with `ChordSymbolEnum[kind]` (there is no `other`). `calculateChordText` then builds the label from `EngravingRules.ChordSymbolLabelTexts` plus the degrees (`(b9)`, `(alt #5)`, `(omit 3)`) and custom chord names (`7alt`, `7sus4`, `m7b5`, …).
- **Fix/workaround:** `src/lib/chords.ts` maps typed text to real MusicXML kinds plus `<degree>`s (b9/#9/#11/b13 as `add`, b5/#5 as `alter`, `alt` → dominant + #5 b9 #9 alter b5, which OSMD names "7alt"). It falls back to `other` only when nothing matches. In that case OSMD shows just the root, but the chord editor still shows the full text. `viewer.ts` sets `ChordSymbolLabelTexts` for `majorsixth` → `6`, `augmented` → `+` and `augmentedseventh` → `+7` (lead-sheet style). The server should also avoid `kind="other"` where it can.

## 4. vitest + jsdom: `new URL("../x", import.meta.url)` → "The URL must be of scheme file"
- **Symptom:** test helpers that read the sample with `fileURLToPath(new URL(..., import.meta.url))` fail under `environment: "jsdom"`.
- **Cause:** in the jsdom environment `import.meta.url` is not a `file:` URL that `fileURLToPath` accepts.
- **Fix:** use `path.resolve(__dirname, "../public/samples/sample.musicxml")` in `test/helpers.ts`.

## 5. Round trip of chord roots is not exact for every interval
- **Symptom:** sample transposed +1 (F → G♭) and back turns `Bb7` into `A#7`.
- **Cause:** by design. Chord roots that would become Fb/Cb/E#/B# or double accidentals are simplified (B♭ + m2 = C♭ → B), the same as OSMD's `SimpleChordSymbolSpelling`. Going back from B gives A♯.
- **Fix/decision:** this is acceptable because the app always transposes from the untouched concert source, so the loss never builds up. Tests check exact round trips for the common moves (±2, ±5, ±7, +12) and the same pitch class for all other offsets.

## 6. Playwright smoke test: "Failed to load resource … 503" console error
- **Symptom:** the smoke test reported 1 console error.
- **Cause:** Chromium logs every non-2xx response. The test deliberately mocks `/api/convert` → 503 `engine_unavailable` to check that the error message is readable.
- **Fix:** the smoke test ignores only that expected network log. The app itself logs no errors.

## 7. OSMD prints its own chord label, not the one on the lead sheet: "Csus4(b7)", "D7(b9,#9)(alt #5)", "F69", "A7(b9)"
- **Symptom:** the server writes `<kind text="7sus4">suspended-fourth</kind>` + `<degree print-object="no">` (and `7alt`, `6/9`, `7b9` the same way). OSMD 2.2.1 showed `Csus4(b7)`, `D7(b9,#9)(alt #5)`, `F69`, `A7(b9)`, `Bb7(#11)`, `D7(#9)`.
- **Cause:** `ChordSymbolReader.readChordSymbol` reads `kind/@text` only to tell `aug`/`dim` apart and ignores `print-object` on `<degree>`. `ChordSymbolContainer.calculateChordText` then builds the label from `EngravingRules.ChordSymbolLabelTexts[kind]` + `(adds)(alt …)(omit …)`. `EngravingRules.CustomChords` (`addChordName`, PR #933) only renames exact kind + degree sets ("7alt" needs add #5,b9,#9 + alter b5; "7sus4" needs kind dominant + add 4 + subtract 3), so it can't reproduce arbitrary written suffixes. There is no option to use the text (checked the 2.2.1 build, `resetChordNames`, the changelog and the issue tracker). MusicXML defines `kind/@text` as how the kind is spelled (unless `use-symbols="yes"`), and Finale and MuseScore print it.
- **Fix:** `src/lib/osmd-chords.ts` → `installChordTextPatch()`, called once from `viewer.ts`. It wraps the two exported statics (OSMD calls them through the class object, so the patch reaches the reader and the label code). The reader wrapper stores the text on the container and drops degrees marked `print-object="no"`. When a text is stored, the label is the root (transposed by OSMD's active `TransposeCalculator`, accidental from `ChordAccidentalTexts`) + text + `/bass`. N.C., numerals, `use-symbols="yes"`, and harmonies without text keep OSMD's label. The empty-text rule is the same as `harmonyToText()`. Display transposition and the exported file both keep the suffix: D7alt → E7alt, C7sus4 → D7sus4, F6/9 → G6/9 for Bb. No server change was needed. Tests: `test/osmd-chords.test.ts` loads real MusicXML through OSMD in jsdom (with a stub canvas) and checks the labels, transposed labels, the fixture, and the exported Bb part. Those tests fail without the patch.
- **Sources:** `node_modules/opensheetmusicdisplay/build/opensheetmusicdisplay.min.js` (`readChordSymbol`, `calculateChordText`, `resetChordNames`); https://github.com/opensheetmusicdisplay/opensheetmusicdisplay/pull/933 (CustomChords); https://github.com/opensheetmusicdisplay/opensheetmusicdisplay/issues/930; https://www.w3.org/2021/06/musicxml40/musicxml-reference/elements/kind/ ; https://musescore.org/en/node/301372

## 8. "Untitled" in the app (and `untitled-….musicxml` downloads) when OSMD shows a title
- **Symptom:** a file whose only title is a `<credit><credit-type>title</credit-type>` showed "Untitled" in the title box and the download name, while OSMD drew the real title. Audiveris files had no title at all (backend #14).
- **Fix:** `getTitle()` falls back to the title credit. The Audiveris engine now writes `<work-title>` (backend #14), so the e2e download is `blue-lantern-G-Bb-part.musicxml`.
