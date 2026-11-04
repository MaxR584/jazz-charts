import multipart from "@fastify/multipart";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import type { ApiError, ConvertResponse, Engine, EngineChoice, HealthResponse, ProgressResponse } from "../../shared/types.js";
import { AudiverisEngine } from "./engines/audiveris.js";
import { ClaudeEngine } from "./engines/claude.js";
import { MockEngine } from "./engines/mock.js";
import { EngineError, type ConversionEngine } from "./engines/types.js";
import { InputError, prepareInput } from "./pipeline/pages.js";
import { sniffType } from "./pipeline/sniff.js";

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export type Engines = Record<Engine, ConversionEngine>;

export interface AppOptions {
  engines?: Partial<Engines>;
  logger?: boolean;
  maxPages?: number;
}

type ErrorCode = ApiError["error"]["code"];

function sendError(reply: FastifyReply, status: number, code: ErrorCode, message: string) {
  const body: ApiError = { error: { code, message } };
  return reply.code(status).send(body);
}

const ENGINE_CHOICES: EngineChoice[] = ["auto", "claude", "audiveris", "mock"];

/** `auto` = claude if ANTHROPIC_API_KEY is set, else audiveris if installed. Never mock:
 * mock always returns the sample, which looks like a wrong answer for the user's own file. */
export function resolveEngine(choice: EngineChoice, engines: Engines): ConversionEngine | null {
  if (choice === "auto") {
    for (const name of ["claude", "audiveris"] as const) {
      if (engines[name].isAvailable()) return engines[name];
    }
    return null;
  }
  return engines[choice].isAvailable() ? engines[choice] : null;
}

export function buildApp(opts: AppOptions = {}): FastifyInstance {
  const engines: Engines = {
    claude: opts.engines?.claude ?? new ClaudeEngine(),
    audiveris: opts.engines?.audiveris ?? new AudiverisEngine(),
    mock: opts.engines?.mock ?? new MockEngine(),
  };
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: MAX_UPLOAD_BYTES + 1024 * 1024 });

  app.register(multipart, {
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 10, fieldSize: 1024 },
    throwFileSizeLimit: true,
  });

  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, req, reply) => {
    if (err.code === "FST_REQ_FILE_TOO_LARGE" || err.code === "FST_ERR_CTP_BODY_TOO_LARGE" || err.statusCode === 413) {
      return sendError(reply, 413, "file_too_large", `File is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`);
    }
    if (err.code === "FST_INVALID_MULTIPART_CONTENT_TYPE" || err.statusCode === 415) {
      return sendError(reply, 415, "unsupported_type", "Send multipart/form-data with a `file` field");
    }
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
      return sendError(reply, err.statusCode, "unsupported_type", err.message);
    }
    req.log.error(err);
    return sendError(reply, 500, "internal", "Internal server error");
  });

  // Conversion progress, keyed by a client-chosen job id (POST /api/convert?job=<id>).
  const progress = new Map<string, ProgressResponse & { at: number }>();
  const setProgress = (job: string | undefined, p: ProgressResponse) => {
    if (!job) return;
    const now = Date.now();
    progress.set(job, { ...p, percent: Math.max(0, Math.min(100, Math.round(p.percent))), at: now });
    for (const [k, v] of progress) if (now - v.at > 10 * 60_000) progress.delete(k); // forget stale jobs
  };

  app.get<{ Params: { job: string } }>("/api/progress/:job", async (req, reply) => {
    const p = progress.get(req.params.job);
    if (!p) return reply.code(404).send({ error: { code: "internal", message: "Unknown job" } });
    const { at: _at, ...body } = p;
    return body;
  });

  app.get("/api/health", async (): Promise<HealthResponse> => ({
    ok: true,
    engines: {
      claude: engines.claude.isAvailable(),
      audiveris: engines.audiveris.isAvailable(),
      mock: engines.mock.isAvailable(),
    },
  }));

  app.post<{ Querystring: { job?: string } }>("/api/convert", async (req, reply) => {
    const job = /^[A-Za-z0-9_-]{8,64}$/.test(req.query.job ?? "") ? req.query.job : undefined;
    setProgress(job, { percent: 0, stage: "Uploading", done: false });
    if (!req.isMultipart()) {
      return sendError(reply, 415, "unsupported_type", "Send multipart/form-data with a `file` field");
    }
    let file: Buffer | null = null;
    let engineField: string | undefined;
    for await (const part of req.parts()) {
      if (part.type === "file") {
        if (part.fieldname !== "file" || file) {
          await part.toBuffer(); // drain
          continue;
        }
        file = await part.toBuffer(); // throws FST_REQ_FILE_TOO_LARGE past the limit
      } else if (part.fieldname === "engine") {
        engineField = String(part.value ?? "").trim();
      }
    }
    if (!file || file.length === 0) {
      return sendError(reply, 400, "unsupported_type", "Missing `file` (PNG, JPEG, WebP or PDF)");
    }

    const choice = (engineField || "auto") as EngineChoice;
    if (!ENGINE_CHOICES.includes(choice)) {
      return sendError(reply, 400, "engine_unavailable", `Unknown engine "${engineField}". Use one of: ${ENGINE_CHOICES.join(", ")}`);
    }

    const mime = sniffType(file);
    if (!mime) {
      return sendError(reply, 415, "unsupported_type", "Unsupported file type. Upload a PNG, JPEG, WebP or PDF.");
    }

    const engine = resolveEngine(choice, engines);
    if (!engine) {
      const why =
        choice === "claude" ? "ANTHROPIC_API_KEY is not set" : choice === "audiveris" ? "Audiveris is not installed (scripts/install-audiveris.sh)" : "no recognition engine is set up. Set ANTHROPIC_API_KEY before starting the server, or install Audiveris (see server/README.md)";
      return sendError(reply, 503, "engine_unavailable", `Engine "${choice}" is unavailable: ${why}`);
    }

    setProgress(job, { percent: 2, stage: mime === "application/pdf" ? "Splitting the PDF into pages" : "Preparing the image", done: false });
    let input;
    try {
      input = await prepareInput(file, mime, { maxPages: opts.maxPages });
    } catch (e) {
      if (e instanceof InputError) return sendError(reply, e.code === "unsupported_type" ? 415 : 422, e.code, e.message);
      throw e;
    }

    const started = performance.now();
    try {
      // Engine work maps to 5–97%; the rest is preparing and finishing.
      const result = await engine.convert(input, (p, stage) => setProgress(job, { percent: 5 + p * 0.92, stage, done: false }));
      setProgress(job, { percent: 100, stage: "Done", done: true });
      const warnings = [...result.warnings];
      if (input.totalPages > input.pages.length) {
        warnings.push({ measure: null, code: "other", message: `Only the first ${input.pages.length} of ${input.totalPages} pages were processed.` });
      }
      const body: ConvertResponse = {
        musicxml: result.musicxml,
        model: result.model,
        engine: engine.name,
        pages: input.pages.length,
        warnings,
        elapsedMs: Math.round(performance.now() - started),
      };
      return reply.send(body);
    } catch (e) {
      setProgress(job, { percent: 100, stage: "Failed", done: true });
      if (e instanceof EngineError) {
        const status = e.code === "engine_unavailable" ? 503 : e.code === "recognition_failed" ? 422 : 500;
        req.log.warn({ err: e }, "engine failed");
        return sendError(reply, status, e.code, e.message);
      }
      throw e;
    }
  });

  return app;
}
