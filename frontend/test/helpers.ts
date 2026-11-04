import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export function scoreXml(fifths: number, measures: string[], mode = "major"): string {
  const body = measures
    .map(
      (m, i) =>
        `<measure number="${i + 1}">` +
        (i === 0
          ? `<attributes><divisions>12</divisions><key><fifths>${fifths}</fifths><mode>${mode}</mode></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>`
          : "") +
        m +
        `</measure>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Lead</part-name></score-part></part-list><part id="P1">${body}</part></score-partwise>`;
}

/** A quarter note, e.g. n("A", 1, 4). */
export function n(step: string, alter: number, octave: number, extra = ""): string {
  return `<note><pitch><step>${step}</step>${alter ? `<alter>${alter}</alter>` : ""}<octave>${octave}</octave></pitch><duration>12</duration><voice>1</voice><type>quarter</type>${extra}</note>`;
}

export function chord(step: string, alter: number, kind: string, text: string, bass?: [string, number]): string {
  return (
    `<harmony><root><root-step>${step}</root-step>${alter ? `<root-alter>${alter}</root-alter>` : ""}</root><kind text="${text}">${kind}</kind>` +
    (bass ? `<bass><bass-step>${bass[0]}</bass-step>${bass[1] ? `<bass-alter>${bass[1]}</bass-alter>` : ""}</bass>` : "") +
    `</harmony>`
  );
}

export function sampleXml(): string {
  return readFileSync(resolve(__dirname, "../public/samples/sample.musicxml"), "utf8");
}
