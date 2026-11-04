/**
 * session.js - Everything derived from the two loaded documents that the masking and review screens
 * share: the aligned UNITS, their structure (lists, table columns, headings, resolution parts), the
 * entities and the masked texts.
 *
 * A unit is one aligned pair of paragraphs (either side may be missing):
 *   { idx, n (1-based number shown to the AI), srcPara, tgtPara, sep, kind:'h'|'li'|'cell'|'p'|'sep',
 *     group (siblings key for parallelism or null), part:'pre'|'op'|null (resolutions), section }
 */

import { computeEntities, maskText, entitiesByTagMap } from '../redact/entities.js';

const LIST_LABEL_RE = /^[\s\t]*(?:\(?[a-z]{1,2}\)|\(?[ivxlc]{1,6}\)|\(?\d{1,3}[.)]|[\u2022\u2013\u2014\u25aa\u25cf\-*])[\s\t]+/i;

export function listLabelOf(text) {
  const m = LIST_LABEL_RE.exec(text || '');
  return m ? m[0] : '';
}

function _isList(p) {
  return !!(p && (p.listPrefix || p.listLabel || LIST_LABEL_RE.test(p.text || '')));
}

/**
 * build({ src, tgt, alignment, srcLang, mask, gazetteer, dict }) -> session
 */
export function buildSession(input) {
  const { src, tgt, alignment } = input;
  const units = [];
  let section = 0;
  for (const pair of alignment.pairs) {
    const sp = pair.src.length ? pair.src[0] : null;
    const tp = pair.tgt.length ? pair.tgt[0] : null;
    const sPara = sp !== null ? src.paras[sp] : null;
    const tPara = tp !== null ? tgt.paras[tp] : null;
    const any = tPara || sPara;
    const sep = !!(pair.sep || (any && (any.isSlideSep)));
    let kind = 'p';
    if (sep) kind = 'sep';
    else if (any && any.isHeading) kind = 'h';
    else if (any && any.loc && any.loc.table !== null && any.loc.table !== undefined) kind = 'cell';
    else if (_isList(tPara) || _isList(sPara)) kind = 'li';
    if (kind === 'h' || kind === 'sep') section++;
    units.push({ idx: units.length, n: units.length + 1, srcPara: sp, tgtPara: tp, sep, kind, group: null, part: null, section });
  }
  _groups(units, src, tgt);
  _resolutionParts(units, src, tgt);
  const session = { src, tgt, units, srcLang: input.srcLang || 'en' };
  remask(session, input);
  return session;
}

// Siblings: consecutive list items (same section), the cells of one table column (rows after the
// first), and headings of the document.
function _groups(units, src, tgt) {
  let gi = 0;
  let cur = null;
  let curType = null;
  for (const u of units) {
    if (u.kind === 'li') {
      // A change of numbering style (1. -> a) -> (i) -> bullet) starts another list.
      const type = _labelType(u, src, tgt);
      if (!cur || type !== curType) { cur = 'L' + (gi++); curType = type; }
      u.group = cur;
    } else if (u.kind !== 'sep' && !(u.kind === 'p' && !_text(u, src, tgt).trim())) {
      cur = null;
    }
    if (u.kind === 'cell') {
      const p = (u.tgtPara !== null ? tgt.paras[u.tgtPara] : src.paras[u.srcPara]);
      if (p && p.loc && p.loc.row > 0 && !p.numeric) u.group = 'T' + p.loc.table + 'C' + p.loc.col;
    }
    if (u.kind === 'h') u.group = 'H';
  }
  // A group of one is no group.
  const count = {};
  for (const u of units) if (u.group) count[u.group] = (count[u.group] || 0) + 1;
  for (const u of units) if (u.group && count[u.group] < 3) u.group = null;
}

function _labelType(u, src, tgt) {
  const p = u.tgtPara !== null ? tgt.paras[u.tgtPara] : src.paras[u.srcPara];
  const lab = (p && (p.listPrefix || p.listLabel || listLabelOf(p.text))) || '';
  const t = String(lab).trim().replace(/^\(/, '');
  if (/^\d/.test(t)) return 'num';
  if (/^(?:i{1,3}|iv|v|vi{1,3}|ix|x)[.)]/i.test(t)) return 'roman';
  if (/^[a-z]{1,2}[.)]/i.test(t)) return 'alpha';
  return 'bullet';
}

function _text(u, src, tgt) {
  const p = u.tgtPara !== null ? tgt.paras[u.tgtPara] : (u.srcPara !== null ? src.paras[u.srcPara] : null);
  return p ? p.text : '';
}

// Resolutions: preambular paragraphs (start with an italic word, end with a comma) and operative
// paragraphs (a number, then an italic verb). Decided on the SOURCE when available.
function _resolutionParts(units, src, tgt) {
  for (const u of units) {
    if (u.kind !== 'p' && u.kind !== 'li') continue;
    const p = u.srcPara !== null ? src.paras[u.srcPara] : (u.tgtPara !== null ? tgt.paras[u.tgtPara] : null);
    if (!p || !p.text) continue;
    const t = p.text.trim();
    const firstRun = (p.runs || []).find(r => r.t && r.t.trim());
    const italicStart = !!(firstRun && firstRun.i);
    if (/^\d{1,3}\.[\s\t]/.test(t) || (p.listPrefix && /^\d/.test(p.listPrefix))) {
      const runs = (p.runs || []).filter(r => r.t && r.t.trim());
      const verbRun = /^\d{1,3}\.[\s\t]/.test(t) ? runs.find(r => /[A-Za-z\u00c0-\u024f]/.test(r.t)) : runs[0];
      if (verbRun && verbRun.i) u.part = 'op';
    } else if (italicStart && /,\s*$/.test(t)) {
      u.part = 'pre';
    } else if (italicStart && /[;.:]\s*$/.test(t)) {
      // Operative paragraphs without an automatic number (a verb in italics, ending in ';' or '.').
      u.part = 'op';
    }
  }
}

/** Recomputes entities and masked texts (after any masking adjustment). */
export function remask(session, input) {
  const ent = computeEntities({
    units: session.units, src: session.src, tgt: session.tgt, srcLang: session.srcLang,
    mask: input.mask, gazetteer: input.gazetteer, dict: input.dict
  });
  session.ent = ent;
  session.byTag = entitiesByTagMap(ent.entities);
  session.masked = { src: new Map(), tgt: new Map() };
  for (const u of session.units) {
    if (u.srcPara !== null) {
      const t = session.src.paras[u.srcPara].text;
      session.masked.src.set(u.srcPara, maskText(t, ent.occ.src.get(u.srcPara) || [], 'src', ent.byKey));
    }
    if (u.tgtPara !== null) {
      const t = session.tgt.paras[u.tgtPara].text;
      session.masked.tgt.set(u.tgtPara, maskText(t, ent.occ.tgt.get(u.tgtPara) || [], 'tgt', ent.byKey));
    }
  }
  return session;
}

export function unitSrc(session, u) { return u.srcPara !== null ? session.src.paras[u.srcPara].text : ''; }
export function unitTgt(session, u) { return u.tgtPara !== null ? session.tgt.paras[u.tgtPara].text : ''; }
export function unitSrcMasked(session, u) { return u.srcPara !== null ? session.masked.src.get(u.srcPara).masked : ''; }
export function unitTgtMasked(session, u) { return u.tgtPara !== null ? session.masked.tgt.get(u.tgtPara).masked : ''; }

/** Units that carry text worth reviewing. */
export function reviewableUnits(session) {
  return session.units.filter(u => !u.sep && (unitTgt(session, u).trim() || unitSrc(session, u).trim()));
}
