#!/usr/bin/env node
/**
 * doctype.e2e.mjs - The type of document and the footer of Revisar, with the mock provider:
 *   - the type is guessed from the eLUNa symbol in the file names (SR, PV, RES/DEC);
 *   - Archivos and Revisar show the same choice; a summary record puts its one line (present tense,
 *     the country's name) into the instructions, after the first line, and the plan names it;
 *     "Sin especificar" adds nothing;
 *   - a bench of one's own may bring it (banco.json "docType");
 *   - Revisar's footer: with findings, "Siguiente: corregir"; while a deferred review is running,
 *     "Ir a Corregir" leads on and what it covers is not sent again.
 * Exit code 1 on failure.
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { startServer } from '../tools/serve.mjs';
import { startMockAI } from './mock-ai.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'out', 'doctype');
fs.mkdirSync(OUT, { recursive: true });

let failures = 0;
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) failures++; };

async function main() {
  const srv = await startServer({ port: 0 });
  const mock = await startMockAI(8790);
  const base = 'http://localhost:' + srv.port;
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    await page.goto(base + '/app/index.html');
    await page.waitForSelector('.modal', { timeout: 15000 });
    await page.click('.modal-foot .btn');
    await page.evaluate(async () => {
      const reg = await import('/app/js/ai/registry.js');
      const p = await reg.saveProvider({ name: 'Simulador', adapter: 'openai-compatible', baseUrl: 'http://localhost:8790/v1', trust: 'external',
        models: [{ id: 'mock-small', label: 'Simulado' }] });
      await reg.setApiKey(p.id, 'k');
      await reg.setGeneralModel({ provider: p.id, model: 'mock-small' });
      const mc = await import('/app/js/review/module-config.js');
      for (const m of ['meaning', 'writing']) await mc.saveModuleConfig(m, { verify: false });
    });

    const guesses = await page.evaluate(async () => {
      const { guessDocType } = await import('/app/js/review/doc-types.js');
      return [['A_C.5_78_SR.12_ES.docx'], ['S_PV.9500.docx'], ['A_RES_78_1.docx'], ['E_ICEF_2024_DEC_3.docx'], ['A_78_123.docx'], ['banco_es.docx']].map(n => guessDocType(n));
    });
    ok(JSON.stringify(guesses) === JSON.stringify(['sr', 'pv', 'res', 'res', '', '']), 'The type is guessed from the symbol in the file name (' + guesses.join(', ') + ')');

    // The bench's documents: no symbol, "Sin especificar".
    await page.evaluate(async () => {
      const { benchFiles } = await import('/app/js/review/bench.js');
      const { openFiles, emit } = await import('/app/js/state.js');
      const f = await benchFiles();
      await openFiles(f.src, f.tgt);
      emit('goto', 'review');
    });
    await page.waitForSelector('#rv-modules .mchip');
    ok(await page.inputValue('#rv-doctype') === '', 'Revisar shows the type: "Sin especificar"');
    const pick = async () => {
      await page.evaluate(() => { document.querySelectorAll('#rv-modules .mchip input[type=checkbox]').forEach(c => { if (c.checked) c.click(); }); });
      await page.click('#rv-modules .mchip[data-mod="meaning"] input[type=checkbox]');
    };
    const review = async () => {
      mock.state.log = [];
      await pick();
      await page.click('#rv-run');
      await page.waitForSelector('.modal:has-text("Plan de ejecuci")', { timeout: 15000 });
      const plan = await page.textContent('.modal');
      await page.click('.modal-foot .btn.amber');
      await page.waitForSelector('.toast:has-text("Revisi\u00f3n terminada")', { timeout: 60000 });
      await page.evaluate(() => document.querySelectorAll('.toast').forEach(t => t.remove()));
      return { plan, calls: mock.state.log.filter(l => l.kind === 'openai' && /\nO: /.test(l.prompt)) };
    };
    let r = await review();
    ok(r.calls.length > 0 && !/Tipo de documento/.test(r.calls[0].system) && !/Tipo de documento/.test(r.plan), 'Unspecified: nothing added to the instructions or the plan');

    // A summary record, chosen in Revisar: also in Archivos; its line goes after the first line.
    await page.click('.step[data-view="review"]');
    await page.waitForSelector('#rv-doctype');
    await page.selectOption('#rv-doctype', 'sr');
    await page.waitForTimeout(200);
    ok(await page.evaluate(async () => (await import('/app/js/state.js')).state.project.docType) === 'sr', 'Chosen in Revisar: the project is a summary record');
    r = await review();
    const sys = r.calls.length ? r.calls[0].system : '';
    const lines = sys.split('\n');
    ok(/^Tipo de documento: acta resumida\. .*presente.*were parties: \u00abson partes\u00bb.*nombre del pa\u00eds/.test(lines[1] || ''), 'Its one line goes into the instructions, right after the first');
    ok(/Prueba: \u00bfun lector/.test(sys) && r.calls.length > 0, 'And the task is unchanged (' + r.calls.length + ' calls: not taken from the cache of the other type)');
    ok(/Tipo de documento: Acta resumida/.test(r.plan), 'The plan names the type');
    await page.click('.step[data-view="files"]');
    await page.waitForSelector('#view-files.on');
    ok(await page.inputValue('#files-doctype') === 'sr', 'Archivos shows the same choice');
    await page.screenshot({ path: path.join(OUT, '1-files.png') });

    // Revisar's footer: with findings, the way on to Corregir.
    await page.evaluate(async () => {
      const { state, emit } = await import('/app/js/state.js');
      state.findings = [{ id: 'x1', module: 'meaning', source: 'ai', state: 'open', unit: 1, cat: 'MIST', sev: 'MAY', quote: 'a', suggestion: 'b', reason: 'c' }];
      emit('findings');
      emit('goto', 'review');
    });
    await page.waitForSelector('#rv-modules .mchip');
    await pick();
    ok(await page.isVisible('#rv-next') && /Siguiente: corregir/.test(await page.textContent('#rv-next')) && /Revisar de nuevo/.test(await page.textContent('#rv-run')),
      'With findings: "Siguiente: corregir", and the run button says "Revisar de nuevo"');

    // A deferred review running for Sentido.
    await page.evaluate(async () => {
      const { state, emit } = await import('/app/js/state.js');
      state.findings = [];
      state.project.deferred = [{ id: 'd1', createdAt: Date.now(), status: 'running', modules: ['meaning'], jobs: [{ total: 2, done: 0 }], findings: 0, spent: 0 }];
      emit('findings');
    });
    await page.waitForTimeout(300);
    ok(/Ir a Corregir/.test(await page.textContent('#rv-next')) && await page.evaluate(() => document.getElementById('rv-next').classList.contains('primary')),
      'Deferred review running: "Ir a Corregir" leads on');
    ok(!(await page.isVisible('#rv-run')) && /Revisi\u00f3n diferida en curso \(Sentido\)/.test(await page.textContent('#rv-summary')), 'And what it covers cannot be sent again');
    await page.screenshot({ path: path.join(OUT, '2-deferred.png') });
    await page.click('#rv-modules .mchip[data-mod="writing"] input[type=checkbox]');
    ok(await page.isVisible('#rv-run') && !(await page.isDisabled('#rv-run')), 'Another reviewer can still be run');
    await page.click('#rv-next');
    await page.waitForSelector('#view-correct.on');
    ok(true, '"Ir a Corregir" goes to step 4');
    await page.evaluate(async () => { const { state } = await import('/app/js/state.js'); state.project.deferred = []; });

    // A bench of one's own with its type.
    const zipType = await page.evaluate(async () => {
      const { benchFiles, readBenchZip } = await import('/app/js/review/bench.js');
      const f = await benchFiles();
      const z = new window.JSZip();
      z.file('banco.json', JSON.stringify({ kind: 'umbra-bench', version: 1, name: 'Actas', docType: 'sr', paragraphs: [{ n: 1, en: 'x', es: 'y', expect: [] }] }));
      z.file('banco_en.docx', await f.src.arrayBuffer());
      z.file('banco_es.docx', await f.tgt.arrayBuffer());
      const blob = await z.generateAsync({ type: 'blob' });
      const r = await readBenchZip(new File([blob], 'actas.zip'));
      return r.spec.docType;
    });
    ok(zipType === 'sr', 'A bench of one\'s own keeps its "docType" (' + zipType + ')');
    ok(errors.length === 0, 'No console errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  } finally {
    await browser.close();
    await mock.close();
    await srv.close();
  }
  console.log(failures ? '\nDOCTYPE: ' + failures + ' FAILED' : '\nDOCTYPE: ALL PASSED');
  process.exit(failures ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
