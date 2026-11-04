/**
 * docx-comments.js - Writes Word comments into a DOCX that doc-writer.js is
 * producing: the comments part (word/comments.xml, created when missing, with
 * its relationship and its content type) and the anchors in the text:
 *
 *   <w:commentRangeStart w:id="N"/> ...text... <w:commentRangeEnd w:id="N"/>
 *   <w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="N"/></w:r>
 *
 * The range goes around the QUOTE inside the paragraph's CURRENT text (after
 * the tracked edits: deleted runs are not text any more) when it can be found
 * there, splitting the <w:r> at the boundaries; otherwise around the whole
 * paragraph. A comment on a footnote/endnote paragraph is anchored on the
 * note's CALL in the body (its text is prefixed with the note label), or
 * skipped with a warning when the call cannot be found.
 *
 * The paragraph projection and the locator are doc-writer.js's own (passed in
 * `ctx`), so the offsets here are exactly the ones the edits used.
 *
 * ASCII ONLY: non-ASCII characters in strings are written as \uXXXX escapes.
 */

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';

const COMMENTS_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments';
const COMMENTS_CT = 'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml';

function _parseXml(xml) {
  const dom = new DOMParser().parseFromString(xml, 'text/xml');
  if (dom.getElementsByTagName('parsererror').length) {
    throw new Error('XML mal formado dentro del DOCX.');
  }
  return dom;
}

function _w(dom, name) {
  return dom.createElementNS(W_NS, 'w:' + name);
}

function _setW(el, name, val) {
  el.setAttributeNS(W_NS, 'w:' + name, String(val));
}

/** Initials for w:initials: the first letter of each word ('Ana Ruiz' -> 'AR'). */
function _initials(author) {
  const words = String(author || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return 'U';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return words.map(w => w.charAt(0)).join('').toUpperCase().slice(0, 9);
}

// ------------------------------------------------------------------
// Splitting runs at a text position
// ------------------------------------------------------------------

/** Make `node` (a direct child of a <w:r>) the first content of its run. Returns the run. */
function _splitRunBefore(node) {
  const run = node.parentNode;
  const before = [];
  for (let c = run.firstChild; c && c !== node; c = c.nextSibling) {
    if (c.nodeType === 1 && c.localName === 'rPr') continue;
    before.push(c);
  }
  if (!before.some(n => n.nodeType === 1)) return run;
  const first = run.cloneNode(false);
  for (const c of run.childNodes) {
    if (c.nodeType === 1 && c.localName === 'rPr') { first.appendChild(c.cloneNode(true)); break; }
  }
  for (const n of before) first.appendChild(n);
  run.parentNode.insertBefore(first, run);
  return run;
}

/** Split a text node <w:t> at `local`: the node keeps [0, local), a new one after it gets the rest. */
function _splitText(tNode, local) {
  const text = tNode.textContent || '';
  const tail = tNode.ownerDocument.createElementNS(W_NS, 'w:t');
  tail.setAttributeNS(XML_NS, 'xml:space', 'preserve');
  tail.textContent = text.slice(local);
  tNode.textContent = text.slice(0, local);
  tNode.setAttributeNS(XML_NS, 'xml:space', 'preserve');
  tNode.parentNode.insertBefore(tail, tNode.nextSibling);
  return tail;
}

/** The item holding character `pos` (start side) or ending at `pos` (end side). */
function _itemAt(items, pos, side) {
  for (const it of items) {
    if (it.end <= it.start) continue;
    if (side === 'start' ? (pos >= it.start && pos < it.end) : (pos > it.start && pos <= it.end)) return it;
  }
  return null;
}

/** Insert `marker` right before the text position `pos` (a start boundary). */
function _markBefore(items, pos, marker) {
  const it = _itemAt(items, pos, 'start');
  if (!it) return false;
  const local = pos - it.start;
  let node = it.node;
  if (it.kind === 't' && local > 0) node = _splitText(node, local);
  const run = _splitRunBefore(node);
  run.parentNode.insertBefore(marker, run);
  return true;
}

/** Insert `marker` right after the text position `pos` (an end boundary). */
function _markAfter(items, pos, marker) {
  const it = _itemAt(items, pos, 'end');
  if (!it) return false;
  const local = pos - it.start;
  const run = it.node.parentNode;
  let next = null;
  if (it.kind === 't' && local < (it.text || '').length) {
    next = _splitText(it.node, local);
  } else {
    for (let c = it.node.nextSibling; c; c = c.nextSibling) {
      if (c.nodeType === 1) { next = c; break; }
    }
  }
  if (next) {
    const second = _splitRunBefore(next);
    second.parentNode.insertBefore(marker, second);
  } else {
    run.parentNode.insertBefore(marker, run.nextSibling);
  }
  return true;
}

/** Put `node` right after the child of `pEl` that contains `inner`. */
function _afterTopLevel(pEl, inner, node) {
  let top = inner;
  while (top && top.parentNode !== pEl) top = top.parentNode;
  if (!top) { pEl.appendChild(node); return; }
  pEl.insertBefore(node, top.nextSibling);
}

// ------------------------------------------------------------------
// Package plumbing
// ------------------------------------------------------------------

async function _commentsTarget(zip) {
  const relsPath = 'word/_rels/document.xml.rels';
  const relsFile = zip.file(relsPath);
  const relsDom = relsFile ? _parseXml(await relsFile.async('string')) : _parseXml(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="' + PKG_REL_NS + '"/>');
  let path = null;
  let maxId = 0;
  for (const rel of relsDom.getElementsByTagNameNS(PKG_REL_NS, 'Relationship')) {
    const m = /^rId(\d+)$/.exec(rel.getAttribute('Id') || '');
    if (m) maxId = Math.max(maxId, parseInt(m[1], 10));
    if (rel.getAttribute('Type') === COMMENTS_TYPE && rel.getAttribute('TargetMode') !== 'External') {
      const t = rel.getAttribute('Target') || '';
      path = t.charAt(0) === '/' ? t.slice(1) : 'word/' + t.replace(/^\.\//, '');
    }
  }
  return { relsDom, relsPath, path, maxId, relsChanged: false };
}

function _ensureRel(info) {
  if (info.path) return;
  const rel = info.relsDom.createElementNS(PKG_REL_NS, 'Relationship');
  rel.setAttribute('Id', 'rId' + (info.maxId + 1));
  rel.setAttribute('Type', COMMENTS_TYPE);
  rel.setAttribute('Target', 'comments.xml');
  info.relsDom.documentElement.appendChild(rel);
  info.path = 'word/comments.xml';
  info.relsChanged = true;
}

async function _ensureContentType(zip, partPath, write) {
  const f = zip.file('[Content_Types].xml');
  if (!f) return;
  const dom = _parseXml(await f.async('string'));
  const name = '/' + partPath;
  for (const o of dom.getElementsByTagNameNS(CT_NS, 'Override')) {
    if ((o.getAttribute('PartName') || '').toLowerCase() === name.toLowerCase()) return;
  }
  const o = dom.createElementNS(CT_NS, 'Override');
  o.setAttribute('PartName', name);
  o.setAttribute('ContentType', COMMENTS_CT);
  dom.documentElement.appendChild(o);
  write(dom, '[Content_Types].xml');
}

// ------------------------------------------------------------------
// Public
// ------------------------------------------------------------------

/**
 * Add comments to the fresh model `fresh` (docx-model.js) being written.
 *
 * @param {Object} fresh     the model whose _parts / _zip are being written
 * @param {Array}  comments  [{ paraId, quote, text, author }]
 * @param {Object} ctx
 *   author, isoDate         defaults for w:author / w:date
 *   idRef { n }             running id counter (shared with the revisions)
 *   project(pEl)            -> { items, R, M, mIdx } (doc-writer.js)
 *   locate(M, texts)        -> [{ ms, me }] | null
 *   familyOf: Map<pEl, para[]>
 *   currentText(paraId)     the paragraph's text after the edits
 *   warnings: []            receives { paraId, message }
 *   write(dom, path)        serializes a DOM into the zip
 *   touched: Set            receives the areas whose part changed
 * @returns {Promise<number>} comments written
 */
export async function addDocxComments(fresh, comments, ctx) {
  const list = (comments || []).filter(c => c && c.text);
  if (!list.length) return 0;
  const zip = fresh._zip;
  const warn = (paraId, message) => ctx.warnings.push({ paraId, message });

  // Styles the comment may use, only when the document defines them.
  let stylesXml = '';
  try { const sf = zip.file('word/styles.xml'); if (sf) stylesXml = await sf.async('string'); } catch (_) { /* none */ }
  const hasStyle = (id) => stylesXml.indexOf('w:styleId="' + id + '"') !== -1;
  const refStyle = hasStyle('CommentReference');
  const textStyle = hasStyle('CommentText');

  const info = await _commentsTarget(zip);
  let cDom = null;
  if (info.path && zip.file(info.path)) {
    cDom = _parseXml(await zip.file(info.path).async('string'));
  } else {
    if (!info.path) _ensureRel(info);
    cDom = _parseXml('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:comments xmlns:w="' + W_NS + '" xmlns:r="' + R_NS + '"/>');
  }
  // Ids already used by comments anywhere, so a new one never clashes.
  let maxCid = -1;
  const bump = (v) => { const n = parseInt(v, 10); if (!isNaN(n) && n > maxCid) maxCid = n; };
  for (const c of cDom.getElementsByTagNameNS(W_NS, 'comment')) bump(c.getAttributeNS(W_NS, 'id'));
  for (const area of ['body', 'footnote', 'endnote']) {
    const dom = fresh._parts[area];
    if (!dom) continue;
    for (const tag of ['commentRangeStart', 'commentRangeEnd', 'commentReference']) {
      for (const el of dom.getElementsByTagNameNS(W_NS, tag)) bump(el.getAttributeNS(W_NS, 'id'));
    }
  }
  if (ctx.idRef.n <= maxCid) ctx.idRef.n = maxCid + 1;

  const bodyDom = fresh._parts.body;
  let written = 0;

  for (const cm of list) {
    const para = fresh.paras[cm.paraId];
    if (!para || !para._el) {
      warn(cm.paraId, 'Comentario omitido: el p\u00e1rrafo ' + cm.paraId + ' no existe en el documento.');
      continue;
    }
    const id = ctx.idRef.n++;
    const crs = _w(bodyDom, 'commentRangeStart'); _setW(crs, 'id', id);
    const cre = _w(bodyDom, 'commentRangeEnd'); _setW(cre, 'id', id);
    const refRun = _w(bodyDom, 'r');
    if (refStyle) {
      const rPr = _w(bodyDom, 'rPr');
      const rs = _w(bodyDom, 'rStyle'); _setW(rs, 'val', 'CommentReference');
      rPr.appendChild(rs);
      refRun.appendChild(rPr);
    }
    const ref = _w(bodyDom, 'commentReference'); _setW(ref, 'id', id);
    refRun.appendChild(ref);

    let text = String(cm.text);
    let placed = false;

    if (para.loc.area === 'body') {
      const pEl = para._el;
      const fam = ctx.familyOf.get(pEl) || [para];
      const proj = ctx.project(pEl);
      const texts = fam.map(p => ctx.currentText(p.id));
      const loc = ctx.locate(proj.M, texts);
      let s = -1, e = -1;
      if (loc) {
        const k = fam.indexOf(para);
        const cur = texts[k];
        const quote = String(cm.quote || '');
        let qi = quote ? cur.indexOf(quote) : -1;
        if (qi < 0 && quote) qi = cur.toLowerCase().indexOf(quote.toLowerCase());
        if (qi >= 0 && quote.length) { s = loc[k].ms + qi; e = s + quote.length; }
        else if (loc[k].me > loc[k].ms) { s = loc[k].ms; e = loc[k].me; }
      }
      if (s >= 0 && e > s && e <= proj.mIdx.length) {
        const Rs = proj.mIdx[s];
        const Re = proj.mIdx[e - 1] + 1;
        // End first: the start item keeps its node and offsets.
        if (_markAfter(proj.items, Re, cre) && _markBefore(proj.items, Rs, crs)) {
          _afterTopLevel(pEl, cre, refRun);
          placed = true;
        } else if (cre.parentNode) {
          cre.parentNode.removeChild(cre);
        }
      }
      if (!placed) {
        // The whole <w:p>.
        let first = null;
        for (const c of pEl.childNodes) {
          if (c.nodeType === 1 && c.localName !== 'pPr') { first = c; break; }
        }
        pEl.insertBefore(crs, first);
        pEl.appendChild(cre);
        pEl.appendChild(refRun);
        placed = true;
      }
    } else {
      // A note paragraph: anchor on the note's call in the body.
      const tag = para.loc.area === 'footnote' ? 'footnoteReference' : 'endnoteReference';
      const fnId = String(para.loc.fnId);
      let callRun = null;
      for (const el of bodyDom.getElementsByTagNameNS(W_NS, tag)) {
        if (el.getAttributeNS(W_NS, 'id') !== fnId) continue;
        let inDel = false;
        for (let a = el.parentNode; a; a = a.parentNode) {
          if (a.nodeType === 1 && (a.localName === 'del' || a.localName === 'moveFrom')) { inDel = true; break; }
        }
        if (!inDel) { callRun = el.parentNode; break; }
      }
      let pEl = callRun;
      while (pEl && !(pEl.nodeType === 1 && pEl.localName === 'p')) pEl = pEl.parentNode;
      if (!callRun || !pEl) {
        warn(cm.paraId, 'Comentario omitido: no se encontr\u00f3 la llamada de la nota del p\u00e1rrafo ' +
          cm.paraId + '.');
        ctx.idRef.n--;
        continue;
      }
      const list2 = para.loc.area === 'footnote' ? fresh.footnotes : fresh.endnotes;
      const note = (list2 || []).find(n => String(n.id) === fnId);
      const label = note ? (note.label || note.num || fnId) : fnId;
      text = '[' + (para.loc.area === 'footnote' ? 'Nota ' : 'Nota final ') + label + '] ' + text;
      callRun.parentNode.insertBefore(crs, callRun);
      callRun.parentNode.insertBefore(cre, callRun.nextSibling);
      _afterTopLevel(pEl, cre, refRun);
      placed = true;
    }

    // The comment itself.
    const author = cm.author || ctx.author || 'UMBRA';
    const c = _w(cDom, 'comment');
    _setW(c, 'id', id);
    _setW(c, 'author', author);
    _setW(c, 'date', ctx.isoDate);
    _setW(c, 'initials', _initials(author));
    const lines = text.split(/\r?\n/);
    lines.forEach((line, k) => {
      const p = _w(cDom, 'p');
      if (textStyle) {
        const pPr = _w(cDom, 'pPr');
        const ps = _w(cDom, 'pStyle'); _setW(ps, 'val', 'CommentText');
        pPr.appendChild(ps);
        p.appendChild(pPr);
      }
      if (k === 0) {
        const ar = _w(cDom, 'r');
        if (refStyle) {
          const rPr = _w(cDom, 'rPr');
          const rs = _w(cDom, 'rStyle'); _setW(rs, 'val', 'CommentReference');
          rPr.appendChild(rs);
          ar.appendChild(rPr);
        }
        ar.appendChild(_w(cDom, 'annotationRef'));
        p.appendChild(ar);
      }
      const r = _w(cDom, 'r');
      const t = _w(cDom, 't');
      t.setAttributeNS(XML_NS, 'xml:space', 'preserve');
      t.textContent = line;
      r.appendChild(t);
      p.appendChild(r);
      c.appendChild(p);
    });
    cDom.documentElement.appendChild(c);
    ctx.touched.add('body');
    written++;
  }

  if (!written) return 0;
  ctx.write(cDom, info.path);
  if (info.relsChanged) ctx.write(info.relsDom, info.relsPath);
  await _ensureContentType(zip, info.path, ctx.write);
  return written;
}
