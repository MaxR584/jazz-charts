import { describe, expect, it } from "vitest";
import type { LeadSheetMeasure } from "../../shared/types.js";
import { buildMusicXML, chooseDivisions, computeBeams, resolveEndings } from "../src/musicxml/builder.js";
import { summarizeMusicXML } from "../src/musicxml/summary.js";
import { validateMusicXML } from "../src/musicxml/validate.js";
import { fixture, sampleSheet, sheet, validateXsd } from "./helpers.js";

const q = (pitch: string, extra = {}) => ({ pitch, duration: "q" as const, ...extra });

describe("buildMusicXML", () => {
  it("builds the fixture as schema-valid MusicXML 4.0 identical to fixtures/sample-1.musicxml", () => {
    const xml = buildMusicXML(sampleSheet());
    const v = validateXsd(xml);
    expect(v.output).toBe("");
    expect(v.ok).toBe(true);
    expect(xml).toBe(fixture("sample-1.musicxml").toString("utf8"));
    expect(validateMusicXML(xml)).toEqual([]);
  });

  it("is deterministic and pure", () => {
    const s = sampleSheet();
    const before = JSON.stringify(s);
    expect(buildMusicXML(s)).toBe(buildMusicXML(s));
    expect(JSON.stringify(s)).toBe(before);
  });

  it("has the score-partwise skeleton with divisions=12", () => {
    const xml = buildMusicXML(sampleSheet());
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"')).toBe(true);
    expect(xml).toContain("<!DOCTYPE score-partwise PUBLIC");
    expect(xml).toContain('<score-partwise version="4.0">');
    expect(xml).toContain("<divisions>12</divisions>");
    expect(xml).toMatch(/<key>\s*<fifths>-1<\/fifths>\s*<mode>major<\/mode>\s*<\/key>/);
  });

  it("escapes titles and composer", () => {
    const xml = buildMusicXML(sheet([{ number: 1, chords: [], notes: [] }], { title: `Tom & "Jerry" <3 'n'`, composer: "A<B" }));
    expect(xml).toContain("<work-title>Tom &amp; &quot;Jerry&quot; &lt;3 &apos;n&apos;</work-title>");
    expect(xml).toContain('<creator type="composer">A&lt;B</creator>');
    expect(validateXsd(xml).ok).toBe(true);
  });

  it("writes durations in ticks and keeps note child order", () => {
    const xml = buildMusicXML(
      sheet([
        {
          number: 1,
          chords: [],
          notes: [
            { pitch: "C5", duration: "q", dots: 1 },
            { pitch: "D5", duration: "8" },
            { pitch: "E5", duration: "h" },
          ],
        },
      ]),
    );
    expect(xml).toMatch(/<step>C<\/step>\s*<octave>5<\/octave>\s*<\/pitch>\s*<duration>18<\/duration>\s*<voice>1<\/voice>\s*<type>quarter<\/type>\s*<dot\/>/);
    expect(xml).toContain("<duration>24</duration>");
    expect(validateXsd(xml).ok).toBe(true);
  });

  it("raises divisions when 32nds or dotted 16ths need it", () => {
    expect(chooseDivisions(sheet([{ number: 1, chords: [], notes: [q("C4")] }]))).toBe(12);
    const s = sheet([
      {
        number: 1,
        chords: [],
        notes: [
          { pitch: "C5", duration: "16", dots: 1 },
          { pitch: "D5", duration: "32" },
          { pitch: "E5", duration: "8" },
          { pitch: "F5", duration: "q" },
          { pitch: "G5", duration: "h" },
        ],
      },
    ]);
    expect(chooseDivisions(s)).toBe(24);
    const xml = buildMusicXML(s);
    expect(xml).toContain("<divisions>24</divisions>");
    expect(validateXsd(xml).ok).toBe(true);
    expect(validateMusicXML(xml).filter((w) => w.code === "duration_mismatch")).toEqual([]);
    expect(xml).toMatch(/<duration>9<\/duration>\s*<voice>1<\/voice>\s*<type>16th<\/type>\s*<dot\/>/);
  });

  it("places harmony before the note it sits on, with offset inside a long note", () => {
    const xml = buildMusicXML(
      sheet([{ number: 1, chords: [{ beat: 1, symbol: "C7" }, { beat: 3, symbol: "F7" }], notes: [{ pitch: "C5", duration: "w" }] }]),
    );
    const body = xml.slice(xml.indexOf('<measure number="1"'));
    expect(body.indexOf("<harmony>")).toBeLessThan(body.indexOf("<note>"));
    expect(body).toMatch(/<root-step>F<\/root-step>[\s\S]*<offset>24<\/offset>\s*<\/harmony>/);
    expect(validateXsd(xml).ok).toBe(true);
  });

  it("places beat-2.5 chords on the right note", () => {
    const xml = buildMusicXML(
      sheet([
        {
          number: 1,
          chords: [{ beat: 2.5, symbol: "G7" }],
          notes: [q("C5"), { pitch: "D5", duration: "8" }, { pitch: "E5", duration: "8" }, { pitch: "F5", duration: "h" }],
        },
      ]),
    );
    expect(xml).toMatch(/<\/harmony>\s*<note>\s*<pitch>\s*<step>E<\/step>/);
  });

  it("writes ties as both <tie> and <tied>", () => {
    const xml = buildMusicXML(
      sheet([
        { number: 1, chords: [], notes: [{ pitch: "C5", duration: "w", tie: "start" }] },
        { number: 2, chords: [], notes: [{ pitch: "C5", duration: "h", tie: "stop" }, { rest: true, duration: "h" }] },
      ]),
    );
    expect(xml).toMatch(/<tie type="start"\/>[\s\S]*<tied type="start"\/>/);
    expect(xml).toMatch(/<tie type="stop"\/>[\s\S]*<tied type="stop"\/>/);
    expect(validateXsd(xml).ok).toBe(true);
  });

  it("emits accidentals against key signature and earlier accidentals in the measure", () => {
    const xml = buildMusicXML(
      sheet(
        [
          {
            number: 1,
            chords: [],
            // F major: Bb is diatonic, B natural needs a natural, the next B natural doesn't, Bb again needs a flat
            notes: [q("Bb4"), q("B4"), q("B4"), q("Bb4")],
          },
          { number: 2, chords: [], notes: [q("C#5"), q("C#5"), q("C5"), q("Bb4")] },
        ],
        { key: { fifths: -1, mode: "major" } },
      ),
    );
    const acc = [...xml.matchAll(/<accidental>([^<]+)<\/accidental>/g)].map((m) => m[1]);
    expect(acc).toEqual(["natural", "flat", "sharp", "natural"]);
    expect(validateXsd(xml).ok).toBe(true);
  });

  it("writes triplets with time-modification and tuplet start/stop", () => {
    const t = { actual: 3, normal: 2 };
    const xml = buildMusicXML(
      sheet([
        {
          number: 1,
          chords: [],
          notes: [
            { pitch: "C5", duration: "8", tuplet: t },
            { pitch: "D5", duration: "8", tuplet: t },
            { pitch: "E5", duration: "8", tuplet: t },
            { pitch: "F5", duration: "q", tuplet: t },
            { pitch: "G5", duration: "8", tuplet: t },
            { pitch: "A5", duration: "h" },
          ],
        },
      ]),
    );
    expect((xml.match(/<tuplet type="start"/g) ?? []).length).toBe(2);
    expect((xml.match(/<tuplet type="stop"/g) ?? []).length).toBe(2);
    expect((xml.match(/<duration>4<\/duration>/g) ?? []).length).toBe(4);
    expect(xml).toContain("<duration>8</duration>");
    expect(validateXsd(xml).ok).toBe(true);
    expect(validateMusicXML(xml).filter((w) => w.code !== "low_confidence")).toEqual([]);
  });

  it("writes a pickup measure as implicit", () => {
    const xml = buildMusicXML(
      sheet([
        { number: 0, implicit: true, chords: [], notes: [q("G4")] },
        { number: 1, chords: [], notes: [{ pitch: "C5", duration: "w" }] },
      ]),
    );
    expect(xml).toContain('<measure number="0" implicit="yes">');
    expect(validateMusicXML(xml).map((w) => w.code)).toEqual(["low_confidence"]); // no chords
    expect(validateXsd(xml).ok).toBe(true);
  });

  it("writes repeats, endings, final barline", () => {
    const xml = buildMusicXML(sampleSheet());
    expect(xml).toMatch(/<barline location="left">\s*<bar-style>heavy-light<\/bar-style>\s*<repeat direction="forward"\/>/);
    expect(xml).toMatch(/<barline location="left">\s*<ending number="1" type="start">1\.<\/ending>/);
    expect(xml).toMatch(/<bar-style>light-heavy<\/bar-style>\s*<ending number="1" type="stop"\/>\s*<repeat direction="backward"\/>/);
    expect(xml).toMatch(/<bar-style>light-light<\/bar-style>\s*<ending number="2" type="discontinue"\/>/);
    expect(xml.trimEnd()).toMatch(/<bar-style>light-heavy<\/bar-style>\s*<\/barline>\s*<\/measure>\s*<\/part>\s*<\/score-partwise>$/);
  });

  it("resolves multi-measure and implicit endings", () => {
    const m = (n: number, extra: Partial<LeadSheetMeasure> = {}): LeadSheetMeasure => ({ number: n, chords: [], notes: [], ...extra });
    const r = resolveEndings([
      m(1, { barlineLeft: "repeat-forward" }),
      m(2, { ending: { number: "1", type: "start" } }),
      m(3, { barlineRight: "repeat-backward" }),
      m(4, { ending: { number: "2", type: "start" } }),
      m(5),
    ]);
    expect([...r.left]).toEqual([
      [1, "1"],
      [3, "2"],
    ]);
    expect([...r.right]).toEqual([
      [2, { number: "1", type: "stop" }],
      [4, { number: "2", type: "discontinue" }],
    ]);
    expect(resolveEndings([m(1, { ending: { number: "1, 2", type: "start" } }), m(2, { ending: { number: "1", type: "stop" } })]).left.get(0)).toBe("1, 2");
  });

  it("writes rehearsal marks and navigation", () => {
    const nav = (navigation: LeadSheetMeasure["navigation"], n: number): LeadSheetMeasure => ({
      number: n,
      navigation,
      chords: [],
      notes: [{ pitch: "C5", duration: "w" }],
    });
    const xml = buildMusicXML(
      sheet([
        { ...nav("segno", 1), rehearsal: "A" },
        nav("To Coda", 2),
        nav("D.S. al Coda", 3),
        nav("coda", 4),
        nav("Fine", 5),
        nav("D.C. al Fine", 6),
      ]),
    );
    expect(xml).toMatch(/<rehearsal>A<\/rehearsal>/);
    expect(xml).toMatch(/<segno\/>\s*<\/direction-type>\s*<sound segno="segno"\/>/);
    expect(xml).toMatch(/<coda\/>\s*<\/direction-type>\s*<sound coda="coda"\/>/);
    expect(xml).toMatch(/<words>D\.S\. al Coda<\/words>\s*<\/direction-type>\s*<sound dalsegno="segno"\/>/);
    expect(xml).toMatch(/<words>To Coda<\/words>\s*<\/direction-type>\s*<sound tocoda="coda"\/>/);
    expect(xml).toMatch(/<sound fine="yes"\/>/);
    expect(xml).toMatch(/<sound dacapo="yes"\/>/);
    // segno at the start of its measure, D.S. at the end
    const m3 = xml.slice(xml.indexOf('<measure number="3"'), xml.indexOf('<measure number="4"'));
    expect(m3.indexOf("<note>")).toBeLessThan(m3.indexOf("D.S. al Coda"));
    expect(validateXsd(xml).ok).toBe(true);
  });

  it("slash measures: measure rest + measure-style slash start/stop", () => {
    const xml = buildMusicXML(
      sheet([
        { number: 1, slash: true, chords: [{ beat: 1, symbol: "C7" }, { beat: 3, symbol: "F7" }], notes: [] },
        { number: 2, chords: [], notes: [{ pitch: "C5", duration: "w" }] },
      ]),
    );
    expect(xml).toMatch(/<measure-style>\s*<slash type="start" use-stems="no"\/>/);
    expect(xml).toMatch(/<measure-style>\s*<slash type="stop"\/>/);
    expect(xml).toMatch(/<rest measure="yes"\/>\s*<duration>48<\/duration>/);
    expect(xml).toContain("<offset>24</offset>");
    expect(validateXsd(xml).ok).toBe(true);
  });

  it("N.C., slash bass and unparseable chords stay schema-valid", () => {
    const xml = buildMusicXML(
      sheet([
        {
          number: 1,
          chords: [
            { beat: 1, symbol: "N.C." },
            { beat: 2, symbol: "Ebmaj7/G" },
            { beat: 3, symbol: "Cxyz" },
            { beat: 4, symbol: "???" },
          ],
          notes: [q("C5"), q("D5"), q("E5"), q("F5")],
        },
      ]),
    );
    expect(xml).toContain('<kind text="N.C.">none</kind>');
    expect(xml).toMatch(/<bass>\s*<bass-step>G<\/bass-step>\s*<\/bass>/);
    expect(xml).toContain("<words>???</words>");
    const v = validateXsd(xml);
    expect(v.output).toBe("");
  });

  it("bass clef", () => {
    const xml = buildMusicXML(sheet([{ number: 1, chords: [], notes: [{ pitch: "C3", duration: "w" }] }], { clef: "bass" }));
    expect(xml).toMatch(/<sign>F<\/sign>\s*<line>4<\/line>/);
  });

  it("beams 8ths per beat and 16ths on two levels", () => {
    const beams = computeBeams(
      [
        { pitch: "C5", duration: "8" },
        { pitch: "D5", duration: "8" },
        { pitch: "E5", duration: "16" },
        { pitch: "F5", duration: "16" },
        { pitch: "G5", duration: "8" },
        { pitch: "A5", duration: "q" },
        { rest: true, duration: "8" },
        { pitch: "B5", duration: "8" },
      ],
      12,
      { beats: 4, beatType: 4 },
    );
    expect(beams.map((b) => b.map((x) => `${x.number}${x.value[0]}`).join(","))).toEqual([
      "1b",
      "1e",
      "1b,2b",
      "1c,2e",
      "1e",
      "",
      "",
      "",
    ]);
  });

  it("round-trips through the summary (notes and chords survive)", () => {
    const s = sampleSheet();
    const sum = summarizeMusicXML(buildMusicXML(s));
    expect(sum.measures).toBe(s.measures.length);
    expect(sum.chords.length).toBe(s.measures.reduce((n, m) => n + m.chords.length, 0));
  });
});
