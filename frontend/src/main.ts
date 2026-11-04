import "./style.css";
import type { ConvertResponse, Engine, EngineChoice, Warning } from "../../shared/types";
import { ApiFailure, convert, fetchHealth, fetchProgress, guessType, newJobId, validateUpload, type ConvertHandle } from "./lib/api";
import { harmonyToText, transposeChordText } from "./lib/chords";
import { addChord, measureChords, measureNotes, setChordText, shiftNote } from "./lib/edit";
import { pitchToName, readPitch } from "./lib/pitch";
import { deleteChart, getChart, listCharts, newId, putChart, type SavedChart } from "./lib/storage";
import { describeInterval, spelledInterval, transposeDocument, transposePitchName, intervalForSemitones } from "./lib/transpose";
import {
  DEFAULT_VIEW,
  INSTRUMENTS,
  describeView,
  instrumentOf,
  keyOptions,
  totalSemitones,
  wrapOffset,
  type ViewState,
} from "./lib/view-state";
import {
  bytesToMusicXml,
  findMeasureIndexByNumber,
  firstKey,
  getTitle,
  measureInfos,
  MusicXmlError,
  noteKey,
  parseMusicXml,
  serializeMusicXml,
  setTitle,
} from "./lib/xml";
import { ScoreViewer } from "./viewer";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------------------------------------------------------------- state
interface AppState {
  doc: Document | null;
  key: { fifths: number; mode: "major" | "minor" };
  view: ViewState;
  warnings: Warning[];
  chartId: string | null;
  dirty: boolean;
  undo: string[];
  redo: string[];
  selection: { kind: "measure"; measure: number; chord?: number } | { kind: "note"; key: string; measure: number } | null;
  activeWarning: number | null;
}

const state: AppState = {
  doc: null,
  key: { fifths: 0, mode: "major" },
  view: { ...DEFAULT_VIEW },
  warnings: [],
  chartId: null,
  dirty: false,
  undo: [],
  redo: [],
  selection: null,
  activeWarning: null,
};

let engines: Record<Engine, boolean> | null = null;
let currentUpload: ConvertHandle | null = null;

const viewer = new ScoreViewer($("score-wrap"), $("score"), {
  onNote: (key, measure) => select({ kind: "note", key, measure }),
  onChord: (measure, chord) => select({ kind: "measure", measure, chord }),
  onMeasure: (measure) => select({ kind: "measure", measure }),
  onBackground: () => select(null),
});
viewer.onRender(() => updateHighlights());

// ---------------------------------------------------------------- messages
function showError(msg: string): void {
  $("error-text").textContent = msg;
  $("error").hidden = false;
}
function clearError(): void {
  $("error").hidden = true;
}
let infoTimer = 0;
function showInfo(msg: string, ms = 2500): void {
  const el = $("info");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(infoTimer);
  infoTimer = window.setTimeout(() => (el.hidden = true), ms);
}
$("error-close").addEventListener("click", clearError);

// ---------------------------------------------------------------- server health
async function checkHealth(): Promise<void> {
  const pill = $("server-pill");
  const text = pill.querySelector(".pill-text")!;
  pill.className = "pill";
  text.textContent = "Checking server…";
  try {
    const h = await fetchHealth();
    engines = h.engines;
    const on = (Object.keys(h.engines) as Engine[]).filter((e) => h.engines[e]);
    pill.classList.add("ok");
    text.textContent = "Server online";
    pill.title = `Engines available: ${on.join(", ") || "none"} — click to re-check`;
  } catch (e) {
    engines = null;
    pill.classList.add("down");
    text.textContent = "Server offline";
    pill.title = (e as Error).message + " Click to re-check.";
  }
  updateEngineSelect();
}

function updateEngineSelect(): void {
  const sel = $<HTMLSelectElement>("engine");
  const note = $("engine-note");
  for (const opt of Array.from(sel.options)) {
    if (opt.value === "auto") continue;
    const ok = engines ? engines[opt.value as Engine] : false;
    opt.disabled = !!engines && !ok;
    opt.textContent = opt.textContent!.replace(/ \(unavailable\)$/, "") + (engines && !ok ? " (unavailable)" : "");
  }
  if (sel.selectedOptions[0]?.disabled) sel.value = "auto";
  if (!engines) {
    note.textContent = "The conversion server isn't reachable — uploads won't work until it's running. Opening MusicXML files and the sample still works.";
    note.className = "small warn-text";
  } else {
    const on = (Object.keys(engines) as Engine[]).filter((e) => engines![e]);
    if (!engines.claude && !engines.audiveris) {
      note.textContent =
        "No recognition engine is set up, so your own files can't be read yet. Set ANTHROPIC_API_KEY before starting the server, or install Audiveris. (The mock engine only returns the sample.)";
      note.className = "small warn-text";
    } else {
      note.textContent = `Available: ${on.join(", ")}. Auto picks Claude, then Audiveris. Mock only returns the sample.`;
      note.className = "muted small";
    }
  }
}
$("server-pill").addEventListener("click", () => void checkHealth());

// ---------------------------------------------------------------- loading charts
async function openXml(xml: string, opts: { warnings?: Warning[]; chartId?: string | null; view?: ViewState; meta?: string } = {}) {
  let doc: Document;
  try {
    doc = parseMusicXml(xml);
  } catch (e) {
    showError(e instanceof MusicXmlError ? e.message : "Couldn't read that MusicXML: " + (e as Error).message);
    return;
  }
  clearError();
  state.doc = doc;
  state.key = firstKey(doc);
  state.view = opts.view ? { ...opts.view } : { ...DEFAULT_VIEW };
  state.warnings = opts.warnings ?? [];
  state.chartId = opts.chartId ?? null;
  state.dirty = !opts.chartId;
  state.undo = [];
  state.redo = [];
  state.selection = null;
  state.activeWarning = null;
  $("workspace").hidden = false;
  $("empty").hidden = true;
  $("upload-panel").classList.add("compact");
  $<HTMLInputElement>("title").value = getTitle(doc);
  $("meta").textContent = opts.meta ?? "";
  hideEditor();
  buildKeySelect();
  renderWarnings();
  updateTransposeUi();
  try {
    await viewer.load(serializeMusicXml(doc), totalSemitones(state.view), fifthsDelta());
  } catch (e) {
    console.warn("OSMD load failed", e);
    showError("The score couldn't be drawn: " + (e as Error).message);
  }
  updateUndoUi();
}

async function openFile(file: File): Promise<void> {
  const name = file.name.toLowerCase();
  if (/\.(musicxml|xml|mxl)$/.test(name) || /musicxml/.test(file.type)) {
    try {
      const xml = bytesToMusicXml(new Uint8Array(await file.arrayBuffer()));
      await openXml(xml, { meta: `Opened ${file.name}` });
    } catch (e) {
      showError(`Couldn't open ${file.name}: ${(e as Error).message}`);
    }
    return;
  }
  await uploadForConversion(file);
}

async function loadSample(): Promise<void> {
  try {
    const res = await fetch(import.meta.env.BASE_URL + "samples/sample.musicxml");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await openXml(await res.text(), { meta: "Sample chart (original composition)" });
  } catch (e) {
    showError("Couldn't load the sample: " + (e as Error).message);
  }
}

// ---------------------------------------------------------------- upload / convert
function setProgress(visible: boolean, fraction = 0, text = ""): void {
  $("progress").hidden = !visible;
  const fill = $("progress-fill");
  fill.classList.toggle("indeterminate", fraction < 0);
  fill.style.width = fraction < 0 ? "" : `${Math.round(fraction * 100)}%`;
  $("progress-text").textContent = text;
}

async function uploadForConversion(file: File): Promise<void> {
  clearError();
  const problem = validateUpload(file);
  if (problem) return showError(problem);
  if (currentUpload) currentUpload.abort();
  const engine = $<HTMLSelectElement>("engine").value as EngineChoice;
  const started = performance.now();
  let phase: "upload" | "recognize" = "upload";
  const job = newJobId();
  let last = { percent: 0, stage: "Starting" };
  let polling = false;
  const timer = window.setInterval(async () => {
    if (phase !== "recognize" || polling) return;
    polling = true;
    const p = await fetchProgress(job);
    polling = false;
    if (phase !== "recognize") return;
    // Never move the bar backwards (e.g. a late response from an earlier poll).
    if (p && p.percent >= last.percent) last = { percent: p.percent, stage: p.stage };
    const s = Math.round((performance.now() - started) / 1000);
    setProgress(true, last.percent / 100, `${last.stage}… ${Math.round(last.percent)}% · ${s}s`);
  }, 600);
  setProgress(true, 0, `Uploading ${file.name}…`);
  $("upload-panel").classList.add("busy");
  const handle = convert(
    file,
    engine,
    (f) => {
      if (f >= 1) {
        if (phase === "upload") setProgress(true, 0, "Starting recognition… 0%");
        phase = "recognize";
      } else setProgress(true, f, `Uploading ${file.name}… ${Math.round(f * 100)}%`);
    },
    job,
  );
  currentUpload = handle;
  try {
    const r: ConvertResponse = await handle.promise;
    const meta = `Recognized “${file.name}” with ${r.engine} · ${r.pages} page${r.pages === 1 ? "" : "s"} · ${(r.elapsedMs / 1000).toFixed(1)} s. Check it against the original — recognition isn't perfect.`;
    await openXml(r.musicxml, { warnings: r.warnings, meta });
  } catch (e) {
    if (e instanceof ApiFailure) {
      if (e.code !== "aborted") showError(e.message);
      if (e.code === "server_down") void checkHealth();
    } else showError("Conversion failed: " + (e as Error).message);
  } finally {
    clearInterval(timer);
    if (currentUpload === handle) currentUpload = null;
    setProgress(false);
    $("upload-panel").classList.remove("busy");
  }
}

$("btn-cancel").addEventListener("click", () => currentUpload?.abort());
$("btn-upload").addEventListener("click", () => $<HTMLInputElement>("file-image").click());
$("dropzone").addEventListener("click", () => $<HTMLInputElement>("file-image").click());
$("dropzone").addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    $<HTMLInputElement>("file-image").click();
  }
});
$("btn-open").addEventListener("click", () => $<HTMLInputElement>("file-xml").click());
$("btn-sample").addEventListener("click", () => void loadSample());
$("btn-sample2").addEventListener("click", () => void loadSample());
for (const id of ["file-image", "file-xml"]) {
  const input = $<HTMLInputElement>(id);
  input.addEventListener("change", () => {
    const f = input.files?.[0];
    input.value = "";
    if (f) void openFile(f);
  });
}

// drag & drop anywhere
let dragDepth = 0;
window.addEventListener("dragenter", (e) => {
  if (!e.dataTransfer?.types.includes("Files")) return;
  dragDepth++;
  $("drop-overlay").hidden = false;
});
window.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $("drop-overlay").hidden = true;
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  $("drop-overlay").hidden = true;
  const f = e.dataTransfer?.files?.[0];
  if (f) void openFile(f);
});

// paste image (or MusicXML text)
window.addEventListener("paste", (e) => {
  const t = e.target as HTMLElement;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
  const items = Array.from(e.clipboardData?.items ?? []);
  const fileItem = items.find((i) => i.kind === "file");
  if (fileItem) {
    const f = fileItem.getAsFile();
    if (f) {
      e.preventDefault();
      const ext = (f.type.split("/")[1] || "png").replace("jpeg", "jpg");
      const named = f.name && f.name !== "image.png" ? f : new File([f], `pasted-image.${ext}`, { type: f.type || guessType("x." + ext) });
      void openFile(named);
      return;
    }
  }
  const text = e.clipboardData?.getData("text/plain") ?? "";
  if (/<score-partwise[\s>]/.test(text)) {
    e.preventDefault();
    void openXml(text, { meta: "Pasted MusicXML" });
  }
});

// ---------------------------------------------------------------- transpose UI
function fifthsDelta(): number | null {
  const d = describeView(state.key.fifths, state.key.mode, state.view);
  return d.writtenFifths - state.key.fifths;
}

function buildKeySelect(): void {
  const sel = $<HTMLSelectElement>("key-select");
  sel.innerHTML = "";
  for (const k of keyOptions(state.key.fifths, state.key.mode)) {
    const o = document.createElement("option");
    o.value = String(k.offset);
    o.textContent = k.label + (k.offset === 0 ? " (original)" : "");
    sel.appendChild(o);
  }
}

function buildInstrumentSelect(): void {
  const sel = $<HTMLSelectElement>("instrument");
  for (const i of INSTRUMENTS) {
    const o = document.createElement("option");
    o.value = i.id;
    o.textContent = i.label;
    sel.appendChild(o);
  }
}

function updateTransposeUi(): void {
  const d = describeView(state.key.fifths, state.key.mode, state.view);
  $<HTMLSelectElement>("key-select").value = String(wrapOffset(state.view.concertOffset));
  $<HTMLSelectElement>("instrument").value = state.view.instrument;
  $("oct-label").textContent = state.view.octave > 0 ? `+${state.view.octave}` : String(state.view.octave);
  const inst = instrumentOf(state.view.instrument);
  const si = intervalForSemitones(state.key.fifths, d.semitones);
  const shown =
    inst.id === "C"
      ? `Showing ${d.writtenKey}`
      : `Concert ${d.concertKey} → written ${d.writtenKey} for ${inst.id} instruments`;
  $("written-key").textContent = d.semitones === 0 ? `Original key: ${d.writtenKey}` : `${shown} (${describeInterval(si)})`;
  $("written-key").title = `${d.semitones} semitones from the original`;
}

async function applyView(): Promise<void> {
  updateTransposeUi();
  viewer.setTranspose(totalSemitones(state.view), fifthsDelta());
  refreshEditor();
}

$("key-select").addEventListener("change", () => {
  // Keep any extra octaves the ±½ buttons accumulated.
  const off = parseInt($<HTMLSelectElement>("key-select").value, 10);
  state.view.concertOffset = off;
  void applyView();
});
$("semi-up").addEventListener("click", () => {
  state.view.concertOffset++;
  if (state.view.concertOffset > 6) {
    state.view.concertOffset -= 12;
    state.view.octave++;
  }
  void applyView();
});
$("semi-down").addEventListener("click", () => {
  state.view.concertOffset--;
  if (state.view.concertOffset < -6) {
    state.view.concertOffset += 12;
    state.view.octave--;
  }
  void applyView();
});
$("oct-up").addEventListener("click", () => {
  if (state.view.octave < 2) state.view.octave++;
  void applyView();
});
$("oct-down").addEventListener("click", () => {
  if (state.view.octave > -2) state.view.octave--;
  void applyView();
});
$("instrument").addEventListener("change", () => {
  state.view.instrument = $<HTMLSelectElement>("instrument").value as ViewState["instrument"];
  void applyView();
});
$("btn-reset").addEventListener("click", () => {
  state.view = { ...DEFAULT_VIEW };
  void applyView();
});

// ---------------------------------------------------------------- editing
function displayInterval() {
  return intervalForSemitones(state.key.fifths, totalSemitones(state.view));
}

/** Chord text as shown in the current (transposed) view. */
function toDisplayChord(sourceText: string): string {
  const si = displayInterval();
  return si.semitones % 12 === 0 && si.ivl === "1P" ? sourceText : transposeChordText(sourceText, si.ivl);
}

/** Chord text typed in the current view → concert/original spelling. */
function fromDisplayChord(text: string): string {
  const t = totalSemitones(state.view);
  if (t % 12 === 0) return text;
  const d = describeView(state.key.fifths, state.key.mode, state.view);
  const inv = spelledInterval(d.writtenFifths, state.key.fifths, -t);
  return transposeChordText(text, inv.ivl);
}

function snapshot(): void {
  if (!state.doc) return;
  state.undo.push(serializeMusicXml(state.doc));
  if (state.undo.length > 100) state.undo.shift();
  state.redo = [];
  state.dirty = true;
}

async function rerender(): Promise<void> {
  if (!state.doc) return;
  await viewer.load(serializeMusicXml(state.doc), totalSemitones(state.view), fifthsDelta());
  updateUndoUi();
  refreshEditor();
}

async function undoRedo(from: string[], to: string[]): Promise<void> {
  if (!state.doc || !from.length) return;
  to.push(serializeMusicXml(state.doc));
  state.doc = parseMusicXml(from.pop()!);
  state.dirty = true;
  $<HTMLInputElement>("title").value = getTitle(state.doc);
  await rerender();
}
$("btn-undo").addEventListener("click", () => void undoRedo(state.undo, state.redo));
$("btn-redo").addEventListener("click", () => void undoRedo(state.redo, state.undo));

function updateUndoUi(): void {
  $<HTMLButtonElement>("btn-undo").disabled = !state.undo.length;
  $<HTMLButtonElement>("btn-redo").disabled = !state.redo.length;
  $("btn-save").textContent = state.dirty || !state.chartId ? "Save" : "Saved ✓";
}

$("title").addEventListener("change", () => {
  if (!state.doc) return;
  const t = $<HTMLInputElement>("title").value.trim() || "Untitled";
  snapshot();
  setTitle(state.doc, t);
  void rerender();
});

function select(sel: AppState["selection"]): void {
  state.selection = sel;
  viewer.selectNote(sel?.kind === "note" ? sel.key : null);
  updateHighlights();
  refreshEditor();
}

function measureLabel(mi: number): string {
  const m = state.doc ? measureInfos(state.doc)[mi] : undefined;
  return m ? `Bar ${m.number}` : `Bar ${mi + 1}`;
}

function hideEditor(): void {
  $("editor").hidden = true;
  document.body.classList.remove("editor-open");
}

function refreshEditor(): void {
  const sel = state.selection;
  const body = $("editor-body");
  if (!sel || !state.doc) return hideEditor();
  $("editor").hidden = false;
  document.body.classList.add("editor-open");
  body.innerHTML = "";
  if (sel.kind === "measure") renderMeasureEditor(sel.measure, sel.chord, body);
  else renderNoteEditor(sel.key, sel.measure, body);
}

function renderMeasureEditor(mi: number, focusChord: number | undefined, body: HTMLElement): void {
  const doc = state.doc!;
  $("editor-title").textContent = `${measureLabel(mi)} — chords`;
  const chords = measureChords(doc, mi);
  const list = document.createElement("div");
  list.className = "chord-list";
  if (!chords.length) {
    const p = document.createElement("p");
    p.className = "muted small";
    p.textContent = "No chords in this bar.";
    list.appendChild(p);
  }
  chords.forEach((c, i) => {
    const row = document.createElement("form");
    row.className = "chord-row";
    row.innerHTML = `<span class="beat">beat ${fmtBeat(c.beat)}</span>
      <input class="chord-input" name="chord" autocomplete="off" spellcheck="false" aria-label="Chord on beat ${fmtBeat(c.beat)}" />
      <button class="btn small" type="submit">Set</button>
      <button class="btn small ghost danger" type="button" data-del title="Delete chord">✕</button>`;
    const input = row.querySelector("input")!;
    input.value = toDisplayChord(c.text);
    row.addEventListener("submit", (e) => {
      e.preventDefault();
      editChord(mi, i, input.value);
    });
    row.querySelector("[data-del]")!.addEventListener("click", () => editChord(mi, i, ""));
    list.appendChild(row);
    if (focusChord === i) queueMicrotask(() => input.select());
  });
  body.appendChild(list);

  const add = document.createElement("form");
  add.className = "chord-row add";
  const beats = beatsInMeasure(mi);
  add.innerHTML = `<select name="beat" aria-label="Beat">${beats.map((b) => `<option value="${b}">beat ${fmtBeat(b)}</option>`).join("")}</select>
    <input name="chord" class="chord-input" placeholder="e.g. Bb7(b9)" autocomplete="off" spellcheck="false" aria-label="New chord" />
    <button class="btn small primary" type="submit">Add</button>`;
  add.addEventListener("submit", (e) => {
    e.preventDefault();
    const beat = parseFloat((add.elements.namedItem("beat") as HTMLSelectElement).value);
    const text = (add.elements.namedItem("chord") as HTMLInputElement).value.trim();
    if (!text) return;
    try {
      snapshot();
      addChord(doc, mi, beat, fromDisplayChord(text));
      void rerender();
    } catch (err) {
      state.undo.pop();
      showError((err as Error).message + ". Try forms like C7, F-7, Bbmaj7, Eø, A7(b9), D7/F#.");
    }
  });
  body.appendChild(add);
  if (focusChord === undefined && !chords.length) queueMicrotask(() => (add.elements.namedItem("chord") as HTMLInputElement).focus());

  const nav = document.createElement("div");
  nav.className = "editor-nav";
  nav.innerHTML = `<button class="btn small ghost" type="button" data-prev>← Prev bar</button><button class="btn small ghost" type="button" data-next>Next bar →</button>`;
  const count = measureInfos(doc).length;
  nav.querySelector<HTMLButtonElement>("[data-prev]")!.disabled = mi <= 0;
  nav.querySelector<HTMLButtonElement>("[data-next]")!.disabled = mi >= count - 1;
  nav.querySelector("[data-prev]")!.addEventListener("click", () => select({ kind: "measure", measure: mi - 1 }));
  nav.querySelector("[data-next]")!.addEventListener("click", () => select({ kind: "measure", measure: mi + 1 }));
  body.appendChild(nav);
}

function fmtBeat(b: number): string {
  return Number.isInteger(b) ? String(b) : b.toFixed(2).replace(/0+$/, "");
}

function beatsInMeasure(mi: number): number[] {
  const doc = state.doc!;
  let beats = 4;
  let beatType = 4;
  for (const m of measureInfos(doc).slice(0, mi + 1)) {
    const t = m.el.getElementsByTagName("time")[0];
    if (t) {
      beats = parseInt(t.getElementsByTagName("beats")[0]?.textContent ?? "4", 10) || 4;
      beatType = parseInt(t.getElementsByTagName("beat-type")[0]?.textContent ?? "4", 10) || 4;
    }
  }
  const quarters = (beats * 4) / beatType;
  const out: number[] = [];
  for (let q = 0; q < quarters; q++) out.push(q + 1);
  // add the onsets of notes too (e.g. "and" of 2)
  for (const n of measureNotes(doc, mi)) if (!out.includes(n.onset + 1)) out.push(n.onset + 1);
  return out.sort((a, b) => a - b);
}

function editChord(mi: number, index: number, text: string): void {
  const doc = state.doc!;
  const c = measureChords(doc, mi)[index];
  if (!c) return;
  try {
    snapshot();
    setChordText(doc, c.el, text.trim() ? fromDisplayChord(text.trim()) : "");
    clearError();
    state.selection = { kind: "measure", measure: mi };
    void rerender();
  } catch (err) {
    state.undo.pop();
    showError((err as Error).message + ". Try forms like C7, F-7, Bbmaj7, Eø, A7(b9), D7/F#.");
  }
}

function findNoteEl(key: string, mi: number): Element | null {
  const doc = state.doc!;
  const n = measureNotes(doc, mi).find((x) => noteKey(mi, x.voice, x.onset, x.chordIndex) === key);
  return n?.el ?? null;
}

function renderNoteEditor(key: string, mi: number, body: HTMLElement): void {
  const el = findNoteEl(key, mi);
  const p = el && readPitch(el);
  $("editor-title").textContent = `${measureLabel(mi)} — note`;
  if (!el || !p) {
    body.innerHTML = `<p class="muted small">This note couldn't be matched to the MusicXML.</p>`;
    return;
  }
  const shown = transposePitchName(pitchToName(p), displayInterval());
  body.innerHTML = `<div class="note-edit">
      <span class="note-name" aria-live="polite">${shown.replace("#", "♯").replace(/b(?=-?\d)/, "♭")}</span>
      <div class="stepper vertical">
        <button class="btn" type="button" data-up title="Up a semitone (↑)">▲ semitone</button>
        <button class="btn" type="button" data-down title="Down a semitone (↓)">▼ semitone</button>
      </div>
      <div class="stepper vertical">
        <button class="btn small ghost" type="button" data-oup title="Up an octave (Shift+↑)">+8ve</button>
        <button class="btn small ghost" type="button" data-odown title="Down an octave (Shift+↓)">−8ve</button>
      </div>
    </div>
    <div class="editor-nav">
      <button class="btn small ghost" type="button" data-prev>← Prev note</button>
      <button class="btn small ghost" type="button" data-bar>Edit bar chords</button>
      <button class="btn small ghost" type="button" data-next>Next note →</button>
    </div>`;
  body.querySelector("[data-up]")!.addEventListener("click", () => moveNote(1));
  body.querySelector("[data-down]")!.addEventListener("click", () => moveNote(-1));
  body.querySelector("[data-oup]")!.addEventListener("click", () => moveNote(12));
  body.querySelector("[data-odown]")!.addEventListener("click", () => moveNote(-12));
  body.querySelector("[data-prev]")!.addEventListener("click", () => stepNote(-1));
  body.querySelector("[data-next]")!.addEventListener("click", () => stepNote(1));
  body.querySelector("[data-bar]")!.addEventListener("click", () => select({ kind: "measure", measure: mi }));
}

function moveNote(semitones: number): void {
  const sel = state.selection;
  if (!sel || sel.kind !== "note" || !state.doc) return;
  const el = findNoteEl(sel.key, sel.measure);
  if (!el) return;
  const before = serializeMusicXml(state.doc);
  if (shiftNote(state.doc, el, sel.measure, semitones)) {
    state.undo.push(before);
    state.redo = [];
    state.dirty = true;
    scheduleRerender();
  }
}

let rerenderTimer = 0;
function scheduleRerender(): void {
  refreshEditor();
  clearTimeout(rerenderTimer);
  rerenderTimer = window.setTimeout(() => void rerender(), 120);
}

function stepNote(dir: 1 | -1): void {
  const sel = state.selection;
  const order = viewer.noteOrder;
  if (!order.length) return;
  let i = sel?.kind === "note" ? order.findIndex((n) => n.key === sel.key) : -1;
  i = i < 0 ? (dir > 0 ? 0 : order.length - 1) : Math.min(order.length - 1, Math.max(0, i + dir));
  select({ kind: "note", key: order[i].key, measure: order[i].measure });
}

$("editor-close").addEventListener("click", () => select(null));

window.addEventListener("keydown", (e) => {
  const t = e.target as HTMLElement;
  const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT");
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === "z" && !typing) {
    e.preventDefault();
    void (e.shiftKey ? undoRedo(state.redo, state.undo) : undoRedo(state.undo, state.redo));
    return;
  }
  if (mod && e.key.toLowerCase() === "y" && !typing) {
    e.preventDefault();
    void undoRedo(state.redo, state.undo);
    return;
  }
  if (typing) return;
  if (e.key === "Escape") return select(null);
  if (state.selection?.kind === "note") {
    if (e.key === "ArrowUp") (e.preventDefault(), moveNote(e.shiftKey ? 12 : 1));
    else if (e.key === "ArrowDown") (e.preventDefault(), moveNote(e.shiftKey ? -12 : -1));
    else if (e.key === "ArrowRight") (e.preventDefault(), stepNote(1));
    else if (e.key === "ArrowLeft") (e.preventDefault(), stepNote(-1));
  }
});

// ---------------------------------------------------------------- warnings
function warningMeasureIndex(w: Warning): number {
  return w.measure == null || !state.doc ? -1 : findMeasureIndexByNumber(state.doc, w.measure);
}

function renderWarnings(): void {
  const box = $<HTMLDetailsElement>("warnings");
  const list = $("warnings-list");
  list.innerHTML = "";
  box.hidden = !state.warnings.length;
  $("warnings-title").textContent = `${state.warnings.length} recognition warning${state.warnings.length === 1 ? "" : "s"}`;
  state.warnings.forEach((w, i) => {
    const li = document.createElement("li");
    const mi = warningMeasureIndex(w);
    const btn = document.createElement(mi >= 0 ? "button" : "span");
    btn.className = mi >= 0 ? "warn-link" : "warn-global";
    if (mi >= 0) (btn as HTMLButtonElement).type = "button";
    btn.innerHTML = `<span class="warn-bar"></span><span class="warn-code"></span><span class="warn-msg"></span>`;
    btn.querySelector(".warn-bar")!.textContent = w.measure == null ? "Whole score" : `Bar ${w.measure}`;
    btn.querySelector(".warn-code")!.textContent = w.code.replace(/_/g, " ");
    btn.querySelector(".warn-msg")!.textContent = w.message;
    if (mi >= 0) {
      btn.addEventListener("click", () => {
        state.activeWarning = i;
        renderWarningActive();
        viewer.scrollToMeasure(mi);
        select({ kind: "measure", measure: mi });
      });
    }
    li.appendChild(btn);
    list.appendChild(li);
  });
}

function renderWarningActive(): void {
  Array.from($("warnings-list").children).forEach((li, i) => li.classList.toggle("active", i === state.activeWarning));
}

function updateHighlights(): void {
  const map = new Map<number, string>();
  for (const w of state.warnings) {
    const mi = warningMeasureIndex(w);
    if (mi >= 0) map.set(mi, "warn");
  }
  if (state.activeWarning != null) {
    const mi = warningMeasureIndex(state.warnings[state.activeWarning]);
    if (mi >= 0) map.set(mi, "active");
  }
  if (state.selection?.kind === "measure") {
    const mi = state.selection.measure;
    map.set(mi, (map.get(mi) === "active" ? "active " : "") + "select");
  }
  viewer.setHighlights(map);
}

// ---------------------------------------------------------------- download
function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "chart";
}

function download(name: string, text: string): void {
  const blob = new Blob([text], { type: "application/vnd.recordare.musicxml+xml" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** The edited score, transposed for the current view (what the download contains). */
export function exportTransposed(): string {
  const doc = parseMusicXml(serializeMusicXml(state.doc!));
  const t = totalSemitones(state.view);
  transposeDocument(doc, { semitones: t });
  const inst = instrumentOf(state.view.instrument);
  if (inst.id !== "C") {
    for (const pn of Array.from(doc.getElementsByTagName("part-name"))) pn.textContent = `${pn.textContent} (${inst.id})`;
  }
  return serializeMusicXml(doc);
}

$("btn-download").addEventListener("click", () => {
  if (!state.doc) return;
  const d = describeView(state.key.fifths, state.key.mode, state.view);
  const inst = state.view.instrument === "C" ? "" : `-${state.view.instrument}-part`;
  const name = `${slug(getTitle(state.doc))}-${d.writtenKey.replace("#", "sharp")}${inst}.musicxml`;
  download(name, exportTransposed());
});
$("btn-download-concert").addEventListener("click", () => {
  if (!state.doc) return;
  download(`${slug(getTitle(state.doc))}-concert.musicxml`, serializeMusicXml(state.doc));
});

// ---------------------------------------------------------------- my charts (IndexedDB)
$("btn-save").addEventListener("click", async () => {
  if (!state.doc) return;
  const now = Date.now();
  const existing = state.chartId ? await getChart(state.chartId).catch(() => undefined) : undefined;
  const chart: SavedChart = {
    id: state.chartId ?? newId(),
    title: getTitle(state.doc),
    xml: serializeMusicXml(state.doc),
    warnings: state.warnings,
    view: { ...state.view },
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  try {
    await putChart(chart);
    state.chartId = chart.id;
    state.dirty = false;
    updateUndoUi();
    showInfo(`Saved “${chart.title}” to My charts (in this browser).`);
  } catch (e) {
    showError("Couldn't save: " + (e as Error).message);
  }
});

async function openLibrary(): Promise<void> {
  const dlg = $<HTMLDialogElement>("library");
  const list = $("library-list");
  list.innerHTML = "";
  let charts: SavedChart[] = [];
  try {
    charts = await listCharts();
  } catch (e) {
    showError("Couldn't read My charts: " + (e as Error).message);
  }
  $("library-empty").hidden = charts.length > 0;
  for (const c of charts) {
    const li = document.createElement("li");
    let keyLabel = "";
    try {
      const k = firstKey(parseMusicXml(c.xml));
      keyLabel = describeView(k.fifths, k.mode, DEFAULT_VIEW).concertKey;
    } catch {
      keyLabel = "?";
    }
    li.innerHTML = `<button class="lib-open" type="button"><strong></strong><span class="muted small"></span></button>
      <button class="btn small ghost danger" type="button" title="Delete">Delete</button>`;
    li.querySelector("strong")!.textContent = c.title;
    li.querySelector("span")!.textContent = `${keyLabel} · ${new Date(c.updatedAt).toLocaleString()}`;
    li.querySelector(".lib-open")!.addEventListener("click", async () => {
      dlg.close();
      await openXml(c.xml, { warnings: c.warnings, chartId: c.id, view: c.view as ViewState | undefined, meta: `From My charts · saved ${new Date(c.updatedAt).toLocaleString()}` });
    });
    li.querySelector(".danger")!.addEventListener("click", async () => {
      if (!confirm(`Delete “${c.title}”?`)) return;
      await deleteChart(c.id);
      if (state.chartId === c.id) state.chartId = null;
      void openLibrary();
    });
    list.appendChild(li);
  }
  if (!dlg.open) dlg.showModal();
}
$("btn-library").addEventListener("click", () => void openLibrary());

window.addEventListener("beforeunload", (e) => {
  if (state.doc && state.dirty && state.undo.length) e.preventDefault();
});

// ---------------------------------------------------------------- boot
buildInstrumentSelect();
void checkHealth();
// Debug hooks for tests
(window as unknown as { __jazz: unknown }).__jazz = { state, viewer, exportTransposed, harmonyToText };
