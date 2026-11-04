/**
 * usage.js - What the AI has cost: a running record of the tokens every AI call used, by day, module,
 * provider, model, project and file, and an approximate cost from the models' prices.
 *
 * Origin: COMeT services/ai-usage.js @ 04540f5 (adapted)
 *
 * WHERE IT IS WRITTEN. Every AI call of UMBRA goes through gateway.js, which hears from the provider
 * what the call used (onUsage) and passes it here (recordUsage). A web page has no background
 * worker, so the record is written here directly, one write after another (a queue, plus a
 * navigator.locks lock so that two tabs never interleave their read-modify-write).
 *
 * WHAT IS KEPT. Totals per day, not each call:
 *   usage:<device id> = { v: 1, device: <name>, updated: ms,
 *                         days: { 'YYYY-MM-DD': { '<module>|<provider>|<model>|<project>|<file>':
 *                                                  [calls, input, cached, output, thoughts, words] } } }
 * `input` counts every token sent (`cached` of them served from the provider's cache), `output` the
 * answer WITHOUT the reasoning, `thoughts` the reasoning (billed as output), `words` the words of the
 * translator's text the calls worked on. Each computer writes only its own key, so the sync file
 * carries every computer's record (merge: the copy written last) and nothing is counted twice.
 *
 * PRICES. ai_prices = { models: { '<provider>|<model>': { in, cached, out, src, at } }, eurPerUsd, fxAt },
 * in US dollars per million tokens. priceFor() looks first at the profile's own model price (set in
 * Settings > Providers), then at ai_prices, then at a few built-in list prices.
 *
 * SESSION METER. getSessionTotals() / onUsage(fn): what this page has spent since it opened (in
 * memory), for the header chip "Sesion: N tokens . X US$".
 */

import { storage, getValue, setValue } from '../store/storage.js';
import { getDevice } from '../sync/sync-device.js';
import { getProvider } from './registry.js';

export const USAGE_PREFIX = 'usage:';
export const PRICES_KEY = 'ai_prices';
export const NOTES_KEY = 'usage_notes';
export const PRICE_LIST_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
// The same list as a page to read (Settings links to it, so the prices can be checked).
export const PRICE_LIST_PAGE = 'https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json';
// The module a call came from when it said none (e.g. the connection test in Settings).
export const OTHER_MODULE = 'other';

// List prices (US$ per million tokens) of models LiteLLM may not know yet. Last resort of priceFor().
const BUILTIN_PRICES = {
  'anthropic|claude-opus-5-5': { in: 4, cached: 0.2, out: 20 },
  'anthropic|claude-sonnet-5-5': { in: 2, cached: 0.2, out: 10 },
  'anthropic|claude-haiku-5-5': { in: 0.1, cached: null, out: 0.5 }
};
const BUILTIN_SRC = 'Lista de Anthropic (2026-10)';

function _localDay(d) {
  const x = d || new Date();
  const p = (n) => (n < 10 ? '0' : '') + n;
  return x.getFullYear() + '-' + p(x.getMonth() + 1) + '-' + p(x.getDate());
}

function _n(v) { return (typeof v === 'number' && isFinite(v) && v > 0) ? Math.round(v) : 0; }

// A part of the record's key: no '|' (the separator) and no spaces around it.
function _part(v) { return String(v || '').replace(/\|/g, '/').trim(); }

/** The words in a text, as the record counts them: runs of characters holding a letter or a digit. */
export function countWords(text) {
  const t = String(text || '').trim();
  if (!t) return 0;
  return t.split(/\s+/).filter(w => /[\p{L}\p{N}]/u.test(w)).length;
}

async function _withLock(name, fn) {
  try {
    if (typeof navigator !== 'undefined' && navigator.locks && navigator.locks.request) {
      return await navigator.locks.request(name, fn);
    }
  } catch (_) { /* no lock: better to write than not */ }
  return await fn();
}

// ------------------------------------------------------------------ session meter

const _session = { calls: 0, input: 0, cached: 0, output: 0, thoughts: 0, words: 0, cost: 0, unpriced: 0 };
const _sessionListeners = new Set();

/** What this page has spent since it opened: { calls, input, cached, output, thoughts, words, tokens, cost, unpriced }. */
export function getSessionTotals() {
  return Object.assign({}, _session, { tokens: _session.input + _session.output + _session.thoughts });
}

/** fn(totals, entry) after every recorded call. Returns the unsubscriber. */
export function onUsage(fn) {
  if (typeof fn !== 'function') return () => {};
  _sessionListeners.add(fn);
  return () => _sessionListeners.delete(fn);
}

async function _bumpSession(entry) {
  let cost = null;
  try { cost = costOf(entry, await priceFor(entry.provider, entry.model)); } catch (_) { cost = null; }
  _session.calls += 1;
  _session.input += entry.input; _session.cached += entry.cached; _session.output += entry.output;
  _session.thoughts += entry.thoughts; _session.words += entry.words;
  if (cost === null) _session.unpriced += 1; else _session.cost += cost;
  const totals = getSessionTotals();
  for (const fn of Array.from(_sessionListeners)) {
    try { fn(totals, Object.assign({ cost }, entry)); } catch (e) { console.error('onUsage listener', e); }
  }
  return cost;
}

// ------------------------------------------------------------------ the record

// This page's writes, one after another (two calls answered together must both count).
let _queue = Promise.resolve();

/**
 * After a call the provider reported (gateway.js). Never throws: the record is a statistic, not a
 * condition for anything. Resolves to the call's cost in US$ (null when the model has no price).
 */
export function recordUsage({ module, provider, model, usage, project, file, words } = {}) {
  const u = usage || {};
  const entry = {
    day: _localDay(),
    module: String(module || OTHER_MODULE),
    provider: String(provider || ''),
    model: String(model || ''),
    project: _part(project), file: _part(file),
    input: _n(u.input), cached: _n(u.cached), output: _n(u.output), thoughts: _n(u.thoughts), words: _n(words)
  };
  const p = _queue.then(() => _withLock('umbra-usage-write', () => _apply(entry))).catch((e) => {
    console.warn('usage: could not record', e);
  }).then(() => _bumpSession(entry)).catch(() => null);
  _queue = p.then(() => {}, () => {});
  return p;
}

async function _apply(entry) {
  const dev = await getDevice();
  const key = USAGE_PREFIX + dev.id;
  const cur = await getValue(key, null);
  const rec = (cur && typeof cur === 'object' && cur.days) ? cur : { v: 1, days: {} };
  rec.v = 1;
  rec.device = dev.name || rec.device || '';
  const day = rec.days[entry.day] || (rec.days[entry.day] = {});
  const k = [_part(entry.module), _part(entry.provider), _part(entry.model), _part(entry.project), _part(entry.file)].join('|');
  const t = day[k] || (day[k] = [0, 0, 0, 0, 0, 0]);
  while (t.length < 6) t.push(0);
  t[0] += 1; t[1] += entry.input; t[2] += entry.cached; t[3] += entry.output; t[4] += entry.thoughts; t[5] += entry.words;
  rec.updated = Date.now();
  await setValue(key, rec);
}

/**
 * Every computer's record, as rows: [{ day, device, mine, module, provider, model, project, file,
 * calls, input, cached, output, thoughts, words }]. `device` is the computer's name (or "Este
 * equipo" / "Otro equipo").
 */
export async function readUsageRows() {
  const all = await storage.get(null);
  let me = { id: '' };
  try { me = await getDevice(); } catch (_) {}
  const rows = [];
  for (const key of Object.keys(all)) {
    if (key.indexOf(USAGE_PREFIX) !== 0) continue;
    const rec = all[key];
    if (!rec || typeof rec !== 'object' || !rec.days) continue;
    const mine = key === USAGE_PREFIX + me.id;
    const device = rec.device || (mine ? 'Este equipo' : 'Otro equipo');
    for (const day of Object.keys(rec.days)) {
      const d = rec.days[day] || {};
      for (const k of Object.keys(d)) {
        const t = d[k];
        if (!Array.isArray(t)) continue;
        const parts = k.split('|');
        rows.push({
          day, device, mine,
          module: parts[0] || OTHER_MODULE, provider: parts[1] || '', model: parts[2] || '',
          project: parts[3] || '', file: parts[4] || '',
          calls: _n(t[0]), input: _n(t[1]), cached: _n(t[2]), output: _n(t[3]), thoughts: _n(t[4]), words: _n(t[5])
        });
      }
    }
  }
  return rows;
}

// ------------------------------------------------------------------ prices

export async function loadPrices() {
  try {
    const p = await getValue(PRICES_KEY, null);
    if (p && typeof p === 'object') return { models: Object.assign({}, p.models || {}), eurPerUsd: p.eurPerUsd || null, fxAt: p.fxAt || 0 };
  } catch (_) {}
  return { models: {}, eurPerUsd: null, fxAt: 0 };
}

export async function savePrices(prices) {
  await setValue(PRICES_KEY, { models: prices.models || {}, eurPerUsd: prices.eurPerUsd || null, fxAt: prices.fxAt || 0 });
}

export function priceKey(provider, model) { return String(provider || '') + '|' + String(model || ''); }

function _isPrice(p) { return !!p && typeof p.in === 'number' && typeof p.out === 'number'; }

/**
 * The price of a model: { in, cached, out, src } in US$ per million tokens, or null. The profile's
 * own price first (Settings > Providers), then ai_prices, then the built-in list prices.
 */
export const BATCH_SUFFIX = '#batch';
export const BATCH_DISCOUNT = 0.5;

export async function priceFor(providerId, modelId) {
  // Deferred batch jobs are recorded as '<model>#batch' and cost half the normal price.
  if (String(modelId || '').endsWith(BATCH_SUFFIX)) {
    const base = await priceFor(providerId, String(modelId).slice(0, -BATCH_SUFFIX.length));
    if (!base) return null;
    const half = (v) => (typeof v === 'number' ? v * BATCH_DISCOUNT : v);
    return Object.assign({}, base, { in: half(base.in), cached: half(base.cached), out: half(base.out), src: (base.src || '') + ' \u00b7 lotes \u221250 %' });
  }
  let profile = null;
  try { profile = await getProvider(providerId); } catch (_) { profile = null; }
  if (profile) {
    const m = (profile.models || []).find(x => x.id === modelId);
    if (m && _isPrice(m.price)) return Object.assign({ src: 'Perfil del proveedor' }, m.price);
  }
  const prices = await loadPrices();
  const p = prices.models[priceKey(providerId, modelId)];
  if (_isPrice(p)) return Object.assign({}, p);
  const adapter = profile ? profile.adapter : providerId;
  const b = BUILTIN_PRICES[priceKey(adapter, modelId)];
  if (b) return Object.assign({ src: BUILTIN_SRC }, b);
  return null;
}

/**
 * The cost of some usage in US dollars, or null when the model has no price. Cached tokens at the
 * cache price (the input price when there is none); the reasoning at the output price. (As COMeT.)
 */
export function costOf(u, price) {
  if (!price || typeof price.in !== 'number' || typeof price.out !== 'number') return null;
  const cachedPrice = (typeof price.cached === 'number') ? price.cached : price.in;
  const fresh = Math.max(0, (u.input || 0) - (u.cached || 0));
  return (fresh * price.in + (u.cached || 0) * cachedPrice + ((u.output || 0) + (u.thoughts || 0)) * price.out) / 1e6;
}

/** Cost estimate before a call (the plan): US$ or null when the model has no price. */
export async function estimateCost(providerId, modelId, inTokens, outTokens, cachedTokens) {
  const price = await priceFor(providerId, modelId);
  return costOf({ input: inTokens || 0, cached: cachedTokens || 0, output: outTokens || 0, thoughts: 0 }, price);
}

// The names LiteLLM may list a model under, best first.
function _listNames(adapter, model) {
  const m = String(model || '').trim();
  if (!m) return [];
  const last = m.split('/').pop();
  if (adapter === 'gemini') return ['gemini/' + m, m, 'vertex_ai/' + m];
  if (adapter === 'mistral') return ['mistral/' + m, m];
  if (adapter === 'azure-openai') return ['azure/' + m, m];
  if (adapter === 'anthropic') return [m, 'anthropic/' + m];
  return [m, last, 'openrouter/' + m, 'deepseek/' + last, 'groq/' + m];
}

/**
 * Looks the models up in LiteLLM's price list. `keys`: [{ provider, model, adapter? }] (the adapter
 * is read from the profile when missing). Returns { found: { '<provider>|<model>': { in, cached, out,
 * src, at } }, missing: [keys] }. US$ per million tokens. Throws when the list cannot be read.
 */
export async function lookupPrices(keys) {
  const res = await fetch(PRICE_LIST_URL, { cache: 'no-store' });
  if (!res.ok) throw new Error('La lista de precios ha respondido HTTP ' + res.status);
  const list = await res.json();
  const found = {};
  const missing = [];
  const per1M = (v) => (typeof v === 'number' && isFinite(v)) ? Math.round(v * 1e6 * 10000) / 10000 : null;
  for (const k of (keys || [])) {
    let adapter = k.adapter;
    if (!adapter) {
      try { const p = await getProvider(k.provider); adapter = p ? p.adapter : k.provider; } catch (_) { adapter = k.provider; }
    }
    let hit = null, name = '';
    for (const n of _listNames(adapter, k.model)) {
      const e = list[n];
      if (e && typeof e === 'object' && typeof e.input_cost_per_token === 'number' && typeof e.output_cost_per_token === 'number') { hit = e; name = n; break; }
    }
    if (!hit) { missing.push(k); continue; }
    found[priceKey(k.provider, k.model)] = {
      in: per1M(hit.input_cost_per_token),
      cached: per1M(hit.cache_read_input_token_cost),
      out: per1M(hit.output_cost_per_token),
      src: 'LiteLLM (' + name + ')',
      at: Date.now()
    };
  }
  return { found, missing };
}

// ------------------------------------------------------------------ notes

/**
 * The translator's own notes on a project or a file of the record ("Resoluci\u00f3n", "Quinta Comisi\u00f3n"):
 * usage_notes = { notes: { '<project>': { text, at }, '<project>|<file>': { text, at } } }. An empty
 * text is a note deleted (kept with its time, so that the sync file does not bring the old one back).
 */
export async function loadUsageNotes() {
  try {
    const v = await getValue(NOTES_KEY, null);
    if (v && typeof v === 'object' && v.notes && typeof v.notes === 'object') return v.notes;
  } catch (_) {}
  return {};
}

/** Writes one note ('' deletes it). Returns all the notes. */
export async function saveUsageNote(key, text) {
  const notes = await loadUsageNotes();
  notes[String(key)] = { text: String(text || '').trim().slice(0, 120), at: Date.now() };
  await setValue(NOTES_KEY, { notes });
  return notes;
}

// ------------------------------------------------------------------ sync (sync/sync-spec.js)

/** Two copies of the notes: per project or file, the note written last. */
export function mergeUsageNotes(a, b) {
  const an = (a && a.notes && typeof a.notes === 'object') ? a.notes : {};
  const bn = (b && b.notes && typeof b.notes === 'object') ? b.notes : {};
  const notes = Object.assign({}, an);
  for (const k of Object.keys(bn)) {
    const x = notes[k], y = bn[k];
    if (!y || typeof y !== 'object') continue;
    if (!x || (Number(y.at) || 0) >= (Number(x.at) || 0)) notes[k] = y;
  }
  return { notes };
}

/** Two copies of one computer's record: the one written last (each computer writes only its own). */
export function mergeUsageRecord(a, b) {
  const ao = (a && typeof a === 'object') ? a : null;
  const bo = (b && typeof b === 'object') ? b : null;
  if (!ao) return bo;
  if (!bo) return ao;
  return ((bo.updated || 0) >= (ao.updated || 0)) ? bo : ao;
}

/** Two price tables: per model, the price set last; the exchange rate set last. */
export function mergePrices(a, b) {
  const ao = (a && typeof a === 'object') ? a : {};
  const bo = (b && typeof b === 'object') ? b : {};
  const models = Object.assign({}, ao.models || {});
  for (const k of Object.keys(bo.models || {})) {
    const x = models[k], y = bo.models[k];
    if (!x || ((y && y.at) || 0) >= (x.at || 0)) models[k] = y;
  }
  const fxB = (bo.fxAt || 0) >= (ao.fxAt || 0);
  return { models, eurPerUsd: fxB ? (bo.eurPerUsd || null) : (ao.eurPerUsd || null), fxAt: Math.max(ao.fxAt || 0, bo.fxAt || 0) };
}
