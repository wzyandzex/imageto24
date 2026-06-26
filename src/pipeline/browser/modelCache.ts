/**
 * IndexedDB cache for downloaded AI model weights (issue #6, ADR-0003).
 *
 * The Real-ESRGAN general model is ~65MB; re-downloading it on every visit would
 * be a hostile UX and waste R2 bandwidth. We persist the raw model bytes in
 * IndexedDB keyed by a versioned model id, so a return visitor's first AI run
 * reads from disk instead of the network.
 *
 * This module is browser-bound (IndexedDB) and intentionally not unit-tested —
 * the pure AI dispatch (`aiUpscale`) is the tested seam. It is kept tiny and
 * dependency-free; there is no need for an IndexedDB wrapper library.
 */

const DB_NAME = "imageto24-models";
const STORE = "weights";
const DB_VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
  });
}

/**
 * Read cached model bytes by key, or undefined when absent. A cache miss (or any
 * IndexedDB failure) resolves to undefined rather than throwing: the caller then
 * downloads fresh, so a broken cache degrades to a re-download, never a hard error.
 */
export async function readCachedModel(key: string): Promise<ArrayBuffer | undefined> {
  try {
    const db = await openDb();
    try {
      return await new Promise<ArrayBuffer | undefined>((resolve, reject) => {
        const tx = db.transaction(STORE, "readonly");
        const req = tx.objectStore(STORE).get(key);
        req.onsuccess = () => resolve(req.result as ArrayBuffer | undefined);
        req.onerror = () => reject(req.error ?? new Error("IndexedDB get failed"));
      });
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

/**
 * Persist model bytes under a key. A write failure (e.g. quota exceeded) is
 * swallowed: caching is an optimisation, not a correctness requirement, so a
 * full disk means "download again next time", not a failed AI run.
 */
export async function writeCachedModel(key: string, bytes: ArrayBuffer): Promise<void> {
  try {
    const db = await openDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put(bytes, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error("IndexedDB put failed"));
      });
    } finally {
      db.close();
    }
  } catch {
    // Best-effort cache; ignore write failures.
  }
}
