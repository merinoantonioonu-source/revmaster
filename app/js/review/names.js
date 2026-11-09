/**
 * names.js - The "Nombres oficiales" module: the table of institutional names of the document (each
 * masked organization, organ, title, country or place, with its forms in the original and the
 * translation) and the findings that come back for it.
 *
 * Only that table goes to the AI (gateway.callAINames validates it): no text of the document, no
 * persons, figures, dates, symbols, URLs or confidential terms of the user.
 *
 * A name translated WRONG is not recognised as that name, so it stays "Sin pareja" and would never
 * reach the table. Hence two more kinds of row, for a name of the original that its paragraph's
 * translation does not show:
 *   - next to a Spanish name of the same paragraph that has no counterpart anywhere in the original
 *     (UNTSO / UNIFIL left as they are): the two together, an ordinary row;
 *   - with nothing to pair (a name never recognised in the translation): the original's name and
 *     "\u2014"; the AI answers with the official Spanish name (and acronym), and a finding is made
 *     where none of them is in that paragraph's translation.
 * A name the translation does show elsewhere, but not in this paragraph, is left alone: a short
 * form or a pronoun is normal there ("el Departamento", "la Fuerza").
 */

import { newFindingId } from './findings.js';

export const NAME_CATS = ['ORG', 'ORGANO', 'CARGO', 'PAIS', 'LUGAR'];
/** The translation column of a name not recognised in the translation. */
export const NO_FORM = '\u2014';

const _fold = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();

/**
 * -> [{ n, key, cat, src: 'form / form', tgt: 'form', count, missing?, units? }] one row per form of the
 * translation; then the rows of names the translation does not show (see the head of this file).
 */
export function namesRows(session) {
  const rows = [];
  for (const e of session.ent.entities) {
    if (!NAME_CATS.includes(e.cat)) continue;
    const src = Object.keys(e.srcForms), tgt = Object.keys(e.tgtForms);
    if (!src.length || !tgt.length) continue;   // one side only: the rows below
    for (const t of tgt) rows.push({ n: rows.length + 1, key: e.key, cat: e.cat, src: src.join(' / '), tgt: t, count: e.tgtForms[t] });
  }
  // Names of the original that their paragraph's translation does not show.
  const byKey = session.ent.byKey;
  const unitBySrc = new Map();
  for (const u of session.units) if (u.srcPara !== null && u.srcPara !== undefined && u.tgtPara !== null && u.tgtPara !== undefined && !unitBySrc.has(u.srcPara)) unitBySrc.set(u.srcPara, u);
  const paired = new Map(), missing = new Map();
  for (const [pid, occs] of session.ent.occ.src) {
    const u = unitBySrc.get(pid);
    if (!u) continue;
    const tOccs = session.ent.occ.tgt.get(u.tgtPara) || [];
    const tKeys = new Set(tOccs.map(o => o.key)), sKeys = new Set(occs.map(o => o.key));
    for (const o of occs) {
      const e = byKey.get(o.key);
      if (!e || !NAME_CATS.includes(e.cat) || tKeys.has(o.key)) continue;
      // A Spanish name of this paragraph with no counterpart anywhere in the original, same kind first.
      const lone = tOccs.filter(t => { const te = byKey.get(t.key); return te && NAME_CATS.includes(te.cat) && !te.srcCount && !sKeys.has(t.key); });
      const cand = lone.find(t => byKey.get(t.key).cat === e.cat) || lone[0];
      if (cand) {
        const k = o.surface + '\u0001' + cand.key + '\u0001' + cand.surface;
        if (!paired.has(k)) paired.set(k, { key: cand.key, cat: e.cat, src: o.surface, tgt: cand.surface, count: 1, loose: true, units: [] });
        const p = paired.get(k);
        if (!p.units.includes(u.idx)) p.units.push(u.idx);
      } else if (!e.tgtCount) {
        if (!missing.has(e.key)) missing.set(e.key, { key: e.key, cat: e.cat, src: Object.keys(e.srcForms).join(' / '), tgt: NO_FORM, missing: true, units: [] });
        const m = missing.get(e.key);
        if (!m.units.includes(u.idx)) m.units.push(u.idx);
      }
    }
  }
  for (const r of [...paired.values(), ...missing.values()]) rows.push(Object.assign({ n: rows.length + 1 }, r));
  return rows;
}

/** The table as sent (also used to estimate its size). */
export function namesTableText(rows) {
  return 'NOMBRES (fila | categor\u00eda | original | traducci\u00f3n):\n' +
    rows.map(r => r.n + ' | ' + r.cat + ' | ' + r.src + ' | ' + r.tgt).join('\n') + '\n(FIN ' + rows.length + ')';
}

/**
 * The answer lines (parse.js items, with `unit` = row number) as findings: one per occurrence of that
 * form in the translation, anchored on the real text.
 */
export function namesFindings(session, rows, items, meta) {
  const out = [];
  const byN = new Map(rows.map(r => [r.n, r]));
  const unitOfTgt = new Map();
  for (const u of session.units) if (u.tgtPara !== null && u.tgtPara !== undefined && !unitOfTgt.has(u.tgtPara)) unitOfTgt.set(u.tgtPara, u);
  for (const it of items) {
    const row = byN.get(it.unit);
    if (!row) continue;
    // The official name (and acronym) the AI gives.
    const alts = String(it.suggestion || '').split(/\s+\/\s+|\s*;\s*/).map(x => x.replace(/^[\u00ab"\u201c]|[\u00bb"\u201d]$/g, '').trim()).filter(Boolean);
    const shows = (u) => { const text = _fold(session.tgt.paras[u.tgtPara].text); return alts.some(a => text.includes(_fold(a))); };
    if (row.missing) {
      // A finding where none of them is in the paragraph's translation.
      if (!alts.length) continue;
      for (const idx of row.units) {
        const u = session.units[idx];
        if (!u || u.tgtPara === null || u.tgtPara === undefined) continue;
        if (shows(u)) continue;
        out.push({
          id: newFindingId('N'), module: 'names', source: 'ai', state: 'open', unit: u.idx, cat: 'NOM', sev: it.sev,
          quote: '', suggestion: alts[0], start: null, end: null,
          reason: (it.reason ? it.reason + ' ' : '') + 'En la traducci\u00f3n no aparece el nombre oficial de \u00ab' + row.src.split(' / ')[0] + '\u00bb.',
          quoteMasked: '', suggestionMasked: alts[0], model: (meta && meta.model) || '', role: 'triage'
        });
      }
      continue;
    }
    const e = session.ent.byKey.get(row.key);
    let made = 0;
    for (const [pid, occs] of session.ent.occ.tgt) {
      const u = unitOfTgt.get(pid);
      if (!u) continue;
      // A row paired by its paragraph: only there, and not when the official name is there after all
      // ("Naciones Unidas" inside "Voluntarios de las Naciones Unidas").
      if (row.loose && (!row.units.includes(u.idx) || shows(u))) continue;
      for (const o of occs) {
        if (o.key !== row.key || o.surface !== row.tgt || made >= 40) continue;
        made++;
        out.push({
          id: newFindingId('N'), module: 'names', source: 'ai', state: 'open', unit: u.idx, cat: 'NOM', sev: it.sev,
          quote: row.tgt, suggestion: it.suggestion || '', reason: it.reason || '', start: o.start, end: o.end,
          quoteMasked: e ? e.tagTgt : row.tgt, suggestionMasked: it.suggestion || '', model: (meta && meta.model) || '', role: 'triage'
        });
      }
    }
  }
  return out;
}
