// Client for the conversion server (see docs/CONTRACT.md).
import type { ApiError, ConvertResponse, EngineChoice, HealthResponse, ProgressResponse } from "../../../shared/types";

export const ACCEPTED_UPLOAD = ["image/png", "image/jpeg", "image/webp", "application/pdf"];
export const MAX_UPLOAD = 20 * 1024 * 1024;

export class ApiFailure extends Error {
  constructor(
    message: string,
    public code: ApiError["error"]["code"] | "server_down" | "network" | "bad_response" | "aborted",
    public status = 0,
  ) {
    super(message);
  }
}

const FRIENDLY: Record<string, string> = {
  unsupported_type: "That file type isn't supported. Use PNG, JPEG, WebP or PDF.",
  file_too_large: "That file is too large (max 20 MB).",
  engine_unavailable: "No recognition engine is available to read this file.",
  recognition_failed: "The server couldn't read music from that image.",
  internal: "The server hit an internal error.",
};

export const SERVER_DOWN =
  "Can't reach the conversion server (expected on port 3001). You can still open MusicXML files and the sample.";

export async function fetchHealth(timeoutMs = 4000): Promise<HealthResponse> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch("/api/health", { signal: ctrl.signal });
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new ApiFailure(SERVER_DOWN, "server_down", res.status);
    }
    const h = body as HealthResponse;
    if (!res.ok || typeof h !== "object" || !h || !h.engines) throw new ApiFailure(SERVER_DOWN, "server_down", res.status);
    return h;
  } catch (e) {
    if (e instanceof ApiFailure) throw e;
    throw new ApiFailure(SERVER_DOWN, "server_down");
  } finally {
    clearTimeout(timer);
  }
}

export function validateUpload(file: File): string | null {
  const type = file.type || guessType(file.name);
  if (!ACCEPTED_UPLOAD.includes(type)) return `"${file.name}" isn't an image or PDF. Use PNG, JPEG, WebP or PDF.`;
  if (file.size > MAX_UPLOAD) return `"${file.name}" is ${(file.size / 1048576).toFixed(1)} MB; the limit is 20 MB.`;
  return null;
}

export function guessType(name: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return (
    { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", pdf: "application/pdf" }[ext] ?? ""
  );
}

export interface ConvertHandle {
  promise: Promise<ConvertResponse>;
  abort: () => void;
}

/** A random id the server uses to report this conversion's progress. */
export function newJobId(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  return Array.from({ length: 4 }, () => Math.random().toString(36).slice(2, 10)).join("-");
}

/** GET /api/progress/:job. Returns null when the server has nothing (yet) for this job. */
export async function fetchProgress(job: string): Promise<ProgressResponse | null> {
  try {
    const res = await fetch(`/api/progress/${encodeURIComponent(job)}`, { cache: "no-store" });
    if (!res.ok) return null;
    const p = (await res.json()) as ProgressResponse;
    return typeof p?.percent === "number" ? p : null;
  } catch {
    return null;
  }
}

/** POST /api/convert with upload progress (XHR, since fetch has no upload progress). */
export function convert(file: File, engine: EngineChoice, onUploadProgress: (fraction: number) => void, job?: string): ConvertHandle {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<ConvertResponse>((resolve, reject) => {
    const form = new FormData();
    const type = file.type || guessType(file.name);
    form.append("file", type && type !== file.type ? new File([file], file.name, { type }) : file, file.name);
    form.append("engine", engine);
    xhr.open("POST", job ? `/api/convert?job=${encodeURIComponent(job)}` : "/api/convert");
    xhr.responseType = "text";
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onUploadProgress(e.loaded / e.total);
    };
    xhr.upload.onload = () => onUploadProgress(1);
    xhr.onerror = () => reject(new ApiFailure(SERVER_DOWN, "server_down"));
    xhr.onabort = () => reject(new ApiFailure("Cancelled.", "aborted"));
    xhr.onload = () => {
      let body: unknown;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // The Vite proxy answers 500/502/504 with plain text when the server isn't running.
        if (xhr.status >= 500 || xhr.status === 0) return reject(new ApiFailure(SERVER_DOWN, "server_down", xhr.status));
        return reject(new ApiFailure(`Unexpected response from the server (HTTP ${xhr.status}).`, "bad_response", xhr.status));
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        const r = body as ConvertResponse;
        if (!r || typeof r.musicxml !== "string") return reject(new ApiFailure("The server response had no MusicXML.", "bad_response", xhr.status));
        r.warnings = Array.isArray(r.warnings) ? r.warnings : [];
        return resolve(r);
      }
      const err = (body as ApiError)?.error;
      if (err?.code) {
        const friendly = FRIENDLY[err.code] ?? "The server reported an error.";
        const msg = err.message && err.message !== friendly ? `${friendly} (${err.message})` : friendly;
        return reject(new ApiFailure(msg, err.code, xhr.status));
      }
      reject(new ApiFailure(`The server returned HTTP ${xhr.status}.`, "bad_response", xhr.status));
    };
    xhr.send(form);
  });
  return { promise, abort: () => xhr.abort() };
}
