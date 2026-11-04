// Small MusicXML DOM helpers. Pure (no OSMD), usable in vitest/jsdom and the browser.
import { unzipSync, strFromU8 } from "fflate";

export const XML_DECL = '<?xml version="1.0" encoding="UTF-8"?>\n';

export class MusicXmlError extends Error {}

export function parseMusicXml(xml: string): Document {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const err = doc.getElementsByTagName("parsererror")[0];
  if (err) throw new MusicXmlError("This file is not valid XML: " + (err.textContent ?? "").trim().slice(0, 200));
  const root = doc.documentElement;
  if (root.tagName === "score-timewise") {
    throw new MusicXmlError("score-timewise MusicXML is not supported; please export as score-partwise.");
  }
  if (root.tagName !== "score-partwise") {
    throw new MusicXmlError(`Not a MusicXML score (root element <${root.tagName}>).`);
  }
  return doc;
}

export function serializeMusicXml(doc: Document): string {
  let s = new XMLSerializer().serializeToString(doc);
  s = s.replace(/^<\?xml[^>]*\?>\s*/, "");
  return XML_DECL + s;
}

/** Extract the score from a compressed .mxl (zip) file. */
export function unzipMxl(data: Uint8Array): string {
  const files = unzipSync(data);
  let path: string | undefined;
  const container = files["META-INF/container.xml"];
  if (container) {
    const m = strFromU8(container).match(/full-path\s*=\s*"([^"]+)"/);
    if (m && files[m[1]]) path = m[1];
  }
  if (!path) {
    path = Object.keys(files).find((p) => !p.startsWith("META-INF/") && /\.(musicxml|xml)$/i.test(p));
  }
  if (!path) throw new MusicXmlError("No MusicXML score found inside this .mxl file.");
  return strFromU8(files[path]);
}

/** Read bytes from a user file as MusicXML text (.musicxml, .xml or .mxl). */
export function bytesToMusicXml(data: Uint8Array): string {
  // zip magic "PK\x03\x04"
  if (data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04) return unzipMxl(data);
  let text = new TextDecoder("utf-8").decode(data);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (/encoding="UTF-16"/i.test(text.slice(0, 100)) || text.indexOf("\u0000") >= 0) {
    text = new TextDecoder("utf-16").decode(data);
  }
  return text;
}

export function children(el: Element, tag?: string): Element[] {
  const out: Element[] = [];
  for (let c = el.firstElementChild; c; c = c.nextElementSibling) if (!tag || c.tagName === tag) out.push(c);
  return out;
}

export function child(el: Element, tag: string): Element | null {
  for (let c = el.firstElementChild; c; c = c.nextElementSibling) if (c.tagName === tag) return c;
  return null;
}

export function childText(el: Element, tag: string): string | null {
  const c = child(el, tag);
  return c ? (c.textContent ?? "").trim() : null;
}

/** Set (or create, before the first sibling in `before`) a child element's text. */
export function setChildText(el: Element, tag: string, value: string, before: string[] = []): Element {
  let c = child(el, tag);
  if (!c) {
    c = el.ownerDocument.createElement(tag);
    insertBefore(el, c, before);
  }
  c.textContent = value;
  return c;
}

/** Insert `node` before the first child whose tag is in `before`; append if none. */
export function insertBefore(parent: Element, node: Element, before: string[]): void {
  for (let c = parent.firstElementChild; c; c = c.nextElementSibling) {
    if (before.includes(c.tagName)) {
      parent.insertBefore(node, c);
      return;
    }
  }
  parent.appendChild(node);
}

export function removeChild(el: Element, tag: string): void {
  const c = child(el, tag);
  if (c) el.removeChild(c);
}

export function firstPart(doc: Document): Element | null {
  return children(doc.documentElement, "part")[0] ?? null;
}

export function partMeasures(part: Element): Element[] {
  return children(part, "measure");
}

/** Title: <work-title>, else <movement-title>, else the title credit (the text OSMD draws), else "Untitled". */
export function getTitle(doc: Document): string {
  const root = doc.documentElement;
  const work = child(root, "work");
  const credit = children(root, "credit").find((c) => childText(c, "credit-type") === "title");
  return (
    (work && childText(work, "work-title")?.trim()) ||
    childText(root, "movement-title")?.trim() ||
    (credit && childText(credit, "credit-words")?.trim()) ||
    "Untitled"
  );
}

export function setTitle(doc: Document, title: string): void {
  const root = doc.documentElement;
  let work = child(root, "work");
  if (!work) {
    work = doc.createElement("work");
    root.insertBefore(work, root.firstElementChild);
  }
  setChildText(work, "work-title", title);
  const mt = child(root, "movement-title");
  if (mt) mt.textContent = title;
  // Title credits (what OSMD draws) — update the credit that matches the old title, if any.
  for (const cw of Array.from(doc.getElementsByTagName("credit-words"))) {
    const credit = cw.parentElement;
    const type = credit && childText(credit, "credit-type");
    if (type === "title") cw.textContent = title;
  }
}

/** The first `<key><fifths>` in the first part (0 if none). */
export function firstKey(doc: Document): { fifths: number; mode: "major" | "minor" } {
  const part = firstPart(doc);
  const key = part?.getElementsByTagName("key")[0];
  const fifths = key ? parseInt(childText(key, "fifths") ?? "0", 10) || 0 : 0;
  const mode = key && childText(key, "mode") === "minor" ? "minor" : "major";
  return { fifths, mode };
}

export interface MeasureInfo {
  index: number;
  /** `number` attribute as written. */
  number: string;
  el: Element;
}

export function measureInfos(doc: Document): MeasureInfo[] {
  const part = firstPart(doc);
  if (!part) return [];
  return partMeasures(part).map((el, index) => ({ index, number: el.getAttribute("number") ?? String(index + 1), el }));
}

export function findMeasureIndexByNumber(doc: Document, n: number | string): number {
  return measureInfos(doc).findIndex((m) => m.number === String(n));
}

export interface TimedElement {
  el: Element;
  /** Onset from the start of the measure, in quarter notes. */
  onset: number;
  voice: string;
  /** Index among pitched/rest notes sharing the same onset+voice (chord notes). */
  chordIndex: number;
}

/** Notes (not grace) and harmonies of a measure with their onsets in quarter notes. */
export function timedContents(measure: Element, divisionsIn: number): {
  notes: TimedElement[];
  harmonies: TimedElement[];
  divisions: number;
} {
  let divisions = divisionsIn;
  let pos = 0;
  let lastOnset = 0;
  const notes: TimedElement[] = [];
  const harmonies: TimedElement[] = [];
  const chordCount = new Map<string, number>();
  for (const el of children(measure)) {
    switch (el.tagName) {
      case "attributes": {
        const d = childText(el, "divisions");
        if (d) divisions = parseFloat(d) || divisions;
        break;
      }
      case "backup":
        pos -= parseFloat(childText(el, "duration") ?? "0") || 0;
        break;
      case "forward":
        pos += parseFloat(childText(el, "duration") ?? "0") || 0;
        break;
      case "harmony": {
        const off = parseFloat(childText(el, "offset") ?? "0") || 0;
        harmonies.push({ el, onset: (pos + off) / divisions, voice: "", chordIndex: 0 });
        break;
      }
      case "note": {
        if (child(el, "grace")) break;
        const isChord = !!child(el, "chord");
        const dur = parseFloat(childText(el, "duration") ?? "0") || 0;
        const onset = isChord ? lastOnset : pos;
        const voice = childText(el, "voice") ?? "1";
        const key = `${voice}@${onset}`;
        const ci = chordCount.get(key) ?? 0;
        chordCount.set(key, ci + 1);
        notes.push({ el, onset: onset / divisions, voice, chordIndex: ci });
        if (!isChord) {
          lastOnset = pos;
          pos += dur;
        }
        break;
      }
    }
  }
  return { notes, harmonies, divisions };
}

/** Divisions in effect at the start of each measure (index-aligned with measureInfos). */
export function divisionsPerMeasure(doc: Document): number[] {
  let d = 1;
  return measureInfos(doc).map((m) => {
    const start = d;
    for (const a of children(m.el, "attributes")) {
      const t = childText(a, "divisions");
      if (t) d = parseFloat(t) || d;
    }
    // If divisions are set in this measure's first attributes, they apply to the whole measure in practice.
    const firstAttr = children(m.el, "attributes")[0];
    return firstAttr && childText(firstAttr, "divisions") ? parseFloat(childText(firstAttr, "divisions")!) || start : start;
  });
}

export function noteKey(measureIndex: number, voice: string | number, onset: number, chordIndex: number): string {
  return `${measureIndex}|${voice}|${onset.toFixed(4)}|${chordIndex}`;
}
