/**
 * findings.js - Turning AI answers into findings anchored in the REAL text, and applying the accepted
 * ones.
 *
 * AI answers quote the MASKED target; anchorItem() finds the quote in the masked paragraph, converts
 * the offsets to the original paragraph (entities.maskedToOriginal) and rehydrates quote and
 * suggestion (tags -> real forms).
 */

import { maskedToOriginal, rehydrate } from '../redact/entities.js';
import { CAT_MODULE } from './prompts.js';

let _seq = 0;
export function newFindingId(prefix) { return (prefix || 'F') + Date.now().toString(36) + (_seq++).toString(36); }

function _norm(s) {
  return String(s || '').replace(/[\u2018\u2019\u02bc]/g, "'").replace(/[\u201c\u201d\u00ab\u00bb]/g, '"')
    .replace(/[\u00a0\u202f\t]/g, ' ');
}

/** Index of `quote` in `text`: exact, then normalized, then case-insensitive, then a trimmed core. */
export function locate(text, quote) {
  if (!quote) return -1;
  let i = text.indexOf(quote);
  if (i >= 0) return { start: i, end: i + quote.length };
  const nt = _norm(text), nq = _norm(quote).replace(/\s+/g, ' ').trim();
  i = nt.indexOf(nq);
  if (i >= 0) return { start: i, end: i + nq.length };
  i = nt.toLowerCase().indexOf(nq.toLowerCase());
  if (i >= 0) return { start: i, end: i + nq.length };
  // Whitespace-insensitive search.
  const re = new RegExp(nq.split(/\s+/).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'), 'i');
  const m = re.exec(nt);
  if (m) return { start: m.index, end: m.index + m[0].length };
  // The model trimmed or extended the quote: try its longest word run of 3+ words.
  const words = nq.split(/\s+/);
  for (let len = words.length - 1; len >= 2; len--) {
    for (let s = 0; s + len <= words.length; s++) {
      const part = words.slice(s, s + len).join(' ');
      if (part.length < 8) continue;
      const k = nt.toLowerCase().indexOf(part.toLowerCase());
      if (k >= 0) return { start: k, end: k + part.length, partial: true };
    }
  }
  return -1;
}

/**
 * item (parsed line) -> finding. ctx = { session, unitByN, module, source, model }
 */
export function anchorItem(item, ctx) {
  const { session } = ctx;
  const u = ctx.unitByN.get(item.unit);
  if (!u) return null;
  const module = ctx.module || CAT_MODULE[item.cat] || 'fidelity';
  const f = {
    id: newFindingId(ctx.source === 'external' ? 'X' : 'A'), module, source: ctx.source || 'ai', state: 'open',
    unit: u.idx, side: 'tgt', cat: item.cat, sev: item.sev, start: null, end: null,
    quoteMasked: item.quote, suggestionMasked: item.suggestion,
    quote: rehydrate(item.quote, session.byTag, 'tgt'),
    suggestion: rehydrate(item.suggestion, session.byTag, 'tgt'),
    reason: rehydrate(item.reason, session.byTag, 'tgt'),
    model: ctx.model || '', role: ctx.role || ''
  };
  if (u.tgtPara !== null && item.quote) {
    const m = session.masked.tgt.get(u.tgtPara);
    const hit = locate(m.masked, item.quote);
    if (hit !== -1) {
      f.start = maskedToOriginal(m.map, hit.start, 'start');
      f.end = maskedToOriginal(m.map, hit.end, 'end');
      f.quote = session.tgt.paras[u.tgtPara].text.slice(f.start, f.end);
      if (hit.partial) f.partial = true;
    } else {
      f.unanchored = true;
    }
  }
  return f;
}

/** Same unit, module and (normalized) quote/reason = same finding. */
export function sameFinding(a, b) {
  return a.unit === b.unit && a.module === b.module && a.cat === b.cat &&
    _norm(a.quote).trim().toLowerCase() === _norm(b.quote).trim().toLowerCase() &&
    (a.quote || _norm(a.reason).slice(0, 40) === _norm(b.reason).slice(0, 40));
}

/** Parses "tras \u00abX\u00bb: Y" (omission suggestions) -> { after:'X', insert:'Y' } */
export function parseInsertion(s) {
  const m = /^(?:tras|despu[e\u00e9]s de|after)\s+[\u00ab"\u201c](.+?)[\u00bb"\u201d]\s*[:\-]\s*(.+)$/i.exec(String(s || '').trim());
  return m ? { after: m[1], insert: m[2] } : null;
}

/**
 * New texts of the target paragraphs after applying the ACCEPTED findings.
 * Returns { texts: Map(tgtParaId -> newText), applied:[ids], skipped:[{id, why}] }
 */
export function applyAccepted(session, findings) {
  const byPara = new Map();
  const skipped = [];
  for (const f of findings) {
    if (f.state !== 'accepted') continue;
    const u = session.units[f.unit];
    if (!u || u.tgtPara === null) { skipped.push({ id: f.id, why: 'Sin p\u00e1rrafo de destino.' }); continue; }
    const text = session.tgt.paras[u.tgtPara].text;
    let start = f.start, end = f.end, repl = (f.edited !== undefined && f.edited !== null) ? f.edited : f.suggestion;
    if ((start === null || start === undefined) && !f.quote) {
      const ins = parseInsertion(repl);
      if (ins) {
        const k = text.indexOf(ins.after);
        if (k >= 0) { start = end = k + ins.after.length; repl = (/^[\s,;.]/.test(ins.insert) ? '' : ' ') + ins.insert; }
      }
    }
    if (start === null || start === undefined || end === null || end === undefined) {
      skipped.push({ id: f.id, why: 'No se sabe d\u00f3nde aplicarlo: queda como comentario.' });
      continue;
    }
    if (!byPara.has(u.tgtPara)) byPara.set(u.tgtPara, []);
    byPara.get(u.tgtPara).push({ id: f.id, start, end, repl: repl || '' });
  }
  const texts = new Map();
  const applied = [];
  for (const [pid, list] of byPara) {
    let text = session.tgt.paras[pid].text;
    list.sort((a, b) => b.start - a.start || b.end - a.end);
    let lastStart = Infinity;
    for (const c of list) {
      if (c.end > lastStart) { skipped.push({ id: c.id, why: 'Se solapa con otra correcci\u00f3n aceptada.' }); continue; }
      text = text.slice(0, c.start) + c.repl + text.slice(c.end);
      lastStart = c.start;
      applied.push(c.id);
    }
    texts.set(pid, text);
  }
  return { texts, applied, skipped };
}

export const STATE_LABELS = { open: 'Pendiente', accepted: 'Aceptado', rejected: 'Rechazado', ignored: 'Ignorado', discarded: 'Descartado por el verificador' };
