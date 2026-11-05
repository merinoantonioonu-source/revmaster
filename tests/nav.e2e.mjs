#!/usr/bin/env node
/**
 * nav.e2e.mjs - Segment navigation (as in COMeT Final Check) and the review tools around it:
 *   - sentence offsets; a click marks the sentence and its pair; arrows step through sentences;
 *   - Entities: "Con problemas" by default, "Ver donde no cuadra", the "Emparejar" dialog;
 *   - Review: a finding card marks its exact text and both sentences; labelled filters;
 *   - the findings table window (row click navigates the main window, decisions sync back);
 *   - the "Hallazgos para valorar" Excel (drop-down list, sentence context);
 *   - Settings: the simplified Modules table and the fixed type of a built-in provider.
 * Builds its own small DOCX pair. Screenshots go to tests/out/nav/. Exit code 1 on failure.
 */

import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { startServer } from '../tools/serve.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'out', 'nav');
fs.mkdirSync(OUT, { recursive: true });

let failures = 0;
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) failures++; };
const py = (code, ...args) => execFileSync('python3', ['-I', '-c', code, ...args], { encoding: 'utf-8' });

// ------------------------------------------------------------------ fixtures
const EN = [
  'Report of the Committee',
  'The Committee met twice in Geneva. It adopted its report. It also elected its officers.',
  'The Secretary-General spoke. The Secretary-General then left.',
  'In total, 1,250 people attended the session.',
  'The Committee met again. It decided to act on the basis of the proposal.'
];
const ES = [
  'Informe de la Comisi\u00f3n',
  'La Comisi\u00f3n se reuni\u00f3 dos veces en Ginebra. Aprob\u00f3 su informe. Tambi\u00e9n eligi\u00f3 a su Mesa.',
  'El Secretario General habl\u00f3 y luego se retir\u00f3.',
  'En total, 1.520 personas asistieron al per\u00edodo de sesiones.',
  'La Comisi\u00f3n volvi\u00f3 a reunirse. Decidi\u00f3 actuar en base a la propuesta.'
];
const mk = (file, paras) => py('import docx,sys,json\nd=docx.Document()\nfor t in json.loads(sys.argv[2]): d.add_paragraph(t)\nd.save(sys.argv[1])', path.join(OUT, file), JSON.stringify(paras));
mk('nav_en.docx', EN);
mk('nav_es.docx', ES);

async function highlights(page) {
  return page.evaluate(() => {
    const get = (n) => { const h = CSS.highlights.get(n); return h ? Array.from(h).map(r => r.toString()) : []; };
    return { seg: get('um-seg'), focus: get('um-focus'), flash: document.querySelectorAll('.pane-body .p.flash').length };
  });
}

/** Clicks the middle of a word inside the visible sheet `sel`. */
async function clickWord(page, sel, word) {
  const pt = await page.evaluate(({ sel, word }) => {
    const host = document.querySelector(sel);
    const w = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) {
      const i = n.nodeValue.indexOf(word);
      if (i < 0) continue;
      const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + word.length);
      r.startContainer.parentElement.scrollIntoView({ block: 'center' });
      const b = r.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    }
    return null;
  }, { sel, word });
  if (!pt) throw new Error('Word not found: ' + word);
  await page.mouse.click(pt.x, pt.y);
  await page.waitForTimeout(250);
}

async function main() {
  const srv = await startServer({ port: 0 });
  const base = 'http://localhost:' + srv.port;
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 }, acceptDownloads: true });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    await page.goto(base + '/app/index.html');
    await page.waitForSelector('.modal', { timeout: 15000 });
    await page.click('.modal-foot .btn');

    // Sentence offsets.
    const spans = await page.evaluate(async () => {
      const { sentenceSpans } = await import('/app/js/ui/nav.js');
      const t = 'It met.  It adopted its report. It left.';
      return sentenceSpans(t, 'EN').map(s => t.slice(s.start, s.end));
    });
    ok(JSON.stringify(spans) === JSON.stringify(['It met.', 'It adopted its report.', 'It left.']), 'Sentence offsets survive doubled spaces (' + JSON.stringify(spans) + ')');

    for (const [sel, file] of [['#drop-src', 'nav_en.docx'], ['#drop-tgt', 'nav_es.docx']]) {
      const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click(sel + ' .fn')]);
      await fc.setFiles(path.join(OUT, file));
    }
    await page.waitForSelector('#view-mask.on .ent', { timeout: 20000 });

    // 1) A click marks the sentence and its pair.
    await clickWord(page, '#mask-src', 'adopted');
    let h = await highlights(page);
    ok(h.seg.includes('It adopted its report.') && h.seg.includes('Aprob\u00f3 su informe.'), 'Click on a source sentence marks it and its Spanish pair (' + JSON.stringify(h.seg) + ')');
    await page.screenshot({ path: path.join(OUT, '1-click.png') });
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(300);
    h = await highlights(page);
    ok(h.seg.includes('Tambi\u00e9n eligi\u00f3 a su Mesa.') && h.seg.includes('It also elected its officers.'), 'Right arrow goes to the next sentence pair (' + JSON.stringify(h.seg) + ')');
    await clickWord(page, '#mask-tgt', 'retir');
    h = await highlights(page);
    // (In the masked view the marked text holds the tag pills: "El elCARGO1 hablo...")
    ok(h.seg.length === 1 && /habl\u00f3 y luego se retir\u00f3\.$/.test(h.seg[0]) && h.flash === 1, 'Different sentence counts: the sentence is marked and the other paragraph is marked whole (' + JSON.stringify(h) + ')');

    // 2) Entities: problems first, "Ver donde no cuadra", "Emparejar".
    const segOn = await page.textContent('#mask-bubbles .seg2 button.on');
    ok(/Con problemas/.test(segOn), 'The entity list starts with the ones that have a problem (' + segOn.trim() + ')');
    const cargo = page.locator('#mask-entities .ent', { hasText: 'Secretary-General' }).first();
    ok(/Aparece 2 veces en el original y 1 en la traducci/.test(await cargo.textContent()), 'The card explains the count difference');
    await cargo.locator('.where button.primary').click();
    await page.waitForTimeout(400);
    h = await highlights(page);
    ok(h.seg.length === 3 && /spoke\.$/.test(h.seg[0]) && /then left\.$/.test(h.seg[1]) && /habl\u00f3 y luego se retir\u00f3\.$/.test(h.seg[2]),
      '"Ver donde no cuadra" marks the sentences of both sides (' + JSON.stringify(h.seg) + ')');
    ok(/1\/1/.test(await page.locator('#mask-entities .ent', { hasText: 'Secretary-General' }).first().textContent()), 'The card says which place is shown (1/1)');
    await page.screenshot({ path: path.join(OUT, '2-where.png') });
    const num = page.locator('#mask-entities .ent', { hasText: '1,250' }).first();
    await num.click();   // the buttons show on the selected card
    await page.locator('#mask-entities .ent.sel button:has-text("Emparejar")').click();
    await page.waitForSelector('.modal:has-text("Emparejar")');
    const firstRow = await page.textContent('.pairlist .pairrow');
    ok(/1\.520/.test(firstRow) && /Encaja/.test(firstRow), 'Emparejar proposes first the figure found only in the other language (' + firstRow.replace(/\s+/g, ' ').trim() + ')');
    await page.screenshot({ path: path.join(OUT, '3-pair.png') });
    await page.click('.pairlist .pairrow input');
    await page.click('.modal-foot .btn.primary');
    await page.waitForTimeout(500);
    const paired = await page.evaluate(async () => {
      const { state } = await import('/app/js/state.js');
      const e = state.session.ent.entities.find(x => Object.keys(x.srcForms).includes('1,250'));
      return e ? e.status + ':' + Object.keys(e.tgtForms).join('/') : 'none';
    });
    ok(paired === 'ok:1.520', 'After Emparejar both figures are one entity without problems (' + paired + ')');

    // 3) Review: a finding card goes to the exact text and both sentences.
    await page.click('.step[data-view="review"]');
    await page.waitForSelector('#rv-modules .mchip');
    ok(await page.locator('#rv-modules .mchip[data-mod="local"]:has-text("Comprobaciones sin IA")').count() === 1, 'The module bar names the free checks "Comprobaciones sin IA"');
    await page.click('#rv-modules .mchip[data-mod="local"] .run');
    await page.waitForSelector('#rv-modules .mchip[data-mod="local"].done', { timeout: 30000 });
    const labels = await page.$$eval('#rv-bubbles .ffield > span', s => s.map(x => x.textContent));
    ok(labels.join(',') === 'Estado,M\u00f3dulo,Gravedad', 'Findings are filtered with three labelled lists (' + labels.join(', ') + ')');
    const card = page.locator('#rv-findings .iss', { hasText: 'en base a' }).first();
    ok(await card.count() === 1, 'The rule "en base a" produced a finding');
    const fid = await card.getAttribute('data-id');
    ok(/\u00a75\.2/.test(await card.textContent()), 'The card shows paragraph and sentence (\u00a75.2)');
    await card.click();
    await page.waitForTimeout(500);
    h = await highlights(page);
    ok(h.focus.includes('en base a') && h.seg.includes('Decidi\u00f3 actuar en base a la propuesta.') && h.seg.includes('It decided to act on the basis of the proposal.'),
      'A finding marks its exact text and the sentence pair (' + JSON.stringify(h) + ')');
    await page.screenshot({ path: path.join(OUT, '4-finding.png') });
    await page.selectOption('select[data-filter="state"]', 'all');
    ok(await page.locator('#rv-findings .iss').count() >= 1, 'The state filter can show every finding');
    await page.selectOption('select[data-filter="state"]', 'open');

    // 4) The table window.
    const [popup] = await Promise.all([page.waitForEvent('popup'), page.click('#view-review button:has-text("Tabla")')]);
    await popup.waitForSelector('tr[data-id]');
    const rows = await popup.locator('tr[data-id]').count();
    const openN = await page.evaluate(async () => (await import('/app/js/state.js')).state.findings.filter(f => f.state === 'open').length);
    ok(rows === openN, 'The table window lists the pending findings (' + rows + '/' + openN + ')');
    const row = popup.locator('tr[data-id="' + fid + '"]');
    ok(/en base a/.test(await row.locator('td.txt').nth(1).textContent()) && /It decided to act/.test(await row.locator('td.txt').nth(0).textContent()),
      'A row shows the original and the translation at sentence level');
    await page.click('#rv-findings .iss:not([data-id="' + fid + '"])').catch(() => {});
    await row.locator('td.txt').nth(1).click();
    await page.waitForTimeout(400);
    const selId = await page.getAttribute('#rv-findings .iss.sel', 'data-id');
    ok(selId === fid, 'Clicking a row selects that finding in the main window');
    await popup.screenshot({ path: path.join(OUT, '5-table.png') });
    await row.locator('button.ok').click().catch(() => {});
    await page.waitForTimeout(400);
    const st = await page.evaluate(async (id) => (await import('/app/js/state.js')).state.findings.find(f => f.id === id).state, fid);
    ok(st === 'accepted' || st === 'open', 'A decision taken in the table reaches the main window (' + st + ')');
    if (st === 'open') {
      // No proposal to accept: reject it instead.
      await popup.locator('tr[data-id="' + fid + '"] button.no').click();
      await page.waitForTimeout(300);
    }
    const st2 = await page.evaluate(async (id) => (await import('/app/js/state.js')).state.findings.find(f => f.id === id).state, fid);
    ok(st2 !== 'open', 'The finding left the pending list after the decision in the table (' + st2 + ')');
    ok(await popup.locator('tr[data-id="' + fid + '"]').count() === 0, 'The table redraws itself after the change');
    await popup.close();

    // 5) The Excel to judge the findings.
    await page.selectOption('select[data-filter="state"]', 'all');
    await page.click('#tools button:has-text("Exportar")');
    await page.click('.menu .mi:has-text("Hallazgos para valorar")');
    await page.waitForSelector('.modal:has-text("Hallazgos para valorar")');
    await page.check('.modal input[value="real"]');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('.modal-foot .btn.primary')]);
    const xl = path.join(OUT, 'valorar.xlsx');
    await dl.saveAs(xl);
    const chk = py([
      'import openpyxl,sys', 'wb=openpyxl.load_workbook(sys.argv[1])', 'ws=wb["Hallazgos"]',
      'head=[c.value for c in ws[1]]',
      'dv=[d.formula1 for d in ws.data_validations.dataValidation]',
      'rows=[[c.value for c in r] for r in ws.iter_rows(min_row=2)]',
      'hit=[r for r in rows if r[8]=="en base a"]',
      'print(",".join(wb.sheetnames)); print("valoracion" if "Su valoraci\\u00f3n" in head else "-"); print("dv" if any("Falso positivo" in (f or "") for f in dv) else "-")',
      'print(hit[0][12] if hit else "-"); print(hit[0][1] if hit else "-")'].join('\n'), xl).trim().split('\n');
    ok(chk[0] === 'Hallazgos,Instrucciones' && chk[1] === 'valoracion' && chk[2] === 'dv', 'Excel to judge: two sheets, the column "Su valoraci\u00f3n" and its drop-down list (' + chk.slice(0, 3).join(' | ') + ')');
    ok(chk[3] === 'It decided to act on the basis of the proposal.' && chk[4] === '5.2', 'Excel to judge: the original sentence and its place (' + chk.slice(3).join(' | ') + ')');

    // 6) Settings: simple Modules table; fixed type of a built-in provider.
    await page.click('.step[data-view="settings"]');
    await page.click('.settings-nav button[data-sec="modules"]');
    await page.waitForSelector('.modtable');
    const deep = await page.locator('.modtable select[data-module="fidelity"][data-role="deep"]').count();
    const semOff = await page.locator('#view-settings select.inp >> nth=0').evaluate(() => {
      const s = Array.from(document.querySelectorAll('#view-settings select.inp')).find(x => Array.from(x.options).some(o => o.value === 'local'));
      return s ? s.value : 'none';
    });
    ok(deep === 1 && semOff === 'off', 'Modules: model per module in one table; the semantic extra is off by default (' + deep + ', ' + semOff + ')');
    ok(!/Ortograf/.test(await page.textContent('.modtable')), 'No spelling module any more');
    await page.screenshot({ path: path.join(OUT, '6-modules.png'), fullPage: true });
    await page.click('.settings-nav button[data-sec="providers"]');
    await page.waitForSelector('.pcard');
    await page.locator('.pcard', { hasText: 'Gemini' }).locator('button:has-text("Editar")').click();
    await page.waitForSelector('.modal');
    ok(/Fijo en los proveedores de serie/.test(await page.textContent('.modal')), 'A built-in provider says its type is fixed instead of showing a dead list');
    await page.keyboard.press('Escape');

    ok(!errors.length, 'No console errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
    await ctx.close();
  } catch (e) {
    console.error(e);
    failures++;
  } finally {
    await browser.close();
    await srv.close();
  }
  console.log(failures ? '\nNAV: ' + failures + ' FAILED' : '\nNAV: ALL PASSED');
  process.exit(failures ? 1 : 0);
}

main();
