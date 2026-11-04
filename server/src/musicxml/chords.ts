import { normalizeAccidentals, type Step } from "./pitch.js";

/**
 * Jazz chord-symbol parser → MusicXML <harmony> model.
 *
 * Accepts the usual lead-sheet spellings: Cm7b5, C-7, CΔ7, C^7, Cø7, C°7, F7#9,
 * Bb7alt, C6/9, Ebmaj7/G, N.C., C7sus4, G7b9b13, C7(b9,#11), Cm(maj7), ...
 */

export interface ChordRoot {
  step: Step;
  alter: number;
}

export interface ChordDegree {
  value: number;
  /** Relative to the major scale (b7 = -1, #9 = +1). */
  alter: number;
  type: "add" | "alter" | "subtract";
}

export interface ParsedChord {
  /** null for N.C. */
  root: ChordRoot | null;
  /** MusicXML kind value (major, minor-seventh, dominant, ..., none, other). */
  kind: string;
  /** Text displayed after the root (the suffix as written, e.g. "-7", "Δ7", "7alt"). */
  text: string;
  degrees: ChordDegree[];
  bass: ChordRoot | null;
}

export type ChordParseResult =
  | { ok: true; chord: ParsedChord }
  /** `partial` is set when the root parsed but the suffix didn't; build it as kind="other". */
  | { ok: false; reason: string; partial: ParsedChord | null };

interface Quality {
  kind: string;
  degrees?: ChordDegree[];
}

const add = (value: number, alter = 0): ChordDegree => ({ value, alter, type: "add" });

const ALT_DEGREES: ChordDegree[] = [
  { value: 5, alter: 1, type: "alter" },
  { value: 9, alter: -1, type: "add" },
  { value: 9, alter: 1, type: "add" },
];

/** Quality prefixes, matched longest-first against the normalized suffix. */
const QUALITIES: Record<string, Quality> = {
  "": { kind: "major" },
  maj: { kind: "major" },
  maj7: { kind: "major-seventh" },
  maj9: { kind: "major-ninth" },
  maj11: { kind: "major-11th" },
  maj13: { kind: "major-13th" },
  maj69: { kind: "major-sixth", degrees: [add(9)] },
  m: { kind: "minor" },
  m7: { kind: "minor-seventh" },
  m9: { kind: "minor-ninth" },
  m11: { kind: "minor-11th" },
  m13: { kind: "minor-13th" },
  m6: { kind: "minor-sixth" },
  m69: { kind: "minor-sixth", degrees: [add(9)] },
  m7b5: { kind: "half-diminished" },
  mmaj: { kind: "major-minor" },
  mmaj7: { kind: "major-minor" },
  mmaj9: { kind: "major-minor", degrees: [add(9)] },
  dim: { kind: "diminished" },
  dim7: { kind: "diminished-seventh" },
  aug: { kind: "augmented" },
  aug7: { kind: "augmented-seventh" },
  "7": { kind: "dominant" },
  "9": { kind: "dominant-ninth" },
  "11": { kind: "dominant-11th" },
  "13": { kind: "dominant-13th" },
  "6": { kind: "major-sixth" },
  "69": { kind: "major-sixth", degrees: [add(9)] },
  "5": { kind: "power" },
  sus: { kind: "suspended-fourth" },
  sus4: { kind: "suspended-fourth" },
  sus2: { kind: "suspended-second" },
  "7sus": { kind: "suspended-fourth", degrees: [add(7, -1)] },
  "7sus4": { kind: "suspended-fourth", degrees: [add(7, -1)] },
  "7sus2": { kind: "suspended-second", degrees: [add(7, -1)] },
  "9sus": { kind: "suspended-fourth", degrees: [add(7, -1), add(9)] },
  "9sus4": { kind: "suspended-fourth", degrees: [add(7, -1), add(9)] },
  "13sus": { kind: "suspended-fourth", degrees: [add(7, -1), add(9), add(13)] },
  "13sus4": { kind: "suspended-fourth", degrees: [add(7, -1), add(9), add(13)] },
  // "alt" has no MusicXML kind: dominant + b9, #9, #5 (renderers that ignore the
  // kind text, e.g. OSMD, still show the alterations; text keeps "7alt").
  alt: { kind: "dominant", degrees: ALT_DEGREES },
  "7alt": { kind: "dominant", degrees: ALT_DEGREES },
  augmaj7: { kind: "major-seventh", degrees: [{ value: 5, alter: 1, type: "alter" }] },
  augmaj9: { kind: "major-ninth", degrees: [{ value: 5, alter: 1, type: "alter" }] },
};

const QUALITY_KEYS = Object.keys(QUALITIES).sort((a, b) => b.length - a.length);

/** Degrees already contained in a kind (an alteration of these is type "alter", not "add"). */
const IMPLIED: Record<string, number[]> = {
  "dominant-ninth": [9],
  "major-ninth": [9],
  "minor-ninth": [9],
  "dominant-11th": [9, 11],
  "major-11th": [9, 11],
  "minor-11th": [9, 11],
  "dominant-13th": [9, 11, 13],
  "major-13th": [9, 11, 13],
  "minor-13th": [9, 11, 13],
};

const NO_CHORD = /^(n\.?\s*c\.?|no\s*chord|tacet)$/i;

function parseNote(s: string): { root: ChordRoot; rest: string } | null {
  const m = /^([A-G])(bb|##|b|#)?/.exec(s);
  if (!m) return null;
  const acc = m[2] ?? "";
  const alter = acc === "#" ? 1 : acc === "##" ? 2 : acc === "b" ? -1 : acc === "bb" ? -2 : 0;
  return { root: { step: m[1] as Step, alter }, rest: s.slice(m[0].length) };
}

/** Normalize the suffix (after the root, before the slash bass) to the table's vocabulary. */
export function normalizeSuffix(suffix: string): string {
  let q = suffix.replace(/[()\[\],\s]/g, "");
  q = q.replace(/6\/9/g, "69");
  // Triangle → maj
  q = q.replace(/[Δ△∆^](9|11|13)/g, "maj$1").replace(/[Δ△∆^]7?/g, "maj7");
  // ø → m7b5
  q = q.replace(/[øØ⌀]7?/g, "m7b5");
  // ° / o → dim
  q = q.replace(/^[°º]/, "dim").replace(/^o(?=7|$)/, "dim");
  // Leading dash = minor; inner dash before a number = flat (old "C7-9" style)
  q = q.replace(/^[-−–]/, "m").replace(/[-−–](?=\d)/g, "b");
  // Leading + = aug; inner + before a number = sharp
  q = q.replace(/^\+/, "aug").replace(/\+(?=\d)/g, "#");
  // min / mi / mn → m (before the major rule so "min" is not eaten)
  q = q.replace(/^(min|mi|mn)(?!d)/, "m");
  // m + major-7 spellings → mmaj
  q = q.replace(/^m(maj|Maj|MAJ|Ma|MA|ma|M)/, "mmaj");
  // Major spellings: maj / Maj / MAJ / Ma / ma / M → maj
  q = q.replace(/^(maj|Maj|MAJ|Ma|MA|ma|M)(?=\d|$|add|#|b|sus)/, "maj");
  q = q.replace(/^augmented/, "aug").replace(/^diminished/, "dim");
  q = q.replace(/alt\.?$/, "alt");
  // "C7+" / "C9+": trailing + is a raised fifth
  q = q.replace(/(\d)\+$/, "$1#5");
  // "C+maj7" → augmaj7
  q = q.replace(/^aug(maj|Maj|MAJ|Ma|M)(?=\d)/, "augmaj");
  return q;
}

export function parseChordSymbol(input: string): ChordParseResult {
  const raw = normalizeAccidentals(input.trim());
  if (!raw) return { ok: false, reason: "empty chord symbol", partial: null };
  if (NO_CHORD.test(raw)) {
    return { ok: true, chord: { root: null, kind: "none", text: "N.C.", degrees: [], bass: null } };
  }
  const head = parseNote(raw);
  if (!head) return { ok: false, reason: `no root note in "${input}"`, partial: null };

  let rest = head.rest;
  let bass: ChordRoot | null = null;
  const slash = /\/([A-G](?:bb|##|b|#)?)$/.exec(rest);
  if (slash) {
    bass = parseNote(slash[1]!)!.root;
    rest = rest.slice(0, slash.index);
  }
  const text = rest;
  const partial: ParsedChord = { root: head.root, kind: "other", text, degrees: [], bass };

  let q = normalizeSuffix(rest);
  const key = QUALITY_KEYS.find((k) => q.startsWith(k));
  if (key === undefined) return { ok: false, reason: `unknown chord quality "${rest}"`, partial };
  const quality = QUALITIES[key]!;
  q = q.slice(key.length);

  let kind = quality.kind;
  const degrees: ChordDegree[] = [...(quality.degrees ?? [])];
  let implied = new Set(IMPLIED[kind] ?? []);

  while (q.length > 0) {
    // Trailing "sus" after extensions, e.g. "C7b9sus4", "C9sus".
    const sus = /^sus(4|2)?/.exec(q);
    if (sus) {
      const susKind = sus[1] === "2" ? "suspended-second" : "suspended-fourth";
      const ext = kind.startsWith("dominant") ? kind : null;
      if (ext) {
        degrees.unshift(add(7, -1));
        if (ext !== "dominant") degrees.splice(1, 0, add(9));
        if (ext === "dominant-13th") degrees.splice(2, 0, add(13));
      } else if (kind !== "major") {
        return { ok: false, reason: `cannot combine "${key}" with sus in "${input}"`, partial };
      }
      kind = susKind;
      implied = new Set();
      q = q.slice(sus[0].length);
      continue;
    }
    const m = /^(add|no|omit)?(bb|b|#)?(2|3|4|5|6|7|9|11|13)/.exec(q);
    if (!m) {
      if (q === "alt") {
        degrees.push(...ALT_DEGREES.filter((d) => !degrees.some((x) => x.value === d.value && x.alter === d.alter)));
        q = "";
        break;
      }
      return { ok: false, reason: `cannot parse "${q}" in "${input}"`, partial };
    }
    const [, op, acc, num] = m;
    const value = Number(num);
    const alter = acc === "#" ? 1 : acc === "b" ? -1 : acc === "bb" ? -2 : 0;
    if (op === "no" || op === "omit") {
      degrees.push({ value, alter: 0, type: "subtract" });
    } else if (op === "add") {
      degrees.push(add(value, alter));
    } else if (value === 5) {
      degrees.push({ value, alter, type: "alter" });
    } else if (value === 7 && alter === 0 && kind === "dominant") {
      // "C7 7" style redundancy: ignore
    } else if (value === 7 && alter === 0 && kind.startsWith("suspended")) {
      degrees.push(add(7, -1)); // "Csus7" = C7sus4
    } else if (implied.has(value)) {
      if (alter !== 0) degrees.push({ value, alter, type: "alter" });
    } else {
      degrees.push(add(value, alter));
    }
    q = q.slice(m[0].length);
  }

  return { ok: true, chord: { root: head.root, kind, text, degrees, bass } };
}

/** True when the symbol parses fully. */
export function isValidChord(symbol: string): boolean {
  return parseChordSymbol(symbol).ok;
}
