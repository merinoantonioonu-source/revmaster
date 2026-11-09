#!/usr/bin/env node
/**
 * nav.e2e.mjs - Navigation between the sheets (as in COMeT Final Check) and the tools around it:
 *   - sentence offsets; a click marks the sentence and its pair; arrows; sentence alignment when the
 *     two paragraphs do not have the same number of sentences;
 *   - Entities: "Con problemas" by default; a click on a card goes there (yellow sentences, red glow on
 *     the entity), also for an entity found on one side only; "Emparejar" with a search box and a
 *     suggestion chosen in advance; hovering a tag shows only the hidden text and lights its
 *     counterpart; right click > "Desenmascarar" until another sentence is clicked; no articles;
 *   - Corregir: a finding marks its exact text and both sentences, in its row and in "Documento";
 *     filters; the inspector (an edited proposal is what gets accepted); "Vaciar"; the table window;
 *     the "Hallazgos para valorar" Excel (drop-down list in the right XML order);
 *   - Settings: no Rules section, the Modules table with "Exigencia", no duplicated content, the fixed
 *     type of a built-in provider.
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
  'The Committee met again. It decided to act on the basis of the proposal.',
  'France supported the text. Brazil abstained. Kenya voted against it.'
];
const ES = [
  'Informe de la Comisi\u00f3n',
  'La Comisi\u00f3n se reuni\u00f3 dos veces en Ginebra. Aprob\u00f3 su informe. Tambi\u00e9n eligi\u00f3 a su Mesa.',
  'El Secretario General habl\u00f3 y luego se retir\u00f3.',
  'En total, 1.520 personas asistieron al per\u00edodo de sesiones.',
  'La Comisi\u00f3n volvi\u00f3 a reunirse. Decidi\u00f3 actuar en base a la propuesta.',
  'Francia apoy\u00f3 el texto y el Brasil se abstuvo. Kenya vot\u00f3 en contra.'
];
const mk = (file, paras) => py('import docx,sys,json\nd=docx.Document()\nfor t in json.loads(sys.argv[2]): d.add_paragraph(t)\nd.save(sys.argv[1])', path.join(OUT, file), JSON.stringify(paras));
mk('nav_en.docx', EN);
mk('nav_es.docx', ES);

async function highlights(page) {
  return page.evaluate(() => {
    const get = (n) => { const h = CSS.highlights.get(n); return h ? Array.from(h).map(r => r.toString()) : []; };
    return { seg: get('um-seg'), focus: get('um-focus'), flash: document.querySelectorAll('.pane-body .p.flash').length,
      hot: Array.from(document.querySelectorAll('.pane-body .hot')).map(x => x.closest('.pane-body').id + ':' + x.textContent) };
  });
}

/** Clicks (or right-clicks) the middle of a word inside the visible sheet `sel`. */
async function clickWord(page, sel, word, button) {
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
  await page.mouse.click(pt.x, pt.y, button ? { button } : undefined);
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

    // Sentence offsets and alignment.
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

    const tags = await page.evaluate(async () => (await import('/app/js/state.js')).state.session.ent.entities.map(e => e.tagSrc + '=' + e.tagTgt));
    ok(tags.length && tags.every(t => { const [a, b] = t.split('='); return a === b && !/\{(el|la|los|las) /.test(b); }), 'Tags carry no article: the same tag on both sides (' + tags.slice(0, 4).join(', ') + ')');

    // 1) A click marks the sentence and its pair; arrows; alignment of 3 sentences with 2.
    await clickWord(page, '#mask-src', 'adopted');
    let h = await highlights(page);
    ok(h.seg.includes('It adopted its report.') && h.seg.includes('Aprob\u00f3 su informe.'), 'Click on a source sentence marks it and its Spanish pair (' + JSON.stringify(h.seg) + ')');
    await page.screenshot({ path: path.join(OUT, '1-click.png') });
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(300);
    h = await highlights(page);
    ok(h.seg.includes('Tambi\u00e9n eligi\u00f3 a su Mesa.') && h.seg.includes('It also elected its officers.'), 'Right arrow goes to the next sentence pair (' + JSON.stringify(h.seg) + ')');
    await clickWord(page, '#mask-src', 'abstained');
    h = await highlights(page);
    ok(h.seg.length === 2 && /abstained\.$/.test(h.seg[0]) && /se abstuvo\.$/.test(h.seg[1]) && /apoy/.test(h.seg[1]),
      'Three sentences against two: the counterpart sentence is found by alignment, not the whole paragraph (' + JSON.stringify(h.seg) + ')');

    // 2) Entities: problems first; a card click goes there with a red glow.
    const segOn = await page.textContent('#mask-bubbles .seg2 button.on');
    ok(/Con problemas/.test(segOn), 'The entity list starts with the ones that have a problem (' + segOn.trim() + ')');
    const onlyTgt = page.locator('#mask-entities .ent', { hasText: 'T: 1.520' }).first();
    await onlyTgt.click();
    await page.waitForTimeout(500);
    h = await highlights(page);
    ok(h.seg.some(x => /personas asistieron al per\u00edodo de sesiones\.$/.test(x)) && h.seg.some(x => /people attended the session\.$/.test(x)) &&
      h.hot.some(x => /^mask-tgt:NUM/.test(x)),
      'Card of an entity found only in the translation: both sentences in yellow and the tag with a red glow (' + JSON.stringify(h) + ')');
    await page.screenshot({ path: path.join(OUT, '2-card.png') });
    const cargo = page.locator('#mask-entities .ent', { hasText: 'Secretary-General' }).first();
    ok(/Aparece 2 veces en el original y 1 en la traducci/.test(await cargo.textContent()), 'The card explains the count difference');
    await cargo.click();
    await page.waitForTimeout(400);
    h = await highlights(page);
    ok(h.seg.length === 3 && h.hot.filter(x => /^mask-src:CARGO/.test(x)).length === 2 && h.hot.some(x => /^mask-tgt:CARGO/.test(x)),
      'Card of a count difference: the sentences of both sides and every occurrence glowing (' + JSON.stringify(h) + ')');

    // Hover: the tooltip is the hidden text only; the counterpart glows.
    const pill = page.locator('#mask-src .tk', { hasText: /^CARGO/ }).first();
    ok(await pill.getAttribute('title') === 'Secretary-General', 'The tooltip of a tag is only what it hides');
    await pill.hover();
    await page.waitForTimeout(200);
    ok(await page.locator('#mask-tgt .tk.glow').count() >= 1, 'Hovering a tag lights its counterpart in the other sheet');
    await page.mouse.move(5, 5);

    // Right click > Desenmascarar: real text until another sentence is clicked.
    await clickWord(page, '#mask-src', 'spoke', 'right');
    await page.click('.menu .mi:has-text("Desenmascarar")');
    await page.waitForTimeout(300);
    const revealed = await page.$$eval('.pane-body .ent-orig.revealed', ns => ns.map(n => n.closest('.pane-body').id + ':' + n.textContent));
    ok(revealed.some(x => x === 'mask-src:Secretary-General') && revealed.some(x => x === 'mask-tgt:Secretario General'), 'Desenmascarar shows the real text of the sentence and of its pair (' + revealed.join(', ') + ')');
    await page.screenshot({ path: path.join(OUT, '3-reveal.png') });
    await clickWord(page, '#mask-src', 'twice');
    ok(await page.locator('.pane-body .ent-orig.revealed').count() === 0, 'A click on another sentence masks it again');

    // Emparejar: search box and the likely counterpart chosen in advance.
    const num = page.locator('#mask-entities .ent', { hasText: 'O: 1,250' }).first();
    await num.click();
    await page.locator('#mask-entities .ent.sel button:has-text("Emparejar")').click();
    await page.waitForSelector('.modal:has-text("Emparejar")');
    const pre = await page.textContent('.pairlist .pairrow.on');
    ok(/1\.520/.test(pre) && /Sugerida/.test(pre), 'Emparejar chooses in advance the figure without a pair in the same paragraph (' + pre.replace(/\s+/g, ' ').trim() + ')');
    await page.fill('.modal input[type=search]', 'zzz');
    ok(await page.locator('.pairlist .pairrow').count() === 0, 'The search box filters the list');
    await page.fill('.modal input[type=search]', '');
    await page.screenshot({ path: path.join(OUT, '4-pair.png') });
    await page.click('.modal-foot .btn.primary');
    await page.waitForTimeout(500);
    const paired = await page.evaluate(async () => {
      const { state } = await import('/app/js/state.js');
      const e = state.session.ent.entities.find(x => Object.keys(x.srcForms).includes('1,250'));
      return e ? e.status + ':' + Object.keys(e.tgtForms).join('/') : 'none';
    });
    ok(paired === 'ok:1.520', 'After Emparejar both figures are one entity without problems (' + paired + ')');

    // 3) Review: injected findings (no AI here), card -> exact text and both sentences.
    await page.click('.step[data-view="review"]');
    await page.waitForSelector('#rv-modules .mchip');
    ok(await page.locator('#rv-modules .mchip[data-mod="local"]').count() === 0, 'No module without AI any more');
    const fid = await page.evaluate(async () => {
      const { state, addFindings } = await import('/app/js/state.js');
      const { anchorItem } = await import('/app/js/review/findings.js');
      const s = state.session;
      const unitByN = new Map(s.units.map(u => [u.n, u]));
      const n = s.units.find(u => u.tgtPara !== null && /en base a/.test(s.tgt.paras[u.tgtPara].text)).n;
      const a = anchorItem({ unit: n, cat: 'EST', sev: 'MEN', quote: 'en base a', suggestion: 'sobre la base de', reason: 'Calco.' }, { session: s, unitByN, module: 'writing', source: 'ai', model: 'prueba' });
      const b = anchorItem({ unit: n, cat: 'MIST', sev: 'MAY', quote: 'propuesta', suggestion: 'proposici\u00f3n', reason: 'Prueba.' }, { session: s, unitByN, module: 'meaning', source: 'ai', model: 'prueba' });
      addFindings([a, b]);
      return a.id;
    });
    await page.click('.step[data-view="correct"]');
    await page.waitForSelector('#rv-findings .cx-row');
    const labels = await page.$$eval('#rv-bubbles .ffield > span', s => s.map(x => x.textContent));
    const modBtns = await page.$$eval('#cx-mods button', bs => bs.map(b => b.dataset.mod));
    ok(labels.join(',') === 'Estado,Gravedad' && modBtns.join(',') === 'all,meaning,writing', 'Findings are filtered by module (buttons), state and severity (' + labels.join(', ') + ' | ' + modBtns.join(', ') + ')');
    ok(await page.locator('#rv-findings .cx-row').count() === 1 && await page.locator('#rv-findings .cx-badge').count() === 2, 'Corregir: one row per segment, one badge per finding');
    await page.click('#rv-findings .cx-badge[data-id="' + fid + '"]');
    await page.waitForTimeout(400);
    ok(/\u00a75\.2/.test(await page.textContent('#cx-insp .ci-meta')), 'The inspector shows paragraph and sentence (\u00a75.2)');
    h = await highlights(page);
    ok(h.focus.includes('en base a') && h.seg.includes('Decidi\u00f3 actuar en base a la propuesta.') && h.seg.includes('It decided to act on the basis of the proposal.'),
      'In its row, a finding marks its exact text and the sentence pair (' + JSON.stringify(h) + ')');
    await page.screenshot({ path: path.join(OUT, '5-finding.png') });
    await page.click('#cx-mode button[data-mode="doc"]');
    await page.waitForTimeout(500);
    h = await highlights(page);
    ok(h.focus.includes('en base a') && h.seg.includes('Decidi\u00f3 actuar en base a la propuesta.') && h.seg.includes('It decided to act on the basis of the proposal.'),
      'In "Documento", both sheets go to the sentence of the finding (' + JSON.stringify(h) + ')');
    await page.screenshot({ path: path.join(OUT, '5b-document.png') });
    await page.click('#cx-mode button[data-mode="rows"]');
    await page.waitForTimeout(300);
    await page.fill('#cx-q', 'zzz');
    await page.waitForTimeout(400);
    ok(await page.locator('#rv-findings .cx-row').count() === 0, 'The search box filters the rows');
    await page.fill('#cx-q', '');
    await page.waitForTimeout(400);
    await page.click('#rv-findings .cx-badge[data-id="' + fid + '"]');

    // The table window.
    const [popup] = await Promise.all([page.waitForEvent('popup'), page.click('#tools button:has-text("Tabla")')]);
    await popup.waitForSelector('tr[data-id]');
    ok(await popup.locator('tr[data-id]').count() === 2, 'The table window lists the pending findings');
    const row = popup.locator('tr[data-id="' + fid + '"]');
    ok(/en base a/.test(await row.locator('td.txt').nth(1).textContent()) && /It decided to act/.test(await row.locator('td.txt').nth(0).textContent()),
      'A row shows the original and the translation at sentence level');
    await row.locator('td.txt').nth(1).click();
    await page.waitForTimeout(400);
    ok(await page.getAttribute('#rv-findings .cx-badge.cur', 'data-id') === fid, 'Clicking a row selects that finding in the main window');
    await row.locator('button.ok').click();
    await page.waitForTimeout(400);
    const st = await page.evaluate(async (id) => (await import('/app/js/state.js')).state.findings.find(f => f.id === id).state, fid);
    ok(st === 'accepted' && await popup.locator('tr[data-id="' + fid + '"]').count() === 0, 'A decision taken in the table reaches the main window and the table redraws itself');
    await popup.screenshot({ path: path.join(OUT, '6-table.png') });
    await popup.close();

    // The inspector: the proposal can be edited before accepting, and then it moves to the next one.
    const other = await page.evaluate(async (id) => (await import('/app/js/state.js')).state.findings.find(f => f.id !== id).id, fid);
    await page.click('#rv-findings .cx-badge[data-id="' + other + '"]');
    await page.waitForSelector('#cx-insp #cx-sug');
    ok(/propuesta/.test(await page.textContent('#cx-insp .ci-quote')), 'The inspector shows the other finding');
    await page.fill('#cx-sug', 'planteamiento');
    await page.keyboard.press('Control+Enter');
    await page.waitForTimeout(300);
    const ed = await page.evaluate(async (id) => { const f = (await import('/app/js/state.js')).state.findings.find(x => x.id === id); return f.state + ':' + f.edited; }, other);
    ok(ed === 'accepted:planteamiento', 'An edited proposal is what gets accepted (' + ed + ')');
    ok(/Todo decidido/.test(await page.textContent('#st-correct')), 'Step 4 says when everything has been decided');

    // The Excel to judge the findings: opens in Excel (drop-down list before ignoredErrors).
    await page.click('.step[data-view="export"]');
    await page.click('#view-export button:has-text("Hallazgos para valorar")');
    await page.waitForSelector('.modal:has-text("Hallazgos para valorar")');
    await page.check('.modal input[value="real"]');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('.modal-foot .btn.primary')]);
    const xl = path.join(OUT, 'valorar.xlsx');
    await dl.saveAs(xl);
    const chk = py([
      'import openpyxl,sys,zipfile,re', 'wb=openpyxl.load_workbook(sys.argv[1])', 'ws=wb["Hallazgos"]',
      'head=[c.value for c in ws[1]]',
      'dv=[d.formula1 for d in ws.data_validations.dataValidation]',
      'rows=[[c.value for c in r] for r in ws.iter_rows(min_row=2)]',
      'hit=[r for r in rows if r[8]=="en base a"]',
      'x=zipfile.ZipFile(sys.argv[1]).read("xl/worksheets/sheet1.xml").decode("utf-8")',
      // Schema order of CT_Worksheet for the elements present.
      'order=["sheetData","autoFilter","mergeCells","conditionalFormatting","dataValidations","hyperlinks","pageMargins","pageSetup","ignoredErrors"]',
      'pos=[x.find("<"+t) for t in order if x.find("<"+t)>=0]',
      'print(",".join(wb.sheetnames)); print("valoracion" if "Su valoraci\\u00f3n" in head else "-"); print("dv" if any("Falso positivo" in (f or "") for f in dv) else "-")',
      'print(hit[0][12] if hit else "-"); print(hit[0][1] if hit else "-"); print("order-ok" if pos==sorted(pos) else "order-bad")'].join('\n'), xl).trim().split('\n');
    ok(chk[0] === 'Hallazgos,Instrucciones' && chk[1] === 'valoracion' && chk[2] === 'dv', 'Excel to judge: two sheets, the column "Su valoraci\u00f3n" and its drop-down list (' + chk.slice(0, 3).join(' | ') + ')');
    ok(chk[3] === 'It decided to act on the basis of the proposal.' && chk[4] === '5.2', 'Excel to judge: the original sentence and its place (' + chk.slice(3, 5).join(' | ') + ')');
    ok(chk[5] === 'order-ok', 'Excel to judge: the XML elements are in the order Excel requires (no "repair" message)');

    // Vaciar.
    await page.click('.step[data-view="correct"]');
    await page.click('#tools button:has-text("Vaciar")');
    await page.waitForSelector('.modal:has-text("Vaciar los hallazgos")');
    await page.click('.modal-foot .btn.danger');
    await page.waitForTimeout(300);
    ok(await page.evaluate(async () => (await import('/app/js/state.js')).state.findings.length) === 0, '"Vaciar" deletes the findings to start again');

    // 4) Settings: no Rules, the Modules table with Exigencia, no duplicated content.
    await page.click('.step[data-view="settings"]');
    await page.click('.settings-nav button[data-sec="modules"]');
    await page.waitForSelector('.modtable');
    const secs = await page.$$eval('.settings-nav button', bs => bs.map(b => b.dataset.sec));
    ok(!secs.includes('rules'), 'No Rules section any more (' + secs.join(', ') + ')');
    const strict = await page.$eval('.modtable select[data-strict="meaning"]', s => s.value);
    ok(strict === 'grave' && await page.locator('.modtable select[data-module="meaning"][data-role="deep"]').count() === 1 &&
      await page.locator('.modtable tr').count() === 5, 'Modules: four reviewers, one model each; Sentido asks only for what matters (' + strict + ')');
    await page.click('.settings-nav button[data-sec="lists"]');
    await page.click('.settings-nav button[data-sec="lists"]');
    await page.waitForTimeout(400);
    ok(await page.locator('.settings-body .card').count() === 1, 'A section clicked twice is drawn once (no duplicated content)');
    await page.screenshot({ path: path.join(OUT, '7-modules.png'), fullPage: true });
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
