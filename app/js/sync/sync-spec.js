/**
 * sync-spec.js - WHAT travels in the sync file and HOW each piece is merged (ARQUITECTURA \u00a76).
 *
 * Origin: COMeT services/sync-fs.js @ 04540f5 (adapted)  (_mergeArrayByKey, tombstones with TTL,
 *         the 'newest' rule of ai_extra_models / ai_feature_models, devices signature)
 *
 * The file holds a flat map { <storage key>: value } under `data`; this module says which storage
 * keys go there and gives the PURE merge functions (no storage, no I/O) that sync-fs.js uses both
 * when it writes (this computer + what the file holds) and when it brings data (the file into this
 * computer).
 *
 *   providers, module_models, module_cfg, lists, prefs, prompts   'newest' (updatedAt)
 *   rules        { updatedAt, overrides:{id:rule}, user:[rule], tombstones:{id:ts} }   'rules'
 *   entity_dict  { updatedAt, items:[{id, updatedAt, ...}], tombstones:{id:ts} }      'byId'
 *   usage:<dev>  per computer, the copy written last                                 'usage'
 *   ai_prices    per model, the price set last                                       'prices'
 *   usage_notes  per note, the one written last                                      'notes'
 *   secrets      { updatedAt, box } (AES-GCM, only with "Incluir claves de API cifradas") 'newest'
 */

import { mergeUsageRecord, mergePrices, mergeUsageNotes } from '../ai/usage.js';

export const SYNC_KIND = 'umbra-sync';
export const SYNC_VERSION = 1;
export const DEFAULT_FILE_NAME = 'umbra-sync.json';

export const SECRETS_KEY = 'secrets';
// Local-only settings of the sync itself (never in the file).
export const AUTOSAVE_PREF_KEY = 'sync_autosave_enabled';
export const SECRETS_PREF_KEY = 'sync_secrets_enabled';
export const SECRETS_PASS_KEY = 'sync_secrets_pass';
// The API keys (registry.js KEY_PREFIX). They travel only inside the encrypted `secrets` box.
export const API_KEY_PREFIX = 'key:';

export const TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

export const SYNC_SPEC = [
  { key: 'providers', merge: 'newest' },
  { key: 'module_models', merge: 'newest' },
  { key: 'module_cfg', merge: 'newest' },
  { key: 'lists', merge: 'newest' },
  { key: 'prefs', merge: 'newest' },
  { key: 'prompts', merge: 'newest' },
  { key: 'rules', merge: 'rules' },
  { key: 'entity_dict', merge: 'byId' },
  { prefix: 'usage:', merge: 'usage' },
  { key: 'ai_prices', merge: 'prices' },
  { key: 'usage_notes', merge: 'notes' },
  { key: SECRETS_KEY, merge: 'newest', optIn: SECRETS_PREF_KEY }
];

/** What travels and what does not, in plain words (PROPUESTA \u00a79.2), for Settings. */
export const TRAVELS = [
  'Perfiles de proveedor y modelos configurados',
  'Modelo por m\u00f3dulo y ajustes de cada m\u00f3dulo',
  'Instrucciones de cada m\u00f3dulo (prompts) modificadas',
  'Diccionario personal de entidades y listas editadas',
  'Registro del gasto, precios y notas',
  'Preferencias (modo oscuro, zoom, color...)',
  'Las claves de API, solo si activas "Incluir claves de API cifradas" (cifradas con tu contrase\u00f1a)'
];
export const DOES_NOT_TRAVEL = [
  'Los documentos y los proyectos (confidenciales y pesados)',
  'El mapa de claves del enmascaramiento',
  'Las claves de API en claro (nunca)',
  'El nombre de este equipo y el propio estado de la sincronizaci\u00f3n'
];

/** The spec entry of a storage key, or null when the key does not travel. */
export function specFor(key) {
  const k = String(key || '');
  for (const s of SYNC_SPEC) {
    if (s.key && s.key === k) return s;
    if (s.prefix && k.indexOf(s.prefix) === 0 && k.length > s.prefix.length) return s;
  }
  return null;
}

export function isSyncedKey(key) { return !!specFor(key); }

// ------------------------------------------------------------------ merge helpers (pure)

function _time(v) {
  if (v === null || v === undefined || v === '') return -1;
  if (typeof v === 'number') return isFinite(v) ? v : -1;
  const t = Date.parse(v);
  return isNaN(t) ? -1 : t;
}

/** The time a record was last changed (updatedAt, else other usual fields), -1 when unknown. */
export function recordTime(r) {
  if (!r || typeof r !== 'object') return -1;
  const v = r.updatedAt ?? r.updated ?? r.at ?? r.savedAt ?? r.createdAt;
  return _time(v);
}

export function pruneTombstones(map, now) {
  const out = {};
  const cut = (now || Date.now()) - TOMBSTONE_TTL_MS;
  for (const k of Object.keys(map || {})) {
    const t = _time(map[k]);
    if (t > cut) out[k] = map[k];
  }
  return out;
}

export function mergeTombstones(a, b) {
  const out = Object.assign({}, a || {});
  for (const k of Object.keys(b || {})) {
    if (out[k] === undefined || _time(b[k]) > _time(out[k])) out[k] = b[k];
  }
  return out;
}

/** The value changed last (updatedAt). On a tie (or no dates) the preferred side: 'a' or 'b'. */
export function mergeNewest(a, b, prefer) {
  if (a === undefined || a === null) return b;
  if (b === undefined || b === null) return a;
  const ta = recordTime(a), tb = recordTime(b);
  if (ta !== tb) return ta > tb ? a : b;
  return prefer === 'a' ? a : b;
}

function _pickRecord(x, y, prefer) {
  if (!x) return y;
  if (!y) return x;
  const tx = recordTime(x), ty = recordTime(y);
  if (tx !== ty) return tx > ty ? x : y;
  return prefer === 'a' ? x : y;
}

function _deleted(tomb, id, rec) {
  const ts = tomb[id];
  return ts !== undefined && _time(ts) > recordTime(rec);
}

/**
 * Two copies of the rules: overrides of built-in rules and the user's own rules, united by id (the
 * newer updatedAt wins per rule); tombstones remove what is older than them (a restored built-in
 * rule = its override deleted with a tombstone).
 */
export function mergeRules(a, b, prefer) {
  const ao = (a && typeof a === 'object') ? a : null;
  const bo = (b && typeof b === 'object') ? b : null;
  if (!ao) return bo;
  if (!bo) return ao;
  const tomb = pruneTombstones(mergeTombstones(ao.tombstones, bo.tombstones));
  const overrides = {};
  const ids = new Set([...Object.keys(ao.overrides || {}), ...Object.keys(bo.overrides || {})]);
  for (const id of ids) {
    const r = _pickRecord((ao.overrides || {})[id], (bo.overrides || {})[id], prefer);
    if (r && !_deleted(tomb, id, r)) overrides[id] = r;
  }
  const byId = new Map();
  const order = [];
  for (const side of [ao.user, bo.user]) {
    for (const r of (Array.isArray(side) ? side : [])) {
      if (!r || r.id === undefined || r.id === null) continue;
      const id = String(r.id);
      if (!byId.has(id)) { order.push(id); byId.set(id, r); continue; }
      const fromA = side === ao.user;
      byId.set(id, fromA ? _pickRecord(r, byId.get(id), prefer) : _pickRecord(byId.get(id), r, prefer));
    }
  }
  const user = order.map(id => byId.get(id)).filter(r => !_deleted(tomb, String(r.id), r));
  const out = Object.assign({}, prefer === 'a' ? Object.assign({}, bo, ao) : Object.assign({}, ao, bo));
  out.updatedAt = Math.max(_time(ao.updatedAt), _time(bo.updatedAt), 0);
  out.overrides = overrides;
  out.user = user;
  out.tombstones = tomb;
  return out;
}

/** Two copies of a list of records with ids: union by id, the newer updatedAt wins, tombstones remove. */
export function mergeById(a, b, prefer) {
  const ao = (a && typeof a === 'object') ? a : null;
  const bo = (b && typeof b === 'object') ? b : null;
  if (!ao) return bo;
  if (!bo) return ao;
  const tomb = pruneTombstones(mergeTombstones(ao.tombstones, bo.tombstones));
  const byId = new Map();
  const order = [];
  const add = (r, fromA) => {
    if (!r || r.id === undefined || r.id === null) return;
    const id = String(r.id);
    if (!byId.has(id)) { order.push(id); byId.set(id, r); return; }
    byId.set(id, fromA ? _pickRecord(r, byId.get(id), prefer) : _pickRecord(byId.get(id), r, prefer));
  };
  (Array.isArray(ao.items) ? ao.items : []).forEach(r => add(r, true));
  (Array.isArray(bo.items) ? bo.items : []).forEach(r => add(r, false));
  const items = order.map(id => byId.get(id)).filter(r => !_deleted(tomb, String(r.id), r));
  const out = Object.assign({}, prefer === 'a' ? Object.assign({}, bo, ao) : Object.assign({}, ao, bo));
  out.updatedAt = Math.max(_time(ao.updatedAt), _time(bo.updatedAt), 0);
  out.items = items;
  out.tombstones = tomb;
  return out;
}

/**
 * The merged value of one storage key. `a` and `b` are the two copies; on a tie `prefer` ('a' | 'b')
 * says which side wins. undefined when neither side has it.
 */
export function mergeValue(key, a, b, prefer) {
  const s = specFor(key);
  const p = prefer === 'a' ? 'a' : 'b';
  if (a === undefined) return b;
  if (b === undefined) return a;
  if (!s) return p === 'a' ? a : b;
  switch (s.merge) {
    case 'rules': return mergeRules(a, b, p);
    case 'byId': return mergeById(a, b, p);
    // COMeT's merges prefer their SECOND argument on a tie: the preferred side goes second.
    case 'usage': return p === 'a' ? mergeUsageRecord(b, a) : mergeUsageRecord(a, b);
    case 'prices': return p === 'a' ? mergePrices(b, a) : mergePrices(a, b);
    case 'notes': return p === 'a' ? mergeUsageNotes(b, a) : mergeUsageNotes(a, b);
    case 'newest':
    default: return mergeNewest(a, b, p);
  }
}

/** { id: { name, at } } of two copies: per computer, its latest save (and its name then). */
export function mergeDevices(a, b) {
  const out = {};
  for (const src of [a, b]) {
    if (!src || typeof src !== 'object') continue;
    for (const id of Object.keys(src)) {
      const v = src[id];
      if (!v || !v.at) continue;
      const cur = out[id];
      if (!cur || String(v.at) > String(cur.at)) out[id] = { name: String(v.name || ''), at: String(v.at) };
    }
  }
  return out;
}

/**
 * Merge this computer's export with what the file holds, before writing it. Every key is merged by
 * its rule (this computer wins ties: it is the one writing now); keys this version does not know
 * (written by a newer UMBRA) are kept as they are. The signature is this computer's; the list of
 * computers is combined.
 */
export function mergeSyncData(file, local) {
  if (!file || typeof file !== 'object' || !file.data || typeof file.data !== 'object') return local;
  const ld = (local && local.data) || {};
  const fd = file.data;
  const data = {};
  const keys = new Set([...Object.keys(fd), ...Object.keys(ld)]);
  for (const k of keys) {
    const v = mergeValue(k, ld[k], fd[k], 'a');
    if (v !== undefined) data[k] = v;
  }
  const meta = Object.assign({}, (local && local.meta) || {}, {
    devices: mergeDevices(file.meta && file.meta.devices, local && local.meta && local.meta.devices)
  });
  return { meta, data };
}

/**
 * Throws a Spanish error (code 'SYNC_WRONG_KIND') unless `data` is an UMBRA sync file. A COMeT file
 * ('comet-sync') gets its own message: UMBRA never reads nor writes it.
 */
export function assertUmbraSync(data) {
  const kind = data && data.meta && data.meta.kind;
  if (kind === SYNC_KIND) return true;
  let msg;
  if (kind === 'comet-sync') {
    msg = 'Este es el archivo de sincronizaci\u00f3n de COMeT, no el de UMBRA. UMBRA no lo lee ni escribe en \u00e9l, ' +
      'para no mezclar los datos. Elige o crea otro archivo (por ejemplo, ' + DEFAULT_FILE_NAME + ').';
  } else {
    msg = 'Este archivo no es un archivo de sincronizaci\u00f3n de UMBRA' + (kind ? ' (es de tipo "' + String(kind) + '")' : '') +
      '. UMBRA no lo lee ni escribe en \u00e9l. Elige o crea otro archivo (por ejemplo, ' + DEFAULT_FILE_NAME + ').';
  }
  const e = new Error(msg);
  e.code = 'SYNC_WRONG_KIND';
  e.kind = kind || null;
  throw e;
}

export function isUmbraSync(data) {
  return !!(data && data.meta && data.meta.kind === SYNC_KIND);
}
