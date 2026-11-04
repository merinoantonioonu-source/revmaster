/**
 * Origin: COMeT modules/final-check/pptx-model.js @ 04540f5 (adapted)
 *
 * pptx-model.js - Parses a PPTX into the SAME document-model contract that
 * docx-model.js produces, so the Final Check pipeline (align.js, checks.js,
 * preview-renderer.js, find, navigation, sync scroll) works on presentations
 * without any change.
 *
 * The slide-walking strategy mirrors the Document View minimap renderer
 * (modules/docx-minimap/docx-renderer.js, renderPptxToHtml): slides in number
 * order; within a slide, top-level <p:sp> text shapes and <p:graphicFrame>
 * tables sorted into READING ORDER by (y, x) with a half-inch y tolerance;
 * text from <a:p>/<a:r>/<a:t>; merged table cells via gridSpan/rowSpan and
 * their hMerge/vMerge continuation cells.
 *
 * Differences vs the DOCX model:
 *   - model.kind = 'pptx'. There is no _parts/_el machinery: PPTX has no
 *     track-changes format. UMBRA (adapted): the model CAN be written back by
 *     doc-writer.js. It keeps `_bytes` (a copy of the original file) and every
 *     paragraph carries `_w: { part, pIndex }` = the slide part and the index of
 *     its <a:p> among ALL the <a:p> elements of that part, in document order.
 *   - Each slide contributes a synthetic heading paragraph "Slide N" so both
 *     panes show the slide boundaries and the aligner gets a shared anchor
 *     (isSlideSep:true, no `_w`: it is not in the file).
 *   - loc.slide carries the slide number (informational).
 *
 * UMBRA additions:
 *   - The text of a paragraph is EXACTLY the concatenation of its <a:t> texts,
 *     <a:br> -> ' ', and <a:fld> (slide number, date...) text is included, so
 *     the writer can project the XML to the same string.
 *   - Slides follow the presentation order (ppt/presentation.xml sldIdLst),
 *     falling back to the slide file numbers.
 *   - Group shapes (<p:grpSp>) are walked too (their text must not be missed
 *     by the masking), in reading order inside the group.
 *   - Tables carry `slide`.
 *
 * ASCII ONLY: non-ASCII characters in strings are written as \uXXXX escapes.
 */

// El recuento de palabras se comparte con el modelo DOCX para que las dos
// cajas de arrastre cuenten exactamente igual.
import { countWords } from './docx-model.js';

const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const P_NS = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';

// JSZip is a global script (app/libs/jszip.min.js, loaded by a <script> tag).
async function getJSZip() {
  const lib = (typeof window !== 'undefined' && window.JSZip) ||
    (typeof JSZip !== 'undefined' ? JSZip : null);
  if (!lib) throw new Error('No se ha cargado la biblioteca JSZip (app/libs/jszip.min.js).');
  return lib;
}

function _parseXml(xml) {
  const dom = new DOMParser().parseFromString(xml, 'text/xml');
  if (dom.getElementsByTagName('parsererror').length) {
    throw new Error('XML mal formado dentro del PPTX.');
  }
  return dom;
}

// A run in the shared model contract. fnRef/enRef MUST be null (not
// undefined): the preview renderer treats `run.fnRef !== null` as a note call.
function _mkRun(props) {
  return Object.assign({
    t: '', b: false, i: false, u: false, sup: false, sub: false,
    sz: null, color: null, highlight: null, caps: false, smallCaps: false,
    strike: false, link: null, fnRef: null, enRef: null, cmRef: null, img: null, brk: false
  }, props);
}

/** The direct child of `el` with this DrawingML local name (or null). */
function _child(el, name) {
  for (const c of el.childNodes) {
    if (c.nodeType === 1 && c.localName === name) return c;
  }
  return null;
}

/**
 * The text items of one <a:p>, in document order, exactly as doc-writer.js
 * projects them: <a:r>/<a:fld> -> their <a:t>; <a:br> -> ' '.
 * item = { kind:'t', node:<a:t>, runEl, text } | { kind:'x', node:<a:br>, text:' ' }
 */
export function pptxParaItems(pEl) {
  const items = [];
  for (const child of pEl.childNodes) {
    if (child.nodeType !== 1) continue;
    const ln = child.localName;
    if (ln === 'br') {
      items.push({ kind: 'x', node: child, runEl: child, text: ' ', deletable: false });
    } else if (ln === 'r' || ln === 'fld') {
      const tEl = _child(child, 't');
      if (tEl) items.push({ kind: 't', node: tEl, runEl: child, text: tEl.textContent || '' });
    }
  }
  return items;
}

/** Extract the runs of one <a:p> paragraph. */
function _paraRuns(pEl) {
  const runs = [];
  for (const it of pptxParaItems(pEl)) {
    if (it.kind === 'x') {
      // Soft break: keep a space in the comparison text (same convention as
      // the DOCX model) so issue spans stay aligned.
      runs.push(_mkRun({ t: ' ', brk: true }));
      continue;
    }
    const text = it.text;
    if (!text) continue;
    const rPr = _child(it.runEl, 'rPr');
    let b = false, i = false, u = false, sz = null, strike = false;
    if (rPr) {
      b = rPr.getAttribute('b') === '1';
      i = rPr.getAttribute('i') === '1';
      u = !!rPr.getAttribute('u') && rPr.getAttribute('u') !== 'none';
      strike = !!rPr.getAttribute('strike') && rPr.getAttribute('strike') !== 'noStrike';
      // PPTX sz is in hundredths of a point; the renderer expects DOCX
      // half-points (pt * 2), so divide by 50.
      const rawSz = parseInt(rPr.getAttribute('sz'), 10);
      if (rawSz > 0) sz = Math.round(rawSz / 50);
    }
    runs.push(_mkRun({ t: text, b, i, u, sz, strike, fld: it.runEl.localName === 'fld' }));
  }
  return runs;
}

function _paraFmt(pEl) {
  const pPr = _child(pEl, 'pPr');
  const algn = pPr ? pPr.getAttribute('algn') : null;
  const jc = algn === 'ctr' ? 'center' : algn === 'r' ? 'right' : algn === 'just' ? 'both' : null;
  return { jc, indLeft: 0, indFirstLine: 0, spaceBefore: 0, spaceAfter: null };
}

/** Push one logical paragraph into the model. Returns the para (or null). */
function _pushPara(model, pEl, loc, isHeading, ctx) {
  const runs = _paraRuns(pEl);
  const text = runs.map(r => r.t).join('');
  if (!text.trim()) return null;
  const pIndex = ctx.pIndex.has(pEl) ? ctx.pIndex.get(pEl) : -1;
  const para = {
    id: model.paras.length,
    text,
    listPrefix: '',
    listMarker: null,
    runs,
    loc,
    fmt: _paraFmt(pEl),
    isHeading,
    listLabel: null,
    fnRefs: [],
    _el: null,
    _seg: { index: 0, total: 1 },
    _w: { part: ctx.part, pIndex }
  };
  model.paras.push(para);
  return para;
}

/** Synthetic "Slide N" heading paragraph (same text on both sides: it becomes
 *  a natural alignment anchor and a visible slide boundary). */
function _pushSlideSep(model, slideNum, part) {
  const para = {
    id: model.paras.length,
    text: 'Slide ' + slideNum,
    listPrefix: '',
    listMarker: null,
    runs: [_mkRun({ t: 'Slide ' + slideNum, b: true })],
    loc: { area: 'body', table: null, row: null, col: null, fnId: null, slide: slideNum },
    fmt: { jc: 'center', indLeft: 0, indFirstLine: 0, spaceBefore: 14, spaceAfter: 6 },
    isHeading: true,
    listLabel: null,
    fnRefs: [],
    isSlideSep: true,
    slidePart: part,
    _el: null,
    _seg: { index: 0, total: 1 }
  };
  model.paras.push(para);
  model.blocks.push({ type: 'p', paraId: para.id });
}

/** True when the shape is a title placeholder (its paragraphs are headings). */
function _isTitleShape(sp) {
  const nv = sp.getElementsByTagNameNS(P_NS, 'nvSpPr')[0];
  if (!nv) return false;
  const ph = nv.getElementsByTagNameNS(P_NS, 'ph')[0];
  if (!ph) return false;
  const type = ph.getAttribute('type');
  return type === 'title' || type === 'ctrTitle';
}

function _walkShape(model, sp, slideNum, ctx) {
  const txBody = sp.getElementsByTagNameNS(P_NS, 'txBody')[0];
  if (!txBody) return;
  const titleShape = _isTitleShape(sp);
  for (const p of txBody.getElementsByTagNameNS(A_NS, 'p')) {
    // Big fonts read as headings too (same heuristic as the minimap: >= 24pt).
    let big = false;
    for (const r of p.getElementsByTagNameNS(A_NS, 'r')) {
      const rp = r.getElementsByTagNameNS(A_NS, 'rPr')[0];
      if (rp && (parseInt(rp.getAttribute('sz'), 10) || 0) >= 2400) { big = true; break; }
    }
    const para = _pushPara(model, p,
      { area: 'body', table: null, row: null, col: null, fnId: null, slide: slideNum },
      titleShape || big, ctx);
    if (para) model.blocks.push({ type: 'p', paraId: para.id });
  }
}

function _walkGraphicFrame(model, gf, slideNum, ctx) {
  const tbl = gf.getElementsByTagNameNS(A_NS, 'tbl')[0];
  if (!tbl) return;
  const tIdx = model.tables.length;

  const gridCols = [];
  const grid = tbl.getElementsByTagNameNS(A_NS, 'tblGrid')[0];
  if (grid) {
    for (const col of grid.getElementsByTagNameNS(A_NS, 'gridCol')) {
      gridCols.push(parseInt(col.getAttribute('w'), 10) || 1);
    }
  }

  const rows = [];
  const trs = [];
  for (const tr of tbl.childNodes) {
    if (tr.nodeType === 1 && tr.localName === 'tr') trs.push(tr);
  }
  for (let r = 0; r < trs.length; r++) {
    const row = [];
    const tcs = [];
    for (const tc of trs[r].childNodes) {
      if (tc.nodeType === 1 && tc.localName === 'tc') tcs.push(tc);
    }
    let c = 0;
    for (const tc of tcs) {
      // Horizontally merged-away cells are covered by the anchor's gridSpan:
      // skip them entirely (the DOCX model does not emit them either).
      if (tc.getAttribute('hMerge') === '1') continue;
      const isVCont = tc.getAttribute('vMerge') === '1';
      const gridSpan = parseInt(tc.getAttribute('gridSpan'), 10) || 1;
      const rowSpan = parseInt(tc.getAttribute('rowSpan'), 10) || 1;
      const cell = {
        paraIds: [],
        gridSpan,
        vMerge: isVCont ? 'cont' : (rowSpan > 1 ? 'restart' : null),
        shade: null
      };
      if (!isVCont) {
        const txBody = tc.getElementsByTagNameNS(A_NS, 'txBody')[0];
        if (txBody) {
          for (const p of txBody.getElementsByTagNameNS(A_NS, 'p')) {
            const para = _pushPara(model, p,
              { area: 'body', table: tIdx, row: r, col: c, fnId: null, slide: slideNum },
              false, ctx);
            if (para) cell.paraIds.push(para.id);
          }
        }
      }
      row.push(cell);
      c++;
    }
    rows.push(row);
  }

  model.tables.push({ idx: tIdx, rows, gridCols, hasBorders: true, slide: slideNum });
  model.blocks.push({ type: 'table', tIdx });
}

/** Offset (EMU) of a shape, a table frame or a group, for the reading order. */
function _offsetOf(el) {
  const ln = el.localName;
  let xfrm = null;
  if (ln === 'sp') {
    const spPr = _child(el, 'spPr');
    if (spPr) xfrm = _child(spPr, 'xfrm');
  } else if (ln === 'graphicFrame') {
    xfrm = _child(el, 'xfrm');
  } else if (ln === 'grpSp') {
    const gPr = _child(el, 'grpSpPr');
    if (gPr) xfrm = _child(gPr, 'xfrm');
  }
  const off = xfrm ? _child(xfrm, 'off') : null;
  return {
    x: off ? (parseInt(off.getAttribute('x'), 10) || 0) : 0,
    y: off ? (parseInt(off.getAttribute('y'), 10) || 0) : 0
  };
}

/**
 * Walk the shapes of a shape tree (or of a group) in READING ORDER:
 * top-to-bottom, then left-to-right when on the same band (same approach and
 * tolerance as the Document View minimap). A group is placed by its own
 * offset and walked recursively.
 */
function _walkTree(model, treeEl, slideNum, ctx) {
  const shapes = [];
  for (const child of treeEl.childNodes) {
    if (child.nodeType !== 1) continue;
    const ln = child.localName;
    if (ln !== 'sp' && ln !== 'graphicFrame' && ln !== 'grpSp') continue;
    const { x, y } = _offsetOf(child);
    shapes.push({ el: child, ln, x, y });
  }
  const Y_TOLERANCE = 457200; // ~0.5 inch in EMU
  shapes.sort((a, b) => (Math.abs(a.y - b.y) < Y_TOLERANCE) ? a.x - b.x : a.y - b.y);

  for (const sh of shapes) {
    if (sh.ln === 'sp') _walkShape(model, sh.el, slideNum, ctx);
    else if (sh.ln === 'graphicFrame') _walkGraphicFrame(model, sh.el, slideNum, ctx);
    else _walkTree(model, sh.el, slideNum, ctx);
  }
}

/** Resolve a relationship target against the folder of the part that owns it. */
function _resolveTarget(baseDir, target) {
  const parts = (target.charAt(0) === '/' ? target.slice(1) : baseDir + target).split('/');
  const norm = [];
  for (const p of parts) {
    if (p === '..') norm.pop();
    else if (p && p !== '.') norm.push(p);
  }
  return norm.join('/');
}

/**
 * The slide parts in PRESENTATION order (ppt/presentation.xml sldIdLst), or
 * by slide file number when that cannot be read.
 */
async function _slideOrder(zip) {
  const byNumber = Object.keys(zip.files)
    .filter(f => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort((a, b) => parseInt(a.match(/slide(\d+)/)[1], 10) - parseInt(b.match(/slide(\d+)/)[1], 10));
  try {
    const pres = zip.file('ppt/presentation.xml');
    const rels = zip.file('ppt/_rels/presentation.xml.rels');
    if (!pres || !rels) return byNumber;
    const presDom = _parseXml(await pres.async('string'));
    const relsDom = _parseXml(await rels.async('string'));
    const targets = new Map();
    for (const rel of relsDom.getElementsByTagNameNS(PKG_REL_NS, 'Relationship')) {
      targets.set(rel.getAttribute('Id'), rel.getAttribute('Target') || '');
    }
    const ordered = [];
    for (const sid of presDom.getElementsByTagNameNS(P_NS, 'sldId')) {
      const rid = sid.getAttributeNS(R_NS, 'id');
      const target = rid ? targets.get(rid) : null;
      if (!target) continue;
      const path = _resolveTarget('ppt/', target);
      if (zip.file(path) && ordered.indexOf(path) === -1) ordered.push(path);
    }
    if (!ordered.length) return byNumber;
    // Any slide file the list does not name (should not happen) goes last.
    for (const p of byNumber) if (ordered.indexOf(p) === -1) ordered.push(p);
    return ordered;
  } catch (e) {
    return byNumber;
  }
}

/**
 * Parse a PPTX file into the shared Final Check document model.
 * @param {File|Blob|ArrayBuffer|{name, arrayBuffer()}} file
 * @returns {Promise<Object>} model (kind: 'pptx')
 */
export async function parsePptxModel(file) {
  const JSZipL = await getJSZip();
  const arrayBuffer = file instanceof ArrayBuffer ? file : await file.arrayBuffer();
  const zip = await JSZipL.loadAsync(arrayBuffer);

  const slidePaths = await _slideOrder(zip);
  if (!slidePaths.length) throw new Error('No se encontraron diapositivas en el PPTX.');

  const model = {
    kind: 'pptx',
    fileName: (file && file.name) || 'presentation.pptx',
    paras: [],
    blocks: [],
    tables: [],
    footnotes: [],
    endnotes: [],
    fnRefOrder: [],
    media: {},
    fnNumById: new Map(),
    stats: null,
    slideParts: slidePaths.slice(),
    _bytes: arrayBuffer.slice(0),
    _zip: zip
  };

  for (let si = 0; si < slidePaths.length; si++) {
    const slideNum = si + 1;
    const xml = await zip.file(slidePaths[si]).async('string');
    const dom = _parseXml(xml);
    _pushSlideSep(model, slideNum, slidePaths[si]);

    // Index of every <a:p> of the part in document order: the writer finds a
    // paragraph again by this number.
    const pIndex = new Map();
    const allPs = dom.getElementsByTagNameNS(A_NS, 'p');
    for (let k = 0; k < allPs.length; k++) pIndex.set(allPs[k], k);
    const ctx = { part: slidePaths[si], pIndex };

    const spTree = dom.getElementsByTagNameNS(P_NS, 'spTree')[0];
    if (!spTree) continue;
    _walkTree(model, spTree, slideNum, ctx);
  }

  model.stats = {
    nonEmptyParas: model.paras.filter(p => p.text.trim() && !p.isSlideSep).length,
    wordCount: countWords(model.paras.filter(p => !p.isSlideSep)),
    tableCount: model.tables.length,
    footnoteCount: 0,
    endnoteCount: 0,
    fnRefCount: 0,
    slideCount: slidePaths.length
  };
  return model;
}
