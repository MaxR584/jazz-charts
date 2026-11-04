import { describe, expect, it } from "vitest";
import { buildHarmony, harmonyToText, normalizeSuffix, suffixToKind, transposeChordText } from "../src/lib/chords";
import { addChord, measureChords, setChordText, shiftNote } from "../src/lib/edit";
import { pitchToName, readPitch } from "../src/lib/pitch";
import { bytesToMusicXml, parseMusicXml, serializeMusicXml } from "../src/lib/xml";
import { zipSync, strToU8 } from "fflate";
import { n, sampleXml, scoreXml } from "./helpers";

describe("chord symbols", () => {
  it("maps text to MusicXML kinds", () => {
    expect(suffixToKind("maj7").kind).toBe("major-seventh");
    expect(suffixToKind("-7").kind).toBe("minor-seventh");
    expect(suffixToKind("ø").kind).toBe("half-diminished");
    expect(suffixToKind("Δ").kind).toBe("major-seventh");
    expect(suffixToKind("°7").kind).toBe("diminished-seventh");
    expect(suffixToKind("7sus4").kind).toBe("suspended-fourth");
    expect(suffixToKind("6/9").kind).toBe("major-sixth");
    const alt = suffixToKind("7(b9,#11)");
    expect(alt.kind).toBe("dominant");
    expect(alt.degrees).toEqual([
      { value: 9, alter: -1, type: "add" },
      { value: 11, alter: 1, type: "add" },
    ]);
    expect(suffixToKind("xyz").kind).toBe("other");
    expect(normalizeSuffix("min7")).toBe("m7");
  });

  it("builds harmony and reads it back", () => {
    const doc = parseMusicXml(scoreXml(0, [n("C", 0, 4)]));
    for (const s of ["Bb7(b9)/D", "F#m7b5", "Ebmaj7", "C", "Am", "N.C.", "G7alt"]) {
      expect(harmonyToText(buildHarmony(doc, s)!)).toBe(s);
    }
    const h = buildHarmony(doc, "Eb-7/Gb")!;
    expect(h.getElementsByTagName("root-alter")[0].textContent).toBe("-1");
    expect(h.getElementsByTagName("bass-step")[0].textContent).toBe("G");
    expect(h.getElementsByTagName("kind")[0].textContent).toBe("minor-seventh");
  });

  it("reads harmonies without a text attribute", () => {
    const doc = parseMusicXml(
      scoreXml(0, [`<harmony><root><root-step>B</root-step><root-alter>-1</root-alter></root><kind>dominant</kind><degree><degree-value>9</degree-value><degree-alter>1</degree-alter><degree-type>add</degree-type></degree></harmony>` + n("C", 0, 4)]),
    );
    expect(harmonyToText(doc.getElementsByTagName("harmony")[0])).toBe("Bb7(#9)");
  });

  it("transposes chord text", () => {
    expect(transposeChordText("C7/E", "-2M")).toBe("Bb7/D");
    expect(transposeChordText("Ebmaj7", "2m")).toBe("Emaj7");
    expect(transposeChordText("N.C.", "2M")).toBe("N.C.");
  });
});

describe("editing", () => {
  it("edits, adds and deletes chords", () => {
    const doc = parseMusicXml(sampleXml());
    const chords = measureChords(doc, 4);
    expect(chords.map((c) => [c.text, c.beat])).toEqual([["Am7", 1], ["D7", 3]]);
    setChordText(doc, chords[1].el, "D7b9");
    addChord(doc, 4, 2, "Ab7");
    expect(measureChords(doc, 4).map((c) => [c.text, c.beat])).toEqual([["Am7", 1], ["Ab7", 2], ["D7b9", 3]]);
    setChordText(doc, measureChords(doc, 4)[0].el, "");
    expect(measureChords(doc, 4).map((c) => c.text)).toEqual(["Ab7", "D7b9"]);
    expect(() => setChordText(doc, measureChords(doc, 4)[0].el, "hello")).toThrow();
    // Re-parse survives serialization
    expect(measureChords(parseMusicXml(serializeMusicXml(doc)), 4).length).toBe(2);
  });

  it("shifts note pitch with key-aware spelling and accidentals", () => {
    const doc = parseMusicXml(scoreXml(-1, [n("A", 0, 4) + n("B", -1, 4)]));
    const notes = doc.getElementsByTagName("note");
    shiftNote(doc, notes[0], 0, 1); // A → Bb (in key)
    expect(pitchToName(readPitch(notes[0])!)).toBe("Bb4");
    expect(notes[0].getElementsByTagName("accidental").length).toBe(0);
    shiftNote(doc, notes[1], 0, 1); // Bb → B natural
    expect(pitchToName(readPitch(notes[1])!)).toBe("B4");
    expect(notes[1].getElementsByTagName("accidental")[0].textContent).toBe("natural");
    shiftNote(doc, notes[1], 0, -2); // → A
    expect(pitchToName(readPitch(notes[1])!)).toBe("A4");
  });

  it("moves tied notes together", () => {
    const doc = parseMusicXml(sampleXml());
    const m9 = doc.getElementsByTagName("measure")[8].getElementsByTagName("note")[0];
    shiftNote(doc, m9, 8, 2);
    const m10 = doc.getElementsByTagName("measure")[9].getElementsByTagName("note")[0];
    expect(pitchToName(readPitch(m10)!)).toBe("G4");
  });
});

describe("file loading", () => {
  it("reads .mxl zips via container.xml", () => {
    const zip = zipSync({
      "META-INF/container.xml": strToU8('<container><rootfiles><rootfile full-path="score.musicxml"/></rootfiles></container>'),
      "score.musicxml": strToU8(sampleXml()),
    });
    expect(bytesToMusicXml(zip)).toContain("Blue Lantern");
  });
  it("rejects non-MusicXML", () => {
    expect(() => parseMusicXml("<html></html>")).toThrow(/Not a MusicXML/);
    expect(() => parseMusicXml("not xml")).toThrow(/not valid XML/);
  });
});
