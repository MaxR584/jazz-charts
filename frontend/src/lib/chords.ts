// Chord symbol text <-> MusicXML <harmony>.
import { Note } from "tonal";
import { accSymbol } from "./pitch";
import { child, childText, children } from "./xml";

export interface ParsedChord {
  root: string; // e.g. "Bb"
  suffix: string; // display suffix, e.g. "m7b5"
  bass?: string;
}

const CHORD_RE = /^([A-G])([#b♯♭]?)(.*?)(?:\/([A-G])([#b♯♭]?))?$/;

export function splitChord(sym: string): ParsedChord | null {
  const m = sym.trim().match(CHORD_RE);
  if (!m) return null;
  const acc = (s: string) => s.replace("♯", "#").replace("♭", "b");
  return {
    root: m[1] + acc(m[2]),
    suffix: m[3].trim(),
    bass: m[4] ? m[4] + acc(m[5]) : undefined,
  };
}

/** Lead sheets don't use Fb, Cb, E#, B# or double accidentals for chord roots. */
export function cleanChordSpelling(n: string): string {
  return /(bb|##|x)|^(Fb|Cb|E#|B#)$/.test(n) ? Note.simplify(n) : n;
}

/** Transpose a chord symbol string: root and slash bass only, suffix untouched. */
export function transposeChordText(sym: string, ivl: string): string {
  const c = splitChord(sym);
  if (!c) return sym;
  const r = cleanChordSpelling(Note.transpose(c.root, ivl));
  return r + c.suffix + (c.bass ? "/" + cleanChordSpelling(Note.transpose(c.bass, ivl)) : "");
}

interface KindSpec {
  kind: string;
  degrees?: Degree[];
}
interface Degree {
  value: number;
  alter: number;
  type: "add" | "alter" | "subtract";
}

// Suffixes (after normalization) → MusicXML kind. Longest match first.
const BASES: [string, KindSpec][] = [
  ["mmaj7", { kind: "major-minor" }],
  ["m7b5", { kind: "half-diminished" }],
  ["maj13", { kind: "major-13th" }],
  ["maj11", { kind: "major-11th" }],
  ["maj9", { kind: "major-ninth" }],
  ["maj7", { kind: "major-seventh" }],
  ["dim7", { kind: "diminished-seventh" }],
  ["aug7", { kind: "augmented-seventh" }],
  ["7#5", { kind: "augmented-seventh" }],
  ["7alt", { kind: "dominant", degrees: [d(5, 1, "add"), d(9, -1, "add"), d(9, 1, "add"), d(5, -1, "alter")] }],
  ["alt", { kind: "dominant", degrees: [d(5, 1, "add"), d(9, -1, "add"), d(9, 1, "add"), d(5, -1, "alter")] }],
  ["m13", { kind: "minor-13th" }],
  ["m11", { kind: "minor-11th" }],
  ["m69", { kind: "minor-sixth", degrees: [d(9, 0, "add")] }],
  ["m9", { kind: "minor-ninth" }],
  ["m7", { kind: "minor-seventh" }],
  ["m6", { kind: "minor-sixth" }],
  ["13sus4", { kind: "suspended-fourth", degrees: [d(13, 0, "add")] }],
  ["9sus4", { kind: "suspended-fourth", degrees: [d(9, 0, "add")] }],
  ["7sus4", { kind: "suspended-fourth", degrees: [d(7, 0, "add")] }],
  ["7sus2", { kind: "suspended-second", degrees: [d(7, 0, "add")] }],
  ["7sus", { kind: "suspended-fourth", degrees: [d(7, 0, "add")] }],
  ["sus4", { kind: "suspended-fourth" }],
  ["sus2", { kind: "suspended-second" }],
  ["sus", { kind: "suspended-fourth" }],
  ["69", { kind: "major-sixth", degrees: [d(9, 0, "add")] }],
  ["13", { kind: "dominant-13th" }],
  ["11", { kind: "dominant-11th" }],
  ["9", { kind: "dominant-ninth" }],
  ["7", { kind: "dominant" }],
  ["6", { kind: "major-sixth" }],
  ["dim", { kind: "diminished" }],
  ["aug", { kind: "augmented" }],
  ["maj", { kind: "major" }],
  ["m", { kind: "minor" }],
  ["5", { kind: "power" }],
  ["", { kind: "major" }],
];
function d(value: number, alter: number, type: Degree["type"]): Degree {
  return { value, alter, type };
}

/** Normalize the common jazz spellings of a suffix: -7 → m7, Δ → maj7, ø → m7b5, ° → dim, + → aug … */
export function normalizeSuffix(s: string): string {
  let x = s.replace(/[\s,()]/g, "").replace(/♯/g, "#").replace(/♭/g, "b");
  x = x.replace(/^(min|mi|-)/, "m");
  x = x.replace(/^(ma7|M7|Ma7|Maj7|Δ7|Δ|\^7|\^)/, "maj7").replace(/^(M9|Ma9|Maj9|Δ9)/, "maj9").replace(/^(M13|Δ13)/, "maj13");
  x = x.replace(/^m(M7|Δ7|Δ|maj7|ma7)/, "mmaj7");
  x = x.replace(/^(ø7|ø|Ø7|Ø)/, "m7b5");
  x = x.replace(/^(°7|o7)/, "dim7").replace(/^(°|o)(?![a-z])/, "dim");
  x = x.replace(/^\+7/, "aug7").replace(/^\+/, "aug");
  x = x.replace(/^6\/9/, "69").replace(/^m6\/9/, "m69");
  return x;
}

export function suffixToKind(suffixIn: string): KindSpec & { ok: boolean } {
  const s = normalizeSuffix(suffixIn);
  for (const [base, spec] of BASES) {
    if (!s.startsWith(base)) continue;
    const rest = s.slice(base.length);
    const degrees: Degree[] = [...(spec.degrees ?? [])];
    const re = /(add|no|omit)?([#b]?)(\d+)/y;
    let pos = 0;
    let ok = true;
    while (pos < rest.length) {
      re.lastIndex = pos;
      const m = re.exec(rest);
      if (!m) {
        ok = false;
        break;
      }
      const value = parseInt(m[3], 10);
      const alter = m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0;
      const type = m[1] === "no" || m[1] === "omit" ? "subtract" : value === 5 && alter !== 0 ? "alter" : "add";
      degrees.push({ value, alter, type });
      pos = re.lastIndex;
    }
    if (ok) return { kind: spec.kind, degrees, ok: true };
  }
  return { kind: "other", degrees: [], ok: false };
}

function stepAlter(name: string): { step: string; alter: number } {
  const n = Note.get(name);
  return { step: n.letter, alter: n.alt };
}

/** Build a <harmony> element from chord text ("Bb7(b9)/D", "N.C."). Returns null if unparseable. */
export function buildHarmony(doc: Document, sym: string): Element | null {
  const h = doc.createElement("harmony");
  const t = sym.trim();
  if (/^(N\.?C\.?|NC)$/i.test(t)) {
    // MusicXML needs a root; kind "none" means no chord.
    const root = el(doc, "root", [el(doc, "root-step", "C")]);
    const kind = el(doc, "kind", "none");
    kind.setAttribute("text", "N.C.");
    h.append(root, kind);
    return h;
  }
  const c = splitChord(t);
  if (!c) return null;
  const r = stepAlter(c.root);
  const rootEl = el(doc, "root", [el(doc, "root-step", r.step)]);
  if (r.alter) rootEl.appendChild(el(doc, "root-alter", String(r.alter)));
  h.appendChild(rootEl);
  const spec = suffixToKind(c.suffix);
  const kind = el(doc, "kind", spec.kind);
  kind.setAttribute("text", c.suffix);
  h.appendChild(kind);
  if (c.bass) {
    const b = stepAlter(c.bass);
    const bassEl = el(doc, "bass", [el(doc, "bass-step", b.step)]);
    if (b.alter) bassEl.appendChild(el(doc, "bass-alter", String(b.alter)));
    h.appendChild(bassEl);
  }
  for (const dg of spec.degrees ?? []) {
    h.appendChild(
      el(doc, "degree", [
        el(doc, "degree-value", String(dg.value)),
        el(doc, "degree-alter", String(dg.alter)),
        el(doc, "degree-type", dg.type),
      ]),
    );
  }
  return h;
}

function el(doc: Document, tag: string, content: string | Element[]): Element {
  const e = doc.createElement(tag);
  if (typeof content === "string") e.textContent = content;
  else e.append(...content);
  return e;
}

const KIND_SUFFIX: Record<string, string> = {
  major: "",
  minor: "m",
  augmented: "+",
  diminished: "dim",
  dominant: "7",
  "major-seventh": "maj7",
  "minor-seventh": "m7",
  "diminished-seventh": "dim7",
  "augmented-seventh": "+7",
  "half-diminished": "m7b5",
  "major-minor": "m(maj7)",
  "major-sixth": "6",
  "minor-sixth": "m6",
  "dominant-ninth": "9",
  "major-ninth": "maj9",
  "minor-ninth": "m9",
  "dominant-11th": "11",
  "major-11th": "maj11",
  "minor-11th": "m11",
  "dominant-13th": "13",
  "major-13th": "maj13",
  "minor-13th": "m13",
  "suspended-second": "sus2",
  "suspended-fourth": "sus4",
  power: "5",
  none: "N.C.",
  other: "",
};

/** Chord text of a <harmony> element ("" if it has no root). */
export function harmonyToText(h: Element): string {
  const kindEl = child(h, "kind");
  const kind = (kindEl?.textContent ?? "").trim();
  if (kind === "none") return kindEl?.getAttribute("text") || "N.C.";
  const root = child(h, "root");
  if (!root) return "";
  const step = childText(root, "root-step") ?? "";
  const alter = parseInt(childText(root, "root-alter") ?? "0", 10) || 0;
  let s = step + accSymbol(alter);
  const text = kindEl?.getAttribute("text");
  if (text != null && (text !== "" || kind === "major" || kind === "other")) {
    s += text;
  } else {
    s += KIND_SUFFIX[kind] ?? "";
    const degs = children(h, "degree").map((dg) => {
      const v = childText(dg, "degree-value") ?? "";
      const a = parseInt(childText(dg, "degree-alter") ?? "0", 10) || 0;
      const t = childText(dg, "degree-type");
      return (t === "subtract" ? "no" : "") + accSymbol(a) + v;
    });
    if (degs.length) s += "(" + degs.join(",") + ")";
  }
  const bass = child(h, "bass");
  if (bass) {
    const bs = childText(bass, "bass-step") ?? "";
    const ba = parseInt(childText(bass, "bass-alter") ?? "0", 10) || 0;
    s += "/" + bs + accSymbol(ba);
  }
  return s;
}
