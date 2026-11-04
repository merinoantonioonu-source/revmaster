/**
 * xlsx-model.js - Parses an XLSX workbook into the shared document-model
 * contract (docs/ARQUITECTURA.md section 2), the same one docx-model.js and
 * pptx-model.js produce, so alignment, masking and review work on workbooks
 * without special cases.
 *
 * MAPPING
 *   - One worksheet = one table (`tables[]`, `blocks: [{ type:'table', tIdx }]`),
 *     in workbook order (xl/workbook.xml). Chart sheets are skipped.
 *   - Every non-empty cell = one paragraph, in sheet order, row by row:
 *       { id, text, runs, loc:{ area:'body', table, row, col, sheet, cellRef, fnId:null },
 *         fmt:{}, isHeading:false, listPrefix:'', listMarker:null, listLabel:null,
 *         fnRefs:[], numeric, formula, _seg, _w }
 *   - Cell types: t="s" shared string, t="inlineStr" inline string, t="str"
 *     formula string result (formula:true), t="d" ISO date (as text), numbers
 *     (no t or t="n": text = the raw <v> string, numeric:true, formula:true
 *     when an <f> is present). Booleans and errors are skipped.
 *   - Rich text (<r><rPr/><t/></r>) becomes one run per <r> with b/i/u/strike/
 *     sup/sub; plain strings are one run.
 *   - `rows` keeps the full RECTANGULAR grid from A1 to the last used cell
 *     (merged ranges included): rows[r][c] is always the cell at column c.
 *     Empty cells have paraIds []. Merged ranges, best effort: the anchor cell
 *     carries gridSpan (columns) and vMerge:'restart' (when several rows);
 *     every other cell of the range carries merged:true, and those below the
 *     anchor in its column also vMerge:'cont'. A renderer must skip merged
 *     cells. (A sheet whose grid would exceed MAX_GRID_CELLS keeps ragged rows,
 *     each up to its own last used column.)
 *   - `_w` locates the cell for the writer (doc-writer.js):
 *       { part:'xl/worksheets/sheet1.xml', cellRef:'B3', type:'s'|'inlineStr'|'str'|'n'|'d', si? }
 *   - footnotes / endnotes: [].
 *
 * The model also keeps `_bytes` (a copy of the original file), `_zip`,
 * `sharedStringsPart` and `_sstUse` (shared string index -> number of cells
 * of the whole workbook that use it, empty ones included).
 *
 * ASCII ONLY: non-ASCII characters in strings are written as \uXXXX escapes.
 */

import { countWords } from './docx-model.js';

const PKG_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const R_NS_STRICT = 'http://purl.oclc.org/ooxml/officeDocument/relationships';

const MAX_GRID_CELLS = 400000;

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
    throw new Error('XML mal formado dentro del XLSX.');
  }
  return dom;
}

/** Direct element children of `el` with this local name (namespace-agnostic). */
function _kids(el, name) {
  const out = [];
  if (!el) return out;
  for (const c of el.childNodes) {
    if (c.nodeType === 1 && (!name || c.localName === name)) out.push(c);
  }
  return out;
}

function _kid(el, name) {
  if (!el) return null;
  for (const c of el.childNodes) {
    if (c.nodeType === 1 && c.localName === name) return c;
  }
  return null;
}

/** First descendant with this local name (namespace-agnostic). */
function _desc(root, name) {
  const all = root.getElementsByTagName('*');
  for (const el of all) if (el.localName === name) return el;
  return null;
}

// ------------------------------------------------------------------
// Cell references
// ------------------------------------------------------------------

/** 'B3' -> { row: 2, col: 1 } (0-based), or null. */
export function parseCellRef(ref) {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(String(ref || '').trim());
  if (!m) return null;
  let col = 0;
  const letters = m[1].toUpperCase();
  for (let i = 0; i < letters.length; i++) col = col * 26 + (letters.charCodeAt(i) - 64);
  return { row: parseInt(m[2], 10) - 1, col: col - 1 };
}

/** (row, col) 0-based -> 'B3'. */
export function cellRefOf(row, col) {
  let n = col + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s + (row + 1);
}

/**
 * Every <c> of a worksheet DOM with its position. A cell (or row) may omit
 * its `r` attribute; it then follows the previous one, which is what Excel
 * does. Returns [{ el, row, col, ref }] in document order.
 */
export function xlsxCells(sheetDom) {
  const out = [];
  const sheetData = _desc(sheetDom, 'sheetData');
  if (!sheetData) return out;
  let rowIdx = -1;
  for (const rowEl of _kids(sheetData, 'row')) {
    const rAttr = parseInt(rowEl.getAttribute('r'), 10);
    rowIdx = isNaN(rAttr) ? rowIdx + 1 : rAttr - 1;
    let colIdx = -1;
    for (const c of _kids(rowEl, 'c')) {
      const pos = parseCellRef(c.getAttribute('r'));
      if (pos) { colIdx = pos.col; } else { colIdx += 1; }
      const row = pos ? pos.row : rowIdx;
      out.push({ el: c, row, col: colIdx, ref: cellRefOf(row, colIdx) });
    }
  }
  return out;
}

// ------------------------------------------------------------------
// Strings (shared <si> and inline <is>)
// ------------------------------------------------------------------

/**
 * The text items of a string item (<si> or <is>), in document order, exactly
 * as doc-writer.js projects them: a direct <t>, or the <t> of each rich-text
 * run <r>. Phonetic runs (<rPh>) are not text.
 * item = { kind:'t', node:<t>, runEl:<r>|null, text }
 */
export function xlsxStringItems(strEl) {
  const items = [];
  if (!strEl) return items;
  for (const c of strEl.childNodes) {
    if (c.nodeType !== 1) continue;
    if (c.localName === 't') {
      items.push({ kind: 't', node: c, runEl: null, text: c.textContent || '' });
    } else if (c.localName === 'r') {
      const t = _kid(c, 't');
      if (t) items.push({ kind: 't', node: t, runEl: c, text: t.textContent || '' });
    }
  }
  return items;
}

function _onOff(el) {
  if (!el) return false;
  const v = el.getAttribute('val');
  return !(v === '0' || v === 'false' || v === 'none');
}

function _mkRun(props) {
  return Object.assign({
    t: '', b: false, i: false, u: false, sup: false, sub: false,
    sz: null, color: null, highlight: null, caps: false, smallCaps: false,
    strike: false, link: null, fnRef: null, enRef: null, cmRef: null, img: null, brk: false
  }, props);
}

/** { text, runs } of a string item. */
function _readString(strEl) {
  const runs = [];
  let text = '';
  for (const it of xlsxStringItems(strEl)) {
    text += it.text;
    if (!it.text) continue;
    const props = { t: it.text };
    const rPr = it.runEl ? _kid(it.runEl, 'rPr') : null;
    if (rPr) {
      props.b = _onOff(_kid(rPr, 'b'));
      props.i = _onOff(_kid(rPr, 'i'));
      const u = _kid(rPr, 'u');
      props.u = !!u && u.getAttribute('val') !== 'none';
      props.strike = _onOff(_kid(rPr, 'strike'));
      const va = _kid(rPr, 'vertAlign');
      if (va) {
        props.sup = va.getAttribute('val') === 'superscript';
        props.sub = va.getAttribute('val') === 'subscript';
      }
      const sz = _kid(rPr, 'sz');
      if (sz) { const n = parseFloat(sz.getAttribute('val')); if (n > 0) props.sz = n; }
    }
    runs.push(_mkRun(props));
  }
  return { text, runs };
}

// ------------------------------------------------------------------
// Package structure
// ------------------------------------------------------------------

function _resolveTarget(baseDir, target) {
  const parts = (target.charAt(0) === '/' ? target.slice(1) : baseDir + target).split('/');
  const norm = [];
  for (const p of parts) {
    if (p === '..') norm.pop();
    else if (p && p !== '.') norm.push(p);
  }
  return norm.join('/');
}

async function _workbookParts(zip) {
  const wbFile = zip.file('xl/workbook.xml');
  if (!wbFile) throw new Error('No se encontr\u00f3 xl/workbook.xml. \u00bfEs un XLSX v\u00e1lido?');
  const wbDom = _parseXml(await wbFile.async('string'));
  const rels = new Map();   // Id -> { target, type }
  const relsFile = zip.file('xl/_rels/workbook.xml.rels');
  if (relsFile) {
    const relsDom = _parseXml(await relsFile.async('string'));
    for (const rel of relsDom.getElementsByTagNameNS(PKG_REL_NS, 'Relationship')) {
      rels.set(rel.getAttribute('Id'), {
        target: _resolveTarget('xl/', rel.getAttribute('Target') || ''),
        type: rel.getAttribute('Type') || ''
      });
    }
  }
  let sstPath = null;
  for (const r of rels.values()) {
    if (/\/sharedStrings$/.test(r.type)) { sstPath = r.target; break; }
  }
  if (!sstPath && zip.file('xl/sharedStrings.xml')) sstPath = 'xl/sharedStrings.xml';

  const sheets = [];
  const sheetsEl = _desc(wbDom, 'sheets');
  for (const sh of _kids(sheetsEl, 'sheet')) {
    const rid = sh.getAttributeNS(R_NS, 'id') || sh.getAttributeNS(R_NS_STRICT, 'id') ||
      sh.getAttribute('r:id');
    const rel = rid ? rels.get(rid) : null;
    if (!rel || !/\/worksheet$/.test(rel.type)) continue;   // chart / dialog sheets
    if (!zip.file(rel.target)) continue;
    sheets.push({
      name: sh.getAttribute('name') || '',
      part: rel.target,
      hidden: !!(sh.getAttribute('state') && sh.getAttribute('state') !== 'visible')
    });
  }
  return { sheets, sstPath };
}

// ------------------------------------------------------------------
// Parsing
// ------------------------------------------------------------------

/**
 * Parse an XLSX File/ArrayBuffer into the shared document model.
 * @param {File|Blob|ArrayBuffer|{name, arrayBuffer()}} file
 * @returns {Promise<Object>} model (kind: 'xlsx')
 */
export async function parseXlsxModel(file) {
  const JSZipL = await getJSZip();
  const arrayBuffer = file instanceof ArrayBuffer ? file : await file.arrayBuffer();
  const zip = await JSZipL.loadAsync(arrayBuffer);
  const { sheets, sstPath } = await _workbookParts(zip);
  if (!sheets.length) throw new Error('No se encontraron hojas en el XLSX.');

  // Shared strings: text and runs per <si>.
  const sst = [];
  if (sstPath && zip.file(sstPath)) {
    const sstDom = _parseXml(await zip.file(sstPath).async('string'));
    for (const si of _kids(sstDom.documentElement, 'si')) sst.push(_readString(si));
  }

  const model = {
    kind: 'xlsx',
    fileName: (file && file.name) || 'workbook.xlsx',
    paras: [],
    blocks: [],
    tables: [],
    footnotes: [],
    endnotes: [],
    fnRefOrder: [],
    media: {},
    fnNumById: new Map(),
    stats: null,
    sharedStringsPart: sstPath,
    _sstUse: new Map(),
    _bytes: arrayBuffer.slice(0),
    _zip: zip
  };

  for (let s = 0; s < sheets.length; s++) {
    const sh = sheets[s];
    const dom = _parseXml(await zip.file(sh.part).async('string'));
    const tIdx = model.tables.length;
    const cells = [];   // { row, col, ref, para }
    let maxRow = -1, maxCol = -1;

    for (const { el, row, col, ref } of xlsxCells(dom)) {
      const t = el.getAttribute('t') || 'n';
      const vEl = _kid(el, 'v');
      const fEl = _kid(el, 'f');
      const raw = vEl ? (vEl.textContent || '') : '';
      let text = '', runs = null, numeric = false, formula = !!fEl, w = null;

      if (t === 's') {
        const idx = parseInt(raw, 10);
        if (isNaN(idx)) continue;
        model._sstUse.set(idx, (model._sstUse.get(idx) || 0) + 1);
        const str = sst[idx];
        if (!str) continue;
        text = str.text; runs = str.runs;
        w = { part: sh.part, cellRef: ref, type: 's', si: idx };
      } else if (t === 'inlineStr') {
        const str = _readString(_kid(el, 'is'));
        text = str.text; runs = str.runs;
        w = { part: sh.part, cellRef: ref, type: 'inlineStr' };
      } else if (t === 'str') {
        text = raw; formula = true;
        w = { part: sh.part, cellRef: ref, type: 'str' };
      } else if (t === 'd') {
        text = raw;
        w = { part: sh.part, cellRef: ref, type: 'd' };
      } else if (t === 'n') {
        if (!raw.trim()) continue;   // a styled cell, or a formula with no cached value
        text = raw; numeric = true;
        w = { part: sh.part, cellRef: ref, type: 'n' };
      } else {
        continue;                    // 'b' booleans and 'e' errors
      }
      if (!text || !text.trim()) continue;
      if (!runs || !runs.length) runs = [_mkRun({ t: text })];

      const para = {
        id: model.paras.length,
        text,
        runs,
        loc: { area: 'body', table: tIdx, row, col, sheet: sh.name, cellRef: ref, fnId: null },
        fmt: {},
        isHeading: false,
        listPrefix: '',
        listMarker: null,
        listLabel: null,
        fnRefs: [],
        numeric,
        formula,
        _el: null,
        _seg: { index: 0, total: 1 },
        _w: w
      };
      model.paras.push(para);
      cells.push({ row, col, ref, para });
      if (row > maxRow) maxRow = row;
      if (col > maxCol) maxCol = col;
    }

    // Merged ranges (best effort).
    const merges = [];
    const mc = _desc(dom, 'mergeCells');
    for (const m of _kids(mc, 'mergeCell')) {
      const parts = String(m.getAttribute('ref') || '').split(':');
      const a = parseCellRef(parts[0]);
      const b = parseCellRef(parts[1] || parts[0]);
      if (!a || !b) continue;
      const r0 = Math.min(a.row, b.row), r1 = Math.max(a.row, b.row);
      const c0 = Math.min(a.col, b.col), c1 = Math.max(a.col, b.col);
      merges.push({ r0, r1, c0, c1 });
      if (r1 > maxRow) maxRow = r1;
      if (c1 > maxCol) maxCol = c1;
    }

    // The grid.
    const nRows = maxRow + 1, nCols = maxCol + 1;
    const ragged = nRows * nCols > MAX_GRID_CELLS;
    const lastColOfRow = new Map();
    if (ragged) {
      for (const c of cells) lastColOfRow.set(c.row, Math.max(lastColOfRow.get(c.row) || 0, c.col));
    }
    const rows = [];
    for (let r = 0; r < nRows; r++) {
      const width = ragged ? (lastColOfRow.has(r) ? lastColOfRow.get(r) + 1 : 0) : nCols;
      const row = new Array(width);
      for (let c = 0; c < width; c++) row[c] = { paraIds: [], gridSpan: 1, vMerge: null };
      rows.push(row);
    }
    const cellAt = (r, c) => (rows[r] && rows[r][c]) ? rows[r][c] : null;
    for (const m of merges) {
      const anchor = cellAt(m.r0, m.c0);
      if (anchor) {
        anchor.gridSpan = m.c1 - m.c0 + 1;
        if (m.r1 > m.r0) anchor.vMerge = 'restart';
      }
      for (let r = m.r0; r <= m.r1; r++) {
        for (let c = m.c0; c <= m.c1; c++) {
          if (r === m.r0 && c === m.c0) continue;
          const cell = cellAt(r, c);
          if (!cell) continue;
          cell.merged = true;
          if (c === m.c0) { cell.vMerge = 'cont'; cell.gridSpan = m.c1 - m.c0 + 1; }
        }
      }
    }
    for (const c of cells) {
      const cell = cellAt(c.row, c.col);
      if (cell) cell.paraIds.push(c.para.id);
    }

    model.tables.push({
      idx: tIdx, sheet: sh.name, sheetIndex: s, part: sh.part, hidden: sh.hidden,
      rows, hasBorders: true, gridCols: []
    });
    model.blocks.push({ type: 'table', tIdx });
  }

  model.stats = {
    nonEmptyParas: model.paras.length,
    wordCount: countWords(model.paras),
    tableCount: model.tables.length,
    sheetCount: model.tables.length,
    numericCount: model.paras.filter(p => p.numeric).length,
    footnoteCount: 0,
    endnoteCount: 0,
    fnRefCount: 0
  };
  return model;
}
