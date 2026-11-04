# Jazz Charts

Upload a screenshot or PDF of a jazz lead sheet, convert it to editable
MusicXML, then view, transpose (any key, Bb/Eb/F instruments), edit and
download it in the browser. Runs entirely on your own computer.

## Run on Windows (no API key needed)

Needs [Node.js](https://nodejs.org) LTS. In PowerShell, `npm.cmd` works even
when script policies block `npm`.

One-time setup, from the `server` folder:

```powershell
npm.cmd install
npm.cmd run install-audiveris:windows
```

Then from the `frontend` folder:

```powershell
npm.cmd install
```

Each time, open two PowerShell windows:

1. `server` folder: `npm.cmd run dev`
2. `frontend` folder: `npm.cmd run dev`, then open http://localhost:5173

Recognition uses Audiveris, a free offline engine. It reads notes well and
most chord symbols; check the warnings it shows and fix anything it missed
with the chord editor.

## Run on Linux / macOS

```bash
cd server && npm install && npm run install-audiveris && npm start   # :3001 (macOS: install Audiveris yourself, set AUDIVERIS_BIN)
cd frontend && npm install && npm run dev                            # :5173
```

## Optional: Claude engine

For better chord-symbol reading, set `ANTHROPIC_API_KEY` before starting the
server (PowerShell: `$env:ANTHROPIC_API_KEY = "sk-ant-..."`). It's used
automatically when set.

End-to-end test with both running: `node frontend/e2e/full-flow.cjs`.

See `docs/CONTRACT.md` for the API, `server/README.md` for engines, and
`docs/errors-*.md` for known issues and fixes.
