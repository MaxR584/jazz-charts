import type { DurationCode, LeadSheet, LeadSheetMeasure, LeadSheetNote } from "../../../shared/types.js";
import { parseChordSymbol, type ChordRoot, type ParsedChord } from "./chords.js";
import { accidentalName, keyAlters, parsePitch, type Step } from "./pitch.js";
import { el, empty, wrap } from "./xml.js";

/** Quarter-note lengths of each duration code. */
export const QUARTERS: Record<DurationCode, number> = { w: 4, h: 2, q: 1, "8": 0.5, "16": 0.25, "32": 0.125 };

const TYPE_NAME: Record<DurationCode, string> = {
  w: "whole",
  h: "half",
  q: "quarter",
  "8": "eighth",
  "16": "16th",
  "32": "32nd",
};

export const DEFAULT_DIVISIONS = 12;

/** Length of a note in quarter notes (dots and tuplets applied). */
export function noteQuarters(n: LeadSheetNote): number {
  const base = QUARTERS[n.duration] ?? 1;
  const dots = Math.max(0, Math.min(3, n.dots ?? 0));
  let q = base * (2 - 1 / 2 ** dots);
  if (n.tuplet && n.tuplet.actual > 0 && n.tuplet.normal > 0) q = (q * n.tuplet.normal) / n.tuplet.actual;
  return q;
}

/** Expected measure length in quarter notes. */
export function measureQuarters(time: { beats: number; beatType: number }): number {
  return (time.beats * 4) / time.beatType;
}

/**
 * Divisions per quarter. 12 covers 8ths, 16ths and triplets; doubled as needed for
 * 32nds or dotted 16ths so every <duration> is an integer.
 */
export function chooseDivisions(sheet: LeadSheet): number {
  let d = DEFAULT_DIVISIONS;
  const all = sheet.measures.flatMap((m) => m.notes ?? []);
  for (let i = 0; i < 6; i++) {
    if (all.every((n) => Number.isInteger(Math.round(noteQuarters(n) * d * 1e6) / 1e6))) return d;
    d *= 2;
  }
  return d;
}

function ticks(n: LeadSheetNote, divisions: number): number {
  return Math.round(noteQuarters(n) * divisions);
}

function rootXml(prefix: "root" | "bass", r: ChordRoot): string {
  const children = [el(`${prefix}-step`, r.step)];
  if (r.alter !== 0) children.push(el(`${prefix}-alter`, r.alter));
  return wrap(prefix, children);
}

export function harmonyXml(chord: ParsedChord, offsetTicks: number): string {
  const children: string[] = [];
  if (chord.root) children.push(rootXml("root", chord.root));
  else children.push(wrap("root", [el("root-step", "C", { text: "" })])); // N.C.: root required by schema
  children.push(el("kind", chord.kind, { text: chord.text }));
  if (chord.bass) children.push(rootXml("bass", chord.bass));
  // The kind's text already spells the whole suffix (e.g. "7b9"), so degrees are
  // structural only (transposition, playback) and must not be printed again.
  const degreeAttrs = chord.text ? { "print-object": "no" } : undefined;
  for (const d of chord.degrees) {
    children.push(
      wrap("degree", [el("degree-value", d.value), el("degree-alter", d.alter), el("degree-type", d.type)], degreeAttrs),
    );
  }
  if (offsetTicks !== 0) children.push(el("offset", offsetTicks));
  return wrap("harmony", children, chord.kind === "none" ? { "print-frame": "no" } : undefined);
}

function chordXml(symbol: string, offsetTicks: number): string {
  const r = parseChordSymbol(symbol);
  if (r.ok) return harmonyXml(r.chord, offsetTicks);
  if (r.partial) return harmonyXml(r.partial, offsetTicks); // kind="other" keeps the text visible
  // No root at all: show it as plain text above the staff.
  const dir = [wrap("direction-type", [el("words", symbol)])];
  if (offsetTicks !== 0) dir.push(el("offset", offsetTicks));
  return wrap("direction", dir, { placement: "above" });
}

function endingNumber(n: string): string {
  const nums = (n.match(/[1-9]\d*/g) ?? []).join(", ");
  return nums || "1";
}

interface EndingMarks {
  left: Map<number, string>; // measure index → number (start)
  right: Map<number, { number: string; type: "stop" | "discontinue" }>;
}

/**
 * Resolve the per-measure `ending` hints into explicit start/stop pairs.
 * An ending runs from its "start" measure until an explicit stop/discontinue, a
 * backward repeat (stop), a final/double barline or the next ending (discontinue),
 * or the end of the piece.
 */
export function resolveEndings(measures: LeadSheetMeasure[]): EndingMarks {
  const left = new Map<number, string>();
  const right = new Map<number, { number: string; type: "stop" | "discontinue" }>();
  let open: { number: string } | null = null;
  const close = (i: number, type: "stop" | "discontinue") => {
    if (open) right.set(i, { number: open.number, type });
    open = null;
  };
  measures.forEach((m, i) => {
    const e = m.ending;
    if (e?.type === "start") {
      if (open) close(i - 1, measures[i - 1]?.barlineRight === "repeat-backward" ? "stop" : "discontinue");
      open = { number: endingNumber(e.number) };
      left.set(i, open.number);
    } else if (e && (e.type === "stop" || e.type === "discontinue")) {
      if (open) close(i, e.type);
      else right.set(i, { number: endingNumber(e.number), type: e.type }); // orphan; validator warns
    }
    if (open) {
      if (m.barlineRight === "repeat-backward") close(i, "stop");
      else if (m.barlineRight === "final" || m.barlineRight === "double") close(i, "discontinue");
    }
  });
  if (open) close(measures.length - 1, "discontinue");
  return { left, right };
}

const START_NAV = new Set(["segno", "coda"]);

function navigationXml(nav: NonNullable<LeadSheetMeasure["navigation"]>): string {
  switch (nav) {
    case "segno":
      return wrap("direction", [wrap("direction-type", [empty("segno")]), empty("sound", { segno: "segno" })], {
        placement: "above",
      });
    case "coda":
      return wrap("direction", [wrap("direction-type", [empty("coda")]), empty("sound", { coda: "coda" })], {
        placement: "above",
      });
    case "D.S. al Coda":
      return words(nav, { dalsegno: "segno" });
    case "D.C. al Fine":
      return words(nav, { dacapo: "yes" });
    case "Fine":
      return words(nav, { fine: "yes" });
    case "To Coda":
      return words(nav, { tocoda: "coda" });
    default:
      return words(String(nav), null);
  }
}

function words(text: string, sound: Record<string, string> | null): string {
  const children = [wrap("direction-type", [el("words", text)])];
  if (sound) children.push(empty("sound", sound));
  return wrap("direction", children, { placement: "above" });
}

type BeamValue = "begin" | "continue" | "end" | "forward hook" | "backward hook";

/**
 * Simple beaming: consecutive pitched 8ths/16ths/32nds inside one beat (a dotted
 * quarter in compound meters) share a beam; 16ths get a second beam level.
 */
export function computeBeams(notes: LeadSheetNote[], divisions: number, time: { beats: number; beatType: number }): { number: number; value: BeamValue }[][] {
  const compound = time.beatType === 8 && time.beats % 3 === 0 && time.beats > 3;
  const beatTicks = compound ? Math.round(1.5 * divisions) : Math.round((divisions * 4) / time.beatType);
  const out: { number: number; value: BeamValue }[][] = notes.map(() => []);
  const level = (n: LeadSheetNote) => (n.rest || !n.pitch ? 0 : n.duration === "8" ? 1 : n.duration === "16" ? 2 : n.duration === "32" ? 3 : 0);
  let pos = 0;
  const groups: number[][] = [];
  let cur: number[] = [];
  let curBeat = -1;
  notes.forEach((n, i) => {
    const beat = Math.floor(pos / beatTicks);
    if (level(n) > 0 && beat === curBeat && cur.length > 0) cur.push(i);
    else {
      if (cur.length > 1) groups.push(cur);
      cur = level(n) > 0 ? [i] : [];
      curBeat = beat;
    }
    pos += ticks(n, divisions);
    // A note running past the beat boundary ends the group.
    if (Math.floor((pos - 1) / beatTicks) !== beat) {
      if (cur.length > 1) groups.push(cur);
      cur = [];
      curBeat = -1;
    }
  });
  if (cur.length > 1) groups.push(cur);
  for (const g of groups) {
    for (let lv = 1; lv <= 3; lv++) {
      g.forEach((idx, k) => {
        if (level(notes[idx]!) < lv) return;
        if (lv === 1) {
          out[idx]!.push({ number: 1, value: k === 0 ? "begin" : k === g.length - 1 ? "end" : "continue" });
          return;
        }
        const prev = k > 0 && level(notes[g[k - 1]!]!) >= lv;
        const next = k < g.length - 1 && level(notes[g[k + 1]!]!) >= lv;
        const value: BeamValue = prev && next ? "continue" : prev ? "end" : next ? "begin" : k === 0 ? "forward hook" : "backward hook";
        out[idx]!.push({ number: lv, value });
      });
    }
  }
  return out;
}

/** Build one measure's <note> elements plus harmony insertion points. */
function notesXml(
  m: LeadSheetMeasure,
  sheet: LeadSheet,
  divisions: number,
): string[] {
  const expected = Math.round(measureQuarters(sheet.time) * divisions);
  const notes = m.notes ?? [];
  const ticksPerBeat = (divisions * 4) / sheet.time.beatType;
  const chords = [...(m.chords ?? [])]
    .map((c) => ({ symbol: c.symbol, pos: Math.max(0, Math.round((Number(c.beat) - 1) * ticksPerBeat)) }))
    .sort((a, b) => a.pos - b.pos);

  const out: string[] = [];
  const isMeasureRest = notes.length === 0 || (notes.length === 1 && notes[0]!.rest && !m.implicit && (m.slash || ticks(notes[0]!, divisions) === expected));

  if (isMeasureRest) {
    for (const c of chords) out.push(chordXml(c.symbol, c.pos));
    out.push(
      wrap("note", [empty("rest", { measure: "yes" }), el("duration", m.implicit && notes[0] ? ticks(notes[0], divisions) : expected), el("voice", 1)]),
    );
    return out;
  }

  const beams = computeBeams(notes, divisions, sheet.time);
  const keyAlt = keyAlters(sheet.key.fifths);
  const state = new Map<string, number>(); // "F4" → current alter in this measure
  let pos = 0;
  let ci = 0;
  let tuplet: { actual: number; normal: number; sum: number; minBase: number } | null = null;

  notes.forEach((n, idx) => {
    const dur = ticks(n, divisions);
    const isLast = idx === notes.length - 1;
    // Chords that start inside this note (or after the last note) go before it.
    while (ci < chords.length && (chords[ci]!.pos < pos + dur || isLast)) {
      out.push(chordXml(chords[ci]!.symbol, chords[ci]!.pos - pos));
      ci++;
    }

    const children: string[] = [];
    const pitch = !n.rest && n.pitch ? parsePitch(n.pitch) : null;
    if (pitch) {
      const p = [el("step", pitch.step)];
      if (pitch.alter !== 0) p.push(el("alter", pitch.alter));
      p.push(el("octave", pitch.octave));
      children.push(wrap("pitch", p));
    } else {
      children.push(empty("rest"));
    }
    children.push(el("duration", dur));
    const tie = pitch ? n.tie ?? null : null;
    if (tie === "stop" || tie === "both") children.push(empty("tie", { type: "stop" }));
    if (tie === "start" || tie === "both") children.push(empty("tie", { type: "start" }));
    children.push(el("voice", 1));
    children.push(el("type", TYPE_NAME[n.duration] ?? "quarter"));
    for (let d = 0; d < Math.min(3, n.dots ?? 0); d++) children.push(empty("dot"));

    if (pitch) {
      const k = `${pitch.step}${pitch.octave}`;
      const current = state.get(k) ?? keyAlt[pitch.step as Step];
      if (current !== pitch.alter && tie !== "stop" && tie !== "both") {
        children.push(el("accidental", accidentalName(pitch.alter)));
      }
      state.set(k, pitch.alter);
    }

    const timeMod: string[] = [];
    const notations: string[] = [];
    if (tie === "stop" || tie === "both") notations.push(empty("tied", { type: "stop" }));
    if (tie === "start" || tie === "both") notations.push(empty("tied", { type: "start" }));

    if (n.tuplet && n.tuplet.actual > 0 && n.tuplet.normal > 0) {
      timeMod.push(
        wrap("time-modification", [el("actual-notes", n.tuplet.actual), el("normal-notes", n.tuplet.normal)]),
      );
      const base = Math.round(QUARTERS[n.duration] * divisions);
      const same = tuplet && tuplet.actual === n.tuplet.actual && tuplet.normal === n.tuplet.normal;
      if (!same) {
        if (tuplet) closeTuplet(out);
        tuplet = { actual: n.tuplet.actual, normal: n.tuplet.normal, sum: 0, minBase: base };
        notations.push(empty("tuplet", { type: "start", bracket: "yes" }));
      }
      const t = tuplet!;
      t.sum += dur;
      t.minBase = Math.min(t.minBase, base);
      const next = notes[idx + 1];
      const nextContinues = next?.tuplet && next.tuplet.actual === t.actual && next.tuplet.normal === t.normal;
      if (t.sum % (t.normal * t.minBase) === 0 || !nextContinues) {
        notations.push(empty("tuplet", { type: "stop" }));
        tuplet = null;
      }
    } else if (tuplet) {
      closeTuplet(out);
      tuplet = null;
    }

    children.push(...timeMod);
    for (const b of beams[idx]!) children.push(el("beam", b.value, { number: b.number }));
    if (notations.length) children.push(wrap("notations", notations));
    out.push(wrap("note", children));
    pos += dur;
  });
  return out;
}

/** Defensive: add a tuplet stop to the previous note if a group was left open. */
function closeTuplet(out: string[]): void {
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i]!.startsWith("<note>")) {
      const stop = empty("tuplet", { type: "stop" });
      out[i] = out[i]!.includes("<notations>")
        ? out[i]!.replace("</notations>", `${stop}</notations>`)
        : out[i]!.replace("</note>", `<notations>${stop}</notations></note>`);
      return;
    }
  }
}

export interface BuildOptions {
  /** Pretty-print with 2-space indentation (default true). */
  pretty?: boolean;
  software?: string;
}

/** Pure function: LeadSheet JSON → MusicXML 4.0 score-partwise string. */
export function buildMusicXML(sheet: LeadSheet, opts: BuildOptions = {}): string {
  const divisions = chooseDivisions(sheet);
  const measures = sheet.measures;
  const endings = resolveEndings(measures);
  const parts: string[] = [];

  measures.forEach((m, i) => {
    const children: string[] = [];
    const isLast = i === measures.length - 1;

    // Left barline (repeat start and/or ending start)
    const leftEnding = endings.left.get(i);
    if (m.barlineLeft === "repeat-forward" || leftEnding) {
      const b: string[] = [];
      if (m.barlineLeft === "repeat-forward") b.push(el("bar-style", "heavy-light"));
      if (leftEnding) b.push(el("ending", `${leftEnding}.`, { number: leftEnding, type: "start" }));
      if (m.barlineLeft === "repeat-forward") b.push(empty("repeat", { direction: "forward" }));
      children.push(wrap("barline", b, { location: "left" }));
    }

    // Attributes
    const attrs: string[] = [];
    if (i === 0) {
      attrs.push(el("divisions", divisions));
      attrs.push(wrap("key", [el("fifths", sheet.key.fifths), el("mode", sheet.key.mode)]));
      attrs.push(wrap("time", [el("beats", sheet.time.beats), el("beat-type", sheet.time.beatType)]));
      attrs.push(
        wrap("clef", sheet.clef === "bass" ? [el("sign", "F"), el("line", 4)] : [el("sign", "G"), el("line", 2)]),
      );
    }
    const prevSlash = i > 0 && !!measures[i - 1]!.slash;
    if (!!m.slash !== prevSlash) {
      attrs.push(
        wrap("measure-style", [
          empty("slash", m.slash ? { type: "start", "use-stems": "no" } : { type: "stop" }),
        ]),
      );
    }
    if (attrs.length) children.push(wrap("attributes", attrs));

    if (m.rehearsal) {
      children.push(
        wrap("direction", [wrap("direction-type", [el("rehearsal", m.rehearsal)])], { placement: "above" }),
      );
    }
    if (m.navigation && START_NAV.has(m.navigation)) children.push(navigationXml(m.navigation));

    children.push(...notesXml(m, sheet, divisions));

    if (m.navigation && !START_NAV.has(m.navigation)) children.push(navigationXml(m.navigation));

    // Right barline
    const rightEnding = endings.right.get(i);
    const barRight = m.barlineRight ?? (isLast ? "final" : null);
    if (barRight || rightEnding) {
      const b: string[] = [];
      if (barRight === "repeat-backward" || barRight === "final") b.push(el("bar-style", "light-heavy"));
      else if (barRight === "double") b.push(el("bar-style", "light-light"));
      if (rightEnding) b.push(empty("ending", { number: rightEnding.number, type: rightEnding.type }));
      if (barRight === "repeat-backward") b.push(empty("repeat", { direction: "backward" }));
      children.push(wrap("barline", b, { location: "right" }));
    }

    parts.push(wrap("measure", children, { number: m.number, implicit: m.implicit ? "yes" : undefined }));
  });

  const header: string[] = [];
  header.push(wrap("work", [el("work-title", sheet.title || "Untitled")]));
  const ident: string[] = [];
  if (sheet.composer) ident.push(el("creator", sheet.composer, { type: "composer" }));
  ident.push(wrap("encoding", [el("software", opts.software ?? "jazz-charts")]));
  header.push(wrap("identification", ident));
  header.push(wrap("part-list", [wrap("score-part", [el("part-name", "Lead")], { id: "P1" })]));

  const body = wrap("score-partwise", [...header, wrap("part", parts, { id: "P1" })], { version: "4.0" });
  const xml =
    `<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n` +
    `<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">\n` +
    (opts.pretty === false ? body : prettyPrint(body)) +
    "\n";
  return xml;
}

/**
 * Indent our own generated XML (no mixed content: an element has either text or
 * child elements). Not a general-purpose formatter.
 */
export function prettyPrint(xml: string): string {
  const tokens = xml.match(/<[^>]+>[^<]*/g) ?? [];
  const lines: string[] = [];
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    const tag = tok.slice(0, tok.indexOf(">") + 1);
    const text = tok.slice(tag.length);
    if (tag.startsWith("</")) {
      depth--;
      lines.push("  ".repeat(depth) + tag);
    } else if (tag.endsWith("/>")) {
      lines.push("  ".repeat(depth) + tag);
    } else {
      const next = tokens[i + 1];
      // <a>text</a> on one line
      if (next && next.startsWith("</") && next.slice(2, next.indexOf(">")) === tagName(tag)) {
        lines.push("  ".repeat(depth) + tag + text + next.slice(0, next.indexOf(">") + 1));
        i++;
      } else {
        lines.push("  ".repeat(depth) + tag);
        depth++;
      }
    }
  }
  return lines.join("\n");
}

function tagName(openTag: string): string {
  return /^<([^\s/>]+)/.exec(openTag)![1]!;
}

