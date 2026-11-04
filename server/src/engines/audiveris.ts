import { execFile } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import sharp from "sharp";
import { harmonyXml } from "../musicxml/builder.js";
import { parseChordSymbol } from "../musicxml/chords.js";
import { unzipMxl } from "../musicxml/mxl.js";
import { validateMusicXML } from "../musicxml/validate.js";
import type { PreparedInput } from "../pipeline/pages.js";
import { VENDOR_DIR } from "../paths.js";
import { EngineError, type ConversionEngine, type EngineResult } from "./types.js";

export interface AudiverisOptions {
  /** Path to the Audiveris launcher. Default: $AUDIVERIS_BIN or server/vendor/audiveris/bin/Audiveris */
  bin?: string;
  timeoutMs?: number;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type Runner = (bin: string, args: string[], timeoutMs: number) => Promise<RunResult>;

const defaultRunner: Runner = (bin, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(
      bin,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
        env: audiverisEnv(bin),
      },
      (err, stdout, stderr) => {
        const code = err ? ((err as NodeJS.ErrnoException & { code?: unknown }).code as number | undefined) ?? 1 : 0;
        resolve({ code: typeof code === "number" ? code : 1, stdout: String(stdout), stderr: String(stderr) + (err && (err as { killed?: boolean }).killed ? "\n[killed: timeout]" : "") });
      },
    );
  });

/**
 * Environment for the Audiveris JVM: headless AWT, and TESSDATA_PREFIX pointing at
 * the OCR language files installed next to the binary (without them Audiveris
 * skips all text, i.e. chord symbols and titles).
 */
export function audiverisEnv(bin: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    JAVA_TOOL_OPTIONS: `${process.env.JAVA_TOOL_OPTIONS ?? ""} -Djava.awt.headless=true`.trim(),
  };
  const tessdata = join(dirname(dirname(bin)), "tessdata");
  if (!env.TESSDATA_PREFIX && existsSync(join(tessdata, "eng.traineddata"))) env.TESSDATA_PREFIX = tessdata;
  return env;
}

export function defaultAudiverisBin(): string {
  return process.env.AUDIVERIS_BIN ?? join(VENDOR_DIR, "audiveris", "bin", "Audiveris");
}

async function findFiles(dir: string, re: RegExp): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile() && re.test(e.name)) out.push(join(e.parentPath, e.name));
  }
  return out.sort();
}

/**
 * Prepare an image for OMR: auto-orient, flatten, grayscale. Audiveris wants
 * ~300 dpi scans (staff interline ≥ ~12 px); small screenshots are upscaled.
 */
export async function omrImage(buf: Buffer): Promise<Buffer> {
  const img = sharp(buf).rotate().flatten({ background: "#ffffff" }).grayscale();
  const meta = await sharp(buf).rotate().metadata();
  const longEdge = Math.max(meta.width ?? 0, meta.height ?? 0);
  const target = longEdge > 0 && longEdge < 2400 ? Math.min(2, 2400 / longEdge) : 1;
  if (target > 1.05) {
    img.resize({ width: Math.round((meta.width ?? 0) * target), kernel: "lanczos3" });
  }
  return img.png().toBuffer();
}

export class AudiverisEngine implements ConversionEngine {
  readonly name = "audiveris" as const;
  private readonly bin: string;
  private readonly timeoutMs: number;

  constructor(
    opts: AudiverisOptions = {},
    private readonly runner: Runner = defaultRunner,
  ) {
    this.bin = opts.bin ?? defaultAudiverisBin();
    this.timeoutMs = opts.timeoutMs ?? Number(process.env.AUDIVERIS_TIMEOUT_MS ?? 300_000);
  }

  isAvailable(): boolean {
    try {
      accessSync(this.bin, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  /** Audiveris starts a JVM per run (~1 GB); run one job at a time. */
  private queue: Promise<unknown> = Promise.resolve();

  convert(input: PreparedInput): Promise<EngineResult> {
    const job = this.queue.then(() => this.convertNow(input));
    this.queue = job.catch(() => undefined);
    return job;
  }

  private async convertNow(input: PreparedInput): Promise<EngineResult> {
    if (!this.isAvailable()) {
      throw new EngineError("engine_unavailable", `Audiveris is not installed (looked for ${this.bin}); run scripts/install-audiveris.sh`);
    }
    const dir = await mkdtemp(join(tmpdir(), "jc-audiveris-"));
    try {
      const out = join(dir, "out");
      let inFile: string;
      if (input.kind === "pdf") {
        inFile = join(dir, "score.pdf");
        await writeFile(inFile, input.original);
      } else {
        inFile = join(dir, "score.png");
        await writeFile(inFile, await omrImage(input.original));
      }
      const res = await this.runner(this.bin, ["-batch", "-export", "-output", out, "--", inFile], this.timeoutMs);
      const mxls = await findFiles(dir, /\.mxl$/i).catch(() => [] as string[]);
      if (mxls.length === 0) {
        const log = (res.stdout + "\n" + res.stderr).split("\n").filter((l) => /WARN|ERROR|Exception|killed/i.test(l)).slice(-5).join(" | ");
        throw new EngineError(
          "recognition_failed",
          `Audiveris produced no MusicXML (exit ${res.code}). ${log || "No music recognized; the image may be too small or not engraved notation."}`.trim(),
        );
      }
      // One .mxl per movement (book.mvt1.mxl, ...). Lead sheets are a single movement.
      const xml = normalizeAudiverisXml(unzipMxl(await readFile(mxls[0]!)));
      const warnings = validateMusicXML(xml);
      if (mxls.length > 1) {
        warnings.push({ measure: null, code: "other", message: `Audiveris split the score into ${mxls.length} movements; only the first is returned.` });
      }
      return { musicxml: xml, model: null, warnings };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

const tagText = (xml: string, tag: string): string | null => {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`).exec(xml);
  return m ? m[1]!.trim() : null;
};
const acc = (alter: string | null) => {
  const a = Number(alter ?? 0);
  return a > 0 ? "#".repeat(a) : "b".repeat(-a);
};
const unescapeXml = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/**
 * Audiveris's chord-symbol OCR gets the text right more often than the kind
 * (e.g. text "m7b5" → kind minor-seventh), and leaves some symbols (e.g. "D7alt")
 * as plain <words>. Re-derive each <harmony> from its displayed text with our
 * parser, and turn <words> directions that are clearly chord symbols into
 * <harmony>. Anything our parser rejects is left untouched.
 */
export function fixAudiverisHarmonies(xml: string): string {
  let out = xml.replace(/<harmony(\s[^>]*)?>([\s\S]*?)<\/harmony>/g, (whole, attrs: string | undefined, inner: string) => {
    const step = tagText(inner, "root-step");
    const kindText = /<kind[^>]*\btext="([^"]*)"/.exec(inner)?.[1];
    if (!step || kindText === undefined) return whole;
    const bassStep = tagText(inner, "bass-step");
    const symbol =
      step + acc(tagText(inner, "root-alter")) + unescapeXml(kindText) + (bassStep ? `/${bassStep}${acc(tagText(inner, "bass-alter"))}` : "");
    const r = parseChordSymbol(symbol);
    if (!r.ok) return whole;
    const offset = Number(tagText(inner, "offset") ?? 0);
    return harmonyXml(r.chord, offset).replace(/^<harmony[^>]*>/, `<harmony${attrs ?? ""}>`);
  });
  out = out.replace(
    /<direction(\s[^>]*)?>\s*<direction-type>\s*<words[^>]*>([^<]+)<\/words>\s*<\/direction-type>\s*(<offset[^>]*>[^<]*<\/offset>)?\s*(?:<staff>[^<]*<\/staff>)?\s*<\/direction>/g,
    (whole, attrs: string | undefined, words: string, offsetTag: string | undefined) => {
      const textValue = unescapeXml(words).trim();
      // Require a suffix or slash bass so rehearsal letters ("A") and words don't become chords.
      if (!/^[A-G][#b♭♯]?\S+$/.test(textValue)) return whole;
      const r = parseChordSymbol(textValue);
      if (!r.ok || !r.chord.root) return whole;
      const offset = offsetTag ? Number(tagText(offsetTag, "offset") ?? 0) : 0;
      // <direction> attributes (e.g. directive) are not all valid on <harmony>.
      const placement = /\bplacement="(above|below)"/.exec(attrs ?? "")?.[1] ?? "above";
      return harmonyXml(r.chord, offset).replace(/^<harmony[^>]*>/, `<harmony placement="${placement}">`);
    },
  );
  return out;
}

/** Make sure we hand out an uncompressed score-partwise string labelled 4.0. */
export function normalizeAudiverisXml(xml: string): string {
  if (!/<score-partwise[\s>]/.test(xml)) {
    throw new EngineError("recognition_failed", "Audiveris output is not a score-partwise document");
  }
  return fixAudiverisHarmonies(xml.replace(/<score-partwise([^>]*?)version="[^"]*"/, '<score-partwise$1version="4.0"'));
}
