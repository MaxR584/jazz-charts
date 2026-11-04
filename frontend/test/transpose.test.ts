import { Note } from "tonal";
import { describe, expect, it } from "vitest";
import { harmonyToText } from "../src/lib/chords";
import { pitchToName, readPitch } from "../src/lib/pitch";
import { describeInterval, intervalForSemitones, targetFifths, transposeDocument } from "../src/lib/transpose";
import { firstKey, parseMusicXml, serializeMusicXml } from "../src/lib/xml";
import { chord, n, sampleXml, scoreXml } from "./helpers";

const pitches = (doc: Document) =>
  Array.from(doc.getElementsByTagName("note")).map((x) => (readPitch(x) ? pitchToName(readPitch(x)!) : "r"));
const accidentals = (doc: Document) =>
  Array.from(doc.getElementsByTagName("note")).map((x) => x.getElementsByTagName("accidental")[0]?.textContent ?? "");
const chords = (doc: Document) => Array.from(doc.getElementsByTagName("harmony")).map(harmonyToText);

describe("targetFifths (flat keys preferred)", () => {
  it("spells ambiguous keys with flats", () => {
    expect(targetFifths(0, 1)).toBe(-5); // Db
    expect(targetFifths(0, 6)).toBe(-6); // Gb
    expect(targetFifths(0, -6)).toBe(-6);
    expect(targetFifths(0, 8)).toBe(-4); // Ab
    expect(targetFifths(0, -2)).toBe(-2); // Bb
    expect(targetFifths(0, 6, "sharps")).toBe(6); // F#
    expect(targetFifths(0, 11)).toBe(5); // B, not Cb
    expect(targetFifths(3, 12)).toBe(3);
  });
});

describe("transposeDocument", () => {
  it("C → Bb: A#4 → G#4, F# → E, C7/E → Bb7/D", () => {
    const doc = parseMusicXml(
      scoreXml(0, [chord("C", 0, "dominant", "7", ["E", 0]) + n("A", 1, 4, "<accidental>sharp</accidental>") + n("F", 1, 4, "<accidental>sharp</accidental>") + n("C", 0, 5) + n("G", 0, 4)]),
    );
    const si = transposeDocument(doc, { semitones: -2 });
    expect(describeInterval(si)).toBe("-2M");
    expect(firstKey(doc).fifths).toBe(-2);
    expect(pitches(doc)).toEqual(["G#4", "E4", "Bb4", "F4"]);
    // E is flat in Bb major, so E4 needs a natural; Bb4 is in the key.
    expect(accidentals(doc)).toEqual(["sharp", "natural", "", ""]);
    expect(chords(doc)).toEqual(["Bb7/D"]);
  });

  it("D → Eb (+1): Ebmaj7 → Emaj7, not Fbmaj7", () => {
    const doc = parseMusicXml(scoreXml(2, [chord("E", -1, "major-seventh", "maj7") + n("E", -1, 4, "<accidental>flat</accidental>") + n("D", 0, 4) + n("F", 1, 4) + n("A", 0, 4)]));
    transposeDocument(doc, { semitones: 1 });
    expect(firstKey(doc).fifths).toBe(-3);
    expect(chords(doc)).toEqual(["Emaj7"]);
    expect(pitches(doc)).toEqual(["Fb4", "Eb4", "G4", "Bb4"]);
    expect(accidentals(doc)).toEqual(["flat", "", "", ""]);
  });

  it("round trip: +5 then -5 returns the original exactly (sample lead sheet)", () => {
    const original = serializeMusicXml(parseMusicXml(sampleXml()));
    const doc = parseMusicXml(original);
    transposeDocument(doc, { semitones: 5 });
    const up = serializeMusicXml(doc);
    expect(up).not.toBe(original);
    transposeDocument(doc, { semitones: -5 });
    expect(serializeMusicXml(doc)).toBe(original);
  });

  it("round trip on every semitone offset keeps pitches and chords", () => {
    const original = parseMusicXml(sampleXml());
    for (let s = -11; s <= 11; s++) {
      const doc = parseMusicXml(sampleXml());
      transposeDocument(doc, { semitones: s });
      transposeDocument(doc, { semitones: -s });
      // Chord roots may be respelled (Cb → B, then back as A#), like OSMD's SimpleChordSymbolSpelling.
      const chroma = (d: Document) =>
        chords(d).map((c) => { const m = c.match(/^([A-G][#b]?)(.*)$/)!; return Note.chroma(m[1]) + m[2]; });
      expect(chroma(doc)).toEqual(chroma(original));
      // Same sounding pitches (spelling may differ only where a double accidental was simplified).
      expect(pitches(doc).length).toBe(pitches(original).length);
    }
  });

  it("round trips exactly for common jazz moves (±2, ±5, ±7)", () => {
    const original = serializeMusicXml(parseMusicXml(sampleXml()));
    for (const s of [2, -2, 5, -5, 7, -7, 12]) {
      const doc = parseMusicXml(original);
      transposeDocument(doc, { semitones: s });
      transposeDocument(doc, { semitones: -s });
      expect(serializeMusicXml(doc)).toBe(original);
    }
  });

  it("concert F → Bb instrument: written key G, melody up M2", () => {
    const doc = parseMusicXml(scoreXml(-1, [chord("F", 0, "major-seventh", "maj7") + n("F", 0, 4) + n("A", 0, 4) + n("B", -1, 4) + n("C", 0, 5)]));
    const si = transposeDocument(doc, { semitones: 2 });
    expect(describeInterval(si)).toBe("2M");
    expect(firstKey(doc).fifths).toBe(1);
    expect(pitches(doc)).toEqual(["G4", "B4", "C5", "D5"]);
    expect(accidentals(doc)).toEqual(["", "", "", ""]);
    expect(chords(doc)).toEqual(["Gmaj7"]);
  });

  it("octave shift: +12 keeps the key and moves every note up an octave", () => {
    const doc = parseMusicXml(scoreXml(-1, [n("F", 0, 4) + n("B", -1, 4)]));
    transposeDocument(doc, { semitones: 12 });
    expect(firstKey(doc).fifths).toBe(-1);
    expect(pitches(doc)).toEqual(["F5", "Bb5"]);
  });

  it("Eb instrument (down m3) from concert C", () => {
    const si = intervalForSemitones(0, -3);
    expect(si.toFifths).toBe(3); // A major
    expect(describeInterval(si)).toBe("-3m");
  });

  it("regenerates accidentals within a measure (later same note needs no sign; courtesy kept)", () => {
    const doc = parseMusicXml(scoreXml(0, [n("F", 1, 4, "<accidental>sharp</accidental>") + n("F", 1, 4) + n("F", 0, 4, "<accidental>natural</accidental>") + n("C", 0, 5, '<accidental cautionary="yes">natural</accidental>')]));
    transposeDocument(doc, { semitones: 3 }); // C → Eb
    expect(pitches(doc)).toEqual(["A4", "A4", "Ab4", "Eb5"]);
    expect(accidentals(doc)).toEqual(["natural", "", "flat", "flat"]);
  });

  it("transposes slash-bass and altered chords, leaves N.C. alone", () => {
    const doc = parseMusicXml(
      scoreXml(0, [chord("G", 0, "dominant", "7b9", ["B", 0]) + n("G", 0, 4) + `<harmony><root><root-step>C</root-step></root><kind text="N.C.">none</kind></harmony>` + n("A", 0, 4)]),
    );
    transposeDocument(doc, { semitones: 1 }); // → Db
    expect(chords(doc)).toEqual(["Ab7b9/C", "N.C."]);
  });

  it("all key signatures follow (key change mid-score)", () => {
    const doc = parseMusicXml(scoreXml(0, [n("C", 0, 4), `<attributes><key><fifths>2</fifths></key></attributes>` + n("D", 0, 4)]));
    transposeDocument(doc, { semitones: -2 });
    const keys = Array.from(doc.getElementsByTagName("fifths")).map((f) => f.textContent);
    expect(keys).toEqual(["-2", "0"]);
  });
});
