import { strFromU8, unzipSync } from "fflate";

/**
 * Extract the score from a compressed MusicXML (.mxl) archive. Uses
 * META-INF/container.xml to find the root file; falls back to the first
 * .xml/.musicxml entry that isn't in META-INF.
 */
export function unzipMxl(data: Uint8Array): string {
  const files = unzipSync(data);
  const container = files["META-INF/container.xml"];
  if (container) {
    const m = /<rootfile[^>]*full-path="([^"]+)"/.exec(strFromU8(container));
    const path = m?.[1];
    if (path && files[path]) return strFromU8(files[path]!);
  }
  const name = Object.keys(files).find((n) => !n.startsWith("META-INF/") && /\.(xml|musicxml)$/i.test(n));
  if (!name) throw new Error("No MusicXML file found inside the .mxl archive");
  return strFromU8(files[name]!);
}
