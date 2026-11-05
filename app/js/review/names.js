/**
 * names.js - The "Nombres oficiales" module: the table of institutional names of the document (each
 * masked organization, organ, title, country or place, with its forms in the original and the
 * translation) and the findings that come back for it.
 *
 * Only that table goes to the AI (gateway.callAINames validates it): no text of the document, no
 * persons, figures, dates, symbols, URLs or confidential terms of the user.
 */

import { newFindingId } from './findings.js';

export const NAME_CATS = ['ORG', 'ORGANO', 'CARGO', 'PAIS', 'LUGAR'];

/** -> [{ n, key, cat, src: 'form / form', tgt: 'form', count }] one row per form of the translation. */
export function namesRows(session) {
  const rows = [];
  for (const e of session.ent.entities) {
    if (!NAME_CATS.includes(e.cat)) continue;
    const src = Object.keys(e.srcForms), tgt = Object.keys(e.tgtForms);
    if (!src.length || !tgt.length) continue;   // a name on one side only is a masking matter (Sin pareja)
    for (const t of tgt) rows.push({ n: rows.length + 1, key: e.key, cat: e.cat, src: src.join(' / '), tgt: t, count: e.tgtForms[t] });
  }
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
    const e = session.ent.byKey.get(row.key);
    let made = 0;
    for (const [pid, occs] of session.ent.occ.tgt) {
      const u = unitOfTgt.get(pid);
      if (!u) continue;
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
