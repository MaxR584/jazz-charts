// Pure MusicXML transposition (for download/export). Works on a DOM Document in place.
// Mirrors OSMD's IntervalTransposeCalculator: every note moves by the same *spelled* interval,
// derived from the old and new key signatures, so A# in C → G# in Bb (not Ab).
import { Interval, Note } from "tonal";
import { cleanChordSpelling } from "./chords";
import { majorTonic, nameToPitch, pitchToName, readPitch, regenerateAccidentals, writePitch } from "./pitch";
import { child, childText, firstKey, setChildText } from "./xml";

export type KeyPreference = "flats" | "sharps";

/**
 * Key signature (fifths) after transposing a key by `semitones`.
 * Ambiguous keys use flats by default (Db, Gb, Ab…): result in -6..5 ("flats") or -5..6 ("sharps").
 * A whole-octave transposition keeps the original key.
 */
export function targetFifths(fromFifths: number, semitones: number, prefer: KeyPreference = "flats"): number {
  if (semitones % 12 === 0) return fromFifths;
  let f = (((fromFifths + 7 * semitones) % 12) + 12) % 12; // 0..11
  if (prefer === "flats" ? f > 5 : f > 6) f -= 12;
  return f;
}

export interface SpelledInterval {
  /** Simple interval between the two major tonics (tonal notation, e.g. "7m"), ascending within an octave. */
  ivl: string;
  /** Octaves to add after applying `ivl` so the total equals `semitones`. */
  octaves: number;
  semitones: number;
  fromFifths: number;
  toFifths: number;
}

/** The spelled interval that moves key `fromFifths` to `toFifths` by `semitones` in total. */
export function spelledInterval(fromFifths: number, toFifths: number, semitones: number): SpelledInterval {
  const ivl = Interval.distance(majorTonic(fromFifths), majorTonic(toFifths));
  const s = Interval.semitones(ivl) ?? 0;
  const octaves = (semitones - s) / 12;
  if (!Number.isInteger(octaves)) {
    throw new Error(`Key ${fromFifths} → ${toFifths} is not a transposition by ${semitones} semitones`);
  }
  return { ivl, octaves, semitones, fromFifths, toFifths };
}

export function intervalForSemitones(fromFifths: number, semitones: number, prefer: KeyPreference = "flats"): SpelledInterval {
  return spelledInterval(fromFifths, targetFifths(fromFifths, semitones, prefer), semitones);
}

/** Human readable interval, e.g. "-2M" (down a major second). */
export function describeInterval(si: SpelledInterval): string {
  return Interval.distance("C4", transposePitchName("C4", si)) || "1P";
}

/** Transpose a pitch name like "A#4". Double sharps/flats are respelled (Cbb4 → Bb3). */
export function transposePitchName(name: string, si: SpelledInterval): string {
  let out = Note.transpose(name, si.ivl);
  if (/(bb|##)/.test(out)) out = Note.simplify(out);
  const n = Note.get(out);
  return n.pc + ((n.oct ?? 4) + si.octaves);
}

export function transposePitchClass(pc: string, si: SpelledInterval): string {
  return cleanChordSpelling(Note.transpose(pc, si.ivl));
}

function normFifths(f: number): number {
  while (f > 7) f -= 12;
  while (f < -7) f += 12;
  return f;
}

export interface TransposeOptions {
  semitones: number;
  prefer?: KeyPreference;
}

/**
 * Transpose a MusicXML document in place: note pitches (step/alter/octave), `<accidental>` (regenerated),
 * `<harmony>` root and bass, and every `<key><fifths>`. Returns the interval used.
 */
export function transposeDocument(doc: Document, opts: TransposeOptions): SpelledInterval {
  const { fifths: f0 } = firstKey(doc);
  const si = intervalForSemitones(f0, opts.semitones, opts.prefer ?? "flats");
  if (opts.semitones === 0) return si;
  const deltaFifths = si.toFifths - f0;

  // Key signatures
  for (const key of Array.from(doc.getElementsByTagName("key"))) {
    const f = childText(key, "fifths");
    if (f == null) continue;
    const nf = normFifths((parseInt(f, 10) || 0) + deltaFifths);
    setChildText(key, "fifths", String(nf));
  }

  // Notes
  for (const note of Array.from(doc.getElementsByTagName("note"))) {
    const p = readPitch(note);
    if (!p || !Number.isInteger(p.alter)) continue;
    writePitch(note, nameToPitch(transposePitchName(pitchToName(p), si)));
  }

  // Chord symbols
  for (const h of Array.from(doc.getElementsByTagName("harmony"))) {
    transposeStepAlter(child(h, "root"), "root-step", "root-alter", si);
    transposeStepAlter(child(h, "bass"), "bass-step", "bass-alter", si);
  }

  regenerateAccidentals(doc);
  return si;
}

function transposeStepAlter(parent: Element | null, stepTag: string, alterTag: string, si: SpelledInterval): void {
  if (!parent) return;
  const step = childText(parent, stepTag);
  if (!step) return;
  const alter = parseInt(childText(parent, alterTag) ?? "0", 10) || 0;
  const pc = step + (alter > 0 ? "#".repeat(alter) : "b".repeat(-alter));
  const n = Note.get(transposePitchClass(pc, si));
  setChildText(parent, stepTag, n.letter, [alterTag]);
  const a = child(parent, alterTag);
  if (n.alt) setChildText(parent, alterTag, String(n.alt));
  else if (a) parent.removeChild(a);
}
