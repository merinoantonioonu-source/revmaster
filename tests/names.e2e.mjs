#!/usr/bin/env node
/**
 * names.e2e.mjs - "Nombres oficiales" with names that are NOT recognised as a pair (tests/fixtures/
 * names_*.docx, invented sentences), with the mock provider:
 *   - a name of the original that its translation does not show, with nothing to pair, goes in the
 *     table with "\u2014"; the AI gives the official name, and a finding is made where it is missing
 *     (the Department translated wrong) but not where it is there (the Volunteers, well translated);
 *   - an English acronym left in the Spanish (UNTSO) is paired with the original's and anchored;
 *   - the module's answers (category NOM) are read at all (they used to be dropped);
 *   - the call still carries only the table of names.
 * Exit code 1 on failure.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { startServer } from '../tools/serve.mjs';
import { startMockAI } from './mock-ai.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, 'fixtures');

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
    });
    for (const [sel, file] of [['#drop-src', 'names_en.docx'], ['#drop-tgt', 'names_es.docx']]) {
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click(sel)]);
      await chooser.setFiles(path.join(FIX, file));
    }
    await page.waitForSelector('#view-mask.on', { timeout: 20000 });

    const rows = await page.evaluate(async () => {
      const { state } = await import('/app/js/state.js');
      const { namesRows } = await import('/app/js/review/names.js');
      return namesRows(state.session).map(r => ({ n: r.n, src: r.src, tgt: r.tgt, missing: !!r.missing }));
    });
    console.log(rows.map(r => r.n + ' ' + r.src + ' => ' + r.tgt).join('\n'));
    const desa = rows.find(r => /Economic and Social Affairs/.test(r.src));
    const vol = rows.find(r => /Volunteers/.test(r.src));
    const untso = rows.find(r => r.src === 'UNTSO');
    ok(desa && desa.missing && desa.tgt === '\u2014', 'A name translated wrong (not recognised) goes in the table with "\u2014"');
    ok(!!vol, 'A name UMBRA does not recognise as a pair in the translation is in the table too (' + (vol && vol.tgt) + ')');
    ok(untso && !untso.missing && untso.tgt === 'UNTSO', 'An English acronym left in the Spanish is paired with the original\'s');

    // The AI's answer: the official names; the Volunteers' is in the translation already.
    const answer = [
      // The model copies the table's category (ORG) instead of NOM: it is still read.
      desa.n + ' | ORG | MAY | \u2014 | Departamento de Asuntos Econ\u00f3micos y Sociales / DAES | Nombre oficial.',
      vol.n + ' | NOM | MAY | \u2014 | Voluntarios de las Naciones Unidas / VNU | Nombre oficial.',
      untso.n + ' | NOM | MAY | UNTSO | ONUVT | Sigla oficial en espa\u00f1ol.',
      'FIN 3'].join('\n');
    Object.assign(mock.state, { log: [], rules: [{ match: 'NOMBRES (fila', response: answer }], def: 'FIN 0' });
    await page.click('.step[data-view="review"]');
    await page.waitForSelector('#rv-modules .mchip');
    await page.evaluate(() => { document.querySelectorAll('#rv-modules .mchip input[type=checkbox]').forEach(c => { if (c.checked) c.click(); }); });
    await page.click('#rv-modules .mchip[data-mod="names"] input[type=checkbox]');
    await page.click('#rv-run');
    await page.waitForSelector('.modal:has-text("Plan de ejecuci")', { timeout: 15000 });
    await page.click('.modal-foot .btn.amber');
    await page.waitForSelector('.modal:has-text("Revisi\u00f3n terminada")', { timeout: 60000 });
    await page.click('.modal-foot .btn:has-text("Cerrar")');

    const call = mock.state.log.find(l => l.kind === 'openai' && /^NOMBRES \(fila/.test(l.prompt));
    ok(!!call && call.prompt.split('\n').slice(1, -1).every(l => /^\d+ \| (ORG|ORGANO|CARGO|PAIS|LUGAR) \| [^|]+ \| [^|]+$/.test(l)) && !/organiz|ceasefire|veinte/.test(call.prompt),
      'The call carries only the table of names');
    ok(!!call && /\u00ab\u2014\u00bb/.test(call.system), 'The instructions say what "\u2014" asks for');
    const found = await page.evaluate(async () => {
      const { state } = await import('/app/js/state.js');
      return state.findings.filter(f => f.module === 'names').map(f => ({ n: state.session.units[f.unit].n, quote: f.quote, suggestion: f.suggestion, start: f.start }));
    });
    console.log(JSON.stringify(found));
    ok(found.some(f => f.n === 1 && f.quote === '' && f.suggestion === 'Departamento de Asuntos Econ\u00f3micos y Sociales'), 'The Department translated wrong: a finding with the official name');
    ok(!found.some(f => f.n === 3), 'The Volunteers, well translated: nothing (the official name is there)');
    ok(found.some(f => f.n === 2 && f.quote === 'UNTSO' && f.suggestion === 'ONUVT' && f.start != null), 'UNTSO: a finding on the acronym, anchored');
    ok(errors.length === 0, 'No console errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  } finally {
    await browser.close();
    await mock.close();
    await srv.close();
  }
  console.log(failures ? '\nNAMES: ' + failures + ' FAILED' : '\nNAMES: ALL PASSED');
  process.exit(failures ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
