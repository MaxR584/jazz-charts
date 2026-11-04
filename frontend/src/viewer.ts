// OSMD wrapper: render, display transposition, click hit-testing and measure highlights.
import {
  ChordSymbolEnum,
  IntervalTransposeCalculator,
  OpenSheetMusicDisplay,
  TransposeCalculator,
  type GraphicalMeasure,
  type KeyInstruction,
  type VexFlowGraphicalNote,
} from "opensheetmusicdisplay";
import { noteKey } from "./lib/xml";

/** OSMD's default key mapping spells +6 from C as F#. This keeps the key signature spelling the app chose
 *  (Gb, Db…), and IntervalTransposeCalculator derives its letter steps from it, so notes follow. */
class KeyChoiceCalculator extends TransposeCalculator {
  /** Fifths to add to every key signature, or null for OSMD's default. */
  fifthsDelta: number | null = null;
  override transposeKey(keyInstruction: KeyInstruction, transpose: number): void {
    super.transposeKey(keyInstruction, transpose);
    if (this.fifthsDelta !== null && transpose % 12 !== 0) {
      let f = keyInstruction.keyTypeOriginal + this.fifthsDelta;
      while (f > 7) f -= 12;
      while (f < -7) f += 12;
      keyInstruction.Key = f;
    }
  }
}

export interface MeasureBox {
  index: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ViewerEvents {
  onNote(key: string, measureIndex: number): void;
  onChord(measureIndex: number, chordIndex: number): void;
  onMeasure(measureIndex: number): void;
  onBackground(): void;
}

export class ScoreViewer {
  readonly osmd: OpenSheetMusicDisplay;
  private keyCalc = new KeyChoiceCalculator();
  private measures: MeasureBox[] = [];
  /** Note keys in score order (for left/right navigation). */
  noteOrder: { key: string; measure: number }[] = [];
  private overlay: HTMLDivElement;
  private highlights = new Map<number, string>();
  private selectedNote: string | null = null;
  private lastWidth = 0;
  private resizeTimer = 0;
  private semitones = 0;
  private loaded = false;
  private renderListeners: (() => void)[] = [];

  constructor(
    private wrapper: HTMLElement,
    private host: HTMLElement,
    private events: ViewerEvents,
  ) {
    this.osmd = new OpenSheetMusicDisplay(host, {
      autoResize: false, // we re-render ourselves so the click index stays in sync
      backend: "svg",
      drawTitle: true,
      drawComposer: true,
      drawPartNames: false,
      drawCredits: true,
      autoBeam: true,
      drawingParameters: "default",
    });
    const calc = new IntervalTransposeCalculator(this.keyCalc);
    calc.AvoidDoubleAccidentals = true;
    this.osmd.TransposeCalculator = calc;
    const rules = this.osmd.EngravingRules;
    rules.RenderRehearsalMarks = true;
    // Lead-sheet style labels: C6 rather than OSMD's default "Cmaj6", C+ rather than "Caug".
    rules.ChordSymbolLabelTexts.setValue(ChordSymbolEnum.majorsixth, "6");
    rules.ChordSymbolLabelTexts.setValue(ChordSymbolEnum.augmented, "+");
    rules.ChordSymbolLabelTexts.setValue(ChordSymbolEnum.augmentedseventh, "+7");
    this.overlay = document.createElement("div");
    this.overlay.className = "score-overlay";
    wrapper.appendChild(this.overlay);
    host.addEventListener("click", (e) => this.handleClick(e));
    new ResizeObserver(() => this.onResize()).observe(wrapper);
    this.applyColors();
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      this.applyColors();
      if (this.loaded) this.render();
    });
  }

  onRender(fn: () => void): void {
    this.renderListeners.push(fn);
  }

  private applyColors(): void {
    const css = getComputedStyle(document.documentElement);
    const ink = css.getPropertyValue("--score-ink").trim() || "#111";
    this.osmd.setOptions({
      defaultColorMusic: ink,
      defaultColorLabel: ink,
      defaultColorTitle: ink,
      defaultColorNotehead: ink,
      defaultColorStem: ink,
      defaultColorRest: ink,
    });
  }

  async load(xml: string, semitones: number, fifthsDelta: number | null): Promise<void> {
    await this.osmd.load(xml);
    this.loaded = true;
    this.setTransposeInternal(semitones, fifthsDelta);
    this.render();
  }

  setTranspose(semitones: number, fifthsDelta: number | null): void {
    if (!this.loaded) return;
    this.setTransposeInternal(semitones, fifthsDelta);
    this.osmd.updateGraphic();
    this.render();
  }

  private setTransposeInternal(semitones: number, fifthsDelta: number | null): void {
    this.semitones = semitones;
    this.keyCalc.fifthsDelta = fifthsDelta;
    this.osmd.Sheet.Transpose = semitones;
  }

  render(): void {
    if (!this.loaded) return;
    const w = this.wrapper.clientWidth;
    this.lastWidth = w;
    this.osmd.Zoom = w < 520 ? 0.62 : w < 800 ? 0.8 : 1.0;
    this.osmd.render();
    this.buildIndex();
    this.drawHighlights();
    this.markSelected();
    for (const fn of this.renderListeners) fn();
  }

  clear(): void {
    this.osmd.clear();
    this.loaded = false;
    this.measures = [];
    this.noteOrder = [];
    this.highlights.clear();
    this.overlay.innerHTML = "";
  }

  private onResize(): void {
    if (!this.loaded) return;
    clearTimeout(this.resizeTimer);
    this.resizeTimer = window.setTimeout(() => {
      if (Math.abs(this.wrapper.clientWidth - this.lastWidth) > 16) this.render();
      else this.drawHighlights();
    }, 150);
  }

  private buildIndex(): void {
    this.measures = [];
    this.noteOrder = [];
    const gs = this.osmd.GraphicSheet;
    if (!gs) return;
    for (const staves of gs.MeasureList) {
      const gm: GraphicalMeasure | undefined = staves?.[0];
      if (!gm || !gm.parentSourceMeasure) continue;
      const mi = gm.parentSourceMeasure.measureListIndex;
      const ps = gm.PositionAndShape;
      this.measures.push({ index: mi, x: ps.AbsolutePosition.x, y: ps.AbsolutePosition.y, w: ps.Size.width, h: ps.Size.height });
      let chordIndex = 0;
      for (const se of gm.staffEntries) {
        for (const cc of se.graphicalChordContainers ?? []) {
          const node = cc.GraphicalLabel?.SVGNode as Element | undefined;
          if (node && "setAttribute" in node) {
            node.setAttribute("data-chord", `${mi}|${chordIndex}`);
            node.classList.add("chord-hit");
          }
          chordIndex++;
        }
        for (const gve of se.graphicalVoiceEntries) {
          for (const gn of gve.notes) {
            const note = gn.sourceNote;
            if (!note || note.isRest() || note.IsGraceNote) continue;
            const ve = note.ParentVoiceEntry;
            const key = noteKey(mi, ve.ParentVoice.VoiceId, ve.Timestamp.RealValue * 4, ve.Notes.indexOf(note));
            const g = (gn as VexFlowGraphicalNote).getSVGGElement?.();
            if (g) {
              g.setAttribute("data-note", key);
              g.setAttribute("data-measure", String(mi));
              g.classList.add("note-hit");
            }
            if (!this.noteOrder.some((n) => n.key === key)) this.noteOrder.push({ key, measure: mi });
          }
        }
      }
    }
  }

  /** Pixels per OSMD unit, plus the SVG's offset inside the wrapper. */
  private geometry(): { unit: number; left: number; top: number; rect: DOMRect } | null {
    const svg = this.host.querySelector("svg");
    if (!svg) return null;
    const r = svg.getBoundingClientRect();
    const wr = this.wrapper.getBoundingClientRect();
    const baseW = svg.width.baseVal.value || r.width;
    const unit = 10 * this.osmd.Zoom * (r.width / baseW);
    return { unit, left: r.left - wr.left + this.wrapper.scrollLeft, top: r.top - wr.top + this.wrapper.scrollTop, rect: r };
  }

  measureAt(clientX: number, clientY: number): number | null {
    const g = this.geometry();
    if (!g) return null;
    const x = (clientX - g.rect.left) / g.unit;
    const y = (clientY - g.rect.top) / g.unit;
    const hit = this.measures.find((m) => x >= m.x && x <= m.x + m.w && y >= m.y - 6 && y <= m.y + m.h + 3);
    return hit ? hit.index : null;
  }

  private handleClick(e: MouseEvent): void {
    const t = e.target as Element;
    const note = t.closest?.("[data-note]");
    if (note) {
      this.events.onNote(note.getAttribute("data-note")!, parseInt(note.getAttribute("data-measure")!, 10));
      return;
    }
    const chord = t.closest?.("[data-chord]");
    if (chord) {
      const [m, c] = chord.getAttribute("data-chord")!.split("|").map(Number);
      this.events.onChord(m, c);
      return;
    }
    const mi = this.measureAt(e.clientX, e.clientY);
    if (mi !== null) this.events.onMeasure(mi);
    else this.events.onBackground();
  }

  /** Highlight measures: kind is a CSS class suffix ("warn", "active", "select"). */
  setHighlights(map: Map<number, string>): void {
    this.highlights = map;
    this.drawHighlights();
  }

  private drawHighlights(): void {
    this.overlay.innerHTML = "";
    const g = this.geometry();
    if (!g) return;
    for (const [mi, kind] of this.highlights) {
      for (const m of this.measures.filter((x) => x.index === mi)) {
        const d = document.createElement("div");
        d.className = "measure-hl " + kind.split(" ").map((k) => `measure-hl-${k}`).join(" ");
        d.dataset.measure = String(mi);
        d.style.left = `${g.left + m.x * g.unit}px`;
        d.style.top = `${g.top + (m.y - 4.5) * g.unit}px`;
        d.style.width = `${m.w * g.unit}px`;
        d.style.height = `${(m.h + 6) * g.unit}px`;
        this.overlay.appendChild(d);
      }
    }
  }

  scrollToMeasure(mi: number): void {
    const g = this.geometry();
    const m = this.measures.find((x) => x.index === mi);
    if (!g || !m) return;
    const top = g.rect.top + window.scrollY + (m.y - 8) * g.unit;
    window.scrollTo({ top: Math.max(0, top - 80), behavior: "smooth" });
  }

  selectNote(key: string | null): void {
    this.selectedNote = key;
    this.markSelected();
  }

  private markSelected(): void {
    for (const el of Array.from(this.host.querySelectorAll(".note-sel"))) el.classList.remove("note-sel");
    if (!this.selectedNote) return;
    const el = this.host.querySelector(`[data-note="${CSS.escape(this.selectedNote)}"]`);
    el?.classList.add("note-sel");
  }

  hasNote(key: string): boolean {
    return this.noteOrder.some((n) => n.key === key);
  }

  get currentSemitones(): number {
    return this.semitones;
  }
}
