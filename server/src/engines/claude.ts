import Anthropic from "@anthropic-ai/sdk";
import type {
  DurationCode,
  LeadSheet,
  LeadSheetMeasure,
  LeadSheetNote,
  Warning,
} from "../../../shared/types.js";
import { buildMusicXML } from "../musicxml/builder.js";
import { validateLeadSheet } from "../musicxml/validate.js";
import type { PreparedInput } from "../pipeline/pages.js";
import { EngineError, type ConversionEngine, type EngineResult } from "./types.js";

export const DEFAULT_MODEL = "claude-opus-5-5";

type StreamParams = Parameters<Anthropic["beta"]["messages"]["stream"]>[0];
type BetaMessage = Anthropic.Beta.Messages.BetaMessage;
type ContentBlock = Anthropic.Beta.Messages.BetaContentBlockParam;

/** The slice of the SDK client this engine uses (lets tests inject a fake). */
export interface ClaudeClient {
  beta: { messages: { stream(params: StreamParams): { finalMessage(): Promise<BetaMessage> } } };
}

export interface ClaudeEngineOptions {
  client?: ClaudeClient;
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  maxTokens?: number;
  /** Repair rounds for measures that fail validation (spec: max 1). */
  repairRounds?: number;
  concurrency?: number;
  /** Override availability (defaults to ANTHROPIC_API_KEY being set). */
  available?: boolean;
}

// ---------------------------------------------------------------------------
// JSON schema for structured output. All objects closed; nullable via anyOf.

const nullable = (s: object) => ({ anyOf: [s, { type: "null" }] });

const NOTE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["pitch", "rest", "duration", "dots", "tie", "tuplet"],
  properties: {
    pitch: nullable({ type: "string", description: 'Scientific pitch incl. key-signature accidentals, e.g. "Bb4". null for rests.' }),
    rest: { type: "boolean" },
    duration: { type: "string", enum: ["w", "h", "q", "8", "16", "32"] },
    dots: { type: "integer", description: "0, 1 or 2" },
    tie: nullable({ type: "string", enum: ["start", "stop", "both"] }),
    tuplet: nullable({
      type: "object",
      additionalProperties: false,
      required: ["actual", "normal"],
      properties: { actual: { type: "integer" }, normal: { type: "integer" } },
    }),
  },
};

const MEASURE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "number",
    "implicit",
    "slash",
    "barlineLeft",
    "barlineRight",
    "ending",
    "rehearsal",
    "navigation",
    "chords",
    "notes",
    "uncertain",
  ],
  properties: {
    number: { type: "integer" },
    implicit: { type: "boolean", description: "true only for an incomplete pickup measure" },
    slash: { type: "boolean", description: "rhythm slashes instead of melody" },
    barlineLeft: nullable({ type: "string", enum: ["repeat-forward"] }),
    barlineRight: nullable({ type: "string", enum: ["repeat-backward", "final", "double"] }),
    ending: nullable({
      type: "object",
      additionalProperties: false,
      required: ["number", "type"],
      properties: { number: { type: "string" }, type: { type: "string", enum: ["start", "stop", "discontinue"] } },
    }),
    rehearsal: nullable({ type: "string" }),
    navigation: nullable({
      type: "string",
      enum: ["segno", "coda", "D.S. al Coda", "D.C. al Fine", "Fine", "To Coda"],
    }),
    chords: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["beat", "symbol"],
        properties: { beat: { type: "number" }, symbol: { type: "string" } },
      },
    },
    notes: { type: "array", items: NOTE_SCHEMA },
    uncertain: { type: "boolean", description: "true if this measure was hard to read" },
  },
};

export const SHEET_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "composer", "key", "time", "clef", "measures"],
  properties: {
    title: { type: "string" },
    composer: nullable({ type: "string" }),
    key: {
      type: "object",
      additionalProperties: false,
      required: ["fifths", "mode"],
      properties: { fifths: { type: "integer" }, mode: { type: "string", enum: ["major", "minor"] } },
    },
    time: {
      type: "object",
      additionalProperties: false,
      required: ["beats", "beatType"],
      properties: { beats: { type: "integer" }, beatType: { type: "integer" } },
    },
    clef: { type: "string", enum: ["treble", "bass"] },
    measures: { type: "array", items: MEASURE_SCHEMA },
  },
};

export const REPAIR_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["measures"],
  properties: { measures: { type: "array", items: MEASURE_SCHEMA } },
};

export const SYSTEM_PROMPT = `You transcribe jazz lead sheets (melody + chord symbols, Real Book style) from images into JSON.

Rules:
- Transcribe exactly what is written. Do not correct or "improve" the harmony or melody.
- Chord symbols as plain text as printed, e.g. "Cm7b5", "C-7", "CΔ7", "F7#9", "Bb7alt", "C6/9", "Ebmaj7/G", "C7sus4", "N.C.".
- chords[].beat is the 1-based beat the chord starts on (may be fractional, e.g. 2.5). In 4/4 two chords per bar are usually beats 1 and 3.
- Pitches in scientific notation, middle C = C4. Write the sounding written pitch INCLUDING accidentals from the key signature and earlier accidentals in the same measure (in F major, a note on the middle line B is "Bb4").
- Durations: w h q 8 16 32; dots 0–2; triplets as tuplet {"actual":3,"normal":2} on each note of the group.
- Each measure's note durations must add up to the time signature, unless it is a pickup measure (set implicit: true).
- Slash notation (rhythm slashes) or an empty bar with only chords: notes = [] and slash: true for slashes.
- A tie connecting two notes: "start" on the first, "stop" on the second ("both" for a middle note).
- Repeats: barlineLeft "repeat-forward" / barlineRight "repeat-backward". Endings: ending {"number":"1","type":"start"} on the first bar of the ending and {"type":"stop"} (or "discontinue" for a last ending with no repeat) on its last bar; a one-bar ending gets "start" and its repeat-backward barline.
- Rehearsal marks (A, B, Intro...) in rehearsal; segno / coda / D.S. al Coda / D.C. al Fine / Fine / To Coda in navigation.
- Number measures in reading order starting at 1 (0 for a pickup). Mark measures you could not read with confidence as uncertain: true instead of guessing silently.`;

// ---------------------------------------------------------------------------
// Raw model output → LeadSheet

interface RawNote {
  pitch: string | null;
  rest: boolean;
  duration: DurationCode;
  dots: number;
  tie: "start" | "stop" | "both" | null;
  tuplet: { actual: number; normal: number } | null;
}
interface RawMeasure extends Omit<LeadSheetMeasure, "notes"> {
  notes: RawNote[];
  uncertain?: boolean;
}
interface RawSheet extends Omit<LeadSheet, "measures" | "composer"> {
  composer: string | null;
  measures: RawMeasure[];
}

function cleanNote(n: RawNote): LeadSheetNote {
  const out: LeadSheetNote = { duration: n.duration };
  if (n.rest || !n.pitch) out.rest = true;
  else out.pitch = n.pitch;
  if (n.dots) out.dots = Math.max(0, Math.min(2, n.dots));
  if (n.tie && !out.rest) out.tie = n.tie;
  if (n.tuplet) out.tuplet = n.tuplet;
  return out;
}

function cleanMeasure(m: RawMeasure): { measure: LeadSheetMeasure; uncertain: boolean } {
  const measure: LeadSheetMeasure = {
    number: m.number,
    chords: (m.chords ?? []).map((c) => ({ beat: Number(c.beat) || 1, symbol: String(c.symbol).trim() })).filter((c) => c.symbol),
    notes: (m.notes ?? []).map(cleanNote),
  };
  if (m.implicit) measure.implicit = true;
  if (m.slash) measure.slash = true;
  if (m.barlineLeft) measure.barlineLeft = m.barlineLeft;
  if (m.barlineRight) measure.barlineRight = m.barlineRight;
  if (m.ending) measure.ending = m.ending;
  if (m.rehearsal) measure.rehearsal = m.rehearsal;
  if (m.navigation) measure.navigation = m.navigation;
  return { measure, uncertain: !!m.uncertain };
}

export interface MergedSheet {
  sheet: LeadSheet;
  /** 0-based page index of each measure (parallel to sheet.measures). */
  pageOf: number[];
  uncertain: Set<number>;
}

/**
 * Join per-page transcriptions into one LeadSheet. Header (title, key, time,
 * clef) comes from page 1. Measures are renumbered sequentially across pages:
 * a leading pickup is 0, everything else counts from 1. A pickup flag on a
 * later page's first measure is dropped (it's a page break, not a pickup).
 */
export function mergePages(pages: RawSheet[]): MergedSheet {
  if (pages.length === 0) throw new EngineError("recognition_failed", "No pages transcribed");
  const first = pages[0]!;
  const measures: LeadSheetMeasure[] = [];
  const pageOf: number[] = [];
  const uncertain = new Set<number>();
  pages.forEach((p, pi) => {
    p.measures.forEach((rm, mi) => {
      const { measure, uncertain: u } = cleanMeasure(rm);
      if (measure.implicit && !(pi === 0 && mi === 0) && !(pi === pages.length - 1 && mi === p.measures.length - 1)) {
        delete measure.implicit;
      }
      measures.push(measure);
      pageOf.push(pi);
      if (u) uncertain.add(measures.length - 1);
    });
  });
  let n = measures[0]?.implicit ? 0 : 1;
  for (const m of measures) m.number = n++;
  const sheet: LeadSheet = {
    title: first.title?.trim() || "Untitled",
    key: { fifths: Math.max(-7, Math.min(7, first.key?.fifths ?? 0)), mode: first.key?.mode === "minor" ? "minor" : "major" },
    time: { beats: first.time?.beats || 4, beatType: first.time?.beatType || 4 },
    clef: first.clef === "bass" ? "bass" : "treble",
    measures,
  };
  if (first.composer) sheet.composer = first.composer;
  return { sheet, pageOf, uncertain: new Set([...uncertain].map((i) => measures[i]!.number)) };
}

const REPAIRABLE = new Set<Warning["code"]>(["duration_mismatch", "unparsed_chord", "other"]);

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}

// ---------------------------------------------------------------------------

export class ClaudeEngine implements ConversionEngine {
  readonly name = "claude" as const;
  private clientInstance?: ClaudeClient;
  private readonly model: string;
  private readonly effort: NonNullable<ClaudeEngineOptions["effort"]>;
  private readonly maxTokens: number;
  private readonly repairRounds: number;
  private readonly concurrency: number;

  constructor(private readonly opts: ClaudeEngineOptions = {}) {
    this.clientInstance = opts.client;
    this.model = opts.model ?? process.env.CLAUDE_MODEL ?? DEFAULT_MODEL;
    this.effort = opts.effort ?? (process.env.CLAUDE_EFFORT as ClaudeEngineOptions["effort"]) ?? "high";
    this.maxTokens = opts.maxTokens ?? 64000;
    this.repairRounds = Math.min(1, opts.repairRounds ?? 1);
    this.concurrency = opts.concurrency ?? 3;
  }

  isAvailable(): boolean {
    return this.opts.available ?? Boolean(process.env.ANTHROPIC_API_KEY);
  }

  private get client(): ClaudeClient {
    // Created lazily so the server starts without a key.
    this.clientInstance ??= new Anthropic();
    return this.clientInstance;
  }

  /** One structured-output request; returns the parsed JSON. */
  private async ask<T>(content: ContentBlock[], schema: object): Promise<T> {
    let msg: BetaMessage;
    try {
      msg = await this.client.beta.messages
        .stream({
          model: this.model,
          max_tokens: this.maxTokens,
          system: SYSTEM_PROMPT,
          thinking: { type: "adaptive" },
          output_config: { effort: this.effort, format: { type: "json_schema", schema: schema as Record<string, unknown> } },
          // Server-side fallback if the model declines for policy reasons.
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          messages: [{ role: "user", content }],
        })
        .finalMessage();
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) {
        throw new EngineError("engine_unavailable", "Anthropic API key was rejected");
      }
      if (e instanceof Anthropic.RateLimitError) {
        throw new EngineError("recognition_failed", "Claude API rate limit reached; try again shortly");
      }
      if (e instanceof Anthropic.APIError) {
        throw new EngineError("recognition_failed", `Claude API error ${e.status ?? ""}: ${e.message}`);
      }
      throw new EngineError("recognition_failed", `Claude request failed: ${(e as Error).message}`);
    }
    if (msg.stop_reason === "refusal") {
      throw new EngineError("recognition_failed", "The model declined to transcribe this image");
    }
    if (msg.stop_reason === "max_tokens") {
      throw new EngineError("recognition_failed", "Transcription was cut off (output too long)");
    }
    const text = msg.content
      .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new EngineError("recognition_failed", "Model returned invalid JSON");
    }
  }

  private image(png: Buffer): ContentBlock {
    return { type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } };
  }

  private async transcribePage(png: Buffer, index: number, total: number): Promise<RawSheet> {
    const where =
      total === 1
        ? "Transcribe this lead sheet."
        : `This is page ${index + 1} of ${total} of one lead sheet. Transcribe only the measures on this page, in order.` +
          (index > 0 ? " Measures continue from the previous page; repeat the header fields (title may be blank) as best you can see them." : "");
    const raw = await this.ask<RawSheet>([this.image(png), { type: "text", text: where }], SHEET_SCHEMA);
    if (!Array.isArray(raw?.measures)) throw new EngineError("recognition_failed", "Model output has no measures");
    return raw;
  }

  async convert(input: PreparedInput): Promise<EngineResult> {
    if (!this.isAvailable() && !this.opts.client) {
      throw new EngineError("engine_unavailable", "ANTHROPIC_API_KEY is not set");
    }
    const pages = await mapLimit(input.pages, this.concurrency, (png, i) => this.transcribePage(png, i, input.pages.length));
    const merged = mergePages(pages);
    let warnings = validateLeadSheet(merged.sheet);

    for (let round = 0; round < this.repairRounds; round++) {
      const bad = new Map<number, string[]>();
      for (const w of warnings) {
        if (w.measure !== null && REPAIRABLE.has(w.code)) {
          bad.set(w.measure, [...(bad.get(w.measure) ?? []), `${w.code}: ${w.message}`]);
        }
      }
      if (bad.size === 0) break;
      await this.repair(merged, input.pages, bad);
      warnings = validateLeadSheet(merged.sheet);
    }

    for (const n of merged.uncertain) {
      warnings.push({ measure: n, code: "low_confidence", message: "The model was unsure about this measure." });
    }
    return { musicxml: buildMusicXML(merged.sheet), model: merged.sheet, warnings };
  }

  /** Re-ask for just the failing measures, one request per page that has any. Mutates `merged`. */
  private async repair(merged: MergedSheet, pageImages: Buffer[], bad: Map<number, string[]>): Promise<void> {
    const { sheet, pageOf } = merged;
    const byPage = new Map<number, number[]>();
    sheet.measures.forEach((m, i) => {
      if (bad.has(m.number)) byPage.set(pageOf[i]!, [...(byPage.get(pageOf[i]!) ?? []), m.number]);
    });
    await mapLimit([...byPage.entries()], this.concurrency, async ([page, numbers]) => {
      const pageMeasures = sheet.measures.filter((_, i) => pageOf[i] === page);
      const errors = numbers.map((n) => `Measure ${n}: ${bad.get(n)!.join("; ")}`).join("\n");
      const prompt =
        `Here is the image again, plus my JSON transcription of the measures on it (header: key fifths ${sheet.key.fifths}, ` +
        `time ${sheet.time.beats}/${sheet.time.beatType}, clef ${sheet.clef}).\n\n` +
        `${JSON.stringify(pageMeasures)}\n\nThese measures failed validation:\n${errors}\n\n` +
        `Look at the image again and return corrected versions of ONLY measures ${numbers.join(", ")}, keeping their measure numbers. ` +
        `If the image really shows what was transcribed, return it unchanged.`;
      let fixed: { measures: RawMeasure[] };
      try {
        fixed = await this.ask<{ measures: RawMeasure[] }>([this.image(pageImages[page]!), { type: "text", text: prompt }], REPAIR_SCHEMA);
      } catch {
        return; // keep the first transcription; its warnings stay
      }
      for (const rm of fixed.measures ?? []) {
        if (!numbers.includes(rm.number)) continue;
        const idx = sheet.measures.findIndex((m) => m.number === rm.number);
        if (idx < 0) continue;
        const { measure, uncertain } = cleanMeasure(rm);
        measure.number = rm.number;
        if (sheet.measures[idx]!.implicit) measure.implicit = true;
        sheet.measures[idx] = measure;
        if (uncertain) merged.uncertain.add(rm.number);
        else merged.uncertain.delete(rm.number);
      }
    });
  }
}
