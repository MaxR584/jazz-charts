import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** server/ directory */
export const SERVER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_DIR = resolve(SERVER_DIR, "..");
export const FIXTURES_DIR = process.env.FIXTURES_DIR ?? resolve(REPO_DIR, "fixtures");
export const VENDOR_DIR = resolve(SERVER_DIR, "vendor");
