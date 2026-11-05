#!/usr/bin/env node
/**
 * bench.e2e.mjs - The test bench built from the owner's review report and the "Nombres oficiales"
 * module, with the mock OpenAI-compatible provider:
 *   - the bench loads as a project of its own (31 paragraphs: known errors and correct ones);
 *   - after a run, hits, misses and noise are counted right (by paragraph and keys);
 *   - the names call carries ONLY the table of institutional names (no sentence, no person), the
 *     gateway refuses anything else, and its findings are anchored on every occurrence;
 *   - the calibrated prompts are in the calls (meaning test, small words count, strictness).
 * Screenshots go to tests/out/bench/. Exit code 1 on failure.
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
const OUT = path.join(HERE, 'out', 'bench');
fs.mkdirSync(OUT, { recursive: true });

let failures = 0;
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) failures++; };

async function main() {
  const srv = await startServer({ port: 0 });
  const mock = await startMockAI(8790);
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
    await page.evaluate(async () => {
      const reg = await import('/app/js/ai/registry.js');
      const p = await reg.saveProvider({ name: 'Simulador', adapter: 'openai-compatible', baseUrl: 'http://localhost:8790/v1', trust: 'external',
        models: [{ id: 'mock-small', label: 'Simulado' }] });
      await reg.setApiKey(p.id, 'k');
      await reg.setGeneralModel({ provider: p.id, model: 'mock-small' });
      const mc = await import('/app/js/review/module-config.js');
      for (const m of ['fidelity', 'integrity', 'grammar', 'style', 'coldread']) await mc.saveModuleConfig(m, { verify: false });
    });

    // The gateway refuses anything that is not a table of names.
    const refused = await page.evaluate(async () => {
      const g = await import('/app/js/ai/gateway.js');
      const out = [];
      for (const rows of [[{ n: 1, cat: 'PER', src: 'John Smith', tgt: 'John Smith' }],
        [{ n: 1, cat: 'ORG', src: 'The Council met twice in Geneva and adopted its report after a long debate on the matter of sanctions', tgt: 'x' }],
        [{ n: 1, cat: 'ORG', src: 'UNDP', tgt: 'PNUD | 12 | ORG | otra' }]]) {
        try { await g.callAINames({ module: 'names', rows }); out.push('sent'); } catch (e) { out.push(e.code); }
      }
      return out;
    });
    ok(refused.every(x => x === 'UNMASKED'), 'The names call refuses persons, sentences and smuggled rows (' + refused.join(', ') + ')');

    // Load the bench from the menu.
    await page.goto(base + '/app/index.html');
    await page.waitForSelector('#view-welcome.on');
    await page.click('.step[data-view="review"]');
    // No project yet: the menu lives in the review bar once a project is open, so open it through the module.
    await page.evaluate(async () => {
      const { benchFiles } = await import('/app/js/review/bench.js');
      const { openFiles, state, emit, saveProjectSoon } = await import('/app/js/state.js');
      const f = await benchFiles();
      await openFiles(f.src, f.tgt);
      state.project.bench = true; state.project.name = 'Banco de pruebas'; saveProjectSoon(); emit('project'); emit('goto', 'review');
    });
    await page.waitForSelector('#rv-modules .mchip');
    const units = await page.evaluate(async () => (await import('/app/js/state.js')).state.session.units.length);
    ok(units === 31, 'The bench opens as a project with its 31 paragraphs (' + units + ')');
    await page.click('#tools button:has-text("M\u00e1s")');
    ok(await page.locator('.menu .mi:has-text("Resultado del banco de pruebas")').count() === 1, 'In the bench project the menu offers the result');
    await page.keyboard.press('Escape');
    await page.mouse.click(5, 5);

    // A run with the mock: three right findings, one noise.
    Object.assign(mock.state, { log: [], rules: [
      { match: 'NOMBRES (fila', response: 'FIN 0' },
      { match: '\nO: ', response: '2 | MIST | MAY | e informaran sobre ellos | y aportaran informaci\u00f3n para orientarlos | Efforts es complemento de los dos verbos.\n' +
        '3 | MIST | MAY | despu\u00e9s de | en virtud de | Further to es normativo, no temporal.\n' +
        '18 | ADD | MAY | estricta |  | El original no dice estricta.\n' +
        '27 | MIST | MAY | celebr\u00f3 | mantuvo | Ruido de prueba.\n' +
        '27 | MIST | MEN | consultas | reuniones | Menor: la exigencia lo descarta.\nFIN 31' }
    ], def: 'FIN 0' });
    await page.evaluate(() => { document.querySelectorAll('#rv-modules .mchip input[type=checkbox]').forEach(c => { if (c.checked) c.click(); }); });
    for (const id of ['fidelity', 'integrity', 'names']) await page.click('#rv-modules .mchip[data-mod="' + id + '"] input[type=checkbox]');
    await page.click('#tools button:has-text("Ejecutar seleccionados")');
    await page.waitForSelector('.modal:has-text("Plan de ejecuci")', { timeout: 15000 });
    ok(/Nombres oficiales: 1 llamada con \d+ nombres \(solo la lista de nombres/.test(await page.textContent('.modal')), 'The plan shows the names call and says only the list travels');
    await page.click('.modal-foot .btn.amber');
    await page.waitForSelector('.toast:has-text("Banco de pruebas:")', { timeout: 60000 });
    const toastText = await page.textContent('.toast:has-text("Banco de pruebas:")');
    ok(/3 de 31 errores detectados, 1 hallazgos de ruido/.test(toastText), 'After the run the bench counts hits and noise (' + toastText.trim() + ')');

    // What was sent.
    const log = mock.state.log.filter(l => l.kind === 'openai');
    const namesCall = log.find(l => /^NOMBRES \(fila/.test(l.prompt));
    ok(!!namesCall, 'The names module made its call');
    if (namesCall) {
      const lines = namesCall.prompt.split('\n').slice(1, -1);
      ok(lines.length > 0 && lines.every(l => /^\d+ \| (ORG|ORGANO|CARGO|PAIS|LUGAR) \| [^|]+ \| [^|]+$/.test(l)), 'The names call carries only rows of names (' + lines.length + ' rows)');
      ok(!/Consejo alent|encouraged|Somalia\./.test(namesCall.prompt) && /NOMBRES OFICIALES/.test(namesCall.system), 'No sentence of the document in the names call');
    }
    const bil = log.find(l => /\nO: /.test(l.prompt));
    ok(!!bil && /Prueba: \u00bfun lector/.test(bil.system) && /aunque sea una sola palabra/.test(bil.system) && /including, but not limited to/.test(bil.system) && /EXIGENCIA/.test(bil.system),
      'Fidelity and Integrity carry the calibrated instructions (meaning test, small words, legal formulas, strictness)');

    // Results dialog.
    await page.click('#tools button:has-text("M\u00e1s")');
    await page.click('.menu .mi:has-text("Resultado del banco de pruebas")');
    await page.waitForSelector('.modal:has-text("Resultado del banco de pruebas")');
    const res = await page.textContent('.modal');
    ok(/3 de 31 errores detectados/.test(res) && /\u00a72 \u00b7 Fidelidad/.test(res) && /\u00a718 \u00b7 Integridad/.test(res) && /Ruido \(1\)/.test(res), 'The result lists hits, misses and the noise');
    await page.screenshot({ path: path.join(OUT, '1-result.png') });
    await page.keyboard.press('Escape');

    // Names findings are anchored on every occurrence of the form.
    const anchored = await page.evaluate(async () => {
      const { state } = await import('/app/js/state.js');
      const { namesRows, namesFindings } = await import('/app/js/review/names.js');
      const rows = namesRows(state.session);
      const r = rows.find(x => x.count >= 1);
      const fs = namesFindings(state.session, rows, [{ unit: r.n, cat: 'NOM', sev: 'MAY', quote: r.tgt, suggestion: 'Forma correcta', reason: 'Prueba.' }], { model: 'm' });
      return { cats: [...new Set(rows.map(x => x.cat))], count: r.count, n: fs.length, ok: fs.every(f => state.session.tgt.paras[state.session.units[f.unit].tgtPara].text.slice(f.start, f.end) === r.tgt) };
    });
    ok(anchored.n === anchored.count && anchored.ok && anchored.cats.every(c => ['ORG', 'ORGANO', 'CARGO', 'PAIS', 'LUGAR'].includes(c)),
      'A names finding is anchored on each occurrence of that form (' + JSON.stringify(anchored) + ')');

    ok(!errors.length, 'No console errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
    await ctx.close();
  } catch (e) {
    console.error(e);
    failures++;
  } finally {
    await browser.close();
    await mock.close();
    await srv.close();
  }
  console.log(failures ? '\nBENCH: ' + failures + ' FAILED' : '\nBENCH: ALL PASSED');
  process.exit(failures ? 1 : 0);
}

main();
