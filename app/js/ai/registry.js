/**
 * registry.js - Provider profiles, API keys and the model each review module uses.
 *
 * Origin: COMeT services/ai-service.js @ 04540f5 (adapted)
 * Origin: COMeT services/credentials-manager.js @ 04540f5 (adapted)
 * Origin: COMeT settings/tabs/ai-tab.js @ 04540f5 (adapted)  (model lists, "add a model")
 *
 * Storage (app/js/store/storage.js):
 *   providers     = { updatedAt, list: [profile] }   (travels in the sync file, merge 'newest')
 *   module_models = { updatedAt, general: {provider, model}|null,
 *                     map: { <moduleId>: { triage: {provider, model}|null, deep: {...}|null } } }
 *   key:<providerId> = the API key (NEVER inside a profile; travels only encrypted, see sync-fs.js)
 *
 * profile = { id, name, adapter, baseUrl, deployment, apiVersion, relayUrl,
 *             models: [{ id, label, price?: { in, cached, out } }],   (US$ per million tokens)
 *             trust: 'external'|'local', builtIn, hidden? }
 *
 * The built-in profiles are seeded with updatedAt 0, so a real configuration brought by the sync
 * file always beats a fresh seed. COMeT's featureFallbacks become resolveClient's chain: the
 * module's role -> its other role -> the general choice -> the first provider with a key.
 */

import { storage, getValue, setValue } from '../store/storage.js';
import { createClient } from './providers.js';

export const PROVIDERS_KEY = 'providers';
export const MODULE_MODELS_KEY = 'module_models';
export const KEY_PREFIX = 'key:';

// What a model's API name may hold: letters, digits and . _ - : / @
export const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:\/@-]{0,119}$/;

// Gemini and Mistral lists from COMeT settings/settings.html (plus Gemini 2.5 Pro).
export const DEFAULT_PROVIDERS = [
  {
    id: 'gemini', name: 'Google Gemini', adapter: 'gemini', baseUrl: '', deployment: '', apiVersion: '', relayUrl: '',
    trust: 'external', builtIn: true,
    models: [
      { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite' },
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
      { id: 'gemini-3-flash-preview', label: 'Gemini 3.0 Flash' },
      { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash Lite' },
      { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash' }
    ]
  },
  {
    id: 'mistral', name: 'Mistral', adapter: 'mistral', baseUrl: '', deployment: '', apiVersion: '', relayUrl: '',
    trust: 'external', builtIn: true,
    models: [
      { id: 'mistral-large-latest', label: 'Mistral Large' },
      { id: 'mistral-medium-latest', label: 'Mistral Medium' },
      { id: 'mistral-small-latest', label: 'Mistral Small' }
    ]
  },
  {
    id: 'azure', name: 'Azure OpenAI', adapter: 'azure-openai', baseUrl: '', deployment: '', apiVersion: '2024-06-01', relayUrl: '',
    trust: 'external', builtIn: true, models: []
  },
  {
    id: 'anthropic', name: 'Anthropic (Claude)', adapter: 'anthropic', baseUrl: '', deployment: '', apiVersion: '', relayUrl: '',
    trust: 'external', builtIn: true,
    models: [
      { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
      { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' }
    ]
  }
];

function _clone(x) { return x === undefined ? undefined : JSON.parse(JSON.stringify(x)); }

function _err(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function _num(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return (isFinite(n) && n >= 0) ? n : null;
}

function _normPrice(price) {
  if (!price || typeof price !== 'object') return undefined;
  const p = { in: _num(price.in), cached: _num(price.cached), out: _num(price.out) };
  return (p.in === null && p.out === null && p.cached === null) ? undefined : p;
}

function _normModel(m) {
  if (!m) return null;
  const id = String(m.id || '').trim();
  if (!id) return null;
  const out = { id, label: String(m.label || '').trim() || id };
  const price = _normPrice(m.price);
  if (price) out.price = price;
  return out;
}

function _normProfile(p) {
  const out = {
    id: String(p.id || '').trim(),
    name: String(p.name || '').trim() || 'Proveedor',
    adapter: String(p.adapter || 'openai-compatible'),
    baseUrl: String(p.baseUrl || '').trim(),
    deployment: String(p.deployment || '').trim(),
    apiVersion: String(p.apiVersion || '').trim(),
    relayUrl: String(p.relayUrl || '').trim(),
    models: [],
    trust: p.trust === 'local' ? 'local' : 'external',
    builtIn: !!p.builtIn
  };
  if (p.hidden) out.hidden = true;
  if (p.batch === true) out.batch = true;   // openai-compatible: supports the OpenAI Batch API
  const seen = new Set();
  for (const m of (Array.isArray(p.models) ? p.models : [])) {
    const nm = _normModel(m);
    if (nm && !seen.has(nm.id)) { seen.add(nm.id); out.models.push(nm); }
  }
  return out;
}

// ------------------------------------------------------------------ profiles

async function _loadStore() {
  let st = await getValue(PROVIDERS_KEY, null);
  let changed = false;
  if (!st || typeof st !== 'object' || !Array.isArray(st.list)) {
    st = { updatedAt: 0, list: _clone(DEFAULT_PROVIDERS) };
    changed = true;
  }
  // A built-in added by a later version of UMBRA (one the user hid stays in the list, hidden).
  for (const d of DEFAULT_PROVIDERS) {
    if (!st.list.some(p => p && p.id === d.id)) { st.list.push(_clone(d)); changed = true; }
  }
  // updatedAt is NOT bumped: a seed must never beat a real configuration in the sync file.
  if (changed) await setValue(PROVIDERS_KEY, st);
  return st;
}

async function _saveStore(list) {
  await setValue(PROVIDERS_KEY, { updatedAt: Date.now(), list });
}

/** Seeds the built-in profiles on first run. Safe to call at every start. */
export async function ensureSeeded() {
  await _loadStore();
}

/** [profile] (copies). Hidden built-ins only with { includeHidden: true }. */
export async function listProviders(opts) {
  const st = await _loadStore();
  const all = st.list.filter(p => p && p.id).map(p => _normProfile(p));
  return (opts && opts.includeHidden) ? all : all.filter(p => !p.hidden);
}

export async function getProvider(id) {
  const all = await listProviders({ includeHidden: true });
  return all.find(p => p.id === id) || null;
}

/**
 * Adds or replaces a profile (by id; a new one gets an id 'p_...'). A built-in keeps its id, adapter
 * and builtIn flag. Returns the saved profile.
 */
export async function saveProvider(profile) {
  if (!profile || typeof profile !== 'object') throw _err('BAD_PROFILE', 'Perfil de proveedor no v\u00e1lido.');
  const st = await _loadStore();
  const list = st.list.slice();
  let p = _normProfile(profile);
  if (!p.id) p.id = 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const i = list.findIndex(x => x && x.id === p.id);
  if (i >= 0) {
    const old = _normProfile(list[i]);
    if (old.builtIn) { p.builtIn = true; p.adapter = old.adapter; }
    list[i] = p;
  } else {
    p.builtIn = false;
    list.push(p);
  }
  await _saveStore(list);
  return _clone(p);
}

/**
 * Removes a profile and its key. A built-in is HIDDEN instead (resetProvider brings it back).
 * Module choices that named it are left: resolveClient falls back and the settings say so.
 */
export async function removeProvider(id) {
  const st = await _loadStore();
  const i = st.list.findIndex(x => x && x.id === id);
  if (i < 0) return false;
  const list = st.list.slice();
  if (list[i].builtIn) {
    list[i] = Object.assign({}, list[i], { hidden: true });
  } else {
    list.splice(i, 1);
    await storage.remove(KEY_PREFIX + id);
  }
  await _saveStore(list);
  return true;
}

/** A built-in back to its defaults (models included) and visible. The key is kept. */
export async function resetProvider(id) {
  const d = DEFAULT_PROVIDERS.find(x => x.id === id);
  if (!d) return null;
  const st = await _loadStore();
  const list = st.list.map(x => (x && x.id === id) ? _clone(d) : x);
  await _saveStore(list);
  return _clone(d);
}

/** Shows a hidden built-in again, as it was. */
export async function unhideProvider(id) {
  const st = await _loadStore();
  const list = st.list.map((x) => {
    if (!x || x.id !== id) return x;
    const y = Object.assign({}, x);
    delete y.hidden;
    return y;
  });
  await _saveStore(list);
}

/** The models a profile offers. An Azure profile with an empty list offers its deployment. */
export function modelsOf(profile) {
  if (!profile) return [];
  const list = Array.isArray(profile.models) ? profile.models : [];
  if (!list.length && profile.adapter === 'azure-openai' && profile.deployment) {
    return [{ id: profile.deployment, label: profile.deployment }];
  }
  return list;
}

export function modelLabel(profile, modelId) {
  const m = modelsOf(profile).find(x => x.id === modelId);
  return m ? (m.label || m.id) : String(modelId || '');
}

export async function addModel(providerId, model) {
  const nm = _normModel(model);
  if (!nm || !MODEL_ID_RE.test(nm.id)) throw _err('BAD_MODEL', 'Nombre de API del modelo no v\u00e1lido: solo letras, cifras y . _ - : / @');
  const p = await getProvider(providerId);
  if (!p) throw _err('NO_PROFILE', 'Ese proveedor ya no existe.');
  const i = p.models.findIndex(m => m.id === nm.id);
  if (i >= 0) p.models[i] = Object.assign({}, p.models[i], nm);
  else p.models.push(nm);
  await saveProvider(p);
  return nm;
}

export async function removeModel(providerId, modelId) {
  const p = await getProvider(providerId);
  if (!p) return false;
  const before = p.models.length;
  p.models = p.models.filter(m => m.id !== modelId);
  if (p.models.length === before) return false;
  await saveProvider(p);
  return true;
}

/** price = { in, cached, out } in US$ per million tokens, or null to remove it. */
export async function setModelPrice(providerId, modelId, price) {
  const p = await getProvider(providerId);
  if (!p) return false;
  const m = p.models.find(x => x.id === modelId);
  if (!m) return false;
  const np = _normPrice(price);
  if (np) m.price = np; else delete m.price;
  await saveProvider(p);
  return true;
}

// ------------------------------------------------------------------ keys

export async function getApiKey(id) {
  const v = await getValue(KEY_PREFIX + id, '');
  return typeof v === 'string' ? v : '';
}

/** '' (or null) removes the key. */
export async function setApiKey(id, key) {
  const k = String(key || '').trim();
  if (!k) await storage.remove(KEY_PREFIX + id);
  else await setValue(KEY_PREFIX + id, k);
}

export async function hasApiKey(id) {
  return !!(await getApiKey(id));
}

/**
 * Can this profile be called (key + the addresses it needs)? A local OpenAI-compatible provider
 * (Ollama...) may have no key.
 */
export function isUsable(profile, key) {
  if (!profile || profile.hidden) return false;
  const hasKey = !!key;
  if (profile.adapter === 'openai-compatible') {
    if (!(profile.baseUrl || profile.relayUrl)) return false;
    return hasKey || profile.trust === 'local';
  }
  if (profile.adapter === 'azure-openai') {
    return hasKey && !!(profile.baseUrl || profile.relayUrl) && modelsOf(profile).length > 0;
  }
  return hasKey;
}

/** [{ profile, key, usable }] for every visible profile. */
export async function providersWithStatus() {
  const list = await listProviders();
  const out = [];
  for (const p of list) {
    const key = await getApiKey(p.id);
    out.push({ profile: p, key, usable: isUsable(p, key) });
  }
  return out;
}

// ------------------------------------------------------------------ model per module

function _choice(c) {
  if (!c || typeof c !== 'object' || !c.provider) return null;
  return { provider: String(c.provider), model: String(c.model || '') };
}

export async function getModuleModels() {
  const v = await getValue(MODULE_MODELS_KEY, null);
  const o = (v && typeof v === 'object') ? v : {};
  return {
    updatedAt: Number(o.updatedAt) || 0,
    general: _choice(o.general),
    map: (o.map && typeof o.map === 'object') ? _clone(o.map) : {}
  };
}

/** role: 'triage' | 'deep'; choice: { provider, model } or null ("General"). */
export async function setModuleModel(moduleId, role, choice) {
  const mm = await getModuleModels();
  const r = role === 'deep' ? 'deep' : 'triage';
  const slot = Object.assign({ triage: null, deep: null }, mm.map[moduleId] || {});
  slot[r] = _choice(choice);
  mm.map[moduleId] = slot;
  mm.updatedAt = Date.now();
  await setValue(MODULE_MODELS_KEY, mm);
  return mm;
}

export async function getGeneralModel() {
  return (await getModuleModels()).general;
}

export async function setGeneralModel(choice) {
  const mm = await getModuleModels();
  mm.general = _choice(choice);
  mm.updatedAt = Date.now();
  await setValue(MODULE_MODELS_KEY, mm);
  return mm;
}

async function _tryBuild(list, choice) {
  const p = list.find(x => x.id === choice.provider);
  if (!p) return null;
  const key = await getApiKey(p.id);
  if (!isUsable(p, key)) return null;
  const models = modelsOf(p);
  // A model taken off the list is not called any more: the provider's first model instead.
  let modelId = choice.model && models.some(m => m.id === choice.model) ? choice.model : (models[0] && models[0].id) || '';
  if (!modelId && p.adapter === 'openai-compatible') modelId = choice.model || '';
  if (!modelId) return null;
  return { client: createClient(p, modelId, key), providerId: p.id, modelId, trust: p.trust, profile: p };
}

/**
 * The client a module role uses: its own choice -> its other role -> the general choice -> the first
 * provider with a key. -> { client, providerId, modelId, trust, fallback, source, wanted, profile }.
 * fallback is true when a choice made for it could not be used (no key, provider gone): `wanted`
 * says which. Throws err.code 'NO_PROVIDER' when nothing can be called.
 */
export async function resolveClient(moduleId, role) {
  const r = role === 'deep' ? 'deep' : 'triage';
  const other = r === 'deep' ? 'triage' : 'deep';
  const [list, mm] = await Promise.all([listProviders(), getModuleModels()]);
  const slot = (moduleId && mm.map[moduleId]) || {};
  const cands = [];
  if (_choice(slot[r])) cands.push({ choice: _choice(slot[r]), source: 'module' });
  if (_choice(slot[other])) cands.push({ choice: _choice(slot[other]), source: 'module-other' });
  if (mm.general) cands.push({ choice: mm.general, source: 'general' });
  for (let i = 0; i < cands.length; i++) {
    const got = await _tryBuild(list, cands[i].choice);
    if (got) return Object.assign(got, { fallback: i > 0, source: cands[i].source, wanted: i > 0 ? cands[0].choice : null });
  }
  for (const p of list) {
    const got = await _tryBuild(list, { provider: p.id, model: '' });
    if (got) return Object.assign(got, { fallback: cands.length > 0, source: 'first', wanted: cands.length ? cands[0].choice : null });
  }
  throw _err('NO_PROVIDER', 'No hay ning\u00fan proveedor de IA con clave. A\u00f1ade una clave en Ajustes > Proveedores.');
}

/** fn(changes) whenever profiles, keys or module choices change (also from another tab). */
export function onRegistryChanged(fn) {
  return storage.onChanged((changes) => {
    const keys = Object.keys(changes || {});
    if (keys.some(k => k === PROVIDERS_KEY || k === MODULE_MODELS_KEY || k.indexOf(KEY_PREFIX) === 0)) {
      try { fn(changes); } catch (e) { console.error('onRegistryChanged', e); }
    }
  });
}
