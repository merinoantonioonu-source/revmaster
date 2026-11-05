/**
 * entities.js - The entities of a project and their tags.
 *
 * computeEntities(input) runs the detectors over every paragraph of both documents, applies the
 * translator's manual adjustments and returns one entity per KEY (the same key in the source and
 * the target is the same entity, so both sides get the same tag).
 *
 * Tags: source  {CARGO1}      target  {el CARGO1}   (article of the ENTITY; none when unknown).
 * Numbering is per category, in order of first appearance (source before target in each unit).
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

export const TAG_RE = /\{(?:(el|la|los|las)\s)?(NUM|FECHA|ORGANO|ORG|PAIS|LUGAR|PER|CARGO|SIMB|URL|X)(\d+)\}/g;

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
 * Returns { entities: [entity], byKey: Map, occ: { src: Map(paraId -> [occ]), tgt: Map(...) } }
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

  const run = (side, paraId, text, lang, unitIdx) => {
    const spans = detectSpans(text, lang, { gaz, terms, cats, acronymsBoth: both, spelled: mask.spelled, acronyms: mask.acronyms });
    const list = [];
    for (const s of spans) {
      const key = _resolveKey(s.key, mask.merges);
      if (removedKeys.has(key)) continue;
      if (removedOcc.has(side + ':' + paraId + ':' + s.start)) continue;
      const o = { side, paraId, start: s.start, end: s.end, key, surface: s.surface, art: s.art || '' };
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

  input.units.forEach((u, i) => {
    if (u.srcPara !== null && u.srcPara !== undefined) run('src', u.srcPara, input.src.paras[u.srcPara].text, input.srcLang, i);
    if (u.tgtPara !== null && u.tgtPara !== undefined) run('tgt', u.tgtPara, input.tgt.paras[u.tgtPara].text, 'es', i);
  });

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
    const tgtFormsN = Object.keys(e.tgtForms).length;
    if (!e.srcCount || !e.tgtCount) e.status = 'nopair';
    else if (e.srcCount !== e.tgtCount) e.status = 'count';
    else if (tgtFormsN > 1 && e.cat !== 'NUM' && e.cat !== 'FECHA') e.status = 'forms';
    else e.status = 'ok';
  }
  return { entities: order, byKey, occ };
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
    const tag = side === 'src' ? e.tagSrc : e.tagTgt;
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

/** Replaces every tag of a masked text with the entity's target (or source) form. */
export function rehydrate(text, entitiesByTag, side) {
  return String(text || '').replace(TAG_RE, (all, art, cat, n) => {
    const e = entitiesByTag.get(cat + n);
    if (!e) return all;
    const f = side === 'src' ? (mainForm(e.srcForms) || mainForm(e.tgtForms)) : (mainForm(e.tgtForms) || mainForm(e.srcForms));
    return f || all;
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
