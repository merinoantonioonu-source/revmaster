/**
 * nav.js - Segment navigation between the two sheets, emulating COMeT Final Check (copied behaviour,
 * new code; COMeT is not imported):
 *
 *  - A segment is a SENTENCE of a paragraph (SRX segmenter, EN/FR for the original, ES for the
 *    translation). Paragraphs are paired by the session units; the sentences of a pair are paired by
 *    position, and only when both paragraphs have the same number of sentences. Otherwise the other
 *    side is marked at paragraph level.
 *  - The selection is painted with the CSS Custom Highlight API: ::highlight(um-seg) (soft yellow,
 *    steady, no blinking) and ::highlight(um-focus) for the exact text of a finding. The paragraph
 *    fallback is the steady class .flash.
 *  - Clicking a sentence never moves the clicked sheet: the OTHER sheet scrolls so the counterpart sits
 *    at the same height. Going to a finding or a place from a list centres both sheets.
 *  - Hovering a paragraph outlines its counterpart; Left/Right arrows step through the sentences.
 *
 * Offsets are those of para.text: ui/preview.js stores them on the rendered nodes (__o, __e).
 */

import { SrxSegmenter } from '../core/srx-segmenter.js';

// ------------------------------------------------------------------ sentences

const _segmenters = {};
function _segmenter(lang) {
  const k = String(lang || 'EN').toUpperCase();
  return _segmenters[k] || (_segmenters[k] = new SrxSegmenter(k));
}

const _cache = new Map();

/** Sentences of a text as offsets: [{ start, end }]. */
export function sentenceSpans(text, lang) {
  const t = String(text || '');
  const key = lang + '\u0001' + t;
  const hit = _cache.get(key);
  if (hit) return hit;
  const out = [];
  let i = 0;
  // The segmenter collapses white space: walk the original text in step with each segment.
  for (const seg of _segmenter(lang).segment(t)) {
    while (i < t.length && /\s/.test(t[i])) i++;
    const start = i;
    let j = 0;
    while (j < seg.length && i < t.length) {
      if (seg[j] === ' ' && /\s/.test(t[i])) { while (i < t.length && /\s/.test(t[i])) i++; j++; } else { i++; j++; }
    }
    if (i > start) out.push({ start, end: i });
  }
  if (!out.length && t.trim()) out.push({ start: 0, end: t.length });
  if (_cache.size > 5000) _cache.clear();
  _cache.set(key, out);
  return out;
}

/** Index of the sentence that holds `offset` (a position between two sentences goes to the next). */
export function sentenceAt(spans, offset) {
  if (!spans.length) return -1;
  for (let i = 0; i < spans.length; i++) if (offset < spans[i].end) return i;
  return spans.length - 1;
}

export function langOf(session, side) { return side === 'src' ? (session.srcLang === 'fr' ? 'FR' : 'EN') : 'ES'; }

export function paraText(session, side, pid) {
  const m = side === 'src' ? session.src : session.tgt;
  const p = m && pid !== null && pid !== undefined ? m.paras[pid] : null;
  return p ? (p.text || '') : '';
}

export function sentencesOf(session, side, pid) { return sentenceSpans(paraText(session, side, pid), langOf(session, side)); }

function _maps(session) {
  if (session.__navMaps && session.__navMaps.units === session.units) return session.__navMaps;
  const src = new Map(), tgt = new Map();
  for (const u of session.units) {
    if (u.srcPara !== null && u.srcPara !== undefined && !src.has(u.srcPara)) src.set(u.srcPara, u);
    if (u.tgtPara !== null && u.tgtPara !== undefined && !tgt.has(u.tgtPara)) tgt.set(u.tgtPara, u);
  }
  session.__navMaps = { units: session.units, src, tgt };
  return session.__navMaps;
}

export function unitOf(session, side, pid) { return _maps(session)[side].get(pid) || null; }

export function peerPid(session, side, pid) {
  const u = unitOf(session, side, pid);
  if (!u) return null;
  const o = side === 'src' ? u.tgtPara : u.srcPara;
  return o === undefined ? null : o;
}

/**
 * Sentence alignment of a paragraph pair -> for each sentence of `side`, the indexes of its
 * counterpart(s) on the other side ([] = no counterpart). Same number of sentences: one to one, by
 * position (as Final Check). Otherwise a small dynamic programme (1-1, 1-2, 2-1, 1-0, 0-1) on the
 * lengths, with the entities (tags) shared by the two sentences as anchors.
 */
export function alignSentences(session, side, pid, opid) {
  const other = side === 'src' ? 'tgt' : 'src';
  const A = sentencesOf(session, side, pid), B = sentencesOf(session, other, opid);
  if (!session.__navAlign || session.__navAlign.units !== session.units) session.__navAlign = { units: session.units, map: new Map() };
  const ck = side + ':' + pid + '|' + opid + '|' + A.length + ':' + B.length;
  const hit = session.__navAlign.map.get(ck);
  if (hit) return hit;
  let out;
  if (A.length === B.length) out = A.map((_, i) => [i]);
  else if (!A.length || !B.length) out = A.map(() => []);
  else {
    const keysIn = (sd, p, spans) => spans.map(sp => {
      const set = new Set();
      const occ = session.ent && session.ent.occ && session.ent.occ[sd] ? (session.ent.occ[sd].get(p) || []) : [];
      for (const o of occ) if (o.start >= sp.start && o.start < sp.end) set.add(o.key);
      return set;
    });
    const ka = keysIn(side, pid, A), kb = keysIn(other, opid, B);
    const la = A.map(x => x.end - x.start), lb = B.map(x => x.end - x.start);
    const ratio = (lb.reduce((x, y) => x + y, 0) + 1) / (la.reduce((x, y) => x + y, 0) + 1);
    const sum = (arr, i0, i1) => { let t = 0; for (let i = i0; i < i1; i++) t += arr[i]; return t; };
    const union = (arr, i0, i1) => { const u = new Set(); for (let i = i0; i < i1; i++) for (const k of arr[i]) u.add(k); return u; };
    const cost = (i0, i1, j0, j1) => {
      if (i1 === i0 || j1 === j0) return 3.5;   // a sentence without counterpart
      const a = sum(la, i0, i1) * ratio, b = sum(lb, j0, j1);
      let c = Math.abs(Math.log((b + 1) / (a + 1))) * 3 + ((i1 - i0) + (j1 - j0) > 2 ? 0.7 : 0);
      const sa = union(ka, i0, i1), sb = union(kb, j0, j1);
      let shared = 0;
      for (const k of sa) if (sb.has(k)) shared++;
      c += ((sa.size - shared) + (sb.size - shared)) * 0.6 - shared * 1.5;
      return c;
    };
    const n = A.length, m = B.length, INF = 1e9;
    const D = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(INF));
    const P = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(null));
    D[0][0] = 0;
    const moves = [[1, 1], [1, 2], [2, 1], [1, 0], [0, 1]];
    for (let i = 0; i <= n; i++) for (let j = 0; j <= m; j++) {
      if (D[i][j] >= INF) continue;
      for (const [di, dj] of moves) {
        const ni = i + di, nj = j + dj;
        if (ni > n || nj > m) continue;
        const c = D[i][j] + cost(i, ni, j, nj);
        if (c < D[ni][nj]) { D[ni][nj] = c; P[ni][nj] = [i, j]; }
      }
    }
    out = A.map(() => []);
    let i = n, j = m;
    while (i > 0 || j > 0) {
      const pr = P[i][j];
      if (!pr) break;
      for (let x = pr[0]; x < i; x++) for (let y = pr[1]; y < j; y++) out[x].push(y);
      i = pr[0]; j = pr[1];
    }
    for (const l of out) l.sort((x, y) => x - y);
  }
  session.__navAlign.map.set(ck, out);
  return out;
}

/** The counterpart of sentence `index` -> { pid, list:[indexes] } ([] = only the paragraph is known),
 *  or null when the paragraph has no counterpart at all. */
export function sentencePeers(session, side, pid, index) {
  const other = side === 'src' ? 'tgt' : 'src';
  const opid = peerPid(session, side, pid);
  if (opid === null) return null;
  if (index === null || index === undefined || index < 0) return { pid: opid, list: [] };
  const al = alignSentences(session, side, pid, opid);
  return { pid: opid, list: (al[index] || []).filter(i => i < sentencesOf(session, other, opid).length) };
}

/** Compatibility: the first counterpart sentence -> { pid, index|null }. */
export function peerSentence(session, side, pid, index) {
  const p = sentencePeers(session, side, pid, index);
  return p ? { pid: p.pid, index: p.list.length ? p.list[0] : null } : null;
}

/** For a unit without a paragraph on `side` (text added or left out): the closest paragraph of that
 *  side, looking back first (as Final Check), then forward. */
export function nearestPara(session, side, unitIdx) {
  const key = side === 'src' ? 'srcPara' : 'tgtPara';
  for (let d = 1; d <= 30; d++) {
    for (const k of [unitIdx - d, unitIdx + d]) {
      const u = session.units[k];
      if (u && u[key] !== null && u[key] !== undefined) return u[key];
    }
  }
  return null;
}

/**
 * Where a finding is, at sentence level, on both sides:
 * -> { unit, tgtPid, tgtIndex, srcPid, srcIndex, label:'12.2', src, tgt (real texts), srcOff, tgtOff
 *      (where those texts start in their paragraphs) }.
 */
export function findingPlace(session, f) {
  const u = session.units[f.unit];
  if (!u) return null;
  const out = { unit: u.idx, tgtPid: u.tgtPara, srcPid: u.srcPara, tgtIndex: null, srcIndex: null, label: String(u.n) };
  let tgtList = null, srcList = null;
  if (u.tgtPara !== null && u.tgtPara !== undefined && f.start !== null && f.start !== undefined) {
    out.tgtIndex = sentenceAt(sentencesOf(session, 'tgt', u.tgtPara), f.start);
    const peer = sentencePeers(session, 'tgt', u.tgtPara, out.tgtIndex);
    if (peer && peer.list.length) { srcList = peer.list; out.srcIndex = peer.list[0]; }
  } else if (u.srcPara !== null && u.srcPara !== undefined && f.srcStart !== null && f.srcStart !== undefined) {
    out.srcIndex = sentenceAt(sentencesOf(session, 'src', u.srcPara), f.srcStart);
    const peer = sentencePeers(session, 'src', u.srcPara, out.srcIndex);
    if (peer && peer.list.length) { tgtList = peer.list; out.tgtIndex = peer.list[0]; }
  }
  const idx = out.tgtIndex !== null ? out.tgtIndex : out.srcIndex;
  if (idx !== null && idx >= 0) out.label = u.n + '.' + (idx + 1);
  // The text of the sentence(s) (or of the whole paragraph) and where it starts in the paragraph.
  const cut = (side, pid, list) => {
    const text = paraText(session, side, pid);
    const spans = sentencesOf(session, side, pid);
    const sel = (list || []).map(i => spans[i]).filter(Boolean);
    if (!sel.length) return { text, off: 0 };
    const a = Math.min(...sel.map(x => x.start)), b = Math.max(...sel.map(x => x.end));
    return { text: text.slice(a, b), off: a };
  };
  const t = (u.tgtPara !== null && u.tgtPara !== undefined) ? cut('tgt', u.tgtPara, tgtList || (out.tgtIndex !== null ? [out.tgtIndex] : null)) : { text: '', off: 0 };
  const so = (u.srcPara !== null && u.srcPara !== undefined) ? cut('src', u.srcPara, srcList || (out.srcIndex !== null ? [out.srcIndex] : null)) : { text: '', off: 0 };
  out.tgt = t.text; out.tgtOff = t.off;
  out.src = so.text; out.srcOff = so.off;
  return out;
}

// ------------------------------------------------------------------ DOM <-> offsets

function _before(n) { return { node: n.parentNode, offset: Array.prototype.indexOf.call(n.parentNode.childNodes, n) }; }
function _after(n) { const b = _before(n); b.offset++; return b; }

/** DOM position of a para.text offset inside a rendered paragraph. edge: 'start' | 'end'. */
export function domPos(paraEl, offset, edge) {
  const w = document.createTreeWalker(paraEl, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  let n, last = null;
  while ((n = w.nextNode())) {
    if (n.nodeType === 3) {
      if (n.__o === undefined) continue;
      const len = n.nodeValue.length;
      if (offset >= n.__o && offset <= n.__o + len) {
        if (offset === n.__o + len && edge === 'start') { last = { node: n, offset: len }; continue; }
        return { node: n, offset: offset - n.__o };
      }
      if (n.__o > offset) return last || { node: n, offset: 0 };
      last = { node: n, offset: len };
    } else if (n.__o !== undefined) {
      if (offset >= n.__o && offset < n.__e) return edge === 'end' ? _after(n) : _before(n);
      if (offset === n.__e) { if (edge === 'end') return _after(n); last = _after(n); }
      if (n.__o > offset) return last || _before(n);
    }
  }
  return last;
}

export function rangeOf(paraEl, start, end) {
  if (!paraEl) return null;
  const a = domPos(paraEl, start, 'start'), b = domPos(paraEl, end, 'end');
  if (!a || !b) return null;
  const r = document.createRange();
  try { r.setStart(a.node, a.offset); r.setEnd(b.node, b.offset); } catch (_) { return null; }
  return r.collapsed ? null : r;
}

/** para.text offset under a click (null when it cannot be told). */
export function offsetAt(ev, paraEl) {
  for (let x = ev.target; x && x !== paraEl; x = x.parentNode) if (x.__o !== undefined && x.nodeType === 1) return x.__o;
  let node = null, off = 0;
  if (document.caretRangeFromPoint) {
    const r = document.caretRangeFromPoint(ev.clientX, ev.clientY);
    if (r) { node = r.startContainer; off = r.startOffset; }
  } else if (document.caretPositionFromPoint) {
    const p = document.caretPositionFromPoint(ev.clientX, ev.clientY);
    if (p) { node = p.offsetNode; off = p.offset; }
  }
  if (!node || !paraEl.contains(node)) return null;
  if (node.nodeType === 3 && node.__o !== undefined) return node.__o + off;
  for (let x = node; x && x !== paraEl; x = x.parentNode) if (x.__o !== undefined && x.nodeType === 1) return x.__o;
  // Between nodes: the first offset-carrying node after the caret.
  const w = document.createTreeWalker(paraEl, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  const start = node.nodeType === 1 ? (node.childNodes[off] || null) : node;
  let n, seen = !start;
  while ((n = w.nextNode())) {
    if (!seen) { if (n === start || (start && start.contains && start.contains(n))) seen = true; else continue; }
    if (n.__o !== undefined) return n.__o;
  }
  return null;
}

// ------------------------------------------------------------------ painting

const HL = typeof CSS !== 'undefined' && !!CSS.highlights && typeof Highlight !== 'undefined';

export function paint(name, ranges, priority) {
  if (!HL) return false;
  CSS.highlights.delete(name);
  const rs = (ranges || []).filter(Boolean);
  if (!rs.length) return true;
  const h = new Highlight(...rs);
  if (priority !== undefined) h.priority = priority;
  CSS.highlights.set(name, h);
  return true;
}

export function clearPaint() { if (HL) { CSS.highlights.delete('um-seg'); CSS.highlights.delete('um-focus'); } }

function _rect(x) { return x && x.getBoundingClientRect ? x.getBoundingClientRect() : null; }

/** Scroll `targetPane` so `target` sits at the same height as `anchor` in `anchorPane`. */
export function alignOther(anchor, anchorPane, target, targetPane) {
  const ar = _rect(anchor), tr = _rect(target);
  if (!ar || !tr) return;
  const delta = (tr.top - targetPane.getBoundingClientRect().top) - (ar.top - anchorPane.getBoundingClientRect().top);
  if (Math.abs(delta) < 1) return;
  targetPane.scrollTo({ top: targetPane.scrollTop + delta, behavior: 'smooth' });
}

export function centerIn(pane, target) {
  const r = _rect(target);
  if (!r) return;
  const h = pane.getBoundingClientRect();
  let delta = (r.top + r.height / 2) - (h.top + h.height / 2);
  if (r.height > h.height - 80) delta = r.top - (h.top + 40);
  if (Math.abs(delta) < 2) return;
  pane.scrollTo({ top: pane.scrollTop + delta, behavior: 'smooth' });
}

/** Minimal scroll: only when the target is not comfortably visible. */
export function revealIn(pane, target, margin) {
  const r = _rect(target);
  if (!r) return false;
  const h = pane.getBoundingClientRect(), m = margin === undefined ? 40 : margin;
  let delta = 0;
  if (r.height > h.height - 2 * m) delta = r.top - (h.top + m);
  else if (r.top < h.top + m) delta = r.top - (h.top + m);
  else if (r.bottom > h.bottom - m) delta = r.bottom - (h.bottom - m);
  if (Math.abs(delta) < 1) return false;
  pane.scrollTo({ top: pane.scrollTop + delta, behavior: 'smooth' });
  return true;
}

// ------------------------------------------------------------------ the controller of one view

/**
 * createNav({ panes:{src,tgt}, session: () => session, onSelect(sel) }) -> controller.
 * sel = { side, pid, index } of the sentence that was marked last.
 * In the masking view the tags carry data-key: the entity being looked at gets the class "hot" (red
 * glow), so it can be found inside a long sentence.
 */
export function createNav(opts) {
  const o = opts || {};
  const panes = o.panes;
  const st = { sel: null, focus: null, unit: null };
  const other = (side) => side === 'src' ? 'tgt' : 'src';
  const paraEl = (side, pid) => (pid === null || pid === undefined) ? null : panes[side].querySelector('.p[data-pid="' + pid + '"]');

  function _flash(els) {
    for (const side of ['src', 'tgt']) for (const x of panes[side].querySelectorAll('.p.flash')) x.classList.remove('flash');
    for (const e of els) if (e) e.classList.add('flash');
  }

  function _hot(key, paras) {
    for (const side of ['src', 'tgt']) for (const x of panes[side].querySelectorAll('.hot')) x.classList.remove('hot');
    if (!key) return;
    const sel = '[data-key="' + (window.CSS && CSS.escape ? CSS.escape(key) : key) + '"]';
    for (const p of paras) if (p) for (const x of p.querySelectorAll(sel)) x.classList.add('hot');
  }

  function _ranges(side, pid, list) {
    const s = o.session();
    const spans = sentencesOf(s, side, pid);
    const pe = paraEl(side, pid);
    return (list || []).map(i => spans[i] ? rangeOf(pe, spans[i].start, spans[i].end) : null).filter(Boolean);
  }

  /** The other side of a sentence: its sentence(s), else its paragraph, else the nearest paragraph. */
  function _peerOf(side, pid, index) {
    const s = o.session();
    const os = other(side);
    const peer = sentencePeers(s, side, pid, index);
    if (peer) return { pid: peer.pid, ranges: _ranges(os, peer.pid, peer.list), el: paraEl(os, peer.pid), approx: false };
    const u = unitOf(s, side, pid);
    const near = u ? nearestPara(s, os, u.idx) : null;
    return { pid: near, ranges: [], el: paraEl(os, near), approx: true };
  }

  /** Marks sentence `index` of a paragraph and its counterpart. how: 'align' | 'center' | 'reveal' | null */
  function markSentence(side, pid, index, how) {
    const s = o.session();
    if (!s) return null;
    const mineEl = paraEl(side, pid);
    const mine = index !== null && index >= 0 ? _ranges(side, pid, [index]) : [];
    const peer = _peerOf(side, pid, index);
    const painted = paint('um-seg', mine.concat(peer.ranges), -1);
    // Paragraph level where the sentence cannot be marked (or the browser has no highlights).
    _flash([(!painted || !mine.length) ? mineEl : null, peer.el && (!painted || !peer.ranges.length) ? peer.el : null]);
    st.sel = { side, pid, index };
    st.unit = null;
    const a = mine[0] || mineEl, b = peer.ranges[0] || peer.el;
    if (how === 'align' && a && b) alignOther(a, panes[side], b, panes[other(side)]);
    else if (how === 'center') { if (a) centerIn(panes[side], a); if (b) centerIn(panes[other(side)], b); }
    else if (how === 'reveal' && a) {
      const moved = revealIn(panes[side], a);
      if (b) { if (moved) setTimeout(() => alignOther(a, panes[side], b, panes[other(side)]), 320); else revealIn(panes[other(side)], b); }
    }
    if (o.onSelect) o.onSelect(st.sel);
    return { mine: mine[0] || null, peerRange: peer.ranges[0] || null, mineEl, peerEl: peer.el };
  }

  /** A click in a sheet: marks the sentence under the pointer and its pair. */
  function clickAt(side, ev) {
    const pe = ev.target.closest && ev.target.closest('.p[data-pid]');
    if (!pe || !panes[side].contains(pe)) return null;
    const pid = +pe.dataset.pid;
    const s = o.session();
    const off = offsetAt(ev, pe);
    paint('um-focus', []);
    _hot(null, []);
    st.focus = null;
    if (off === null) {
      const peer = _peerOf(side, pid, null);
      paint('um-seg', []);
      _flash([pe, peer.el]);
      if (peer.el) alignOther(pe, panes[side], peer.el, panes[other(side)]);
      st.sel = { side, pid, index: null };
      if (o.onSelect) o.onSelect(st.sel);
      return { side, pid, offset: null, index: null };
    }
    const index = sentenceAt(sentencesOf(s, side, pid), off);
    markSentence(side, pid, index, 'align');
    return { side, pid, offset: off, index };
  }

  /** Goes to a span of a paragraph (a finding): its sentence and pair marked, the span itself in
   *  stronger yellow, both sheets centred (opt.quiet: no scrolling). */
  function focusSpan(side, pid, start, end, opt) {
    const s = o.session();
    if (!s || pid === null || pid === undefined) return;
    const index = sentenceAt(sentencesOf(s, side, pid), start);
    const r = markSentence(side, pid, index, null);
    const exact = end > start ? rangeOf(paraEl(side, pid), start, end) : null;
    paint('um-focus', [exact], 3);
    st.focus = { side, pid, start, end };
    if (r && !(opt && opt.quiet)) {
      if (exact || r.mine || r.mineEl) centerIn(panes[side], exact || r.mine || r.mineEl);
      if (r.peerRange || r.peerEl) centerIn(panes[other(side)], r.peerRange || r.peerEl);
    }
  }

  /** Both paragraphs of a unit (no sentence known): steady paragraph mark, both centred. */
  function focusParas(unitIdx) {
    const s = o.session();
    const u = s && s.units[unitIdx];
    if (!u) return;
    paint('um-seg', []); paint('um-focus', []);
    const a = paraEl('src', u.srcPara !== null ? u.srcPara : nearestPara(s, 'src', u.idx));
    const b = paraEl('tgt', u.tgtPara !== null ? u.tgtPara : nearestPara(s, 'tgt', u.idx));
    _flash([a, b]);
    if (a) centerIn(panes.src, a);
    if (b) centerIn(panes.tgt, b);
    st.sel = null; st.focus = null; st.unit = { unitIdx, key: null };
  }

  /**
   * An entity in a unit: the sentences where it occurs on each side (and, where it is missing, the
   * sentences paired with them) in yellow, the entity itself with a red glow, both sheets centred.
   * A side without a paragraph in this unit shows the nearest one (marked whole). opt = { key, quiet }
   */
  function focusUnit(unitIdx, opt) {
    const s = o.session();
    const u = s && s.units[unitIdx];
    if (!u) return;
    const key = opt && opt.key;
    const pids = { src: u.srcPara, tgt: u.tgtPara };
    const approx = { src: null, tgt: null };
    for (const side of ['src', 'tgt']) if (pids[side] === null || pids[side] === undefined) approx[side] = nearestPara(s, side, u.idx);
    const occIdx = (side) => {
      const pid = pids[side];
      if (pid === null || pid === undefined || !key) return [];
      const spans = sentencesOf(s, side, pid);
      const set = new Set();
      for (const oc of (s.ent.occ[side].get(pid) || [])) if (oc.key === key) set.add(sentenceAt(spans, oc.start));
      return Array.from(set).sort((x, y) => x - y);
    };
    const idx = { src: occIdx('src'), tgt: occIdx('tgt') };
    // The side without the entity shows the sentences aligned with those of the other side.
    for (const side of ['src', 'tgt']) {
      const os = other(side);
      if (!idx[side].length && idx[os].length && pids[side] !== null && pids[side] !== undefined && pids[os] !== null && pids[os] !== undefined) {
        const al = alignSentences(s, os, pids[os], pids[side]);
        const set = new Set();
        for (const i of idx[os]) for (const j of (al[i] || [])) set.add(j);
        idx[side] = Array.from(set).sort((x, y) => x - y);
      }
    }
    const ranges = { src: pids.src !== null ? _ranges('src', pids.src, idx.src) : [], tgt: pids.tgt !== null ? _ranges('tgt', pids.tgt, idx.tgt) : [] };
    const painted = paint('um-seg', ranges.src.concat(ranges.tgt), -1);
    paint('um-focus', []);
    const els = { src: paraEl('src', pids.src !== null ? pids.src : approx.src), tgt: paraEl('tgt', pids.tgt !== null ? pids.tgt : approx.tgt) };
    _flash([(!painted || !ranges.src.length) ? els.src : null, (!painted || !ranges.tgt.length) ? els.tgt : null]);
    _hot(key, [paraEl('src', pids.src), paraEl('tgt', pids.tgt)]);
    if (!(opt && opt.quiet)) {
      const firstHot = (side) => { const p = paraEl(side, pids[side]); return p ? p.querySelector('.hot') : null; };
      const ta = firstHot('src') || ranges.src[0] || els.src, tb = firstHot('tgt') || ranges.tgt[0] || els.tgt;
      if (ta) centerIn(panes.src, ta);
      if (tb) centerIn(panes.tgt, tb);
    }
    st.sel = null; st.focus = null; st.unit = { unitIdx, key };
  }

  /** Left/Right arrows: the next/previous sentence of the translation. */
  function step(dir) {
    const s = o.session();
    if (!s) return;
    const list = [];
    for (const pe of panes.tgt.querySelectorAll('.p[data-pid]')) {
      const pid = +pe.dataset.pid;
      const n = sentencesOf(s, 'tgt', pid).length;
      for (let i = 0; i < n; i++) list.push({ pid, index: i });
    }
    if (!list.length) return;
    let at = -1;
    if (st.sel) {
      let sel = st.sel;
      if (sel.side === 'src') { const p = peerSentence(s, 'src', sel.pid, sel.index); sel = p ? { pid: p.pid, index: p.index === null ? 0 : p.index } : null; }
      if (sel) at = list.findIndex(x => x.pid === sel.pid && x.index === (sel.index === null ? 0 : sel.index));
    }
    const next = list[at < 0 ? (dir > 0 ? 0 : list.length - 1) : (at + dir + list.length) % list.length];
    paint('um-focus', []);
    _hot(null, []);
    st.focus = null;
    markSentence('tgt', next.pid, next.index, 'reveal');
  }

  /** After the sheets were drawn again: the marks point at old nodes, so paint them again. */
  function refresh() {
    if (st.focus) { const f = st.focus; const i = sentenceAt(sentencesOf(o.session(), f.side, f.pid), f.start); markSentence(f.side, f.pid, i, null); paint('um-focus', [rangeOf(paraEl(f.side, f.pid), f.start, f.end)], 3); st.focus = f; return; }
    if (st.sel && st.sel.index !== null) { markSentence(st.sel.side, st.sel.pid, st.sel.index, null); return; }
    if (st.unit) focusUnit(st.unit.unitIdx, { key: st.unit.key, quiet: true });
  }

  function clear() { clearPaint(); _flash([]); _hot(null, []); st.sel = null; st.focus = null; st.unit = null; }

  /** Hover: the counterpart paragraph is outlined too. */
  function attachHover() {
    for (const side of ['src', 'tgt']) {
      let cur = null;
      const drop = () => { if (cur) cur.classList.remove('peer-hover'); cur = null; };
      panes[side].addEventListener('mouseover', (ev) => {
        const pe = ev.target.closest && ev.target.closest('.p[data-pid]');
        const s = o.session();
        if (!pe || !s) { drop(); return; }
        const oe = paraEl(other(side), peerPid(s, side, +pe.dataset.pid));
        if (oe === cur) return;
        drop();
        if (oe) { oe.classList.add('peer-hover'); cur = oe; }
      });
      panes[side].addEventListener('mouseleave', drop);
    }
  }

  return { markSentence, clickAt, focusSpan, focusParas, focusUnit, step, refresh, clear, attachHover, paraEl, get selection() { return st.sel; } };
}
