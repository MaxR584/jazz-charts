import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  AUDIVERIS_CONSTANTS,
  AudiverisEngine,
  droppedChordNames,
  fixAudiverisHarmonies,
  normalizeAudiverisXml,
  promoteTitle,
  repairOcrChord,
  type Runner,
  rehearsalWarnings,
  unreadChordWarnings,
} from "../src/engines/audiveris.js";
import { compareScores, summarizeMusicXML } from "../src/musicxml/summary.js";
import { unzipMxl } from "../src/musicxml/mxl.js";
import { prepareInput } from "../src/pipeline/pages.js";
import { fixture, validateXsd } from "./helpers.js";

const SCORE = fixture("sample-1.musicxml").toString("utf8");

function mxl(xml: string, name = "score.xml"): Uint8Array {
  return zipSync({
    "META-INF/container.xml": strToU8(
      `<?xml version="1.0"?><container><rootfiles><rootfile full-path="${name}" media-type="application/vnd.recordare.musicxml+xml"/></rootfiles></container>`,
    ),
    [name]: strToU8(xml),
  });
}

/** Fake Audiveris: writes the given .mxl files into the -output directory. */
const fakeRunner =
  (files: Record<string, Uint8Array>, calls: string[][] = []): Runner =>
  async (_bin, args) => {
    calls.push(args);
    const out = args[args.indexOf("-output") + 1]!;
    mkdirSync(out, { recursive: true });
    for (const [n, data] of Object.entries(files)) writeFileSync(join(out, n), data);
    return { code: 0, stdout: "", stderr: "" };
  };

const BIN = "/bin/sh"; // any executable file makes the engine "available"

describe("unzipMxl", () => {
  it("follows META-INF/container.xml", () => {
    expect(unzipMxl(mxl(SCORE, "nested/a.musicxml"))).toBe(SCORE);
  });
  it("falls back to the first score file", () => {
    expect(unzipMxl(zipSync({ "x.xml": strToU8("<score-partwise/>") }))).toBe("<score-partwise/>");
  });
  it("throws without a score", () => {
    expect(() => unzipMxl(zipSync({ "a.txt": strToU8("x") }))).toThrow();
  });
});

describe("AudiverisEngine (fake runner)", () => {
  it("runs batch export and returns the unzipped XML", async () => {
    const calls: string[][] = [];
    const engine = new AudiverisEngine({ bin: BIN }, fakeRunner({ "sample.mxl": mxl(SCORE) }, calls));
    const res = await engine.convert(await prepareInput(fixture("sample-1.pdf"), "application/pdf"));
    const args = calls[0]!;
    expect(args[0]).toBe("-batch");
    // Each tuned constant is passed as "-option key=value" before -export.
    for (const c of AUDIVERIS_CONSTANTS) expect(args[args.indexOf(c) - 1]).toBe("-option");
    expect(args.slice(-5, -2)).toEqual(["-export", "-output", expect.stringContaining("out")]);
    expect(args.at(-2)).toBe("--");
    expect(args.at(-1)).toMatch(/score\.pdf$/); // the original PDF, not page PNGs
    expect(res.model).toBeNull();
    expect(res.musicxml).toContain('<score-partwise version="4.0">');
    expect(res.warnings).toEqual([]);
  });

  it("feeds images as PNG", async () => {
    const calls: string[][] = [];
    const engine = new AudiverisEngine({ bin: BIN }, fakeRunner({ "a.mxl": mxl(SCORE) }, calls));
    await engine.convert(await prepareInput(fixture("sample-1.png"), "image/png"));
    expect(calls[0]!.at(-1)).toMatch(/score\.png$/);
  });

  it("warns when there are several movements", async () => {
    const engine = new AudiverisEngine({ bin: BIN }, fakeRunner({ "b.mvt1.mxl": mxl(SCORE), "b.mvt2.mxl": mxl(SCORE) }));
    const res = await engine.convert(await prepareInput(fixture("sample-1.png"), "image/png"));
    expect(res.warnings.map((w) => w.message).join()).toMatch(/2 movements/);
  });

  it("fails with recognition_failed when nothing is exported", async () => {
    const engine = new AudiverisEngine({ bin: BIN }, async () => ({ code: 0, stdout: "WARN  no staves found", stderr: "" }));
    await expect(engine.convert(await prepareInput(fixture("sample-1.png"), "image/png"))).rejects.toMatchObject({
      code: "recognition_failed",
      message: /no staves/,
    });
  });

  it("warns about chord names Audiveris dropped for lack of a note under them", async () => {
    const log =
      'INFO  [x#1] SentenceInter 483  | No chord below ChordNameInter#866{(0.766) staff:2 TEXT "B" font:BS-40 root:B ChordKind{MAJOR}}\n' +
      'INFO  [x#1] SentenceInter 483  | No chord below ChordNameInter#878{(0.711) staff:2 TEXT "C7" font:S-37 root:C ChordKind{DOMINANT \'7\'}}\n' +
      'INFO  [x#2] SentenceInter 483  | No chord below ChordNameInter#433{(0.692) staff:1 TEXT "Gm7" font:40 root:G ChordKind{MINOR_SEVENTH \'m7\'}}';
    expect(droppedChordNames(log)).toEqual(["C7", "Gm7"]);
    const runner: Runner = async (bin, args) => ({ ...(await fakeRunner({ "a.mxl": mxl(SCORE) })(bin, args, 1)), stdout: log });
    const res = await new AudiverisEngine({ bin: BIN }, runner).convert(await prepareInput(fixture("sample-1.png"), "image/png"));
    expect(res.warnings.map((w) => w.message).join()).toMatch(/dropped chord symbols C7, Gm7/);
  });

  it("is unavailable when the binary is missing", async () => {
    const engine = new AudiverisEngine({ bin: "/nonexistent/Audiveris" });
    expect(engine.isAvailable()).toBe(false);
    await expect(engine.convert(await prepareInput(fixture("sample-1.png"), "image/png"))).rejects.toMatchObject({ code: "engine_unavailable" });
  });
});

describe("Audiveris output post-processing", () => {
  it("re-derives harmony kinds from the OCR text", () => {
    const xml = `<harmony default-y="21" placement="above"><root><root-step>E</root-step></root><kind text="m7b5">minor-seventh</kind><degree><degree-value>5</degree-value><degree-alter>-1</degree-alter><degree-type>alter</degree-type></degree></harmony>`;
    const out = fixAudiverisHarmonies(xml);
    expect(out).toContain('<harmony default-y="21" placement="above">');
    expect(out).toContain('<kind text="m7b5">half-diminished</kind>');
    expect(out).not.toContain("<degree>");
  });

  it("turns chord-like <words> into <harmony>, leaves other words alone", () => {
    const words = (t: string) =>
      `<direction placement="above" directive="yes"><direction-type><words font-size="9">${t}</words></direction-type></direction>`;
    expect(fixAudiverisHarmonies(words("D7alt"))).toMatch(/^<harmony placement="above"><root><root-step>D<\/root-step><\/root><kind text="7alt">dominant<\/kind>/);
    for (const t of ["Blue Lantern", "A", "Fine", "Swing"]) expect(fixAudiverisHarmonies(words(t))).toBe(words(t));
  });

  it("repairs a flat read as l>, I>, |> or L after the root", () => {
    expect(repairOcrChord("Bl>maj7")).toBe("Bbmaj7");
    expect(repairOcrChord("BI>7#11")).toBe("Bb7#11");
    expect(repairOcrChord("B|>7")).toBe("Bb7");
    expect(repairOcrChord("BLm7")).toBe("Bbm7");
    expect(repairOcrChord("El7")).toBe("Eb7");
    for (const t of ["Bbm7", "Am7", "Blue", "Lantern", "Fine", "B"]) expect(repairOcrChord(t)).toBeNull();
    const words = (t: string) =>
      `<direction placement="above"><direction-type><words font-size="9">${t}</words></direction-type></direction>`;
    expect(fixAudiverisHarmonies(words("Bl&gt;maj7"))).toMatch(
      /^<harmony placement="above"><root><root-step>B<\/root-step><root-alter>-1<\/root-alter><\/root><kind text="maj7">major-seventh<\/kind>/,
    );
  });

  it("promotes a large centred title read as a direction above bar 1 to <work-title>", () => {
    const raw = fixture("audiveris-raw-sample-1-pdf.xml").toString("utf8"); // Audiveris 5.11, default settings
    expect(raw).toMatch(/<words [^>]*font-size="12">Blue Lantern<\/words>/);
    const out = normalizeAudiverisXml(raw);
    expect(out).toMatch(/<score-partwise version="4.0">\s*<work><work-title>Blue Lantern<\/work-title><\/work>/);
    expect(out).not.toMatch(/<words[^>]*>Blue Lantern/);
    expect(out).not.toMatch(/<credit page="1">/); // OSMD would draw an added centred credit as a subtitle
    expect(out).not.toContain("/tmp/"); // input path from the server's temp dir
    expect(validateXsd(out)).toMatchObject({ ok: true });
  });

  it("warns when boxed rehearsal letters don't start at A", () => {
    const m = (n: number, r: string) => `<measure number="${n}"><direction><direction-type><rehearsal>${r}</rehearsal></direction-type></direction></measure>`;
    expect(rehearsalWarnings(m(1, "E") + m(9, "E"))).toEqual([
      { measure: 1, code: "low_confidence", message: expect.stringContaining("read as E, E") },
    ]);
    expect(rehearsalWarnings(m(1, "A") + m(9, "B"))).toEqual([]);
    expect(rehearsalWarnings(m(1, "Intro") + m(5, "B"))).toEqual([]);
  });

  it("moves <movement-title> to <work-title> and marks its credit", () => {
    const xml =
      '<score-partwise version="4.0"><movement-title>Blue Lantern</movement-title><identification/>' +
      '<credit page="1"><credit-words default-x="662" default-y="1680" font-size="12">Blue Lantern</credit-words></credit>' +
      '<credit page="2"><credit-words default-x="190" default-y="1582">12</credit-words></credit><part-list/></score-partwise>';
    const out = promoteTitle(xml);
    expect(out).toContain('<score-partwise version="4.0">\n  <work><work-title>Blue Lantern</work-title></work><identification/>');
    expect(validateXsd(out.replace("<part-list/>", '<part-list><score-part id="P1"><part-name/></score-part></part-list><part id="P1"><measure number="1"/></part>')).ok).toBe(true);
    expect(out).toContain('<credit page="1"><credit-type>title</credit-type><credit-words default-x="662"');
    expect(out).toContain('<credit page="2"><credit-words');
    expect(promoteTitle(out)).toBe(out);
  });

  it("warns about chord-row words that look like a misread chord", () => {
    const m = (n: number, words: string, y = 24) =>
      `<measure number="${n}"><harmony default-y="21" font-size="9.36"><root><root-step>C</root-step></root><kind text="7">dominant</kind></harmony>` +
      `<direction><direction-type><words default-y="${y}" font-size="12">${words}</words></direction-type></direction></measure>`;
    // Real case: Audiveris read B♭maj7 as "vaaj7" (12pt) on the chord row of the PDF fixture.
    const xml = m(10, "vaaj7") + m(11, "Fine") + m(12, "12") + m(13, "Fl2", 60) + m(14, "D7alt");
    expect(unreadChordWarnings(xml)).toEqual([
      { measure: 10, code: "unparsed_chord", message: expect.stringContaining('"vaaj7"') },
    ]);
  });

  it("leaves small, off-centre or direction-like words alone", () => {
    const raw = fixture("audiveris-raw-sample-1-pdf.xml").toString("utf8");
    const small = raw.replace('font-size="12">Blue Lantern', 'font-size="9">Blue Lantern');
    expect(promoteTitle(small)).toBe(small);
    const fine = raw.replace('font-size="12">Blue Lantern', 'font-size="12">D.S. al Coda');
    expect(promoteTitle(fine)).toBe(fine);
    const right = raw.replace('relative-x="-18" font-family="serif" font-size="12">Blue', 'relative-x="600" font-family="serif" font-size="12">Blue');
    expect(promoteTitle(right)).toBe(right);
  });

  it("rejects non-partwise output and relabels the version", () => {
    expect(() => normalizeAudiverisXml("<score-timewise/>")).toThrow(/score-partwise/);
    expect(normalizeAudiverisXml('<score-partwise version="4.0.3"><part-list/></score-partwise>')).toContain('version="4.0"');
    const doctype = '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0.3 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">';
    expect(normalizeAudiverisXml(`${doctype}<score-partwise version="4.0.3"><part-list/></score-partwise>`)).toContain("DTD MusicXML 4.0 Partwise//EN");
  });
});

// Real Audiveris run on the fixtures (skipped unless scripts/install-audiveris.sh was run).
const real = new AudiverisEngine();
describe.skipIf(!real.isAvailable())("Audiveris (installed) on the fixtures", () => {
  const truth = summarizeMusicXML(SCORE);
  for (const [file, mime] of [
    ["sample-1.pdf", "application/pdf"],
    ["sample-1.png", "image/png"],
  ] as const) {
    it(`recognizes ${file}`, { timeout: 180_000 }, async () => {
      const res = await real.convert(await prepareInput(fixture(file), mime));
      expect(validateXsd(res.musicxml).ok).toBe(true);
      const acc = compareScores(truth, summarizeMusicXML(res.musicxml));
      expect(acc.measures.got).toBe(acc.measures.expected);
      expect(acc.pitchesF1).toBeGreaterThan(0.95);
      expect(acc.notesF1).toBeGreaterThan(0.95);
      // 0.84 (PDF) / 0.86 (PNG) before the OCR tuning in AUDIVERIS_CONSTANTS; 0.91 / 0.95 after.
      expect(acc.chordsF1).toBeGreaterThan(0.88);
      // Flat roots used to be lost entirely (the ♭ was dropped or read as "l>").
      const chords = summarizeMusicXML(res.musicxml).chords;
      for (const c of ["Bb:dominant", "Bb:minor-seventh", "Eb:dominant"]) expect(chords).toContain(c);
      expect(res.musicxml).toMatch(/<work-title>Blue Lantern<\/work-title>/);
    });
  }
});
