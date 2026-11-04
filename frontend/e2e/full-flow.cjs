const { chromium } = require("playwright");
const fs = require("fs");
const FIX = require("path").resolve(__dirname, "../../fixtures");
const OUT = process.argv[2] || "/tmp";
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  await page.goto("http://localhost:5173");
  await page.waitForSelector("#server-pill.ok", { timeout: 10000 });
  console.log("pill:", (await page.textContent("#server-pill")).trim());
  for (const [file, engine] of [["sample-1.png", "mock"], ["sample-1.png", "audiveris"], ["sample-1.pdf", "audiveris"]]) {
    await page.selectOption("#engine", engine);
    const t0 = Date.now();
    const resp = page.waitForResponse((r) => r.url().includes("/api/convert"), { timeout: 120000 });
    await page.setInputFiles("#file-image", `${FIX}/${file}`);
    const r = await resp;
    await page.waitForSelector("#score [data-note]", { timeout: 30000 });
    await page.waitForTimeout(500);
    const chords = await page.$$eval("#score [data-chord]", (els) => els.map((e) => e.textContent.replace(/\s+/g, "")));
    const notes = await page.$$eval("#score [data-note]", (e) => e.length);
    const warns = await page.$$eval("#warnings-list li", (e) => e.map((x) => x.textContent.trim())).catch(() => []);
    console.log(`${file}/${engine}: HTTP ${r.status()} ${Date.now() - t0}ms notes=${notes} chords=${chords.length} [${chords.join(" ")}] warnings=${warns.length}`);
    if (warns.length) console.log("  ", warns.slice(0, 5).join(" | "));
    await page.screenshot({ path: `${OUT}/${file}-${engine}.png`, fullPage: true });
  }
  // transpose to Bb instrument and download
  await page.selectOption("#instrument", "Bb");
  await page.waitForTimeout(800);
  console.log("written key:", (await page.textContent("#written-key")).trim());
  const chordsBb = await page.$$eval("#score [data-chord]", (els) => els.map((e) => e.textContent.replace(/\s+/g, "")));
  console.log("Bb chords:", chordsBb.join(" "));
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#btn-download")]);
  const p = `${OUT}/${dl.suggestedFilename()}`; await dl.saveAs(p);
  console.log("downloaded:", p, fs.statSync(p).size, "bytes");
  await page.screenshot({ path: `${OUT}/transposed-Bb.png`, fullPage: true });
  console.log("console errors:", errors.length ? errors : "none");
  await browser.close();
})().catch((e) => { console.error("FAIL", e); process.exit(1); });
