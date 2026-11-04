import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { InputError, normalizeImage, pdfToPngs, prepareInput } from "../src/pipeline/pages.js";
import { sniffType } from "../src/pipeline/sniff.js";
import { fixture } from "./helpers.js";

describe("sniffType (magic bytes, not extensions)", () => {
  it("detects the fixtures", () => {
    expect(sniffType(fixture("sample-1.png"))).toBe("image/png");
    expect(sniffType(fixture("sample-1.pdf"))).toBe("application/pdf");
  });
  it("detects JPEG and WebP", async () => {
    const img = sharp({ create: { width: 4, height: 4, channels: 3, background: "#fff" } });
    expect(sniffType(await img.clone().jpeg().toBuffer())).toBe("image/jpeg");
    expect(sniffType(await img.clone().webp().toBuffer())).toBe("image/webp");
  });
  it("rejects other content", async () => {
    expect(sniffType(Buffer.from("GIF89a....."))).toBeNull();
    expect(sniffType(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(sniffType(Buffer.from("PK\u0003\u0004 a zip"))).toBeNull();
    expect(sniffType(Buffer.alloc(0))).toBeNull();
    expect(sniffType(await sharp({ create: { width: 2, height: 2, channels: 3, background: "#000" } }).gif().toBuffer())).toBeNull();
  });
});

describe("PDF splitting", () => {
  it("rasterizes every page of the 2-page fixture, long edge ≤ 2000 px", async () => {
    const { pages, totalPages } = await pdfToPngs(fixture("sample-1.pdf"));
    expect(totalPages).toBe(2);
    expect(pages).toHaveLength(2);
    for (const p of pages) {
      expect(sniffType(p)).toBe("image/png");
      const meta = await sharp(p).metadata();
      expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(2000);
      expect(Math.max(meta.width!, meta.height!)).toBeGreaterThan(1500); // Letter @250dpi capped to 2000
    }
  });

  it("caps the number of pages", async () => {
    const { pages, totalPages } = await pdfToPngs(fixture("sample-1.pdf"), { maxPages: 1 });
    expect(totalPages).toBe(2);
    expect(pages).toHaveLength(1);
  });

  it("keeps page order past 9 pages (pdftoppm zero-pads page-01.png …)", async () => {
    // 12 pages alternating fixture page 1 / page 2, joined with pdfunite.
    const dir = mkdtempSync(join(tmpdir(), "jc-unite-"));
    try {
      const src = join(dir, "s.pdf");
      writeFileSync(src, fixture("sample-1.pdf"));
      const out = join(dir, "12.pdf");
      execFileSync("pdfunite", [...Array(6)].map(() => src).concat(out));
      const { pages, totalPages } = await pdfToPngs(readFileSync(out), { dpi: 40 });
      expect(totalPages).toBe(12);
      expect(pages).toHaveLength(12);
      const hashes = pages.map((p) => createHash("sha1").update(p).digest("hex"));
      for (let i = 2; i < 12; i++) expect(hashes[i]).toBe(hashes[i % 2]);
      expect(hashes[0]).not.toBe(hashes[1]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a broken PDF", async () => {
    await expect(pdfToPngs(Buffer.from("%PDF-1.4\nthis is not really a pdf"))).rejects.toBeInstanceOf(InputError);
  });

  it("prepareInput for a PDF", async () => {
    const input = await prepareInput(fixture("sample-1.pdf"), "application/pdf");
    expect(input.kind).toBe("pdf");
    expect(input.pages).toHaveLength(2);
  });
});

describe("image normalization", () => {
  it("applies EXIF orientation and strips metadata", async () => {
    // 200x100 landscape stored with orientation 6 (rotate 90° CW) → displayed 100x200
    const jpeg = await sharp({ create: { width: 200, height: 100, channels: 3, background: "#fff" } })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    expect((await sharp(jpeg).metadata()).orientation).toBe(6);
    const out = await normalizeImage(jpeg);
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe("png");
    expect([meta.width, meta.height]).toEqual([100, 200]);
    expect(meta.orientation).toBeUndefined();
    expect(meta.exif).toBeUndefined();
  });

  it("downscales large images and flattens transparency", async () => {
    const png = await sharp({ create: { width: 4000, height: 1000, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .png()
      .toBuffer();
    const out = await normalizeImage(png);
    const meta = await sharp(out).metadata();
    expect([meta.width, meta.height]).toEqual([2000, 500]);
    expect(meta.hasAlpha).toBe(false);
    const { data } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    expect(data[0]).toBe(255); // transparent → white
  });

  it("does not upscale small images", async () => {
    const png = await sharp({ create: { width: 300, height: 200, channels: 3, background: "#fff" } }).png().toBuffer();
    const meta = await sharp(await normalizeImage(png)).metadata();
    expect([meta.width, meta.height]).toEqual([300, 200]);
  });

  it("rejects undecodable images", async () => {
    const bad = Buffer.concat([fixture("sample-1.png").subarray(0, 64)]);
    await expect(normalizeImage(bad)).rejects.toBeInstanceOf(InputError);
  });
});
