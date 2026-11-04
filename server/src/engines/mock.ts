import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LeadSheet } from "../../../shared/types.js";
import { buildMusicXML } from "../musicxml/builder.js";
import { validateLeadSheet } from "../musicxml/validate.js";
import { FIXTURES_DIR } from "../paths.js";
import { EngineError, type ConversionEngine, type EngineResult } from "./types.js";

/** Returns the bundled fixture regardless of the upload, so the frontend can be built without keys. */
export class MockEngine implements ConversionEngine {
  readonly name = "mock" as const;

  constructor(private readonly fixturePath = join(FIXTURES_DIR, "sample-1.json")) {}

  isAvailable(): boolean {
    return true;
  }

  async convert(): Promise<EngineResult> {
    let sheet: LeadSheet;
    try {
      sheet = JSON.parse(readFileSync(this.fixturePath, "utf8")) as LeadSheet;
    } catch (e) {
      throw new EngineError("internal", `Mock fixture not readable: ${(e as Error).message}`);
    }
    return { musicxml: buildMusicXML(sheet), model: sheet, warnings: validateLeadSheet(sheet) };
  }
}
