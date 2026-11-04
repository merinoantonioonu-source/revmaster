/**
 * align-docs.js - Paragraph pairs between a source and a target document
 * model, for every format UMBRA reads:
 *
 *   alignDocs(src, tgt) -> { pairs: [ { src:[paraIds], tgt:[paraIds], score, sep? } ] }
 *
 * - The pairs follow the DOCUMENT ORDER of the target; a source paragraph with
 *   no counterpart (src only, tgt:[]) is placed right after the pair of the
 *   source paragraph that precedes it. Every paragraph of both models appears
 *   in exactly one pair.
 * - DOCX: built on alignModels (align.js, copied from COMeT Final Check): body
 *   paragraphs by DP, tables by rows and cell coordinates, footnotes by note.
 *   Endnotes are aligned here the same way footnotes are. When align.js maps
 *   several paragraphs of one side to a single one of the other (a paragraph
 *   split in translation), they form ONE pair (src:[a], tgt:[b, c]).
 * - PPTX: slide by slide when both decks have the same number of slides (the
 *   "Slide N" separators are paired with each other and marked sep:true);
 *   otherwise alignModels over the whole deck.
 * - XLSX: sheets by index (by name first when the counts differ), cells by
 *   reference ('B3'); score 1.
 *
 * score: 0..1 (1 = structural certainty), 0 for an unpaired paragraph.
 *
 * ASCII ONLY: non-ASCII characters in strings are written as \uXXXX escapes.
 */

import { alignModels, alignSequences } from './align.js';

// ------------------------------------------------------------------
// Groups and order
// ------------------------------------------------------------------

/** Connected components of the src<->tgt links, as { src:[ids], tgt:[ids], score }. */
function _groups(srcIds, tgtIds, links, scoreOf) {
  const parent = new Map();
  const find = (k) => {
    let r = k;
    while (parent.get(r) !== r) r = parent.get(r);
    let c = k;
    while (parent.get(c) !== r) { const n = parent.get(c); parent.set(c, r); c = n; }
    return r;
  };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(rb, ra); };
  for (const id of srcIds) parent.set('s' + id, 's' + id);
  for (const id of tgtIds) parent.set('t' + id, 't' + id);
  for (const [s, t] of links) {
    if (!parent.has('s' + s) || !parent.has('t' + t)) continue;
    union('s' + s, 't' + t);
  }
  const byRoot = new Map();
  const add = (key, side, id) => {
    const r = find(key);
    if (!byRoot.has(r)) byRoot.set(r, { src: [], tgt: [], score: 0 });
    byRoot.get(r)[side].push(id);
  };
  for (const id of srcIds) add('s' + id, 'src', id);
  for (const id of tgtIds) add('t' + id, 'tgt', id);
  const out = [];
  for (const g of byRoot.values()) {
    g.src.sort((a, b) => a - b);
    g.tgt.sort((a, b) => a - b);
    let best = 0;
    if (g.src.length && g.tgt.length) {
      for (const id of g.src) {
        const s = scoreOf(id);
        if (typeof s === 'number' && s > best) best = s;
      }
    }
    g.score = Math.round(Math.max(0, Math.min(1, best)) * 1000) / 1000;
    out.push(g);
  }
  return out;
}

/** Target document order, unpaired source groups interleaved where they fall. */
function _order(groups) {
  const withT = groups.filter(g => g.tgt.length).sort((a, b) => a.tgt[0] - b.tgt[0]);
  const srcOnly = groups.filter(g => !g.tgt.length).sort((a, b) => a.src[0] - b.src[0]);
  const srcPos = new Map();
  withT.forEach((g, i) => { for (const id of g.src) srcPos.set(id, i); });
  const anchored = Array.from(srcPos.keys()).sort((a, b) => a - b);
  const after = new Map();
  for (const g of srcOnly) {
    const first = g.src[0];
    // Largest paired source id below this one (binary search).
    let lo = 0, hi = anchored.length - 1, found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (anchored[mid] < first) { found = mid; lo = mid + 1; } else hi = mid - 1;
    }
    const pos = found >= 0 ? srcPos.get(anchored[found]) : -1;
    if (!after.has(pos)) after.set(pos, []);
    after.get(pos).push(g);
  }
  const out = [];
  for (const g of (after.get(-1) || [])) out.push(g);
  withT.forEach((g, i) => {
    out.push(g);
    for (const x of (after.get(i) || [])) out.push(x);
  });
  return out;
}

function _pairsOut(groups) {
  return groups.map(g => {
    const p = { src: g.src, tgt: g.tgt, score: g.score };
    if (g.sep) p.sep = true;
    return p;
  });
}

// ------------------------------------------------------------------
// DOCX / PPTX (alignModels)
// ------------------------------------------------------------------

/** Endnotes, aligned the way align.js aligns footnotes. */
function _alignEndnotes(src, tgt, record) {
  const sList = src.endnotes || [], tList = tgt.endnotes || [];
  if (!sList.length && !tList.length) return;
  const pseudo = (list) => list.map(n => ({ id: -1, text: n.text, isHeading: false, listLabel: null }));
  for (const mv of alignSequences(pseudo(sList), pseudo(tList))) {
    const sN = mv.srcIdx !== null ? sList[mv.srcIdx] : null;
    const tN = mv.tgtIdx !== null ? tList[mv.tgtIdx] : null;
    if (sN && tN) {
      const sParas = sN.paraIds.map(id => src.paras[id]);
      const tParas = tN.paraIds.map(id => tgt.paras[id]);
      for (const pmv of alignSequences(sParas, tParas)) {
        if (pmv.srcIdx !== null && pmv.tgtIdx !== null) {
          record(sParas[pmv.srcIdx].id, tParas[pmv.tgtIdx].id, pmv.score);
        }
      }
    }
  }
}

/** Links and scores of alignModels (plus endnotes) between two (sub)models. */
function _modelLinks(src, tgt) {
  const res = alignModels(src, tgt);
  const links = [];
  const scores = new Map(res.pairScores);
  for (const [s, t] of res.srcToTgt) if (t !== null && t !== undefined) links.push([s, t]);
  for (const [t, s] of res.tgtToSrc) if (s !== null && s !== undefined) links.push([s, t]);
  _alignEndnotes(src, tgt, (s, t, sc) => { links.push([s, t]); scores.set(s, sc); });
  return { links, scores };
}

function _alignWhole(src, tgt) {
  const { links, scores } = _modelLinks(src, tgt);
  const groups = _groups(src.paras.map(p => p.id), tgt.paras.map(p => p.id), links,
    (id) => scores.get(id));
  for (const g of groups) {
    const all = g.src.map(id => src.paras[id]).concat(g.tgt.map(id => tgt.paras[id]));
    if (all.length && all.every(p => p && p.isSlideSep)) g.sep = true;
  }
  return _order(groups);
}

/**
 * A model restricted to some paragraphs and tables: `paras` is a SPARSE array
 * indexed by paragraph id (align.js reads model.paras[id] and filters the
 * list, which skips the holes), so ids stay the real ones.
 */
function _subModel(model, paras, tables) {
  const sparse = [];
  for (const p of paras) sparse[p.id] = p;
  return { kind: model.kind, paras: sparse, tables, footnotes: [], endnotes: [] };
}

function _alignPptx(src, tgt) {
  const slidesOf = (m) => {
    const map = new Map();
    for (const p of m.paras) {
      const n = p.loc && p.loc.slide;
      if (!map.has(n)) map.set(n, { sep: null, paras: [], tables: [] });
      if (p.isSlideSep) map.get(n).sep = p;
      else map.get(n).paras.push(p);
    }
    for (const t of m.tables) {
      const n = t.slide;
      if (map.has(n)) map.get(n).tables.push(t);
    }
    return map;
  };
  const sS = slidesOf(src), tS = slidesOf(tgt);
  const sNums = Array.from(sS.keys()).sort((a, b) => a - b);
  const tNums = Array.from(tS.keys()).sort((a, b) => a - b);
  const sameShape = sNums.length === tNums.length && sNums.every((n, i) => n === tNums[i]) &&
    src.tables.every(t => t.slide !== undefined) && tgt.tables.every(t => t.slide !== undefined);
  if (!sameShape) return _alignWhole(src, tgt);

  const out = [];
  for (const n of tNums) {
    const a = sS.get(n), b = tS.get(n);
    if (a.sep && b.sep) out.push({ src: [a.sep.id], tgt: [b.sep.id], score: 1, sep: true });
    else {
      if (b.sep) out.push({ src: [], tgt: [b.sep.id], score: 0, sep: true });
      if (a.sep) out.push({ src: [a.sep.id], tgt: [], score: 0, sep: true });
    }
    const subS = _subModel(src, a.paras, a.tables);
    const subT = _subModel(tgt, b.paras, b.tables);
    const { links, scores } = _modelLinks(subS, subT);
    const groups = _groups(a.paras.map(p => p.id), b.paras.map(p => p.id), links,
      (id) => scores.get(id));
    for (const g of _order(groups)) out.push(g);
  }
  return out;
}

// ------------------------------------------------------------------
// XLSX (sheet + cell reference)
// ------------------------------------------------------------------

function _alignXlsx(src, tgt) {
  const sheetsOf = (m) => (m.tables || []).map((t, i) => ({ idx: i, name: t.sheet || '', table: t }));
  const sSheets = sheetsOf(src), tSheets = sheetsOf(tgt);
  const sheetPair = new Map();   // src table idx -> tgt table idx
  if (sSheets.length === tSheets.length) {
    for (let i = 0; i < sSheets.length; i++) sheetPair.set(i, i);
  } else {
    const usedT = new Set();
    for (const s of sSheets) {
      const t = tSheets.find(x => !usedT.has(x.idx) && x.name === s.name);
      if (t) { sheetPair.set(s.idx, t.idx); usedT.add(t.idx); }
    }
    const freeS = sSheets.filter(s => !sheetPair.has(s.idx));
    const freeT = tSheets.filter(t => !usedT.has(t.idx));
    for (let k = 0; k < Math.min(freeS.length, freeT.length); k++) sheetPair.set(freeS[k].idx, freeT[k].idx);
  }
  const tByKey = new Map();
  for (const p of tgt.paras) tByKey.set(p.loc.table + '!' + p.loc.cellRef, p.id);
  const links = [];
  for (const p of src.paras) {
    if (!sheetPair.has(p.loc.table)) continue;
    const t = tByKey.get(sheetPair.get(p.loc.table) + '!' + p.loc.cellRef);
    if (t !== undefined) links.push([p.id, t]);
  }
  const groups = _groups(src.paras.map(p => p.id), tgt.paras.map(p => p.id), links, () => 1);
  return _order(groups);
}

// ------------------------------------------------------------------
// Public API
// ------------------------------------------------------------------

/**
 * @param {Object} src  source document model (parse.js)
 * @param {Object} tgt  target document model
 * @returns {{ pairs: Array<{src:number[], tgt:number[], score:number, sep?:boolean}> }}
 */
export function alignDocs(src, tgt) {
  if (!src || !tgt) return { pairs: [] };
  let groups;
  if (src.kind === 'xlsx' || tgt.kind === 'xlsx') {
    if (src.kind !== tgt.kind) {
      // Different formats cannot be paired cell by cell: everything unpaired.
      groups = _order(_groups(src.paras.map(p => p.id), tgt.paras.map(p => p.id), [], () => 0));
    } else {
      groups = _alignXlsx(src, tgt);
    }
  } else if (src.kind === 'pptx' && tgt.kind === 'pptx') {
    groups = _alignPptx(src, tgt);
  } else {
    groups = _alignWhole(src, tgt);
  }
  return { pairs: _pairsOut(groups) };
}
