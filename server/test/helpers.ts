import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LeadSheet } from "../../shared/types.js";
import { FIXTURES_DIR, SERVER_DIR } from "../src/paths.js";

export const XSD = join(SERVER_DIR, "test", "schema", "musicxml.xsd");

/** Validate MusicXML against the MusicXML 4.0 XSD with xmllint (offline). */
export function validateXsd(xml: string): { ok: boolean; output: string } {
  const dir = mkdtempSync(join(tmpdir(), "jc-xsd-"));
  const file = join(dir, "score.musicxml");
  writeFileSync(file, xml);
  try {
    const out = execFileSync("xmllint", ["--noout", "--nonet", "--schema", XSD, file], { encoding: "utf8", stdio: "pipe" });
    return { ok: true, output: out };
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string };
    return { ok: false, output: `${err.stderr ?? ""}${err.stdout ?? ""}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function fixture(name: string): Buffer {
  return readFileSync(join(FIXTURES_DIR, name));
}

export function sampleSheet(): LeadSheet {
  return JSON.parse(fixture("sample-1.json").toString("utf8")) as LeadSheet;
}

/** Minimal sheet with the given measures. */
export function sheet(measures: LeadSheet["measures"], extra: Partial<LeadSheet> = {}): LeadSheet {
  return {
    title: "Test",
    key: { fifths: 0, mode: "major" },
    time: { beats: 4, beatType: 4 },
    clef: "treble",
    measures,
    ...extra,
  };
}

/** Build a multipart/form-data body for fastify.inject. */
export function multipart(
  fields: Record<string, string>,
  file?: { name?: string; filename: string; contentType: string; data: Buffer },
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = "----jazzcharts" + Math.random().toString(16).slice(2);
  const chunks: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  if (file) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${file.name ?? "file"}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
      ),
    );
    chunks.push(file.data, Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}
