// Pitch spelling and accidental regeneration on a MusicXML DOM.
import { Note } from "tonal";
import { child, childText, children, firstPart, insertBefore, partMeasures, removeChild, setChildText } from "./xml";

export const SHARP_ORDER = ["F", "C", "G", "D", "A", "E", "B"];
export const FLAT_ORDER = ["B", "E", "A", "D", "G", "C", "F"];

/** Alteration the key signature gives a letter. */
export function keyAlter(step: string, fifths: number): number {
  if (fifths > 0) return SHARP_ORDER.indexOf(step) < fifths ? 1 : 0;
  if (fifths < 0) return FLAT_ORDER.indexOf(step) < -fifths ? -1 : 0;
  return 0;
}

const MAJOR_TONICS = ["Cb", "Gb", "Db", "Ab", "Eb", "Bb", "F", "C", "G", "D", "A", "E", "B", "F#", "C#"];
const MINOR_TONICS = ["Ab", "Eb", "Bb", "F", "C", "G", "D", "A", "E", "B", "F#", "C#", "G#", "D#", "A#"];

/** Major tonic name for a key signature (-7..7). */
export function majorTonic(fifths: number): string {
  return MAJOR_TONICS[clampFifths(fifths) + 7];
}
export function minorTonic(fifths: number): string {
  return MINOR_TONICS[clampFifths(fifths) + 7];
}
export function keyName(fifths: number, mode: "major" | "minor" = "major"): string {
  return mode === "minor" ? minorTonic(fifths) + "m" : majorTonic(fifths);
}
function clampFifths(f: number): number {
  while (f > 7) f -= 12;
  while (f < -7) f += 12;
  return f;
}

export function accSymbol(alter: number): string {
  return alter > 0 ? "#".repeat(alter) : "b".repeat(-alter);
}

export interface Pitch {
  step: string;
  alter: number;
  octave: number;
}

export function readPitch(note: Element): Pitch | null {
  const p = child(note, "pitch");
  if (!p) return null;
  return {
    step: childText(p, "step") ?? "C",
    alter: parseFloat(childText(p, "alter") ?? "0") || 0,
    octave: parseInt(childText(p, "octave") ?? "4", 10),
  };
}

export function writePitch(note: Element, p: Pitch): void {
  const pe = child(note, "pitch");
  if (!pe) return;
  setChildText(pe, "step", p.step, ["alter", "octave"]);
  if (p.alter) setChildText(pe, "alter", String(p.alter), ["octave"]);
  else removeChild(pe, "alter");
  setChildText(pe, "octave", String(p.octave));
}

export function pitchToName(p: Pitch): string {
  return p.step + accSymbol(p.alter) + p.octave;
}

export function nameToPitch(name: string): Pitch {
  const n = Note.get(name);
  if (n.empty) throw new Error("Bad pitch " + name);
  return { step: n.letter, alter: n.alt, octave: n.oct ?? 4 };
}

export function pitchMidi(p: Pitch): number {
  return Note.midi(pitchToName(p)) ?? 60;
}

/** Spell a MIDI number for a key: diatonic notes as in the key, others with sharps in sharp keys, flats otherwise
 *  (or in the direction of motion when `dir` is given and the key is C). */
export function spellMidi(midi: number, fifths: number, dir: 1 | -1 | 0 = 0): Pitch {
  // diatonic spelling first
  for (const step of ["C", "D", "E", "F", "G", "A", "B"]) {
    const alter = keyAlter(step, fifths);
    for (const oct of [Math.floor(midi / 12) - 2, Math.floor(midi / 12) - 1, Math.floor(midi / 12)]) {
      const p = { step, alter, octave: oct };
      if (pitchMidi(p) === midi) return p;
    }
  }
  const useSharps = fifths > 0 || (fifths === 0 && dir > 0);
  const name = useSharps ? Note.fromMidiSharps(midi) : Note.fromMidi(midi);
  return nameToPitch(name);
}

const ACC_NAME: Record<string, string> = {
  "-2": "flat-flat",
  "-1": "flat",
  "0": "natural",
  "1": "sharp",
  "2": "double-sharp",
};

/** Children that come after <accidental> in a <note>. */
const AFTER_ACCIDENTAL = [
  "time-modification",
  "stem",
  "notehead",
  "notehead-text",
  "staff",
  "beam",
  "notations",
  "lyric",
  "play",
  "listen",
];

function hasTie(note: Element, type: "start" | "stop"): boolean {
  return children(note, "tie").some((t) => t.getAttribute("type") === type);
}

/**
 * Recompute `<accidental>` for every pitched note, from the key signature and earlier accidentals
 * in the same measure (per octave, as engravers do). Courtesy accidentals (cautionary/editorial/parentheses)
 * that aren't required are kept, with their value updated. Tied-over notes get none.
 */
export function regenerateAccidentals(doc: Document): void {
  const part = firstPart(doc);
  if (!part) return;
  for (const p of Array.from(doc.documentElement.getElementsByTagName("part"))) regeneratePart(p);
}

function regeneratePart(part: Element): void {
  let fifths = 0;
  for (const measure of partMeasures(part)) {
    const state = new Map<string, number>();
    for (const el of children(measure)) {
      if (el.tagName === "attributes") {
        const key = child(el, "key");
        const f = key && childText(key, "fifths");
        if (f != null) {
          fifths = parseInt(f, 10) || 0;
          state.clear();
        }
        continue;
      }
      if (el.tagName !== "note") continue;
      const p = readPitch(el);
      if (!p) continue;
      if (!Number.isInteger(p.alter)) continue; // microtones: leave alone
      const k = p.step + p.octave;
      const expected = state.has(k) ? state.get(k)! : keyAlter(p.step, fifths);
      const existing = child(el, "accidental");
      const courtesy =
        !!existing &&
        ["cautionary", "editorial", "parentheses", "bracket"].some((a) => existing.getAttribute(a) === "yes");
      const tiedOver = hasTie(el, "stop") && !state.has(k);
      const needed = !tiedOver && p.alter !== expected;
      if (!tiedOver) state.set(k, p.alter);
      if (needed || (courtesy && !tiedOver)) {
        const name = ACC_NAME[String(p.alter)];
        if (!name) continue;
        if (existing) existing.textContent = name;
        else {
          const acc = el.ownerDocument.createElement("accidental");
          acc.textContent = name;
          insertBefore(el, acc, AFTER_ACCIDENTAL);
        }
      } else if (existing) {
        el.removeChild(existing);
      }
    }
  }
}
