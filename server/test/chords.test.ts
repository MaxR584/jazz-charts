import { describe, expect, it } from "vitest";
import { buildMusicXML } from "../src/musicxml/builder.js";
import { isValidChord, parseChordSymbol, type ChordDegree, type ParsedChord } from "../src/musicxml/chords.js";
import { sheet, validateXsd } from "./helpers.js";

function parse(sym: string): ParsedChord {
  const r = parseChordSymbol(sym);
  if (!r.ok) throw new Error(`${sym}: ${r.reason}`);
  return r.chord;
}

const deg = (value: number, alter: number, type: ChordDegree["type"] = "add"): ChordDegree => ({ value, alter, type });

describe("parseChordSymbol: the required jazz cases", () => {
  it.each([
    // symbol, root step, root alter, kind, degrees, bass
    ["Cm7b5", "C", 0, "half-diminished", [], null],
    ["C-7", "C", 0, "minor-seventh", [], null],
    ["CΔ7", "C", 0, "major-seventh", [], null],
    ["F7#9", "F", 0, "dominant", [deg(9, 1)], null],
    ["Bb7alt", "B", -1, "dominant", [deg(5, 1, "alter"), deg(9, -1), deg(9, 1)], null],
    ["C6/9", "C", 0, "major-sixth", [deg(9, 0)], null],
    ["Ebmaj7/G", "E", -1, "major-seventh", [], { step: "G", alter: 0 }],
    ["C7sus4", "C", 0, "suspended-fourth", [deg(7, -1)], null],
    ["Dø7", "D", 0, "half-diminished", [], null],
    ["G7b9b13", "G", 0, "dominant", [deg(9, -1), deg(13, -1)], null],
  ] as const)("%s", (sym, step, alter, kind, degrees, bass) => {
    const c = parse(sym);
    expect(c.root).toEqual({ step, alter });
    expect(c.kind).toBe(kind);
    expect(c.degrees).toEqual(degrees);
    expect(c.bass).toEqual(bass);
  });

  it("N.C. is kind none without a root", () => {
    for (const s of ["N.C.", "NC", "N.C", "n.c."]) {
      const c = parse(s);
      expect(c.kind).toBe("none");
      expect(c.root).toBeNull();
      expect(c.text).toBe("N.C.");
    }
  });

  it("keeps the suffix as written in text", () => {
    expect(parse("C-7").text).toBe("-7");
    expect(parse("CΔ7").text).toBe("Δ7");
    expect(parse("Bb7alt").text).toBe("7alt");
    expect(parse("Ebmaj7/G").text).toBe("maj7");
    expect(parse("C").text).toBe("");
  });
});

describe("parseChordSymbol: more spellings", () => {
  it.each([
    ["C", "major"],
    ["Cm", "minor"],
    ["C-", "minor"],
    ["Cmin7", "minor-seventh"],
    ["Cmi7", "minor-seventh"],
    ["CM7", "major-seventh"],
    ["Cma7", "major-seventh"],
    ["CMaj7", "major-seventh"],
    ["C^7", "major-seventh"],
    ["CΔ", "major-seventh"],
    ["C△9", "major-ninth"],
    ["Cmaj9", "major-ninth"],
    ["Cmaj13", "major-13th"],
    ["Cm(maj7)", "major-minor"],
    ["CmM7", "major-minor"],
    ["C-Δ7", "major-minor"],
    ["C-7b5", "half-diminished"],
    ["Cø", "half-diminished"],
    ["Cdim", "diminished"],
    ["C°", "diminished"],
    ["Co7", "diminished-seventh"],
    ["C°7", "diminished-seventh"],
    ["Cdim7", "diminished-seventh"],
    ["C+", "augmented"],
    ["Caug", "augmented"],
    ["C+7", "augmented-seventh"],
    ["Caug7", "augmented-seventh"],
    ["C6", "major-sixth"],
    ["Cm6", "minor-sixth"],
    ["C-6", "minor-sixth"],
    ["C9", "dominant-ninth"],
    ["Cm9", "minor-ninth"],
    ["C11", "dominant-11th"],
    ["Cm11", "minor-11th"],
    ["C13", "dominant-13th"],
    ["Cm13", "minor-13th"],
    ["Csus", "suspended-fourth"],
    ["Csus4", "suspended-fourth"],
    ["Csus2", "suspended-second"],
    ["C5", "power"],
    ["C7", "dominant"],
    ["C♭7", "dominant"],
    ["F♯m7", "minor-seventh"],
  ])("%s → %s", (sym, kind) => {
    expect(parse(sym).kind).toBe(kind);
  });

  it("parses alterations into degrees", () => {
    expect(parse("C7b9").degrees).toEqual([deg(9, -1)]);
    expect(parse("C7#11").degrees).toEqual([deg(11, 1)]);
    expect(parse("Cmaj7#11").degrees).toEqual([deg(11, 1)]);
    expect(parse("C7#5").degrees).toEqual([deg(5, 1, "alter")]);
    expect(parse("C7b5").degrees).toEqual([deg(5, -1, "alter")]);
    expect(parse("C7(b9,#11)").degrees).toEqual([deg(9, -1), deg(11, 1)]);
    expect(parse("C13b9").degrees).toEqual([deg(9, -1, "alter")]); // 9 is part of a 13th chord
    expect(parse("C9#11").degrees).toEqual([deg(11, 1)]);
    expect(parse("Cadd9").degrees).toEqual([deg(9, 0)]);
    expect(parse("C(add9)").kind).toBe("major");
    expect(parse("C7no3").degrees).toEqual([deg(3, 0, "subtract")]);
    expect(parse("Cm69").degrees).toEqual([deg(9, 0)]);
    expect(parse("C7-9").degrees).toEqual([deg(9, -1)]); // old-style dash = flat
    expect(parse("C7+").degrees).toEqual([deg(5, 1, "alter")]);
    expect(parse("C+maj7")).toMatchObject({ kind: "major-seventh", degrees: [deg(5, 1, "alter")] });
  });

  it("handles sus after extensions", () => {
    expect(parse("C9sus4")).toMatchObject({ kind: "suspended-fourth", degrees: [deg(7, -1), deg(9, 0)] });
    expect(parse("C13sus")).toMatchObject({ kind: "suspended-fourth", degrees: [deg(7, -1), deg(9, 0), deg(13, 0)] });
    expect(parse("C7b9sus4")).toMatchObject({ kind: "suspended-fourth", degrees: [deg(7, -1), deg(9, -1)] });
    expect(parse("Csus7")).toMatchObject({ kind: "suspended-fourth", degrees: [deg(7, -1)] });
  });

  it("slash bass with accidentals", () => {
    expect(parse("D7/F#").bass).toEqual({ step: "F", alter: 1 });
    expect(parse("Cm7/Bb").bass).toEqual({ step: "B", alter: -1 });
    expect(parse("C/E")).toMatchObject({ kind: "major", bass: { step: "E", alter: 0 } });
  });

  it("rejects garbage, keeping the root as a partial when possible", () => {
    expect(isValidChord("H7")).toBe(false);
    expect(isValidChord("")).toBe(false);
    const r = parseChordSymbol("Cxyz");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.partial).toMatchObject({ root: { step: "C", alter: 0 }, kind: "other", text: "xyz" });
  });
});

describe("chords for renderers that ignore kind text (OSMD)", () => {
  const COMMON = [
    "C", "Cm", "C7", "Cmaj7", "Cm7", "Cm7b5", "Cdim7", "C6", "Cm6", "C9", "C13", "C7#9", "C7b9", "C7#11", "C7b13",
    "C7#5", "C7b5", "C7alt", "Calt", "C7sus4", "C9sus4", "Cmaj7#11", "Cm(maj7)", "C6/9", "Cm9", "Cm11", "C+", "C+7",
    "Cø7", "C°7", "CΔ7", "C-7", "C7b9b13", "C7#9b13", "C13#11", "C13b9", "Cadd9", "C7(b9,#9)", "Bb7alt/Ab",
  ];
  it.each(COMMON)("%s maps to a real kind, never 'other'", (sym) => {
    expect(parse(sym).kind).not.toBe("other");
  });

  it("F7#9 → dominant + degree 9 alter +1 in the XML", () => {
    const xml = buildMusicXML(sheet([{ number: 1, chords: [{ beat: 1, symbol: "F7#9" }], notes: [] }]));
    expect(xml).toMatch(
      /<kind text="7#9">dominant<\/kind>\s*<degree print-object="no">\s*<degree-value>9<\/degree-value>\s*<degree-alter>1<\/degree-alter>\s*<degree-type>add<\/degree-type>/,
    );
  });

  it("Bb7alt → dominant with #5, b9, #9 degrees in the XML", () => {
    const xml = buildMusicXML(sheet([{ number: 1, chords: [{ beat: 1, symbol: "Bb7alt" }], notes: [] }]));
    expect(xml).toContain('<kind text="7alt">dominant</kind>');
    const degrees = [...xml.matchAll(/<degree-value>(\d+)<\/degree-value>\s*<degree-alter>(-?\d+)<\/degree-alter>/g)].map((m) => `${m[1]}:${m[2]}`);
    expect(degrees).toEqual(["5:1", "9:-1", "9:1"]);
    expect(validateXsd(xml).ok).toBe(true);
  });

  it("only unparseable symbols become kind=other (with the full text kept)", () => {
    const xml = buildMusicXML(sheet([{ number: 1, chords: [{ beat: 1, symbol: "Cxyz" }], notes: [] }]));
    expect(xml).toContain('<kind text="xyz">other</kind>');
  });
});
