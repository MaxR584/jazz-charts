// Editing operations on the MusicXML DOM (the source of truth).
import { buildHarmony, harmonyToText } from "./chords";
import { pitchMidi, readPitch, regenerateAccidentals, spellMidi, writePitch } from "./pitch";
import { child, childText, children, divisionsPerMeasure, measureInfos, timedContents } from "./xml";

export interface ChordAt {
  el: Element;
  text: string;
  /** 1-based beat in quarter notes. */
  beat: number;
}

export function measureChords(doc: Document, measureIndex: number): ChordAt[] {
  const m = measureInfos(doc)[measureIndex];
  if (!m) return [];
  const divs = divisionsPerMeasure(doc)[measureIndex];
  return timedContents(m.el, divs)
    .harmonies.map((h) => ({ el: h.el, text: harmonyToText(h.el), beat: h.onset + 1 }))
    .sort((a, b) => a.beat - b.beat);
}

/** Replace a chord's text. Empty text deletes it. Throws on unparseable text. */
export function setChordText(doc: Document, harmony: Element, text: string): void {
  if (!text.trim()) {
    harmony.parentNode?.removeChild(harmony);
    return;
  }
  const h = buildHarmony(doc, text);
  if (!h) throw new Error(`Can't read chord "${text}"`);
  // Keep position-related children/attributes of the original.
  const offset = child(harmony, "offset");
  if (offset) h.appendChild(offset.cloneNode(true));
  for (const a of ["placement", "print-frame", "default-y"]) {
    const v = harmony.getAttribute(a);
    if (v != null) h.setAttribute(a, v);
  }
  harmony.parentNode?.replaceChild(h, harmony);
}

/** Add a chord at a 1-based beat (quarter-note beats) of a measure. */
export function addChord(doc: Document, measureIndex: number, beat: number, text: string): Element {
  const m = measureInfos(doc)[measureIndex];
  if (!m) throw new Error("No such measure");
  const h = buildHarmony(doc, text);
  if (!h) throw new Error(`Can't read chord "${text}"`);
  const divs = divisionsPerMeasure(doc)[measureIndex];
  const { notes, harmonies, divisions } = timedContents(m.el, divs);
  const target = Math.max(0, beat - 1);
  // Replace an existing chord on the same beat.
  const same = harmonies.find((x) => Math.abs(x.onset - target) < 1e-6);
  if (same) {
    setChordText(doc, same.el, text);
    return h;
  }
  const voice1 = notes.filter((n) => n.chordIndex === 0 && n.voice === (notes[0]?.voice ?? "1"));
  let anchor: Element | null = null;
  let offset = 0;
  for (let i = 0; i < voice1.length; i++) {
    const n = voice1[i];
    const dur = (parseFloat(childText(n.el, "duration") ?? "0") || 0) / divisions;
    if (Math.abs(n.onset - target) < 1e-6) {
      anchor = n.el;
      break;
    }
    if (n.onset < target && target < n.onset + dur) {
      anchor = n.el;
      offset = (target - n.onset) * divisions;
      break;
    }
  }
  if (offset) {
    const o = doc.createElement("offset");
    o.textContent = String(Math.round(offset));
    h.appendChild(o);
  }
  // Harmonies go before the note (and before an existing harmony attached to it).
  let before: Element | null = anchor;
  // (a chord with an offset goes right before the note, after the chord on the note's own beat)
  while (!offset && before && before.previousElementSibling?.tagName === "harmony") before = before.previousElementSibling;
  if (before) m.el.insertBefore(h, before);
  else {
    // after attributes/directions at the start, else at the end
    m.el.appendChild(h);
  }
  return h;
}

export function fifthsAtMeasure(doc: Document, measureIndex: number): number {
  let f = 0;
  for (const m of measureInfos(doc).slice(0, measureIndex + 1)) {
    for (const a of children(m.el, "attributes")) {
      const key = child(a, "key");
      const t = key && childText(key, "fifths");
      if (t != null) f = parseInt(t, 10) || 0;
    }
  }
  return f;
}

/** Move a note up/down by semitones, spelled for the key; accidentals are regenerated. */
export function shiftNote(doc: Document, note: Element, measureIndex: number, semitones: number): boolean {
  const p = readPitch(note);
  if (!p) return false;
  const midi = pitchMidi(p) + semitones;
  if (midi < 21 || midi > 108) return false;
  const np = spellMidi(midi, fifthsAtMeasure(doc, measureIndex), semitones > 0 ? 1 : -1);
  // Tied notes move together.
  const part = note.closest("part");
  const all = part ? Array.from(part.getElementsByTagName("note")) : [note];
  const group = [note];
  const same = (a: Element) => {
    const q = readPitch(a);
    return !!q && q.step === p.step && q.alter === p.alter && q.octave === p.octave;
  };
  const tie = (a: Element, t: string) => children(a, "tie").some((x) => x.getAttribute("type") === t);
  const i = all.indexOf(note);
  for (let j = i + 1; j < all.length && tie(group[group.length - 1], "start"); j++) {
    if (same(all[j]) && tie(all[j], "stop")) group.push(all[j]);
  }
  for (let j = i - 1; j >= 0 && tie(group[0], "stop"); j--) {
    if (same(all[j]) && tie(all[j], "start")) group.unshift(all[j]);
  }
  for (const n of group) writePitch(n, np);
  regenerateAccidentals(doc);
  return true;
}

/** The pitched notes of a measure in document order, by key "voice|onset|chordIndex". */
export function measureNotes(doc: Document, measureIndex: number) {
  const m = measureInfos(doc)[measureIndex];
  if (!m) return [];
  const divs = divisionsPerMeasure(doc)[measureIndex];
  return timedContents(m.el, divs).notes;
}
