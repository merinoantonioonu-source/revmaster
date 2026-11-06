#!/usr/bin/env node
/**
 * app.e2e.mjs - End-to-end test of the whole app in Chromium (Playwright), with a mock
 * OpenAI-compatible provider:
 *   DOCX: load -> entities -> masked export -> provider set-up -> Revisar: AI modules (fusion,
 *         cascade, verifier) -> Corregir: accept -> Exportar: tracked changes + comments, report.
 *   PPTX and XLSX: load -> masked export (verified with python-pptx / openpyxl).
 * Screenshots go to tests/out/e2e/. Exit code 1 on failure.
 */

import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { startServer } from '../tools/serve.mjs';
import { startMockAI } from './mock-ai.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'out', 'e2e');
const FIX = path.join(HERE, 'fixtures');
fs.mkdirSync(OUT, { recursive: true });

let failures = 0;
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) failures++; };

function py(code, ...args) {
  return execFileSync('python3', ['-I', '-c', code, ...args], { encoding: 'utf-8' });
}

async function newApp(browser, base) {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(base + '/app/index.html');
  await page.waitForSelector('.modal', { timeout: 15000 });   // the guide on first run
  await page.click('.modal-foot .btn');
  return { ctx, page, errors };
}

async function load(page, src, tgt) {
  for (const [sel, file] of [['#drop-src', src], ['#drop-tgt', tgt]]) {
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click(sel)]);
    await chooser.setFiles(path.join(FIX, file));
  }
  await page.waitForSelector('#view-mask.on .ent', { timeout: 20000 });
}

async function download(page, trigger, name) {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), trigger()]);
  const p = path.join(OUT, name || dl.suggestedFilename());
  await dl.saveAs(p);
  return p;
}

async function menuItem(page, buttonText, itemText) {
  await page.click('#tools button:has-text("' + buttonText + '")');
  await page.click('.menu .mi:has-text("' + itemText + '")');
}

async function main() {
  const srv = await startServer({ port: 0 });
  const mock = await startMockAI(8790);
  const base = 'http://localhost:' + srv.port;
  const browser = await chromium.launch();
  try {
    // ================= DOCX
    const { ctx, page, errors } = await newApp(browser, base);
    await load(page, 'doc_en.docx', 'doc_es.docx');
    await page.screenshot({ path: path.join(OUT, '1-mask.png') });
    const ents = await page.evaluate(async () => {
      const { state } = await import('/app/js/state.js');
      return state.session.ent.entities.map(e => ({ tagSrc: e.tagSrc, tagTgt: e.tagTgt, status: e.status, src: Object.keys(e.srcForms), tgt: Object.keys(e.tgtForms) }));
    });
    const ag = ents.find(e => e.tgt.includes('Asamblea General'));
    ok(!!ag && /^\{ORGANO\d+\}$/.test(ag.tagTgt) && ag.tagTgt === ag.tagSrc, 'General Assembly tagged as {ORGANOn}, the same tag on both sides (' + (ag && ag.tagTgt) + ')');
    const sg = ents.find(e => e.tgt.some(f => /Secretario General/.test(f)));
    ok(!!sg && /^\{CARGO\d+\}$/.test(sg.tagTgt) && sg.src.some(f => /Secretary-General/.test(f)), 'Secretary-General paired with Secretario General (' + (sg && sg.tagTgt) + ')');
    const n1250 = ents.find(e => e.src.includes('1,250'));
    ok(!!n1250 && n1250.tgt.includes('1.250'), '1,250 and 1.250 share one NUM tag');
    const date = ents.find(e => e.src.some(f => /12 December 2022/.test(f)));
    ok(!!date && date.tgt.some(f => /12 de diciembre de 2022/.test(f)), 'Dates paired across languages');

    // Masked export of the target
    const maskedPath = await download(page, () => menuItem(page, 'Exportar enmascarado', 'Traducci\u00f3n enmascarada'), 'masked_es.docx');
    const maskedText = py('import docx,sys\nd=docx.Document(sys.argv[1])\nprint("\\n".join(p.text for p in d.paragraphs))\nfor t in d.tables:\n  for r in t.rows: print(" | ".join(c.text for c in r.cells))', maskedPath);
    ok(/\{ORGANO\d+\}/.test(maskedText) && !/Asamblea General/.test(maskedText), 'Masked DOCX has tags and no "Asamblea General"');
    ok(!/1\.250/.test(maskedText), 'Masked DOCX hides the figures');

    // External AI text
    const ext = await page.evaluate(async () => {
      const { state } = await import('/app/js/state.js');
      const { buildExternalText } = await import('/app/js/review/external.js');
      return buildExternalText(state.session, {});
    });
    ok(!/Asamblea General|Secretario General|1\.250/.test(ext) && /\{ORGANO\d+\}/.test(ext) && !/\{(el|la|los|las) /.test(ext), 'Text for external AI is masked, tags without articles');

    // Provider set-up (mock) and units of interest
    const info = await page.evaluate(async () => {
      const reg = await import('/app/js/ai/registry.js');
      const p = await reg.saveProvider({ name: 'Simulador', adapter: 'openai-compatible', baseUrl: 'http://localhost:8790/v1', trust: 'external',
        models: [{ id: 'mock-small', label: 'Simulado peque\u00f1o' }, { id: 'mock-big', label: 'Simulado grande' }] });
      await reg.setApiKey(p.id, 'test-key');
      await reg.setGeneralModel({ provider: p.id, model: 'mock-small' });
      await reg.setModuleModel('fidelity', 'deep', { provider: p.id, model: 'mock-big' });
      await reg.setModuleModel('integrity', 'deep', { provider: p.id, model: 'mock-big' });
      await reg.setModuleModel('verifier', 'deep', { provider: p.id, model: 'mock-big' });
      const { state } = await import('/app/js/state.js');
      const s = state.session;
      const unitOf = (re) => { const u = s.units.find(x => x.tgtPara !== null && re.test(s.tgt.paras[x.tgtPara].text)); return u ? u.n : null; };
      return { pid: p.id, uGram: unitOf(/fueron desplegado/), uReq: unitOf(/^Solicita al Secretario/), uDec: unitOf(/^Decide asignar/) };
    });
    ok(info.uGram && info.uReq && info.uDec, 'Units located (' + JSON.stringify(info) + ')');
    Object.assign(mock.state, {
      rules: [
        { match: 'HALLAZGOS A VERIFICAR', response: 'H1 | OK |  | Correcto.\nH2 | OK |  | Correcto.\nH3 | OK |  | Correcto.\nH4 | EDITAR | previsto inicialmente | Mejor as\u00ed.\nFIN 4' },
        { match: 'GRUPO ', response: 'FIN 3' },
        { match: 'DOCUMENTO: resoluci', response: 'FIN 0' },
        { match: 'P\u00c1RRAFOS DE LA TRADUCCI\u00d3N', response: info.uGram + ' | GRA | MEN | fueron desplegado | fueron desplegados | Concordancia con \u00abfuncionarios\u00bb.\n' +
          info.uDec + ' | EST | MEN | asignar | destinar | Verbo m\u00e1s preciso.\n' +
          info.uDec + ' | GRA | SUG | asignar | asignar | Igual: se descarta.\nFIN 20' },
        { match: 'O: ', response: info.uReq + ' | MIST | MAY | presente | presentara | Revisar el modo verbal.\n' +
          info.uReq + ' | MIST | MEN | informe | memoria | Matiz menor: se descarta por la exigencia.\n' +
          info.uDec + ' | OMI | MAY |  | tras \u00abprograma\u00bb: previsto | Falta un matiz.\nFIN 20' }
      ],
      def: 'FIN 0'
    });

    // Revisar: the AI modules through the UI
    await page.click('.step[data-view="review"]');
    await page.waitForSelector('#rv-modules .mchip');
    await page.waitForTimeout(800);
    ok(/^\d+ revisores? \u00b7 \d+ p\u00e1rrafos/.test(await page.textContent('#rv-summary')), 'Revisar: the footer counts the ticked reviewers (' + (await page.textContent('#rv-summary')).trim() + ')');
    await page.click('#rv-run');
    await page.waitForSelector('.modal:has-text("Plan de ejecuci")', { timeout: 15000 });
    const planText = await page.textContent('.modal');
    ok(/fusionados/.test(planText), 'Plan fuses modules with the same input and model');
    await page.screenshot({ path: path.join(OUT, '2-plan.png') });
    await page.click('.modal-foot .btn.amber');
    await page.waitForSelector('.toast:has-text("Revisi\u00f3n terminada")', { timeout: 60000 });
    await page.waitForTimeout(500);
    const res = await page.evaluate(async () => {
      const { state } = await import('/app/js/state.js');
      return state.findings.map(f => ({ id: f.id, module: f.module, cat: f.cat, sev: f.sev, quote: f.quote, sug: f.suggestion, state: f.state,
        start: f.start, verified: f.verified || null, role: f.role, source: f.source }));
    });
    const log = mock.state.log;
    ok(log.some(r => r.model === 'mock-big'), 'Cascade: the deep model was called for flagged units');
    ok(log.some(r => /HALLAZGOS A VERIFICAR/.test(r.prompt)), 'Verifier was called');
    // The names table (Nombres oficiales) is the one call with real names, by the owner's choice: only rows of names.
    const namesCall = log.find(r => /^NOMBRES \(fila/.test(r.prompt));
    ok(!!namesCall && namesCall.prompt.split('\n').slice(1, -1).every(l => /^\d+ \| (ORG|ORGANO|CARGO|PAIS|LUGAR) \| [^|]+ \| [^|]+$/.test(l)) && !/1\.250|1,250/.test(namesCall.prompt),
      'The names call carries only the table of institutional names');
    const leaks = log.filter(r => r !== namesCall && /Asamblea General|Secretario General|Secretary-General|General Assembly|1\.250|1,250|Naciones Unidas/.test(r.prompt));
    if (leaks.length) console.log('LEAK SAMPLE:', leaks[0].prompt.slice(0, 600));
    ok(!leaks.length, 'No real entity reached the AI (only masked text in the prompts)');
    const fused = log.filter(r => /P\u00c1RRAFOS DE LA TRADUCCI\u00d3N/.test(r.prompt));
    ok(fused.length >= 1 && /GRAM\u00c1TICA/.test(fused[0].system) && /ESTILO/.test(fused[0].system) && !/ORTOGRAF\u00cdA Y/.test(fused[0].system), 'Grammar (without spelling) and style fused in one call');
    const gram = res.find(f => f.module === 'grammar' && /desplegado/.test(f.quote || ''));
    ok(!!gram && gram.start !== null, 'Grammar finding anchored in the real text');
    ok(res.some(f => f.state === 'discarded' || f.verified), 'Verifier verdicts applied');
    ok(!res.some(f => f.module === 'fidelity' && f.sev === 'MEN'), 'Fidelity asks only for important errors: a minor one is dropped');
    ok(fused.length >= 1 && /EXIGENCIA/.test(fused[0].system) && !/art\u00edculo que va DENTRO/.test(fused[0].system), 'Prompts carry the strictness and no article explanation');
    const bil = log.filter(r => /\nO: /.test(r.prompt));
    ok(bil.length >= 1 && /FIDELIDAD DE SENTIDO/.test(bil[0].system) && bil[0].system.length < 4500, 'Fidelity prompt is about meaning and compact (' + (bil[0] ? bil[0].system.length : 0) + ' characters)');
    await page.screenshot({ path: path.join(OUT, '3-review.png') });

    // After the run UMBRA moves to Corregir; accept the grammar finding there, then export with
    // tracked changes and comments from step 5.
    await page.waitForSelector('#view-correct.on #rv-findings .cx-row', { timeout: 10000 });
    ok(/por revisar/.test(await page.textContent('#st-correct')), 'The run ends in Corregir and the step says what is left (' + (await page.textContent('#st-correct')).trim() + ')');
    await page.selectOption('select[data-filter="state"]', 'open');
    await page.waitForTimeout(300);
    await page.click('#rv-findings .cx-badge[data-id="' + gram.id + '"]');
    ok(/fueron desplegado/.test(await page.textContent('#cx-insp .ci-quote')), 'The inspector shows the chosen finding');
    await page.click('#cx-accept');
    const st = await page.evaluate(async (id) => { const { state } = await import('/app/js/state.js'); return state.findings.find(f => f.id === id).state; }, gram.id);
    ok(st === 'accepted', 'Finding accepted from the inspector');
    await page.click('.step[data-view="export"]');
    const outDocx = await download(page, () => page.click('#view-export button:has-text("DOCX con control de cambios y comentarios")'), 'corrected_es.docx');
    const chk = py([
      'import zipfile,sys,docx',
      'z=zipfile.ZipFile(sys.argv[1]); x=z.read("word/document.xml").decode("utf-8")',
      'c=z.read("word/comments.xml").decode("utf-8") if "word/comments.xml" in z.namelist() else ""',
      'docx.Document(sys.argv[1])',
      'print("ins" if "<w:ins " in x else "noins", "del" if "<w:del " in x else "nodel", "desplegados" if "desplegados" in x else "-", c.count("<w:comment "), "UMBRA" if "UMBRA" in c else "-")'
    ].join('\n'), outDocx).trim();
    ok(/^ins (?:no)?del desplegados \d+ UMBRA$/.test(chk) && !/ 0 UMBRA/.test(chk), 'Corrected DOCX: tracked change + Word comments (' + chk + ')');
    const rep = await download(page, () => page.click('#view-export button:has-text("Informe HTML")'), 'report.html');
    ok(/Informe de revisi/.test(fs.readFileSync(rep, 'utf-8')), 'HTML report written');

    // Manual masking with Alt+E on a selection of the target
    await page.click('.step[data-view="mask"]');
    await page.waitForSelector('#mask-tgt .p');
    const selOk = await page.evaluate(() => {
      const paras = Array.from(document.querySelectorAll('#mask-tgt .p'));
      const p = paras.find(n => /Primera l\u00ednea de la direcci\u00f3n/.test(n.textContent));
      if (!p) return false;
      const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const i = node.textContent.indexOf('Primera');
        if (i >= 0) { const r = document.createRange(); r.setStart(node, i); r.setEnd(node, i + 'Primera l\u00ednea'.length);
          const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r); return true; }
      }
      return false;
    });
    ok(selOk, 'Text selected in the target sheet');
    await page.keyboard.press('Alt+e');
    await page.waitForSelector('.modal:has-text("Enmascarar selecci")');
    await page.click('.modal-foot .btn.primary');
    await page.waitForTimeout(400);
    const xEnt = await page.evaluate(async () => { const { state } = await import('/app/js/state.js'); return state.session.ent.entities.filter(e => e.cat === 'X').map(e => e.tagTgt + ':' + Object.keys(e.tgtForms).join('/')); });
    ok(xEnt.some(x => /Primera l\u00ednea/.test(x)), 'Alt+E masked the selection (' + xEnt.join(', ') + ')');

    // Right click on a selection of the source -> "Enmascarar la seleccion..."
    await page.evaluate(() => {
      const p = Array.from(document.querySelectorAll('#mask-src .p')).find(n => /First line of the address/.test(n.textContent));
      const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const i = node.textContent.indexOf('First line');
        if (i >= 0) { const r = document.createRange(); r.setStart(node, i); r.setEnd(node, i + 'First line'.length);
          const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r); return; }
      }
    });
    const box = await page.locator('#mask-src .p', { hasText: 'First line of the address' }).first().boundingBox();
    await page.mouse.click(box.x + 40, box.y + 8, { button: 'right' });
    await page.click('.menu .mi:has-text("Enmascarar la selecci")');
    await page.waitForSelector('.modal:has-text("Enmascarar selecci")');
    await page.fill('.modal input.inp', 'Primera l\u00ednea');
    // The translation is already masked (Alt+E above): typing its form selects that entity.
    const autoPair = await page.$eval('.modal .pairrow.on', r => r.dataset.key || '').catch(() => '');
    ok(!!autoPair, 'Typing an already masked translation pairs it automatically (' + autoPair + ')');
    await page.click('.modal-foot .btn.primary');
    await page.waitForTimeout(400);
    const pair = await page.evaluate(async () => { const { state } = await import('/app/js/state.js'); return state.session.ent.entities.filter(e => Object.keys(e.srcForms).includes('First line')).map(e => e.status + ':' + Object.keys(e.tgtForms).join('/')); });
    ok(pair.length === 1 && /Primera l\u00ednea/.test(pair[0]), 'Right-click masking of a source selection, paired with its translation (' + pair.join(', ') + ')');

    // External AI answer imported through the dialog
    await menuItem(page, 'Exportar enmascarado', 'Importar respuesta de IA externa');
    await page.fill('.modal textarea', info.uReq + ' | EST | SUG | presente | actual | Prueba de IA externa.\n' + info.uReq + ' | EST | SUG | presente | presente | Igual que la cita: se descarta.\nFIN 1');
    await page.click('.modal-foot .btn.primary');
    await page.waitForTimeout(500);
    const extF = await page.evaluate(async () => { const { state } = await import('/app/js/state.js'); return state.findings.filter(f => f.source === 'external').length; });
    ok(extF === 1, 'External AI answer imported as a finding (a proposal identical to its quote is dropped)');

    // Settings screens render
    await page.click('.step[data-view="settings"]');
    for (const sec of ['providers', 'modules', 'lists', 'sync', 'usage', 'privacy']) {
      await page.click('.settings-nav button[data-sec="' + sec + '"]');
      await page.waitForTimeout(300);
      const err = await page.$('.settings-body .note.err');
      ok(!err, 'Settings section renders: ' + sec);
      await page.screenshot({ path: path.join(OUT, '4-settings-' + sec + '.png') });
    }
    const usage = await page.evaluate(async () => { const u = await import('/app/js/ai/usage.js'); return (await u.readUsageRows()).length; });
    ok(usage > 0, 'Usage recorded (' + usage + ' rows)');
    // Project file round trip (.umbra) and dark mode
    await page.click('.step[data-view="export"]');
    const umbraPath = await download(page, () => page.click('#view-export button:has-text("Guardar proyecto (.umbra)")'), 'project.umbra');
    const nFind = await page.evaluate(async () => { const { state } = await import('/app/js/state.js'); return state.findings.length; });
    await page.click('#btn-dark');
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(OUT, '7-dark.png') });
    await page.click('#btn-dark');
    {
      const { ctx: c4, page: p4 } = await newApp(browser, base);
      const [chooser] = await Promise.all([p4.waitForEvent('filechooser'), p4.click('#view-files button:has-text("Abrir proyecto (.umbra)")')]);
      await chooser.setFiles(umbraPath);
      await p4.waitForSelector('#view-mask.on .ent', { timeout: 20000 });
      const n2 = await p4.evaluate(async () => { const { state } = await import('/app/js/state.js'); return state.findings.length; });
      ok(n2 === nFind && n2 > 0, 'Project .umbra reopened with its findings (' + n2 + '/' + nFind + ')');
      await c4.close();
    }
    ok(!errors.length, 'No console errors in the DOCX flow' + (errors.length ? ': ' + errors.slice(0, 5).join(' || ') : ''));
    await ctx.close();

    // ================= Masking of a document with deliberate errors (the review has no AI-free layer any more)
    {
      const { ctx: c1, page: p1, errors: e1 } = await newApp(browser, base);
      await load(p1, 'e2e_en.docx', 'e2e_es.docx');
      const nopair = await p1.$$eval('.ent .st.bad', ns => ns.length);
      ok(nopair >= 2, 'Masking shows the figures without a pair (1,250 vs 1.520): ' + nopair);
      await p1.click('.step[data-view="review"]');
      await p1.waitForSelector('#rv-modules .mchip');
      ok(await p1.locator('#rv-modules .mchip[data-mod="local"]').count() === 0, 'No module without AI in the review bar');
      ok(!e1.length, 'No console errors in the second document' + (e1.length ? ': ' + e1.slice(0, 3).join(' || ') : ''));
      await c1.close();
    }
    // ================= PPTX
    {
      const { ctx: c2, page: p2, errors: e2 } = await newApp(browser, base);
      await load(p2, 'deck_en.pptx', 'deck_es.pptx');
      await p2.screenshot({ path: path.join(OUT, '5-pptx.png') });
      const out = await download(p2, () => menuItem(p2, 'Exportar enmascarado', 'Traducci\u00f3n enmascarada'), 'masked_es.pptx');
      const t = py('import pptx,sys\np=pptx.Presentation(sys.argv[1])\nout=[]\nfor s in p.slides:\n  for sh in s.shapes:\n    if sh.has_text_frame: out.append(sh.text_frame.text)\n    if getattr(sh,"has_table",False) and sh.has_table:\n      for r in sh.table.rows:\n        for c in r.cells: out.append(c.text)\nprint("\\n".join(out))', out);
      ok(/\{NUM\d+\}/.test(t), 'Masked PPTX opens and has NUM tags');
      ok(!e2.length, 'No console errors in the PPTX flow' + (e2.length ? ': ' + e2.slice(0, 3).join(' || ') : ''));
      await c2.close();
    }
    // ================= XLSX
    {
      const { ctx: c3, page: p3, errors: e3 } = await newApp(browser, base);
      await load(p3, 'book_en.xlsx', 'book_es.xlsx');
      await p3.screenshot({ path: path.join(OUT, '6-xlsx.png') });
      const out = await download(p3, () => menuItem(p3, 'Exportar enmascarado', 'Traducci\u00f3n enmascarada'), 'masked_es.xlsx');
      const t = py('import openpyxl,sys\nwb=openpyxl.load_workbook(sys.argv[1])\nfor ws in wb.worksheets:\n  for row in ws.iter_rows():\n    for c in row:\n      if c.value is not None: print(repr(c.value))', out);
      ok(/\{NUM\d+\}/.test(t), 'Masked XLSX opens and numeric cells became tags');
      ok(!/\b1250\b/.test(t), 'XLSX figure 1250 hidden');
      ok(!e3.length, 'No console errors in the XLSX flow' + (e3.length ? ': ' + e3.slice(0, 3).join(' || ') : ''));
      await c3.close();
    }
  } catch (e) {
    console.error(e);
    failures++;
  } finally {
    await browser.close();
    await mock.close();
    await srv.close();
  }
  console.log(failures ? '\nE2E: ' + failures + ' FAILED' : '\nE2E: ALL PASSED');
  process.exit(failures ? 1 : 0);
}

main();
