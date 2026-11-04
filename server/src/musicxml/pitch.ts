export type Step = "C" | "D" | "E" | "F" | "G" | "A" | "B";

export interface Pitch {
  step: Step;
  /** Semitones: -2..2 */
  alter: number;
  octave: number;
}

const STEP_SEMITONES: Record<Step, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** Normalize unicode accidentals to ASCII (♭→b, ♯→#, 𝄪→##, 𝄫→bb, ♮→ removed). */
export function normalizeAccidentals(s: string): string {
  return s
    .replace(/\u{1D12A}/gu, "##")
    .replace(/\u{1D12B}/gu, "bb")
    .replace(/♭/g, "b")
    .replace(/♯/g, "#")
    .replace(/♮/g, "");
}

export function parseAccidental(acc: string): number | null {
  switch (acc) {
    case "":
      return 0;
    case "#":
      return 1;
    case "##":
    case "x":
      return 2;
    case "b":
      return -1;
    case "bb":
      return -2;
    default:
      return null;
  }
}

/** Parse scientific pitch notation like "Bb4", "F#5", "C##4". Returns null if invalid. */
export function parsePitch(input: string): Pitch | null {
  const m = /^([A-Ga-g])(##|#|x|bb|b)?(-?\d)$/.exec(normalizeAccidentals(input.trim()));
  if (!m) return null;
  const alter = parseAccidental(m[2] ?? "");
  if (alter === null) return null;
  return { step: m[1]!.toUpperCase() as Step, alter, octave: Number(m[3]) };
}

/** MIDI note number (C4 = 60). */
export function midi(p: Pitch): number {
  return (p.octave + 1) * 12 + STEP_SEMITONES[p.step] + p.alter;
}

export function pitchToString(p: Pitch): string {
  const acc = p.alter > 0 ? "#".repeat(p.alter) : "b".repeat(-p.alter);
  return `${p.step}${acc}${p.octave}`;
}

const SHARP_ORDER: Step[] = ["F", "C", "G", "D", "A", "E", "B"];
const FLAT_ORDER: Step[] = ["B", "E", "A", "D", "G", "C", "F"];

/** Alteration of each step implied by a key signature. */
export function keyAlters(fifths: number): Record<Step, number> {
  const res: Record<Step, number> = { C: 0, D: 0, E: 0, F: 0, G: 0, A: 0, B: 0 };
  const n = Math.min(7, Math.abs(fifths));
  const order = fifths >= 0 ? SHARP_ORDER : FLAT_ORDER;
  for (let i = 0; i < n; i++) res[order[i]!] = fifths >= 0 ? 1 : -1;
  return res;
}

export function accidentalName(alter: number): string {
  switch (alter) {
    case 2:
      return "double-sharp";
    case 1:
      return "sharp";
    case 0:
      return "natural";
    case -1:
      return "flat";
    case -2:
      return "flat-flat";
    default:
      return "natural";
  }
}
