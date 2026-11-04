import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ApiError, ConvertResponse, HealthResponse } from "../../shared/types.js";
import { buildApp, MAX_UPLOAD_BYTES, resolveEngine } from "../src/app.js";
import { ClaudeEngine } from "../src/engines/claude.js";
import { MockEngine } from "../src/engines/mock.js";
import { EngineError, type ConversionEngine } from "../src/engines/types.js";
import { fixture, multipart, validateXsd } from "./helpers.js";

/** Stub engine with controllable availability/behaviour. */
function stub(name: "claude" | "audiveris", available: boolean, impl?: ConversionEngine["convert"]): ConversionEngine {
  return {
    name,
    isAvailable: () => available,
    convert: impl ?? (async () => { throw new Error("not expected"); }),
  };
}

const offline = { claude: stub("claude", false), audiveris: stub("audiveris", false) };

describe("API", () => {
  const app = buildApp({ engines: offline });
  beforeAll(() => app.ready());
  afterAll(() => app.close());

  const convert = (fields: Record<string, string>, file?: Parameters<typeof multipart>[1]) => {
    const { payload, headers } = multipart(fields, file);
    return app.inject({ method: "POST", url: "/api/convert", payload, headers });
  };
  const png = { filename: "sheet.png", contentType: "image/png", data: fixture("sample-1.png") };
  const pdf = { filename: "sheet.pdf", contentType: "application/pdf", data: fixture("sample-1.pdf") };

  it("GET /api/health", async () => {
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json<HealthResponse>()).toEqual({ ok: true, engines: { claude: false, audiveris: false, mock: true } });
  });

  it("converts a PNG with the mock engine", async () => {
    const res = await convert({ engine: "mock" }, png);
    expect(res.statusCode).toBe(200);
    const body = res.json<ConvertResponse>();
    expect(body.engine).toBe("mock");
    expect(body.pages).toBe(1);
    expect(body.model?.title).toBe("Blue Lantern");
    expect(body.warnings).toEqual([]);
    expect(typeof body.elapsedMs).toBe("number");
    expect(validateXsd(body.musicxml).ok).toBe(true);
  });

  it("converts a 2-page PDF with the mock engine", async () => {
    const res = await convert({ engine: "mock" }, pdf);
    expect(res.statusCode).toBe(200);
    expect(res.json<ConvertResponse>().pages).toBe(2);
  });

  it("auto falls back to mock when nothing else is available", async () => {
    const res = await convert({}, png);
    expect(res.statusCode).toBe(200);
    expect(res.json<ConvertResponse>().engine).toBe("mock");
  });

  it("accepts the engine field after the file", async () => {
    const { payload, headers } = multipart({}, png);
    const tail = Buffer.from(payload.toString("latin1").replace(/--(\S+)--\r\n$/, (_m, b) => `--${b}\r\nContent-Disposition: form-data; name="engine"\r\n\r\nmock\r\n--${b}--\r\n`), "latin1");
    const res = await app.inject({ method: "POST", url: "/api/convert", payload: tail, headers });
    expect(res.statusCode).toBe(200);
  });

  it("sniffs content, ignoring the declared type and extension", async () => {
    // PNG bytes declared as PDF still work
    const ok = await convert({ engine: "mock" }, { filename: "x.pdf", contentType: "application/pdf", data: fixture("sample-1.png") });
    expect(ok.statusCode).toBe(200);
    // Text declared as PNG is rejected
    const bad = await convert({ engine: "mock" }, { filename: "x.png", contentType: "image/png", data: Buffer.from("hello, not an image") });
    expect(bad.statusCode).toBe(415);
    expect(bad.json<ApiError>().error.code).toBe("unsupported_type");
  });

  it("rejects GIF", async () => {
    const gif = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#000" } }).gif().toBuffer();
    const res = await convert({ engine: "mock" }, { filename: "x.gif", contentType: "image/gif", data: gif });
    expect(res.statusCode).toBe(415);
    expect(res.json<ApiError>().error.code).toBe("unsupported_type");
  });

  it("rejects files over 20 MB with file_too_large", async () => {
    const big = Buffer.concat([fixture("sample-1.png"), Buffer.alloc(MAX_UPLOAD_BYTES)]);
    const res = await convert({ engine: "mock" }, { filename: "big.png", contentType: "image/png", data: big });
    expect(res.statusCode).toBe(413);
    expect(res.json<ApiError>().error.code).toBe("file_too_large");
  });

  it("rejects a corrupt image that passes sniffing", async () => {
    const res = await convert({ engine: "mock" }, { filename: "x.png", contentType: "image/png", data: fixture("sample-1.png").subarray(0, 100) });
    expect(res.statusCode).toBe(415);
    expect(res.json<ApiError>().error.code).toBe("unsupported_type");
  });

  it("missing file / non-multipart", async () => {
    const res = await convert({ engine: "mock" });
    expect(res.statusCode).toBe(400);
    expect(res.json<ApiError>().error.code).toBe("unsupported_type");
    const json = await app.inject({ method: "POST", url: "/api/convert", payload: { a: 1 } });
    expect(json.statusCode).toBe(415);
    expect(json.json<ApiError>().error.code).toBe("unsupported_type");
  });

  it("unknown engine → 400; unavailable engine → 503 engine_unavailable", async () => {
    const unknown = await convert({ engine: "tesseract" }, png);
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json<ApiError>().error.code).toBe("engine_unavailable");
    for (const engine of ["claude", "audiveris"]) {
      const res = await convert({ engine }, png);
      expect(res.statusCode).toBe(503);
      expect(res.json<ApiError>().error).toMatchObject({ code: "engine_unavailable", message: expect.stringContaining(engine) });
    }
  });
});

describe("API engine selection and errors", () => {
  it("auto prefers claude, then audiveris, then mock", () => {
    const mock = new MockEngine();
    expect(resolveEngine("auto", { claude: stub("claude", true), audiveris: stub("audiveris", true), mock })?.name).toBe("claude");
    expect(resolveEngine("auto", { claude: stub("claude", false), audiveris: stub("audiveris", true), mock })?.name).toBe("audiveris");
    expect(resolveEngine("auto", { ...offline, mock })?.name).toBe("mock");
    expect(resolveEngine("claude", { ...offline, mock })).toBeNull();
  });

  it("maps engine errors to status codes", async () => {
    const cases: [EngineError | Error, number, string][] = [
      [new EngineError("recognition_failed", "nothing found"), 422, "recognition_failed"],
      [new EngineError("engine_unavailable", "key rejected"), 503, "engine_unavailable"],
      [new Error("kaboom"), 500, "internal"],
    ];
    for (const [err, status, code] of cases) {
      const app = buildApp({
        engines: { claude: stub("claude", true, async () => { throw err; }), audiveris: stub("audiveris", false) },
      });
      const { payload, headers } = multipart({}, { filename: "a.png", contentType: "image/png", data: fixture("sample-1.png") });
      const res = await app.inject({ method: "POST", url: "/api/convert", payload, headers });
      expect(res.statusCode).toBe(status);
      expect(res.json<ApiError>().error.code).toBe(code);
      if (code === "internal") expect(res.json<ApiError>().error.message).not.toContain("kaboom");
      await app.close();
    }
  });

  it("runs the Claude engine end to end with a mocked SDK client", async () => {
    const sheet = JSON.parse(fixture("sample-1.json").toString("utf8"));
    const rawSheet = {
      ...sheet,
      measures: sheet.measures.map((m: Record<string, unknown> & { notes: Record<string, unknown>[] }) => ({
        implicit: false, slash: false, barlineLeft: null, barlineRight: null, ending: null, rehearsal: null, navigation: null, uncertain: false,
        ...m,
        notes: m.notes.map((n) => ({ pitch: null, rest: false, dots: 0, tie: null, tuplet: null, ...n })),
      })),
    };
    const client = {
      beta: {
        messages: {
          stream: () => ({
            finalMessage: async () => ({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(rawSheet) }] }) as never,
          }),
        },
      },
    };
    const app = buildApp({ engines: { claude: new ClaudeEngine({ client, available: true }), audiveris: stub("audiveris", false) } });
    const { payload, headers } = multipart({ engine: "claude" }, { filename: "a.pdf", contentType: "application/pdf", data: fixture("sample-1.pdf") });
    const res = await app.inject({ method: "POST", url: "/api/convert", payload, headers });
    expect(res.statusCode).toBe(200);
    const body = res.json<ConvertResponse>();
    expect(body.engine).toBe("claude");
    expect(body.pages).toBe(2);
    // both pages returned the full sheet → measures are joined (twice as many)
    expect(body.model!.measures).toHaveLength(sheet.measures.length * 2);
    expect(validateXsd(body.musicxml).ok).toBe(true);
    await app.close();
  });
});
