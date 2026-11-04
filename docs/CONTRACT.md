# Jazz Charts — frontend/backend contract

Upload a screenshot or PDF of a jazz lead sheet → get editable MusicXML →
view, transpose, edit and download it in the browser.

## Layout

```
frontend/   Vite + TypeScript web app (port 5173). Own package.json.
server/     Node + TypeScript API (port 3001). Own package.json.
shared/     types.ts — shared TypeScript types. Both sides import it by relative path.
fixtures/   Sample lead sheets (PNG + PDF + expected .musicxml). Public domain or self-made only.
docs/       This contract, plus errors-frontend.md / errors-backend.md logs.
```

In dev, Vite proxies `/api/*` to `http://localhost:3001`.

## API

### `GET /api/health`
```json
{ "ok": true, "engines": { "claude": false, "audiveris": true, "mock": true } }
```

### `POST /api/convert`
`multipart/form-data`:
- `file` (required): `image/png`, `image/jpeg`, `image/webp` or `application/pdf`. Max 20 MB.
- `engine` (optional): `auto` (default) | `claude` | `audiveris` | `mock`.
  `auto` = claude if `ANTHROPIC_API_KEY` is set, else audiveris if installed. Never mock (it always returns the sample); with neither, `503 engine_unavailable`.

Response `200`: `ConvertResponse` (see `shared/types.ts`).
Errors: `4xx/5xx` with `{ "error": { "code": string, "message": string } }`.
Codes: `unsupported_type`, `file_too_large`, `engine_unavailable`, `recognition_failed`, `internal`.

`musicxml` is always a complete, uncompressed MusicXML 4.0 `score-partwise`
string. The frontend treats **MusicXML as the source of truth** (Audiveris can't
produce the JSON model). `model` is extra information and may be `null`.

## Frontend responsibilities
Upload (drag/drop, file picker, paste-from-clipboard), progress + errors,
render with OSMD, transpose (key picker, ±semitone, Concert/Bb/Eb/F presets),
basic editing (chord symbols, and note pitch up/down at minimum), show
`warnings` against measures, download `.musicxml` of the **transposed/edited**
score, save charts locally (IndexedDB). Also allow opening an existing
`.musicxml`/`.mxl` file directly without the server.

## Backend responsibilities
`/api/convert` pipeline: PDF → page images (MuPDF) → engine →
MusicXML. Engines: Claude vision (JSON transcription → code-built MusicXML),
Audiveris (offline, PDFs/images → .mxl → unzip), mock (returns a fixture). Validation
(`warnings`). Tests and fixtures.
