import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import type { SniffedType } from "./sniff.js";

const run = promisify(execFile);

export const MAX_LONG_EDGE = 2000;

export interface PreparedInput {
  kind: "pdf" | "image";
  mime: SniffedType;
  /** The uploaded bytes (images: as uploaded; PDFs: the PDF). */
  original: Buffer;
  /** One normalized PNG per page (EXIF rotation applied, metadata stripped, long edge ≤ 2000 px). */
  pages: Buffer[];
  /** Total page count of the PDF (may exceed pages.length if capped). */
  totalPages: number;
}

export class InputError extends Error {
  constructor(
    message: string,
    readonly code: "unsupported_type" | "recognition_failed" = "unsupported_type",
  ) {
    super(message);
  }
}

/**
 * Normalize an image for the vision model: apply EXIF orientation (then drop
 * metadata), flatten transparency onto white, cap the long edge, encode as PNG.
 */
export async function normalizeImage(buf: Buffer, maxLongEdge = MAX_LONG_EDGE): Promise<Buffer> {
  try {
    return await sharp(buf, { failOn: "error" })
      .rotate() // auto-orient from EXIF; output carries no EXIF since we don't call withMetadata()
      .flatten({ background: "#ffffff" })
      .resize({ width: maxLongEdge, height: maxLongEdge, fit: "inside", withoutEnlargement: true })
      .png({ compressionLevel: 9 })
      .toBuffer();
  } catch (e) {
    throw new InputError(`Could not decode image: ${(e as Error).message}`);
  }
}

export async function pdfPageCount(pdfPath: string): Promise<number> {
  try {
    const { stdout } = await run("pdfinfo", [pdfPath], { timeout: 30_000 });
    const m = /^Pages:\s+(\d+)/m.exec(stdout);
    return m ? Number(m[1]) : 0;
  } catch (e) {
    throw new InputError(`Could not read PDF: ${firstLine(e)}`);
  }
}

function firstLine(e: unknown): string {
  const err = e as { stderr?: string; message?: string };
  return (err.stderr || err.message || String(e)).split("\n").find((l) => l.trim()) ?? "unknown error";
}

export interface PdfToPngOptions {
  dpi?: number;
  maxPages?: number;
  maxLongEdge?: number;
}

/** Rasterize a PDF to one PNG per page with pdftoppm, then normalize each page. */
export async function pdfToPngs(pdf: Buffer, opts: PdfToPngOptions = {}): Promise<{ pages: Buffer[]; totalPages: number }> {
  const dpi = opts.dpi ?? 250;
  const maxPages = opts.maxPages ?? 20;
  const dir = await mkdtemp(join(tmpdir(), "jc-pdf-"));
  try {
    const input = join(dir, "in.pdf");
    await writeFile(input, pdf);
    const totalPages = await pdfPageCount(input);
    if (totalPages < 1) throw new InputError("PDF has no pages");
    const last = Math.min(totalPages, maxPages);
    try {
      await run("pdftoppm", ["-png", "-r", String(dpi), "-f", "1", "-l", String(last), input, join(dir, "page")], {
        timeout: 120_000,
        maxBuffer: 16 * 1024 * 1024,
      });
    } catch (e) {
      throw new InputError(`pdftoppm failed: ${firstLine(e)}`);
    }
    // pdftoppm zero-pads page numbers by total digit count: page-1.png or page-01.png ...
    const files = (await readdir(dir))
      .filter((f) => /^page-\d+\.png$/.test(f))
      .sort((a, b) => Number(/\d+/.exec(a)![0]) - Number(/\d+/.exec(b)![0]));
    if (files.length === 0) throw new InputError("pdftoppm produced no pages");
    const pages: Buffer[] = [];
    for (const f of files) pages.push(await normalizeImage(await readFile(join(dir, f)), opts.maxLongEdge));
    return { pages, totalPages };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function prepareInput(buf: Buffer, mime: SniffedType, opts: PdfToPngOptions = {}): Promise<PreparedInput> {
  if (mime === "application/pdf") {
    const { pages, totalPages } = await pdfToPngs(buf, opts);
    return { kind: "pdf", mime, original: buf, pages, totalPages };
  }
  const page = await normalizeImage(buf, opts.maxLongEdge);
  return { kind: "image", mime, original: buf, pages: [page], totalPages: 1 };
}
