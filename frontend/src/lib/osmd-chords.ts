// Make OSMD 2.2.1 print chord symbols the way they are written on the lead sheet.
//
// OSMD builds every label from <kind> + <degree>s (ChordSymbolLabelTexts, CustomChords) and throws away
// <kind text="…">, so "7sus4" became "sus4(b7)", "7alt" became "7(b9,#9)(alt #5)", "6/9" became "69".
// MusicXML says kind/@text is how the kind is spelled (unless use-symbols="yes"), and MuseScore/Finale
// print it. This patch keeps that text on the ChordSymbolContainer while reading, and when it is there,
// the label is <transposed root><text>/<transposed bass>. Without a text, OSMD's own label is used, minus
// any <degree print-object="no">. See docs/errors-frontend.md #7.
import {
  ChordSymbolContainer,
  ChordSymbolEnum,
  ChordSymbolReader,
  MusicSheetCalculator,
  Pitch,
  AccidentalEnum,
  type IXmlElement,
  type KeyInstruction,
} from "opensheetmusicdisplay";

/** Extra field stored on a ChordSymbolContainer by the patched reader. */
interface WithKindText {
  kindText?: string;
}

/** The suffix to print for a <harmony>, or undefined to let OSMD build it.
 *  Same rule as harmonyToText() in chords.ts: an empty text only counts for major (and other). */
export function kindDisplayText(harmony: IXmlElement): string | undefined {
  const kind = harmony.element("kind");
  if (!kind) return undefined;
  const text = kind.attribute("text")?.value;
  if (text === undefined || text === null) return undefined;
  if (kind.attribute("use-symbols")?.value === "yes") return undefined;
  const value = kind.value.trim();
  if (value === "none") return undefined; // N.C.: OSMD's own label
  if (text === "" && value !== "major" && value !== "other") return undefined;
  return text;
}

let installed = false;

/** Patch ChordSymbolReader.readChordSymbol and ChordSymbolContainer.calculateChordText (once). */
export function installChordTextPatch(): void {
  if (installed) return;
  installed = true;

  const origRead = ChordSymbolReader.readChordSymbol.bind(ChordSymbolReader);
  ChordSymbolReader.readChordSymbol = (xmlNode, musicSheet, activeKey) => {
    const c = origRead(xmlNode, musicSheet, activeKey);
    if (!c) return c;
    const text = kindDisplayText(xmlNode);
    if (text !== undefined) (c as ChordSymbolContainer & WithKindText).kindText = text;
    // Drop degrees marked print-object="no" (OSMD reads one Degree per <degree>, in order).
    const xmlDegrees = xmlNode.elements("degree");
    const degrees = c.ChordDegrees;
    if (degrees && xmlDegrees.length === degrees.length) {
      for (let i = xmlDegrees.length - 1; i >= 0; i--) {
        if (xmlDegrees[i].attribute("print-object")?.value === "no") degrees.splice(i, 1);
      }
    }
    return c;
  };

  const origCalc = ChordSymbolContainer.calculateChordText.bind(ChordSymbolContainer);
  ChordSymbolContainer.calculateChordText = (
    chord: ChordSymbolContainer,
    transposeHalftones: number,
    keyInstruction: KeyInstruction,
  ): string => {
    const text = (chord as ChordSymbolContainer & WithKindText).kindText;
    if (text === undefined || chord.NumeralText !== undefined || chord.ChordKind === ChordSymbolEnum.none) {
      return origCalc(chord, transposeHalftones, keyInstruction);
    }
    return pitchText(chord, chord.RootPitch, transposeHalftones, keyInstruction) + text +
      (chord.BassPitch ? "/" + pitchText(chord, chord.BassPitch, transposeHalftones, keyInstruction) : "");
  };
}

/** Root/bass name the way OSMD prints it: transposed by the active calculator, accidental from ChordAccidentalTexts. */
function pitchText(chord: ChordSymbolContainer, p: Pitch, halftones: number, key: KeyInstruction): string {
  const calc = MusicSheetCalculator.transposeCalculator;
  const tp = calc ? calc.transposePitch(p, key, halftones, true) : p;
  let s = Pitch.getNoteEnumString(tp.FundamentalNote);
  if (tp.Accidental !== AccidentalEnum.NONE) {
    s += (chord as unknown as { getTextForAccidental(a: AccidentalEnum): string }).getTextForAccidental(tp.Accidental);
  }
  return s;
}
