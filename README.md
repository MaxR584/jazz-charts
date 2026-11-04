# Jazz Charts

Upload a screenshot or PDF of a jazz lead sheet, convert it to editable
MusicXML, then view, transpose (any key, Bb/Eb/F instruments), edit and
download it in the browser.

## Run

```bash
cd server && npm install && npm run install-audiveris && npm start   # :3001
cd frontend && npm install && npm run dev                            # :5173
```

Set `ANTHROPIC_API_KEY` for the Claude recognition engine (best for chord
symbols). Without it, Audiveris (offline) or the mock engine is used.

End-to-end test with both running: `node frontend/e2e/full-flow.cjs`.

See `docs/CONTRACT.md` for the API, `server/README.md` for engines, and
`docs/errors-*.md` for known issues and fixes.
