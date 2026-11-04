/**
 * formats.test.mjs - End-to-end test of the formats layer (app/js/formats/).
 *
 *   node tests/formats.test.mjs            (UMBRA_TEST_LIBREOFFICE=1 also opens every output with LibreOffice)
 *
 * Starts tools/serve.mjs, opens tests/formats-harness.html in Chromium (Playwright) and, for each
 * fixture pair (DOCX, PPTX, XLSX): parses both files, aligns them, writes a masked copy of the
 * target (writeReplacements) and corrected copies (writeCorrected: tracked changes and Word
 * comments for DOCX, direct changes for PPTX/XLSX), re-parses every written file with the same
 * parser and compares the texts. The files are saved under tests/out/ and checked from Python
 * (tests/verify_outputs.py: python-docx, python-pptx, openpyxl and the raw XML).
 * Prints PASS/FAIL lines and exits non-zero on any failure.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { startServer } from '../tools/serve.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.join(HERE, 'out');
const FIX = path.join(HERE, 'fixtures');

async function loadPlaywright() {
  try {
    const mod = await import('playwright');
    return mod.chromium ? mod : mod.default;
  } catch (e) {
    const require = createRequire(import.meta.url);
    try { return require('playwright'); } catch (e2) { /* try the global install */ }
    const globalRoot = execSync('npm root -g').toString().trim();
    return require(path.join(globalRoot, 'playwright'));
  }
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok || !detail ? '' : ': ' + detail));
}

// ---------------------------------------------------------------------------
// The scenarios, run INSIDE the page (they only use window.UMBRA_FMT).
// ---------------------------------------------------------------------------

async function pageScenarios() {
  const F = window.UMBRA_FMT;
  const load = async (name) => {
    const r = await fetch('fixtures/' + name);
    if (!r.ok) throw new Error('Missing fixture ' + name);
    const buf = await r.arrayBuffer();
    return F.parseDocument({ name, arrayBuffer: async () => buf });
  };
  const fromBlob = async (blob, name) => {
    const buf = await blob.arrayBuffer();
    return F.parseDocument({ name, arrayBuffer: async () => buf });
  };
  const b64 = async (blob) => {
    const u8 = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const applyRepl = (text, list) => {
    let out = '', read = 0;
    for (const r of list.slice().sort((a, b) => a.start - b.start)) { out += text.slice(read, r.start) + r.text; read = r.end; }
    return out + text.slice(read);
  };
  const compareTexts = (model, expected) => {
    const bad = [];
    for (const [id, want] of expected) {
      const p = model.paras[id];
      if (!p || p.text !== want) bad.push({ id, want, got: p ? p.text : null });
    }
    return bad;
  };
  const report = {};

  // Masking replacements: "Asamblea General" -> {la ORGANO2}; every number -> {NUMk}.
  const maskRepl = (model) => {
    const repl = new Map();
    const numTags = new Map();
    for (const p of model.paras) {
      if (p.isSlideSep) continue;
      const list = [];
      const re = /Asamblea General/g;
      let m;
      while ((m = re.exec(p.text))) list.push({ start: m.index, end: m.index + m[0].length, text: '{la ORGANO2}' });
      const rn = /\d+(?:[.,]\d+)*/g;
      while ((m = rn.exec(p.text))) {
        if (!numTags.has(m[0])) numTags.set(m[0], '{NUM' + (numTags.size + 1) + '}');
        list.push({ start: m.index, end: m.index + m[0].length, text: numTags.get(m[0]) });
      }
      // Any order: shuffle to prove the writer sorts them.
      list.reverse();
      if (list.length) repl.set(p.id, list);
    }
    return repl;
  };

  for (const [kind, srcName, tgtName] of [['docx', 'doc_en.docx', 'doc_es.docx'],
                                          ['pptx', 'deck_en.pptx', 'deck_es.pptx'],
                                          ['xlsx', 'book_en.xlsx', 'book_es.xlsx']]) {
    const r = {};
    report[kind] = r;
    const src = await load(srcName);
    const tgt = await load(tgtName);
    r.kinds = [src.kind, tgt.kind];
    r.paraCounts = [src.paras.length, tgt.paras.length];

    // Alignment.
    const { pairs } = F.alignDocs(src, tgt);
    const seenS = new Map(), seenT = new Map();
    for (const p of pairs) {
      for (const id of p.src) seenS.set(id, (seenS.get(id) || 0) + 1);
      for (const id of p.tgt) seenT.set(id, (seenT.get(id) || 0) + 1);
    }
    r.alignCoverage = src.paras.every(p => seenS.get(p.id) === 1) && tgt.paras.every(p => seenT.get(p.id) === 1);
    const tgtPaired = new Set();
    for (const p of pairs) if (p.src.length && p.tgt.length) for (const id of p.tgt) tgtPaired.add(id);
    r.pairedRatio = tgtPaired.size / tgt.paras.length;
    r.pairs = pairs.length;
    r.sepPairs = pairs.filter(p => p.sep && p.src.length && p.tgt.length).length;
    r.slideCount = tgt.stats.slideCount || 0;
    // Pairs in target order: the first target id of each pair increases.
    let last = -1, ordered = true;
    for (const p of pairs) { if (p.tgt.length) { if (p.tgt[0] < last) ordered = false; last = p.tgt[0]; } }
    r.alignOrdered = ordered;
    r.samplePairs = pairs.slice(0, 40).map(p => [p.src.join(','), p.tgt.join(','), p.score, p.sep ? 'sep' : ''].join(' '));

    // Masked copy.
    const repl = maskRepl(tgt);
    const masked = await F.writeReplacements(tgt, repl);
    r.maskedMime = masked.type;
    r.maskedWarnings = masked.warnings;
    r.maskedVerify = masked.verify;
    const expected = new Map();
    for (const p of tgt.paras) expected.set(p.id, repl.has(p.id) ? applyRepl(p.text, repl.get(p.id)) : p.text);
    const re1 = await fromBlob(masked, tgtName);
    r.maskedParaCount = re1.paras.length;
    r.maskedMismatches = compareTexts(re1, expected);
    // Masking a leading list number ("13." -> "{NUM16}.") can change how the
    // DOCX parser splits a paragraph at a line break, so the ids may shift:
    // then the whole text must still be the same.
    const norm = (s) => s.replace(/\s+/g, ' ').trim();
    r.maskedSameWholeText = norm(Array.from(expected.values()).join(' ')) === norm(re1.paras.map(p => p.text).join(' '));
    r.maskedB64 = await b64(masked);
    // The displayed model is untouched.
    r.displayedUntouched = tgt.paras.every(p => !/\{NUM|\{la ORGANO/.test(p.text));
  }

  // DOCX corrected, tracked, with two comments.
  {
    const tgt = await load('doc_es.docx');
    const nt = new Map();
    const edit = (id, from, to) => { const t = tgt.paras[id].text; if (t.indexOf(from) < 0) throw new Error('fixture text ' + id); nt.set(id, t.replace(from, to)); };
    edit(19, 'fueron desplegados en 2024.', 'se desplegaron en 2024.');
    edit(1, 'Recordando su', 'Recordando tambi\u00e9n su');
    edit(18, 'aprob\u00f3 5 decisiones', 'aprob\u00f3 cinco decisiones');
    edit(22, 'p\u00e1rr. 12', 'p\u00e1rrafo 12');
    edit(9, 'Regi\u00f3n', 'Regiones');
    const blob = await F.writeCorrected(tgt, nt, {
      tracked: true, author: 'UMBRA', date: '2026-11-04T10:00:00.000Z',
      comments: [
        { paraId: 19, quote: 'Asamblea General', text: 'Comprobar el nombre del \u00f3rgano.', author: 'UMBRA' },
        { paraId: 15, quote: 'texto inexistente', text: 'Revisar la cifra total.', author: 'Revisora Uno' }
      ]
    });
    const expected = new Map();
    for (const p of tgt.paras) expected.set(p.id, nt.has(p.id) ? nt.get(p.id) : p.text);
    const re = await fromBlob(blob, 'x.docx');
    report.docxTracked = {
      warnings: blob.warnings, verify: blob.verify, changed: blob.changedParas,
      mismatches: compareTexts(re, expected), paraCount: re.paras.length, origCount: tgt.paras.length,
      comments: (re.comments || []).map(c => ({ id: c.id, author: c.author, text: c.text })),
      hasTracked: !!re.hasTracked,
      b64: await b64(blob)
    };

    // Masking THAT file (it carries tracked changes and comments) with the
    // clean-up options: deleted text and comments must not travel.
    const repl2 = maskRepl(re);
    const clean = await F.writeReplacements(re, repl2, { acceptRevisions: true, removeComments: true });
    const expected2 = new Map();
    for (const p of re.paras) expected2.set(p.id, repl2.has(p.id) ? applyRepl(p.text, repl2.get(p.id)) : p.text);
    const re2 = await fromBlob(clean, 'clean.docx');
    const norm = (s) => s.replace(/\s+/g, ' ').trim();
    report.docxClean = {
      warnings: clean.warnings,
      sameWholeText: norm(Array.from(expected2.values()).join(' ')) === norm(re2.paras.map(p => p.text).join(' ')),
      hasTracked: !!re2.hasTracked, comments: (re2.comments || []).length,
      b64: await b64(clean)
    };
  }

  // DOCX replacement edge cases: a custom-marked note call after the span, a
  // span over a non-breaking hyphen (goes) and over a tab (stays), an
  // insertion, overlapping replacements (the second is dropped with a warning).
  {
    const tgt = await load('doc_es.docx');
    const t0 = tgt.paras[0].text, t20 = tgt.paras[20].text;
    const i0 = t0.indexOf('Secretario General');
    const i20 = t20.indexOf('2023-2024');
    const repl = new Map([
      [0, [{ start: i0, end: i0 + 18, text: '{el CARGO1}' }]],
      [20, [{ start: i20, end: i20 + 9, text: '{PERIODO1}' }]],
      [15, [{ start: 0, end: 11, text: '{X}' }]],
      [19, [{ start: 0, end: 0, text: '[INS] ' }]],
      [2, [{ start: 0, end: 5, text: 'A' }, { start: 3, end: 8, text: 'B' }]],
      [13, [{ start: 0, end: 5, text: '{NUM1}' }]]
    ]);
    const blob = await F.writeReplacements(tgt, repl);
    const re = await fromBlob(blob, 'edge.docx');
    const want = new Map([
      [0, 'Informe del {el CARGO1}'],
      [20, t20.replace('2023-2024', '{PERIODO1}')],
      [15, '{X}\t\tfuncionarios de la Asamblea General'],
      [19, '[INS] ' + tgt.paras[19].text],
      [2, 'A' + tgt.paras[2].text.slice(5)],
      [13, '{NUM1}']
    ]);
    const titleRun = (re.paras[0].runs || []).find(r => r.fnRef);
    report.docxEdge = {
      warnings: blob.warnings,
      mismatches: compareTexts(re, want),
      titleCall: titleRun ? { fnRef: titleRun.fnRef, mark: titleRun.customMark } : null,
      fnRefCount: re.stats.fnRefCount
    };
  }

  // DOCX corrected WITHOUT tracked changes, a comment on a footnote paragraph.
  {
    const tgt = await load('doc_es.docx');
    const nt = new Map([[2, tgt.paras[2].text.replace('sobre 15 casos', 'acerca de 15 casos')]]);
    const blob = await F.writeCorrected(tgt, nt, {
      tracked: false, author: 'UMBRA', date: '2026-11-04T10:00:00Z',
      comments: [{ paraId: 22, quote: '78/245', text: 'Revisar la cita.', author: 'UMBRA' }]
    });
    const expected = new Map();
    for (const p of tgt.paras) expected.set(p.id, nt.has(p.id) ? nt.get(p.id) : p.text);
    const re = await fromBlob(blob, 'x.docx');
    report.docxDirect = {
      warnings: blob.warnings, changed: blob.changedParas,
      mismatches: compareTexts(re, expected), hasTracked: !!re.hasTracked,
      comments: (re.comments || []).map(c => ({ id: c.id, author: c.author, text: c.text })),
      b64: await b64(blob)
    };
  }

  // PPTX corrected (direct; comments are not supported -> warning).
  {
    const tgt = await load('deck_es.pptx');
    const nt = new Map([
      [5, tgt.paras[5].text.replace('lleg\u00f3 a', 'alcanz\u00f3 a')],
      [7, tgt.paras[7].text.replace('acogi\u00f3 con benepl\u00e1cito', 'celebr\u00f3')]
    ]);
    const blob = await F.writeCorrected(tgt, nt, { tracked: true, comments: [{ paraId: 5, quote: 'x', text: 'y' }] });
    const expected = new Map();
    for (const p of tgt.paras) expected.set(p.id, nt.has(p.id) ? nt.get(p.id) : p.text);
    const re = await fromBlob(blob, 'x.pptx');
    report.pptxCorrected = { warnings: blob.warnings, mismatches: compareTexts(re, expected), b64: await b64(blob) };
  }

  // XLSX corrected: a shared string used by two cells changes in ONE of them (clone),
  // and a formula string result changes (formula dropped, calcChain removed).
  {
    const tgt = await load('book_es.xlsx');
    const nt = new Map([
      [11, 'Asamblea General (AG)'],
      [12, 'A\u00f1o 2025']
    ]);
    const blob = await F.writeCorrected(tgt, nt, { comments: [{ paraId: 11, quote: 'x', text: 'y' }] });
    const expected = new Map();
    for (const p of tgt.paras) expected.set(p.id, nt.has(p.id) ? nt.get(p.id) : p.text);
    const re = await fromBlob(blob, 'x.xlsx');
    report.xlsxCorrected = { warnings: blob.warnings, mismatches: compareTexts(re, expected), b64: await b64(blob) };
  }

  // XLSX partial masking: only the second user of a shared string, and the master of a
  // shared formula.
  {
    const tgt = await load('book_es.xlsx');
    const repl = new Map([
      [16, [{ start: 0, end: 16, text: '{la ORGANO2}' }]],
      [6, [{ start: 0, end: 4, text: '{NUM9}' }]]
    ]);
    const blob = await F.writeReplacements(tgt, repl);
    const expected = new Map();
    for (const p of tgt.paras) expected.set(p.id, repl.has(p.id) ? applyRepl(p.text, repl.get(p.id)) : p.text);
    const re = await fromBlob(blob, 'x.xlsx');
    report.xlsxPartial = {
      warnings: blob.warnings, mismatches: compareTexts(re, expected),
      numericAfter: re.paras.filter(p => p.numeric).map(p => p.loc.cellRef + '=' + p.text),
      b64: await b64(blob)
    };
  }

  // Unsupported format.
  try {
    await F.parseDocument({ name: 'x.pdf', arrayBuffer: async () => new ArrayBuffer(4) });
    report.unsupported = 'no error';
  } catch (e) { report.unsupported = e.message; }
  try {
    await F.parseDocument({ name: 'roto.docx', arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer });
    report.corrupt = 'no error';
  } catch (e) { report.corrupt = e.message; }

  // textDiffReplacements round trip.
  {
    const a = 'El  Secretario General inform\u00f3 a la Asamblea General de que 1.250 funcionarios.';
    const b = 'El  Secretario General comunic\u00f3 a la Asamblea de que 1250 funcionarios, en total.';
    const list = F.textDiffReplacements(a, b);
    report.diffRoundTrip = applyRepl(a, list) === b;
  }
  return report;
}

// ---------------------------------------------------------------------------

async function main() {
  // Fixtures (generated once; they are committed).
  const need = ['doc_en.docx', 'doc_es.docx', 'deck_en.pptx', 'deck_es.pptx', 'book_en.xlsx', 'book_es.xlsx'];
  if (need.some(n => !fs.existsSync(path.join(FIX, n)))) {
    const r = spawnSync('python3', ['-I', path.join(FIX, 'make_fixtures.py')], { stdio: 'inherit' });
    if (r.status !== 0) { console.log('FAIL fixtures could not be generated'); process.exit(1); }
  }
  fs.mkdirSync(OUT, { recursive: true });

  const pw = await loadPlaywright();
  const srv = await startServer({ root: ROOT, port: 0 });
  const browser = await pw.chromium.launch();
  let report;
  const pageErrors = [];
  try {
    const page = await browser.newPage();
    page.on('pageerror', e => pageErrors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') pageErrors.push(m.text()); });
    await page.goto('http://127.0.0.1:' + srv.port + '/tests/formats-harness.html');
    await page.waitForFunction(() => window.UMBRA_READY === true, null, { timeout: 15000 });
    report = await page.evaluate(pageScenarios);
  } catch (e) {
    console.log('FAIL page run: ' + (e && e.stack ? e.stack : e));
    if (pageErrors.length) console.log(pageErrors.join('\n'));
    await browser.close(); await srv.close();
    process.exit(1);
  }
  await browser.close();
  await srv.close();
  check('page without errors', pageErrors.length === 0, pageErrors.join(' | '));

  const save = (name, b64) => { fs.writeFileSync(path.join(OUT, name), Buffer.from(b64, 'base64')); return name; };
  const files = {};

  for (const kind of ['docx', 'pptx', 'xlsx']) {
    const r = report[kind];
    check(kind + ': parsed kinds', r.kinds[0] === kind && r.kinds[1] === kind, r.kinds.join('/'));
    check(kind + ': every paragraph in exactly one pair', r.alignCoverage);
    check(kind + ': pairs in target order', r.alignOrdered);
    check(kind + ': most paragraphs paired (' + Math.round(r.pairedRatio * 100) + '%)', r.pairedRatio >= 0.85,
      r.samplePairs.join(' ; '));
    if (kind === 'pptx') check('pptx: slide separators paired (sep:true)', r.sepPairs === r.slideCount, r.sepPairs + '/' + r.slideCount);
    check(kind + ': masked MIME type', /openxmlformats/.test(r.maskedMime), r.maskedMime);
    check(kind + ': masked copy without warnings', !r.maskedWarnings.length, JSON.stringify(r.maskedWarnings));
    const strict = !r.maskedMismatches.length && r.maskedParaCount === r.paraCounts[1];
    check(kind + ': masked copy re-parses with the expected texts' +
      (strict ? '' : ' (segmentation changed: ' + r.paraCounts[1] + ' -> ' + r.maskedParaCount + ' paragraphs, whole text compared)'),
      strict || (r.maskedParaCount !== r.paraCounts[1] && r.maskedSameWholeText),
      JSON.stringify(r.maskedMismatches.slice(0, 5)));
    check(kind + ': displayed model untouched', r.displayedUntouched);
    if (kind === 'docx') check('docx: export verification (notes, images)', r.maskedVerify && r.maskedVerify.ok, JSON.stringify(r.maskedVerify));
    files[kind + '_masked'] = save('a_' + kind + '_masked.' + kind, r.maskedB64);
  }

  const t = report.docxTracked;
  check('docx tracked: no warnings', !t.warnings.length, JSON.stringify(t.warnings));
  check('docx tracked: accepted text equals the corrections', !t.mismatches.length && t.paraCount === t.origCount, JSON.stringify(t.mismatches));
  check('docx tracked: the file carries tracked changes', t.hasTracked);
  check('docx tracked: export verification', t.verify && t.verify.ok, JSON.stringify(t.verify));
  check('docx tracked: two comments read back', t.comments.length === 2, JSON.stringify(t.comments));
  files.docx_tracked = save('b_docx_tracked.docx', t.b64);

  const ed = report.docxEdge;
  check('docx edge cases: texts (note call, hyphen, tab, insertion, overlap)', !ed.mismatches.length, JSON.stringify(ed.mismatches));
  check('docx edge cases: one warning for the overlapping replacement', ed.warnings.length === 1 && /solapadas/.test(ed.warnings[0].message),
    JSON.stringify(ed.warnings));
  check('docx edge cases: custom-marked note call kept', ed.titleCall && ed.titleCall.mark === '*' && ed.fnRefCount === 2,
    JSON.stringify(ed.titleCall) + ' ' + ed.fnRefCount);

  const c = report.docxClean;
  check('docx clean mask: no warnings', !c.warnings.length, JSON.stringify(c.warnings));
  check('docx clean mask: text equals the masked accepted text', c.sameWholeText);
  check('docx clean mask: no tracked changes, no comments', !c.hasTracked && c.comments === 0);
  files.docx_clean = save('g_docx_clean.docx', c.b64);

  const d = report.docxDirect;
  check('docx direct: no warnings', !d.warnings.length, JSON.stringify(d.warnings));
  check('docx direct: text equals the correction', !d.mismatches.length, JSON.stringify(d.mismatches));
  check('docx direct: no tracked changes', !d.hasTracked);
  check('docx direct: footnote comment read back', d.comments.length === 1 && /^\[Nota /.test(d.comments[0].text), JSON.stringify(d.comments));
  files.docx_direct = save('c_docx_direct.docx', d.b64);

  const p = report.pptxCorrected;
  check('pptx corrected: texts', !p.mismatches.length, JSON.stringify(p.mismatches));
  check('pptx corrected: comments warning', p.warnings.length === 1 && /comentarios/i.test(p.warnings[0].message), JSON.stringify(p.warnings));
  files.pptx_corrected = save('d_pptx_corrected.pptx', p.b64);

  const x = report.xlsxCorrected;
  check('xlsx corrected: texts', !x.mismatches.length, JSON.stringify(x.mismatches));
  check('xlsx corrected: comments warning', x.warnings.some(w => /comentarios/i.test(w.message)), JSON.stringify(x.warnings));
  files.xlsx_corrected = save('e_xlsx_corrected.xlsx', x.b64);

  const xp = report.xlsxPartial;
  check('xlsx partial: texts', !xp.mismatches.length, JSON.stringify(xp.mismatches));
  check('xlsx partial: shared-formula warning', xp.warnings.some(w => /f\u00f3rmula/.test(w.message)), JSON.stringify(xp.warnings));
  files.xlsx_partial = save('f_xlsx_partial.xlsx', xp.b64);

  check('unsupported format error in Spanish', report.unsupported === 'Formato no admitido: use DOCX, PPTX o XLSX.', report.unsupported);
  check('damaged file error in Spanish', /^No se pudo abrir el archivo/.test(report.corrupt), report.corrupt);
  check('textDiffReplacements round trip', report.diffRoundTrip);

  // Python side.
  fs.writeFileSync(path.join(OUT, 'files.json'), JSON.stringify(files, null, 2));
  const args = ['-I', path.join(HERE, 'verify_outputs.py'), OUT];
  if (process.env.UMBRA_TEST_LIBREOFFICE === '1') args.push('--libreoffice');
  const py = spawnSync('python3', args, { encoding: 'utf-8' });
  process.stdout.write(py.stdout || '');
  if (py.stderr) process.stdout.write(py.stderr);
  check('python verification (tests/verify_outputs.py)', py.status === 0, 'exit ' + py.status);

  const failed = results.filter(r => !r.ok);
  console.log('\n' + (failed.length ? 'FAIL' : 'PASS') + ': ' + (results.length - failed.length) + '/' + results.length +
    ' checks passed in node' + (failed.length ? ' (' + failed.map(f => f.name).join('; ') + ')' : ''));
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.log('FAIL ' + (e && e.stack ? e.stack : e)); process.exit(1); });
