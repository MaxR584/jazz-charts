---
name: musicxml-lead-sheets
description: Reference for writing, parsing and validating MusicXML for jazz lead sheets — melody, chord symbols (<harmony>), repeats, endings, navigation marks — and building it from a JSON transcription. Use when generating MusicXML in code, editing notes/chords, exporting .musicxml/.mxl, or debugging why a score renders wrong.
---

# MusicXML for lead sheets

Use `score-partwise`, MusicXML 4.0, one part. Uncompressed `.musicxml` is
plain XML. `.mxl` is a zip containing `META-INF/container.xml` pointing at
the score file (use `fflate` or `jszip` in the browser).

## Skeleton

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="4.0">
  <work><work-title>Autumn Leaves</work-title></work>
  <identification><creator type="composer">Joseph Kosma</creator></identification>
  <part-list><score-part id="P1"><part-name>Lead</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>12</divisions>            <!-- ticks per quarter; 12 covers 8ths, 16ths, triplets -->
        <key><fifths>-2</fifths><mode>major</mode></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      <harmony>
        <root><root-step>C</root-step></root>
        <kind text="m7">minor-seventh</kind>
      </harmony>
      <note><pitch><step>B</step><alter>-1</alter><octave>4</octave></pitch>
            <duration>12</duration><type>quarter</type></note>
      ...
    </measure>
  </part>
</score-partwise>
```

Rules that matter:
- Element **order inside `<note>`** is fixed by the schema: `grace?`, `chord?`, `pitch|rest`, `duration`, `tie*`, `voice?`, `type`, `dot*`, `accidental?`, `time-modification?`, `stem?`, `beam*`, `notations?`, `lyric*`. Renderers can choke on the wrong order.
- `<duration>` = ticks at `<divisions>` per quarter. With divisions=12: whole 48, half 24, quarter 12, eighth 6, 16th 3, triplet-eighth 4, dotted quarter 18.
- A `<harmony>` goes **before** the `<note>` it sits on. For a chord in mid-note (e.g. beat 3 over a whole note), add `<offset>` in ticks inside `<harmony>`.
- Ties need both `<tie type="start"/>` (sound) and `<notations><tied type="start"/></notations>` (display).
- `<alter>` is the sounding pitch. `<accidental>` is only display. Generate `<accidental>` when the pitch differs from the key signature or an earlier accidental in the measure.
- Pickup measure: `<measure number="0" implicit="yes">`.
- Whole-measure rest: `<note><rest measure="yes"/><duration>48</duration></note>` (no `<type>`).

## Chord symbols (`<harmony>`)

```xml
<harmony>
  <root><root-step>B</root-step><root-alter>-1</root-alter></root>
  <kind text="7">dominant</kind>
  <degree><degree-value>9</degree-value><degree-alter>1</degree-alter><degree-type>add</degree-type></degree>  <!-- #9 -->
  <bass><bass-step>D</bass-step></bass>                                                                       <!-- slash bass -->
</harmony>
```

Map text → `kind` (set `text` to the suffix you want displayed):

| Symbol | kind | | Symbol | kind |
|---|---|---|---|---|
| C | major | | Cm | minor |
| C7 | dominant | | Cmaj7 / CΔ | major-seventh |
| Cm7 / C-7 | minor-seventh | | Cm(maj7) | major-minor |
| Cm7b5 / Cø | half-diminished | | Cdim7 / C°7 | diminished-seventh |
| Cdim / C° | diminished | | C+ / Caug | augmented |
| C7#5 / C+7 | augmented-seventh | | C6 | major-sixth |
| Cm6 | minor-sixth | | C9 | dominant-ninth |
| Cmaj9 | major-ninth | | Cm9 | minor-ninth |
| C11 | dominant-11th | | Cm11 | minor-11th |
| C13 | dominant-13th | | Cmaj13 | major-13th |
| Csus4 / C7sus4 | suspended-fourth (+degree 7 add) | | Csus2 | suspended-second |
| C5 | power | | N.C. | none |
| C6/9 | major-sixth + degree 9 add | | | |

Alterations (`b9 #9 #11 b13 b5 #5`) → `<degree>` with `degree-type` `add` or
`alter`. When parsing the input, normalize `-`→m, `Δ`/`^`→maj7, `ø`→m7b5,
`°`→dim, `+`→aug. If mapping is uncertain, use `kind="other"` with `text`
holding the full suffix. That way the renderer still shows it correctly.

## Repeats, endings, navigation

```xml
<barline location="left"><bar-style>heavy-light</bar-style><repeat direction="forward"/></barline>
<barline location="right"><bar-style>light-heavy</bar-style><repeat direction="backward"/></barline>
<barline location="left"><ending number="1" type="start"/></barline>
<barline location="right"><ending number="1" type="stop"/></barline>   <!-- 2nd ending usually type="discontinue" -->
<direction placement="above"><direction-type><rehearsal>A</rehearsal></direction-type></direction>
<direction placement="above"><direction-type><segno/></direction-type><sound segno="s1"/></direction>
<direction placement="above"><direction-type><coda/></direction-type><sound coda="c1"/></direction>
<direction placement="above"><direction-type><words>D.S. al Coda</words></direction-type><sound dalsegno="s1"/></direction>
```

Left barlines go at the start of the measure, right barlines at the end.

## Building from JSON

Write the builder as a pure function `buildMusicXML(json) → string` with unit
tests (vitest). Use a tiny XML string builder with escaping (`& < > " '`) or
`xmlbuilder2`. Don't concatenate unescaped user text (titles!). Reverse with
`DOMParser` → JSON for the editor so there's a single in-memory model:
**JSON model is the source of truth, MusicXML is an export/render format.**

## Validating

- Quick check: render in OSMD/Verovio and catch load errors.
- Strict check (dev/CI): validate against the MusicXML 4.0 XSD
  (https://github.com/w3c/musicxml, `schema/musicxml.xsd`) with `xmllint --schema`.
- Round-trip test: build → parse → build gives identical output.
- Open exports in MuseScore 4 to confirm other apps can read them.
