import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import type { LeadSheet, LeadSheetMeasure } from "../../shared/types.js";
import { ClaudeEngine, DEFAULT_MODEL, mergePages, SHEET_SCHEMA, type ClaudeClient } from "../src/engines/claude.js";
import { EngineError } from "../src/engines/types.js";
import type { PreparedInput } from "../src/pipeline/pages.js";
import { sampleSheet, validateXsd } from "./helpers.js";

type Params = Parameters<ClaudeClient["beta"]["messages"]["stream"]>[0];

/** Raw (schema-shaped) measure as the model returns it: every field present, nulls for absent. */
function raw(m: LeadSheetMeasure, uncertain = false) {
  return {
    number: m.number,
    implicit: !!m.implicit,
    slash: !!m.slash,
    barlineLeft: m.barlineLeft ?? null,
    barlineRight: m.barlineRight ?? null,
    ending: m.ending ?? null,
    rehearsal: m.rehearsal ?? null,
    navigation: m.navigation ?? null,
    chords: m.chords,
    notes: m.notes.map((n) => ({
      pitch: n.pitch ?? null,
      rest: !!n.rest,
      duration: n.duration,
      dots: n.dots ?? 0,
      tie: n.tie ?? null,
      tuplet: n.tuplet ?? null,
    })),
    uncertain,
  };
}

function rawSheet(s: LeadSheet, measures = s.measures) {
  return { title: s.title, composer: s.composer ?? null, key: s.key, time: s.time, clef: s.clef, measures: measures.map((m) => raw(m)) };
}

function message(text: string, stop_reason = "end_turn") {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: DEFAULT_MODEL,
    content: [
      { type: "thinking", thinking: "", signature: "x" },
      { type: "text", text, citations: null },
    ],
    stop_reason,
    stop_sequence: null,
    stop_details: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  } as unknown as Anthropic.Beta.Messages.BetaMessage;
}

/** Fake SDK client: answers each request with the next queued response and records the params. */
function fakeClient(responses: (object | (() => never) | { stop: string })[]) {
  const calls: Params[] = [];
  const client: ClaudeClient = {
    beta: {
      messages: {
        stream(params: Params) {
          calls.push(params);
          const r = responses.shift();
          return {
            finalMessage: async () => {
              if (r === undefined) throw new Error("unexpected extra request");
              if (typeof r === "function") return r();
              if ("stop" in r) return message("", (r as { stop: string }).stop);
              return message(JSON.stringify(r));
            },
          };
        },
      },
    },
  };
  return { client, calls };
}

const png = Buffer.from("89504e470d0a1a0a", "hex");
const input = (pages = 1): PreparedInput => ({
  kind: pages > 1 ? "pdf" : "image",
  mime: pages > 1 ? "application/pdf" : "image/png",
  original: png,
  pages: Array.from({ length: pages }, () => png),
  totalPages: pages,
});

describe("ClaudeEngine (mocked SDK client)", () => {
  it("is unavailable without ANTHROPIC_API_KEY", () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      expect(new ClaudeEngine().isAvailable()).toBe(false);
      process.env.ANTHROPIC_API_KEY = "sk-test";
      expect(new ClaudeEngine().isAvailable()).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  });

  it("transcribes one page into a LeadSheet and code-built MusicXML", async () => {
    const s = sampleSheet();
    const { client, calls } = fakeClient([rawSheet(s)]);
    const res = await new ClaudeEngine({ client }).convert(input());

    expect(calls).toHaveLength(1);
    const p = calls[0]!;
    expect(p.model).toBe(DEFAULT_MODEL);
    expect(p.thinking).toEqual({ type: "adaptive" });
    expect(p.output_config?.format).toEqual({ type: "json_schema", schema: SHEET_SCHEMA });
    expect(p.fallbacks).toBe("default");
    expect(p.betas).toContain("server-side-fallback-2026-07-01");
    expect(p.tool_choice).toBeUndefined(); // forced tool use is a 400 on Opus 5.5
    const content = p.messages[0]!.content as Anthropic.Beta.Messages.BetaContentBlockParam[];
    expect(content[0]).toMatchObject({ type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } });

    expect(res.model).toEqual(s);
    expect(res.warnings).toEqual([]);
    expect(validateXsd(res.musicxml).ok).toBe(true);
  });

  it("joins measures across pages and renumbers them", async () => {
    const s = sampleSheet();
    const first = s.measures.slice(0, 9);
    const second = s.measures.slice(9).map((m, i) => ({ ...m, number: i + 1 })); // page-local numbering
    const { client, calls } = fakeClient([rawSheet(s, first), { ...rawSheet(s, second), title: "" }]);
    const res = await new ClaudeEngine({ client }).convert(input(2));
    expect(calls).toHaveLength(2);
    expect((calls[1]!.messages[0]!.content as { type: string; text?: string }[])[1]!.text).toMatch(/page 2 of 2/);
    expect(res.model!.title).toBe("Blue Lantern");
    expect(res.model!.measures.map((m) => m.number)).toEqual(s.measures.map((m) => m.number));
    expect(res.model).toEqual(s);
    expect(res.warnings).toEqual([]);
  });

  it("drops a bogus 'pickup' flag at the top of page 2", () => {
    const s = sampleSheet();
    const p2 = [{ ...s.measures[5]!, implicit: true }, s.measures[6]!];
    const merged = mergePages([rawSheet(s, s.measures.slice(0, 5)) as never, rawSheet(s, p2) as never]);
    expect(merged.sheet.measures[5]!.implicit).toBeUndefined();
    expect(merged.pageOf).toEqual([0, 0, 0, 0, 0, 1, 1]);
    expect(merged.sheet.measures.map((m) => m.number)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("repairs measures that fail validation, once, and only those measures", async () => {
    const s = sampleSheet();
    const broken = structuredClone(s);
    broken.measures[2]!.notes.pop(); // measure 2 now 3 beats → duration_mismatch
    broken.measures[5]!.chords[0]!.symbol = "Fmaj7?!"; // unparsed chord in measure 5
    const fixed = { measures: [raw(s.measures[2]!), raw(s.measures[5]!), raw({ ...s.measures[7]!, notes: [] })] };
    const { client, calls } = fakeClient([rawSheet(broken), fixed]);
    const res = await new ClaudeEngine({ client }).convert(input());

    expect(calls).toHaveLength(2);
    const repairText = (calls[1]!.messages[0]!.content as { type: string; text?: string }[])[1]!.text!;
    expect(repairText).toMatch(/Measure 2: duration_mismatch/);
    expect(repairText).toMatch(/Measure 5: unparsed_chord/);
    expect(repairText).toMatch(/ONLY measures 2, 5/);
    expect(calls[1]!.output_config?.format?.type).toBe("json_schema");
    expect(res.warnings).toEqual([]);
    // measure 7 was not asked for, so the stray correction is ignored
    expect(res.model).toEqual(s);
  });

  it("gives up after one repair round and returns the warnings", async () => {
    const s = sampleSheet();
    const broken = structuredClone(s);
    broken.measures[2]!.notes.pop();
    const { client, calls } = fakeClient([rawSheet(broken), { measures: [raw(broken.measures[2]!)] }]);
    const res = await new ClaudeEngine({ client }).convert(input());
    expect(calls).toHaveLength(2);
    expect(res.warnings.map((w) => `${w.code}@${w.measure}`)).toEqual(["duration_mismatch@2"]);
    expect(validateXsd(res.musicxml).ok).toBe(true);
  });

  it("keeps the first transcription when the repair request fails", async () => {
    const s = sampleSheet();
    const broken = structuredClone(s);
    broken.measures[2]!.notes.pop();
    const { client } = fakeClient([rawSheet(broken), () => { throw new Error("boom"); }]);
    const res = await new ClaudeEngine({ client }).convert(input());
    expect(res.warnings.map((w) => w.code)).toEqual(["duration_mismatch"]);
  });

  it("reports uncertain measures as low_confidence", async () => {
    const s = sampleSheet();
    const r = rawSheet(s);
    r.measures[3]!.uncertain = true;
    const { client } = fakeClient([r]);
    const res = await new ClaudeEngine({ client }).convert(input());
    expect(res.warnings).toEqual([{ measure: 3, code: "low_confidence", message: expect.any(String) }]);
  });

  it("maps refusals, truncation, bad JSON and API errors to EngineError", async () => {
    const cases: [object | (() => never), string, RegExp][] = [
      [{ stop: "refusal" }, "recognition_failed", /declined/],
      [{ stop: "max_tokens" }, "recognition_failed", /cut off/],
      [
        () => {
          throw new Anthropic.AuthenticationError(401, { type: "error", error: { type: "authentication_error", message: "bad key" } }, "bad key", new Headers());
        },
        "engine_unavailable",
        /rejected/,
      ],
      [
        () => {
          throw new Anthropic.RateLimitError(429, { type: "error", error: { type: "rate_limit_error", message: "slow" } }, "slow", new Headers());
        },
        "recognition_failed",
        /rate limit/,
      ],
      [{ measures: "nope" }, "recognition_failed", /no measures/],
    ];
    for (const [resp, code, msg] of cases) {
      const { client } = fakeClient([resp]);
      const err = await new ClaudeEngine({ client }).convert(input()).catch((e) => e);
      expect(err).toBeInstanceOf(EngineError);
      expect(err.code).toBe(code);
      expect(err.message).toMatch(msg);
    }

    const bad: ClaudeClient = { beta: { messages: { stream: () => ({ finalMessage: async () => message("{not json") }) } } };
    await expect(new ClaudeEngine({ client: bad }).convert(input())).rejects.toMatchObject({ code: "recognition_failed", message: /invalid JSON/ });
  });

  it("the schema is strict-output friendly (all objects closed, all properties required)", () => {
    const walk = (node: unknown): void => {
      if (!node || typeof node !== "object") return;
      const n = node as Record<string, unknown>;
      if (n.type === "object") {
        expect(n.additionalProperties).toBe(false);
        expect([...(n.required as string[])].sort()).toEqual(Object.keys(n.properties as object).sort());
      }
      for (const v of Object.values(n)) walk(v);
    };
    walk(SHEET_SCHEMA);
    // no unsupported constraints
    expect(JSON.stringify(SHEET_SCHEMA)).not.toMatch(/minimum|maximum|minLength|maxLength|minItems/);
  });
});
