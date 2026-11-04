import { XMLParser } from "fast-xml-parser";
import { midi, type Step } from "./pitch.js";

/**
 * Flatten a MusicXML score (first part, voice 1) into comparable token streams.
 * Used to measure OMR accuracy against a hand-checked fixture.
 */
export interface ScoreSummary {
  measures: number;
  /** "60:1" = MIDI 60 for 1 quarter; "r:0.5" = eighth rest. */
  notes: string[];
  /** Pitch-only stream (rests skipped). */
  pitches: number[];
  /** Chord symbols as root + kind, e.g. "Bb:dominant", "N.C.". */
  chords: string[];
}

type Node = Record<string, unknown>;
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@", preserveOrder: true, parseTagValue: false, trimValues: true });
const tagOf = (n: Node) => Object.keys(n).find((k) => k !== ":@") ?? "";
const kids = (n: Node | undefined): Node[] => (n && Array.isArray(n[tagOf(n)]) ? (n[tagOf(n)] as Node[]) : []);
const child = (n: Node | undefined, name: string) => kids(n).find((c) => tagOf(c) === name);
const text = (n: Node | undefined) => {
  const t = kids(n).find((c) => "#text" in c);
  return t ? String(t["#text"]) : "";
};

const ACC = (a: number) => (a > 0 ? "#".repeat(a) : "b".repeat(-a));

export function summarizeMusicXML(xml: string): ScoreSummary {
  const doc = parser.parse(xml) as Node[];
  const score = doc.find((n) => tagOf(n) === "score-partwise");
  const part = kids(score).find((n) => tagOf(n) === "part");
  const measures = kids(part).filter((n) => tagOf(n) === "measure");
  let divisions = 1;
  const out: ScoreSummary = { measures: measures.length, notes: [], pitches: [], chords: [] };
  for (const m of measures) {
    for (const c of kids(m)) {
      const tag = tagOf(c);
      if (tag === "attributes") {
        const d = Number(text(child(c, "divisions")));
        if (d > 0) divisions = d;
      } else if (tag === "harmony") {
        const kind = text(child(c, "kind"));
        if (kind === "none") {
          out.chords.push("N.C.");
          continue;
        }
        const root = child(c, "root");
        const alter = Number(text(child(root, "root-alter")) || 0);
        out.chords.push(`${text(child(root, "root-step"))}${ACC(alter)}:${kind}`);
      } else if (tag === "note") {
        if (child(c, "grace") || child(c, "chord")) continue;
        const voice = text(child(c, "voice")) || "1";
        if (voice !== "1") continue;
        const q = Math.round((Number(text(child(c, "duration"))) / divisions) * 1000) / 1000;
        const p = child(c, "pitch");
        if (p) {
          const v = midi({ step: text(child(p, "step")) as Step, alter: Number(text(child(p, "alter")) || 0), octave: Number(text(child(p, "octave"))) });
          out.notes.push(`${v}:${q}`);
          out.pitches.push(v);
        } else {
          out.notes.push(`r:${q}`);
        }
      }
    }
  }
  return out;
}

/** Length of the longest common subsequence. */
export function lcs<T>(a: T[], b: T[]): number {
  const dp = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let prev = 0;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]!;
      dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(dp[j]!, dp[j - 1]!);
      prev = tmp;
    }
  }
  return dp[b.length]!;
}

export interface Accuracy {
  measures: { expected: number; got: number };
  /** F1 of LCS over (pitch, duration) tokens incl. rests. */
  notesF1: number;
  pitchesF1: number;
  chordsF1: number;
}

const f1 = (common: number, expected: number, got: number) =>
  expected + got === 0 ? 1 : Math.round(((2 * common) / (expected + got)) * 1000) / 1000;

export function compareScores(expected: ScoreSummary, got: ScoreSummary): Accuracy {
  return {
    measures: { expected: expected.measures, got: got.measures },
    notesF1: f1(lcs(expected.notes, got.notes), expected.notes.length, got.notes.length),
    pitchesF1: f1(lcs(expected.pitches, got.pitches), expected.pitches.length, got.pitches.length),
    chordsF1: f1(lcs(expected.chords, got.chords), expected.chords.length, got.chords.length),
  };
}
