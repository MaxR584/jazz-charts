import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ChordSymbolContainer,
  IntervalTransposeCalculator,
  MusicSheetCalculator,
  OpenSheetMusicDisplay,
  TransposeCalculator,
} from "opensheetmusicdisplay";
import { installChordTextPatch } from "../src/lib/osmd-chords";
import { transposeDocument } from "../src/lib/transpose";
import { getTitle, parseMusicXml, serializeMusicXml } from "../src/lib/xml";
import { chord, n, scoreXml } from "./helpers";

installChordTextPatch();

// jsdom has no canvas; OSMD only measures text widths with it while building the graphic sheet.
HTMLCanvasElement.prototype.getContext = function () {
  return { font: "", measureText: (t: string) => ({ width: t.length * 6 }) };
} as never;

async function labels(xml: string, halftones = 0, calc: TransposeCalculator | IntervalTransposeCalculator | undefined = undefined): Promise<string[]> {
  const div = document.createElement("div");
  document.body.appendChild(div);
  const osmd = new OpenSheetMusicDisplay(div, { autoResize: false, backend: "svg" });
  await osmd.load(xml);
  MusicSheetCalculator.transposeCalculator = calc as never;
  const out: string[] = [];
  for (const m of osmd.Sheet.SourceMeasures) {
    const key = m.FirstInstructionsStaffEntries[0]?.Instructions.find((i) => "Key" in i) ?? osmd.Sheet.SourceMeasures[0].FirstInstructionsStaffEntries[0].Instructions.find((i) => "Key" in i);
    for (const v of m.VerticalSourceStaffEntryContainers) {
      for (const se of v.StaffEntries) {
        for (const c of se?.ChordContainers ?? []) out.push(ChordSymbolContainer.calculateChordText(c, halftones, key as never));
      }
    }
  }
  MusicSheetCalculator.transposeCalculator = undefined as never;
  return out;
}

const deg = (v: number, a: number, t: string, hidden = true) =>
  `<degree${hidden ? ' print-object="no"' : ""}><degree-value>${v}</degree-value><degree-alter>${a}</degree-alter><degree-type>${t}</degree-type></degree>`;

describe("OSMD chord labels honor kind/@text", () => {
  it("prints the written suffix instead of OSMD's kind+degree label", async () => {
    const h = (s: string, a: number, kind: string, text: string, degs = "", bass = "") =>
      `<harmony><root><root-step>${s}</root-step>${a ? `<root-alter>${a}</root-alter>` : ""}</root><kind text="${text}">${kind}</kind>${bass}${degs}</harmony>`;
    const xml = scoreXml(-1, [
      h("C", 0, "suspended-fourth", "7sus4", deg(7, -1, "add")) + n("C", 0, 5) +
        h("D", 0, "dominant", "7alt", deg(9, -1, "add") + deg(9, 1, "add") + deg(5, 1, "alter")) + n("D", 0, 5) +
        h("F", 0, "major-sixth", "6/9", deg(9, 0, "add")) + n("F", 0, 5) +
        h("A", 0, "dominant", "7b9", deg(9, -1, "add")) + n("A", 0, 4),
      h("B", -1, "dominant", "7#11", deg(11, 1, "add")) + n("B", -1, 4) +
        h("E", -1, "major-seventh", "maj7", "", "<bass><bass-step>G</bass-step></bass>") + n("G", 0, 4) +
        h("E", 0, "half-diminished", "m7b5") + n("E", 0, 4) +
        h("G", 0, "major", "") + n("G", 0, 4),
    ]);
    expect(await labels(xml)).toEqual(["C7sus4", "D7alt", "F6/9", "A7b9", "Bb7#11", "Ebmaj7/G", "Em7b5", "G"]);
  });

  it("falls back to OSMD's label without kind text, hiding print-object=no degrees", async () => {
    const xml = scoreXml(0, [
      `<harmony><root><root-step>A</root-step></root><kind>dominant</kind>${deg(9, -1, "add", false)}</harmony>` + n("A", 0, 4) +
        `<harmony><root><root-step>A</root-step></root><kind>dominant</kind>${deg(9, -1, "add")}</harmony>` + n("A", 0, 4) +
        `<harmony><root><root-step>C</root-step></root><kind use-symbols="yes" text="whatever">minor-seventh</kind></harmony>` + n("C", 0, 5) +
        `<harmony><root><root-step>C</root-step></root><kind text="N.C.">none</kind></harmony>` + n("C", 0, 5),
    ]);
    const out = await labels(xml);
    expect(out.slice(0, 3)).toEqual(["A7(b9)", "A7", "Cm7"]);
    expect(out[3]).not.toContain("C7");
  });

  it("transposes root and bass and keeps the written suffix (D7alt → E7alt for Bb)", async () => {
    const xml = scoreXml(-1, [
      chord("D", 0, "dominant", "7alt") + n("D", 0, 5) + chord("E", -1, "major-seventh", "maj7", ["G", 0]) + n("G", 0, 4) +
        chord("B", -1, "dominant", "7#11") + n("B", -1, 4) + chord("F", 0, "major-sixth", "6/9") + n("F", 0, 4),
    ]);
    const calc = new IntervalTransposeCalculator();
    expect(await labels(xml, 2, calc)).toEqual(["E7alt", "Fmaj7/A", "C7#11", "G6/9"]);
    expect(await labels(xml, 2, new TransposeCalculator())).toEqual(["E7alt", "Fmaj7/A", "C7#11", "G6/9"]);
  });

  it("renders the fixture chords as written", async () => {
    const xml = readFileSync(resolve(__dirname, "../../fixtures/sample-1.musicxml"), "utf8");
    const out = await labels(xml);
    expect(out).toContain("C7sus4");
    expect(out).toContain("D7alt");
    expect(out).toContain("F6/9");
    expect(out).toContain("A7b9");
    expect(out).toContain("Bb7#11");
    expect(out.join(" ")).not.toMatch(/\(/);
  });
});

describe("exported (transposed) file", () => {
  it("renders the fixture for Bb instruments with suffixes intact (D7alt → E7alt, F6/9 → G6/9)", async () => {
    const doc = parseMusicXml(readFileSync(resolve(__dirname, "../../fixtures/sample-1.musicxml"), "utf8"));
    transposeDocument(doc, { semitones: 2 });
    const out = await labels(serializeMusicXml(doc));
    for (const c of ["E7alt", "D7sus4", "G6/9", "B7b9", "C7#11", "Cmaj7", "Cm7", "F7"]) expect(out).toContain(c);
  });
});

describe("getTitle", () => {
  const xml = (head: string) => `<score-partwise version="4.0">${head}<part-list/></score-partwise>`;
  it("uses work-title, then movement-title, then the title credit", () => {
    expect(getTitle(parseMusicXml(xml("<work><work-title>A</work-title></work><movement-title>B</movement-title>")))).toBe("A");
    expect(getTitle(parseMusicXml(xml("<movement-title>B</movement-title>")))).toBe("B");
    const credits =
      '<credit page="1"><credit-words>12</credit-words></credit><credit page="1"><credit-type>title</credit-type><credit-words>Blue Lantern</credit-words></credit>';
    expect(getTitle(parseMusicXml(xml(credits)))).toBe("Blue Lantern");
    expect(getTitle(parseMusicXml(xml("<work><work-title> </work-title></work>")))).toBe("Untitled");
  });
});
