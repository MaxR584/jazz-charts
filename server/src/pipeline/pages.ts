import sharp from "sharp";
import type { SniffedType } from "./sniff.js";

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

export interface PdfToPngOptions {
  dpi?: number;
  maxPages?: number;
  maxLongEdge?: number;
}

/**
 * Rasterize a PDF to one PNG per page with MuPDF (WebAssembly, so it works the
 * same on Windows, macOS and Linux with nothing else installed), then normalize each page.
 */
export async function pdfToPngs(pdf: Buffer, opts: PdfToPngOptions = {}): Promise<{ pages: Buffer[]; totalPages: number }> {
  const dpi = opts.dpi ?? 250;
  const maxPages = opts.maxPages ?? 20;
  const mupdf = await import("mupdf");
  let doc: InstanceType<typeof mupdf.Document> | undefined;
  try {
    let totalPages: number;
    try {
      doc = mupdf.Document.openDocument(pdf, "application/pdf");
      totalPages = doc.countPages();
    } catch (e) {
      throw new InputError(`Could not read PDF: ${errorMessage(e)}`);
    }
    if (totalPages < 1) throw new InputError("PDF has no pages");
    const scale = mupdf.Matrix.scale(dpi / 72, dpi / 72);
    const pages: Buffer[] = [];
    for (let i = 0; i < Math.min(totalPages, maxPages); i++) {
      let png: Uint8Array;
      try {
        const page = doc.loadPage(i);
        const pix = page.toPixmap(scale, mupdf.ColorSpace.DeviceRGB, false, true);
        png = pix.asPNG();
        pix.destroy();
        page.destroy();
      } catch (e) {
        throw new InputError(`Could not render PDF page ${i + 1}: ${errorMessage(e)}`);
      }
      pages.push(await normalizeImage(Buffer.from(png), opts.maxLongEdge));
    }
    return { pages, totalPages };
  } finally {
    doc?.destroy();
  }
}

function errorMessage(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).split("\n")[0] || "unknown error";
}

export async function prepareInput(buf: Buffer, mime: SniffedType, opts: PdfToPngOptions = {}): Promise<PreparedInput> {
  if (mime === "application/pdf") {
    const { pages, totalPages } = await pdfToPngs(buf, opts);
    return { kind: "pdf", mime, original: buf, pages, totalPages };
  }
  const page = await normalizeImage(buf, opts.maxLongEdge);
  return { kind: "image", mime, original: buf, pages: [page], totalPages: 1 };
}
