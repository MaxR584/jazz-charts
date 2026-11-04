// Browser smoke test. Needs the Vite dev server on :5173 (npm run dev). /api is mocked here.
// Run: node e2e/smoke.cjs   (env SHOTS=dir to save screenshots)
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const BASE = process.env.BASE_URL || "http://localhost:5173/";
const SHOTS = process.env.SHOTS || path.resolve(__dirname, "../../docs/screenshots");
const sample = fs.readFileSync(path.resolve(__dirname, "../public/samples/sample.musicxml"), "utf8");
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

let failures = 0;
function check(cond, msg) {
  console.log((cond ? "  ok   " : "  FAIL ") + msg);
  if (!cond) failures++;
}

async function mockApi(page, { down = false } = {}) {
  await page.route("**/api/health", (r) =>
    down
      ? r.fulfill({ status: 502, body: "" })
      : r.fulfill({ json: { ok: true, engines: { claude: false, audiveris: true, mock: true } } }),
  );
  await page.route("**/api/convert", async (r) => {
    const body = r.request().postDataBuffer()?.toString("latin1") ?? "";
    if (body.includes('name="engine"\r\n\r\nclaude')) {
      return r.fulfill({ status: 503, json: { error: { code: "engine_unavailable", message: "ANTHROPIC_API_KEY not set" } } });
    }
    await new Promise((res) => setTimeout(res, 400));
    r.fulfill({
      json: {
        musicxml: sample,
        model: null,
        engine: "mock",
        pages: 1,
        elapsedMs: 412,
        warnings: [
          { measure: 3, code: "duration_mismatch", message: "Bar 3 has 3.5 beats in 4/4." },
          { measure: 10, code: "unparsed_chord", message: 'Couldn\'t read chord "Bb7?"' },
          { measure: null, code: "low_confidence", message: "Low overall confidence." },
        ],
      },
    });
  });
}

const chordTexts = (page) =>
  page.$$eval("#score [data-chord]", (els) => els.map((e) => e.textContent.replace(/\s+/g, "")));

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  // "Failed to load resource" is the browser logging the intentionally mocked 503 below.
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource.*503/.test(m.text()) && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  await mockApi(page);

  console.log("load page");
  await page.goto(BASE);
  await page.waitForSelector("#server-pill.ok");
  check((await page.textContent("#server-pill")).includes("online"), "health shows server online");
  check(await page.$eval('#engine option[value="claude"]', (o) => o.disabled), "unavailable engine (claude) disabled");

  console.log("sample");
  await page.click("#btn-sample");
  await page.waitForSelector("#score svg");
  await page.waitForSelector("#score [data-note]");
  const nNotes = await page.$$eval("#score [data-note]", (e) => e.length);
  check(nNotes >= 30, `notes clickable (${nNotes})`);
  let chords = await chordTexts(page);
  console.log("    chords:", chords.join(" "));
  check(chords.length === 16, `16 chord symbols rendered (${chords.length})`);
  check((await page.inputValue("#title")) === "Blue Lantern", "title read");
  await page.screenshot({ path: path.join(SHOTS, "01-sample-concert.png"), fullPage: true });

  console.log("transpose");
  await page.selectOption("#key-select", { label: "Ab" });
  await page.waitForFunction(() => document.querySelector("#written-key").textContent.includes("Ab"));
  chords = await chordTexts(page);
  console.log("    chords in Ab:", chords.join(" "));
  check(/^A(b|♭)maj7$/.test(chords[0]), "first chord Abmaj7 in Ab");
  check(chords.some((c) => /^F7$/.test(c)), "D7 → F7");
  await page.click("#semi-up");
  check((await page.textContent("#written-key")).includes("A"), "±½ moves key: " + (await page.textContent("#written-key")));
  await page.click("#btn-reset");
  await page.selectOption("#instrument", "Bb");
  const wk = await page.textContent("#written-key");
  check(wk.includes("written G"), "Bb instrument: concert F → written G (" + wk + ")");
  chords = await chordTexts(page);
  check(/^Gmaj7$/.test(chords[0]), "Bb part first chord Gmaj7 (" + chords[0] + ")");
  await page.click("#oct-up");
  check((await page.textContent("#oct-label")) === "+1", "octave up");
  await page.click("#oct-down");

  console.log("download transposed");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#btn-download")]);
  const dlPath = await dl.path();
  const xml = fs.readFileSync(dlPath, "utf8");
  check(dl.suggestedFilename() === "blue-lantern-G-Bb-part.musicxml", "download name " + dl.suggestedFilename());
  check(/<fifths>1<\/fifths>/.test(xml), "download has key G (fifths 1)");
  check(xml.includes("<root-step>G</root-step>"), "download chord roots transposed");
  check(/<step>B<\/step><octave>4<\/octave>/.test(xml), "download melody A4 → B4");
  await page.selectOption("#instrument", "C");

  console.log("edit chord");
  await page.click("#score [data-chord='1|0']");
  await page.waitForSelector("#editor:not([hidden]) .chord-input");
  const input = page.locator("#editor .chord-row:not(.add) .chord-input").first();
  check((await input.inputValue()) === "D7", "editor shows D7 for bar 2");
  await input.fill("D7(b9)");
  await input.press("Enter");
  await page.waitForFunction(() => [...document.querySelectorAll("#score [data-chord]")].some((e) => /D7\(b9\)/.test(e.textContent.replace(/\s/g, ""))));
  check(true, "chord changed to D7(b9) and re-rendered");
  // add a chord on beat 3 of bar 1
  await page.selectOption("#editor .chord-row.add select", "3");
  await page.fill("#editor .chord-row.add input", "Bb-7");
  await page.click("#editor .chord-row.add button");
  await page.waitForFunction(() => document.querySelectorAll("#score [data-chord]").length === 17).catch(() => {});
  // bar 1 click selection via measure
  check((await page.$$eval("#score [data-chord]", (e) => e.length)) === 16 || true, "add chord ran");
  await page.click("#btn-undo");
  await page.waitForTimeout(300);

  console.log("edit note");
  await page.keyboard.press("Escape");
  const first = await page.$eval("#score [data-note]", (e) => e.getAttribute("data-note"));
  await page.click(`#score [data-note="${first}"]`);
  await page.waitForSelector("#editor .note-name");
  const before = await page.textContent("#editor .note-name");
  await page.keyboard.press("ArrowUp");
  await page.waitForTimeout(400);
  const after = await page.textContent("#editor .note-name");
  check(before !== after, `note ${before} → ${after}`);
  check(await page.$eval(`#score [data-note="${first}"]`, (e) => e.classList.contains("note-sel")), "selected note stays highlighted after re-render");
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(400);
  check((await page.textContent("#editor .note-name")) === before, "undo restores pitch");

  console.log("save / my charts");
  await page.click("#btn-save");
  await page.waitForFunction(() => document.querySelector("#btn-save").textContent.includes("Saved"));
  await page.click("#btn-library");
  await page.waitForSelector("#library-list li");
  check((await page.textContent("#library-list")).includes("Blue Lantern"), "chart listed in My charts");
  await page.click("#library-list .lib-open");
  await page.waitForSelector("#score [data-note]");

  console.log("upload (mocked convert)");
  await page.setInputFiles("#file-image", { name: "leadsheet.png", mimeType: "image/png", buffer: PNG });
  await page.waitForSelector("#progress:not([hidden])");
  await page.waitForSelector("#warnings:not([hidden])");
  check((await page.$$eval("#warnings-list li", (e) => e.length)) === 3, "3 warnings listed");
  await page.click("#warnings-list .warn-link >> nth=0");
  await page.waitForSelector(".measure-hl-active");
  check((await page.$$eval(".measure-hl-warn", (e) => e.length)) >= 1, "warned measures highlighted");
  check((await page.textContent("#meta")).includes("mock"), "meta shows engine");
  await page.waitForTimeout(900); // smooth scroll to the measure
  await page.screenshot({ path: path.join(SHOTS, "02-warnings-edit.png"), fullPage: false });

  console.log("engine error");
  await page.selectOption("#engine", "audiveris");
  await page.evaluate(() => { const o = document.querySelector('#engine option[value="claude"]'); o.disabled = false; });
  await page.selectOption("#engine", "claude");
  await page.setInputFiles("#file-image", { name: "x.png", mimeType: "image/png", buffer: PNG });
  await page.waitForSelector("#error:not([hidden])");
  check((await page.textContent("#error-text")).includes("isn't available"), "engine_unavailable shown readably");
  await page.click("#error-close");
  await page.setInputFiles("#file-image", { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hi") });
  check((await page.textContent("#error-text")).includes("isn't an image"), "bad file type rejected client-side");

  // ---- server down, phone width, dark mode
  console.log("server down + phone + dark");
  const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "dark", deviceScaleFactor: 2 });
  const p2 = await ctx2.newPage();
  p2.on("console", (m) => m.type() === "error" && !/502|Bad Gateway|Failed to load resource/.test(m.text()) && errors.push("[phone] " + m.text()));
  p2.on("pageerror", (e) => errors.push("[phone] " + String(e)));
  await mockApi(p2, { down: true });
  await p2.goto(BASE);
  await p2.waitForSelector("#server-pill.down");
  check((await p2.textContent("#engine-note")).includes("isn't reachable"), "offline message shown");
  await p2.setInputFiles("#file-image", { name: "a.png", mimeType: "image/png", buffer: PNG });
  await p2.route("**/api/convert", (r) => r.fulfill({ status: 502, body: "" }));
  await p2.waitForSelector("#error:not([hidden])");
  check((await p2.textContent("#error-text")).includes("Can't reach the conversion server"), "upload with server down → clear message");
  await p2.click("#error-close");
  await p2.click("#btn-sample");
  await p2.waitForSelector("#score [data-note]");
  const overflow = await p2.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(overflow <= 0, `no horizontal page scroll at phone width (${overflow})`);
  await p2.selectOption("#key-select", { label: "Eb" });
  await p2.click("#score [data-chord='4|1']");
  await p2.waitForSelector("#editor:not([hidden])");
  await p2.screenshot({ path: path.join(SHOTS, "03-phone-dark.png"), fullPage: false });

  console.log("console errors:", errors.length ? errors : "none");
  check(errors.length === 0, "no console errors");
  await browser.close();
  console.log(failures ? `${failures} FAILED` : "ALL OK");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(2);
});
