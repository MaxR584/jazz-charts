import { spawn } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import sharp from "sharp";
import { harmonyXml } from "../musicxml/builder.js";
import { parseChordSymbol } from "../musicxml/chords.js";
import { unzipMxl } from "../musicxml/mxl.js";
import { validateMusicXML } from "../musicxml/validate.js";
import type { Warning } from "../../../shared/types.js";
import type { PreparedInput } from "../pipeline/pages.js";
import { VENDOR_DIR } from "../paths.js";
import { EngineError, type ConversionEngine, type EngineResult, type ProgressFn } from "./types.js";

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

export type Runner = (bin: string, args: string[], timeoutMs: number, onLine?: (line: string) => void) => Promise<RunResult>;

/** Runs Audiveris, streaming its log line by line (for progress) and collecting it. */
const defaultRunner: Runner = (bin, args, timeoutMs, onLine) =>
  new Promise((resolve) => {
    const out: string[] = [];
    const err: string[] = [];
    let killed = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, { env: audiverisEnv(bin), windowsHide: true });
    } catch (e) {
      return resolve({ code: 1, stdout: "", stderr: String(e) });
    }
    const timer = setTimeout(() => {
      killed = true;
      child.kill();
    }, timeoutMs);
    const pipe = (stream: NodeJS.ReadableStream | null, sink: string[]) => {
      let buf = "";
      stream?.setEncoding("utf8");
      stream?.on("data", (chunk: string) => {
        buf += chunk;
        const lines = buf.split(/\r?\n/);
        buf = lines.pop() ?? "";
        for (const l of lines) {
          sink.push(l);
          onLine?.(l);
        }
      });
      stream?.on("end", () => {
        if (buf) {
          sink.push(buf);
          onLine?.(buf);
        }
      });
    };
    pipe(child.stdout, out);
    pipe(child.stderr, err);
    child.on("error", (e) => err.push(String(e)));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout: out.join("\n"), stderr: err.join("\n") + (killed ? "\n[killed: timeout]" : "") });
    });
  });

/** Audiveris' processing steps per page, in order, as logged by StepMonitoring. */
export const AUDIVERIS_STEPS = [
  "LOAD", "BINARY", "SCALE", "GRID", "HEADERS", "STEM_SEEDS", "BEAMS", "LEDGERS", "HEADS", "STEMS",
  "REDUCTION", "CUE_BEAMS", "TEXTS", "MEASURES", "CHORDS", "CURVES", "SYMBOLS", "LINKS", "RHYTHMS", "PAGE",
] as const;

const STAGE_LABELS: Record<string, string> = {
  LOAD: "Loading the image", BINARY: "Cleaning up the image", SCALE: "Measuring the staff", GRID: "Finding staff lines",
  HEADERS: "Reading clefs and key signatures", STEM_SEEDS: "Finding note stems", BEAMS: "Finding beams", LEDGERS: "Finding ledger lines",
  HEADS: "Finding note heads", STEMS: "Connecting stems", REDUCTION: "Sorting out the notes", CUE_BEAMS: "Finding small notes",
  TEXTS: "Reading chord symbols and text", MEASURES: "Finding bars", CHORDS: "Grouping notes", CURVES: "Finding ties and slurs",
  SYMBOLS: "Reading symbols", LINKS: "Linking symbols to notes", RHYTHMS: "Working out rhythms", PAGE: "Finishing the page",
};

/** Tracks Audiveris' log and reports overall progress across pages. */
export class AudiverisProgress {
  private sheets = 1;
  constructor(private readonly report: ProgressFn) {}

  line(line: string): void {
    const n = /\|\s*(\d+) sheets? in /.exec(line);
    if (n) this.sheets = Math.max(1, Number(n[1]));
    const step = /\[[^\]#]*(?:#(\d+))?\]\s+StepMonitoring\s+\d+\s*\|\s*([A-Z_]+)\s*$/.exec(line);
    if (step) {
      const idx = AUDIVERIS_STEPS.indexOf(step[2] as (typeof AUDIVERIS_STEPS)[number]);
      if (idx < 0) return;
      const sheet = Math.min(Number(step[1] ?? 1), this.sheets);
      const percent = (((sheet - 1) * AUDIVERIS_STEPS.length + idx) / (this.sheets * AUDIVERIS_STEPS.length)) * 100;
      const label = STAGE_LABELS[step[2]!] ?? "Recognizing";
      this.report(percent, this.sheets > 1 ? `Page ${sheet} of ${this.sheets}: ${label.toLowerCase()}` : label);
      return;
    }
    if (/Exporting sheet/.test(line)) this.report(99, "Writing MusicXML");
  }
}

/** A plain-language explanation of why Audiveris produced nothing, from its log. */
export function explainAudiverisFailure(log: string, code: number | null): string {
  const tips = "Tips: use a sharp, straight-on image; zoom in so the staff lines are clearly visible (a full page should be at least about 1500 px tall); crop away everything but the music.";
  if (/does not seem to contain staff lines|Too few staff filaments/i.test(log)) {
    return `Audiveris couldn't find any music staff lines in this image. ${tips}`;
  }
  if (/interline/i.test(log) && /too (low|small)/i.test(log)) {
    return `The staff lines in this image are too small for Audiveris to read (the resolution is too low). ${tips}`;
  }
  if (/OutOfMemory|too large/i.test(log)) return "The image is too large for Audiveris. Try a smaller image or fewer pages.";
  if (/killed: timeout/.test(log)) return "Audiveris took too long and was stopped. Try a smaller image or fewer pages.";
  const last = log.split("\n").filter((l) => /WARN|ERROR|Exception/i.test(l)).slice(-3).join(" | ");
  return `Audiveris couldn't read music from this file (exit ${code}). ${tips}${last ? ` Details: ${last}` : ""}`;
}

/** Whether a failed run is worth retrying with an enhanced image. */
export function shouldRetryEnhanced(log: string): boolean {
  return /does not seem to contain staff lines|Too few staff filaments|interline|Sheet ignored|flagged as invalid/i.test(log);
}

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
  if (!env.TESSDATA_PREFIX) {
    // Linux vendor install keeps tessdata next to bin/; the Windows script puts it in vendor/tessdata.
    const candidates = [join(dirname(dirname(bin)), "tessdata"), join(dirname(bin), "tessdata"), join(VENDOR_DIR, "tessdata")];
    const found = candidates.find((d) => existsSync(join(d, "eng.traineddata")));
    if (found) env.TESSDATA_PREFIX = found;
  }
  return env;
}

/**
 * Audiveris constants tuned for lead sheets (passed as `-option key=value`).
 * Found by running Audiveris with DEBUG logging for org.audiveris.omr.text on the fixtures
 * (docs/errors-backend.md #14). All are text-only except minContextualGrade.
 */
export const AUDIVERIS_CONSTANTS: readonly string[] = [
  // Tesseract reads the small ♭ in "B♭m7" / "E♭7" correctly but with confidence ~0.53-0.59, under the
  // default 0.65, so the whole word was dropped.
  "org.audiveris.omr.text.tesseract.TesseractOCR.minConfidence=0.45",
  // A chord name's grade is its OCR confidence × 0.8 (short sentences get no length boost), so those
  // words then sat at ~0.43-0.47 and SigReducer removed them under the default 0.5.
  "org.audiveris.omr.glyph.Grades.minContextualGrade=0.4",
  // On screenshots the ♭ came out as "l>", "I>", "|>". Without these characters Tesseract picks "b".
  "org.audiveris.omr.text.tesseract.TesseractOrder.blackList=<>|\\{}[]~",
  // Text up to 7 interlines above the first staff counted as a direction, so a title close to the music
  // ("Blue Lantern", ~6.6 interlines up) became a <words> above bar 1. Chord names sit at ~2-3.
  "org.audiveris.omr.text.TextRole.maxStaffDy=5",
  // Text ending within 2 interlines of the staff's right end was taken for the composer, which caught
  // the last chord of the first system ("B♭7#11"). A real composer line is flush with the margin.
  "org.audiveris.omr.text.TextRole.maxRightDx=0.25",
];

/** Command-line arguments for one Audiveris batch run. */
export function audiverisArgs(outDir: string, inFile: string): string[] {
  return ["-batch", ...AUDIVERIS_CONSTANTS.flatMap((c) => ["-option", c]), "-export", "-output", outDir, "--", inFile];
}

/** Where Audiveris is usually installed. The first that exists wins; AUDIVERIS_BIN overrides. */
export function audiverisBinCandidates(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
  if (platform !== "win32") return [join(VENDOR_DIR, "audiveris", "bin", "Audiveris")];
  const roots = [
    env.ProgramFiles ?? "C:\\Program Files",
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Programs"),
    env.USERPROFILE && join(env.USERPROFILE, "scoop", "apps", "audiveris", "current"),
  ].filter(Boolean) as string[];
  return [
    join(VENDOR_DIR, "audiveris", "Audiveris.exe"),
    ...roots.flatMap((r) => (r.endsWith("current") ? [join(r, "Audiveris.exe")] : [join(r, "Audiveris", "Audiveris.exe")])),
  ];
}

export function defaultAudiverisBin(): string {
  if (process.env.AUDIVERIS_BIN) return process.env.AUDIVERIS_BIN;
  const candidates = audiverisBinCandidates();
  return candidates.find((c) => existsSync(c)) ?? candidates[0];
}

async function findFiles(dir: string, re: RegExp): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile() && re.test(e.name)) out.push(join(e.parentPath, e.name));
  }
  return out.sort();
}

/** Staff-line spacing (pixels) that Audiveris reads best. It gives up below about 5 px. */
export const TARGET_INTERLINE = 20;
/** Below this original spacing, enlarged images are converted to pure black and white
 * (tested: much better note recognition on small screenshots, no loss on larger ones). */
const THRESHOLD_BELOW_INTERLINE = 10;
const MAX_LONG_EDGE = 9000;

/**
 * Estimate the staff-line spacing ("interline") of a music image in pixels, from the
 * darkness profile of its rows: staff lines are dark rows in evenly spaced groups of five.
 * Returns null when no staff is found. Matches Audiveris' own measurement on our fixtures.
 */
export async function estimateInterline(buf: Buffer): Promise<number | null> {
  const { data, info } = await sharp(buf)
    .rotate()
    .flatten({ background: "#ffffff" })
    .grayscale()
    .normalise()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  if (w < 20 || h < 20) return null;
  const profile = new Float64Array(h);
  for (let y = 0; y < h; y++) {
    let sum = 0;
    const row = y * w;
    for (let x = 0; x < w; x++) sum += 255 - data[row + x]!;
    profile[y] = sum / (255 * w);
  }
  const sorted = Array.from(profile).sort((a, b) => a - b);
  const median = sorted[Math.floor(h / 2)]!;
  const top = sorted[Math.floor(h * 0.995)]!;
  const threshold = median + (top - median) * 0.35;
  const peaks: number[] = [];
  for (let y = 1; y < h - 1; y++) {
    if (profile[y]! >= threshold && profile[y]! >= profile[y - 1]! && profile[y]! > profile[y + 1]!) {
      if (peaks.length && y - peaks[peaks.length - 1]! < 2) continue;
      peaks.push(y);
    }
  }
  const spacings: number[] = [];
  for (let i = 0; i + 4 < peaks.length; i++) {
    const gaps = [1, 2, 3, 4].map((k) => peaks[i + k]! - peaks[i + k - 1]!);
    const mean = gaps.reduce((a, b) => a + b, 0) / 4;
    if (mean >= 2 && gaps.every((g) => Math.abs(g - mean) <= Math.max(1, mean * 0.2))) {
      spacings.push(mean);
      i += 4;
    }
  }
  if (spacings.length === 0) return null;
  spacings.sort((a, b) => a - b);
  return spacings[Math.floor(spacings.length / 2)]!;
}

/** The interline Audiveris measured, from its "too low interline value of N pixels" warning. */
export function reportedInterline(log: string): number | null {
  const m = /interline value of (\d+(?:\.\d+)?) pixels/i.exec(log);
  return m ? Number(m[1]) : null;
}

export interface OmrImage {
  png: Buffer;
  /** Staff-line spacing in the original image, if known. */
  interline: number | null;
  /** How much the original was scaled. */
  scale: number;
}

/**
 * Prepare an image for Audiveris: auto-orient, flatten, grayscale, and scale it so the staff
 * lines are TARGET_INTERLINE px apart. Small images are also sharpened and turned black and white.
 * Pass `interline` to skip measuring (e.g. when Audiveris told us). Without a measurement, falls
 * back to scaling the long edge to about 2400 px.
 */
export async function omrImage(buf: Buffer, interline?: number | null): Promise<OmrImage> {
  const meta = await sharp(buf).rotate().metadata();
  const width = meta.width ?? 0;
  const longEdge = Math.max(width, meta.height ?? 0);
  const il = interline ?? (await estimateInterline(buf).catch(() => null));
  // Default sizing (long edge up to ~2400 px) was tuned on our fixtures; keep it whenever it
  // already gives a comfortable spacing, otherwise size by the measured spacing.
  let scale = longEdge > 0 && longEdge < 2400 ? Math.min(2, 2400 / longEdge) : 1;
  if (il && (il * scale < 14 || il * scale > 32)) scale = Math.min(6, Math.max(0.4, TARGET_INTERLINE / il));
  if (longEdge * scale > MAX_LONG_EDGE) scale = MAX_LONG_EDGE / longEdge;
  let img = sharp(buf).rotate().flatten({ background: "#ffffff" }).grayscale();
  const small = il !== null && il < THRESHOLD_BELOW_INTERLINE;
  if (small) img = img.normalise();
  if (Math.abs(scale - 1) > 0.05 && width > 0) img = img.resize({ width: Math.round(width * scale), kernel: "lanczos3" });
  if (small) img = sharp(await img.sharpen({ sigma: 1 }).png().toBuffer()).threshold(170);
  return { png: await img.png().toBuffer(), interline: il, scale };
}

/**
 * Last attempt when no staff spacing is known: stretch contrast, sharpen, scale the long edge
 * to about 3200 px, and convert to black and white.
 */
export async function omrImageEnhanced(buf: Buffer): Promise<Buffer> {
  const meta = await sharp(buf).rotate().metadata();
  const longEdge = Math.max(meta.width ?? 0, meta.height ?? 0);
  const scale = longEdge > 0 ? Math.min(4, Math.max(0.5, 3200 / longEdge)) : 1;
  let img = sharp(buf).rotate().flatten({ background: "#ffffff" }).grayscale().normalise();
  if (Math.abs(scale - 1) > 0.05) img = img.resize({ width: Math.round((meta.width ?? 0) * scale), kernel: "lanczos3" });
  const sharpened = await img.sharpen({ sigma: 1 }).png().toBuffer();
  return sharp(sharpened).threshold(170).png().toBuffer();
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

  convert(input: PreparedInput, onProgress?: ProgressFn): Promise<EngineResult> {
    onProgress?.(0, "Waiting for Audiveris");
    const job = this.queue.then(() => this.convertNow(input, onProgress));
    this.queue = job.catch(() => undefined);
    return job;
  }

  private async convertNow(input: PreparedInput, onProgress?: ProgressFn): Promise<EngineResult> {
    if (!this.isAvailable()) {
      throw new EngineError("engine_unavailable", `Audiveris is not installed (looked for ${this.bin}); run scripts/install-audiveris.sh`);
    }
    const dir = await mkdtemp(join(tmpdir(), "jc-audiveris-"));
    try {
      const out = join(dir, "out");
      let inFile: string;
      let prepared: OmrImage | null = null;
      if (input.kind === "pdf") {
        inFile = join(dir, "score.pdf");
        await writeFile(inFile, input.original);
      } else {
        inFile = join(dir, "score.png");
        onProgress?.(0, "Measuring the staff lines");
        prepared = await omrImage(input.original);
        await writeFile(inFile, prepared.png);
      }
      // First pass: 0–100%, or 0–50% if a retry follows.
      let span = 100;
      let base = 0;
      const progress = new AudiverisProgress((p, stage) => onProgress?.(base + (p * span) / 100, stage));
      let res = await this.runner(this.bin, audiverisArgs(out, inFile), this.timeoutMs, (l) => progress.line(l));
      let mxls = await findFiles(dir, /\.mxl$/i).catch(() => [] as string[]);
      let log = res.stdout + "\n" + res.stderr;
      if (mxls.length === 0 && prepared && shouldRetryEnhanced(log)) {
        base = 50;
        span = 50;
        await rm(out, { recursive: true, force: true });
        // If Audiveris measured the spacing in what we sent, rescale exactly from that.
        const seen = reportedInterline(log);
        if (seen) {
          onProgress?.(50, "The staff lines were too small; enlarging the image and trying again");
          await writeFile(inFile, (await omrImage(input.original, seen / prepared.scale)).png);
        } else {
          onProgress?.(50, "Couldn't find the staff; trying again with a cleaned-up image");
          await writeFile(inFile, await omrImageEnhanced(input.original));
        }
        res = await this.runner(this.bin, audiverisArgs(out, inFile), this.timeoutMs, (l) => progress.line(l));
        mxls = await findFiles(dir, /\.mxl$/i).catch(() => [] as string[]);
        log = res.stdout + "\n" + res.stderr;
      }
      if (mxls.length === 0) {
        const il = prepared?.interline;
        if (il && il < 3.5) {
          throw new EngineError(
            "recognition_failed",
            `This image is too small to read: its staff lines are only about ${il.toFixed(1)} pixels apart. ` +
              "Take the screenshot zoomed in further (staff lines at least 4–5 px apart, ideally 8+), or upload the original PDF.",
          );
        }
        throw new EngineError("recognition_failed", explainAudiverisFailure(log, res.code));
      }
      // One .mxl per movement (book.mvt1.mxl, ...). Lead sheets are a single movement.
      const xml = normalizeAudiverisXml(unzipMxl(await readFile(mxls[0]!)));
      const warnings = validateMusicXML(xml);
      warnings.push(...unreadChordWarnings(xml), ...rehearsalWarnings(xml));
      const dropped = droppedChordNames(res.stdout + "\n" + res.stderr);
      if (dropped.length) {
        warnings.push({
          measure: null,
          code: "other",
          message: `Audiveris dropped chord symbol${dropped.length > 1 ? "s" : ""} ${dropped.join(", ")}: they had no note under them (slash bars, chords on rests or held notes). Add them with the chord editor.`,
        });
      }
      if (mxls.length > 1) {
        warnings.push({ measure: null, code: "other", message: `Audiveris split the score into ${mxls.length} movements; only the first is returned.` });
      }
      return { musicxml: xml, model: null, warnings };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

/**
 * Chord names Audiveris read but did not export: a ChordNameInter must attach to a note/rest chord
 * starting under it, otherwise it is removed with "No chord below ChordNameInter#… TEXT "C7" …".
 * Single letters are skipped (usually a rehearsal mark read as a chord).
 */
export function droppedChordNames(log: string): string[] {
  const out: string[] = [];
  for (const m of log.matchAll(/No chord below ChordNameInter#\d+\{[^}\n]*?TEXT "([^"]+)"/g)) {
    if (m[1]!.length > 1) out.push(m[1]!);
  }
  return out;
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
 * Undo Tesseract's readings of a small ♭ right after the root ("Bl>maj7", "BI>7#11", "BLm7", "B|>7").
 * Returns the repaired symbol only when it parses as a chord and the original doesn't.
 */
export function repairOcrChord(text: string): string | null {
  const t = text.trim();
  if (parseChordSymbol(t).ok) return null;
  const m = /^([A-G])(?:[lI|1L]>|>|[lIL|](?=[a-z0-9#+°ø\/]|$))(.*)$/.exec(t);
  if (!m) return null;
  const fixed = `${m[1]}b${m[2]}`;
  const r = parseChordSymbol(fixed);
  return r.ok && r.chord.root ? fixed : null;
}

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
      const raw = unescapeXml(words).trim();
      const textValue = repairOcrChord(raw) ?? raw;
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

const escapeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const attrNum = (tag: string, name: string): number | null => {
  const m = new RegExp(`\\b${name}="(-?[\\d.]+)"`).exec(tag);
  return m ? Number(m[1]) : null;
};
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : NaN;
};
/** Direction words that are never a title, even when printed large. */
const NOT_A_TITLE = /^(fine|coda|to coda|d\.?\s?[cs]\.?.*|segno|swing|ballad|bossa.*|latin|medium.*|up tempo|fast|slow(ly)?|rit\.?.*|rall\.?.*|a tempo|solos?.*|intro|vamp.*|tacet|n\.?\s?c\.?)$/i;

/**
 * Give the score a <work-title> when Audiveris found the title but did not put it there:
 * - it wrote <movement-title> (role Title): move it into <work><work-title> and mark the credit as the title;
 * - it read a title printed close to the music as a <words> direction in the first system: when that text is
 *   much larger than the chord symbols, roughly centred on the page and not a known direction, move it
 *   to <work-title> and remove the direction.
 */
export function promoteTitle(xml: string): string {
  if (/<work-title>\s*[^<\s]/.test(xml)) return xml;
  const mt = /<movement-title>([^<]*)<\/movement-title>/.exec(xml)?.[1]?.trim();
  // OSMD prints <movement-title> as a subtitle when there is a <work-title>, so move it rather than copy it.
  if (mt) return setWorkTitle(xml.replace(/\s*<movement-title>[^<]*<\/movement-title>/, ""), unescapeXml(mt));

  const partStart = xml.indexOf("<part id=");
  if (partStart < 0) return xml;
  // First system: from the first measure up to the first measure that starts a new system/page.
  const measures = [...xml.slice(partStart).matchAll(/<measure\b[^>]*>[\s\S]*?<\/measure>/g)];
  const firstSystem: { text: string; index: number; width: number }[] = [];
  for (const [i, m] of measures.entries()) {
    if (i > 0 && /<print\b[^>]*new-(system|page)="yes"/.test(m[0])) break;
    firstSystem.push({ text: m[0], index: partStart + m.index!, width: attrNum(/<measure\b[^>]*>/.exec(m[0])![0], "width") ?? 0 });
  }
  const chordSizes = [...xml.matchAll(/<harmony\b[^>]*font-size="([\d.]+)"/g)].map((m) => Number(m[1]));
  const chordSize = chordSizes.length ? median(chordSizes) : 10;
  const pageWidth = Number(/<page-width>([\d.]+)<\/page-width>/.exec(xml)?.[1] ?? NaN);
  const pageLeft = Number(/<page-margins[\s\S]*?<left-margin>([\d.]+)<\/left-margin>/.exec(xml)?.[1] ?? 0);
  const sysLeft = Number(/<system-margins>\s*<left-margin>([\d.]+)<\/left-margin>/.exec(firstSystem[0]?.text ?? "")?.[1] ?? 0);
  // Tenths per point, from <scaling> (millimeters per 40 tenths).
  const mm = Number(/<millimeters>([\d.]+)<\/millimeters>/.exec(xml)?.[1] ?? NaN);
  const tenths = Number(/<tenths>([\d.]+)<\/tenths>/.exec(xml)?.[1] ?? 40);
  const tenthsPerPt = Number.isFinite(mm) && mm > 0 ? (25.4 / 72) * (tenths / mm) : 2;

  let x0 = pageLeft + sysLeft;
  for (const m of firstSystem) {
    const re = /<direction\b[^>]*>\s*<direction-type>\s*(<words\b[^>]*>)([^<]+)<\/words>\s*<\/direction-type>[\s\S]*?<\/direction>\s*/g;
    for (const d of m.text.matchAll(re)) {
      const text = unescapeXml(d[2]!).trim();
      const size = attrNum(d[1]!, "font-size");
      if (!size || size < chordSize * 1.2 || !/[a-z]{2}/i.test(text) || NOT_A_TITLE.test(text)) continue;
      if (parseChordSymbol(text).ok || repairOcrChord(text)) continue;
      if (Number.isFinite(pageWidth)) {
        // Anchor: the next note's default-x in this measure, plus the words' relative-x.
        const after = m.text.slice(d.index! + d[0].length);
        const noteX = attrNum(/<note\b[^>]*>/.exec(after)?.[0] ?? "", "default-x") ?? 0;
        const left = x0 + noteX + (attrNum(d[1]!, "relative-x") ?? 0) + (attrNum(d[1]!, "default-x") ?? 0);
        const centre = left + (text.length * size * 0.5 * tenthsPerPt) / 2;
        if (Math.abs(centre - pageWidth / 2) > pageWidth * 0.2) continue;
      }
      const measure = m.text.slice(0, d.index!) + m.text.slice(d.index! + d[0].length);
      const out = xml.slice(0, m.index) + measure + xml.slice(m.index + m.text.length);
      return setWorkTitle(out, text);
    }
    x0 += m.width;
  }
  return xml;
}

function setWorkTitle(xml: string, title: string): string {
  const t = escapeXml(title);
  // Schema order: work, movement-number, movement-title, identification, defaults, credit*, part-list.
  let out = xml.replace(/<work>\s*<\/work>|<work\/>/, "");
  if (/<work>/.test(out)) out = out.replace(/<work>/, `<work><work-title>${t}</work-title>`);
  else out = out.replace(/(<score-partwise\b[^>]*>)/, `$1\n  <work><work-title>${t}</work-title></work>`);
  // Mark the credit that prints this text as the title (OSMD and MuseScore use it), or add one.
  let marked = false;
  out = out.replace(/<credit(\s[^>]*)?>(\s*)(?!<credit-type>)(<credit-words\b[^>]*>)([^<]*)<\/credit-words>/g, (whole, a = "", sp, cw, txt) => {
    if (marked || unescapeXml(txt).trim() !== title) return whole;
    marked = true;
    return `<credit${a}>${sp}<credit-type>title</credit-type>${sp}${cw}${txt}</credit-words>`;
  });
  // No credit is added when there is none: <work-title> is what OSMD and MuseScore print, and OSMD would
  // print an extra centred credit as a subtitle too.
  return out;
}

/**
 * <words> left in the chord row that look like a misread chord symbol ("vaaj7" for B♭maj7): one token with
 * a digit, the same size as the chord symbols, that neither parses nor can be repaired.
 */
export function unreadChordWarnings(xml: string): Warning[] {
  const harmonies = [...xml.matchAll(/<harmony\b[^>]*>/g)].map((m) => m[0]);
  if (!harmonies.length) return [];
  const rowY = median(harmonies.map((h) => attrNum(h, "default-y")).filter((y): y is number => y !== null));
  const chordSize = median(harmonies.map((h) => attrNum(h, "font-size")).filter((y): y is number => y !== null));
  // In the chord row: within 1 staff space (10 tenths) of the chord symbols' default-y, or, without
  // positions, the same font size (OCR font sizes are unreliable: "vaaj7" came out at 12pt among 9pt chords).
  const inChordRow = (attrs: string) => {
    const y = attrNum(attrs, "default-y");
    if (y !== null && Number.isFinite(rowY)) return Math.abs(y - rowY) <= 10;
    const size = attrNum(attrs, "font-size");
    return size !== null && Number.isFinite(chordSize) && Math.abs(size - chordSize) <= chordSize * 0.2;
  };
  const out: Warning[] = [];
  for (const m of xml.matchAll(/<measure\b[^>]*\bnumber="([^"]*)"[^>]*>([\s\S]*?)<\/measure>/g)) {
    for (const w of m[2]!.matchAll(/<words\b([^>]*)>([^<]+)<\/words>/g)) {
      const text = unescapeXml(w[2]!).trim();
      if (!/^[A-Za-z]\S*\d\S*$/.test(text) || !inChordRow(w[1]!)) continue;
      if (parseChordSymbol(text).ok || repairOcrChord(text)) continue;
      const n = Number.parseInt(m[1]!, 10);
      out.push({
        measure: Number.isNaN(n) ? null : n,
        code: "unparsed_chord",
        message: `"${text}" looks like a chord symbol that was misread; check this bar's chords.`,
      });
    }
  }
  return out;
}

/**
 * Boxed rehearsal letters are OCR'd with the box (both "A" and "B" of the PNG fixture came out as "E").
 * Lead sheets start at "A"; when single-letter marks don't, say so instead of guessing the letters.
 */
export function rehearsalWarnings(xml: string): Warning[] {
  const marks: { measure: number | null; text: string }[] = [];
  for (const m of xml.matchAll(/<measure\b[^>]*\bnumber="([^"]*)"[^>]*>([\s\S]*?)<\/measure>/g)) {
    for (const r of m[2]!.matchAll(/<rehearsal\b[^>]*>([^<]*)<\/rehearsal>/g)) {
      const n = Number.parseInt(m[1]!, 10);
      marks.push({ measure: Number.isNaN(n) ? null : n, text: unescapeXml(r[1]!).trim() });
    }
  }
  if (!marks.length || !marks.every((r) => /^[A-Z]$/.test(r.text)) || marks[0]!.text === "A") return [];
  return [
    {
      measure: marks[0]!.measure,
      code: "low_confidence",
      message: `Rehearsal marks were read as ${marks.map((r) => r.text).join(", ")}; boxed letters are often misread. Check them.`,
    },
  ];
}

/** Make sure we hand out an uncompressed score-partwise string labelled 4.0. */
export function normalizeAudiverisXml(xml: string): string {
  if (!/<score-partwise[\s>]/.test(xml)) {
    throw new EngineError("recognition_failed", "Audiveris output is not a score-partwise document");
  }
  const out = xml
    .replace(/<score-partwise([^>]*?)version="[^"]*"/, '<score-partwise$1version="4.0"')
    .replace(/(-\/\/Recordare\/\/DTD MusicXML) 4\.0\.\d+ (Partwise)/, "$1 4.0 $2")
    // Audiveris records the input path (our temp dir) in the file; don't hand it out.
    .replace(/\s*<source>[^<]*<\/source>/, "")
    .replace(/\s*<miscellaneous-field name="source-file">[^<]*<\/miscellaneous-field>/, "");
  return promoteTitle(fixAudiverisHarmonies(out));
}
