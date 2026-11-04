/**
 * Origin: COMeT modules/final-check/export-verify.js @ 04540f5 (adapted)
 *
 * export-verify.js - Checks the DOCX an export has just produced, BEFORE it is
 * saved, for the one thing a reviewer cannot see by looking at the text: that
 * every note call still points at its note, and every note is still there.
 *
 * WHY. The export rewrites paragraphs that carry note calls (corrections,
 * punctuation moved across a call, calls dragged to another place). A call is
 * only a pointer to a note by its id; a mistake there does not show on the
 * page until somebody accepts or rejects the changes in Word -- and then it is
 * a note gone missing, a call pointing at nothing, or the same note called
 * twice. This looks for exactly that, in the file itself.
 *
 * HOW. The exported file is read back and compared with the file that was
 * loaded, in the two states a reviser can bring it to:
 *   - with every change ACCEPTED (deletions dropped, insertions kept), and
 *   - with every change REJECTED (insertions dropped, deletions kept).
 * A correction may MOVE a call, but it never adds or removes one, so in each
 * state every note must be called exactly as many times as in the original.
 * On top of that, every called note must exist and keep its own number mark
 * and its text. Anything the ORIGINAL already had wrong is not blamed on the
 * export: only differences are reported.
 *
 * IMAGES TOO (imageCensus). The export only rewrites text parts and never
 * removes a picture, but an auditor once found a revised file "without
 * images". So the pictures are counted as well: per part of the file (body,
 * notes, headers, footers), the graphic objects (w:drawing, w:pict, w:object)
 * and the image files they point at. The census of the ORIGINAL is taken when
 * the file is loaded (docx-model.js, model._imageCensus), from the untouched
 * package; the exported file must have as many objects in every part, and
 * every image file it points at must be in it.
 *
 * WHAT IT CANNOT DO. It reads the file; it does not run Word. It proves the
 * file is consistent in both states, not how Word will behave inside.
 *
 * ASCII ONLY: non-ASCII characters in strings are written as \uXXXX escapes.
 */

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

const PARTS = {
  body: 'word/document.xml',
  footnote: 'word/footnotes.xml',
  endnote: 'word/endnotes.xml'
};

// The wrappers each state drops, with everything inside them.
const DROP = {
  accepted: ['del', 'moveFrom'],
  rejected: ['ins', 'moveTo']
};

/**
 * Walk `root` in document order, skipping the subtrees a state drops, and call
 * `visit(el)` on every element kept.
 */
function _walk(root, state, visit) {
  const drop = DROP[state];
  const stack = [root];
  while (stack.length) {
    const el = stack.pop();
    if (el.nodeType !== 1) continue;
    if (el !== root && el.namespaceURI === W_NS && drop.indexOf(el.localName) !== -1) continue;
    visit(el);
    for (let c = el.lastChild; c; c = c.previousSibling) if (c.nodeType === 1) stack.push(c);
  }
}

/**
 * What one file looks like in one state:
 *   calls: { fn: Map id -> count, en: Map id -> count }
 *   notes: { fn: Map id -> { marks, text }, en: ... }   (normal notes only)
 */
function _survey(doms, state, clones) {
  const calls = { fn: new Map(), en: new Map() };
  const notes = { fn: new Map(), en: new Map() };
  // A note copied for a moved call is counted as the note it copies.
  const bump = (m, id, kind) => {
    const alias = clones && clones[kind] ? clones[kind].get(String(id)) : null;
    const k = alias !== null && alias !== undefined ? alias : id;
    m.set(k, (m.get(k) || 0) + 1);
  };

  // Calls: in the body, and (endnote calls only) inside footnotes too.
  const countCalls = (dom) => {
    if (!dom) return;
    _walk(dom.documentElement, state, (el) => {
      if (el.namespaceURI !== W_NS) return;
      if (el.localName === 'footnoteReference') bump(calls.fn, el.getAttributeNS(W_NS, 'id'), 'fn');
      else if (el.localName === 'endnoteReference') bump(calls.en, el.getAttributeNS(W_NS, 'id'), 'en');
    });
  };
  countCalls(doms.body);
  countCalls(doms.footnote);

  const readNotes = (dom, tag, mark, out) => {
    if (!dom) return;
    for (const note of dom.getElementsByTagNameNS(W_NS, tag)) {
      const type = note.getAttributeNS(W_NS, 'type') || '';
      if (type && type !== 'normal') continue;           // separators
      let marks = 0, text = '';
      _walk(note, state, (el) => {
        if (el.namespaceURI !== W_NS) return;
        if (el.localName === mark) marks++;
        else if (el.localName === 't') text += el.textContent || '';
      });
      out.set(note.getAttributeNS(W_NS, 'id'), { marks, text: text.trim() });
    }
  };
  readNotes(doms.footnote, 'footnote', 'footnoteRef', notes.fn);
  readNotes(doms.endnote, 'endnote', 'endnoteRef', notes.en);
  return { calls, notes };
}

// ---- Images ---------------------------------------------------------------

/** A readable name for a part of the package ("header 2"). */
function _partLabel(path) {
  const name = String(path).replace(/^word\//, '').replace(/\.xml$/, '');
  if (name === 'document') return 'the body';
  if (name === 'footnotes') return 'the footnotes';
  if (name === 'endnotes') return 'the endnotes';
  const m = /^(header|footer)(\d*)$/.exec(name);
  if (m) return m[1] + (m[2] ? ' ' + m[2] : '');
  return name;
}

/** Relationship id -> { target, external } of one part, from its .rels file. */
async function _relsOf(zip, partPath) {
  const out = new Map();
  const relsPath = partPath.replace(/^(.*\/)?([^/]+)$/, (all, dir, file) => (dir || '') + '_rels/' + file + '.rels');
  const f = zip.file(relsPath);
  if (!f) return out;
  const xml = await f.async('string');
  const re = /<Relationship\b([^>]*)\/?>/g;
  let m;
  while ((m = re.exec(xml))) {
    const attr = (name) => { const a = new RegExp('\\b' + name + '="([^"]*)"').exec(m[1]); return a ? a[1] : ''; };
    const id = attr('Id');
    if (!id) continue;
    const external = /^External$/i.test(attr('TargetMode'));
    let target = attr('Target');
    if (!external) {
      // Relative to the part's folder (word/), or absolute from the package root.
      const parts = (target.charAt(0) === '/' ? target.slice(1) : 'word/' + target).split('/');
      const norm = [];
      for (const p of parts) { if (p === '..') norm.pop(); else if (p && p !== '.') norm.push(p); }
      target = norm.join('/');
    }
    out.set(id, { target, external });
  }
  return out;
}

/**
 * The pictures of a DOCX package, per XML part of word/: { parts: { path: { objects, files } },
 * media: number of files under word/media }. `objects` counts the graphic objects (w:drawing,
 * w:pict, w:object); `files` lists the package files their images point at (linked images,
 * outside the package, are not listed). Read as text: a picture is the same element whatever
 * the paragraph around it says.
 */
export async function imageCensus(zip) {
  const parts = {};
  const names = Object.keys(zip.files || {});
  for (const path of names) {
    if (!/^word\/[^/]+\.xml$/.test(path) || zip.files[path].dir) continue;
    let xml = '';
    try { xml = await zip.file(path).async('string'); } catch (_) { continue; }
    const objects = (xml.match(/<w:(?:drawing|pict|object)\b/g) || []).length;
    if (!objects) continue;
    const ids = new Set();
    const re = /<(?:a:blip|v:imagedata|o:OLEObject)\b[^>]*?\br:(?:embed|link|id)="([^"]+)"/g;
    let m;
    while ((m = re.exec(xml))) ids.add(m[1]);
    const rels = await _relsOf(zip, path);
    const files = [];
    for (const id of ids) {
      const r = rels.get(id);
      if (r && !r.external && r.target) files.push(r.target);
    }
    parts[path] = { objects, files: [...new Set(files)] };
  }
  const media = names.filter(p => /^word\/media\//.test(p) && !zip.files[p].dir).length;
  return { parts, media };
}

/** What the exported package lost of the original's pictures, as messages (none = all there). */
async function _imageProblems(zip, before) {
  if (!before || !before.parts) return { problems: [], images: null };
  const after = await imageCensus(zip);
  const problems = [];
  let total = 0;
  for (const path of Object.keys(before.parts)) {
    const b = before.parts[path];
    const a = after.parts[path] || { objects: 0, files: [] };
    total += b.objects;
    if (a.objects < b.objects) {
      const lost = b.objects - a.objects;
      problems.push(_partLabel(path).replace(/^./, c => c.toUpperCase()) + ': ' + lost + ' image(s) missing (the original has ' +
        b.objects + ', the exported file ' + a.objects + ').');
    }
  }
  for (const path of Object.keys(after.parts)) {
    for (const file of after.parts[path].files) {
      if (!zip.file(file)) problems.push(_partLabel(path).replace(/^./, c => c.toUpperCase()) + ': an image points at ' + file + ', which is not in the exported file.');
    }
  }
  if (after.media < before.media) {
    problems.push('Image files: the original has ' + before.media + ', the exported file ' + after.media + '.');
  }
  return { problems, images: total };
}

// The same library the model was read with (docx-model.js loads it this way).
// JSZip is a global script (app/libs/jszip.min.js, loaded by a <script> tag).
async function _jszip() {
  const lib = (typeof window !== 'undefined' && window.JSZip) ||
    (typeof JSZip !== 'undefined' ? JSZip : null);
  if (!lib) throw new Error('No se ha cargado la biblioteca JSZip (app/libs/jszip.min.js).');
  return lib;
}

async function _readDoms(zip) {
  const out = {};
  for (const area of Object.keys(PARTS)) {
    const f = zip.file(PARTS[area]);
    if (!f) { out[area] = null; continue; }
    const dom = new DOMParser().parseFromString(await f.async('string'), 'application/xml');
    if (dom.getElementsByTagName('parsererror').length) {
      throw new Error(PARTS[area] + ' is not well-formed XML.');
    }
    out[area] = dom;
  }
  return out;
}

/**
 * @param {Blob|ArrayBuffer|Uint8Array} data  the exported DOCX
 * @param {Object} source  the target model as LOADED (its _parts are the
 *                         original part documents, never written by the export)
 * @returns {Promise<{ok:boolean, problems:string[], summary:Object}>}
 */
export async function verifyExportedDocx(data, source, opts) {
  const clones = opts && opts.clones ? opts.clones : null;
  const JSZipLib = await _jszip();
  const zip = await JSZipLib.loadAsync(data);
  const outDoms = await _readDoms(zip);
  const origDoms = {
    body: source._parts ? source._parts.body : null,
    footnote: source._parts ? source._parts.footnote : null,
    endnote: source._parts ? source._parts.endnote : null
  };

  // What Word prints for a note, so the message names the number the reviewer
  // sees ("note 27"), not an internal id.
  const label = (kind, id) => {
    const byId = kind === 'fn' ? source.fnById : source.enById;
    const n = byId ? byId.get(String(id)) : null;
    const lab = (n && n.label !== undefined && n.label !== null && n.label !== '') ? n.label
      : (n && n.num !== undefined && n.num !== null ? n.num : null);
    return (kind === 'fn' ? 'Footnote ' : 'Endnote ') + (lab !== null ? lab : '(internal id ' + id + ')');
  };

  const problems = [];
  const seen = new Set();
  const report = (msg) => { if (!seen.has(msg)) { seen.add(msg); problems.push(msg); } };
  let summary = null;

  for (const state of ['accepted', 'rejected']) {
    const o = _survey(origDoms, state, null);
    const x = _survey(outDoms, state, clones);
    const when = state === 'accepted' ? 'once the changes are ACCEPTED' : 'if the changes are REJECTED';
    if (state === 'accepted') {
      let fnCalls = 0, enCalls = 0;
      for (const v of x.calls.fn.values()) fnCalls += v;
      for (const v of x.calls.en.values()) enCalls += v;
      summary = { fnCalls, enCalls, fnNotes: x.calls.fn.size, enNotes: x.calls.en.size };
    }
    for (const kind of ['fn', 'en']) {
      const ids = new Set([...o.calls[kind].keys(), ...x.calls[kind].keys()]);
      for (const id of ids) {
        const before = o.calls[kind].get(id) || 0;
        const after = x.calls[kind].get(id) || 0;
        if (after === before) continue;
        if (after === 0) report(label(kind, id) + ': its indicator is missing ' + when + '.');
        else if (before === 0) report(label(kind, id) + ': an indicator to it appears that the original did not have, ' + when + '.');
        else if (after > before) report(label(kind, id) + ': called ' + after + ' times ' + when + ' (the original calls it ' + before + ').');
        else report(label(kind, id) + ': called ' + after + ' time(s) ' + when + ' instead of ' + before + '.');
      }
      for (const id of x.calls[kind].keys()) {
        const xn = x.notes[kind].get(id);
        const on = o.notes[kind].get(id);
        if (!xn) {
          if (on) report(label(kind, id) + ': the indicator is there but the note itself is gone ' + when + '.');
          continue;
        }
        if (on && on.marks === 1 && xn.marks !== 1) {
          report(label(kind, id) + ': the note has lost its own number mark ' + when + '.');
        }
        if (on && on.text && !xn.text) {
          report(label(kind, id) + ': the note is empty ' + when + '.');
        }
      }
    }
  }
  // The pictures: as many in every part as the original had, each with its file.
  try {
    const img = await _imageProblems(zip, source._imageCensus);
    for (const p of img.problems) report(p);
    if (summary && img.images !== null) summary.images = img.images;
  } catch (e) {
    report('The images could not be checked: ' + (e && e.message ? e.message : e) + '.');
  }
  return { ok: problems.length === 0, problems, summary };
}
