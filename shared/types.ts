// Shared types between frontend and server. Keep this file dependency-free.

export type Engine = "claude" | "audiveris" | "mock";
export type EngineChoice = Engine | "auto";

export interface HealthResponse {
  ok: boolean;
  engines: Record<Engine, boolean>;
}

export interface Warning {
  /** Measure number as written in the MusicXML (`<measure number>`), or null for whole-score issues. */
  measure: number | null;
  code:
    | "duration_mismatch"
    | "unparsed_chord"
    | "pitch_out_of_range"
    | "unbalanced_repeat"
    | "low_confidence"
    | "other";
  message: string;
}

export type DurationCode = "w" | "h" | "q" | "8" | "16" | "32";

export interface LeadSheetNote {
  /** Scientific pitch like "Bb4". Omitted for rests. */
  pitch?: string;
  rest?: boolean;
  duration: DurationCode;
  dots?: number;
  tie?: "start" | "stop" | "both" | null;
  tuplet?: { actual: number; normal: number } | null;
}

export interface LeadSheetMeasure {
  number: number;
  implicit?: boolean;
  slash?: boolean;
  barlineLeft?: "repeat-forward" | null;
  barlineRight?: "repeat-backward" | "final" | "double" | null;
  ending?: { number: string; type: "start" | "stop" | "discontinue" } | null;
  rehearsal?: string | null;
  navigation?: "segno" | "coda" | "D.S. al Coda" | "D.C. al Fine" | "Fine" | "To Coda" | null;
  /** beat is 1-based and may be fractional (e.g. 2.5). */
  chords: { beat: number; symbol: string }[];
  notes: LeadSheetNote[];
}

export interface LeadSheet {
  title: string;
  composer?: string;
  key: { fifths: number; mode: "major" | "minor" };
  time: { beats: number; beatType: number };
  clef: "treble" | "bass";
  measures: LeadSheetMeasure[];
}

export interface ConvertResponse {
  musicxml: string;
  model: LeadSheet | null;
  engine: Engine;
  pages: number;
  warnings: Warning[];
  /** Milliseconds spent recognizing. */
  elapsedMs: number;
}

export interface ApiError {
  error: {
    code: "unsupported_type" | "file_too_large" | "engine_unavailable" | "recognition_failed" | "internal";
    message: string;
  };
}
