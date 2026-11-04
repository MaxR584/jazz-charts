import type { Engine, LeadSheet, Warning } from "../../../shared/types.js";
import type { PreparedInput } from "../pipeline/pages.js";

export interface EngineResult {
  musicxml: string;
  model: LeadSheet | null;
  warnings: Warning[];
}

export interface ConversionEngine {
  readonly name: Engine;
  isAvailable(): boolean;
  convert(input: PreparedInput): Promise<EngineResult>;
}

export class EngineError extends Error {
  constructor(
    readonly code: "engine_unavailable" | "recognition_failed" | "internal",
    message: string,
  ) {
    super(message);
  }
}
