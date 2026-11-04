/**
 * Run the Audiveris engine on fixtures/<name>.{png,pdf} and score it against
 * fixtures/<name>.musicxml (hand-checked ground truth).
 *
 *   npm run eval:audiveris [-- sample-1]
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AudiverisEngine } from "../src/engines/audiveris.js";
import { compareScores, summarizeMusicXML } from "../src/musicxml/summary.js";
import { FIXTURES_DIR } from "../src/paths.js";
import { prepareInput } from "../src/pipeline/pages.js";
import { sniffType } from "../src/pipeline/sniff.js";

const name = process.argv[2] ?? "sample-1";
const engine = new AudiverisEngine();
if (!engine.isAvailable()) {
  console.error("Audiveris is not installed. Run scripts/install-audiveris.sh");
  process.exit(1);
}
const truth = summarizeMusicXML(readFileSync(join(FIXTURES_DIR, `${name}.musicxml`), "utf8"));

for (const ext of ["pdf", "png"]) {
  const buf = readFileSync(join(FIXTURES_DIR, `${name}.${ext}`));
  const input = await prepareInput(buf, sniffType(buf)!);
  const t0 = performance.now();
  try {
    const res = await engine.convert(input);
    const got = summarizeMusicXML(res.musicxml);
    const acc = compareScores(truth, got);
    console.log(
      JSON.stringify({ file: `${name}.${ext}`, seconds: Math.round((performance.now() - t0) / 100) / 10, ...acc, warnings: res.warnings.length }),
    );
    if (process.env.VERBOSE) {
      console.log("expected chords", truth.chords.join(" "));
      console.log("got chords     ", got.chords.join(" "));
      console.log("expected notes ", truth.notes.join(" "));
      console.log("got notes      ", got.notes.join(" "));
      console.log(res.warnings);
    }
  } catch (e) {
    console.log(JSON.stringify({ file: `${name}.${ext}`, error: (e as Error).message }));
  }
}
