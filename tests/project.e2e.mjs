#!/usr/bin/env node
/**
 * project.e2e.mjs - Cleaning up, made plain (the owner's report, 2026-11-09):
 *   - the header shows the open project and its two files, with a menu: new, open another, close,
 *     delete;
 *   - "Proyectos recientes" has a bin on each project;
 *   - the saved answers of the AI (the results cache) are dealt with where it is decided: the plan says
 *     how many paragraphs it reuses and "Preguntar de nuevo a la IA" shows the plan without them;
 *   - Vaciar (Corregir) only deletes findings: no option about the cache any more.
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
const FIX = path.join(HERE, 'fixtures');
const OUT = path.join(HERE, 'out', 'project');
fs.mkdirSync(OUT, { recursive: true });

let failures = 0;
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) failures++; };

async function main() {
  const srv = await startServer({ port: 0 });
  const mock = await startMockAI(8790);
  const base = 'http://localhost:' + srv.port;
  const browser = await chromium.launch();
  try {
    const page = await (await browser.newContext({ viewport: { width: 1500, height: 900 } })).newPage();
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
    ok(!(await page.isVisible('#projchip')), 'No project: nothing in the header');
    const load = async () => {
      for (const [sel, file] of [['#drop-src', 'names_en.docx'], ['#drop-tgt', 'names_es.docx']]) {
        const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click(sel)]);
        await chooser.setFiles(path.join(FIX, file));
      }
      await page.waitForSelector('#view-mask.on', { timeout: 20000 });
    };
    await load();
    const chip = await page.textContent('#projchip');
    ok(await page.isVisible('#projchip') && /names_es/.test(chip) && /names_en\.docx \u2192 names_es\.docx/.test(chip), 'The header shows the project and its two files (' + chip.trim() + ')');

    await page.click('.step[data-view="files"]');
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, '1-header.png') });
    // The saved answers: a first review, then the same again.
    const review = async (fresh) => {
      mock.state.log = [];
      await page.click('.step[data-view="review"]');
      await page.waitForSelector('#rv-modules .mchip');
      await page.evaluate(() => { document.querySelectorAll('#rv-modules .mchip input[type=checkbox]').forEach(c => { if (c.checked) c.click(); }); });
      await page.click('#rv-modules .mchip[data-mod="writing"] input[type=checkbox]');
      await page.click('#rv-run');
      await page.waitForSelector('.modal:has-text("Plan de ejecuci")', { timeout: 15000 });
      const first = await page.textContent('.modal');
      let second = '';
      if (fresh) {
        await page.click('.modal-foot .btn:has-text("Preguntar de nuevo a la IA")');
        await page.waitForSelector('.modal:has-text("Plan de ejecuci")', { timeout: 15000 });
        second = await page.textContent('.modal');
      }
      await page.click('.modal-foot .btn.amber');
      await page.waitForSelector('.modal:has-text("Revisi\u00f3n terminada")', { timeout: 60000 });
      await page.click('.modal-foot .btn:has-text("Cerrar")');
      return { first, second, calls: mock.state.log.filter(l => l.kind === 'openai').length };
    };
    let r = await review(false);
    ok(r.calls > 0 && !/Respuestas guardadas/.test(r.first), 'First review: sent, nothing saved yet (' + r.calls + ' calls)');
    r = await review(true);
    ok(/Respuestas guardadas: \d+ p\u00e1rrafos? ya se revis/.test(r.first), 'Again: the plan says how many paragraphs it reuses, at no cost');
    ok(!/Respuestas guardadas/.test(r.second) && /\d+ llamadas/.test(r.second), '"Preguntar de nuevo a la IA": the plan again, without them, with its calls');
    ok(r.calls > 0, 'And the AI reads them again (' + r.calls + ' calls)');

    // Vaciar only deletes findings.
    await page.click('.step[data-view="correct"]');
    await page.click('#tools button:has-text("Vaciar")');
    await page.waitForSelector('.modal:has-text("Vaciar los hallazgos")');
    const vac = await page.textContent('.modal');
    ok(!/Olvidar/.test(vac) && /respuestas guardadas de la IA tampoco/.test(vac), 'Vaciar: only findings; it says the saved answers stay');
    await page.click('.modal-foot .btn:has-text("Cancelar")');

    // The header's menu: close, then the bin in "Proyectos recientes".
    await page.click('#projchip');
    const items = await page.evaluate(() => [...document.querySelectorAll('.menu .mi')].map(x => x.textContent.trim()));
    ok(['Nuevo proyecto', 'Abrir otro proyecto\u2026', 'Cerrar este proyecto', 'Borrar este proyecto\u2026'].every(x => items.includes(x)), 'The menu: new, open another, close, delete (' + items.join(' | ') + ')');
    await page.click('.menu .mi:has-text("Cerrar este proyecto")');
    await page.waitForSelector('#view-files.on');
    ok(!(await page.isVisible('#projchip')) && await page.locator('#files-recent tr').count() === 1, 'Closed: the header is empty and the project stays in Proyectos recientes');
    await page.click('#files-recent .recent-del');
    await page.waitForSelector('.modal:has-text("Borrar proyecto")');
    ok(/respuestas guardadas de la IA y el registro de uso/.test(await page.textContent('.modal')), 'Deleting says what is not deleted');
    await page.click('.modal-foot .btn:has-text("Borrar")');
    await page.waitForTimeout(400);
    ok(await page.locator('#files-recent tr').count() === 0, 'The bin deletes it from Proyectos recientes');

    // Delete the open project from the header.
    await load();
    await page.click('#projchip');
    await page.click('.menu .mi:has-text("Borrar este proyecto")');
    await page.waitForSelector('.modal:has-text("Borrar proyecto")');
    await page.click('.modal-foot .btn:has-text("Borrar")');
    await page.waitForSelector('#view-files.on');
    await page.waitForTimeout(300);
    ok(!(await page.isVisible('#projchip')) && await page.evaluate(async () => (await (await import('/app/js/state.js')).listProjects()).length) === 0, 'Deleting the open project closes it and removes it');
    ok(errors.length === 0, 'No console errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  } finally {
    await browser.close();
    await mock.close();
    await srv.close();
  }
  console.log(failures ? '\nPROJECT: ' + failures + ' FAILED' : '\nPROJECT: ALL PASSED');
  process.exit(failures ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
