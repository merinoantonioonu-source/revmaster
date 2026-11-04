/**
 * sync-autosave.js - Writes the linked sync file by itself while the user works.
 *
 * Origin: COMeT services/sync-autosave.js @ 04540f5 (adapted)
 *
 * Detection: storage.onChanged (this tab and the other tabs of UMBRA) on a key that travels
 * (sync-spec.js), or on an API key while "Incluir claves de API cifradas" is on.
 * Strategy: a debounce after each change (DEBOUNCE_MS) + a safety timer (SAFETY_MS). Saving is
 * SILENT: only when write permission is already granted; when a click is needed the state becomes
 * 'needs_gesture' (the header shows an amber "Guardar") and the change waits for the next manual save.
 * It writes ONLY after the user decided in this session (sync-fs.js startupSyncCheck: bring or save),
 * and not while a "bring data" waits to be confirmed (PULL_HOLD_MS), so that "Deshacer lo traido"
 * never leaves an old copy already merged into the file.
 * It never writes when the page is hidden or closing (COMeT learnt that an unfinished write leaves
 * the file at 0 bytes): it notes '_sync_pending' and picks it up when the page is seen again.
 */

import { storage, getValue } from '../store/storage.js';
import {
  getLinkedFileName, saveToSyncFileSilent, LAST_PULL_KEY, PULL_HOLD_MS, isSessionDecided, setSyncState, getSyncState
} from './sync-fs.js';
import { isSyncedKey, AUTOSAVE_PREF_KEY, SECRETS_PREF_KEY, SECRETS_PASS_KEY, API_KEY_PREFIX } from './sync-spec.js';

let DEBOUNCE_MS = 12000;
let SAFETY_MS = 5 * 60000;

let _started = false;
let _enabled = true;
let _hasFile = false;
let _secrets = false;
let _dirty = false;
let _saving = false;
let _debounceTimer = null;
let _safetyTimer = null;
let _unsub = null;

async function _refreshFlags() {
  try { _enabled = (await getValue(AUTOSAVE_PREF_KEY, true)) !== false; } catch (_) { _enabled = true; }
  try { _secrets = !!(await getValue(SECRETS_PREF_KEY, false)); } catch (_) { _secrets = false; }
  try { _hasFile = !!(await getLinkedFileName()); } catch (_) { _hasFile = false; }
}

function _schedule(ms) {
  if (_debounceTimer) clearTimeout(_debounceTimer);
  _debounceTimer = setTimeout(() => { _saveNow('debounce'); }, ms === undefined ? DEBOUNCE_MS : ms);
}

/** Something that travels changed: save after the debounce. */
export function markDirty() {
  _dirty = true;
  if (_enabled && _hasFile) _schedule();
}

function _meaningful(k) {
  if (!k || k.charAt(0) === '_') return false;
  if (isSyncedKey(k)) return true;
  if (_secrets && (k.indexOf(API_KEY_PREFIX) === 0 || k === SECRETS_PASS_KEY)) return true;
  return k === SECRETS_PREF_KEY;
}

async function _saveNow(reason) {
  if (!_hasFile) await _refreshFlags();
  if (!_enabled || !_hasFile || !_dirty || _saving) return { skipped: true };
  // Only after the user decided (bring or save) in this session.
  if (!isSessionDecided()) {
    setSyncState({ state: 'needs_gesture', message: 'Cambios pendientes: elige si traes o guardas para que el autoguardado escriba.' });
    return { skipped: 'undecided' };
  }
  // After "bring data", a moment of waiting until the user confirms the copy (or the hold ends).
  try {
    const p = await getValue(LAST_PULL_KEY, null);
    const left = (p && p.at && !p.confirmed) ? (p.at + PULL_HOLD_MS) - Date.now() : 0;
    if (left > 0) { _schedule(left + 1000); return { skipped: 'pull_hold' }; }
  } catch (_) {}
  _saving = true;
  setSyncState({ state: 'saving', message: 'Guardando...' });
  try {
    const res = await saveToSyncFileSilent();
    _dirty = false;
    try { await storage.remove('_sync_pending'); } catch (_) {}
    setSyncState({ state: 'ok', message: res && res.restored
      ? 'Guardado (el archivo estaba vac\u00edo y se ha rellenado con la copia local).'
      : 'Guardado autom\u00e1ticamente.' });
    if (res && res.restored) console.warn('sync-autosave: the sync file was EMPTY; refilled from the local copy', { reason });
    return { saved: true };
  } catch (e) {
    const code = e && e.code;
    if (code === 'PERMISSION_NEEDS_GESTURE') {
      setSyncState({ state: 'needs_gesture', message: 'El navegador pide un clic para volver a escribir el archivo: pulsa "Guardar".' });
    } else if (code === 'SYNC_FILE_UNEXPECTEDLY_EMPTY') {
      setSyncState({ state: 'needs_gesture', message: 'El archivo se lee vac\u00edo pero ten\u00eda datos: no se escribe (OneDrive puede no haberlo descargado a\u00fan).' });
    } else if (code === 'SYNC_FILE_UNREADABLE') {
      setSyncState({ state: 'needs_gesture', message: 'El archivo no se ha descargado en este equipo: no se escribe para no perder datos.' });
    } else if (code === 'NO_LINKED_FILE') {
      _hasFile = false;
      setSyncState({ linked: false, fileName: null, state: 'off', message: '' });
    } else {
      setSyncState({ state: 'error', message: (e && e.message) || String(e) });
    }
    console.warn('sync-autosave: not saved', code || e);
    return { saved: false, code };
  } finally {
    _saving = false;
  }
}

/** Saves now if there is something pending (same rules as the timer). For tests and "Guardar ahora". */
export async function flushAutosave() {
  if (_debounceTimer) { clearTimeout(_debounceTimer); _debounceTimer = null; }
  return _saveNow('flush');
}

/** For tests: shorter timers. */
export function setAutosaveTiming(t) {
  if (t && t.debounceMs) DEBOUNCE_MS = t.debounceMs;
  if (t && t.safetyMs) SAFETY_MS = t.safetyMs;
}

/** Starts the engine once per page (main.js, after startupSyncCheck()). */
export function initAutosave() {
  if (_started) return;
  _started = true;
  _refreshFlags();

  _unsub = storage.onChanged((changes) => {
    const keys = Object.keys(changes || {});
    if (keys.includes(AUTOSAVE_PREF_KEY)) {
      _enabled = changes[AUTOSAVE_PREF_KEY].newValue !== false;
      if (_enabled && _hasFile && _dirty) _schedule();
    }
    if (keys.includes(SECRETS_PREF_KEY)) _secrets = !!changes[SECRETS_PREF_KEY].newValue;
    if (keys.some(_meaningful)) {
      // A newly linked file is noticed here too.
      if (!_hasFile) _refreshFlags().then(() => markDirty());
      else markDirty();
    }
  });

  _safetyTimer = setInterval(() => { _refreshFlags().then(() => _saveNow('timer')); }, SAFETY_MS);

  try {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        if (_dirty) { storage.set({ _sync_pending: Date.now() }).catch(() => {}); }
        return;
      }
      getValue('_sync_pending', null).then((v) => { if (v) markDirty(); }).catch(() => {});
    });
  } catch (_) {}

  // Work left pending the last time the page closed.
  getValue('_sync_pending', null).then((v) => { if (v) markDirty(); }).catch(() => {});
  if (getSyncState().state === 'off') _refreshFlags();
}

/** Stops the engine (tests). */
export function stopAutosave() {
  if (_unsub) _unsub();
  if (_safetyTimer) clearInterval(_safetyTimer);
  if (_debounceTimer) clearTimeout(_debounceTimer);
  _unsub = null; _safetyTimer = null; _debounceTimer = null; _started = false;
}
