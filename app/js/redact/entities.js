/**
 * entities.js - The entities of a project and their tags.
 *
 * computeEntities(input) runs the detectors over every paragraph of both documents, applies the
 * translator's manual adjustments and returns one entity per KEY (the same key in the source and
 * the target is the same entity, so both sides get the same tag).
 *
 * Tags: {CARGO1}, the same on both sides. An entity written both as a name and as its acronym in the
 * document (United Nations Development Programme / UNDP / PNUD) keeps one number, and its acronym is
 * marked with an "s" (sigla): {ORG5} ({ORG5s}) - one entity, one count, but the AI sees which is which.
 * Numbering is per category, in order of first appearance (source before target in each unit).
 *
 * A person recognised once by a courtesy title (Ms. Ivanova, Sr. Ruiz) is masked wherever the name
 * appears alone in either document (spreadPersons), with the same key, so it keeps one tag.
 *
 * Manual adjustments live in project.mask (see defaultMaskSettings):
 *   terms       [{ id, cat, art, src:[forms], tgt:[forms] }]  project terms (Alt+E), key 't:<id>'
 *   removedKeys [key]            whole entities that must NOT be masked
 *   removedOcc  ['side:paraId:start']  single occurrences that must not be masked
 *   merges      { fromKey: toKey }      "these two are the same entity"
 *   catOverride { key: cat }, artOverride { key: art }
 */

import { detectSpans, compileGazetteer, acronymsIn } from './detect.js';

export const CATS = ['NUM', 'FECHA', 'ORG', 'ORGANO', 'PAIS', 'LUGAR', 'PER', 'CARGO', 'SIMB', 'URL', 'X'];
export const CAT_LABELS = {
  NUM: 'Cifras', FECHA: 'Fechas', ORG: 'Organismos', ORGANO: '\u00d3rganos', PAIS: 'Pa\u00edses', LUGAR: 'Lugares',
  PER: 'Personas', CARGO: 'Cargos', SIMB: 'S\u00edmbolos', URL: 'URL y correos', X: 'Personalizada'
};
export const CAT_SINGULAR = {
  NUM: 'Cifra', FECHA: 'Fecha', ORG: 'Organismo', ORGANO: '\u00d3rgano', PAIS: 'Pa\u00eds', LUGAR: 'Lugar',
  PER: 'Persona', CARGO: 'Cargo', SIMB: 'S\u00edmbolo', URL: 'URL o correo', X: 'Personalizada'
};
export const ARTICLES = ['', 'el', 'la', 'los', 'las'];

export const TAG_RE = /\{(?:(el|la|los|las)\s)?(NUM|FECHA|ORGANO|ORG|PAIS|LUGAR|PER|CARGO|SIMB|URL|X)(\d+)(s?)\}/g;

/** An acronym: one word of capitals (and digits or hyphens), at least two capitals: UNDP, PNUD, AUSSOM. */
export function isAcronymForm(form) {
  const f = String(form || '').trim();
  return /^[A-Z0-9][A-Z0-9&\-]{1,11}$/.test(f) && (f.match(/[A-Z]/g) || []).length >= 2;
}

/** The tag of one occurrence: the acronym of an entity also written in full gets the "s" mark. */
export function occTag(e, o) {
  return (o && o.short && e.tagShort) ? e.tagShort : e.tagSrc;
}

export function defaultMaskSettings() {
  return {
    cats: CATS.filter(c => c !== 'X'),
    spelled: true,
    acronyms: true,
    terms: [],
    removedKeys: [],
    removedOcc: [],
    merges: {},
    catOverride: {},
    artOverride: {}
  };
}

function _resolveKey(key, merges) {
  let k = key;
  const seen = new Set();
  while (merges && merges[k] && !seen.has(k)) { seen.add(k); k = merges[k]; }
  return k;
}

/**
 * input = { units, src: model, tgt: model, srcLang, mask, gazetteer: [entries], dict: [entries] }
 * units = [{ id, srcPara, tgtPara }] in document order (paraId or null).
 * Returns { entities: [entity], byKey: Map, occ: { src: Map(paraId -> [occ]), tgt: Map(...) },
 *           skipped: Set(key) (entities with an occurrence the translator chose not to mask) }
 * entity = { id (= key), key, cat, n, art, tagSrc, tagTgt, srcForms:{form:count}, tgtForms:{form:count},
 *            srcCount, tgtCount, status:'ok'|'nopair'|'count'|'forms', firstUnit }
 * occ = { side, paraId, start, end, key, surface, art }
 */
export function computeEntities(input) {
  const mask = Object.assign(defaultMaskSettings(), input.mask || {});
  const cats = new Set(mask.cats);
  if ((mask.terms || []).length) cats.add('X');
  const gaz = compileGazetteer([].concat(input.gazetteer || [], input.dict || []), (e) => e.key || ('g:' + e.id));
  const termEntries = (mask.terms || []).map(t => ({
    id: t.id, key: 't:' + t.id, cat: t.cat || 'X', art: t.art || '',
    en: t.src || [], fr: t.src || [], es: t.tgt || []
  }));
  const terms = termEntries.length ? compileGazetteer(termEntries, (e) => e.key) : null;

  // Unknown acronyms are masked only when they appear on both sides somewhere in the document.
  const accSrc = new Set(), accTgt = new Set();
  for (const u of input.units) {
    if (u.srcPara !== null && u.srcPara !== undefined) for (const a of acronymsIn(input.src.paras[u.srcPara].text)) accSrc.add(a.text);
    if (u.tgtPara !== null && u.tgtPara !== undefined) for (const a of acronymsIn(input.tgt.paras[u.tgtPara].text)) accTgt.add(a.text);
  }
  const both = new Set(Array.from(accSrc).filter(a => accTgt.has(a)));

  const removedKeys = new Set(mask.removedKeys || []);
  const removedOcc = new Set(mask.removedOcc || []);
  const occ = { src: new Map(), tgt: new Map() };
  const byKey = new Map();
  const order = [];
  const skipped = new Set();

  const run = (side, paraId, spans, unitIdx) => {
    const list = [];
    for (const s of spans) {
      const key = _resolveKey(s.key, mask.merges);
      if (removedKeys.has(key)) continue;
      if (removedOcc.has(side + ':' + paraId + ':' + s.start)) { skipped.add(key); continue; }
      const o = { side, paraId, start: s.start, end: s.end, key, surface: s.surface, art: s.art || '', short: isAcronymForm(s.surface) };
      list.push(o);
      let e = byKey.get(key);
      if (!e) {
        e = { id: key, key, cat: (mask.catOverride && mask.catOverride[key]) || s.cat, n: 0, art: '', arts: {},
          srcForms: {}, tgtForms: {}, srcCount: 0, tgtCount: 0, firstUnit: unitIdx, status: 'ok' };
        byKey.set(key, e);
        order.push(e);
      }
      if (side === 'src') { e.srcForms[s.surface] = (e.srcForms[s.surface] || 0) + 1; e.srcCount++; }
      else { e.tgtForms[s.surface] = (e.tgtForms[s.surface] || 0) + 1; e.tgtCount++; }
      if (s.art) e.arts[s.art] = (e.arts[s.art] || 0) + (side === 'tgt' ? 2 : 1);
    }
    if (list.length) occ[side].set(paraId, list);
  };

  // Every paragraph in document order (source before target in each unit), then its spans.
  const paras = [];
  input.units.forEach((u, i) => {
    if (u.srcPara !== null && u.srcPara !== undefined) paras.push({ side: 'src', paraId: u.srcPara, text: input.src.paras[u.srcPara].text, lang: input.srcLang, unitIdx: i });
    if (u.tgtPara !== null && u.tgtPara !== undefined) paras.push({ side: 'tgt', paraId: u.tgtPara, text: input.tgt.paras[u.tgtPara].text, lang: 'es', unitIdx: i });
  });
  const ctx = { gaz, terms, cats, acronymsBoth: both, spelled: mask.spelled, acronyms: mask.acronyms };
  const spansOf = paras.map(p => detectSpans(p.text, p.lang, ctx));
  if (cats.has('PER')) spreadPersons(paras.map(p => p.text), spansOf);
  paras.forEach((p, k) => run(p.side, p.paraId, spansOf[k], p.unitIdx));

  // Numbering per category, in order of appearance.
  const counters = {};
  for (const e of order) {
    counters[e.cat] = (counters[e.cat] || 0) + 1;
    e.n = counters[e.cat];
    const override = mask.artOverride && Object.prototype.hasOwnProperty.call(mask.artOverride, e.key) ? mask.artOverride[e.key] : null;
    if (override !== null && override !== undefined) e.art = override;
    else {
      const best = Object.keys(e.arts).sort((a, b) => e.arts[b] - e.arts[a])[0];
      e.art = best || '';
    }
    delete e.arts;
    // No article inside the tag any more (2026-11-05, at the user's request: it confused more than it
    // helped). The same tag on both sides; TAG_RE still reads an article for old texts.
    e.tagSrc = '{' + e.cat + e.n + '}';
    e.tagTgt = e.tagSrc;
    // Written both in full and as an acronym in this document: the acronym is {CATns}.
    const allForms = Object.keys(e.srcForms).concat(Object.keys(e.tgtForms));
    e.tagShort = (allForms.some(isAcronymForm) && allForms.some(f => !isAcronymForm(f))) ? '{' + e.cat + e.n + 's}' : null;
    // A name and its acronym are not two translations: count the names and the acronyms apart.
    const tf = Object.keys(e.tgtForms);
    const tgtFormsN = Math.max(tf.filter(isAcronymForm).length, tf.filter(f => !isAcronymForm(f)).length);
    if (!e.srcCount || !e.tgtCount) e.status = 'nopair';
    else if (e.srcCount !== e.tgtCount) e.status = 'count';
    // A person is named in full or by the surname alone: several forms are normal there.
    else if (tgtFormsN > 1 && e.cat !== 'NUM' && e.cat !== 'FECHA' && e.cat !== 'PER') e.status = 'forms';
    else e.status = 'ok';
  }
  return { entities: order, byKey, occ, skipped };
}

const _esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Words of the texts that start with a lowercase letter (to tell an ordinary word that a surname
 * happens to share - Long, May, Green - from a name).
 */
export function lowercaseWords(texts) {
  const out = new Set();
  for (const t of texts) for (const m of String(t || '').matchAll(/(?<![\p{L}])\p{Ll}[\p{L}']*/gu)) out.add(m[0]);
  return out;
}

/** An ordinary word: one word that also appears with a lowercase first letter in the documents. */
export function isOrdinaryWord(form, lower) {
  return !/\s/.test(form) && lower.has(form.charAt(0).toLowerCase() + form.slice(1));
}

/**
 * A person recognised by a courtesy title (detector 'per': "Ms. Maria Ivanova") is masked wherever
 * the name appears alone: the whole name and its endings ("Maria Ivanova", "Ivanova"), whole words,
 * same case, where nothing else is masked. A one-word ending that is also an ordinary word of the
 * documents is left alone. texts[k] and spansOf[k] belong to the same paragraph; spansOf is updated.
 */
export function spreadPersons(texts, spansOf) {
  const forms = new Map();
  for (const spans of spansOf) {
    for (const s of spans) {
      if (s.src !== 'per' || !/^per:/.test(s.key)) continue;
      const words = String(s.surface || '').split(/\s+/).filter(Boolean);
      for (let i = 0; i < words.length; i++) {
        const f = words.slice(i).join(' ').replace(/[.,;:]+$/, '');
        if (f.length >= 3 && /^\p{Lu}/u.test(f) && !forms.has(f)) forms.set(f, s.key);
      }
    }
  }
  if (!forms.size) return spansOf;
  const lower = lowercaseWords(texts);
  for (const f of Array.from(forms.keys())) if (isOrdinaryWord(f, lower)) forms.delete(f);
  if (!forms.size) return spansOf;
  const list = Array.from(forms.keys()).sort((a, b) => b.length - a.length);
  const re = new RegExp('(?<![\\p{L}\\p{N}])(?:' + list.map(_esc).join('|') + ')(?![\\p{L}\\p{N}])', 'gu');
  texts.forEach((text, k) => {
    const spans = spansOf[k];
    const added = [];
    for (const m of String(text || '').matchAll(re)) {
      const start = m.index, end = start + m[0].length;
      const taken = (x) => x.start < end && start < x.end;
      if (spans.some(taken) || added.some(taken)) continue;
      added.push({ start, end, cat: 'PER', key: forms.get(m[0]), surface: m[0], art: '', src: 'per+' });
    }
    if (added.length) spansOf[k] = spans.concat(added).sort((a, b) => a.start - b.start);
  });
  return spansOf;
}

export const STATUS_LABELS = { ok: 'OK', nopair: 'Sin pareja', count: 'Recuento distinto', forms: 'Formas distintas' };

/** Most frequent form of a forms map ({form: count}). */
export function mainForm(forms) {
  let best = '', n = -1;
  for (const f of Object.keys(forms || {})) if (forms[f] > n) { best = f; n = forms[f]; }
  return best;
}

// ------------------------------------------------------------------ masking

/**
 * Masks one paragraph. occs: the occurrences of that paragraph (sorted). Returns
 * { masked, map:[{ oStart, oEnd, mStart, mEnd, key }] }.
 */
export function maskText(text, occs, side, byKey) {
  let out = '';
  let pos = 0;
  const map = [];
  for (const o of (occs || [])) {
    if (o.start < pos) continue;
    const e = byKey.get(o.key);
    if (!e) continue;
    const tag = occTag(e, o);
    out += text.slice(pos, o.start);
    map.push({ oStart: o.start, oEnd: o.end, mStart: out.length, mEnd: out.length + tag.length, key: o.key });
    out += tag;
    pos = o.end;
  }
  out += text.slice(pos);
  return { masked: out, map };
}

/** Offset in the original text for an offset in the masked text (a position inside a tag maps to
 *  the start of the entity when `edge` is 'start', to its end otherwise). */
export function maskedToOriginal(map, mPos, edge) {
  let delta = 0;
  for (const m of map) {
    if (mPos < m.mStart) break;
    if (mPos < m.mEnd) return edge === 'end' ? m.oEnd : m.oStart;
    delta = m.oEnd - m.mEnd;
  }
  return mPos + delta;
}

/** The forms of a forms map that are (or are not) acronyms. */
function _formsOf(forms, acr) {
  const out = {};
  for (const f of Object.keys(forms || {})) if (isAcronymForm(f) === acr) out[f] = forms[f];
  return out;
}

/** Replaces every tag of a masked text with the entity's target (or source) form; {ORG5s} with its
 *  acronym on that side (PNUD), {ORG5} with its name when the entity also has an acronym. */
export function rehydrate(text, entitiesByTag, side) {
  return String(text || '').replace(TAG_RE, (all, art, cat, n, sh) => {
    const e = entitiesByTag.get(cat + n);
    if (!e) return all;
    const mine = side === 'src' ? e.srcForms : e.tgtForms, other = side === 'src' ? e.tgtForms : e.srcForms;
    let f = '';
    if (e.tagShort) f = mainForm(_formsOf(mine, !!sh)) || mainForm(_formsOf(other, !!sh));
    return f || mainForm(mine) || mainForm(other) || all;
  });
}

export function entitiesByTagMap(entities) {
  const m = new Map();
  for (const e of entities || []) m.set(e.cat + e.n, e);
  return m;
}

/** The tags of a masked text, as 'CAT N' strings (article ignored). */
export function tagsIn(text) {
  const out = [];
  let m;
  const re = new RegExp(TAG_RE.source, 'g');
  while ((m = re.exec(String(text || ''))) !== null) out.push(m[2] + m[3]);
  return out;
}
