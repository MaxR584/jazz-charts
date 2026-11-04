/**
 * Regenerate fixtures/sample-1.{musicxml,png,pdf} from fixtures/sample-1.json.
 *
 *   npm run fixtures
 *
 * MusicXML comes from our builder; it is engraved with Verovio (SVG) and
 * rasterized / printed with Playwright's Chromium. The PNG is one page
 * (screenshot-like); the PDF has two pages so multi-page handling is exercised.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import createVerovioModule from "verovio/wasm";
import { VerovioToolkit } from "verovio/esm";
import type { LeadSheet } from "../../shared/types.js";
import { buildMusicXML } from "../src/musicxml/builder.js";
import { FIXTURES_DIR } from "../src/paths.js";

// Playwright is installed globally in this environment (not a package dependency).
const require = createRequire(import.meta.url);
interface PwPage {
  setContent(html: string): Promise<void>;
  locator(sel: string): { first(): { screenshot(o: { path: string }): Promise<unknown> } };
  pdf(o: Record<string, unknown>): Promise<unknown>;
}
const { chromium } = require("playwright") as {
  chromium: { launch(): Promise<{ newPage(o?: Record<string, unknown>): Promise<PwPage>; close(): Promise<void> }> };
};

const name = process.argv[2] ?? "sample-1";
const sheet = JSON.parse(readFileSync(join(FIXTURES_DIR, `${name}.json`), "utf8")) as LeadSheet;
const xml = buildMusicXML(sheet);
writeFileSync(join(FIXTURES_DIR, `${name}.musicxml`), xml);

const VerovioModule = await createVerovioModule();
const tk = new VerovioToolkit(VerovioModule);

function render(opts: Record<string, unknown>): string[] {
  tk.setOptions({
    footer: "none",
    header: "auto",
    scale: 45,
    pageWidth: 2100,
    pageMarginLeft: 80,
    pageMarginRight: 80,
    pageMarginTop: 60,
    pageMarginBottom: 60,
    font: "Leipzig",
    ...opts,
  });
  // Verovio ignores <degree print-object="no"> and would print "A7b9(b9)"; the kind
  // text already spells the full suffix, so drop hidden degrees for engraving only.
  const forEngraving = xml.replace(/\s*<degree print-object="no">[\s\S]*?<\/degree>/g, "");
  if (!tk.loadData(forEngraving)) throw new Error("Verovio could not load the MusicXML");
  const n = tk.getPageCount();
  return Array.from({ length: n }, (_, i) => tk.renderToSVG(i + 1));
}

const page = (svg: string) =>
  `<div class="page">${svg}</div>`;
const html = (pages: string[], css: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;background:#fff}
  .page svg{display:block;width:100%;height:auto}
  ${css}</style></head><body>${pages.map(page).join("")}</body></html>`;

const browser = await chromium.launch();
try {
  // PNG: everything on one page, like a screenshot of a lead sheet.
  const single = render({ adjustPageHeight: true, pageHeight: 60000 });
  const p1 = await browser.newPage({ viewport: { width: 1400, height: 800 }, deviceScaleFactor: 1 });
  await p1.setContent(html(single.slice(0, 1), ".page{width:1400px}"));
  await p1.locator(".page").first().screenshot({ path: join(FIXTURES_DIR, `${name}.png`) });

  // PDF: Letter pages, systems split over two pages.
  const multi = render({ adjustPageHeight: false, pageWidth: 2100, pageHeight: 2700, scale: 80, breaks: "auto", systemMaxPerPage: 2 });
  const p2 = await browser.newPage();
  await p2.setContent(
    html(multi, "@page{size:Letter;margin:0.5in}.page{width:7.5in;page-break-after:always}.page:last-child{page-break-after:auto}"),
  );
  await p2.pdf({ path: join(FIXTURES_DIR, `${name}.pdf`), format: "Letter", printBackground: true, preferCSSPageSize: true });
  console.log(`Wrote ${name}.musicxml, ${name}.png (1 page), ${name}.pdf (${multi.length} page(s))`);
} finally {
  await browser.close();
}
