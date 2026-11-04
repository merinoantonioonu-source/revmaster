/**
 * idb.js - Minimal IndexedDB helper for the data that is too big or too private for localStorage:
 * projects (documents, entities, findings), the results cache, file handles (sync file) and misc.
 */

const DB_NAME = 'umbra-db';
const DB_VERSION = 1;
export const STORES = ['projects', 'cache', 'handles', 'misc'];

let _dbPromise = null;

function _open() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { _dbPromise = null; reject(req.error); };
  });
  return _dbPromise;
}

function _tx(store, mode, fn) {
  return _open().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const os = tx.objectStore(store);
    let result;
    try { result = fn(os); } catch (e) { reject(e); return; }
    tx.oncomplete = () => resolve(result && result.__req ? result.__req.result : result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}

function _wrap(req) { return { __req: req }; }

export function idbGet(store, key) {
  return _tx(store, 'readonly', os => _wrap(os.get(key)));
}

export function idbPut(store, key, value) {
  return _tx(store, 'readwrite', os => { os.put(value, key); return true; });
}

export function idbDel(store, key) {
  return _tx(store, 'readwrite', os => { os.delete(key); return true; });
}

export function idbKeys(store) {
  return _tx(store, 'readonly', os => _wrap(os.getAllKeys()));
}

export async function idbAll(store) {
  const keys = await idbKeys(store);
  const out = {};
  for (const k of keys) out[k] = await idbGet(store, k);
  return out;
}

export function idbClear(store) {
  return _tx(store, 'readwrite', os => { os.clear(); return true; });
}
