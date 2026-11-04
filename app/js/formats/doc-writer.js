/**
 * doc-writer.js - Writes a document model back to a DOCX / PPTX / XLSX file.
 *
 *   writeReplacements(model, repl, opts?)     -> Promise<Blob>   (no tracked changes)
 *     repl: Map<paraId, Array<{ start, end, text }>> in para.text coordinates
 *     opts (DOCX): { acceptRevisions, removeComments } clean-up of the copy
 *   writeCorrected(model, newTexts, opts)     -> Promise<Blob>
 *     newTexts: Map<paraId, string> (the full new text of each paragraph)
 *     opts: { tracked:true, author:'UMBRA', date: ISO, comments:[{ paraId, quote, text, author }] }
 *   mimeOf(kind), textDiffReplacements(oldText, newText), docxAtomText(el)
 *
 * THE RULE. The file differs from the original ONLY where a replacement or a
 * correction says so. The writer never touches the displayed model: it
 * re-parses `model._bytes` into a FRESH model (paragraph ids are deterministic,
 * so they match), edits that copy's XML in place and zips it again.
 *
 * REPLACEMENTS are applied in the XML text nodes: the replacement text takes
 * the formatting of the run where the replaced span starts; characters of
 * later runs covered by the span are removed from those runs; structural atoms
 * inside a span (tabs, breaks, note calls, images) stay where they are; a
 * non-breaking hyphen goes with its word.
 *
 * DOCX. The XML of a <w:p> is projected to a string with collectRuns
 * (docx-track-changes.js) and an atomText that reads it exactly like
 * docx-model.js builds para.text. Parts that docx-model.js leaves out of the
 * text (math, custom XML wrappers, alternate content, the literal mark of a
 * custom-marked note call) are hidden from the visible projection M but kept
 * in the full one R, so their offsets are mapped and they are never edited.
 * Several logical paragraphs can come from one <w:p> (para._seg): each is
 * located inside M in order. A paragraph that cannot be located is left
 * untouched and reported in blob.warnings.
 *
 * Every Blob carries:
 *   blob.warnings = [{ paraId|null, message }]   (Spanish, for the user)
 *   blob.changedParas = number
 *   blob.verify (DOCX only) = export-verify.js result, or null (never blocks)
 *
 * ASCII ONLY: non-ASCII characters in strings are written as \uXXXX escapes.
 */

import { parseDocxModel } from './docx-model.js';
import { parsePptxModel, pptxParaItems } from './pptx-model.js';
import { parseXlsxModel, xlsxStringItems, xlsxCells } from './xlsx-model.js';
import { collectRuns, applyTrackedEdit, computeWordDiff } from './docx-track-changes.js';
import { verifyExportedDocx } from './export-verify.js';
import { addDocxComments } from './docx-comments.js';

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const PKG_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';

const MIME = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
};

/** MIME type of a document kind ('docx' | 'pptx' | 'xlsx'). */
export function mimeOf(kind) {
  return MIME[String(kind || '').toLowerCase()] || 'application/octet-stream';
}

function _kindOf(model) {
  if (model && model.kind) return model.kind;
  const m = /\.([a-z]+)$/i.exec((model && model.fileName) || '');
  return m ? m[1].toLowerCase() : '';
}

function _parseXml(xml) {
  const dom = new DOMParser().parseFromString(xml, 'text/xml');
  if (dom.getElementsByTagName('parsererror').length) throw new Error('XML mal formado en el archivo.');
  return dom;
}

function _serializer() {
  if (typeof XMLSerializer === 'undefined') throw new Error('XMLSerializer no disponible.');
  return new XMLSerializer();
}

/** A writer of DOMs into a zip, with the XML prolog OPC parts expect. */
function _partWriter(zip) {
  const ser = _serializer();
  return (dom, path) => {
    if (!dom || !path) return;
    let xml = ser.serializeToString(dom);
    if (!/^\s*<\?xml/.test(xml)) {
      xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' + xml;
    }
    zip.file(path, xml);
  };
}

async function _blob(zip, kind) {
  // DEFLATE explicitly: JSZip's default (STORE) would multiply the file size.
  return zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
    mimeType: mimeOf(kind)
  });
}

/** Word wants dates without milliseconds: 2026-11-04T10:20:30Z. */
function _wordDate(date) {
  let d = date ? new Date(date) : new Date();
  if (isNaN(d.getTime())) d = new Date();
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function _msg(paraId, message) {
  return { paraId: (paraId === undefined ? null : paraId), message };
}

function _asMap(x) {
  if (x instanceof Map) return x;
  const m = new Map();
  if (x && typeof x === 'object') {
    for (const k of Object.keys(x)) m.set(Number(k), x[k]);
  }
  return m;
}

// ------------------------------------------------------------------
// Replacement lists and text diffs
// ------------------------------------------------------------------

/**
 * Validate a replacement list for a text of length `len`: integer offsets
 * inside the text, sorted, non-overlapping (two insertions at the same point
 * are both kept, in order). Returns { list, dropped }.
 */
function _normRepls(list, len) {
  const ok = [];
  let dropped = 0;
  const arr = Array.isArray(list) ? list.map((r, i) => ({ r, i })) : [];
  for (const { r, i } of arr) {
    const s = Number(r && r.start), e = Number(r && r.end);
    if (!Number.isInteger(s) || !Number.isInteger(e) || s < 0 || e < s || e > len) { dropped++; continue; }
    ok.push({ start: s, end: e, text: String(r.text == null ? '' : r.text), _i: i });
  }
  ok.sort((a, b) => (a.start - b.start) || (a.end - b.end) || (a._i - b._i));
  const out = [];
  let lastEnd = -1;
  for (const r of ok) {
    if (r.start < lastEnd) { dropped++; continue; }
    out.push({ start: r.start, end: r.end, text: r.text });
    lastEnd = Math.max(lastEnd, r.end);
  }
  return { list: out, dropped };
}

/** Apply sorted, non-overlapping replacements to a string. */
function _applyToString(text, list) {
  let out = '', read = 0;
  for (const r of list) {
    out += text.slice(read, r.start) + r.text;
    read = Math.max(read, r.end);
  }
  return out + text.slice(read);
}

/**
 * The replacements that turn `oldText` into `newText`, in oldText
 * coordinates: words both texts share are kept (word-level LCS, the same
 * diff the track-changes engine uses) and each stretch between two shared
 * words is replaced as one region, minus the prefix and suffix the two sides
 * already share. Differences that are only whitespace at the very edges of
 * the paragraph are ignored (an indent is never ours to remove).
 */
export function textDiffReplacements(oldText, newText) {
  const a = String(oldText == null ? '' : oldText);
  const b = String(newText == null ? '' : newText);
  if (a === b) return [];
  const spans = (t) => {
    const out = [];
    const re = /\S+/g;
    let m;
    while ((m = re.exec(t)) !== null) out.push({ start: m.index, end: m.index + m[0].length });
    return out;
  };
  const ow = spans(a), nw = spans(b);
  const anchors = [];
  for (const part of computeWordDiff(a, b)) {
    if (part.type === 'eq' && ow[part.oi] && nw[part.ni]) anchors.push({ o: ow[part.oi], n: nw[part.ni] });
  }
  const out = [];
  let oPrev = 0, nPrev = 0;
  const region = (oEnd, nEnd, isOuter) => {
    const oldR = a.slice(oPrev, oEnd);
    const newR = b.slice(nPrev, nEnd);
    if (oldR === newR) return;
    if (isOuter && !oldR.trim() && !newR.trim()) return;
    let p = 0;
    while (p < oldR.length && p < newR.length && oldR[p] === newR[p]) p++;
    let s = 0;
    while (s < oldR.length - p && s < newR.length - p &&
           oldR[oldR.length - 1 - s] === newR[newR.length - 1 - s]) s++;
    out.push({ start: oPrev + p, end: oEnd - s, text: newR.slice(p, newR.length - s) });
  };
  for (const an of anchors) {
    region(an.o.start, an.n.start, oPrev === 0 && nPrev === 0);
    oPrev = an.o.end; nPrev = an.n.end;
  }
  region(a.length, b.length, true);
  return out;
}

// ------------------------------------------------------------------
// The replacement engine over projected text items
// ------------------------------------------------------------------

/**
 * Apply replacements given in the coordinates of a projection made of `items`
 * ({ kind:'t'|'x', node, start, end, text, deletable }).
 *
 * Text items (kind 't') are edited through node.textContent. The replacement
 * text goes into the text item where the span starts (its run's formatting);
 * when the span starts on an atom, into the first text item inside the span,
 * else at the end of the text before it, else at the start of the text after
 * it. Deletable atoms fully inside a span are removed; the others stay.
 *
 * hooks: { onText(item, newText), removeAtom(item), createHost(pos) -> item|null }
 * Returns { applied, failed: [repl] }.
 */
function _applyItems(items, list, hooks) {
  const h = hooks || {};
  const tItems = items.filter(it => it.kind === 't');
  const textual = tItems.filter(it => it.end > it.start);
  const plans = new Map();   // item -> { del: Uint8Array, ins: Map(local -> [text]) }
  const planOf = (it) => {
    if (!plans.has(it)) plans.set(it, { del: new Uint8Array(it.end - it.start), ins: new Map() });
    return plans.get(it);
  };
  const failed = [];
  let applied = 0;

  for (const r of list) {
    let host = null, local = 0;
    if (r.end > r.start) {
      host = textual.find(it => it.start <= r.start && r.start < it.end) || null;
      if (host) local = r.start - host.start;
      if (!host) { host = textual.find(it => it.start >= r.start && it.start < r.end) || null; local = 0; }
    } else {
      host = textual.find(it => it.start < r.start && r.start <= it.end) || null;
      if (host) local = r.start - host.start;
      if (!host) { host = textual.find(it => it.start === r.start) || null; local = 0; }
    }
    if (!host) {
      const before = textual.filter(it => it.end <= r.start).pop();
      if (before) { host = before; local = before.end - before.start; }
    }
    if (!host) {
      const after = textual.find(it => it.start >= r.end);
      if (after) { host = after; local = 0; }
    }
    if (!host && r.text && h.createHost) {
      host = h.createHost(r.start);
      if (host) { host.start = r.start; host.end = r.start; local = 0; }
    }
    if (!host) {
      if (r.text || r.end > r.start) failed.push(r);
      continue;
    }
    // Deletions in every text item the span covers.
    if (r.end > r.start) {
      for (const it of textual) {
        const a = Math.max(r.start, it.start), b = Math.min(r.end, it.end);
        if (a >= b) continue;
        const pl = planOf(it);
        for (let c = a; c < b; c++) pl.del[c - it.start] = 1;
      }
      for (const it of items) {
        if (it.kind === 'x' && it.deletable && it.end > it.start && it.start >= r.start && it.end <= r.end) {
          if (h.removeAtom) h.removeAtom(it);
        }
      }
    }
    if (r.text) {
      const pl = planOf(host);
      if (!pl.ins.has(local)) pl.ins.set(local, []);
      pl.ins.get(local).push(r.text);
    }
    applied++;
  }

  for (const [it, pl] of plans) {
    const text = it.node ? (it.node.textContent || '') : '';
    let out = '';
    for (let k = 0; k <= text.length; k++) {
      const add = pl.ins.get(k);
      if (add) out += add.join('');
      if (k < text.length && !pl.del[k]) out += text[k];
    }
    if (out !== text) {
      if (h.onText) h.onText(it, out);
      else it.node.textContent = out;
    }
  }
  return { applied, failed };
}

/** Give a list of items their start/end offsets (in order). */
function _withOffsets(items) {
  let off = 0;
  for (const it of items) {
    it.start = off;
    it.end = off + (it.text || '').length;
    off = it.end;
  }
  return items;
}

// ------------------------------------------------------------------
// DOCX projection (the contract with docx-model.js)
// ------------------------------------------------------------------

/**
 * What every non-<w:t> child of a <w:r> reads as in para.text (docx-model.js):
 * tab -> "\t", any break -> " ", non-breaking hyphen -> "-" (deletable with
 * its word); note calls, comment references, field codes, images -> nothing.
 */
export function docxAtomText(el) {
  switch (el.localName) {
    case 'tab': return { text: '\t' };
    case 'br':
    case 'cr': return { text: ' ' };
    case 'noBreakHyphen': return { text: '-', deletable: true };
    default: return null;
  }
}

// The containers docx-model.js walks into; text in any other container
// (math, custom XML, alternate content...) is not part of para.text.
const MODEL_WRAPPERS = new Set(['hyperlink', 'ins', 'moveTo', 'smartTag', 'fldSimple', 'sdt', 'sdtContent']);

function _visibleRun(runEl, pEl) {
  if (!runEl || runEl.localName !== 'r') return false;
  for (let a = runEl.parentNode; a && a !== pEl; a = a.parentNode) {
    if (a.nodeType !== 1 || !MODEL_WRAPPERS.has(a.localName)) return false;
  }
  return true;
}

function _contributesText(it) {
  if (it.kind === 't') return true;
  const ln = it.node.localName;
  if (ln === 'tab' || ln === 'noBreakHyphen') return true;
  if (ln === 'br') {
    const bt = it.node.getAttributeNS(W_NS, 'type');
    return bt === 'page' || bt === 'column';
  }
  return false;
}

function _createsModelRun(it) {
  const ln = it.node.localName;
  if (ln === 'br') return !_contributesText(it);
  return ln === 'cr' || ln === 'footnoteReference' || ln === 'endnoteReference' ||
    ln === 'commentReference' || ln === 'drawing' || ln === 'pict' || ln === 'object';
}

/**
 * docx-model.js absorbs the literal mark that follows a custom-marked note
 * call ("*") into the call: it is not in para.text. Hide those items.
 */
function _hideCustomMarks(items) {
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it.visible || it.kind !== 'x') continue;
    const ln = it.node.localName;
    if (ln !== 'footnoteReference' && ln !== 'endnoteReference') continue;
    const cmf = it.node.getAttributeNS(W_NS, 'customMarkFollows');
    if (cmf !== '1' && cmf !== 'true') continue;
    const chunk = [];
    let runEl = it.runEl;
    for (let k = i + 1; k < items.length; k++) {
      const nx = items[k];
      if (!nx.visible) continue;
      if (nx.runEl !== runEl) {
        if (chunk.length) break;     // the chunk ends with its run
        runEl = nx.runEl;
      }
      if (_contributesText(nx)) { chunk.push(nx); continue; }
      if (_createsModelRun(nx)) break;
    }
    const text = chunk.map(c => c.text).join('');
    if (chunk.length && /^[^A-Za-z0-9]{1,3}\s*$/.test(text)) {
      for (const c of chunk) c.visible = false;
    }
  }
}

/**
 * The projections of a <w:p>:
 *   items  every text item / atom (collectRuns) with its run and R offsets
 *   R      the full projection (what applyTrackedEdit reads)
 *   M      the visible projection (what docx-model.js put in para.text)
 *   mIdx   M index -> R index
 */
function _docxProject(pEl) {
  const items = [];
  for (const r of collectRuns(pEl, docxAtomText)) {
    for (const it of r.items) {
      it.runEl = r.runEl;
      it.visible = _visibleRun(r.runEl, pEl);
      items.push(it);
    }
  }
  _hideCustomMarks(items);
  let R = '', M = '';
  const mIdx = [];
  for (const it of items) {
    R += it.text;
    if (!it.visible) continue;
    for (let c = 0; c < it.text.length; c++) mIdx.push(it.start + c);
    M += it.text;
  }
  return { items, R, M, mIdx };
}

/**
 * Locate the logical paragraphs of one <w:p> (their texts, in line order)
 * inside its visible projection. What lies between and around them may only
 * be whitespace (the line breaks the model splits at, blank lines it drops).
 * Returns [{ ms, me }] or null.
 */
function _locate(M, texts) {
  const out = [];
  let cursor = 0;
  for (const t of texts) {
    const at = M.indexOf(t, cursor);
    if (at < 0) return null;
    if (/\S/.test(M.slice(cursor, at))) return null;
    out.push({ ms: at, me: at + t.length });
    cursor = at + t.length;
  }
  if (/\S/.test(M.slice(cursor))) return null;
  return out;
}

/** Para coordinates -> R coordinates (a span [s, e) of a para located at ms). */
function _spanToR(proj, ms, len, s, e) {
  const m = proj.mIdx;
  if (e > s) return { start: m[ms + s], end: m[ms + e - 1] + 1 };
  let pos;
  if (s < len) pos = m[ms + s];
  else if (len > 0) pos = m[ms + len - 1] + 1;
  else pos = (ms < m.length) ? m[ms] : proj.R.length;
  return { start: pos, end: pos };
}

function _docxFamilies(fresh) {
  const fam = new Map();
  for (const p of fresh.paras) {
    if (!p._el) continue;
    if (!fam.has(p._el)) fam.set(p._el, []);
    fam.get(p._el).push(p);
  }
  for (const list of fam.values()) {
    list.sort((a, b) => (a._seg ? a._seg.index : 0) - (b._seg ? b._seg.index : 0));
  }
  return fam;
}

/** Largest numeric w:id of the parts, so new revision ids never clash. */
function _maxWId(fresh) {
  let max = 0;
  for (const area of ['body', 'footnote', 'endnote']) {
    const dom = fresh._parts && fresh._parts[area];
    if (!dom) continue;
    for (const el of dom.getElementsByTagName('*')) {
      const v = el.getAttributeNS(W_NS, 'id');
      if (v === null || v === '') continue;
      const n = parseInt(v, 10);
      if (!isNaN(n) && n > max) max = n;
    }
  }
  return max;
}

function _docxHooks(pEl) {
  return {
    onText(it, text) {
      if (!text && it.node.parentNode) {
        // The text went entirely: drop the <w:t>, and the run too when nothing
        // but its properties is left in it.
        const run = it.node.parentNode;
        run.removeChild(it.node);
        const rest = Array.from(run.childNodes).some(c => c.nodeType === 1 && c.localName !== 'rPr');
        if (!rest && run.localName === 'r' && run.parentNode) run.parentNode.removeChild(run);
        return;
      }
      it.node.textContent = text;
      it.node.setAttributeNS(XML_NS, 'xml:space', 'preserve');
    },
    removeAtom(it) {
      if (it.node.parentNode) it.node.parentNode.removeChild(it.node);
    },
    createHost() {
      // An empty paragraph receiving text: a new run at its end.
      const dom = pEl.ownerDocument;
      const r = dom.createElementNS(W_NS, 'w:r');
      const t = dom.createElementNS(W_NS, 'w:t');
      t.setAttributeNS(XML_NS, 'xml:space', 'preserve');
      r.appendChild(t);
      pEl.appendChild(r);
      return { kind: 't', node: t, text: '' };
    }
  };
}

// Inline revision markup. Accepting a revision keeps what the document reads
// (docx-model.js already reads it that way), so no offset moves.
const REV_DROP = ['del', 'moveFrom'];
const REV_UNWRAP = ['ins', 'moveTo'];
const REV_RECORDS = ['rPrChange', 'pPrChange', 'sectPrChange', 'tblPrChange', 'trPrChange', 'tcPrChange',
  'tblGridChange', 'numberingChange', 'moveFromRangeStart', 'moveFromRangeEnd', 'moveToRangeStart', 'moveToRangeEnd'];
const COMMENT_MARKS = ['commentRangeStart', 'commentRangeEnd', 'commentReference'];
const COMMENT_REL = /\/(comments|commentsExtended|commentsIds|commentsExtensible)$/;

/**
 * Optional clean-up of a masked copy, so nothing outside the masked text
 * travels with it:
 *   acceptRevisions  tracked deletions (their text!) are removed, insertions
 *                    kept as plain text, formatting-change records dropped;
 *   removeComments   the Word comments (parts, relationships, anchors) go.
 * Works on the body, footnotes and endnotes. Returns the areas changed.
 */
async function _cleanDocx(fresh, opts, write) {
  const areas = new Set();
  const zip = fresh._zip;
  const each = (dom, names, fn) => {
    for (const name of names) {
      for (const el of Array.from(dom.getElementsByTagNameNS(W_NS, name))) if (el.parentNode) fn(el);
    }
  };
  for (const area of ['body', 'footnote', 'endnote']) {
    const dom = fresh._parts[area];
    if (!dom) continue;
    let n = 0;
    if (opts.acceptRevisions) {
      each(dom, REV_DROP, (el) => { el.parentNode.removeChild(el); n++; });
      each(dom, REV_UNWRAP, (el) => {
        const parent = el.parentNode;
        // A marker inside properties (an inserted paragraph mark or row) only goes.
        if (parent.localName !== 'rPr' && parent.localName !== 'trPr') {
          while (el.firstChild) parent.insertBefore(el.firstChild, el);
        }
        parent.removeChild(el);
        n++;
      });
      each(dom, REV_RECORDS, (el) => { el.parentNode.removeChild(el); n++; });
    }
    if (opts.removeComments) {
      each(dom, COMMENT_MARKS, (el) => {
        const run = el.parentNode;
        run.removeChild(el);
        if (run.localName === 'r' && !Array.from(run.childNodes).some(c => c.nodeType === 1 && c.localName !== 'rPr')) {
          if (run.parentNode) run.parentNode.removeChild(run);
        }
        n++;
      });
    }
    if (n) areas.add(area);
  }
  if (opts.removeComments) {
    const removed = [];
    const relsPath = 'word/_rels/document.xml.rels';
    if (zip.file(relsPath)) {
      const rd = _parseXml(await zip.file(relsPath).async('string'));
      let changed = false;
      for (const rel of Array.from(rd.getElementsByTagNameNS(PKG_REL_NS, 'Relationship'))) {
        if (!COMMENT_REL.test(rel.getAttribute('Type') || '')) continue;
        const target = rel.getAttribute('Target') || '';
        removed.push(target.charAt(0) === '/' ? target.slice(1) : 'word/' + target.replace(/^\.\//, ''));
        rel.parentNode.removeChild(rel);
        changed = true;
      }
      if (changed) write(rd, relsPath);
    }
    for (const path of removed) {
      if (zip.file(path)) zip.remove(path);
      const rels = path.replace(/^(.*\/)?([^/]+)$/, (all, dir, file) => (dir || '') + '_rels/' + file + '.rels');
      if (zip.file(rels)) zip.remove(rels);
    }
    if (removed.length && zip.file('[Content_Types].xml')) {
      const cd = _parseXml(await zip.file('[Content_Types].xml').async('string'));
      const gone = new Set(removed.map(p => '/' + p.toLowerCase()));
      for (const o of Array.from(cd.getElementsByTagNameNS(CT_NS, 'Override'))) {
        if (gone.has((o.getAttribute('PartName') || '').toLowerCase())) o.parentNode.removeChild(o);
      }
      write(cd, '[Content_Types].xml');
    }
  }
  return areas;
}

/**
 * The DOCX writer shared by writeReplacements and writeCorrected.
 * job: { repl?: Map, newTexts?: Map, tracked, author, date, comments, warnings }
 */
async function _writeDocx(model, job) {
  if (!model._bytes) throw new Error('El modelo no conserva el archivo original; vuelva a cargarlo.');
  const fresh = await parseDocxModel(model._bytes);
  fresh.fileName = model.fileName || '';
  const zip = fresh._zip;
  const write = _partWriter(zip);
  const warnings = (job.warnings || []).slice();
  const touched = new Set();
  const families = _docxFamilies(fresh);
  const author = job.author || 'UMBRA';
  const isoDate = _wordDate(job.date);
  const revIdRef = { n: _maxWId(fresh) + 1 };
  let changedParas = 0;
  if (job.clean && (job.clean.acceptRevisions || job.clean.removeComments)) {
    for (const area of await _cleanDocx(fresh, job.clean, write)) touched.add(area);
  }

  // paraId -> replacements in para coordinates, grouped by <w:p>.
  const byEl = new Map();
  const newTexts = job.newTexts || null;
  const addEdit = (para, list) => {
    if (!byEl.has(para._el)) byEl.set(para._el, new Map());
    byEl.get(para._el).set(para.id, list);
  };
  if (job.repl) {
    for (const [pid, list] of job.repl) {
      const para = fresh.paras[pid];
      if (!para || !para._el) { warnings.push(_msg(pid, 'El p\u00e1rrafo ' + pid + ' no existe en el documento; no se ha escrito.')); continue; }
      const norm = _normRepls(list, para.text.length);
      if (norm.dropped) {
        warnings.push(_msg(pid, 'P\u00e1rrafo ' + pid + ': ' + norm.dropped +
          ' sustituci\u00f3n(es) fuera de rango o solapadas; se han omitido.'));
      }
      if (norm.list.length) addEdit(para, norm.list);
    }
  }
  if (newTexts) {
    for (const [pid, txt] of newTexts) {
      const para = fresh.paras[pid];
      if (!para || !para._el) { warnings.push(_msg(pid, 'El p\u00e1rrafo ' + pid + ' no existe en el documento; no se ha escrito.')); continue; }
      const list = textDiffReplacements(para.text, String(txt == null ? '' : txt));
      if (list.length) addEdit(para, list);
    }
  }

  // The current text of each paragraph once the edits are in (for comments).
  const current = new Map();

  for (const [pEl, edits] of byEl) {
    const fam = families.get(pEl) || [];
    const proj = _docxProject(pEl);
    const loc = _locate(proj.M, fam.map(p => p.text));
    if (!loc) {
      for (const pid of edits.keys()) {
        warnings.push(_msg(pid, 'El p\u00e1rrafo ' + pid + ' no se pudo localizar en el XML; se ha dejado sin cambios.'));
      }
      continue;
    }
    const rRepls = [];
    for (const [pid, list] of edits) {
      const k = fam.findIndex(p => p.id === pid);
      const para = fam[k];
      for (const r of list) {
        const span = _spanToR(proj, loc[k].ms, para.text.length, r.start, r.end);
        rRepls.push({ start: span.start, end: span.end, text: r.text, paraId: pid });
      }
      current.set(pid, _applyToString(para.text, list));
    }
    rRepls.sort((a, b) => (a.start - b.start) || (a.end - b.end));
    const area = fam[0].loc.area;

    if (job.tracked) {
      const newR = _applyToString(proj.R, rRepls);
      const n = applyTrackedEdit(pEl, newR, {
        author, isoDate, revIdRef, atomText: docxAtomText, lineBreaks: true
      });
      if (n > 0) { touched.add(area); changedParas += edits.size; }
      else if (newR.trim() !== proj.R.trim()) {
        for (const pid of edits.keys()) {
          warnings.push(_msg(pid, 'El p\u00e1rrafo ' + pid + ' no admiti\u00f3 el cambio con control de cambios; se ha dejado sin cambios.'));
        }
      }
    } else {
      const res = _applyItems(proj.items, rRepls, _docxHooks(pEl));
      for (const f of res.failed) {
        warnings.push(_msg(f.paraId, 'P\u00e1rrafo ' + f.paraId + ': una sustituci\u00f3n no encontr\u00f3 texto donde escribirse.'));
      }
      if (res.applied) { touched.add(area); changedParas += edits.size; }
    }
  }

  if (job.comments && job.comments.length) {
    await addDocxComments(fresh, job.comments, {
      author, isoDate, idRef: revIdRef, warnings, touched, write,
      project: _docxProject,
      locate: _locate,
      familyOf: families,
      currentText: (pid) => (current.has(pid) ? current.get(pid) : fresh.paras[pid].text)
    });
  }

  for (const area of touched) write(fresh._parts[area], fresh._partPath[area]);
  const blob = await _blob(zip, 'docx');

  // The check of every export (notes and images), against the file as loaded.
  let verify = null;
  try {
    const source = (model._parts && model._parts.body) ? model : await parseDocxModel(model._bytes);
    verify = await verifyExportedDocx(blob, source, null);
  } catch (e) {
    verify = { ok: false, summary: null,
      problems: ['No se pudo verificar el archivo exportado: ' + ((e && e.message) || e)] };
  }
  blob.warnings = warnings;
  blob.changedParas = changedParas;
  blob.verify = verify;
  return blob;
}

// ------------------------------------------------------------------
// PPTX
// ------------------------------------------------------------------

async function _writePptx(model, repl, preWarnings) {
  if (!model._bytes) throw new Error('El modelo no conserva el archivo original; vuelva a cargarlo.');
  const fresh = await parsePptxModel(model._bytes);
  const zip = fresh._zip;
  const write = _partWriter(zip);
  const warnings = (preWarnings || []).slice();
  const doms = new Map();
  const touched = new Set();
  let changedParas = 0;

  for (const [pid, rawList] of repl) {
    const para = fresh.paras[pid];
    if (!para || para.isSlideSep || !para._w || para._w.pIndex < 0) {
      if (!para || !para.isSlideSep) {
        warnings.push(_msg(pid, 'El p\u00e1rrafo ' + pid + ' no existe en la presentaci\u00f3n; no se ha escrito.'));
      }
      continue;
    }
    const norm = _normRepls(rawList, para.text.length);
    if (norm.dropped) {
      warnings.push(_msg(pid, 'P\u00e1rrafo ' + pid + ': ' + norm.dropped +
        ' sustituci\u00f3n(es) fuera de rango o solapadas; se han omitido.'));
    }
    if (!norm.list.length) continue;
    const part = para._w.part;
    if (!doms.has(part)) doms.set(part, _parseXml(await zip.file(part).async('string')));
    const pEl = doms.get(part).getElementsByTagNameNS(A_NS, 'p')[para._w.pIndex];
    const items = pEl ? _withOffsets(pptxParaItems(pEl)) : [];
    const text = items.map(i => i.text).join('');
    if (!pEl || text !== para.text) {
      warnings.push(_msg(pid, 'El p\u00e1rrafo ' + pid + ' no se pudo localizar en la diapositiva; se ha dejado sin cambios.'));
      continue;
    }
    const res = _applyItems(items, norm.list.map(r => ({ ...r, paraId: pid })), {
      createHost() {
        const r = pEl.ownerDocument.createElementNS(A_NS, 'a:r');
        const t = pEl.ownerDocument.createElementNS(A_NS, 'a:t');
        r.appendChild(t);
        const endPr = Array.from(pEl.childNodes).find(c => c.nodeType === 1 && c.localName === 'endParaRPr');
        pEl.insertBefore(r, endPr || null);
        return { kind: 't', node: t, text: '' };
      }
    });
    for (const f of res.failed) {
      warnings.push(_msg(pid, 'P\u00e1rrafo ' + pid + ': una sustituci\u00f3n no encontr\u00f3 texto donde escribirse.'));
    }
    if (res.applied) { touched.add(part); changedParas++; }
  }

  for (const part of touched) write(doms.get(part), part);
  const blob = await _blob(zip, 'pptx');
  blob.warnings = warnings;
  blob.changedParas = changedParas;
  blob.verify = null;
  return blob;
}

// ------------------------------------------------------------------
// XLSX
// ------------------------------------------------------------------

function _xKid(el, name) {
  for (const c of el.childNodes) if (c.nodeType === 1 && c.localName === name) return c;
  return null;
}

function _xlsxHooks(strEl) {
  const ns = strEl.namespaceURI;
  return {
    onText(it, text) {
      it.node.textContent = text;
      it.node.setAttributeNS(XML_NS, 'xml:space', 'preserve');
    },
    createHost() {
      const t = strEl.ownerDocument.createElementNS(ns, 't');
      strEl.appendChild(t);
      return { kind: 't', node: t, text: '' };
    }
  };
}

/** Turn a cell into an inline string holding `text` (drops <f>, <v>, <is>). */
function _toInlineStr(cEl, text) {
  const ns = cEl.namespaceURI;
  const dom = cEl.ownerDocument;
  let removedFormula = null;
  for (const c of Array.from(cEl.childNodes)) {
    if (c.nodeType !== 1) continue;
    if (c.localName === 'f') { removedFormula = c; cEl.removeChild(c); }
    else if (c.localName === 'v' || c.localName === 'is') cEl.removeChild(c);
  }
  cEl.setAttribute('t', 'inlineStr');
  const is = dom.createElementNS(ns, 'is');
  const t = dom.createElementNS(ns, 't');
  t.setAttributeNS(XML_NS, 'xml:space', 'preserve');
  t.textContent = text;
  is.appendChild(t);
  cEl.insertBefore(is, _xKid(cEl, 'extLst'));
  return removedFormula;
}

async function _writeXlsx(model, repl, preWarnings) {
  if (!model._bytes) throw new Error('El modelo no conserva el archivo original; vuelva a cargarlo.');
  const fresh = await parseXlsxModel(model._bytes);
  const zip = fresh._zip;
  const write = _partWriter(zip);
  const warnings = (preWarnings || []).slice();
  const sheets = new Map();   // part -> { dom, cells: Map(ref -> el) }
  const touched = new Set();
  let sstTouched = false;
  let formulasRemoved = false;
  let changedParas = 0;

  const sheetOf = async (part) => {
    if (!sheets.has(part)) {
      const dom = _parseXml(await zip.file(part).async('string'));
      const cells = new Map();
      for (const c of xlsxCells(dom)) cells.set(c.ref, c.el);
      sheets.set(part, { dom, cells });
    }
    return sheets.get(part);
  };
  let sstDom = null, siEls = null;
  const sst = async () => {
    if (!sstDom) {
      sstDom = _parseXml(await zip.file(fresh.sharedStringsPart).async('string'));
      siEls = Array.from(sstDom.documentElement.childNodes).filter(c => c.nodeType === 1 && c.localName === 'si');
    }
    return sstDom;
  };

  // Normalized edits per paragraph.
  const edits = new Map();
  for (const [pid, rawList] of repl) {
    const para = fresh.paras[pid];
    if (!para || !para._w) { warnings.push(_msg(pid, 'La celda ' + pid + ' no existe en el libro; no se ha escrito.')); continue; }
    const norm = _normRepls(rawList, para.text.length);
    if (norm.dropped) {
      warnings.push(_msg(pid, 'Celda ' + para.loc.cellRef + ': ' + norm.dropped +
        ' sustituci\u00f3n(es) fuera de rango o solapadas; se han omitido.'));
    }
    if (norm.list.length && _applyToString(para.text, norm.list) !== para.text) edits.set(pid, norm.list);
  }

  // Removing the master of a shared formula breaks the cells that reuse it:
  // once every edit is in, those that still use it keep their cached values
  // instead (see 2b).
  const droppedMasters = [];
  const dropFormula = (sheet, part, cEl, fEl) => {
    formulasRemoved = true;
    if (fEl && fEl.getAttribute('t') === 'shared' && fEl.getAttribute('ref')) {
      droppedMasters.push({ sheet, part, si: fEl.getAttribute('si'), ref: cEl.getAttribute('r') });
    }
  };

  // 1) Shared strings: one edit per (si, replacement set); clones when the
  //    cells that share an si need different results.
  const sUsers = new Map();   // si -> [para]
  for (const p of fresh.paras) {
    if (p._w && p._w.type === 's') {
      if (!sUsers.has(p._w.si)) sUsers.set(p._w.si, []);
      sUsers.get(p._w.si).push(p);
    }
  }
  const sTargets = new Set();
  for (const pid of edits.keys()) {
    const p = fresh.paras[pid];
    if (p._w.type === 's') sTargets.add(p._w.si);
  }
  let uniqueAdded = 0;
  for (const si of sTargets) {
    await sst();
    const users = sUsers.get(si) || [];
    const groups = new Map();   // key -> { list, paras }
    for (const p of users) {
      const list = edits.get(p.id) || null;
      const key = list ? JSON.stringify(list) : '';
      if (!groups.has(key)) groups.set(key, { list, paras: [] });
      groups.get(key).paras.push(p);
    }
    // Cells that use this string but are not paragraphs (blank text) keep it.
    if ((fresh._sstUse.get(si) || 0) > users.length && !groups.has('')) groups.set('', { list: null, paras: [] });
    const original = siEls[si];
    if (!original) {
      for (const g of groups.values()) for (const p of g.paras) {
        if (g.list) warnings.push(_msg(p.id, 'Celda ' + p.loc.cellRef + ': cadena compartida no encontrada; sin cambios.'));
      }
      continue;
    }
    // Every clone is taken from the PRISTINE string, before any edit is made:
    // the group that keeps the original index is edited last.
    let inPlaceUsed = groups.has('');
    const jobs = [];
    for (const [key, g] of groups) {
      if (!key) continue;
      let target = original;
      if (inPlaceUsed) {
        target = original.cloneNode(true);
        sstDom.documentElement.appendChild(target);
        const newIdx = siEls.length;
        siEls.push(target);
        uniqueAdded++;
        for (const p of g.paras) {
          const sheet = await sheetOf(p._w.part);
          const cEl = sheet.cells.get(p._w.cellRef);
          const vEl = cEl ? _xKid(cEl, 'v') : null;
          if (vEl) { vEl.textContent = String(newIdx); touched.add(p._w.part); }
        }
      }
      inPlaceUsed = true;
      jobs.push({ target, g });
    }
    for (const { target, g } of jobs) {
      const items = _withOffsets(xlsxStringItems(target));
      const text = items.map(i => i.text).join('');
      if (text !== g.paras[0].text) {
        for (const p of g.paras) warnings.push(_msg(p.id, 'Celda ' + p.loc.cellRef + ': el texto no coincide con el archivo; sin cambios.'));
        continue;
      }
      const res = _applyItems(items, g.list, _xlsxHooks(target));
      if (res.applied) { sstTouched = true; changedParas += g.paras.length; }
    }
  }
  if (uniqueAdded && sstDom) {
    const root = sstDom.documentElement;
    const uc = parseInt(root.getAttribute('uniqueCount'), 10);
    if (!isNaN(uc)) root.setAttribute('uniqueCount', String(uc + uniqueAdded));
  }

  // 2) Every other cell type.
  for (const [pid, list] of edits) {
    const p = fresh.paras[pid];
    const type = p._w.type;
    if (type === 's') continue;
    const sheet = await sheetOf(p._w.part);
    const cEl = sheet.cells.get(p._w.cellRef);
    if (!cEl) { warnings.push(_msg(pid, 'Celda ' + p._w.cellRef + ' no encontrada; sin cambios.')); continue; }
    if (type === 'inlineStr') {
      const is = _xKid(cEl, 'is');
      const items = _withOffsets(xlsxStringItems(is));
      if (!is || items.map(i => i.text).join('') !== p.text) {
        warnings.push(_msg(pid, 'Celda ' + p._w.cellRef + ': el texto no coincide con el archivo; sin cambios.'));
        continue;
      }
      const res = _applyItems(items, list, _xlsxHooks(is));
      if (res.applied) { touched.add(p._w.part); changedParas++; }
    } else {
      // 'n', 'str', 'd': the cell becomes an inline string with the new text.
      const fEl = _toInlineStr(cEl, _applyToString(p.text, list));
      if (fEl) dropFormula(sheet, p._w.part, cEl, fEl);
      touched.add(p._w.part);
      changedParas++;
    }
  }

  // 2b) Cells left with a shared formula whose master is gone.
  for (const m of droppedMasters) {
    let n = 0;
    for (const el of m.sheet.cells.values()) {
      const f = _xKid(el, 'f');
      if (f && f.getAttribute('t') === 'shared' && f.getAttribute('si') === m.si) { el.removeChild(f); n++; }
    }
    if (n) {
      touched.add(m.part);
      warnings.push(_msg(null, 'Hoja ' + m.part + ': ' + n + ' celda(s) que compart\u00edan la f\u00f3rmula de ' +
        m.ref + ' conservan su valor pero ya no tienen f\u00f3rmula.'));
    }
  }

  // 3) A workbook whose formulas changed loses its calculation chain (Excel
  //    rebuilds it); a stale one makes Excel report the file as damaged.
  if (formulasRemoved && zip.file('xl/calcChain.xml')) {
    zip.remove('xl/calcChain.xml');
    const relsPath = 'xl/_rels/workbook.xml.rels';
    if (zip.file(relsPath)) {
      const rd = _parseXml(await zip.file(relsPath).async('string'));
      for (const rel of Array.from(rd.getElementsByTagNameNS(PKG_REL_NS, 'Relationship'))) {
        if (/\/calcChain$/.test(rel.getAttribute('Type') || '')) rel.parentNode.removeChild(rel);
      }
      write(rd, relsPath);
    }
    if (zip.file('[Content_Types].xml')) {
      const cd = _parseXml(await zip.file('[Content_Types].xml').async('string'));
      for (const o of Array.from(cd.getElementsByTagNameNS(CT_NS, 'Override'))) {
        if ((o.getAttribute('PartName') || '').toLowerCase() === '/xl/calcchain.xml') o.parentNode.removeChild(o);
      }
      write(cd, '[Content_Types].xml');
    }
  }

  for (const part of touched) write(sheets.get(part).dom, part);
  if (sstTouched || uniqueAdded) write(sstDom, fresh.sharedStringsPart);
  const blob = await _blob(zip, 'xlsx');
  blob.warnings = warnings;
  blob.changedParas = changedParas;
  blob.verify = null;
  return blob;
}

// ------------------------------------------------------------------
// Public API
// ------------------------------------------------------------------

/**
 * Write a copy of the document with the replacements applied (no tracked
 * changes): the masked copy.
 * @param {Object} model  a model from parse.js (keeps `_bytes`)
 * @param {Map<number, Array<{start:number,end:number,text:string}>>} repl
 * @param {{acceptRevisions?:boolean, removeComments?:boolean}} [opts]  DOCX only:
 *        accept the tracked changes already in the file (their deleted text
 *        would otherwise travel in clear) and remove its Word comments.
 * @returns {Promise<Blob>} with .warnings, .changedParas, .verify
 */
export async function writeReplacements(model, repl, opts) {
  const kind = _kindOf(model);
  const map = _asMap(repl);
  if (kind === 'docx') return _writeDocx(model, { repl: map, tracked: false, clean: opts || null });
  if (kind === 'pptx') return _writePptx(model, map, []);
  if (kind === 'xlsx') return _writeXlsx(model, map, []);
  throw new Error('Formato no admitido: use DOCX, PPTX o XLSX.');
}

/**
 * Write a corrected copy: each paragraph of `newTexts` gets its new text.
 * DOCX: as tracked changes (opts.tracked, default true) or directly, plus Word
 * comments (opts.comments). PPTX/XLSX: always directly; comments are not
 * supported there (a warning says so).
 * @param {Object} model
 * @param {Map<number, string>} newTexts
 * @param {{tracked?:boolean, author?:string, date?:string,
 *          comments?:Array<{paraId:number, quote:string, text:string, author?:string}>}} opts
 * @returns {Promise<Blob>} with .warnings, .changedParas, .verify
 */
export async function writeCorrected(model, newTexts, opts) {
  const o = opts || {};
  const kind = _kindOf(model);
  const texts = _asMap(newTexts);
  if (kind === 'docx') {
    return _writeDocx(model, {
      newTexts: texts,
      tracked: o.tracked !== false,
      author: o.author || 'UMBRA',
      date: o.date,
      comments: Array.isArray(o.comments) ? o.comments : []
    });
  }
  if (kind !== 'pptx' && kind !== 'xlsx') throw new Error('Formato no admitido: use DOCX, PPTX o XLSX.');
  const pre = [];
  if (Array.isArray(o.comments) && o.comments.length) {
    pre.push(_msg(null, 'Los comentarios no se admiten en archivos ' + kind.toUpperCase() +
      ': se han omitido ' + o.comments.length + '.'));
  }
  const repl = new Map();
  for (const [pid, txt] of texts) {
    const para = model.paras[pid];
    if (!para) { pre.push(_msg(pid, 'El p\u00e1rrafo ' + pid + ' no existe en el documento; no se ha escrito.')); continue; }
    const list = textDiffReplacements(para.text, String(txt == null ? '' : txt));
    if (list.length) repl.set(pid, list);
  }
  return kind === 'pptx' ? _writePptx(model, repl, pre) : _writeXlsx(model, repl, pre);
}
