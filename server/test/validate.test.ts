import { describe, expect, it } from "vitest";
import type { LeadSheetMeasure } from "../../shared/types.js";
import { buildMusicXML } from "../src/musicxml/builder.js";
import { checkRepeats, validateLeadSheet, validateMusicXML } from "../src/musicxml/validate.js";
import { fixture, sampleSheet, sheet } from "./helpers.js";

const m = (number: number, extra: Partial<LeadSheetMeasure> = {}): LeadSheetMeasure => ({
  number,
  chords: [],
  notes: [{ pitch: "C5", duration: "w" }],
  ...extra,
});
const codes = (ws: { code: string; measure: number | null }[]) => ws.map((w) => `${w.code}@${w.measure}`);

describe("validateLeadSheet", () => {
  it("the fixture is clean", () => {
    expect(validateLeadSheet(sampleSheet())).toEqual([]);
  });

  it("flags duration mismatches (but not pickups or empty/slash measures)", () => {
    const ws = validateLeadSheet(
      sheet([
        m(0, { implicit: true, notes: [{ pitch: "G4", duration: "q" }] }),
        m(1, { notes: [{ pitch: "C5", duration: "h" }] }),
        m(2, { notes: [{ pitch: "C5", duration: "w" }, { pitch: "D5", duration: "q" }] }),
        m(3, { slash: true, notes: [] }),
        m(4),
      ]),
    );
    expect(codes(ws)).toEqual(["duration_mismatch@1", "duration_mismatch@2"]);
    expect(ws[0]!.message).toMatch(/2 .*expected 4/);
  });

  it("accepts 3/4 and 6/8 bars and triplets", () => {
    const t = { actual: 3, normal: 2 };
    expect(
      validateLeadSheet(sheet([m(1, { notes: [{ pitch: "C5", duration: "h", dots: 1 }] })], { time: { beats: 3, beatType: 4 } })),
    ).toEqual([]);
    expect(
      validateLeadSheet(
        sheet([m(1, { notes: [{ pitch: "C5", duration: "q", dots: 1 }, { pitch: "C5", duration: "q", dots: 1 }] })], { time: { beats: 6, beatType: 8 } }),
      ),
    ).toEqual([]);
    expect(
      validateLeadSheet(
        sheet([m(1, { notes: [...[...Array(6)].map(() => ({ pitch: "C5", duration: "8" as const, tuplet: t })), { pitch: "C5", duration: "h" as const }] })]),
      ),
    ).toEqual([]);
  });

  it("flags oversize pickups", () => {
    const ws = validateLeadSheet(sheet([m(0, { implicit: true, notes: [{ pitch: "C5", duration: "w" }, { pitch: "C5", duration: "q" }] }), m(1)]));
    expect(codes(ws)).toEqual(["duration_mismatch@0"]);
  });

  it("flags unparsed chords and chords outside the bar", () => {
    const ws = validateLeadSheet(sheet([m(1, { chords: [{ beat: 1, symbol: "Cxyz" }, { beat: 5, symbol: "G7" }, { beat: 3, symbol: "Bb7alt" }] })]));
    expect(codes(ws)).toEqual(["unparsed_chord@1", "other@1"]);
  });

  it("flags pitches out of range and unreadable pitches", () => {
    const ws = validateLeadSheet(
      sheet([m(1, { notes: [{ pitch: "C3", duration: "q" }, { pitch: "C7", duration: "q" }, { pitch: "H4", duration: "q" }, { pitch: "D6", duration: "q" }] })]),
    );
    expect(codes(ws)).toEqual(["pitch_out_of_range@1", "pitch_out_of_range@1", "other@1"]);
    // bass clef has its own range
    expect(validateLeadSheet(sheet([m(1, { notes: [{ pitch: "C3", duration: "w" }] })], { clef: "bass" }))).toEqual([]);
  });

  it("flags broken ties", () => {
    const ws = validateLeadSheet(
      sheet([
        m(1, { notes: [{ pitch: "C5", duration: "w", tie: "start" }] }),
        m(2, { notes: [{ pitch: "D5", duration: "w", tie: "stop" }] }),
      ]),
    );
    expect(codes(ws)).toEqual(["other@2"]);
    // a tie start followed by an untied note
    expect(
      codes(validateLeadSheet(sheet([m(1, { notes: [{ pitch: "C5", duration: "w", tie: "start" }] }), m(2)]))),
    ).toEqual(["other@1"]);
  });

  it("flags unbalanced repeats", () => {
    expect(codes(validateLeadSheet(sheet([m(1, { barlineLeft: "repeat-forward" }), m(2)])))).toEqual(["unbalanced_repeat@1"]);
    expect(codes(validateLeadSheet(sheet([m(1, { barlineRight: "repeat-backward" }), m(2)])))).toEqual([]); // repeat from start
    expect(
      codes(validateLeadSheet(sheet([m(1, { barlineRight: "repeat-backward" }), m(2, { barlineRight: "repeat-backward" })]))),
    ).toEqual(["unbalanced_repeat@2"]);
    expect(codes(validateLeadSheet(sheet([m(1, { ending: { number: "1", type: "stop" } })])))).toEqual(["unbalanced_repeat@1"]);
    expect(
      codes(validateLeadSheet(sheet([m(1, { barlineLeft: "repeat-forward" }), m(2, { barlineLeft: "repeat-forward" }), m(3, { barlineRight: "repeat-backward" })]))),
    ).toEqual(["unbalanced_repeat@2"]);
  });

  it("no measures", () => {
    expect(codes(validateLeadSheet(sheet([])))).toEqual(["other@null"]);
  });
});

describe("validateMusicXML", () => {
  it("fixture MusicXML has no warnings", () => {
    expect(validateMusicXML(fixture("sample-1.musicxml").toString("utf8"))).toEqual([]);
  });

  it("finds duration mismatch, range and missing chords in raw MusicXML", () => {
    const xml = buildMusicXML(sheet([m(1, { notes: [{ pitch: "C7", duration: "h" }] }), m(2)]));
    expect(codes(validateMusicXML(xml))).toEqual(["pitch_out_of_range@1", "duration_mismatch@1", "low_confidence@null"]);
  });

  it("handles backup/forward and chord notes", () => {
    const xml = `<?xml version="1.0"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>x</part-name></score-part></part-list>
      <part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>2</beats><beat-type>4</beat-type></time></attributes>
      <harmony><root><root-step>C</root-step></root><kind>major</kind></harmony>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>2</duration><voice>1</voice></note>
      <note><chord/><pitch><step>E</step><octave>5</octave></pitch><duration>2</duration><voice>1</voice></note>
      <backup><duration>2</duration></backup>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>1</duration><voice>2</voice></note>
      <forward><duration>1</duration></forward>
      </measure></part></score-partwise>`;
    expect(validateMusicXML(xml)).toEqual([]);
  });

  it("strict ending checks and junk input", () => {
    expect(checkRepeats([{ number: 1, forward: false, backward: false, endingStart: true, endingStop: false }], true).map((w) => w.code)).toEqual([
      "unbalanced_repeat",
    ]);
    expect(validateMusicXML("not xml <")[0]!.code).toBe("other");
    expect(validateMusicXML("<score-timewise/>")[0]!.message).toMatch(/score-partwise/);
  });
});
