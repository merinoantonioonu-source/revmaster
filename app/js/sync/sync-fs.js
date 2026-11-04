/**
 * sync-fs.js - Synchronization through ONE file (OneDrive, network drive) with the File System Access
 * API: the page remembers a FileSystemFileHandle in IndexedDB and saves/brings the data with a click
 * (or by itself: sync-autosave.js).
 *
 * Origin: COMeT services/sync-fs.js @ 04540f5 (adapted)
 * Origin: COMeT toolbar/toolbar.js @ 04540f5 (adapted)  (_showSyncDecisionPrompt: the question at opening)
 *
 * KEPT FROM COMeT (each one fixed a real loss of data there):
 * - The handle lives in IndexedDB (idb.js, store 'handles'); permission is queried silently and
 *   requested only with a user gesture.
 * - Merge, never overwrite: every save reads the file first and merges (sync-spec.js).
 * - A local copy of the LAST GOOD content of the file: a file found at 0 bytes is refilled from it,
 *   and a 0-byte file that had content before is an ALARM (OneDrive may not have brought it yet),
 *   never an invitation to write.
 * - Verified write (size checked, BOM written apart), one writer at a time (navigator.locks).
 * - The signature of the computer that saved (meta.device, meta.devices) and the question at opening.
 * - "Bring data" keeps a photo of this computer's data first: undoLastPull() puts it back. While the
 *   pull is not confirmed (PULL_HOLD_MS), the autosave waits.
 * - The autosave writes only after the user decided in this session (bring or save), see
 *   startupSyncCheck().
 * DROPPED: everything about COMeT's corpus, productivity, QA lists, queries and unlock flags.
 * NEW: meta.kind = 'umbra-sync'; any other kind (COMeT's 'comet-sync' above all) is REFUSED for
 * reading and for writing. Optional encrypted API keys (`secrets`). A manual download/load for
 * browsers without the File System Access API (only Chrome and Edge have it).
 */

import { storage, getValue, setValue } from '../store/storage.js';
import { idbGet, idbPut, idbDel } from '../store/idb.js';
import { encryptJSON, decryptJSON, fnv1a } from '../util/crypto.js';
import { el, toast, download, promptDialog } from '../util/dom.js';
import { getDevice, setDeviceName, relativeDay } from './sync-device.js';
import {
  SYNC_KIND, SYNC_VERSION, DEFAULT_FILE_NAME, SECRETS_KEY, SECRETS_PREF_KEY, SECRETS_PASS_KEY, API_KEY_PREFIX,
  AUTOSAVE_PREF_KEY, isSyncedKey, mergeValue, mergeSyncData, assertUmbraSync, isUmbraSync, recordTime
} from './sync-spec.js';

export { mergeSyncData, assertUmbraSync } from './sync-spec.js';

const HANDLE_STORE = 'handles';
const HANDLE_KEY = 'syncFileHandle';
const SNAPSHOT_KEY = 'lastGoodSyncData';
const PRE_PULL_KEY = 'prePullSnapshot';
export const LAST_PULL_KEY = 'sync_last_pull';
export const LAST_PUSH_KEY = 'sync_last_push_date';
export const PULL_HOLD_MS = 10 * 60000;
const SECRETS_FP_KEY = '_sync_secrets_fp';
const DECIDED_KEY = 'umbra:_sync_session_decided';

// Under this, a file that gives no text is TRUNCATED, not "in the cloud": an online-only placeholder
// declares the real size of the file (hundreds of KB), not three bytes (a lone UTF-8 BOM).
const BLANK_TINY_MAX = 64;
const SNAPSHOT_MIN_INTERVAL_MS = 10 * 60000;
let _snapshotAt = 0;

function _err(code, message, extra) {
  const e = new Error(message);
  e.code = code;
  if (extra) Object.assign(e, extra);
  return e;
}

// ------------------------------------------------------------------ state (header chip)

let _state = { linked: false, fileName: null, state: 'off', at: 0, message: '' };
const _stateListeners = new Set();

/** { linked, fileName, state: 'ok'|'saving'|'needs_gesture'|'error'|'off', at, message } */
export function getSyncState() { return Object.assign({}, _state); }

/** fn(state) on every change. Returns the unsubscriber. */
export function onSyncState(fn) {
  if (typeof fn !== 'function') return () => {};
  _stateListeners.add(fn);
  return () => _stateListeners.delete(fn);
}

export function setSyncState(patch) {
  _state = Object.assign({}, _state, patch || {}, { at: (patch && patch.at) || Date.now() });
  if (!_state.linked && _state.state !== 'error') _state.state = 'off';
  const snap = getSyncState();
  for (const fn of Array.from(_stateListeners)) {
    try { fn(snap); } catch (e) { console.error('onSyncState listener', e); }
  }
}

/** Re-reads whether a file is linked and publishes it. */
export async function refreshSyncState() {
  let name = null;
  try { name = await getLinkedFileName(); } catch (_) { name = null; }
  if (!name) setSyncState({ linked: false, fileName: null, state: 'off', message: '' });
  else setSyncState({ linked: true, fileName: name });
  return getSyncState();
}

// ------------------------------------------------------------------ session decision

let _decidedMem = false;
/** Did the user decide (bring or save) in this tab session? The autosave waits until they do. */
export function isSessionDecided() {
  if (_decidedMem) return true;
  try { return window.sessionStorage.getItem(DECIDED_KEY) === '1'; } catch (_) { return false; }
}
function _setDecided(v) {
  _decidedMem = !!v;
  try {
    if (v) window.sessionStorage.setItem(DECIDED_KEY, '1');
    else window.sessionStorage.removeItem(DECIDED_KEY);
  } catch (_) {}
}

// ------------------------------------------------------------------ handle + local copies (IndexedDB)

async function _saveHandle(handle) { await idbPut(HANDLE_STORE, HANDLE_KEY, handle); }
async function _loadHandle() {
  try { return (await idbGet(HANDLE_STORE, HANDLE_KEY)) || null; } catch (_) { return null; }
}
async function _clearHandle() { try { await idbDel(HANDLE_STORE, HANDLE_KEY); } catch (_) {} }

// The JSON already SERIALIZED is kept (the string is made for the file anyway).
async function _saveSnapshot(json, force) {
  const now = Date.now();
  if (!force && (now - _snapshotAt) < SNAPSHOT_MIN_INTERVAL_MS) return;
  try { await idbPut(HANDLE_STORE, SNAPSHOT_KEY, { at: now, json }); _snapshotAt = now; } catch (_) {}
}
async function _loadSnapshot() {
  let rec = null;
  try { rec = await idbGet(HANDLE_STORE, SNAPSHOT_KEY); } catch (_) { return null; }
  if (!rec || typeof rec.json !== 'string' || !rec.json) return null;
  try { return { at: rec.at, data: JSON.parse(rec.json) }; } catch (_) { return null; }
}
async function _clearSnapshot() { try { await idbDel(HANDLE_STORE, SNAPSHOT_KEY); } catch (_) {} _snapshotAt = 0; }

export function isSupported() {
  return typeof window !== 'undefined' && 'showSaveFilePicker' in window && 'showOpenFilePicker' in window;
}

// ------------------------------------------------------------------ export / import

async function _apiKeysOf(all) {
  const keys = {};
  for (const k of Object.keys(all || {})) {
    if (k.indexOf(API_KEY_PREFIX) === 0 && typeof all[k] === 'string' && all[k]) keys[k.slice(API_KEY_PREFIX.length)] = all[k];
  }
  return keys;
}

function _keysFingerprint(keys, pass) {
  const ids = Object.keys(keys).sort();
  return fnv1a(JSON.stringify(ids.map(id => [id, keys[id]])) + '\u0001' + pass);
}

/**
 * The encrypted box of this computer's API keys, when the user enabled it and set a password:
 * { updatedAt, box } (box = encryptJSON({ <providerId>: key }, password)). Re-encrypted only when the
 * keys or the password change, so updatedAt says when they really changed.
 */
async function _currentSecrets(all) {
  if (!all[SECRETS_PREF_KEY]) return null;
  const pass = all[SECRETS_PASS_KEY];
  if (!pass) return null;
  const keys = await _apiKeysOf(all);
  const fp = _keysFingerprint(keys, pass);
  const cur = all[SECRETS_KEY];
  if (cur && cur.box && all[SECRETS_FP_KEY] === fp) return cur;
  const sec = { updatedAt: Date.now(), box: await encryptJSON(keys, pass) };
  await storage.set({ [SECRETS_KEY]: sec, [SECRETS_FP_KEY]: fp });
  return sec;
}

/** Everything that travels, from this computer: { meta, data }. */
export async function buildFullExportData() {
  const date = new Date().toISOString();
  const out = { meta: { kind: SYNC_KIND, version: SYNC_VERSION, app: 'UMBRA', date }, data: {} };
  try {
    const dev = await getDevice();
    out.meta.device = { id: dev.id, name: dev.name };
    out.meta.devices = { [dev.id]: { name: dev.name, at: date } };
  } catch (_) { /* no signature: the copy is saved anyway */ }
  const all = await storage.get(null);
  for (const k of Object.keys(all)) {
    if (k === SECRETS_KEY) continue;
    if (isSyncedKey(k)) out.data[k] = all[k];
  }
  try {
    const sec = await _currentSecrets(all);
    if (sec) out.data[SECRETS_KEY] = sec;
  } catch (e) { console.warn('sync: the API keys could not be encrypted', e); }
  return out;
}

// Who asks for the password of the encrypted keys (Settings may replace it; tests pass opts.password).
let _askPassword = async (why) => promptDialog('Claves de API cifradas',
  why || 'El archivo de sincronizaci\u00f3n trae claves de API cifradas. Escribe la contrase\u00f1a con la que se cifraron:',
  '', { type: 'password' });
export function setPasswordPrompt(fn) { if (typeof fn === 'function') _askPassword = fn; }

async function _applySecrets(fileSec, local, opts) {
  const localSec = local[SECRETS_KEY];
  if (localSec && localSec.box && recordTime(localSec) >= recordTime(fileSec)) return { applied: 0, skipped: 'not_newer' };
  const tries = [];
  if (opts.password) tries.push(opts.password);
  if (local[SECRETS_PASS_KEY] && tries.indexOf(local[SECRETS_PASS_KEY]) < 0) tries.push(local[SECRETS_PASS_KEY]);
  let keys = null, pass = null;
  for (const p of tries) {
    try { keys = await decryptJSON(fileSec.box, p); pass = p; break; } catch (_) {}
  }
  if (!keys && opts.interactive !== false) {
    let why;
    for (let i = 0; i < 2 && !keys; i++) {
      const p = await _askPassword(why);
      if (!p) break;
      try { keys = await decryptJSON(fileSec.box, p); pass = p; } catch (_) {
        why = 'Contrase\u00f1a incorrecta. Vuelve a escribirla (o cancela para seguir sin traer las claves):';
      }
    }
  }
  if (!keys) return { applied: 0, skipped: 'no_password' };
  const set = {};
  for (const id of Object.keys(keys)) if (typeof keys[id] === 'string' && keys[id]) set[API_KEY_PREFIX + id] = keys[id];
  set[SECRETS_KEY] = fileSec;
  set[SECRETS_PASS_KEY] = pass;
  set[SECRETS_PREF_KEY] = true;
  await storage.set(set);
  return { applied: Object.keys(keys).length, skipped: false };
}

/**
 * Merges a sync file's content INTO this computer (the file wins ties: bringing data is the user's
 * choice). opts: { password, interactive }. -> { keys: [changed storage keys], secrets }.
 */
export async function applyImportData(file, opts) {
  const o = opts || {};
  assertUmbraSync(file);
  const fdata = (file && file.data && typeof file.data === 'object') ? file.data : {};
  const local = await storage.get(null);
  const out = {};
  for (const k of Object.keys(fdata)) {
    if (k === SECRETS_KEY || !isSyncedKey(k)) continue;
    const merged = mergeValue(k, local[k], fdata[k], 'b');
    if (merged === undefined) continue;
    if (JSON.stringify(merged) !== JSON.stringify(local[k])) out[k] = merged;
  }
  if (Object.keys(out).length) await storage.set(out);
  let secrets = { applied: 0, skipped: 'none' };
  if (fdata[SECRETS_KEY] && fdata[SECRETS_KEY].box) secrets = await _applySecrets(fdata[SECRETS_KEY], local, o);
  return { keys: Object.keys(out), secrets };
}

// ------------------------------------------------------------------ reading the file

function _parseText(text) {
  let t = text || '';
  if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
  return t.trim();
}

/**
 * Reads the file for a WRITE and classifies it:
 *   data | empty (genuinely new) | empty_unexpected (0 bytes but it had content: OneDrive may not
 *   have brought it yet) | not_downloaded (no text but a real size: a cloud placeholder) |
 *   gone (getFile fails: replaced, renamed, restored from history) | corrupt (not JSON).
 */
async function _readExistingForWrite(handle) {
  let file = null, trimmed = '', openFailed = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise(r => setTimeout(r, 1200));
    try { file = await handle.getFile(); openFailed = false; } catch (_) { openFailed = true; continue; }
    let text;
    try { text = await file.text(); } catch (_) { continue; }
    trimmed = _parseText(text);
    if (trimmed) break;
  }
  if (openFailed || !file) return { state: 'gone' };
  if (!trimmed) {
    if ((file.size || 0) > BLANK_TINY_MAX) return { state: 'not_downloaded' };
    const snap = await _loadSnapshot();
    return { state: (snap && snap.data) ? 'empty_unexpected' : 'empty' };
  }
  try {
    const data = JSON.parse(trimmed);
    return (data && typeof data === 'object') ? { state: 'data', data } : { state: 'corrupt' };
  } catch (_) { return { state: 'corrupt' }; }
}

function _readFailure(state) {
  if (state === 'gone') {
    return _err('SYNC_FILE_GONE', 'UMBRA ya no puede abrir el archivo de sincronizaci\u00f3n vinculado. Pasa cuando el archivo se ha ' +
      'SUSTITUIDO, renombrado, movido o restaurado desde el historial de versiones: aunque se llame igual, para el navegador es ' +
      'otro archivo. SOLUCI\u00d3N: en Ajustes > Sincronizaci\u00f3n pulsa "Elegir archivo" y elige el mismo archivo. No se pierde nada.');
  }
  if (state === 'corrupt') {
    return _err('SYNC_FILE_CORRUPT', 'El archivo de sincronizaci\u00f3n tiene contenido, pero no es JSON v\u00e1lido (puede haber quedado a ' +
      'medias). No se ha sobrescrito nada. Puedes recuperar una versi\u00f3n anterior desde el historial de versiones de OneDrive.');
  }
  return _err('SYNC_FILE_UNREADABLE', 'No se ha podido leer el archivo de sincronizaci\u00f3n: ocupa espacio pero no devuelve texto, ' +
    'lo que apunta a un archivo "solo en la nube" que OneDrive a\u00fan no ha descargado en este equipo. No se ha sobrescrito nada. ' +
    '\u00c1brelo en el Explorador para que se descargue ("disponible sin conexi\u00f3n") y vuelve a intentarlo.');
}

// With what this computer's data is merged before writing.
async function _resolveWriteData(ex, localData) {
  if (ex && ex.state === 'data') return { data: mergeSyncData(ex.data, localData), restored: false };
  const snap = await _loadSnapshot();
  if (snap && snap.data && isUmbraSync(snap.data)) return { data: mergeSyncData(snap.data, localData), restored: true };
  return { data: localData, restored: false };
}

/**
 * Both sides carry encrypted keys and the boxes differ: open the file's box with this computer's
 * password and write the UNION (this computer's keys win), so that a save never drops the keys
 * another computer put in the file. Without the password the newer box stays (merge 'newest').
 */
async function _mergeSecretsForWrite(fileData, merged, localData) {
  const fs = fileData && fileData.data && fileData.data[SECRETS_KEY];
  const ls = localData && localData.data && localData.data[SECRETS_KEY];
  if (!fs || !ls || !fs.box || !ls.box || JSON.stringify(fs.box) === JSON.stringify(ls.box)) return;
  const pass = await getValue(SECRETS_PASS_KEY, '');
  if (!pass) return;
  let fk, lk;
  try { fk = await decryptJSON(fs.box, pass); lk = await decryptJSON(ls.box, pass); } catch (_) { return; }
  const union = Object.assign({}, fk, lk);
  if (JSON.stringify(Object.keys(union).sort()) === JSON.stringify(Object.keys(lk).sort())) return;
  merged.data[SECRETS_KEY] = { updatedAt: Math.max(recordTime(fs), recordTime(ls), Date.now()), box: await encryptJSON(union, pass) };
}

// Writes the JSON and CHECKS the file ended with the expected size (a truncated write is retried
// once and then reported, never announced as saved). The BOM and the JSON are written apart.
async function _writeVerified(handle, json) {
  const expected = json.length + 1;
  let lastSize = -1;
  for (let attempt = 0; attempt < 2; attempt++) {
    const writable = await handle.createWritable();
    try {
      await writable.write('\ufeff');
      await writable.write(json);
      await writable.close();
    } catch (e) {
      try { await writable.abort(); } catch (_) {}
      throw e;
    }
    let size = -1;
    try { size = (await handle.getFile()).size; } catch (_) { size = -1; }
    if (size < 0) return;
    if (size >= expected - 2) return;
    lastSize = size;
  }
  throw _err('SYNC_WRITE_TRUNCATED', 'La escritura del archivo de sincronizaci\u00f3n qued\u00f3 INCOMPLETA. Los datos de este equipo no se ' +
    'han perdido, pero el archivo no es de fiar: comprueba que hay espacio, que el archivo no est\u00e1 abierto en otro programa y que ' +
    'OneDrive ha terminado de sincronizarlo, y vuelve a intentarlo.', { expected, got: lastSize });
}

// ONE WRITER AT A TIME: navigator.locks is per origin, so it also serializes the tabs of UMBRA.
const WRITE_LOCK = 'umbra-sync-file-write';
async function _withWriteLock(fn) {
  try {
    if (typeof navigator !== 'undefined' && navigator.locks && navigator.locks.request) {
      return await navigator.locks.request(WRITE_LOCK, fn);
    }
  } catch (_) { /* no lock: better to write than not */ }
  return await fn();
}

function _signatureOf(data) {
  const m = (data && data.meta) || {};
  return {
    device: (m.device && m.device.id) ? { id: String(m.device.id), name: String(m.device.name || '') } : null,
    devices: (m.devices && typeof m.devices === 'object') ? m.devices : null
  };
}

async function _ensurePermission(handle, mode) {
  const opts = { mode };
  try {
    if ((await handle.queryPermission(opts)) === 'granted') return true;
    if ((await handle.requestPermission(opts)) === 'granted') return true;
  } catch (_) {}
  return false;
}

// Never prompts: the autosave runs without a user gesture.
async function _hasPermissionSilent(handle, mode) {
  try { return (await handle.queryPermission({ mode })) === 'granted'; } catch (_) { return false; }
}

// ------------------------------------------------------------------ linking

/** Reads a handle's content to make sure it is not someone else's file (empty is fine). */
async function _checkLinkable(handle) {
  let text = '';
  try { text = await (await handle.getFile()).text(); } catch (_) { return; }
  const t = _parseText(text);
  if (!t) return;
  let data;
  try { data = JSON.parse(t); } catch (_) {
    throw _err('SYNC_WRONG_KIND', 'Este archivo no es un archivo de sincronizaci\u00f3n de UMBRA (no es JSON). Elige o crea otro archivo ' +
      '(por ejemplo, ' + DEFAULT_FILE_NAME + ').');
  }
  assertUmbraSync(data);
}

/**
 * Links a file handle (from a picker, a drop or the tests). An existing file of another kind
 * (COMeT's above all) is refused. A different file than the one linked before forgets the local
 * copy of the old one's content.
 */
export async function linkFileHandle(handle) {
  if (!handle || typeof handle.getFile !== 'function') throw _err('NO_HANDLE', 'No se ha recibido ning\u00fan archivo.');
  await _checkLinkable(handle);
  const old = await _loadHandle();
  let same = false;
  try { same = !!(old && old.isSameEntry && await old.isSameEntry(handle)); } catch (_) { same = false; }
  if (!same) { await _clearSnapshot(); _setDecided(false); }
  await _saveHandle(handle);
  // Autosave on by default when a file is linked (as COMeT), unless the user turned it off before.
  try { if ((await getValue(AUTOSAVE_PREF_KEY, undefined)) === undefined) await setValue(AUTOSAVE_PREF_KEY, true); } catch (_) {}
  await refreshSyncState();
  return handle.name;
}

/** Links an EXISTING sync file with the "open" picker, which never truncates the file. */
export async function chooseSyncFile() {
  if (!isSupported()) throw _err('UNSUPPORTED', 'Este navegador no permite vincular un archivo (solo Chrome y Edge). Usa "Descargar archivo" y "Cargar archivo".');
  const [handle] = await window.showOpenFilePicker({
    multiple: false,
    types: [{ description: 'Sincronizaci\u00f3n de UMBRA', accept: { 'application/json': ['.json'] } }]
  });
  const name = await linkFileHandle(handle);
  // Choosing a file is not yet a decision: the question at opening (or a manual save/bring) is.
  setSyncState({ state: 'needs_gesture', message: 'Elige si traes los datos del archivo o guardas los de este equipo.' });
  return name;
}

/**
 * Creates a BRAND-NEW sync file with the "save" picker and fills it AT ONCE (the picker empties the
 * file it is given, so it is never left empty): this computer's data merged with the last good copy.
 */
export async function createSyncFile() {
  if (!isSupported()) throw _err('UNSUPPORTED', 'Este navegador no permite crear un archivo de sincronizaci\u00f3n (solo Chrome y Edge). Usa "Descargar archivo".');
  const handle = await window.showSaveFilePicker({
    suggestedName: DEFAULT_FILE_NAME,
    types: [{ description: 'Sincronizaci\u00f3n de UMBRA', accept: { 'application/json': ['.json'] } }]
  });
  const old = await _loadHandle();
  let same = false;
  try { same = !!(old && old.isSameEntry && await old.isSameEntry(handle)); } catch (_) { same = false; }
  if (!same) await _clearSnapshot();
  await _saveHandle(handle);
  try { if ((await getValue(AUTOSAVE_PREF_KEY, undefined)) === undefined) await setValue(AUTOSAVE_PREF_KEY, true); } catch (_) {}
  const out = await _pushTo(handle, { allowEmpty: true });
  _setDecided(true);
  await refreshSyncState();
  setSyncState({ state: 'ok', message: 'Archivo creado y guardado.' });
  return { name: handle.name, bytes: out.bytes, restored: out.restored };
}

export async function getLinkedFileName() {
  const handle = await _loadHandle();
  return handle ? handle.name : null;
}

export async function unlinkSyncFile() {
  await _clearHandle();
  await _clearSnapshot();
  _setDecided(false);
  setSyncState({ linked: false, fileName: null, state: 'off', message: '' });
}

// ------------------------------------------------------------------ peeking

async function _peek(handle) {
  try {
    const file = await handle.getFile();
    const sizeBytes = file.size;
    const text = _parseText(await file.text());
    if (!text) {
      const snap = await _loadSnapshot();
      if (sizeBytes > BLANK_TINY_MAX) return { notDownloaded: true, sizeBytes };
      return { empty: true, sizeBytes, hadContentBefore: !!(snap && snap.data) };
    }
    const data = JSON.parse(text);
    if (!isUmbraSync(data)) {
      let message = '';
      try { assertUmbraSync(data); } catch (e) { message = e.message; }
      return { wrongKind: (data && data.meta && data.meta.kind) || 'unknown', message, sizeBytes };
    }
    return Object.assign({ date: (data.meta && data.meta.date) || null, sizeBytes }, _signatureOf(data));
  } catch (e) {
    return { error: (e && e.message) ? e.message : String(e) };
  }
}

/** The meta of the linked file without applying anything (no prompt): { date, device, devices,
 *  sizeBytes } | { needsPermission } | { empty, hadContentBefore } | { wrongKind, message } | { error } | null. */
export async function peekSyncFileMeta() {
  const handle = await _loadHandle();
  if (!handle) return null;
  if (!(await _hasPermissionSilent(handle, 'read'))) return { needsPermission: true };
  return _peek(handle);
}

/** The same, asking for permission (needs a user gesture). */
export async function peekSyncFileMetaWithPermission() {
  const handle = await _loadHandle();
  if (!handle) return null;
  if (!(await _ensurePermission(handle, 'read'))) return { needsPermission: true };
  return _peek(handle);
}

// ------------------------------------------------------------------ saving

async function _pushTo(handle, opts) {
  const o = opts || {};
  const localData = await buildFullExportData();
  let attempt = 0;
  for (;;) {
    try {
      const out = await _withWriteLock(async () => {
        const ex = o.allowEmpty ? { state: 'empty' } : await _readExistingForWrite(handle);
        if (ex.state === 'gone' || ex.state === 'not_downloaded' || ex.state === 'corrupt') throw _readFailure(ex.state);
        if (ex.state === 'data') assertUmbraSync(ex.data);
        if (ex.state === 'empty_unexpected' && !o.allowOverwriteEmpty) {
          throw _err('SYNC_FILE_UNEXPECTEDLY_EMPTY', 'El archivo de sincronizaci\u00f3n se lee VAC\u00cdO (0 bytes), pero antes ten\u00eda datos. ' +
            'Lo m\u00e1s probable es que OneDrive todav\u00eda no lo haya descargado en ESTE equipo. No se ha escrito nada, para no ' +
            'sobrescribir lo que guardaste en el otro equipo. Espera a que OneDrive lo marque como "disponible sin conexi\u00f3n" y vuelve a intentarlo.');
        }
        const resolved = await _resolveWriteData(ex, localData);
        if (ex.state === 'data') await _mergeSecretsForWrite(ex.data, resolved.data, localData);
        const json = JSON.stringify(resolved.data);
        await _writeVerified(handle, json);
        // The local copy is refreshed only after a verified write.
        await _saveSnapshot(json, true);
        return { bytes: json.length, restored: resolved.restored, date: resolved.data.meta && resolved.data.meta.date };
      });
      try { await setValue(LAST_PUSH_KEY, out.date); } catch (_) {}
      return out;
    } catch (err) {
      attempt++;
      // The file changed on disk between reading and writing (OneDrive): read again and retry.
      if (err && err.name === 'InvalidStateError' && attempt < 3) {
        try { await handle.getFile(); } catch (_) {}
        await new Promise(r => setTimeout(r, 250));
        continue;
      }
      throw err;
    }
  }
}

/**
 * Saves ALL the data to the linked file (merged with what it holds). Needs a user gesture when the
 * permission has expired. opts: { allowOverwriteEmpty }. -> { bytes, restored }.
 */
export async function saveToSyncFile(opts) {
  const handle = await _loadHandle();
  if (!handle) throw _err('NO_LINKED_FILE', 'No hay ning\u00fan archivo de sincronizaci\u00f3n vinculado.');
  if (!(await _ensurePermission(handle, 'readwrite'))) throw _err('PERMISSION_DENIED', 'El navegador no ha dado permiso para escribir el archivo.');
  setSyncState({ linked: true, fileName: handle.name, state: 'saving', message: 'Guardando...' });
  try {
    const out = await _pushTo(handle, opts);
    _setDecided(true);
    setSyncState({ state: 'ok', message: 'Guardado en ' + handle.name + '.' });
    return { bytes: out.bytes, restored: out.restored };
  } catch (e) {
    setSyncState({ state: 'error', message: (e && e.message) || String(e) });
    throw e;
  }
}

/**
 * The autosave's save: writes ONLY when write permission is already granted (no prompt). Throws
 * err.code 'PERMISSION_NEEDS_GESTURE' when a click is needed, 'NO_LINKED_FILE', or the read codes.
 */
export async function saveToSyncFileSilent() {
  const handle = await _loadHandle();
  if (!handle) throw _err('NO_LINKED_FILE', 'NO_LINKED_FILE');
  if (!(await _hasPermissionSilent(handle, 'readwrite'))) throw _err('PERMISSION_NEEDS_GESTURE', 'PERMISSION_NEEDS_GESTURE');
  const out = await _pushTo(handle, {});
  return { bytes: out.bytes, restored: out.restored };
}

// ------------------------------------------------------------------ bringing data + undo

// What a pull may change, and so what its photo keeps. This computer's own usage record is left out:
// only this computer writes it, and an undo must not erase the AI calls made since the pull.
function _pullScope(k, myUsageKey) {
  if (k === myUsageKey) return false;
  return isSyncedKey(k) || k.indexOf(API_KEY_PREFIX) === 0 || k === SECRETS_PREF_KEY || k === SECRETS_PASS_KEY || k === SECRETS_FP_KEY;
}

async function _myUsageKey() {
  try { return 'usage:' + (await getDevice()).id; } catch (_) { return ''; }
}

async function _savePrePull(info) {
  const all = await storage.get(null);
  const mine = await _myUsageKey();
  const local = {};
  for (const k of Object.keys(all)) if (_pullScope(k, mine)) local[k] = all[k];
  await idbPut(HANDLE_STORE, PRE_PULL_KEY, { at: Date.now(), local });
  await setValue(LAST_PULL_KEY, { at: Date.now(), fromDevice: (info && info.fromDevice) || null, fromDate: (info && info.fromDate) || null, confirmed: false });
}

/** The last "bring data" that can still be undone: { at, fromDevice, fromDate, confirmed } or null. */
export async function getLastPull() {
  const r = await getValue(LAST_PULL_KEY, null);
  return (r && r.at) ? r : null;
}

/** "It is the right copy": the autosave stops waiting. */
export async function confirmLastPull() {
  const r = await getLastPull();
  if (r) await setValue(LAST_PULL_KEY, Object.assign({}, r, { confirmed: true }));
}

/**
 * Puts this computer back exactly as it was before the last "bring data". The file is not touched;
 * the autosave waits again until the user decides.
 */
export async function undoLastPull() {
  let rec = null;
  try { rec = await idbGet(HANDLE_STORE, PRE_PULL_KEY); } catch (_) { rec = null; }
  if (!rec || !rec.local) throw _err('NO_PULL', 'No hay nada que deshacer.');
  const now = await storage.get(null);
  const mine = await _myUsageKey();
  const drop = Object.keys(now).filter(k => _pullScope(k, mine) && !(k in rec.local));
  if (drop.length) await storage.remove(drop);
  await storage.set(rec.local);
  await storage.remove([LAST_PULL_KEY, '_sync_pending']);
  try { await idbDel(HANDLE_STORE, PRE_PULL_KEY); } catch (_) {}
  _setDecided(false);
  setSyncState({ state: 'needs_gesture', message: 'Se ha deshecho lo tra\u00eddo. Elige si traes o guardas cuando quieras.' });
  try { window.dispatchEvent(new CustomEvent('umbra:sync-pulled', { detail: { undo: true } })); } catch (_) {}
  return { at: rec.at };
}

async function _bring(data, opts) {
  assertUmbraSync(data);
  const sig = _signatureOf(data);
  await _savePrePull({ fromDevice: sig.device, fromDate: (data.meta && data.meta.date) || null });
  const res = await applyImportData(data, opts);
  try { await setValue(LAST_PUSH_KEY, (data.meta && data.meta.date) || new Date().toISOString()); } catch (_) {}
  _setDecided(true);
  try { window.dispatchEvent(new CustomEvent('umbra:sync-pulled', { detail: res })); } catch (_) {}
  return res;
}

/**
 * Brings ALL the data of the linked file into this computer (merge). A photo of this computer's data
 * is taken first (undoLastPull). opts: { password, interactive }. -> { keys, secrets }.
 */
export async function loadFromSyncFile(opts) {
  const handle = await _loadHandle();
  if (!handle) throw _err('NO_LINKED_FILE', 'No hay ning\u00fan archivo de sincronizaci\u00f3n vinculado.');
  if (!(await _ensurePermission(handle, 'read'))) throw _err('PERMISSION_DENIED', 'El navegador no ha dado permiso para leer el archivo.');
  let text;
  try { text = await (await handle.getFile()).text(); } catch (_) { throw _readFailure('gone'); }
  text = _parseText(text);
  if (!text) {
    throw _err('SYNC_FILE_EMPTY', 'El archivo de sincronizaci\u00f3n est\u00e1 vac\u00edo o a\u00fan no se ha descargado del todo. Espera a que OneDrive ' +
      'termine de sincronizarlo (debe verse como "disponible sin conexi\u00f3n") y vuelve a intentarlo.');
  }
  let data;
  try { data = JSON.parse(text); } catch (_) { throw _readFailure('corrupt'); }
  const res = await _bring(data, opts);
  setSyncState({ linked: true, fileName: handle.name, state: 'ok', message: 'Datos tra\u00eddos de ' + handle.name + '.' });
  return res;
}

// ------------------------------------------------------------------ manual file (no FS Access API)

/** Downloads this computer's data as umbra-sync.json (browsers without the File System Access API). */
export async function downloadSyncFile() {
  const data = await buildFullExportData();
  const blob = new Blob(['\ufeff' + JSON.stringify(data)], { type: 'application/json' });
  download(blob, DEFAULT_FILE_NAME);
  return { bytes: blob.size };
}

/** Brings the data of a File (from a file input) into this computer: the same merge and undo as a linked file. */
export async function loadFromFileObject(file, opts) {
  if (!file) throw _err('NO_FILE', 'No se ha elegido ning\u00fan archivo.');
  const text = _parseText(await file.text());
  if (!text) throw _err('SYNC_FILE_EMPTY', 'El archivo est\u00e1 vac\u00edo.');
  let data;
  try { data = JSON.parse(text); } catch (_) { throw _readFailure('corrupt'); }
  return _bring(data, opts);
}

/** What the local copy of the file's last good content holds: { at, fileDate, keys } or null. */
export async function getSnapshotInfo() {
  const snap = await _loadSnapshot();
  if (!snap || !snap.data) return null;
  return { at: snap.at || null, fileDate: (snap.data.meta && snap.data.meta.date) || null, keys: Object.keys(snap.data.data || {}).length };
}

// ------------------------------------------------------------------ the question at opening

/**
 * At start (main.js): when a file is linked and its content is newer than this computer's last
 * save, or comes from another computer, asks what to do (Traer lo del archivo / Guardar lo de este
 * equipo / Decidir luego). When the file is this computer's own last save, nothing is asked and the
 * autosave may write. Resolves to 'none' | 'unsupported' | 'quiet' | 'pull' | 'push' | 'later' |
 * 'error' | 'already'.
 */
export async function startupSyncCheck() {
  if (!isSupported()) { setSyncState({ linked: false, fileName: null, state: 'off' }); return 'unsupported'; }
  const name = await getLinkedFileName();
  if (!name) { setSyncState({ linked: false, fileName: null, state: 'off', message: '' }); return 'none'; }
  setSyncState({ linked: true, fileName: name });
  if (isSessionDecided()) {
    if (_state.state === 'off' || _state.state === 'needs_gesture') setSyncState({ state: 'ok', message: '' });
    return 'already';
  }
  setSyncState({ state: 'needs_gesture', message: 'Pendiente: elige si traes los datos del archivo o guardas los de este equipo.' });
  const meta = await peekSyncFileMeta();
  const verdict = await _quietVerdict(meta);
  if (verdict === 'quiet') return 'quiet';
  if (meta && meta.wrongKind) {
    setSyncState({ state: 'error', message: meta.message });
    return 'error';
  }
  return showSyncDecisionModal(meta);
}

async function _quietVerdict(meta) {
  if (!meta || !meta.date || !meta.device) return 'ask';
  let me = { id: '' };
  try { me = await getDevice(); } catch (_) {}
  const lastPush = await getValue(LAST_PUSH_KEY, null);
  const fileT = Date.parse(meta.date), pushT = lastPush ? Date.parse(lastPush) : NaN;
  if (meta.device.id === me.id && !isNaN(pushT) && fileT <= pushT + 5000) {
    _setDecided(true);
    setSyncState({ state: 'ok', message: '' });
    return 'quiet';
  }
  return 'ask';
}

/** The decision dialog itself (also for Settings). Resolves to the action taken. */
export function showSyncDecisionModal(initialMeta) {
  return new Promise((resolve) => {
    if (document.getElementById('umbra-sync-decision')) { resolve('already'); return; }
    let me = { id: '', name: '' };
    let lastPushIso = null;
    const back = el('div.modal-back#umbra-sync-decision');
    const box = el('div.modal', { style: { width: '430px' } });
    back.appendChild(box);
    document.body.appendChild(back);
    const finish = (action) => { back.remove(); resolve(action); };

    const sentence = (w) => { const s = String(w || '').toLowerCase(); return s.charAt(0).toUpperCase() + s.slice(1); };
    const shortWhen = (iso) => {
      try {
        const d = new Date(iso);
        return d.toLocaleString('es-ES', { weekday: 'short', day: 'numeric', month: 'short',
          year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric', hour: '2-digit', minute: '2-digit' });
      } catch (_) { return ''; }
    };

    async function act(action, btn) {
      const label = btn.textContent;
      btn.disabled = true; btn.textContent = 'Un momento...';
      try {
        if (action === 'pull') {
          await loadFromSyncFile();
          toast('Datos tra\u00eddos del archivo. Si no era la copia buena, usa "Deshacer lo tra\u00eddo" en Ajustes > Sincronizaci\u00f3n.', 'ok', 7000);
        } else if (action === 'push-force') {
          if (!window.confirm('El archivo se lee vac\u00edo pero antes ten\u00eda datos. Si OneDrive a\u00fan no lo ha descargado, sobrescribirlo ' +
            'PIERDE los datos del otro equipo.\n\n\u00bfSobrescribir de todos modos?')) { btn.disabled = false; btn.textContent = label; return; }
          await saveToSyncFile({ allowOverwriteEmpty: true });
          toast('Datos de este equipo guardados en el archivo.', 'ok');
        } else {
          await saveToSyncFile();
          toast('Datos de este equipo guardados en el archivo.', 'ok');
        }
        finish(action === 'push-force' ? 'push' : action);
      } catch (e) {
        btn.disabled = false; btn.textContent = label;
        toast((e && e.message) || String(e), 'err', 9000);
      }
    }

    function render(m) {
      box.textContent = '';
      box.appendChild(el('div.modal-head', el('span', 'Tus datos de UMBRA'),
        el('button.icon-btn.modal-x', { title: 'Decidir luego', onclick: () => later() }, '\u00d7')));
      const body = el('div.modal-body');
      box.appendChild(body);
      body.appendChild(el('p.info', 'UMBRA guarda tus ajustes en este navegador y en un archivo de sincronizaci\u00f3n que OneDrive ' +
        'lleva a tus otros equipos. Elige qu\u00e9 datos usar ahora. Las dos opciones combinan los datos: ninguna borra nada del otro lado.'));

      if (!(m && m.needsPermission) && me.id && !me.name) {
        const inp = el('input.inp', { type: 'text', maxlength: '40', placeholder: 'Por ejemplo: Oficina, Casa', style: { flex: '1' } });
        const save = async () => {
          if (!inp.value.trim()) { inp.focus(); return; }
          try { me = await setDeviceName(inp.value); } catch (_) {}
          render(m);
        };
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
        body.appendChild(el('div.note', el('div.row', el('span', 'Nombre de este equipo:'), inp, el('button.btn.sm', { onclick: save }, 'Guardar'))));
      }

      let primary = 'pull';
      let hint = '';
      let verdict = '';
      if (m && m.needsPermission) {
        verdict = 'El navegador necesita un clic para leer el archivo de sincronizaci\u00f3n.';
      } else if (m && m.error) {
        verdict = 'No se ha podido leer el archivo de sincronizaci\u00f3n (' + m.error + '). Comprueba que OneDrive lo ha descargado.';
      } else if (m && m.notDownloaded) {
        verdict = 'El archivo ocupa espacio pero no devuelve texto: OneDrive a\u00fan no lo ha descargado en este equipo. Espera y vuelve a abrir UMBRA.';
        primary = 'wait';
      } else if (m && m.empty && m.hadContentBefore) {
        verdict = 'El archivo se lee VAC\u00cdO pero antes ten\u00eda datos. Lo m\u00e1s probable es que OneDrive a\u00fan no lo haya descargado: espera.';
        primary = 'wait';
      } else if (m && m.empty) {
        verdict = 'El archivo est\u00e1 vac\u00edo: todav\u00eda no hay datos guardados fuera de este equipo.';
        primary = 'push';
      } else if (m && m.date) {
        const r = relativeDay(m.date);
        const mine = m.device && m.device.id === me.id;
        const who = m.device ? (m.device.name || (mine ? 'Este equipo' : 'Otro equipo')) + (m.device.name ? (mine ? ' (este equipo)' : ' (otro equipo)') : '') : 'Sin firma';
        const tiles = el('div.form-grid',
          el('div.note', el('div.lbl', 'Guardado por'), el('b', who)),
          el('div.note.warn', el('div.lbl', 'Cu\u00e1ndo'), el('b', r ? sentence(r.word) : '?'), el('div', shortWhen(m.date))));
        body.appendChild(el('div.lbl', '\u00daltima copia del archivo'));
        body.appendChild(tiles);
        const fileT = Date.parse(m.date), pushT = lastPushIso ? Date.parse(lastPushIso) : NaN;
        if (mine) {
          hint = '\u00bfHas trabajado en otro equipo desde entonces? Espera a que OneDrive traiga su copia y vuelve a abrir UMBRA.';
          primary = 'push';
        } else if (!isNaN(pushT) && fileT < pushT - 5000) {
          hint = 'Este equipo guard\u00f3 despu\u00e9s. Puede que OneDrive a\u00fan no haya tra\u00eddo la copia m\u00e1s reciente.';
          primary = 'push';
        } else {
          hint = 'Es m\u00e1s reciente que los datos de este navegador.';
          primary = 'pull';
        }
      } else {
        verdict = 'No se ha podido comparar. Elige qu\u00e9 datos usar.';
      }
      if (verdict) body.appendChild(el('p', verdict));
      if (hint) body.appendChild(el('p.info', hint));
      if (lastPushIso && !(m && m.needsPermission)) {
        const lr = relativeDay(lastPushIso);
        if (lr) body.appendChild(el('p.info', 'Este equipo guard\u00f3 o trajo datos por \u00faltima vez: ', el('b', sentence(lr.word)), ' (' + lr.when + ').'));
      }

      const actions = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '10px' } });
      body.appendChild(actions);
      const mk = (action, label, kind) => {
        const b = el('button.btn' + (kind ? '.' + kind : ''), { style: { width: '100%' } }, label);
        b.addEventListener('click', () => act(action, b));
        return b;
      };
      const myName = me.name ? ' (' + me.name + ')' : '';
      if (m && m.needsPermission) {
        const go = el('button.btn.primary', { style: { width: '100%' } }, 'Continuar');
        go.addEventListener('click', async () => {
          go.disabled = true; go.textContent = 'Un momento...';
          let m2 = null;
          try { m2 = await peekSyncFileMetaWithPermission(); } catch (_) {}
          if (m2 && m2.wrongKind) { setSyncState({ state: 'error', message: m2.message }); toast(m2.message, 'err', 9000); finish('error'); return; }
          if ((await _quietVerdict(m2)) === 'quiet') { finish('quiet'); return; }
          render(m2 || { error: 'sin respuesta' });
        });
        actions.appendChild(go);
      } else if (m && m.empty && m.hadContentBefore) {
        actions.appendChild(mk('push-force', 'Sobrescribir con lo de este equipo' + myName, 'danger'));
      } else if (m && m.empty) {
        actions.appendChild(mk('push', 'Guardar lo de este equipo' + myName, 'primary'));
      } else if (primary === 'wait') {
        // Nothing to do but wait: only "Decidir luego".
      } else {
        const pull = mk('pull', 'Traer lo del archivo', primary === 'pull' ? 'primary' : '');
        const push = mk('push', 'Guardar lo de este equipo' + myName, primary === 'push' ? 'primary' : '');
        if (primary === 'pull') { actions.appendChild(pull); actions.appendChild(push); }
        else { actions.appendChild(push); actions.appendChild(pull); }
      }
      actions.appendChild(el('button.btn.link', { onclick: () => later(), title: 'No toca ni el archivo ni este navegador. El autoguardado espera.' }, 'Decidir luego'));

      // Footer: the autosave switch (the same preference as Settings > Sincronizaci\u00f3n).
      const chk = el('input', { type: 'checkbox' });
      getValue(AUTOSAVE_PREF_KEY, true).then(v => { chk.checked = v !== false; });
      chk.addEventListener('change', () => { setValue(AUTOSAVE_PREF_KEY, chk.checked); });
      box.appendChild(el('div.modal-foot', { style: { justifyContent: 'space-between' } },
        el('label.row', { title: 'Guardar en el archivo autom\u00e1ticamente mientras trabajas.' }, chk, 'Autoguardar'),
        el('span.muted', { style: { fontSize: '11px' } }, _state.fileName || '')));
    }

    function later() {
      setSyncState({ state: 'needs_gesture', message: 'Pendiente: el autoguardado espera hasta que traigas o guardes.' });
      finish('later');
    }

    (async () => {
      try { me = await getDevice(); } catch (_) {}
      try { lastPushIso = await getValue(LAST_PUSH_KEY, null); } catch (_) {}
      render(initialMeta || null);
    })();
  });
}
