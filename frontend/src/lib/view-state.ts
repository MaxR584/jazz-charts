// Transposition view state: concert key offset + instrument + octave → semitones and key spellings.
import { Note } from "tonal";
import { keyName, majorTonic, minorTonic } from "./pitch";
import { targetFifths } from "./transpose";

export interface Instrument {
  id: "C" | "Bb" | "Eb" | "F";
  label: string;
  /** concert → written */
  semitones: number;
}

export const INSTRUMENTS: Instrument[] = [
  { id: "C", label: "Concert (C)", semitones: 0 },
  { id: "Bb", label: "B♭ — trumpet, tenor/soprano sax, clarinet", semitones: 2 },
  { id: "Eb", label: "E♭ — alto/bari sax", semitones: -3 },
  { id: "F", label: "F — horn", semitones: 7 },
];

export interface ViewState {
  /** Concert transposition from the original, in semitones. */
  concertOffset: number;
  instrument: Instrument["id"];
  octave: number;
}

export const DEFAULT_VIEW: ViewState = { concertOffset: 0, instrument: "C", octave: 0 };

export function instrumentOf(id: string): Instrument {
  return INSTRUMENTS.find((i) => i.id === id) ?? INSTRUMENTS[0];
}

export function totalSemitones(v: ViewState): number {
  return v.concertOffset + instrumentOf(v.instrument).semitones + 12 * v.octave;
}

export function tonicChroma(fifths: number, mode: "major" | "minor"): number {
  return Note.chroma(mode === "minor" ? minorTonic(fifths) : majorTonic(fifths)) ?? 0;
}

export interface KeyOption {
  /** Concert offset (-6..5) that reaches this key from the original. */
  offset: number;
  label: string;
  fifths: number;
}

/** The 12 concert keys, C first, spelled with flats where ambiguous. */
export function keyOptions(originalFifths: number, mode: "major" | "minor"): KeyOption[] {
  const orig = tonicChroma(originalFifths, mode);
  const out: KeyOption[] = [];
  for (let pc = 0; pc < 12; pc++) {
    let offset = (((pc - orig) % 12) + 12) % 12;
    if (offset > 5) offset -= 12;
    const fifths = targetFifths(originalFifths, offset);
    out.push({ offset, fifths, label: keyName(fifths, mode) });
  }
  return out;
}

/** Normalize an offset to -6..5 (same key). */
export function wrapOffset(o: number): number {
  let x = ((o % 12) + 12) % 12;
  if (x > 5) x -= 12;
  return x;
}

export function describeView(originalFifths: number, mode: "major" | "minor", v: ViewState) {
  const concert = targetFifths(originalFifths, v.concertOffset);
  const total = totalSemitones(v);
  const written = targetFifths(originalFifths, total);
  return {
    concertKey: keyName(concert, mode),
    writtenKey: keyName(written, mode),
    writtenFifths: written,
    semitones: total,
  };
}
