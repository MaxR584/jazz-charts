// Generates public/samples/sample.musicxml — a self-composed 12-bar lead sheet ("Blue Lantern").
// Run: node scripts/make-sample.mjs
import { writeFileSync } from "node:fs";

const DIV = 12;
const DUR = { w: 48, "h.": 36, h: 24, "q.": 18, q: 12, 8: 6 };
const TYPE = { w: "whole", "h.": "half", h: "half", "q.": "quarter", q: "quarter", 8: "eighth" };
const KEY_FIFTHS = -1; // F major
const ACC = { "-1": "flat", "0": "natural", "1": "sharp" };
const inKey = { B: -1 };

const kinds = {
  maj7: ["major-seventh", "maj7"], 7: ["dominant", "7"], m7: ["minor-seventh", "m7"], 6: ["major-sixth", "6"],
};
function harmony(sym) {
  const m = sym.match(/^([A-G])(b|#)?(maj7|m7|7|6)$/);
  const [, step, acc, k] = m;
  const alter = acc === "b" ? "<root-alter>-1</root-alter>" : acc === "#" ? "<root-alter>1</root-alter>" : "";
  const [kind, text] = kinds[k];
  return `      <harmony><root><root-step>${step}</root-step>${alter}</root><kind text="${text}">${kind}</kind></harmony>\n`;
}

// note: "A4:q", "Bb4:8", "F#4:q", "r:q", "C5:h~" (tie start), "~F4:h" (tie stop)
function note(spec, accState) {
  let [p, d] = spec.split(":");
  let tieStop = false, tieStart = false;
  if (p.startsWith("~")) { tieStop = true; p = p.slice(1); }
  if (d.endsWith("~")) { tieStart = true; d = d.slice(0, -1); }
  const dots = d.endsWith(".") ? "<dot/>" : "";
  const beam = "";
  if (p === "r") return `      <note><rest/><duration>${DUR[d]}</duration><voice>1</voice><type>${TYPE[d]}</type>${dots}</note>\n`;
  const [, step, acc, oct] = p.match(/^([A-G])(b|#|n)?(\d)$/);
  const alter = acc === "b" ? -1 : acc === "#" ? 1 : 0;
  const key = step + oct;
  const expected = accState.has(key) ? accState.get(key) : (inKey[step] ?? 0);
  const showAcc = !tieStop && alter !== expected;
  if (!tieStop) accState.set(key, alter);
  const ties = (tieStop ? '<tie type="stop"/>' : "") + (tieStart ? '<tie type="start"/>' : "");
  const tied = (tieStop ? '<tied type="stop"/>' : "") + (tieStart ? '<tied type="start"/>' : "");
  return `      <note><pitch><step>${step}</step>${alter ? `<alter>${alter}</alter>` : ""}<octave>${oct}</octave></pitch>` +
    `<duration>${DUR[d]}</duration>${ties}<voice>1</voice><type>${TYPE[d]}</type>${dots}` +
    `${showAcc ? `<accidental>${ACC[alter]}</accidental>` : ""}${beam}${tied ? `<notations>${tied}</notations>` : ""}</note>\n`;
}

// Each measure: list of items; chords as "@Sym" placed before the next note.
const measures = [
  { left: "repeat", rehearsal: "A", items: ["@Fmaj7", "A4:q", "C5:q", "E5:h"] },
  { items: ["@D7", "D5:q.", "C5:8", "F#4:q", "A4:q"] },
  { items: ["@Gm7", "G4:8", "A4:8", "Bb4:8", "D5:8", "F5:h"] },
  { items: ["@C7", "E5:q", "D5:8", "C5:8", "Bb4:h"] },
  { items: ["@Am7", "C5:h", "@D7", "A4:q", "F#4:q"] },
  { items: ["@Gm7", "G4:q", "Bb4:q", "@C7", "E5:q", "Db5:q"] },
  { ending: ["1", "start"], items: ["@Fmaj7", "A4:h.", "r:q"] },
  { ending: ["1", "stop"], right: "repeat", items: ["@Gm7", "Bb4:q", "A4:q", "@C7", "G4:q", "E4:q"] },
  { ending: ["2", "start"], items: ["@Fmaj7", "F4:w~"] },
  { ending: ["2", "discontinue"], items: ["@Bb7", "~F4:h", "Ab4:q", "An4:q"] },
  { items: ["@Gm7", "Bb4:q", "D5:q", "@C7", "C5:q", "E4:q"] },
  { right: "final", items: ["@F6", "F4:w"] },
];

let body = "";
measures.forEach((m, i) => {
  body += `    <measure number="${i + 1}">\n`;
  if (i === 0) {
    body += `      <attributes><divisions>${DIV}</divisions><key><fifths>${KEY_FIFTHS}</fifths><mode>major</mode></key>` +
      `<time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>\n`;
  }
  const left = [];
  if (m.left === "repeat") left.push(`<bar-style>heavy-light</bar-style><repeat direction="forward"/>`);
  if (m.ending && m.ending[1] === "start") left.push(`<ending number="${m.ending[0]}" type="start">${m.ending[0]}.</ending>`);
  if (left.length) body += `      <barline location="left">${left.join("")}</barline>\n`;
  if (m.rehearsal) body += `      <direction placement="above"><direction-type><rehearsal>${m.rehearsal}</rehearsal></direction-type></direction>\n`;
  if (i === 0) body += `      <direction placement="above"><direction-type><words font-style="italic">Medium swing</words></direction-type><sound tempo="132"/></direction>\n`;
  const acc = new Map();
  for (const it of m.items) body += it.startsWith("@") ? harmony(it.slice(1)) : note(it, acc);
  const right = [];
  if (m.right === "repeat") right.push(`<bar-style>light-heavy</bar-style>`);
  if (m.right === "final") right.push(`<bar-style>light-heavy</bar-style>`);
  if (m.ending && m.ending[1] !== "start") right.push(`<ending number="${m.ending[0]}" type="${m.ending[1]}"/>`);
  if (m.right === "repeat") right.push(`<repeat direction="backward"/>`);
  if (right.length) body += `      <barline location="right">${right.join("")}</barline>\n`;
  body += `    </measure>\n`;
});

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="4.0">
  <work><work-title>Blue Lantern</work-title></work>
  <identification>
    <creator type="composer">Jazz Charts sample (original, CC0)</creator>
    <encoding><software>jazz-charts make-sample.mjs</software></encoding>
  </identification>
  <part-list><score-part id="P1"><part-name>Lead</part-name></score-part></part-list>
  <part id="P1">
${body}  </part>
</score-partwise>
`;
writeFileSync(new URL("../public/samples/sample.musicxml", import.meta.url), xml);
console.log("wrote sample.musicxml", xml.length, "bytes");
