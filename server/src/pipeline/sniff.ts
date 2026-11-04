export type SniffedType = "image/png" | "image/jpeg" | "image/webp" | "application/pdf";

/** Detect the file type from magic bytes. The client-supplied MIME type and extension are ignored. */
export function sniffType(buf: Uint8Array): SniffedType | null {
  const b = buf;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) {
    return "image/png";
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (
    b.length >= 12 &&
    String.fromCharCode(b[0]!, b[1]!, b[2]!, b[3]!) === "RIFF" &&
    String.fromCharCode(b[8]!, b[9]!, b[10]!, b[11]!) === "WEBP"
  ) {
    return "image/webp";
  }
  // PDF header may be preceded by up to 1024 bytes of junk per the spec.
  const head = Buffer.from(b.subarray(0, Math.min(b.length, 1024))).toString("latin1");
  if (head.includes("%PDF-")) return "application/pdf";
  return null;
}
