/**
 * Origin: COMeT services/docx-track-changes.js @ 04540f5 (adapted)
 *
 * docx-track-changes.js - The SHARED engine that writes a user's edit into an
 * existing Word paragraph as tracked changes (<w:ins> / <w:del> / <w:rPrChange>).
 *
 * Used by the Correction Tracker and by the Final Check, which used to carry
 * two different implementations of the same job -- and therefore the same bug
 * twice: both rebuilt the paragraph from its plain text and silently lost
 * everything that is not text (the <w:tab/> that indents the first line of a UN
 * document, manual line breaks, comment anchors, bookmarks, note calls,
 * hyperlinks, images, fields, and the revisions the file already carried).
 *
 * THE RULE THIS MODULE EXISTS TO ENFORCE: the exported file differs from the
 * original ONLY where the user changed something. Nothing is removed,
 * normalised or reformatted on COMeT's initiative.
 *
 * HOW IT WORKS. The paragraph keeps its own XML. The engine projects it to a
 * flat string, diffs that against the text the user wants, and then splits ONLY
 * the runs holding the words that changed. Text that stays is re-emitted as a
 * SLICE of the original string, so even double spaces survive; every other node
 * is left exactly where it was, with its own <w:rPr>.
 *
 * Because each run is replaced inside ITS OWN parent, deleting text that lives
 * inside somebody else's <w:ins> produces the standard
 * <w:ins author="X"><w:del author="Translator">... structure instead of
 * flattening that reviewer's revision.
 *
 * THE PROJECTION IS THE CONTRACT. A caller diffs against the text ITS OWN
 * reader produced, so the engine must project the XML to exactly that string or
 * the offsets drift. `opts.atomText` maps every non-<w:t> element to the text
 * the caller's reader gives it:
 *
 *   - Correction Tracker (file-parsers.js reads <w:t> only): the default, i.e.
 *     every other element projects to nothing.
 *   - Final Check (docx-model.js): tab -> "\t", break -> " ",
 *     noBreakHyphen -> "-", note call -> its "[[n5]]" marker.
 *
 * An element projecting to WHITESPACE or to nothing is never deleted: that is
 * what keeps an indent tab or a manual line break from disappearing when the
 * words around it are replaced. A deletion covering it is split around it.
 * A projection can opt into being deletable (a non-breaking hyphen belongs to
 * the word that contains it, so it must go when that word goes).
 *
 * ASCII ONLY (project rule): non-ASCII characters must be \uXXXX escapes.
 */

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';

// ------------------------------------------------------------------
// Reading the paragraph
// ------------------------------------------------------------------

/**
 * The runs of a paragraph that hold its CURRENT text, in document order, with
 * every child mapped to character offsets of the projected string.
 *
 * <w:del> / <w:moveFrom> subtrees are skipped: their text (<w:delText>) is not
 * part of what the document currently reads and must stay untouched. Everything
 * else (<w:ins>, <w:hyperlink>, <w:smartTag>, <w:sdt>, ...) is walked into, so
 * text inside those wrappers is editable in place.
 *
 * item = { kind:'t', node, start, end, text }
 *      | { kind:'x', node, start, end, text, deletable }
 */
export function collectRuns(pEl, atomText) {
  const runs = [];
  let offset = 0;

  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType !== 1) continue;
      const ln = child.localName;
      if (ln === 'pPr' || ln === 'del' || ln === 'moveFrom') continue;

      if (ln === 'r') {
        const items = [];
        for (const rc of child.childNodes) {
          if (rc.nodeType !== 1) continue;
          if (rc.localName === 'rPr') continue;      // stays on the run itself
          if (rc.localName === 't') {
            const text = rc.textContent || '';
            items.push({ kind: 't', node: rc, start: offset, end: offset + text.length, text });
            offset += text.length;
          } else {
            const proj = atomText ? atomText(rc) : null;
            const text = (proj && typeof proj.text === 'string') ? proj.text : '';
            // Whitespace and zero-length projections are structure, not words:
            // a tab or a line break must survive an edit of the words around it.
            const deletable = !!(proj && proj.deletable) && !!text && /\S/.test(text);
            items.push({ kind: 'x', node: rc, start: offset, end: offset + text.length, text, deletable });
            offset += text.length;
          }
        }
        runs.push({ runEl: child, items });
        continue;
      }

      walk(child);
    }
  };

  walk(pEl);
  return runs;
}

/**
 * The text a paragraph currently reads, in the caller's own coordinate system.
 * @param {Element} pEl
 * @param {Function} [atomText] see the module header
 */
export function paragraphText(pEl, atomText) {
  let text = '';
  for (const r of collectRuns(pEl, atomText)) {
    for (const it of r.items) text += it.text;
  }
  return text;
}

// ------------------------------------------------------------------
// Diffing
// ------------------------------------------------------------------

/** Word spans of a text: [{ start, end, val }] (one per stretch of non-space). */
function wordSpans(text) {
  const out = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(text || '')) !== null) {
    out.push({ start: m.index, end: m.index + m[0].length, val: m[0] });
  }
  return out;
}

/**
 * Word-level LCS diff -> [{ type:'eq'|'del'|'ins', val }] (one entry per word).
 * This is the diff both panels show the user, so what is displayed is exactly
 * what gets marked up in the file.
 */
export function computeWordDiff(oldText, newText) {
  const oldWords = (oldText || '').trim().split(/\s+/).filter(w => w);
  const newWords = (newText || '').trim().split(/\s+/).filter(w => w);
  return diffWordLists(oldWords, newWords);
}

function diffWordLists(oldWords, newWords) {
  const m = oldWords.length, n = newWords.length;
  if (!m && !n) return [];
  if (!m) return newWords.map(w => ({ type: 'ins', val: w }));
  if (!n) return oldWords.map(w => ({ type: 'del', val: w }));

  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = oldWords[i - 1] === newWords[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  let i = m, j = n;
  const parts = [];
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldWords[i - 1] === newWords[j - 1]) {
      parts.unshift({ type: 'eq', val: oldWords[i - 1], oi: i - 1, ni: j - 1 }); i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      parts.unshift({ type: 'ins', val: newWords[j - 1], ni: j - 1 }); j--;
    } else {
      parts.unshift({ type: 'del', val: oldWords[i - 1], oi: i - 1 }); i--;
    }
  }
  return parts;
}

// ------------------------------------------------------------------
// Run properties: applying the user's formatting
// ------------------------------------------------------------------
// A "marks" object says what a stretch of text must END UP looking like:
// { b, i, u, sup, sub }. It is applied ON TOP of the run's existing <w:rPr>, so
// colour, size, font, language and highlight are preserved untouched.
//
// A KEY THAT IS ABSENT (undefined) MEANS "LEAVE THAT ONE AS IT IS", which is not
// the same as false ("turn it off"). The difference matters: a caller that only
// wants to ADD bold names b alone, and the superscript, the italics and the
// underline the text already carries survive. Passing all five keys, as the
// paragraph editor does, states the whole look and behaves exactly as before --
// which is why the editor's own bold/italic toggles still turn a mark OFF. A change
// over text that STAYS is recorded as a Word format revision (<w:rPrChange>
// carrying the previous properties), so the reviewer can accept or reject it
// like any other tracked change. Inserted text needs none: the run is already
// inside a <w:ins>.

// Every on/off property the model reads and this engine can therefore write
// back as a Word FORMAT REVISION. The valued ones (size, colour,
// highlighting) are deliberately absent: they are not toggles, so they need
// a value to carry and a different merge rule.
const MARK_KEYS = ['b', 'i', 'u', 'sup', 'sub', 'strike', 'caps', 'smallCaps'];

/** The marks an existing <w:rPr> already carries. */
function marksOfRpr(rPr) {
  const m = { b: false, i: false, u: false, sup: false, sub: false,
    strike: false, caps: false, smallCaps: false };
  if (!rPr) return m;
  for (const child of rPr.childNodes) {
    if (child.nodeType !== 1) continue;
    const ln = child.localName;
    const val = child.getAttributeNS ? child.getAttributeNS(W_NS, 'val') : null;
    const off = (val === '0' || val === 'false' || val === 'none');
    if (ln === 'b') m.b = !off;
    else if (ln === 'i') m.i = !off;
    else if (ln === 'u') m.u = !off;
    else if (ln === 'strike') m.strike = !off;
    else if (ln === 'caps') m.caps = !off;
    else if (ln === 'smallCaps') m.smallCaps = !off;
    else if (ln === 'vertAlign') {
      m.sup = (val === 'superscript');
      m.sub = (val === 'subscript');
    }
  }
  return m;
}

/**
 * The end state of a stretch: the marks the caller NAMED, over the ones the run
 * already carries. An unnamed key keeps the run's own value, so nothing the
 * caller did not mention is ever changed.
 */
function resolveMarks(had, marks) {
  if (!marks) return null;
  const out = {};
  for (const k of MARK_KEYS) {
    out[k] = (marks[k] === undefined || marks[k] === null) ? !!(had && had[k]) : !!marks[k];
  }
  return out;
}

function marksKey(marks) {
  if (!marks) return '-';
  return MARK_KEYS.map(k => (marks[k] ? '1' : '0')).join('');
}

function dropRprChild(rPr, name) {
  const kids = [];
  for (const c of rPr.childNodes) if (c.nodeType === 1 && c.localName === name) kids.push(c);
  for (const c of kids) rPr.removeChild(c);
}

// The order Word REQUIRES for the children of <w:rPr> (CT_RPr). An element
// out of this order is a file Word calls unreadable and "repairs": appending a
// new <w:i> after the <w:lang> or <w:sz> the run already had -- which is what
// the marks used to do -- was enough.
const RPR_ORDER = ['rStyle', 'rFonts', 'b', 'bCs', 'i', 'iCs', 'caps', 'smallCaps', 'strike', 'dstrike',
  'outline', 'shadow', 'emboss', 'imprint', 'noProof', 'snapToGrid', 'vanish', 'webHidden', 'color',
  'spacing', 'w', 'kern', 'position', 'sz', 'szCs', 'highlight', 'u', 'effect', 'bdr', 'shd', 'fitText',
  'vertAlign', 'rtl', 'cs', 'em', 'lang', 'eastAsianLayout', 'specVanish', 'oMath', 'rPrChange'];

/** Put `el` into `rPr` at its place in RPR_ORDER. */
export function putRprChild(rPr, el) {
  const rank = RPR_ORDER.indexOf(el.localName);
  for (let c = rPr.firstChild; c; c = c.nextSibling) {
    if (c.nodeType !== 1) continue;
    const r = RPR_ORDER.indexOf(c.localName);
    if (r > rank) { rPr.insertBefore(el, c); return; }
  }
  rPr.appendChild(el);
}

/** Replace the `rPr` child of the same name as `el` (if any) by `el`, in order. */
export function setRprChild(rPr, el) {
  for (let c = rPr.firstChild; c; ) {
    const next = c.nextSibling;
    if (c.nodeType === 1 && c.localName === el.localName) rPr.removeChild(c);
    c = next;
  }
  putRprChild(rPr, el);
}

/**
 * The <w:rPr> for a stretch: the original properties with the user's marks on
 * top. `trackFormat` adds the <w:rPrChange> when the marks really change the
 * look of text that stays. Returns null when there is nothing to write.
 */
function buildRpr(dom, baseRPr, rawMarks, trackFormat, author, isoDate, revIdRef) {
  if (!rawMarks) return baseRPr ? baseRPr.cloneNode(true) : null;

  const had = marksOfRpr(baseRPr);
  // What the caller NAMED, over what the run already is: an unnamed mark keeps
  // the run's value instead of being read as "off".
  const marks = resolveMarks(had, rawMarks);
  const changed = marksKey(had) !== marksKey(marks);
  if (!changed) return baseRPr ? baseRPr.cloneNode(true) : null;

  const rPr = baseRPr ? baseRPr.cloneNode(true) : dom.createElementNS(W_NS, 'w:rPr');
  // Toggle on -> the bare element; toggle off -> an explicit val="0", but only
  // when it was on before (so a bold inherited from the style is really off).
  for (const name of ['b', 'i', 'u', 'strike', 'caps', 'smallCaps']) {
    dropRprChild(rPr, name);
    if (marks[name]) {
      const el = dom.createElementNS(W_NS, 'w:' + name);
      if (name === 'u') el.setAttributeNS(W_NS, 'w:val', 'single');
      putRprChild(rPr, el);
    } else if (had[name]) {
      const el = dom.createElementNS(W_NS, 'w:' + name);
      el.setAttributeNS(W_NS, 'w:val', name === 'u' ? 'none' : '0');
      putRprChild(rPr, el);
    }
  }
  dropRprChild(rPr, 'vertAlign');
  if (marks.sup || marks.sub) {
    const el = dom.createElementNS(W_NS, 'w:vertAlign');
    el.setAttributeNS(W_NS, 'w:val', marks.sup ? 'superscript' : 'subscript');
    putRprChild(rPr, el);
  } else if (had.sup || had.sub) {
    const el = dom.createElementNS(W_NS, 'w:vertAlign');
    el.setAttributeNS(W_NS, 'w:val', 'baseline');
    putRprChild(rPr, el);
  }

  if (trackFormat) {
    // ONE <w:rPrChange>, the last child: a run that came with a format change
    // of its own keeps one record, now this one.
    dropRprChild(rPr, 'rPrChange');
    const chg = dom.createElementNS(W_NS, 'w:rPrChange');
    chg.setAttributeNS(W_NS, 'w:id', String(revIdRef.n++));
    chg.setAttributeNS(W_NS, 'w:author', author);
    chg.setAttributeNS(W_NS, 'w:date', isoDate);
    // The PREVIOUS properties go inside, as Word expects (without a change
    // record of their own: one may not nest inside another).
    const prev = baseRPr ? baseRPr.cloneNode(true) : dom.createElementNS(W_NS, 'w:rPr');
    dropRprChild(prev, 'rPrChange');
    chg.appendChild(prev);
    rPr.appendChild(chg);
  }
  return rPr.childNodes.length ? rPr : null;
}

/** The marks the caller asked for at character `pos` of the NEW text. */
function marksAt(spans, pos) {
  if (!spans || !spans.length) return null;
  for (let i = 0; i < spans.length; i++) {
    if (pos >= spans[i].start && pos < spans[i].end) return spans[i];
  }
  return null;
}

// ------------------------------------------------------------------
// Planning: what has to change, expressed over the projected string
// ------------------------------------------------------------------

/**
 * Work out what has to change, expressed over the projected string.
 *
 *   deletes  = [{ start, end }]                     ranges of srcText that go
 *   inserts  = [{ pos, pieces:[{ text, marks }] }]  text that comes in
 *   keepMarks= Array<marks|null>, srcText length    formatting for text that stays
 *
 * HOW. The words both texts have in common are the ANCHORS; everything between
 * two anchors is replaced as one REGION, after stripping whatever prefix and
 * suffix the two sides already share. Working in regions rather than in
 * separate word deletions and insertions means the spacing the user typed is
 * reproduced exactly, instead of being guessed at by rules about which space
 * belongs to which word.
 *
 * BARRIERS. An element that projects to visible text and cannot be deleted --
 * in practice a note call shown as "[[n5]]" -- would otherwise be swallowed
 * into the word next to it ("Melissa[[n5]]" is one token for a word-level
 * diff), and replacing that word would re-insert the marker as ordinary text
 * while the real call stayed put: the call would appear TWICE. So the edit is
 * cut into chunks at those elements and each chunk is planned on its own. The
 * barrier itself never takes part in the diff, so it can be neither duplicated
 * nor moved.
 *
 * Returns null when the new text does not carry the same barriers, in the same
 * order, as the paragraph: refusing to write anything is the only safe answer.
 */
function planEdit(srcText, newText, userMarks, deletable, barriers) {
  const full = String(newText == null ? '' : newText);

  // Chunk both strings at the barriers.
  const chunks = [];
  let sPos = 0, nPos = 0;
  for (const b of (barriers || [])) {
    const at = full.indexOf(b.text, nPos);
    if (at < 0) return null;
    chunks.push({ s0: sPos, s1: b.start, n0: nPos, n1: at });
    sPos = b.end; nPos = at + b.text.length;
  }
  chunks.push({ s0: sPos, s1: srcText.length, n0: nPos, n1: full.length });

  const deletes = [];
  const inserts = [];
  const keepMarks = userMarks ? new Array(srcText.length).fill(null) : null;
  const markFor = (newPos) => (userMarks ? marksAt(userMarks, newPos) : null);

  // A deletion never removes a protected character (an indent tab, a manual
  // line break): the range is split around it and the element stays.
  const pushDeletes = (from, to) => {
    let open = -1;
    for (let c = from; c < to; c++) {
      const ok = !deletable || deletable[c];
      if (ok && open < 0) open = c;
      else if (!ok && open >= 0) { deletes.push({ start: open, end: c }); open = -1; }
    }
    if (open >= 0) deletes.push({ start: open, end: to });
  };

  const piecesFor = (newStart, text) => {
    const pieces = [];
    for (let c = 0; c < text.length; c++) {
      const marks = markFor(newStart + c);
      const last = pieces[pieces.length - 1];
      if (last && marksKey(last.marks) === marksKey(marks)) last.text += text[c];
      else pieces.push({ text: text[c], marks });
    }
    return pieces;
  };

  for (let ci = 0; ci < chunks.length; ci++) {
    const ch = chunks[ci];
    const oldW = wordSpans(srcText.slice(ch.s0, ch.s1))
      .map(w => ({ start: w.start + ch.s0, end: w.end + ch.s0, val: w.val }));
    const newW = wordSpans(full.slice(ch.n0, ch.n1))
      .map(w => ({ start: w.start + ch.n0, end: w.end + ch.n0, val: w.val }));
    const parts = diffWordLists(oldW.map(w => w.val), newW.map(w => w.val));

    const anchors = [];
    let oi = 0, ni = 0;
    for (const part of parts) {
      if (part.type === 'eq') { anchors.push({ o: oldW[oi], n: newW[ni] }); oi++; ni++; }
      else if (part.type === 'del') oi++;
      else ni++;
    }

    // Formatting for the text that stays.
    if (keepMarks) {
      let lastEnd = 0;
      for (const an of anchors) {
        for (let c = 0; c < an.o.end - an.o.start; c++) {
          keepMarks[an.o.start + c] = markFor(an.n.start + c);
        }
        // The gap before this word takes the formatting only when BOTH sides
        // agree, so the inside of a bolded phrase stays bold while the space
        // beside it is left exactly as it was. A gap at a boundary keeps null,
        // which means "do not touch this run's properties".
        if (lastEnd > 0 && lastEnd < an.o.start &&
            marksKey(keepMarks[lastEnd - 1]) === marksKey(keepMarks[an.o.start])) {
          for (let c = lastEnd; c < an.o.start; c++) keepMarks[c] = keepMarks[an.o.start];
        }
        lastEnd = an.o.end;
      }
    }

    // Replace each region between anchors.
    let oPrev = ch.s0, nPrev = ch.n0;
    const region = (oEnd, nEnd, isOuter) => {
      const oldR = srcText.slice(oPrev, oEnd);
      const newR = full.slice(nPrev, nEnd);
      if (oldR === newR) return;
      // The outer edges of the PARAGRAPH are not reconciled when the only
      // difference is whitespace: the caller's reader may have trimmed the
      // text it showed the user, and an indent is never ours to remove.
      if (isOuter && !oldR.trim() && !newR.trim()) return;

      let a = 0;
      while (a < oldR.length && a < newR.length && oldR[a] === newR[a]) a++;
      let b = 0;
      while (b < oldR.length - a && b < newR.length - a &&
             oldR[oldR.length - 1 - b] === newR[newR.length - 1 - b]) b++;

      // WHAT STAYS OF A CHANGED STRETCH takes the formatting asked for, like
      // any word that stays. "omnes." -> "omnes" keeps "omnes" and only takes
      // the full stop out, but that "omnes" is no anchor of the word diff, so
      // it kept the file's look: italics put on "erga omnes" in the edit box
      // reached "erga" and never "omnes". Blanks are left as they are (null:
      // not touched), as at the edges of a formatted phrase.
      if (keepMarks) {
        for (let c = 0; c < a; c++) {
          if (!/\s/.test(oldR[c])) keepMarks[oPrev + c] = markFor(nPrev + c);
        }
        for (let c = 0; c < b; c++) {
          if (!/\s/.test(oldR[oldR.length - 1 - c])) keepMarks[oEnd - 1 - c] = markFor(nEnd - 1 - c);
        }
      }

      const delFrom = oPrev + a, delTo = oEnd - b;
      if (delTo > delFrom) pushDeletes(delFrom, delTo);
      const insText = newR.slice(a, newR.length - b);
      if (insText) inserts.push({ pos: delFrom, pieces: piecesFor(nPrev + a, insText) });
    };

    for (const an of anchors) {
      region(an.o.start, an.n.start, ci === 0 && oPrev === 0);
      oPrev = an.o.end; nPrev = an.n.end;
    }
    region(ch.s1, ch.n1, ci === chunks.length - 1);
  }

  deletes.sort((a, b) => a.start - b.start);
  inserts.sort((a, b) => a.pos - b.pos);
  return { deletes, inserts, keepMarks };
}

function inAnyDelete(pos, deletes) {
  for (const d of deletes) {
    if (pos >= d.start && pos < d.end) return true;
    if (d.start > pos) break;
  }
  return false;
}

function overlapsDelete(start, end, deletes) {
  for (const d of deletes) if (d.start < end && d.end > start) return true;
  return false;
}

// ------------------------------------------------------------------
// Execution: splicing the runs
// ------------------------------------------------------------------

/**
 * Apply `newText` to the paragraph `pEl` as tracked changes.
 *
 * @param {Element} pEl      the <w:p> to edit (mutated in place)
 * @param {string}  newText  what the paragraph must read, in the SAME
 *                           coordinate system the projection produces
 * @param {Object}  opts
 *   author    revision author (default 'Translator')
 *   isoDate   revision timestamp
 *   revIdRef  { n } running w:id counter, shared with the caller
 *   marks     [{ start, end, b, i, u, sup, sub }] absolute spans over newText
 *   atomText  fn(el) -> { text, deletable } | null   (see the module header)
 * @returns {number} revisions written; 0 means the paragraph already read like
 *          `newText` with that formatting and was NOT touched at all.
 */
export function applyTrackedEdit(pEl, newText, opts) {
  const dom = pEl.ownerDocument;
  const o = opts || {};
  const author = o.author || 'Translator';
  const isoDate = o.isoDate || new Date().toISOString();
  const revIdRef = o.revIdRef || { n: 1000 };
  const atomText = o.atomText || null;
  const userMarks = (Array.isArray(o.marks) && o.marks.length) ? o.marks : null;
  // opts.lineBreaks: a "\n" in the INSERTED text is a manual line break the
  // user typed (Final Check, Shift+Enter) and is written as <w:br/>. Off by
  // default, so a caller whose text may carry stray newlines is unaffected.
  const lineBreaks = !!o.lineBreaks;

  const runs = collectRuns(pEl, atomText);
  let srcText = '';
  const deletable = [];   // per character: may the engine remove it?
  const barriers = [];    // protected elements that show as text (note calls)
  for (const r of runs) {
    for (const it of r.items) {
      const ok = (it.kind === 't') || !!it.deletable;
      if (!ok && it.text && /\S/.test(it.text)) {
        barriers.push({ start: it.start, end: it.end, text: it.text });
      }
      srcText += it.text;
      for (let c = 0; c < it.text.length; c++) deletable.push(ok);
    }
  }

  const plan = planEdit(srcText, newText, userMarks, deletable, barriers);
  // The new text lost or reordered a note call: write nothing at all.
  if (!plan) return 0;
  const { deletes, inserts, keepMarks } = plan;
  if (!deletes.length && !inserts.length && !keepMarks) return 0;

  const srcLen = srcText.length;
  const insQueue = inserts.slice();
  const revsBefore = revIdRef.n;

  const mkText = (tag, text) => {
    const el = dom.createElementNS(W_NS, 'w:' + tag);
    el.setAttributeNS(XML_NS, 'xml:space', 'preserve');
    el.textContent = text;
    return el;
  };
  const mkRev = (tag) => {
    const el = dom.createElementNS(W_NS, 'w:' + tag);
    el.setAttributeNS(W_NS, 'w:id', String(revIdRef.n++));
    el.setAttributeNS(W_NS, 'w:author', author);
    el.setAttributeNS(W_NS, 'w:date', isoDate);
    return el;
  };

  // WHOSE PROPERTIES A PIECE OF INSERTED TEXT TAKES.
  //
  // A note call is a run of its OWN, carrying the FootnoteReference character
  // style -- superscript, and several points smaller. Text queued to go in
  // beside it was written with THAT run's properties, because the properties
  // came from whichever run happened to be under the cursor when the queue was
  // emptied. So when a call was dragged in a paragraph the reviewer had already
  // corrected, the words it travelled past were re-inserted in the tiny
  // superscript font of the call itself, and the exported file showed a whole
  // clause in footnote type.
  //
  // Words take the properties of the WORDS around them. This picks, for every
  // run, the properties an insertion emitted there must use: this run's own if
  // it really carries text, otherwise those of the nearest run that does --
  // behind first, since inserted text reads as a continuation of what precedes
  // it, and ahead only when there is nothing behind.
  const rprOfRun = (runEl) => {
    for (const c of runEl.childNodes) {
      if (c.nodeType === 1 && c.localName === 'rPr') return c;
    }
    return null;
  };
  const carriesText = (r) => r.items.some(it => it.kind === 't');
  const insRPrByRun = runs.map((r, i) => {
    if (carriesText(r)) return rprOfRun(r.runEl);
    for (let k = i - 1; k >= 0; k--) if (carriesText(runs[k])) return rprOfRun(runs[k].runEl);
    for (let k = i + 1; k < runs.length; k++) if (carriesText(runs[k])) return rprOfRun(runs[k].runEl);
    return null;
  });

  for (let ri = 0; ri < runs.length; ri++) {
    const r = runs[ri];
    // The run's own properties, cloned onto every piece it is split into.
    let baseRPr = null;
    for (const c of r.runEl.childNodes) {
      if (c.nodeType === 1 && c.localName === 'rPr') { baseRPr = c; break; }
    }
    const baseKey = marksKey(marksOfRpr(baseRPr));

    // Does anything happen inside THIS run? An untouched run is left alone:
    // same node, same properties, same position in its parent.
    let touched = false;
    for (const it of r.items) {
      if (it.end > it.start && overlapsDelete(it.start, it.end, deletes)) {
        // A deletion that only spans a protected atom changes nothing here.
        if (it.kind === 't' || it.deletable) { touched = true; break; }
      }
      // Which item CLAIMS a pending insertion has to be decided here exactly as
      // it is below, or an insertion whose run is judged untouched ends up
      // adrift at the end of the paragraph. A text item takes everything due
      // before it ends (an overdue offset lands at its first cut point); a
      // barrier takes what is due before it starts.
      const isBarrier = it.kind === 'x' && !it.deletable && !!it.text && /\S/.test(it.text);
      for (const ins of insQueue) {
        if (it.kind === 't' && it.end > it.start &&
            (ins.pos < it.end || (ins.pos === it.end && it.end === srcLen))) {
          touched = true; break;
        }
        if (isBarrier && ins.pos <= it.start) { touched = true; break; }
      }
      if (touched) break;
      if (keepMarks && it.kind === 't') {
        for (let c = it.start; c < it.end; c++) {
          const mk = keepMarks[c];
          if (mk && marksKey(resolveMarks(marksOfRpr(baseRPr), mk)) !== baseKey &&
              !inAnyDelete(c, deletes)) { touched = true; break; }
        }
        if (touched) break;
      }
    }
    if (!touched) continue;

    const out = [];       // the nodes that will take this run's place
    let pending = [];     // children of the plain run being accumulated
    let pendingMarks;     // the marks in force for `pending` (undefined = none yet)

    const mkRun = (marks, trackFormat) => {
      const run = dom.createElementNS(W_NS, 'w:r');
      const rPr = buildRpr(dom, baseRPr, marks || null, trackFormat, author, isoDate, revIdRef);
      if (rPr) run.appendChild(rPr);
      return run;
    };
    // Inserted text, which takes the properties of the surrounding WORDS and
    // never those of a barrier standing beside them (see insRPrByRun).
    const mkInsRun = (marks) => {
      const run = dom.createElementNS(W_NS, 'w:r');
      const rPr = buildRpr(dom, insRPrByRun[ri], marks || null, false, author, isoDate, revIdRef);
      if (rPr) run.appendChild(rPr);
      return run;
    };
    const flush = () => {
      if (!pending.length) return;
      const run = mkRun(pendingMarks, true);
      for (const n of pending) run.appendChild(n);
      out.push(run);
      pending = []; pendingMarks = undefined;
    };
    const addPending = (node, marks) => {
      if (pending.length && marksKey(pendingMarks || null) !== marksKey(marks || null)) flush();
      pendingMarks = marks || null;
      pending.push(node);
    };
    const emitDelete = (node) => {
      flush();
      const del = mkRev('del');
      const run = mkRun(null, false);
      run.appendChild(node);
      del.appendChild(run);
      out.push(del);
    };
    const emitInsert = (pieces) => {
      flush();
      const ins = mkRev('ins');
      for (const piece of pieces) {
        const run = mkInsRun(piece.marks);
        if (lineBreaks && piece.text.indexOf('\n') !== -1) {
          const parts = piece.text.split('\n');
          parts.forEach((part, k) => {
            if (k) run.appendChild(dom.createElementNS(W_NS, 'w:br'));
            if (part) run.appendChild(mkText('t', part));
          });
        } else {
          run.appendChild(mkText('t', piece.text));
        }
        ins.appendChild(run);
      }
      out.push(ins);
    };
    // Overdue insertions go in at the first boundary at or after their offset,
    // so a position that never becomes a cut point cannot stall the queue.
    const takeInserts = (pos) => {
      while (insQueue.length && insQueue[0].pos <= pos) emitInsert(insQueue.shift().pieces);
    };

    for (const it of r.items) {
      if (it.kind === 'x') {
        // A protected element (tab, line break, note call...) never moves and
        // never disappears; only one that projects to word text can be deleted
        // along with the word it belongs to.
        //
        // Text queued for the end of a chunk goes in BEFORE a barrier (a note
        // call closes its chunk), but NOT before a tab or a line break: text
        // added at the head of an indented paragraph must land AFTER the
        // indent, not in front of it.
        if (it.text && /\S/.test(it.text) && !it.deletable) takeInserts(it.start);
        if (it.deletable && it.end > it.start && inAnyDelete(it.start, deletes)) {
          emitDelete(it.node.cloneNode(true));
        } else {
          addPending(it.node.cloneNode(true), keepMarks ? keepMarks[it.start] : null);
        }
        continue;
      }

      const cuts = new Set([it.start, it.end]);
      for (const d of deletes) {
        if (d.start > it.start && d.start < it.end) cuts.add(d.start);
        if (d.end > it.start && d.end < it.end) cuts.add(d.end);
      }
      for (const ins of insQueue) {
        if (ins.pos > it.start && ins.pos < it.end) cuts.add(ins.pos);
      }
      if (keepMarks) {
        for (let c = it.start + 1; c < it.end; c++) {
          if (marksKey(keepMarks[c]) !== marksKey(keepMarks[c - 1])) cuts.add(c);
        }
      }
      const points = Array.from(cuts).sort((a, b) => a - b);

      for (let k = 0; k < points.length - 1; k++) {
        const a = points[k], b = points[k + 1];
        takeInserts(a);
        const piece = it.text.slice(a - it.start, b - it.start);
        if (inAnyDelete(a, deletes)) emitDelete(mkText('delText', piece));
        else addPending(mkText('t', piece), keepMarks ? keepMarks[a] : null);
      }
      // Text appended at the very end of the paragraph.
      if (it.end === srcLen) takeInserts(it.end);
    }

    flush();

    const parent = r.runEl.parentNode;
    for (const n of out) parent.insertBefore(n, r.runEl);
    parent.removeChild(r.runEl);
  }

  // An empty paragraph (or an insertion with nowhere to anchor) gets its text
  // appended at the end, after everything already there.
  //
  // WITH THE PROPERTIES OF THE PARAGRAPH'S OWN WORDS, not with none at all.
  // A paragraph that ends in a note call sends its appended text down this
  // path -- a barrier claims nothing queued beyond it -- and writing it with no
  // properties left it to the paragraph default: in a document whose body runs
  // carry an explicit size, a sentence added at the end came out in a different
  // type from the sentence before it. The same rule as everywhere else: words
  // look like the words around them.
  const tailRPr = runs.length ? insRPrByRun[runs.length - 1] : null;
  while (insQueue.length) {
    const ins = mkRev('ins');
    for (const piece of insQueue.shift().pieces) {
      const run = dom.createElementNS(W_NS, 'w:r');
      const rPr = buildRpr(dom, tailRPr, piece.marks || null, false, author, isoDate, revIdRef);
      if (rPr) run.appendChild(rPr);
      run.appendChild(mkText('t', piece.text));
      ins.appendChild(run);
    }
    pEl.appendChild(ins);
  }

  return revIdRef.n - revsBefore;
}
