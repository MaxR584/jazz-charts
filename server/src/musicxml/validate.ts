import { XMLParser } from "fast-xml-parser";
import type { LeadSheet, Warning } from "../../../shared/types.js";
import { measureQuarters, noteQuarters, QUARTERS } from "./builder.js";
import { parseChordSymbol } from "./chords.js";
import { midi, parsePitch, type Pitch } from "./pitch.js";

/** Sane written range for a lead-sheet melody per clef (inclusive MIDI numbers). */
export const RANGES = {
  treble: { low: 55, high: 86, label: "G3–D6" }, // G3..D6
  bass: { low: 36, high: 67, label: "C2–G4" },
} as const;

const EPS = 1e-6;

function fmt(q: number): string {
  return `${Math.round(q * 1000) / 1000} beats(quarter)`;
}

/** Validate a LeadSheet transcription. Returns warnings; never throws. */
export function validateLeadSheet(sheet: LeadSheet): Warning[] {
  const warnings: Warning[] = [];
  const expected = measureQuarters(sheet.time);
  const range = RANGES[sheet.clef] ?? RANGES.treble;

  if (!sheet.measures?.length) {
    warnings.push({ measure: null, code: "other", message: "No measures recognized." });
    return warnings;
  }

  let prevNote: { pitch: Pitch | null; tie: boolean; measure: number } | null = null;

  sheet.measures.forEach((m, idx) => {
    const notes = m.notes ?? [];
    // Durations
    if (notes.length > 0) {
      for (const n of notes) {
        if (!(n.duration in QUARTERS)) {
          warnings.push({ measure: m.number, code: "other", message: `Unknown duration "${n.duration}".` });
        }
      }
      const total = notes.reduce((s, n) => s + noteQuarters(n), 0);
      const isPickup = m.implicit && (idx === 0 || idx === sheet.measures.length - 1);
      if (m.implicit) {
        if (total > expected + EPS) {
          warnings.push({
            measure: m.number,
            code: "duration_mismatch",
            message: `Pickup measure is longer than the time signature (${fmt(total)} > ${fmt(expected)}).`,
          });
        }
        if (!isPickup) {
          warnings.push({ measure: m.number, code: "other", message: "Incomplete (implicit) measure in the middle of the tune." });
        }
      } else if (Math.abs(total - expected) > EPS) {
        warnings.push({
          measure: m.number,
          code: "duration_mismatch",
          message: `Notes add up to ${fmt(total)}, expected ${fmt(expected)}.`,
        });
      }
    }

    // Chords
    for (const c of m.chords ?? []) {
      const r = parseChordSymbol(c.symbol);
      if (!r.ok) {
        warnings.push({ measure: m.number, code: "unparsed_chord", message: `Chord "${c.symbol}": ${r.reason}.` });
      }
      if (!(c.beat >= 1 && c.beat < sheet.time.beats + 1)) {
        warnings.push({ measure: m.number, code: "other", message: `Chord "${c.symbol}" is on beat ${c.beat}, outside the measure.` });
      }
    }

    // Pitches and ties
    for (const n of notes) {
      let p: Pitch | null = null;
      if (!n.rest) {
        if (!n.pitch) {
          warnings.push({ measure: m.number, code: "other", message: "Note without pitch (and not a rest)." });
        } else {
          p = parsePitch(n.pitch);
          if (!p) {
            warnings.push({ measure: m.number, code: "other", message: `Cannot read pitch "${n.pitch}".` });
          } else {
            const v = midi(p);
            if (v < range.low || v > range.high) {
              warnings.push({
                measure: m.number,
                code: "pitch_out_of_range",
                message: `${n.pitch} is outside the usual ${sheet.clef} range (${range.label}).`,
              });
            }
          }
        }
      }
      const tieStops = n.tie === "stop" || n.tie === "both";
      if (tieStops && (!prevNote || !prevNote.tie || !p || !prevNote.pitch || midi(prevNote.pitch) !== midi(p))) {
        warnings.push({ measure: m.number, code: "other", message: "Tie end without a matching tie start on the same pitch." });
      }
      if (prevNote?.tie && !tieStops) {
        warnings.push({ measure: prevNote.measure, code: "other", message: "Tie start is not followed by a tied note." });
      }
      prevNote = { pitch: p, tie: n.tie === "start" || n.tie === "both", measure: m.number };
    }
  });

  warnings.push(...checkRepeats(sheet.measures.map((m) => ({
    number: m.number,
    forward: m.barlineLeft === "repeat-forward",
    backward: m.barlineRight === "repeat-backward",
    endingStart: m.ending?.type === "start",
    endingStop: m.ending?.type === "stop" || m.ending?.type === "discontinue",
  })), false));
  return warnings;
}

interface RepeatInfo {
  number: number;
  forward: boolean;
  backward: boolean;
  endingStart: boolean;
  endingStop: boolean;
}

/**
 * Repeat balance: every forward repeat needs a later backward repeat; a backward
 * repeat without a forward one is fine once (repeat from the start). With
 * `strictEndings`, ending starts must be closed explicitly (MusicXML input); for
 * LeadSheet JSON the builder closes them implicitly, so only orphan stops warn.
 */
export function checkRepeats(measures: RepeatInfo[], strictEndings: boolean): Warning[] {
  const warnings: Warning[] = [];
  let open: number | null = null;
  let implicitStartUsed = false;
  let endingOpen: number | null = null;
  for (const m of measures) {
    if (m.forward) {
      if (open !== null) {
        warnings.push({ measure: m.number, code: "unbalanced_repeat", message: `Forward repeat while the repeat from measure ${open} is still open.` });
      }
      open = m.number;
    }
    if (m.endingStart) {
      if (strictEndings && endingOpen !== null) {
        warnings.push({ measure: m.number, code: "unbalanced_repeat", message: `Ending starts before the ending from measure ${endingOpen} was closed.` });
      }
      endingOpen = m.number;
    }
    if (m.endingStop) {
      if (endingOpen === null) {
        warnings.push({ measure: m.number, code: "unbalanced_repeat", message: "Ending stop without an ending start." });
      }
      endingOpen = null;
    }
    if (m.backward) {
      if (open !== null) open = null;
      else if (!implicitStartUsed) implicitStartUsed = true;
      else warnings.push({ measure: m.number, code: "unbalanced_repeat", message: "Backward repeat without a matching forward repeat." });
    }
  }
  if (open !== null) {
    warnings.push({ measure: open, code: "unbalanced_repeat", message: "Forward repeat is never closed by a backward repeat." });
  }
  if (strictEndings && endingOpen !== null) {
    warnings.push({ measure: endingOpen, code: "unbalanced_repeat", message: "Ending is never closed." });
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// MusicXML-level validation (used for engines that return MusicXML directly, e.g. Audiveris)

type Node = Record<string, unknown>;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  preserveOrder: true,
  parseTagValue: false,
  trimValues: true,
});

function tagOf(n: Node): string {
  return Object.keys(n).find((k) => k !== ":@") ?? "";
}
function kids(n: Node): Node[] {
  const v = n[tagOf(n)];
  return Array.isArray(v) ? (v as Node[]) : [];
}
function attr(n: Node, name: string): string | undefined {
  const a = n[":@"] as Record<string, string> | undefined;
  return a?.[`@${name}`];
}
function child(n: Node, name: string): Node | undefined {
  return kids(n).find((c) => tagOf(c) === name);
}
function text(n: Node | undefined): string {
  if (!n) return "";
  const t = kids(n).find((c) => "#text" in c);
  return t ? String(t["#text"]) : "";
}

/**
 * Parse-level checks on a MusicXML score: well-formed score-partwise, per-measure
 * durations (first part), melody range, repeats, and presence of chord symbols.
 */
export function validateMusicXML(xml: string): Warning[] {
  const warnings: Warning[] = [];
  let doc: Node[];
  try {
    doc = parser.parse(xml) as Node[];
  } catch (e) {
    return [{ measure: null, code: "other", message: `MusicXML could not be parsed: ${(e as Error).message}` }];
  }
  const root = doc.find((n) => tagOf(n) === "score-partwise");
  if (!root) return [{ measure: null, code: "other", message: "Not a score-partwise MusicXML document." }];
  const parts = kids(root).filter((n) => tagOf(n) === "part");
  if (!parts.length) return [{ measure: null, code: "other", message: "Score has no parts." }];

  const part = parts[0]!;
  let divisions = 1;
  let beats = 4;
  let beatType = 4;
  let clef: "treble" | "bass" = "treble";
  let harmonyCount = 0;
  const repeats: RepeatInfo[] = [];
  const measures = kids(part).filter((n) => tagOf(n) === "measure");

  measures.forEach((m, idx) => {
    const num = Number.parseInt(attr(m, "number") ?? "", 10);
    const number = Number.isFinite(num) ? num : idx + 1;
    let cursor = 0;
    let maxPos = 0;
    let lastDur = 0;
    const info: RepeatInfo = { number, forward: false, backward: false, endingStart: false, endingStop: false };
    for (const c of kids(m)) {
      const tag = tagOf(c);
      if (tag === "attributes") {
        const d = Number(text(child(c, "divisions")));
        if (d > 0) divisions = d;
        const t = child(c, "time");
        if (t) {
          beats = Number(text(child(t, "beats"))) || beats;
          beatType = Number(text(child(t, "beat-type"))) || beatType;
        }
        const cl = child(c, "clef");
        if (cl) clef = text(child(cl, "sign")) === "F" ? "bass" : "treble";
      } else if (tag === "harmony") {
        harmonyCount++;
      } else if (tag === "note") {
        if (child(c, "grace")) continue;
        const dur = Number(text(child(c, "duration"))) || 0;
        if (child(c, "chord")) {
          maxPos = Math.max(maxPos, cursor - lastDur + dur);
          continue;
        }
        cursor += dur;
        lastDur = dur;
        maxPos = Math.max(maxPos, cursor);
        const p = child(c, "pitch");
        if (p && (text(child(c, "voice")) || "1") === "1") {
          const step = text(child(p, "step"));
          const alter = Number(text(child(p, "alter")) || 0);
          const octave = Number(text(child(p, "octave")));
          const v = midi({ step: step as Pitch["step"], alter, octave });
          const range = RANGES[clef];
          if (Number.isFinite(v) && (v < range.low || v > range.high)) {
            warnings.push({ measure: number, code: "pitch_out_of_range", message: `${step}${alter > 0 ? "#".repeat(alter) : "b".repeat(-alter)}${octave} is outside the usual ${clef} range (${range.label}).` });
          }
        }
      } else if (tag === "backup") {
        cursor -= Number(text(child(c, "duration"))) || 0;
      } else if (tag === "forward") {
        cursor += Number(text(child(c, "duration"))) || 0;
        maxPos = Math.max(maxPos, cursor);
      } else if (tag === "barline") {
        const rep = child(c, "repeat");
        if (rep && attr(rep, "direction") === "forward") info.forward = true;
        if (rep && attr(rep, "direction") === "backward") info.backward = true;
        const end = child(c, "ending");
        if (end && attr(end, "type") === "start") info.endingStart = true;
        if (end && (attr(end, "type") === "stop" || attr(end, "type") === "discontinue")) info.endingStop = true;
      }
    }
    repeats.push(info);
    const expected = (beats * 4 * divisions) / beatType;
    const implicit = attr(m, "implicit") === "yes";
    const hasNotes = kids(m).some((c) => tagOf(c) === "note");
    if (hasNotes && !implicit && Math.abs(maxPos - expected) > EPS) {
      warnings.push({
        measure: number,
        code: "duration_mismatch",
        message: `Measure lasts ${fmt(maxPos / divisions)}, expected ${fmt(expected / divisions)}.`,
      });
    } else if (hasNotes && implicit && maxPos > expected + EPS) {
      warnings.push({ measure: number, code: "duration_mismatch", message: "Pickup measure is longer than the time signature." });
    }
  });

  warnings.push(...checkRepeats(repeats, true));
  if (harmonyCount === 0) {
    warnings.push({ measure: null, code: "low_confidence", message: "No chord symbols were recognized; add them in the editor." });
  }
  if (parts.length > 1) {
    warnings.push({ measure: null, code: "other", message: `Score has ${parts.length} parts; the lead sheet is expected in the first one.` });
  }
  return warnings;
}

