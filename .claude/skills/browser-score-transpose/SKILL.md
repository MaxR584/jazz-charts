---
name: browser-score-transpose
description: Render MusicXML lead sheets in the browser and transpose them (notes + chord symbols, correct enharmonic spelling), including concert↔Bb/Eb/F instrument keys and exporting the transposed MusicXML. Use when working on the score viewer, transpose controls, playback, or download/export in the jazz chart app.
---

# Render and transpose in the browser

Verified versions (Nov 2026): `opensheetmusicdisplay@2.2.1`, `tonal@6.5.1`,
`verovio@6.4.1`. Pin exact versions.

## Renderer: OpenSheetMusicDisplay (OSMD)

OSMD renders MusicXML directly with VexFlow and has **built-in transposition
of notes and chord symbols**. Use it as the viewer.

```ts
import { OpenSheetMusicDisplay, IntervalTransposeCalculator } from "opensheetmusicdisplay";

const osmd = new OpenSheetMusicDisplay(container, {
  autoResize: true,
  backend: "svg",
  drawTitle: true,
  drawingParameters: "default",      // "compact" for small screens
});
osmd.TransposeCalculator = new IntervalTransposeCalculator(); // spells like an engraver
await osmd.load(xmlString);           // string, URL, or Document; .mxl as Blob/ArrayBuffer is OK
osmd.render();

function transpose(semitones: number) {
  osmd.Sheet.Transpose = semitones;   // relative to the ORIGINAL, not cumulative
  osmd.updateGraphic();
  osmd.render();
}
```

- `IntervalTransposeCalculator` moves every note by the same interval (A# in
  C → G# in Bb, not Ab) and keeps chord roots readable (Emaj7, not Fbmaj7).
  Options: `.SimpleChordSymbolSpelling` (default true), `.AvoidDoubleAccidentals` (default false; set true for a lead sheet app).
- The default `TransposeCalculator` only counts half steps. Use it only if
  the interval one misbehaves.
- Keep a `targetKey` in UI state. Compute `semitones` from the original key to
  the target, choosing within -6…+6 so the melody doesn't jump an octave.
  Let the user add an octave shift too.
- OSMD **does not export** the transposed XML. For downloads, transpose the
  model yourself (below).

Alternative renderer: Verovio (WASM, 2 MB+) renders MusicXML/MEI to SVG, has a
`transpose` option (`"M2"`, `"-m3"`, `"Bb"`) and can export MEI/MIDI. Use it
only if OSMD layout is unacceptable. OSMD is lighter and handles chord
symbols well.

## Transposing the model (for export and editing)

Use `tonal` so spelling stays correct. Work on the JSON model (see
`musicxml-lead-sheets`), then rebuild MusicXML.

```ts
import { Interval, Note, Key } from "tonal";

// Choose a spelled interval from the key change, not just semitones:
// C major → Bb major = "-2M" (down a major 2nd), so A#4 → G#4.
function intervalForKeys(fromTonic: string, toTonic: string, dir: "up" | "down" | "nearest") {
  const up = Interval.distance(fromTonic, toTonic);           // e.g. "7m"
  const down = Interval.invert(up);                           // "2M"
  const semis = Interval.semitones(up);
  if (dir === "up" || (dir === "nearest" && semis <= 6)) return up;
  return "-" + down;
}

const tp = (p: string, ivl: string) => Note.transpose(p, ivl);   // "Bb4","-2M" → "Ab4"
```

Chord symbols: transpose the **root and slash bass only**, keep the suffix
string untouched:

```ts
function transposeChord(sym: string, ivl: string): string {
  const m = sym.match(/^([A-G][#b]?)(.*?)(?:\/([A-G][#b]?))?$/);
  if (!m) return sym;                           // "N.C." etc.
  const [, root, suffix, bass] = m;
  const r = cleanSpelling(Note.transpose(root, ivl));
  return r + suffix + (bass ? "/" + cleanSpelling(Note.transpose(bass, ivl)) : "");
}
// Lead sheets don't use Fb, Cb, E#, B#, or double accidentals in chord roots.
const cleanSpelling = (n: string) =>
  /(bb|##|x|^Fb|^Cb|^E#|^B#)/.test(n) ? Note.enharmonic(n) : n;
```

Notes: transpose `Note.transpose(pitch, ivl)`. If the result has a double
accidental, fall back to `Note.enharmonic`. Then **recompute `<accidental>`
display** against the new key signature. Don't transpose stored accidentals.

Key signature: `newFifths` = fifths of the target tonic
(`Key.majorKey(t).alteration` gives that number; for minor use
`Key.minorKey(t).alteration`). Prefer flat keys for jazz when a key is
ambiguous: Db over C#, Gb over F# (offer a toggle), Ab, Eb, Bb.

## Instrument (transposing) parts

| Instrument | Written vs concert | Transpose concert → written |
|---|---|---|
| Bb trumpet, tenor sax, clarinet, soprano sax | sounds M2 lower | up M2 (`"2M"`); tenor sax also +1 octave |
| Eb alto sax, bari sax | sounds M6 lower | up M6 (`"6M"`) or down m3 (`"-3m"`); bari +1 octave |
| F horn | sounds P5 lower | up P5 (`"5P"`) |
| C (piano, guitar, flute, voice) | concert | none (guitar/bass written 8va) |

Offer a preset dropdown (Concert / Bb / Eb / F / Bass clef). Bass clef =
concert pitch, down one or two octaves, `<clef><sign>F</sign><line>4</line>`.

## Nice-to-haves

- **Playback**: OSMD has a cursor (`osmd.cursor.show()/next()`). Pair with
  `tone` or `soundfont-player` and play the melody plus a simple comp of
  chord tones from `Chord.get(sym).notes`.
- **Editing**: click a note in the SVG → map to the model by measure/index →
  edit form or arrow keys for pitch → rebuild XML → `osmd.load` + `render`.
  Debounce re-renders (~150 ms).
- **Export**: `.musicxml` (Blob download), `.mxl` (zip), PDF via
  `window.print()` with a print stylesheet, MIDI via `@tonejs/midi`.
- **Persistence**: IndexedDB (`idb-keyval`) for the user's charts in the browser.

## Testing transposition

Unit tests (vitest) that must pass:
- C → Bb: `A#4` → `G#4`, `F#` → `E`, chord `C7/E` → `Bb7/D`.
- D → Eb (+1): chord `Ebmaj7` → `Emaj7` (not `Fbmaj7`).
- Round trip: +5 then -5 returns the original model exactly.
- Concert `F` → Bb instrument: written key G, melody up M2.
