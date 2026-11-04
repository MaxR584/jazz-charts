// "My charts": a tiny IndexedDB store (no dependency).
import type { Warning } from "../../../shared/types";

export interface SavedChart {
  id: string;
  title: string;
  /** Concert-pitch, edited MusicXML (the source of truth). */
  xml: string;
  warnings: Warning[];
  view?: { concertOffset: number; instrument: string; octave: number };
  createdAt: number;
  updatedAt: number;
}

const DB = "jazz-charts";
const STORE = "charts";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("IndexedDB is not available in this browser."));
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("Could not open IndexedDB"));
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(req.result);
      t.onerror = () => reject(t.error ?? req.error);
      t.onabort = () => reject(t.error ?? new Error("Transaction aborted"));
    });
  } finally {
    db.close();
  }
}

export const listCharts = async (): Promise<SavedChart[]> =>
  (await tx<SavedChart[]>("readonly", (s) => s.getAll() as IDBRequest<SavedChart[]>)).sort((a, b) => b.updatedAt - a.updatedAt);
export const getChart = (id: string) => tx<SavedChart | undefined>("readonly", (s) => s.get(id));
export const putChart = (c: SavedChart) => tx("readwrite", (s) => s.put(c)).then(() => c);
export const deleteChart = (id: string) => tx("readwrite", (s) => s.delete(id)).then(() => undefined);

export function newId(): string {
  return (crypto.randomUUID?.() ?? Date.now().toString(36) + Math.random().toString(36).slice(2));
}
