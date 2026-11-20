/**
 * leak-guard.js - The safety net of the gateway and the record of what was sent.
 *
 * The masking replaces each entity by its tag; the gateway still looks at every masked text BEFORE it
 * leaves (callAI, the deferred batches, the text copied for an external AI): if the real form of an
 * entity of the open project appears in it (a name masked in one paragraph and missed in another, a
 * text built by mistake from real words), it is replaced by the entity's tag and the listeners are told
 * (a warning on screen). Not looked at: the names table (Nombres oficiales, the owner's exception), a
 * project "Sin enmascarar" and a local provider allowed to read the text.
 *
 * Left out of the net: plain numbers (paragraph numbers go in every prompt), forms shorter than three
 * characters, one word that also appears with a lowercase first letter in the documents (an ordinary
 * word: Long, May) and entities the translator chose to leave visible somewhere (removedOcc).
 *
 * The record (in memory only, cleared when another project opens) keeps the last calls as they were
 * sent: module, model, time, instructions and text, and what the net masked.
 */

import { lowercaseWords, isOrdinaryWord } from '../redact/entities.js';

const MAX_LOG = 300;
let _guard = null;
let _log = [];
let _seq = 0;
const _leakListeners = [];
const _sentListeners = [];

const _esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The net for a project: buildLeakGuard(entities, { skip: Set(key), texts: [all paragraph texts] })
 * -> { re, tagOf: Map(form -> tag) } or null when there is nothing to watch.
 */
export function buildLeakGuard(entities, opts) {
  const o = opts || {};
  const skip = o.skip || new Set();
  const lower = lowercaseWords(o.texts || []);
  const tagOf = new Map();
  for (const e of entities || []) {
    if (skip.has(e.key)) continue;
    const tag = e.tagSrc || ('{' + e.cat + e.n + '}');
    for (const raw of Object.keys(e.srcForms || {}).concat(Object.keys(e.tgtForms || {}))) {
      const f = String(raw || '').trim();
      if (f.length < 3 || tagOf.has(f)) continue;
      if (!/[\p{L}]/u.test(f) && !/\d[.,\u00a0\u202f ]\d/.test(f) && !/[\/@:]/.test(f)) continue;   // a plain number
      if (isOrdinaryWord(f, lower)) continue;
      tagOf.set(f, tag);
    }
  }
  if (!tagOf.size) return null;
  const list = Array.from(tagOf.keys()).sort((a, b) => b.length - a.length);
  const re = new RegExp('(?<![\\p{L}\\p{N}{])(?:' + list.map(_esc).join('|') + ')(?![\\p{L}\\p{N}}])', 'gu');
  return { re, tagOf };
}

/** The net of the open project (state.js sets it each time the masking is recomputed). */
export function setLeakGuard(guard) { _guard = guard || null; }
export function currentLeakGuard() { return _guard; }

/** guardText(text) -> { text, hits:[{ form, tag, count }] }: the real forms replaced by their tags. */
export function guardText(text, guard) {
  const g = guard === undefined ? _guard : guard;
  const s = String(text || '');
  if (!g || !s) return { text: s, hits: [] };
  const count = new Map();
  g.re.lastIndex = 0;
  const out = s.replace(g.re, (m) => {
    const tag = g.tagOf.get(m);
    if (!tag) return m;
    count.set(m, (count.get(m) || 0) + 1);
    return tag;
  });
  const hits = Array.from(count, ([form, n]) => ({ form, tag: g.tagOf.get(form), count: n }));
  if (hits.length) for (const fn of _leakListeners.slice()) { try { fn(hits); } catch (e) { console.error('leak', e); } }
  return { text: out, hits };
}

/** Called with [{ form, tag, count }] each time the net masks something. */
export function onLeak(fn) { _leakListeners.push(fn); }

// ------------------------------------------------------------------ what was sent

/** Records one call as it left: { module, role, providerId, modelId, system, prompt, leaks, deferred, unmasked }. */
export function logSent(entry) {
  const e = Object.assign({ id: ++_seq, at: Date.now() }, entry);
  _log.push(e);
  if (_log.length > MAX_LOG) _log = _log.slice(-MAX_LOG);
  for (const fn of _sentListeners.slice()) { try { fn(e); } catch (err) { console.error('sent', err); } }
  return e;
}

/** The calls sent since the project was opened, oldest first. */
export function sentLog() { return _log.slice(); }

export function clearSentLog() { _log = []; }

export function onSent(fn) { _sentListeners.push(fn); }
