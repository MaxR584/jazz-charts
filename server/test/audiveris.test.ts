import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { AudiverisEngine, fixAudiverisHarmonies, normalizeAudiverisXml, type Runner } from "../src/engines/audiveris.js";
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
    expect(calls[0]!.slice(0, 4)).toEqual(["-batch", "-export", "-output", expect.stringContaining("out")]);
    expect(calls[0]![4]).toBe("--");
    expect(calls[0]![5]).toMatch(/score\.pdf$/); // the original PDF, not page PNGs
    expect(res.model).toBeNull();
    expect(res.musicxml).toContain('<score-partwise version="4.0">');
    expect(res.warnings).toEqual([]);
  });

  it("feeds images as PNG", async () => {
    const calls: string[][] = [];
    const engine = new AudiverisEngine({ bin: BIN }, fakeRunner({ "a.mxl": mxl(SCORE) }, calls));
    await engine.convert(await prepareInput(fixture("sample-1.png"), "image/png"));
    expect(calls[0]![5]).toMatch(/score\.png$/);
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

  it("rejects non-partwise output and relabels the version", () => {
    expect(() => normalizeAudiverisXml("<score-timewise/>")).toThrow(/score-partwise/);
    expect(normalizeAudiverisXml('<score-partwise version="4.0.3"><part-list/></score-partwise>')).toContain('version="4.0"');
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
      expect(acc.chordsF1).toBeGreaterThan(0.7);
    });
  }
});
