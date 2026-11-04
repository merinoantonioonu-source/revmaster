/**
 * storage.js - A chrome.storage.local look-alike for a web page.
 *
 * UMBRA is a static page on GitHub Pages, so it has no chrome.storage. Code copied from COMeT
 * expects get/set/remove/onChanged with the same shapes; this module provides them on top of
 * localStorage. Every key is stored under the prefix 'umbra:' because all GitHub Pages sites of
 * one account share the same origin (and therefore the same localStorage).
 *
 * Change events fire in this tab (synchronously after set/remove) and in OTHER tabs of UMBRA
 * (through the browser 'storage' event), with the chrome.storage shape:
 *   { key: { oldValue, newValue } }
 */

const PREFIX = 'umbra:';
const _listeners = new Set();

function _ls() {
  try { return window.localStorage; } catch (_) { return null; }
}

function _read(key) {
  const ls = _ls();
  if (!ls) return undefined;
  const raw = ls.getItem(PREFIX + key);
  if (raw === null) return undefined;
  try { return JSON.parse(raw); } catch (_) { return undefined; }
}

function _emit(changes) {
  if (!changes || !Object.keys(changes).length) return;
  for (const fn of Array.from(_listeners)) {
    try { fn(changes, 'local'); } catch (e) { console.error('storage listener', e); }
  }
}

function _allKeys() {
  const ls = _ls();
  const out = [];
  if (!ls) return out;
  for (let i = 0; i < ls.length; i++) {
    const k = ls.key(i);
    if (k && k.indexOf(PREFIX) === 0) out.push(k.slice(PREFIX.length));
  }
  return out;
}

export const storage = {
  /** keys: string | string[] | null (all UMBRA keys) | object of defaults. Resolves to { key: value }. */
  async get(keys) {
    const out = {};
    if (keys === null || keys === undefined) {
      for (const k of _allKeys()) { const v = _read(k); if (v !== undefined) out[k] = v; }
      return out;
    }
    if (typeof keys === 'string') keys = [keys];
    if (Array.isArray(keys)) {
      for (const k of keys) { const v = _read(k); if (v !== undefined) out[k] = v; }
      return out;
    }
    if (typeof keys === 'object') {
      for (const k of Object.keys(keys)) { const v = _read(k); out[k] = (v === undefined) ? keys[k] : v; }
    }
    return out;
  },

  async set(obj) {
    const ls = _ls();
    if (!ls || !obj) return;
    const changes = {};
    for (const k of Object.keys(obj)) {
      const oldValue = _read(k);
      const newValue = obj[k];
      try {
        ls.setItem(PREFIX + k, JSON.stringify(newValue));
      } catch (e) {
        // Quota exceeded: surface it, never fail silently (the caller may show it).
        const err = new Error('No queda espacio en el almacenamiento del navegador.');
        err.code = 'QUOTA';
        throw err;
      }
      changes[k] = { oldValue, newValue };
    }
    _emit(changes);
  },

  async remove(keys) {
    const ls = _ls();
    if (!ls) return;
    if (typeof keys === 'string') keys = [keys];
    const changes = {};
    for (const k of (keys || [])) {
      const oldValue = _read(k);
      if (oldValue === undefined) continue;
      ls.removeItem(PREFIX + k);
      changes[k] = { oldValue, newValue: undefined };
    }
    _emit(changes);
  },

  /** All UMBRA keys (without the prefix). */
  async keys() {
    return _allKeys();
  },

  /** fn(changes, 'local'). Returns the unsubscriber. */
  onChanged(fn) {
    if (typeof fn !== 'function') return () => {};
    _listeners.add(fn);
    return () => _listeners.delete(fn);
  }
};

// Changes made in another tab of UMBRA.
try {
  window.addEventListener('storage', (ev) => {
    if (!ev.key || ev.key.indexOf(PREFIX) !== 0) return;
    const k = ev.key.slice(PREFIX.length);
    let oldValue, newValue;
    try { oldValue = ev.oldValue === null ? undefined : JSON.parse(ev.oldValue); } catch (_) {}
    try { newValue = ev.newValue === null ? undefined : JSON.parse(ev.newValue); } catch (_) {}
    _emit({ [k]: { oldValue, newValue } });
  });
} catch (_) { /* not in a window (tests) */ }

export async function getValue(key, defaultValue) {
  const v = _read(key);
  return v === undefined ? defaultValue : v;
}

export async function setValue(key, value) {
  await storage.set({ [key]: value });
}

export async function removeValue(key) {
  await storage.remove(key);
}
