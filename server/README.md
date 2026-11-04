# Jazz Charts server

Node + TypeScript (Fastify) API that turns a lead-sheet screenshot (PNG/JPEG/WebP)
or PDF into MusicXML 4.0. The API is specified in [`../docs/CONTRACT.md`](../docs/CONTRACT.md),
and the types are in [`../shared/types.ts`](../shared/types.ts).

## Run

```bash
cd server
npm install
npm run dev          # watch mode, http://localhost:3001
# or
npm start
```

```bash
curl localhost:3001/api/health
curl -F file=@../fixtures/sample-1.png -F engine=mock      localhost:3001/api/convert
curl -F file=@../fixtures/sample-1.pdf -F engine=audiveris localhost:3001/api/convert
```

| Env var | Default | Meaning |
|---|---|---|
| `PORT` | `3001` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `ANTHROPIC_API_KEY` | – | Enables the `claude` engine (and makes it the `auto` choice) |
| `CLAUDE_MODEL` | `claude-opus-5-5` | Vision model for the `claude` engine |
| `CLAUDE_EFFORT` | `high` | `low` … `max` |
| `AUDIVERIS_BIN` | `vendor/audiveris/bin/Audiveris` | Audiveris launcher |
| `AUDIVERIS_TIMEOUT_MS` | `300000` | Kill Audiveris after this long |
| `TESSDATA_PREFIX` | `vendor/audiveris/tessdata` if present | OCR languages for Audiveris |
| `MAX_PDF_PAGES` | `20` | Pages rasterized per PDF (extra pages produce a warning) |
| `FIXTURES_DIR` | `../fixtures` | Where the `mock` engine reads `sample-1.json` |

System tools: `pdftoppm` and `pdfinfo` (poppler-utils) for PDFs. Tests also need `xmllint`.

## Engines

`engine=auto` (default) uses `claude` if `ANTHROPIC_API_KEY` is set, else `audiveris` if it's installed, else `mock`.

- **claude**: each page image goes to Claude with a JSON schema (structured outputs via
  `output_config.format`). The model returns a `LeadSheet` transcription. Pages are
  joined and renumbered, and MusicXML is built **in code** (`src/musicxml/builder.ts`). Measures that fail
  validation (duration, unparsed chord, …) get **one** repair request (image + JSON + errors → corrected
  measures only). Uses adaptive thinking, streaming, and server-side refusal fallback (`fallbacks: "default"`).
- **audiveris**: offline OMR. PDFs go to Audiveris as-is; images are auto-oriented, converted to grayscale and
  upscaled to about 2400 px. The engine runs `Audiveris -batch -export`, unzips the `.mxl`, re-derives
  chord kinds from the OCR text, and validates the result (`model` is `null`). Jobs run one at a time.
- **mock**: returns `fixtures/sample-1.json` built to MusicXML, whatever you upload.

### Install Audiveris

```bash
npm run install-audiveris        # = bash scripts/install-audiveris.sh [version]
```

This downloads the official Ubuntu `.deb` (default 5.11.0) from GitHub releases and extracts it into
`server/vendor/audiveris` (gitignored; no root or system install needed). The package bundles its own Java 25
runtime, so the system Java version doesn't matter. The script also downloads Tesseract `eng.traineddata`
into `vendor/audiveris/tessdata`. Without it, Audiveris skips all text, including chord symbols. Override the URL with
`AUDIVERIS_DEB_URL`, and add more OCR languages with `AUDIVERIS_OCR_LANGS="eng deu"`. Only x86_64 is supported. On other
platforms, install Audiveris yourself and set `AUDIVERIS_BIN`. Audiveris is AGPL-3.0. We run it as a separate
process and don't link it.

If Audiveris isn't installed, `/api/health` reports `audiveris: false` and `engine=audiveris` returns `503 engine_unavailable`.

## Tests

```bash
npm test             # vitest: builder (XSD-validated), validator, chord parser, PDF splitting,
                     # API routes (fastify.inject), Claude engine (mocked SDK), Audiveris (fake runner
                     # + real run on the fixtures when installed)
npm run typecheck
npm run eval:audiveris   # accuracy of Audiveris on fixtures/sample-1.{pdf,png}
npm run fixtures         # regenerate fixtures/sample-1.{musicxml,png,pdf} from sample-1.json
```

The MusicXML 4.0 XSD is in `test/schema/` (from w3c/musicxml tag `v4.0`, with imports pointed at local
copies so `xmllint --nonet` works offline). `npm run fixtures` needs Playwright's Chromium (used through
`require("playwright")`) and `verovio` (a dev dependency).

## Layout

```
src/app.ts                  routes, upload limits, MIME sniffing, error mapping
src/pipeline/sniff.ts       magic-byte type detection
src/pipeline/pages.ts       PDF → PNG pages (pdftoppm), image normalization (sharp)
src/musicxml/chords.ts      jazz chord-symbol parser → <harmony> kind/degrees
src/musicxml/builder.ts     LeadSheet → MusicXML (pure function)
src/musicxml/validate.ts    warnings for LeadSheet JSON and for raw MusicXML
src/musicxml/summary.ts     token streams + LCS F1 for accuracy measurement
src/engines/{claude,audiveris,mock}.ts
scripts/install-audiveris.sh, render-fixtures.ts, eval-audiveris.ts
```

## Notes for renderers

- Chord `<kind text="...">` holds the suffix as written (e.g. `-7`, `7alt`). Alterations are also
  encoded as `<degree print-object="no">`. OSMD ignores both `text` and `print-object` and builds the
  label from kind + degrees. Verovio prints the text plus the degrees. `kind="other"` appears only for
  symbols the parser can't read (they also produce an `unparsed_chord` warning).
- Divisions are 12 per quarter, doubled automatically when 32nds or dotted 16ths need it.
