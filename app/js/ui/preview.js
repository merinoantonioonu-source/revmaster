/**
 * preview.js - Word-like rendering of a document model (DOCX/PPTX/XLSX) with decorations.
 *
 * renderDoc(host, model, opts) where opts = {
 *   decorate(para) -> [{ start, end, cls, attrs, replace (Node|null) }]  non-overlapping spans
 *   gaps(para) -> [{ at, label }]   omission markers
 *   onParaClick(para, ev)
 * }
 * Each paragraph is a div.p[data-pid]; tables keep their grid; XLSX sheets get their name; PPTX slide
 * separators are shown as small headers; footnotes/endnotes go at the end.
 *
 * Every text node written from para.text carries its offset in para.text (node.__o), and every pill
 * that replaces text carries __o/__e: ui/nav.js uses them to turn para.text offsets into DOM ranges
 * (sentence highlights) and a click position back into an offset.
 */

import { el, clear } from '../util/dom.js';

export function renderDoc(host, model, opts) {
  clear(host);
  if (!model) return;
  const o = opts || {};
  const sheet = el('div.sheet');
  const paraEls = new Map();
  const paraNode = (p) => {
    const node = renderPara(p, o);
    paraEls.set(p.id, node);
    return node;
  };
  const tableNode = (t) => {
    const wrap = el('div');
    if (t.sheet) wrap.appendChild(el('div.sheetname', 'Hoja: ' + t.sheet));
    const table = el('table');
    for (const row of t.rows || []) {
      const tr = el('tr');
      for (const cell of row) {
        if (cell && (cell.vMerge === 'cont' || cell.merged)) continue;
        const td = el('td');
        if (cell && cell.gridSpan > 1) td.colSpan = cell.gridSpan;
        for (const pid of (cell && cell.paraIds) || []) {
          const p = model.paras[pid];
          if (p) td.appendChild(paraNode(p));
        }
        tr.appendChild(td);
      }
      table.appendChild(tr);
    }
    wrap.appendChild(table);
    return wrap;
  };
  const blocks = model.blocks && model.blocks.length ? model.blocks : model.paras.filter(p => p.loc.area === 'body' && (p.loc.table === null || p.loc.table === undefined)).map(p => ({ type: 'p', paraId: p.id }));
  const tablesDone = new Set();
  for (const b of blocks) {
    if (b.type === 'table') {
      const t = model.tables[b.tIdx];
      if (t && !tablesDone.has(b.tIdx)) { tablesDone.add(b.tIdx); sheet.appendChild(tableNode(t)); }
    } else {
      const p = model.paras[b.paraId];
      if (p && p.loc.area === 'body') sheet.appendChild(paraNode(p));
    }
  }
  // Paragraphs not reached through blocks (PPTX tables, safety net).
  for (const p of model.paras) {
    if (paraEls.has(p.id) || p.loc.area !== 'body') continue;
    if (p.loc.table !== null && p.loc.table !== undefined && !tablesDone.has(p.loc.table)) {
      tablesDone.add(p.loc.table);
      const t = model.tables[p.loc.table];
      if (t) { sheet.appendChild(tableNode(t)); continue; }
    }
    if (!paraEls.has(p.id)) sheet.appendChild(paraNode(p));
  }
  const notes = (model.footnotes || []).concat(model.endnotes || []);
  if (notes.length) {
    const box = el('div.notes');
    for (const n of notes) {
      for (const pid of n.paraIds || []) {
        const p = model.paras[pid];
        if (!p) continue;
        const node = paraNode(p);
        if (n.paraIds[0] === pid) node.insertBefore(el('sup.lp', String(n.num || n.id)), node.firstChild);
        box.appendChild(node);
      }
    }
    sheet.appendChild(box);
  }
  host.appendChild(sheet);
  if (o.onParaClick) {
    sheet.addEventListener('click', (ev) => {
      const pe = ev.target.closest('.p[data-pid]');
      if (pe) o.onParaClick(model.paras[+pe.dataset.pid], ev);
    });
  }
  return { sheet, paraEls };
}

export function renderPara(p, o) {
  const cls = ['p'];
  if (p.isHeading) cls.push('h');
  if (p.isSlideSep) cls.push('slide');
  const node = el('div.' + cls.join('.'), { dataset: { pid: p.id } });
  if (p.fmt) {
    if (p.fmt.jc === 'center') node.style.textAlign = 'center';
    else if (p.fmt.jc === 'right' || p.fmt.jc === 'end') node.style.textAlign = 'right';
    else if (p.fmt.jc === 'both') node.style.textAlign = 'justify';
    if (typeof p.fmt.indLeft === 'number' && p.fmt.indLeft > 0) node.style.paddingLeft = Math.min(p.fmt.indLeft, 200) + 'px';
    if (typeof p.fmt.indFirstLine === 'number' && p.fmt.indFirstLine) node.style.textIndent = Math.max(-80, Math.min(p.fmt.indFirstLine, 120)) + 'px';
  }
  if (p.loc && p.loc.cellRef) node.appendChild(el('span.cellref', p.loc.cellRef));
  if (p.listPrefix) node.appendChild(el('span.lp', p.listPrefix.trim()));
  const decos = (o && o.decorate ? o.decorate(p) : []) || [];
  const gaps = (o && o.gaps ? o.gaps(p) : []) || [];
  appendRich(node, p, decos, gaps);
  return node;
}

/**
 * Writes the text of a paragraph with its run formatting and the decorations. Decorations must not
 * overlap; a decoration with `replace` swaps its text for that node (a masking tag pill).
 */
export function appendRich(node, p, decos, gaps) {
  const text = p.text || '';
  const runs = (p.runs && p.runs.length) ? p.runs : [{ t: text }];
  // Formatting boundaries from the runs (their t concatenate to text).
  const fmtAt = [];
  let pos = 0;
  for (const r of runs) {
    const t = r.t || '';
    if (!t) continue;
    fmtAt.push({ start: pos, end: pos + t.length, r });
    pos += t.length;
  }
  if (pos !== text.length) { fmtAt.length = 0; fmtAt.push({ start: 0, end: text.length, r: {} }); }
  const ds = (decos || []).slice().sort((a, b) => a.start - b.start);
  const gs = (gaps || []).slice().sort((a, b) => a.at - b.at);
  const cuts = new Set([0, text.length]);
  for (const f of fmtAt) { cuts.add(f.start); cuts.add(f.end); }
  for (const d of ds) { cuts.add(Math.max(0, d.start)); cuts.add(Math.min(text.length, d.end)); }
  for (const g of gs) cuts.add(Math.max(0, Math.min(text.length, g.at)));
  const points = Array.from(cuts).sort((a, b) => a - b);
  let di = 0, gi = 0;
  let curDeco = null, curHost = node;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    while (gi < gs.length && gs[gi].at === a) { node.appendChild(el('span.gap', { title: gs[gi].title || '' }, gs[gi].label)); gi++; }
    if (i === points.length - 1) break;
    const b = points[i + 1];
    if (a === b) continue;
    while (di < ds.length && ds[di].end <= a) di++;
    const d = (di < ds.length && ds[di].start <= a && ds[di].end >= b) ? ds[di] : null;
    if (d !== curDeco) {
      curDeco = d;
      if (d) {
        if (d.replace) {
          if (d.start === a) {
            const pill = d.replace;
            pill.__o = d.start;
            pill.__e = d.end;
            node.appendChild(pill);
          }
          curHost = null;
        } else {
          const m = el('mark.' + (d.cls || 'f').split(' ').join('.'), d.attrs || null);
          node.appendChild(m);
          curHost = m;
        }
      } else {
        curHost = node;
      }
    }
    if (!curHost) continue;
    const f = fmtAt.find(x => x.start <= a && x.end >= b);
    const piece = text.slice(a, b);
    curHost.appendChild(_fmt(piece, f ? f.r : {}, a));
  }
  while (gi < gs.length) { node.appendChild(el('span.gap', { title: gs[gi].title || '' }, gs[gi].label)); gi++; }
  if (!text) node.appendChild(document.createTextNode('\u200b'));
}

function _fmt(text, r, at) {
  let n = document.createTextNode(text);
  n.__o = at;
  if (r.sup) n = _wrap('sup', n);
  if (r.sub) n = _wrap('sub', n);
  if (r.u) n = _wrap('u', n);
  if (r.i) n = _wrap('i', n);
  if (r.b) n = _wrap('b', n);
  if (r.strike) n = _wrap('s', n);
  return n;
}

function _wrap(tag, child) {
  const e = document.createElement(tag);
  e.appendChild(child);
  return e;
}
