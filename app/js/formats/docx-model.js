/**
 * Origin: COMeT modules/final-check/docx-model.js @ 04540f5 (adapted)
 *
 * docx-model.js - Parses a DOCX file into a structured document model for the
 * Final Check (Cotejo final) module.
 *
 * The model preserves what the structural comparison and the Word-like
 * dual-pane preview need: paragraph order, inline formatting runs, paragraph
 * formatting (alignment, indents, spacing) resolved through styles.xml,
 * tables (with row/cell coordinates, borders, shading, widths and merged
 * cells), footnotes/endnotes, hyperlinks and embedded images. It deliberately
 * ignores headers/footers, columns and floating layout.
 *
 * ASCII ONLY: non-ASCII characters in strings are written as \uXXXX escapes.
 *
 * Model shape:
 * {
 *   kind: 'docx',
 *   fileName: string,
 *   _bytes: ArrayBuffer (a copy of the original file, for the writers),
 *   paras: [ { id, text, runs, loc, fmt, isHeading, listLabel, listPrefix,
 *              listMarker, fnRefs, _el, _seg } ],
 *     - runs: [ { t, b, i, u, sup, sub, strike, sz, color, highlight,
 *                 fnRef, enRef, link, img, brk, ins, del, dt, author, date } ]
 *       TRACKED CHANGES: insertions are kept (the change is accepted) and only
 *       flagged with ins:true. A deletion becomes a run with an EMPTY t and the
 *       removed words in dt, so it is invisible to everything that reads run
 *       text -- the export, the transformations, the editor and the character
 *       offsets -- and only the preview can show it, on request.
 *     - loc:  { area:'body'|'footnote'|'endnote', table:tIdx|null, row, col, fnId }
 *     - fmt:  { jc, indLeft, indFirstLine, spaceBefore, spaceAfter } (px/keyword)
 *     - listPrefix: automatic list number/bullet ('' when not a list item)
 *     - listMarker: literal leading marker still present in `text` (or null)
 *     - _el:  the source <w:p> element; _seg { index, total } = line within it
 *             (a <w:p> split at <w:br> yields several logical paragraphs)
 *   blocks: [ { type:'p', paraId } | { type:'table', tIdx } ],   // body order
 *   tables: [ { idx, rows: [ [ cell ] ], hasBorders } ],
 *     - cell: { paraIds:[], gridSpan, vMerge:'restart'|'cont'|null, widthPct, shade }
 *   footnotes / endnotes: [ { id, num, paraIds:[], text } ],
 *   fnRefOrder: [fnId,...],
 *   media: { relPathKey -> dataUrl },
 *   stats: { bodyParas, nonEmptyParas, tableCount, footnoteCount, fnRefCount, xeCount }
 * }
 */

import { imageCensus } from './export-verify.js';

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';

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
    throw new Error('XML mal formado dentro del DOCX.');
  }
  return dom;
}

/** Read a relationships part: external URLs and internal targets (media). */
async function _parseRels(zip, path) {
  const rels = { external: {}, internal: {} };
  const f = zip.file(path);
  if (!f) return rels;
  try {
    const dom = _parseXml(await f.async('string'));
    const els = dom.getElementsByTagName('Relationship');
    for (const el of els) {
      const id = el.getAttribute('Id');
      const target = el.getAttribute('Target');
      if (!id || !target) continue;
      if (el.getAttribute('TargetMode') === 'External') rels.external[id] = target;
      else rels.internal[id] = target;
    }
  } catch (e) { /* rels are optional */ }
  return rels;
}

// ------------------------------------------------------------------
// Unit helpers
// ------------------------------------------------------------------

/** Twentieths of a point -> CSS px (approx, 96dpi). */
function _twipsToPx(v) {
  const n = parseInt(v, 10);
  if (isNaN(n)) return null;
  return Math.round(n / 20 * 96 / 72);
}

/** Half-points -> pt. */
function _halfPtToPt(v) {
  const n = parseInt(v, 10);
  if (isNaN(n)) return null;
  return n / 2;
}

/** EMU -> px. */
function _emuToPx(v) {
  const n = parseInt(v, 10);
  if (isNaN(n)) return null;
  return Math.round(n / 9525);
}

function _attr(el, name) {
  return el ? el.getAttributeNS(W_NS, name) : null;
}

// ------------------------------------------------------------------
// styles.xml resolution
// ------------------------------------------------------------------

function _readRunProps(rPr) {
  if (!rPr) return {};
  const out = {};
  const get = (n) => rPr.getElementsByTagNameNS(W_NS, n)[0];
  const onOff = (n) => {
    const el = get(n);
    if (!el) return undefined;
    const val = _attr(el, 'val');
    return !(val === 'false' || val === '0' || val === 'none');
  };
  const b = onOff('b'); if (b !== undefined) out.b = b;
  const i = onOff('i'); if (i !== undefined) out.i = i;
  const caps = onOff('caps'); if (caps !== undefined) out.caps = caps;
  const smallCaps = onOff('smallCaps'); if (smallCaps !== undefined) out.smallCaps = smallCaps;
  const strike = onOff('strike'); if (strike !== undefined) out.strike = strike;
  const uEl = get('u');
  if (uEl) out.u = _attr(uEl, 'val') !== 'none';
  const szEl = get('sz');
  if (szEl) { const pt = _halfPtToPt(_attr(szEl, 'val')); if (pt) out.sz = pt; }
  const colorEl = get('color');
  if (colorEl) {
    const v = _attr(colorEl, 'val');
    if (v && v !== 'auto') out.color = '#' + v;
  }
  const hlEl = get('highlight');
  if (hlEl) {
    const v = _attr(hlEl, 'val');
    if (v && v !== 'none') out.highlight = v;
  }
  const va = get('vertAlign');
  if (va) {
    const v = _attr(va, 'val');
    if (v === 'superscript') out.sup = true;
    else if (v === 'subscript') out.sub = true;
  }
  return out;
}

function _readParaProps(pPr) {
  if (!pPr) return {};
  const out = {};
  const get = (n) => pPr.getElementsByTagNameNS(W_NS, n)[0];
  const jcEl = get('jc');
  if (jcEl) {
    const v = _attr(jcEl, 'val');
    if (v === 'center' || v === 'right' || v === 'both' || v === 'left') out.jc = v;
  }
  const indEl = get('ind');
  if (indEl) {
    const left = _twipsToPx(_attr(indEl, 'left') || _attr(indEl, 'start'));
    const fl = _twipsToPx(_attr(indEl, 'firstLine'));
    const hang = _twipsToPx(_attr(indEl, 'hanging'));
    if (left !== null) out.indLeft = left;
    if (fl !== null) out.indFirstLine = fl;
    if (hang !== null) out.indFirstLine = -hang;
  }
  const spEl = get('spacing');
  if (spEl) {
    const before = _twipsToPx(_attr(spEl, 'before'));
    const after = _twipsToPx(_attr(spEl, 'after'));
    if (before !== null) out.spaceBefore = before;
    if (after !== null) out.spaceAfter = after;
  }
  return out;
}

/** Parse styles.xml into styleId -> { basedOn, pPr, rPr, name } plus doc defaults. */
async function _parseStyles(zip) {
  const styles = { byId: new Map(), defaultRPr: {}, defaultPPr: {} };
  const f = zip.file('word/styles.xml');
  if (!f) return styles;
  let dom;
  try { dom = _parseXml(await f.async('string')); } catch (e) { return styles; }

  const dd = dom.getElementsByTagNameNS(W_NS, 'docDefaults')[0];
  if (dd) {
    const rPrD = dd.getElementsByTagNameNS(W_NS, 'rPrDefault')[0];
    if (rPrD) styles.defaultRPr = _readRunProps(rPrD.getElementsByTagNameNS(W_NS, 'rPr')[0]);
    const pPrD = dd.getElementsByTagNameNS(W_NS, 'pPrDefault')[0];
    if (pPrD) styles.defaultPPr = _readParaProps(pPrD.getElementsByTagNameNS(W_NS, 'pPr')[0]);
  }

  const styleEls = dom.getElementsByTagNameNS(W_NS, 'style');
  for (const st of styleEls) {
    const id = _attr(st, 'styleId');
    if (!id) continue;
    const basedOnEl = st.getElementsByTagNameNS(W_NS, 'basedOn')[0];
    const nameEl = st.getElementsByTagNameNS(W_NS, 'name')[0];
    // Only direct children pPr/rPr of the style element.
    let pPr = null, rPr = null;
    for (const c of st.childNodes) {
      if (c.nodeType !== 1) continue;
      if (c.localName === 'pPr') pPr = c;
      else if (c.localName === 'rPr') rPr = c;
    }
    styles.byId.set(id, {
      basedOn: basedOnEl ? _attr(basedOnEl, 'val') : null,
      name: nameEl ? (_attr(nameEl, 'val') || '') : '',
      pPr: _readParaProps(pPr),
      rPr: _readRunProps(rPr)
    });
  }
  return styles;
}

/** Resolve a style chain (basedOn) into merged pPr/rPr, memoized. */
function _resolveStyle(styles, styleId, memo, depth) {
  if (!styleId || !styles.byId.has(styleId)) return { pPr: {}, rPr: {}, name: '' };
  if (memo.has(styleId)) return memo.get(styleId);
  if (depth > 8) return { pPr: {}, rPr: {}, name: '' };
  const st = styles.byId.get(styleId);
  const base = st.basedOn ? _resolveStyle(styles, st.basedOn, memo, depth + 1) : { pPr: {}, rPr: {} };
  const resolved = {
    pPr: { ...base.pPr, ...st.pPr },
    rPr: { ...base.rPr, ...st.rPr },
    name: st.name
  };
  memo.set(styleId, resolved);
  return resolved;
}

// ------------------------------------------------------------------
// Inline content
// ------------------------------------------------------------------

/**
 * Walk the inline content of a paragraph and emit runs.
 * Handles w:r, w:hyperlink, w:ins (kept), w:del (skipped), w:sdt wrappers,
 * and embedded images (w:drawing -> a:blip).
 */
/** Update ctx.activeComments from every comment-range marker inside a subtree
 *  that is otherwise skipped (w:del / w:moveFrom), in document order, so a
 *  range that opens or closes inside deleted text is still tracked exactly. */
function _scanCommentMarkers(root, ctx) {
  if (!ctx.activeComments) return;
  const walk = (node) => {
    for (const c of node.childNodes) {
      if (c.nodeType !== 1) continue;
      if (c.localName === 'commentRangeStart') {
        const id = _attr(c, 'id');
        if (id !== null) ctx.activeComments.add(id);
      } else if (c.localName === 'commentRangeEnd') {
        const id = _attr(c, 'id');
        if (id !== null) ctx.activeComments.delete(id);
      } else {
        walk(c);
      }
    }
  };
  walk(root);
}

/**
 * The text inside a tracked DELETION (w:del / w:moveFrom).
 *
 * Word stores deleted text in w:delText, not w:t, and keeps tabs and breaks as
 * their own elements, so a plain textContent would miss the tabs and swallow
 * whatever else lives in the subtree (field codes, note numbers).
 */
function _deletedText(root) {
  let out = '';
  const walk = (node) => {
    for (const c of node.childNodes) {
      if (c.nodeType !== 1) continue;
      const n = c.localName;
      if (n === 'delText' || n === 't') out += c.textContent || '';
      else if (n === 'tab') out += '\t';
      else if (n === 'br' || n === 'cr') out += ' ';
      else if (n === 'rPr' || n === 'pPr') continue;
      else walk(c);
    }
  };
  walk(root);
  return out;
}

function _collectRuns(node, runs, ctx, linkUrl, baseRPr) {
  for (const child of node.childNodes) {
    if (child.nodeType !== 1) continue;
    const ln = child.localName;

    // Word comment RANGE markers (siblings of the runs): track which comment
    // ids are open so each run inside the range can be tagged and the preview
    // can highlight the covered text (Word-like), not just show an icon.
    if (ln === 'commentRangeStart') {
      const cid = _attr(child, 'id');
      if (cid !== null && ctx.activeComments) ctx.activeComments.add(cid);
      continue;
    }
    if (ln === 'commentRangeEnd') {
      const cid = _attr(child, 'id');
      if (cid !== null && ctx.activeComments) ctx.activeComments.delete(cid);
      continue;
    }

    if (ln === 'del' || ln === 'moveFrom') {
      // Deleted (tracked) text is not part of the model text: Final Check
      // reviews the document as it will be DELIVERED, that is, with every
      // change accepted. Comment-range markers may live INSIDE the deletion
      // (Word puts them there when a comment overlaps text that was later
      // deleted); skipping them left the range open forever and the highlight
      // ran on to the end of the document, so the subtree is still scanned for
      // markers.
      _scanCommentMarkers(child, ctx);
      // The words themselves ARE kept, so the source pane can show them struck
      // through on request -- as a run whose `t` is EMPTY, with the text in
      // `dt`. The empty `t` is what makes this safe: every consumer of `runs`
      // (the export, the transformations, the editor, and the character
      // offsets the checks and the eLUNa colours are measured in) already
      // skips a run with no text, so none of them can see it.
      const dt = _deletedText(child);
      if (dt) {
        runs.push({
          t: '', dt, del: true, moved: ln === 'moveFrom',
          author: _attr(child, 'author') || '', date: _attr(child, 'date') || '',
          fnRef: null, enRef: null, cmRef: null, img: null,
          cmRanges: (ctx.activeComments && ctx.activeComments.size) ? Array.from(ctx.activeComments) : null
        });
        if (ctx.trk) ctx.trk.any = true;
      }
      continue;
    }
    if (ln === 'pPr' ||
        ln === 'bookmarkStart' || ln === 'bookmarkEnd' || ln === 'proofErr') {
      continue;
    }

    if (ln === 'r') {
      const direct = _readRunProps(child.getElementsByTagNameNS(W_NS, 'rPr')[0]);
      const props = { ...baseRPr, ...direct };
      let buf = '';
      const mk = (extra) => ({
        t: '', b: !!props.b, i: !!props.i, u: !!props.u,
        sup: !!props.sup, sub: !!props.sub, strike: !!props.strike,
        caps: !!props.caps, smallCaps: !!props.smallCaps,
        sz: props.sz || null, color: props.color || null,
        highlight: props.highlight || null,
        fnRef: null, enRef: null, cmRef: null, link: linkUrl || null, img: null,
        // Ids of the Word comment ranges covering this run (null when none), so
        // the preview highlights the exact commented text.
        cmRanges: (ctx.activeComments && ctx.activeComments.size) ? Array.from(ctx.activeComments) : null,
        ...extra
      });
      const flush = () => {
        if (buf) { runs.push(mk({ t: buf })); buf = ''; }
      };
      for (const rc of child.childNodes) {
        if (rc.nodeType !== 1) continue;
        const rln = rc.localName;
        if (rln === 't') {
          buf += rc.textContent || '';
        } else if (rln === 'tab') {
          buf += '\t';
        } else if (rln === 'br') {
          // A line break (Shift+Enter) splits the paragraph into logical
          // lines; a page/column break does not (treat it as a space).
          const bt = _attr(rc, 'type');
          if (bt === 'page' || bt === 'column') { buf += ' '; }
          else { flush(); runs.push(mk({ brk: true, t: ' ' })); }
        } else if (rln === 'cr') {
          flush(); runs.push(mk({ brk: true, t: ' ' }));
        } else if (rln === 'noBreakHyphen') {
          buf += '-';
        } else if (rln === 'footnoteReference') {
          flush();
          // w:customMarkFollows: Word SUPPRESSES the automatic number and the
          // literal mark that follows in the same run ("*") is the visible
          // call. Flagged here; the literal run is absorbed in _makeParas.
          const cmf = _attr(rc, 'customMarkFollows');
          runs.push(mk({ sup: true, fnRef: _attr(rc, 'id'),
            noteCustom: cmf === '1' || cmf === 'true' }));
        } else if (rln === 'endnoteReference') {
          flush();
          const cme = _attr(rc, 'customMarkFollows');
          runs.push(mk({ sup: true, enRef: _attr(rc, 'id'),
            noteCustom: cme === '1' || cme === 'true' }));
        } else if (rln === 'commentReference') {
          // Word comment anchor: keep it as a zero-width run so the preview
          // can show a comment marker with the comment's text on hover.
          flush();
          runs.push(mk({ cmRef: _attr(rc, 'id') }));
        } else if (rln === 'fldChar') {
          // INDEX ENTRIES (XE fields). A field is a SEQUENCE of runs
          // (begin -> instrText -> end) and its code is not text: none of it
          // reaches the model, which is what makes an index entry impossible to
          // damage by editing the paragraph. But an entry that cannot be SEEN
          // cannot be checked or placed either, so each one leaves a zero-width
          // run carrying its code -- the same device the comment anchors use.
          // With no text it moves no offset, so nothing downstream can see it
          // unless it looks for `xe` on purpose.
          const fct = _attr(rc, 'fldCharType');
          if (fct === 'begin') { ctx.fld = { code: '' }; }
          else if (fct === 'end' && ctx.fld) {
            const code = ctx.fld.code.trim();
            ctx.fld = null;
            if (/^XE\b/i.test(code)) { flush(); runs.push(mk({ xe: code })); }
          }
        } else if (rln === 'instrText') {
          // The field code, which Word may split across several runs.
          if (ctx.fld) ctx.fld.code += rc.textContent || '';
        } else if (rln === 'drawing' || rln === 'pict' || rln === 'object') {
          const img = _extractImage(rc, ctx);
          if (img) { flush(); runs.push(mk({ img })); }
        }
      }
      flush();
      continue;
    }

    if (ln === 'hyperlink') {
      const rid = child.getAttributeNS(R_NS, 'id');
      const url = rid && ctx.rels.external[rid] ? ctx.rels.external[rid] : null;
      _collectRuns(child, runs, ctx, url || linkUrl, baseRPr);
      continue;
    }

    if (ln === 'ins' || ln === 'moveTo') {
      // Inserted text IS part of the document (the change is accepted), so it
      // is collected exactly as before. It is only FLAGGED, so the preview can
      // mark it when the reviewer asks to see the tracked changes. Flagging
      // afterwards, by position, avoids threading a "we are inside an
      // insertion" state through every recursive call.
      const from = runs.length;
      _collectRuns(child, runs, ctx, linkUrl, baseRPr);
      const author = _attr(child, 'author') || '';
      const date = _attr(child, 'date') || '';
      for (let i = from; i < runs.length; i++) {
        if (runs[i].ins || runs[i].del) continue;   // a nested change keeps its own
        runs[i].ins = true;
        runs[i].moved = ln === 'moveTo';
        runs[i].author = author;
        runs[i].date = date;
      }
      if (runs.length > from && ctx.trk) ctx.trk.any = true;
      continue;
    }

    if (ln === 'smartTag' || ln === 'fldSimple' || ln === 'sdt' || ln === 'sdtContent') {
      _collectRuns(child, runs, ctx, linkUrl, baseRPr);
      continue;
    }
  }
}

/** Extract an embedded image reference from a w:drawing / w:pict subtree. */
function _extractImage(drawingEl, ctx) {
  // DrawingML: a:blip r:embed="rIdX"
  const blips = drawingEl.getElementsByTagNameNS(A_NS, 'blip');
  let rid = null;
  if (blips.length) {
    rid = blips[0].getAttributeNS(R_NS, 'embed') || blips[0].getAttributeNS(R_NS, 'link');
  } else {
    // VML fallback: v:imagedata r:id="rIdX"
    const all = drawingEl.getElementsByTagName('*');
    for (const el of all) {
      if (el.localName === 'imagedata') {
        rid = el.getAttributeNS(R_NS, 'id') || el.getAttributeNS(R_NS, 'href');
        if (rid) break;
      }
    }
  }
  if (!rid) return null;
  const target = ctx.rels.internal[rid];
  if (!target) return null;

  // Displayed size from wp:extent (EMU), if present.
  let wPx = null, hPx = null;
  const all2 = drawingEl.getElementsByTagName('*');
  for (const el of all2) {
    if (el.localName === 'extent' && el.getAttribute('cx')) {
      wPx = _emuToPx(el.getAttribute('cx'));
      hPx = _emuToPx(el.getAttribute('cy'));
      break;
    }
  }

  // Normalize the media path relative to word/.
  let path = target.replace(/^\.\//, '');
  if (path.indexOf('../') === 0) path = path.slice(3);
  else if (path.indexOf('/') !== 0 && path.indexOf('word/') !== 0) path = 'word/' + path;
  ctx.mediaPaths.add(path);
  return { path, wPx, hPx };
}

/** Detect a list/heading label at the start of the paragraph text ("(a)", "IV.", "1.", "A."). */
function _detectListLabel(text) {
  const m = text.match(/^\s*(\(?[a-z]\)|\(?[ivxlcdm]{1,6}\)|\(?[IVXLCDM]{1,6}[.)]|\d{1,3}[.)]|[A-Z][.)])\s/);
  return m ? m[1] : null;
}

// A LITERAL list marker at the very start of a paragraph ("16.", "16)", "(a)",
// "(iv)"). These are removed from the COMPARISON text so a source that types
// its numbers by hand and a target that uses Word's automatic numbering are
// compared on equal terms (and the list number is never flagged as a missing
// figure). The display keeps the number via runs + listPrefix.
const _LEADING_MARKER_RE = /^\s*(\(?\d{1,3}[.)]|\(?[a-z]\)|\(?[ivxlcdm]{1,6}\))[ \t\u00a0]+/;

/**
 * Words of a list of paragraphs. A word is a run of non-space characters that
 * carries at least one letter or digit, so a stray dash or a lone bullet does
 * not inflate the count while "50 %" counts the figure and "art. 5" counts two.
 * Shared with pptx-model.js through the model contract, not by import: each
 * parser owns its own stats block.
 */
export function countWords(paras) {
  let n = 0;
  for (const p of (paras || [])) {
    const t = (p && p.text) || '';
    if (!t.trim()) continue;
    for (const tok of t.split(/\s+/)) {
      if (tok && /[A-Za-z\u00c0-\u024f0-9]/.test(tok)) n++;
    }
  }
  return n;
}
function _stripLeadingMarker(raw) {
  const m = raw.match(_LEADING_MARKER_RE);
  if (m && raw.length - m[0].length >= 1) {
    return { text: raw.slice(m[0].length), marker: m[1] };
  }
  return { text: raw, marker: null };
}

// ------------------------------------------------------------------
// Automatic list numbering (numbering.xml)
// ------------------------------------------------------------------

function _toRoman(n, upper) {
  if (n <= 0 || n >= 4000) return String(n);
  const table = [[1000,'m'],[900,'cm'],[500,'d'],[400,'cd'],[100,'c'],[90,'xc'],
                 [50,'l'],[40,'xl'],[10,'x'],[9,'ix'],[5,'v'],[4,'iv'],[1,'i']];
  let out = '';
  for (const [v, s] of table) { while (n >= v) { out += s; n -= v; } }
  return upper ? out.toUpperCase() : out;
}

// The four symbols Word cycles through for "chicago" numbering, doubled once
// the fourth is used up (*, dagger, double dagger, section; then **, and so
// on). It is how a footnote call is written when the document numbers its
// notes with signs instead of figures.
const _CHICAGO = ['*', '\u2020', '\u2021', '\u00a7'];

function _formatNum(val, fmt) {
  switch (fmt) {
    // Past the twenty-sixth item Word REPEATS the letter (aa, bb, cc), it does
    // not carry over like a number: the twenty-seventh note is "aa", not "ab".
    case 'lowerLetter':
      return String.fromCharCode(97 + ((val - 1) % 26)).repeat(Math.floor((val - 1) / 26) + 1);
    case 'upperLetter':
      return String.fromCharCode(65 + ((val - 1) % 26)).repeat(Math.floor((val - 1) / 26) + 1);
    case 'lowerRoman': return _toRoman(val, false);
    case 'upperRoman': return _toRoman(val, true);
    case 'decimalZero': return (val < 10 ? '0' : '') + val;
    case 'chicago': {
      // A file could say the count starts at 0 (or lower): never index the
      // table with a negative, which would throw and take the whole document
      // down instead of printing an odd sign.
      const k = Math.max(1, val) - 1;
      return _CHICAGO[k % 4].repeat(Math.floor(k / 4) + 1);
    }
    case 'none': return '';
    default: return String(val); // decimal and anything unsupported
  }
}

/** Parse word/numbering.xml into { abstract: Map, numToAbs: Map }. */
async function _parseNumbering(zip) {
  const num = { abstract: new Map(), numToAbs: new Map() };
  const f = zip.file('word/numbering.xml');
  if (!f) return num;
  let dom;
  try { dom = _parseXml(await f.async('string')); } catch (e) { return num; }

  for (const an of dom.getElementsByTagNameNS(W_NS, 'abstractNum')) {
    const absId = _attr(an, 'abstractNumId');
    if (absId === null) continue;
    const levels = new Map();
    for (const lvl of an.getElementsByTagNameNS(W_NS, 'lvl')) {
      const ilvl = _attr(lvl, 'ilvl');
      if (ilvl === null) continue;
      const numFmtEl = lvl.getElementsByTagNameNS(W_NS, 'numFmt')[0];
      const lvlTextEl = lvl.getElementsByTagNameNS(W_NS, 'lvlText')[0];
      const startEl = lvl.getElementsByTagNameNS(W_NS, 'start')[0];
      levels.set(String(ilvl), {
        numFmt: numFmtEl ? _attr(numFmtEl, 'val') : 'decimal',
        lvlText: lvlTextEl ? (_attr(lvlTextEl, 'val') || '') : ('%' + (parseInt(ilvl, 10) + 1) + '.'),
        start: startEl ? (parseInt(_attr(startEl, 'val'), 10) || 1) : 1
      });
    }
    num.abstract.set(absId, levels);
  }
  for (const n of dom.getElementsByTagNameNS(W_NS, 'num')) {
    const numId = _attr(n, 'numId');
    const absEl = n.getElementsByTagNameNS(W_NS, 'abstractNumId')[0];
    if (numId !== null && absEl) num.numToAbs.set(numId, _attr(absEl, 'val'));
  }
  return num;
}

/**
 * Compute the automatic list-number prefix for a paragraph ("16.", "a)", ...),
 * advancing the per-list counter state in ctx.numState. Returns '' when the
 * paragraph is not part of a numbered/bulleted list. Must be called in
 * document order (it is stateful).
 */
function _computeListPrefix(pPrEl, ctx) {
  if (!pPrEl || !ctx.numbering) return '';
  const numPr = pPrEl.getElementsByTagNameNS(W_NS, 'numPr')[0];
  if (!numPr) return '';
  const numIdEl = numPr.getElementsByTagNameNS(W_NS, 'numId')[0];
  if (!numIdEl) return '';
  const numId = _attr(numIdEl, 'val');
  if (numId === null || numId === '0') return ''; // numId 0 = numbering removed
  const ilvlEl = numPr.getElementsByTagNameNS(W_NS, 'ilvl')[0];
  const ilvl = ilvlEl ? (parseInt(_attr(ilvlEl, 'val'), 10) || 0) : 0;

  const absId = ctx.numbering.numToAbs.get(numId);
  if (absId === undefined) return '';
  const levels = ctx.numbering.abstract.get(absId);
  if (!levels) return '';
  const lvlDef = levels.get(String(ilvl));
  if (!lvlDef || lvlDef.numFmt === 'none') return '';

  // Per-list counter array (index = level). Advance this level, reset deeper.
  let counters = ctx.numState.get(numId);
  if (!counters) { counters = []; ctx.numState.set(numId, counters); }
  counters[ilvl] = counters[ilvl] === undefined ? lvlDef.start : counters[ilvl] + 1;
  for (let d = ilvl + 1; d < counters.length; d++) counters[d] = undefined;

  if (lvlDef.numFmt === 'bullet') return '\u2022';

  let out = lvlDef.lvlText || ('%' + (ilvl + 1) + '.');
  out = out.replace(/%(\d)/g, (mm, d) => {
    const li = parseInt(d, 10) - 1;
    const lv = levels.get(String(li));
    const val = counters[li] !== undefined ? counters[li] : (lv ? lv.start : 1);
    return _formatNum(val, lv ? lv.numFmt : 'decimal');
  });
  return out;
}

/**
 * Build the logical paragraphs for a single <w:p>. A paragraph is split at
 * line breaks (<w:br/> / <w:cr>) into one logical paragraph PER LINE, because
 * UN documents frequently number items with a manual "12." + a line break
 * instead of a real paragraph mark. Splitting keeps the source (line-break
 * numbered) and the target (real-paragraph numbered) at the same granularity,
 * which the aligner and the checks depend on. Returns the created paragraphs
 * (already pushed to model.paras).
 */
function _makeParas(pEl, loc, ctx, model) {
  // Paragraph style + direct formatting.
  let styleId = null;
  let pPrEl = null;
  for (const c of pEl.childNodes) {
    if (c.nodeType === 1 && c.localName === 'pPr') { pPrEl = c; break; }
  }
  if (pPrEl) {
    const st = pPrEl.getElementsByTagNameNS(W_NS, 'pStyle')[0];
    if (st) styleId = _attr(st, 'val');
  }
  const resolved = _resolveStyle(ctx.styles, styleId, ctx.styleMemo, 0);
  const directPPr = _readParaProps(pPrEl);
  const fmt = { ...ctx.styles.defaultPPr, ...resolved.pPr, ...directPPr };
  const baseRPr = { ...ctx.styles.defaultRPr, ...resolved.rPr };

  // Automatic list number (numbers the paragraph, i.e. its FIRST line).
  const listPrefix = _computeListPrefix(pPrEl, ctx);

  // Heading detection: style id/name or outline level.
  let isHeading = false;
  const sid = (styleId || '').toLowerCase();
  const sname = (resolved.name || '').toLowerCase();
  if (sid.indexOf('heading') === 0 || sid.indexOf('title') === 0 ||
      sname.indexOf('heading') === 0 || sname.indexOf('title') === 0) isHeading = true;
  if (pPrEl && pPrEl.getElementsByTagNameNS(W_NS, 'outlineLvl')[0]) isHeading = true;

  const allRuns = [];
  // A field never spans two paragraphs: start each one with no field open, so
  // a file with an unbalanced field cannot swallow the paragraphs after it.
  ctx.fld = null;
  _collectRuns(pEl, allRuns, ctx, null, baseRPr);

  // Custom-marked note calls: the literal mark run that follows the reference
  // ("*", "**", a dagger...) IS the visible call, so absorb it into the
  // reference run (customMark). Without this the preview showed BOTH the
  // computed number and the literal mark ("1*"). Only short symbol runs are
  // absorbed, defensively.
  for (let ri = 0; ri < allRuns.length; ri++) {
    const rr = allRuns[ri];
    if (!rr.noteCustom || !(rr.fnRef || rr.enRef)) continue;
    const nxt = allRuns[ri + 1];
    if (nxt && nxt.t && !nxt.fnRef && !nxt.enRef && !nxt.img && !nxt.brk &&
        /^[^A-Za-z0-9]{1,3}\s*$/.test(nxt.t)) {
      rr.customMark = nxt.t.trim();
      allRuns.splice(ri + 1, 1);
    } else {
      rr.customMark = ''; // number still suppressed; any literal renders as text
    }
  }

  // Number the index entries in DOCUMENT order within this <w:p>. The count is
  // the WHOLE paragraph element's, not the logical line's, because that is what
  // the export counts when it has to find the k-th field in the XML.
  let xeSeq = 0;
  for (const r of allRuns) if (r.xe) r.xeIdx = xeSeq++;

  // Split the paragraph into logical paragraphs ONLY at line breaks that begin
  // a manually numbered item ("12. ...<br>13. ..."). A line break that is just
  // a soft wrap (an address, a list of names) is KEPT inside the paragraph and
  // rendered as a visual <br>, so the granularity still matches a target that
  // does not use those breaks. This is what a blind split got wrong.
  const lines = [];   // each line = array of runs
  const seps = [];    // seps[k] = the break run between lines[k] and lines[k+1]
  let curLine = [];
  for (const r of allRuns) {
    if (r.brk) { lines.push(curLine); seps.push(r); curLine = []; }
    else curLine.push(r);
  }
  lines.push(curLine);

  const segments = [];
  let cur = null;
  for (let li = 0; li < lines.length; li++) {
    const lineText = lines[li].map(r => r.t).join('');
    const startsWithMarker = _LEADING_MARKER_RE.test(lineText);
    if (li === 0 || startsWithMarker) {
      cur = [];
      segments.push(cur);
    } else {
      cur.push(seps[li - 1]); // soft break: visible <br>, same logical paragraph
    }
    for (const r of lines[li]) cur.push(r);
  }

  const total = segments.length;
  const made = [];
  for (let si = 0; si < segments.length; si++) {
    const segRuns = segments[si];
    const hasContent = segRuns.some(r => r.t || r.fnRef || r.enRef || r.img);
    // Drop blank continuation lines (double break) to avoid alignment noise,
    // but always keep a paragraph when the <w:p> has a single (possibly empty)
    // segment so structural empty paragraphs survive.
    if (!hasContent && total > 1) continue;

    const rawText = segRuns.map(r => r.t).join('');
    const prefix = si === 0 ? listPrefix : '';
    // Detect a LITERAL leading marker but do NOT remove it from `text`: the
    // renderer highlights character spans that the checks compute against
    // `text`, so `text` must stay aligned with the runs. Checks and the aligner
    // skip the marker region themselves (see markerLen / _features).
    const { marker } = _stripLeadingMarker(rawText);
    const fnRefs = segRuns.filter(r => r.fnRef !== null && r.fnRef !== undefined && r.fnRef).map(r => r.fnRef);

    const para = {
      id: model.paras.length,
      text: rawText,      // comparison text == run text (spans stay aligned)
      listPrefix: prefix, // automatic number/bullet shown before the text
      listMarker: marker, // literal leading marker present in `text` (or null)
      runs: segRuns,
      loc,
      fmt,
      isHeading,
      listLabel: prefix ? prefix.trim() : (marker || _detectListLabel(rawText)),
      fnRefs,
      _el: pEl,
      _seg: { index: si, total }
    };
    model.paras.push(para);
    for (const id of fnRefs) model.fnRefOrder.push(id);
    made.push(para);
  }

  // All-empty <w:p>: keep one empty paragraph so block/cell structure holds.
  if (made.length === 0) {
    const para = {
      id: model.paras.length, text: '', listPrefix: listPrefix, listMarker: null,
      runs: [], loc, fmt, isHeading, listLabel: null, fnRefs: [],
      _el: pEl, _seg: { index: 0, total: 1 }
    };
    model.paras.push(para);
    made.push(para);
  }
  return made;
}

// ------------------------------------------------------------------
// Body / tables
// ------------------------------------------------------------------

function _cellShade(tcPr) {
  const shd = tcPr ? tcPr.getElementsByTagNameNS(W_NS, 'shd')[0] : null;
  if (!shd) return null;
  const fill = _attr(shd, 'fill');
  if (fill && fill !== 'auto' && fill.toLowerCase() !== 'ffffff') return '#' + fill;
  return null;
}

function _walkBody(bodyEl, model, ctx) {
  for (const child of bodyEl.childNodes) {
    if (child.nodeType !== 1) continue;
    const ln = child.localName;

    if (ln === 'p') {
      const paras = _makeParas(child, { area: 'body', table: null, row: -1, col: -1, fnId: null }, ctx, model);
      for (const p of paras) model.blocks.push({ type: 'p', paraId: p.id });
      continue;
    }

    if (ln === 'tbl') {
      const tIdx = model.tables.length;
      const table = { idx: tIdx, rows: [], hasBorders: false, gridCols: [] };
      model.tables.push(table);
      model.blocks.push({ type: 'table', tIdx });

      // Borders: any tblBorders/tcBorders with a real border style?
      const tblPr = child.getElementsByTagNameNS(W_NS, 'tblPr')[0];
      if (tblPr) {
        const borders = tblPr.getElementsByTagNameNS(W_NS, 'tblBorders')[0];
        if (borders) {
          for (const b of borders.childNodes) {
            if (b.nodeType === 1) {
              const v = _attr(b, 'val');
              if (v && v !== 'none' && v !== 'nil') { table.hasBorders = true; break; }
            }
          }
        }
      }

      // Column grid (relative widths).
      const grid = child.getElementsByTagNameNS(W_NS, 'tblGrid')[0];
      if (grid) {
        for (const gc of grid.childNodes) {
          if (gc.nodeType === 1 && gc.localName === 'gridCol') {
            const w = parseInt(gc.getAttributeNS(W_NS, 'w'), 10);
            table.gridCols.push(isNaN(w) ? 0 : w);
          }
        }
      }

      const trs = [];
      for (const tc of child.childNodes) {
        if (tc.nodeType === 1 && tc.localName === 'tr') trs.push(tc);
      }
      for (let r = 0; r < trs.length; r++) {
        const rowCells = [];
        const tcs = [];
        for (const cc of trs[r].childNodes) {
          if (cc.nodeType === 1 && cc.localName === 'tc') tcs.push(cc);
        }
        for (let c = 0; c < tcs.length; c++) {
          const tcPr = tcs[c].getElementsByTagNameNS(W_NS, 'tcPr')[0];
          let gridSpan = 1, vMerge = null;
          if (tcPr) {
            const gs = tcPr.getElementsByTagNameNS(W_NS, 'gridSpan')[0];
            if (gs) { const v = parseInt(_attr(gs, 'val'), 10); if (!isNaN(v) && v > 1) gridSpan = v; }
            const vm = tcPr.getElementsByTagNameNS(W_NS, 'vMerge')[0];
            if (vm) vMerge = (_attr(vm, 'val') === 'restart') ? 'restart' : 'cont';
            const tcBorders = tcPr.getElementsByTagNameNS(W_NS, 'tcBorders')[0];
            if (tcBorders && !table.hasBorders) {
              for (const b of tcBorders.childNodes) {
                if (b.nodeType === 1) {
                  const v = _attr(b, 'val');
                  if (v && v !== 'none' && v !== 'nil') { table.hasBorders = true; break; }
                }
              }
            }
          }
          const cell = { paraIds: [], gridSpan, vMerge, shade: _cellShade(tcPr) };
          // All paragraphs inside the cell, incl. nested-table ones (flattened).
          const ps = tcs[c].getElementsByTagNameNS(W_NS, 'p');
          for (const p of ps) {
            const paras = _makeParas(p, { area: 'body', table: tIdx, row: r, col: c, fnId: null }, ctx, model);
            for (const pr of paras) cell.paraIds.push(pr.id);
          }
          rowCells.push(cell);
        }
        table.rows.push(rowCells);
      }
      continue;
    }

    if (ln === 'sdt') {
      const content = child.getElementsByTagNameNS(W_NS, 'sdtContent')[0];
      if (content) _walkBody(content, model, ctx);
    }
  }
}

/**
 * HOW WORD NUMBERS THE NOTES OF THIS DOCUMENT.
 *
 * The panel used to number them itself -- 1, 2, 3 by order of appearance --
 * and that is only right when the document happens to agree. A chapter lifted
 * out of a volume starts at 47; a document may number its notes with roman
 * figures, with letters, or with the signs *, dagger, double dagger, section;
 * and the reviewer reads those numbers in Word, quotes them in the revision
 * and looks for them in the index. A chip that says "1" where Word says "47"
 * is not a smaller truth, it is a different note.
 *
 * WHERE IT IS WRITTEN. `w:footnotePr` (and `w:endnotePr`) in settings.xml
 * carries the defaults; a section may override them in its own `w:sectPr`.
 * The FIRST NUMBER is the exception: it is the section's own, or 1 (see
 * _parseNoteNumbering) -- Word does not take it from settings.xml.
 * Three things matter: the FORMAT (`w:numFmt`), the FIRST number
 * (`w:numStart`) and WHEN THE COUNT RESTARTS (`w:numRestart`).
 *
 * SECTION BY SECTION. Each section numbers its own notes with its own
 * properties, and a section that says nothing inherits settings.xml. A section
 * that restarts (`eachSect`) begins again at its own first number; a
 * `continuous` one carries on the count of the section before it. A document
 * cut out of a volume is typically a first section starting at 17 followed by
 * a section that restarts: the notes of the first print 17, 18, 19...
 *
 * WHAT IT REFUSES TO ANSWER, and this is the important half. A number nobody
 * can be sure of is worse than an honest 1, 2, 3, because it would be quoted.
 * So the reading is given up -- and says so, through `exact:false` -- when a
 * section holding notes:
 *   - restarts the count on every PAGE, which cannot be known without laying
 *     the document out,
 *   - uses a format this file does not know how to write,
 *   - carries on the count (`continuous`) and yet names a first number of its
 *     own different from the first section's, which Word's own dialog leaves
 *     unclear.
 * In every one of those the panel goes back to counting from 1, exactly as it
 * did before, and the tooltip of the call says the number is the panel's own.
 */
const _KNOWN_NUMFMT = ['decimal', 'decimalZero', 'lowerLetter', 'upperLetter',
                       'lowerRoman', 'upperRoman', 'chicago'];

function _readNotePr(prEl) {
  if (!prEl) return null;
  const one = (name) => {
    // DIRECT children only: a <w:sectPr> nested in a paragraph must not read
    // the properties of the section that follows it.
    for (const c of prEl.childNodes) {
      if (c.nodeType === 1 && c.localName === name) return c;
    }
    return null;
  };
  const fmtEl = one('numFmt'), startEl = one('numStart'), restartEl = one('numRestart');
  if (!fmtEl && !startEl && !restartEl) return null;
  const start = startEl ? parseInt(_attr(startEl, 'val'), 10) : NaN;
  return {
    fmt: fmtEl ? (_attr(fmtEl, 'val') || '') : '',
    start: isNaN(start) ? null : start,
    restart: restartEl ? (_attr(restartEl, 'val') || '') : ''
  };
}

/** The `w:footnotePr` / `w:endnotePr` of a part, wherever they hang. */
function _notePrIn(rootEl, tag) {
  const out = [];
  if (!rootEl) return out;
  for (const el of rootEl.getElementsByTagNameNS(W_NS, tag)) {
    const pr = _readNotePr(el);
    if (pr) out.push(pr);
  }
  return out;
}

/**
 * Section of every <w:p> of the body, by index. A <w:sectPr> inside a
 * paragraph's properties ENDS a section after that paragraph; the last section
 * is the one whose <w:sectPr> hangs off <w:body> itself. Also returns, in the
 * same order, the <w:sectPr> of each section (null when the file has none).
 */
function _bodySections(bodyEl) {
  const secOfEl = new Map();
  const sectPrs = [];
  let s = 0;
  const direct = (el, name) => {
    for (const c of el.childNodes) {
      if (c.nodeType === 1 && c.localName === name) return c;
    }
    return null;
  };
  for (const p of bodyEl.getElementsByTagNameNS(W_NS, 'p')) {
    secOfEl.set(p, s);
    const pPr = direct(p, 'pPr');
    const sp = pPr ? direct(pPr, 'sectPr') : null;
    if (sp) { sectPrs.push(sp); s++; }
  }
  sectPrs.push(direct(bodyEl, 'sectPr'));
  return { secOfEl, sectPrs };
}

async function _parseNoteNumbering(zip, bodyEl, tag) {
  const dflt = { fmt: tag === 'endnotePr' ? 'lowerRoman' : 'decimal', start: 1, restart: 'continuous' };
  let base = null;
  const sf = zip.file('word/settings.xml');
  if (sf) {
    try {
      const dom = _parseXml(await sf.async('string'));
      base = _notePrIn(dom, tag)[0] || null;
    } catch (e) { base = null; }
  }
  // Each section's own properties, field by field over settings.xml and
  // Word's defaults. `ownStart` says whether the section itself names its
  // first number (see _printedNoteLabels on a continuous count).
  //
  // EXCEPT THE FIRST NUMBER, which is the SECTION's or 1, never settings.xml.
  // Word numbers notes section by section: on a Repertoire part (original
  // side) Word printed 1, 2... where the panel, taking the first number from
  // settings.xml -- a value a part cut out of a volume can carry over from
  // the volume -- printed 146, 147..., and the two documents no longer agreed
  // on a single note number.
  const { sectPrs } = _bodySections(bodyEl);
  const sections = sectPrs.map(sp => {
    let own = null;
    if (sp) {
      for (const c of sp.childNodes) {
        if (c.nodeType === 1 && c.localName === tag) { own = _readNotePr(c); break; }
      }
    }
    const has = (o, k) => !!(o && o[k] !== null && o[k] !== undefined && o[k] !== '');
    const pickField = (k) => has(own, k) ? own[k]
      : ((k !== 'start' && has(base, k)) ? base[k] : dflt[k]);
    const rawStart = pickField('start');
    return {
      fmt: pickField('fmt'),
      // Word counts from 1 upwards; a file that says otherwise is not a
      // reason to start writing negative note numbers.
      start: rawStart >= 1 ? rawStart : 1,
      restart: pickField('restart'),
      ownStart: !!(own && own.start !== null && own.start !== undefined)
    };
  });
  const first = sections[0];
  // `fmt`, `start` and `restart` describe the first section until the notes
  // are numbered (_printedNoteLabels), which sets them from the first note
  // Word numbers and decides `exact`.
  // The first number settings.xml names and no longer counts (see above),
  // kept so the tooltip of the Footnotes counter can say why it is not used.
  const settingsStart = (base && base.start !== null && base.start !== undefined) ? base.start : null;
  return { fmt: first.fmt, start: first.start, restart: first.restart,
    sectionCount: sections.length, sections, exact: true, bySection: false, settingsStart };
}

/**
 * WHAT WORD PRINTS for each note of `list`, following the numbering of the
 * section its call sits in (see the notes above _KNOWN_NUMFMT). Returns a Map
 * note id -> printed label, or null when the numbers cannot be worked out, in
 * which case `info.exact` is set to false and the caller shows 1, 2, 3.
 *
 * @param {Array} list        the notes (footnotes or endnotes) of the model
 * @param {Object} info       from _parseNoteNumbering; updated in place
 * @param {Map} callSec       note id -> section index of its FIRST call
 * @param {Map} callPos       note id -> position of its first call in the text
 * @param {Map} marks         note id -> custom mark (these take no number)
 */
function _printedNoteLabels(list, info, callSec, callPos, marks) {
  const give = () => { info.exact = false; return null; };
  const secs = info.sections || [];
  const numbered = list.filter(n => !marks.has(n.id));
  if (!numbered.length) return new Map();
  // Word numbers the notes in the order their calls appear in the text.
  const inOrder = numbered.slice().sort((a, b) => {
    const pa = callPos.has(String(a.id)) ? callPos.get(String(a.id)) : Infinity;
    const pb = callPos.has(String(b.id)) ? callPos.get(String(b.id)) : Infinity;
    return pa - pb;
  });
  const labels = new Map();
  let counter = null, curSec = -1, firstSec = -1;
  for (const n of inOrder) {
    const s = callSec.get(String(n.id));
    if (s === undefined || s < curSec) return give();  // call not placed in the body
    const pr = secs[s];
    if (!pr || pr.restart === 'eachPage') return give();
    if (_KNOWN_NUMFMT.indexOf(pr.fmt) === -1) return give();
    // Walk every section entered since the previous note: the count begins
    // at the first section's number, a restarting section begins again at its
    // own, and a continuous one carries on.
    for (let k = curSec + 1; k <= s; k++) {
      const pk = secs[k];
      if (!pk) return give();
      if (k === 0) { counter = pk.start; continue; }
      if (pk.restart === 'eachSect') {
        counter = pk.start;
        if (firstSec !== -1) info.bySection = true;
      } else if (pk.ownStart && pk.start !== secs[0].start) {
        return give();
      }
    }
    curSec = s;
    if (firstSec === -1) { firstSec = s; info.start = counter; info.fmt = pr.fmt; info.restart = pr.restart; }
    labels.set(n.id, _formatNum(counter, pr.fmt));
    counter++;
  }
  return labels;
}

/**
 * Ids of the notes the document CALLS, read from the calls already in the
 * model (key 'fnRef' or 'enRef'). A note is only shown by Word when a call
 * points at it, so this is the set of notes the reader can actually see.
 */
function _noteCallIds(model, key) {
  const ids = new Set();
  for (const p of model.paras) {
    for (const r of p.runs) {
      if (r[key] !== null && r[key] !== undefined && r[key] !== '') ids.add(String(r[key]));
    }
  }
  return ids;
}

/**
 * `called`: the ids of the notes the document calls (see _noteCallIds). A note
 * NO call points at is skipped: Word does not show it, so Final Check must not
 * show, count or check it either. A DOCX cut out of a bigger one keeps the
 * WHOLE notes part of the original -- 2587 notes behind a text that calls 41
 * -- and all of them used to appear. They are left untouched in the XML (the
 * export writes the part back whole), they are simply not part of the model.
 */
async function _parseNotes(zip, path, noteLocalName, area, ctx, model, outList, called) {
  const f = zip.file(path);
  if (!f) return;
  let dom;
  try {
    dom = _parseXml(await f.async('string'));
  } catch (e) { return; }
  if (model._parts) model._parts[area] = dom; // keep for track-changes export
  const notes = dom.getElementsByTagNameNS(W_NS, noteLocalName);
  for (const note of notes) {
    const type = note.getAttributeNS(W_NS, 'type') || '';
    if (type && type !== 'normal') continue; // separator / continuation entries
    const id = note.getAttributeNS(W_NS, 'id');
    if (called && !called.has(String(id))) continue; // not called: Word hides it
    const entry = { id, paraIds: [], text: '' };
    const ps = note.getElementsByTagNameNS(W_NS, 'p');
    for (const p of ps) {
      const paras = _makeParas(p, { area, table: null, row: -1, col: -1, fnId: id }, ctx, model);
      for (const pr of paras) entry.paraIds.push(pr.id);
    }
    entry.text = entry.paraIds.map(pid => model.paras[pid].text).join(' ').trim();
    outList.push(entry);
  }
}

const MIME_BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  bmp: 'image/bmp', webp: 'image/webp', svg: 'image/svg+xml', emf: null, wmf: null
};

/** Load referenced media files as data URLs (skips unsupported formats). */
async function _loadMedia(zip, mediaPaths) {
  const media = {};
  for (const path of mediaPaths) {
    const ext = (path.split('.').pop() || '').toLowerCase();
    const mime = MIME_BY_EXT[ext];
    if (!mime) continue; // EMF/WMF etc. cannot be shown in the browser
    const f = zip.file(path);
    if (!f) continue;
    try {
      const b64 = await f.async('base64');
      // Cap at ~4 MB per image to keep the preview responsive.
      if (b64.length > 5.6e6) continue;
      media[path] = 'data:' + mime + ';base64,' + b64;
    } catch (e) { /* ignore broken media */ }
  }
  return media;
}

/**
 * Parse a DOCX File/ArrayBuffer into the Final Check document model.
 */
export async function parseDocxModel(file) {
  const JSZip = await getJSZip();
  const arrayBuffer = file instanceof ArrayBuffer ? file : await file.arrayBuffer();
  const zip = await JSZip.loadAsync(arrayBuffer);
  // The pictures of the file AS LOADED, for the check of every export
  // (export-verify.js): the export writes into this same zip, so this is the
  // only moment the original can be counted.
  let imgCensus = null;
  try { imgCensus = await imageCensus(zip); } catch (_) { imgCensus = null; }

  const docFile = zip.file('word/document.xml');
  if (!docFile) throw new Error('No se encontr\u00f3 word/document.xml. \u00bfEs un DOCX v\u00e1lido?');

  const styles = await _parseStyles(zip);
  const numbering = await _parseNumbering(zip);
  const docRels = await _parseRels(zip, 'word/_rels/document.xml.rels');
  const fnRels = await _parseRels(zip, 'word/_rels/footnotes.xml.rels');
  const enRels = await _parseRels(zip, 'word/_rels/endnotes.xml.rels');

  // Keep the document rels DOM so hyperlink activation (phase 3) can add
  // external relationships and re-serialize this part.
  let relsDom = null;
  const relsFile = zip.file('word/_rels/document.xml.rels');
  if (relsFile) { try { relsDom = _parseXml(await relsFile.async('string')); } catch (e) { /* keep null */ } }

  const docDom = _parseXml(await docFile.async('string'));
  const bodyEl = docDom.getElementsByTagNameNS(W_NS, 'body')[0];
  if (!bodyEl) throw new Error('No se encontr\u00f3 el cuerpo del documento.');

  const model = {
    kind: 'docx',
    fileName: (file && file.name) || '',
    // A copy of the ORIGINAL bytes: the writers (doc-writer.js) re-parse them
    // into a fresh model and never touch the displayed one.
    _bytes: arrayBuffer.slice(0),
    paras: [],
    blocks: [],
    tables: [],
    footnotes: [],
    endnotes: [],
    fnRefOrder: [],
    media: {},
    stats: {},
    // Export support (phase 2): keep the live parts so edits made to para._el
    // can be re-serialized with track changes. Keyed by loc.area.
    _zip: zip,
    _imageCensus: imgCensus,
    _parts: { body: docDom, footnote: null, endnote: null },
    _partPath: { body: 'word/document.xml', footnote: 'word/footnotes.xml', endnote: 'word/endnotes.xml' },
    _relsDom: relsDom,
    _relsPath: 'word/_rels/document.xml.rels'
  };

  // Relationship DOMs PER PART (body / footnotes / endnotes). A hyperlink
  // activated by a transformation must register its relationship in the rels
  // part of the XML part that CONTAINS it: a URL inside a footnote goes to
  // word/_rels/footnotes.xml.rels, NOT to document.xml.rels. Registering it in
  // the wrong part leaves a dangling r:id, which Word reports as "unreadable
  // content" and strips on recovery (losing the link). A missing rels part
  // starts as an empty Relationships document (the [Content_Types].xml default
  // for the .rels extension always covers it, so adding the part is valid OPC).
  const loadRels = async (path) => {
    const rf = zip.file(path);
    if (rf) { try { return _parseXml(await rf.async('string')); } catch (e) { return null; } }
    return _parseXml('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>');
  };
  model._areaRels = {
    body: { dom: relsDom, path: 'word/_rels/document.xml.rels' },
    footnote: { dom: await loadRels('word/_rels/footnotes.xml.rels'), path: 'word/_rels/footnotes.xml.rels' },
    endnote: { dom: await loadRels('word/_rels/endnotes.xml.rels'), path: 'word/_rels/endnotes.xml.rels' }
  };

  const mediaPaths = new Set();
  const styleMemo = new Map();
  // Shared across the three parts, so "this file has tracked changes" is true
  // whether the change is in the body, a footnote or an endnote.
  const trk = { any: false };
  const ctxDoc = { rels: docRels, styles, styleMemo, mediaPaths, numbering, numState: new Map(), activeComments: new Set(), trk };
  const ctxFn = { rels: fnRels, styles, styleMemo, mediaPaths, numbering, numState: new Map(), activeComments: new Set(), trk };
  const ctxEn = { rels: enRels, styles, styleMemo, mediaPaths, numbering, numState: new Map(), activeComments: new Set(), trk };

  _walkBody(bodyEl, model, ctxDoc);
  // Only the notes the text calls (see _parseNotes). The endnote calls are
  // collected AFTER the footnotes are parsed, so a call that sits inside a
  // footnote still counts.
  await _parseNotes(zip, 'word/footnotes.xml', 'footnote', 'footnote', ctxFn, model, model.footnotes,
    _noteCallIds(model, 'fnRef'));
  await _parseNotes(zip, 'word/endnotes.xml', 'endnote', 'endnote', ctxEn, model, model.endnotes,
    _noteCallIds(model, 'enRef'));

  // Word COMMENTS (word/comments.xml): reviewers sometimes leave important
  // information there. Each comment is kept as { id, author, date, text } and
  // surfaced in the preview at its commentReference anchor.
  model.comments = [];
  model.commentById = new Map();
  const commentsFile = zip.file('word/comments.xml');
  if (commentsFile) {
    try {
      const cmDom = _parseXml(await commentsFile.async('string'));
      for (const c of cmDom.getElementsByTagNameNS(W_NS, 'comment')) {
        const texts = [];
        for (const t of c.getElementsByTagNameNS(W_NS, 't')) {
          if (t.textContent) texts.push(t.textContent);
        }
        const cm = {
          id: _attr(c, 'id'),
          author: _attr(c, 'author') || '',
          date: _attr(c, 'date') || '',
          text: texts.join(' ').replace(/\s+/g, ' ').trim()
        };
        model.comments.push(cm);
        model.commentById.set(cm.id, cm);
      }
    } catch (e) { /* comments are optional; ignore a malformed part */ }
  }

  // SAFETY NET: a comment whose end marker lives somewhere the parser never
  // visits (a text box, an unforeseen container) would stay "open" and wrongly
  // highlight everything after it. Any id still open after walking its part
  // loses its range tags entirely: that comment falls back to the point bubble
  // at its anchor, which is always correct and never over-highlights.
  const unclosed = new Set();
  for (const c of [ctxDoc, ctxFn, ctxEn]) {
    if (c.activeComments) for (const id of c.activeComments) unclosed.add(id);
  }
  if (unclosed.size) {
    for (const p of model.paras) {
      for (const r of p.runs) {
        if (!r.cmRanges) continue;
        const kept = r.cmRanges.filter(id => !unclosed.has(id));
        r.cmRanges = kept.length ? kept : null;
      }
    }
  }

  // Which comments actually cover a run of text (have a highlightable range).
  // A ranged comment is shown as highlighted text (no icon); a point comment
  // (reference only, no range) keeps a small marker so it is still findable.
  model.commentRangeIds = new Set();
  for (const p of model.paras) {
    for (const r of p.runs) {
      if (r.cmRanges) for (const cid of r.cmRanges) model.commentRangeIds.add(cid);
    }
  }

  // ONLY THE COMMENTS THE DOCUMENT SHOWS. Word shows a comment only where the
  // text anchors it (its range or its reference mark). A DOCX cut out of a
  // bigger one keeps the WHOLE comments part of the original, so comments
  // with no anchor left in this piece were listed and counted as if they were
  // in it. Same rule as the notes (see _parseNotes): kept in the XML, left out
  // of the model.
  const anchoredComments = new Set();
  for (const id of model.commentRangeIds) anchoredComments.add(String(id));
  for (const p of model.paras) {
    for (const r of p.runs) {
      if (r.cmRef !== null && r.cmRef !== undefined) anchoredComments.add(String(r.cmRef));
    }
  }
  model.comments = model.comments.filter(c => anchoredComments.has(String(c.id)));
  model.commentById = new Map(model.comments.map(c => [c.id, c]));

  model.media = await _loadMedia(zip, mediaPaths);

  // Order footnotes by their first reference in the body, so "footnote N" means
  // the same thing in both documents even if the XML lists them differently.
  const orderIndex = new Map();
  model.fnRefOrder.forEach((id, i) => { if (!orderIndex.has(id)) orderIndex.set(id, i); });
  model.footnotes.sort((a, b) => {
    const ai = orderIndex.has(a.id) ? orderIndex.get(a.id) : 1e9;
    const bi = orderIndex.has(b.id) ? orderIndex.get(b.id) : 1e9;
    return ai - bi;
  });
  // Custom-marked notes (w:customMarkFollows) show their literal mark ("*")
  // and do NOT consume an automatic number in Word, so the numbering must
  // skip them or every following note would be off by one.
  const fnMarks = new Map(), enMarks = new Map();
  for (const p of model.paras) {
    for (const r of p.runs) {
      if (r.customMark === undefined || r.customMark === null) continue;
      if (r.fnRef) fnMarks.set(r.fnRef, r.customMark);
      else if (r.enRef) enMarks.set(r.enRef, r.customMark);
    }
  }
  // WHAT WORD PRINTS beside the word, read from the document's own numbering
  // (see _parseNoteNumbering). It is kept APART from `num`: `num` is the
  // panel's own count, 1..N, and everything that has to line two texts up --
  // the "[[n5]]" marker of the edit box, the projection the export diffs
  // against, the ordinals a transformation is written by -- is built on it and
  // must stay unique and stable. `label` is only ever read by an eye.
  model.fnNumInfo = await _parseNoteNumbering(zip, bodyEl, 'footnotePr');
  model.enNumInfo = await _parseNoteNumbering(zip, bodyEl, 'endnotePr');
  // Where each note is CALLED: the section of its first call (its numbering
  // depends on it) and the call's position in the text (Word numbers in that
  // order).
  const { secOfEl } = _bodySections(bodyEl);
  const callSec = { fn: new Map(), en: new Map() };
  const callPos = { fn: new Map(), en: new Map() };
  let callN = 0;
  for (const p of model.paras) {
    if (p.loc.area !== 'body') continue;
    const sec = secOfEl.get(p._el);
    for (const r of p.runs) {
      const k = r.fnRef ? 'fn' : (r.enRef ? 'en' : null);
      if (!k) continue;
      const id = String(r.fnRef || r.enRef);
      if (callPos[k].has(id)) continue;
      callPos[k].set(id, callN++);
      if (sec !== undefined) callSec[k].set(id, sec);
    }
  }
  const fnPrinted = _printedNoteLabels(model.footnotes, model.fnNumInfo, callSec.fn, callPos.fn, fnMarks);
  const enPrinted = _printedNoteLabels(model.endnotes, model.enNumInfo, callSec.en, callPos.en, enMarks);
  const labelOf = (printedMap, id, num, mark) => {
    if (mark !== null && mark !== undefined) return mark;   // w:customMarkFollows
    if (printedMap && printedMap.has(id)) return printedMap.get(id);
    return String(num);                                     // honest 1, 2, 3
  };

  let fnN = 0;
  model.footnotes.forEach((fn) => {
    if (fnMarks.has(fn.id)) { fn.num = null; fn.mark = fnMarks.get(fn.id) || '*'; }
    else fn.num = ++fnN;
    fn.label = labelOf(fnPrinted, fn.id, fn.num, fn.num === null ? (fn.mark || '*') : null);
  });
  model.fnNumById = new Map(model.footnotes.map(fn => [fn.id, fn.num]));
  model.fnById = new Map(model.footnotes.map(fn => [fn.id, fn]));
  // Endnotes: number by document order and index by id, so the preview can show
  // their text on hover and jump to them just like footnotes.
  let enN = 0;
  model.endnotes.forEach((en) => {
    if (enMarks.has(en.id)) { en.num = null; en.mark = enMarks.get(en.id) || '*'; }
    else en.num = ++enN;
    en.label = labelOf(enPrinted, en.id, en.num, en.num === null ? (en.mark || '*') : null);
  });
  model.enNumById = new Map(model.endnotes.map(en => [en.id, en.num]));
  model.enById = new Map(model.endnotes.map(en => [en.id, en]));
  // From what a note MARKER says back to what Word prints. The chip of the edit
  // box carries the marker's payload and not the note id, so this is the only
  // way back; the key is built exactly the way the marker is (export-docx.js
  // _noteLabel), or the two would stop matching the day one of them changed.
  const byToken = (list) => {
    const m = new Map();
    // Custom-marked notes FIRST, auto-numbered ones after, so that when a
    // marker could mean either -- note number 3 and the note whose XML id is 3
    // both write "[[n3]]" -- the number wins, which is what the marker almost
    // always means. The ambiguity is the marker's own and older than this map;
    // it costs nothing anywhere else, because two markers are only ever
    // compared as a sequence, in order.
    for (const n of list) {
      if (n.num === null || n.num === undefined) m.set(String(n.id), n.label);
    }
    for (const n of list) {
      if (n.num !== null && n.num !== undefined) m.set(String(n.num), n.label);
    }
    return m;
  };
  model.fnLabelByToken = byToken(model.footnotes);
  model.enLabelByToken = byToken(model.endnotes);

  const bodyParas = model.paras.filter(p => p.loc.area === 'body');
  // Does this file carry tracked changes? The panel offers the "show them"
  // toggle only when there is something to show.
  model.hasTracked = !!trk.any;

  // Does this file carry index entries (XE fields)? The gear offers the "show
  // the index marks" switch only when there is something to show.
  model.hasXE = model.paras.some(p => (p.runs || []).some(r => r.xe));
  // HOW MANY of them. An index entry is invisible, so a translation that has
  // lost half of them looks exactly like one that has kept them all: only the
  // count says otherwise, which is why it sits beside the tables and the notes.
  // Counted over the paragraphs, the same set the panel draws and the export
  // walks, so the figure and what the flags show can never disagree.
  let xeCount = 0;
  for (const p of model.paras) for (const r of (p.runs || [])) if (r.xe) xeCount++;

  model.stats = {
    bodyParas: bodyParas.length,
    // Palabras del documento ENTERO: cuerpo, celdas de tabla y notas. Es la
    // cifra que el traductor mira para saber lo que tiene delante, y por eso
    // la caja de arrastre la muestra en vez de repetir los recuentos de
    // tablas, notas y comentarios que ya salen desglosados justo debajo.
    wordCount: countWords(model.paras),
    nonEmptyParas: bodyParas.filter(p => p.text.trim().length > 0).length,
    tableCount: model.tables.length,
    footnoteCount: model.footnotes.length,
    endnoteCount: model.endnotes.length,
    fnRefCount: model.fnRefOrder.length,
    commentCount: model.comments.length,
    xeCount
  };

  return model;
}
