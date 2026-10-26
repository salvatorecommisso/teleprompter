// Phone-side storage: small values in localStorage, video takes in IndexedDB.

const PREFIX = "tp2_";

export function get(key, fallback = null) {
  try {
    const v = localStorage.getItem(PREFIX + key);
    return v == null ? fallback : JSON.parse(v);
  } catch { return fallback; }
}

export function set(key, value) {
  try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); } catch {}
}

export function remove(key) {
  try { localStorage.removeItem(PREFIX + key); } catch {}
}

let dbPromise = null;
function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open("teleprompter", 2);
      req.onupgradeneeded = () => {
        const d = req.result;
        const make = (name) => d.objectStoreNames.contains(name) || d.createObjectStore(name);
        make("takes");    // key "<scriptId>|<section>" -> { blob, mime, duration, at }
        make("outbox");   // key id -> { blob, name, mime, scriptId, at }  (waiting for Google Drive)
        make("finished"); // key id -> { blob, name, mime, scriptId, at, saved }  (kept for a batch save)
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req && req.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const idb = {
  put: (store, key, value) => tx(store, "readwrite", (s) => s.put(value, key)),
  get: (store, key) => tx(store, "readonly", (s) => s.get(key)),
  del: (store, key) => tx(store, "readwrite", (s) => s.delete(key)),
  keys: (store) => tx(store, "readonly", (s) => s.getAllKeys()),
};

export const takeKey = (scriptId, section) => `${scriptId}|${section}`;

export async function takesFor(scriptId) {
  const keys = (await idb.keys("takes")).filter((k) => k.startsWith(scriptId + "|"));
  const out = {};
  for (const k of keys) out[Number(k.split("|")[1])] = await idb.get("takes", k);
  return out;
}

export async function clearTakes(scriptId) {
  const keys = (await idb.keys("takes")).filter((k) => k.startsWith(scriptId + "|"));
  for (const k of keys) await idb.del("takes", k);
}
