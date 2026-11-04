---
name: leadsheet-image-to-musicxml
description: Convert a screenshot or photo of a jazz lead sheet (melody + chord symbols, Real Book style) into MusicXML. Use when building or debugging the upload → recognition step of the jazz chart app, choosing an OMR engine, writing the vision prompt, or validating/repairing recognized output.
---

# Lead sheet image → MusicXML

## Pick the engine

Jazz lead sheets are a hard case for classic optical music recognition (OMR):
handwritten-style fonts (Real Book / "Inkpen"), chord symbols above the staff,
repeat signs, first/second endings, segno/coda, slash notation. Classic OMR
tools mostly ignore chord symbols.

| Engine | Chord symbols | Handwritten fonts | Runs where | Notes |
|---|---|---|---|---|
| **Claude vision (recommended)** | Yes | Good | Server (API key) | Ask for MusicXML directly; validate + repair afterward. |
| Audiveris (Java, AGPL) | Partial/poor | Weak | Server/CLI | Best for clean engraved scores. `audiveris -batch -export -output out/ in.png` → `.mxl`. |
| homr (Python) | No | Moderate | Server | Built for phone photos of printed music; outputs MusicXML. |

Default plan: Claude vision as primary, optionally Audiveris as a second
opinion for melody pitches on clean engraved input. Never call the Claude
API from the browser with a raw key. Put a small server route (`/api/recognize`)
in front of it.

## Server route (Node, Anthropic SDK)

Before writing this code, load the `claude-api` skill for current model IDs,
SDK details and limits. Shape of the call:

```ts
import Anthropic from "@anthropic-ai/sdk";
const client = new Anthropic(); // ANTHROPIC_API_KEY from env

const msg = await client.messages.create({
  model: MODEL_ID,            // from the claude-api skill; use a top vision model
  max_tokens: 16000,          // a 32-bar tune is ~15–40 KB of MusicXML
  system: SYSTEM_PROMPT,
  messages: [{
    role: "user",
    content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: b64 } },
      { type: "text", text: "Transcribe this lead sheet." },
    ],
  }],
});
```

- Accept PNG/JPEG/WebP. Downscale so the long edge is ≤ ~2000 px. Larger
  images cost more and don't read better.
- Multi-page charts: one image per call, then concatenate measures. Or send all
  pages in one message if they fit.
- Stream the response for long charts so the UI can show progress.

## Prompt strategy: intermediate JSON, then build XML in code

Asking the model for raw MusicXML works, but it often gets `<duration>` /
`<divisions>` arithmetic wrong. More reliable: ask for a compact JSON
transcription, then generate MusicXML deterministically in code (see the
`musicxml-lead-sheets` skill for the builder rules).

Suggested JSON schema to request:

```json
{
  "title": "Autumn Leaves", "composer": "Joseph Kosma",
  "key": { "fifths": -2, "mode": "major" },
  "time": { "beats": 4, "beatType": 4 },
  "clef": "treble",
  "measures": [
    {
      "number": 1,
      "barlineLeft": "repeat-forward" | null,
      "barlineRight": "repeat-backward" | "final" | "double" | null,
      "ending": { "number": "1", "type": "start" | "stop" | "discontinue" } | null,
      "rehearsal": "A" | null,
      "navigation": "segno" | "coda" | "D.S. al Coda" | "Fine" | null,
      "chords": [ { "beat": 1, "symbol": "Cm7" }, { "beat": 3, "symbol": "F7" } ],
      "notes": [
        { "pitch": "Bb4", "duration": "q", "dots": 0, "tie": "start" | "stop" | null, "tuplet": null },
        { "rest": true, "duration": "h" }
      ]
    }
  ]
}
```

Duration codes: `w h q 8 16 32`; `dots` 0–2; triplets as
`"tuplet": {"actual": 3, "normal": 2}`.

System prompt essentials:
- "Transcribe exactly what is written. Do not correct or 'improve' the harmony."
- "Chord symbols as plain text, like `Cm7b5`, `F7#9`, `Bbmaj7/D`, `C6/9`, `N.C.`."
- "Each measure's note durations must add up to the time signature, unless it is a pickup measure (mark it `\"implicit\": true`)."
- "Slash notation (rhythm slashes) → no notes, just chords. Output a whole-measure rest with `\"slash\": true`."
- "Return only JSON." Use structured outputs / tool-use with a JSON schema if the API supports it (check the `claude-api` skill).

## Validate and repair (always)

After recognition, run checks in code and surface problems in the UI rather
than silently guessing:
1. Measure duration sum == time signature (except pickup). Flag bad measures in red.
2. Chord symbols parse (use `tonal`'s `Chord.get(sym).empty === false`, after
   normalizing `-`→`m`, `Δ`/`^`→`maj7`, `ø`→`m7b5`, `°`→`dim`).
3. Pitches in a sane range for the clef (e.g. treble: A3–C6).
4. Repeats/endings balanced.

For flagged measures, offer: (a) re-run recognition on a crop of that system,
(b) manual edit. A cheap repair loop: send the image again plus the JSON plus
the list of errors, and ask for corrected measures only.

## Testing

Keep a `fixtures/` folder of a few public-domain or self-made lead sheet images
with hand-checked JSON. Write a script that runs recognition and diffs per
measure (pitch accuracy, rhythm accuracy, chord accuracy), so prompt changes
can be measured. Don't commit copyrighted Real Book pages to a public repo.
