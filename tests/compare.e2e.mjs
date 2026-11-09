#!/usr/bin/env node
/**
 * compare.e2e.mjs - "Comparar con la version final" (Corregir > Mas), with invented documents
 * (tests/fixtures/names_*.docx and names_es_final.docx) and findings put in by the test:
 *   - a finding where the reviser changed something, with the same correction: probably right;
 *   - a finding where nothing changed: probably spurious; an omission in a paragraph changed only in form:
 *     spurious too;
 *   - a change of words no live finding covers: probably missed (the Verifier had thrown away the one
 *     that pointed at it: counted apart); a comma added: form, not missed;
 *   - the summary to paste in the chat, the Excel and the bench (.zip) that loads as a bench of one's own.
 * Exit code 1 on failure.
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { startServer } from '../tools/serve.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, 'fixtures');
const OUT = path.join(HERE, 'out', 'compare');
fs.mkdirSync(OUT, { recursive: true });

let failures = 0;
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) failures++; };

async function main() {
  const srv = await startServer({ port: 0 });
  const base = 'http://localhost:' + srv.port;
  const browser = await chromium.launch();
  try {
    const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true })).newPage();
    const errors = [];
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    await page.goto(base + '/app/index.html');
    await page.waitForSelector('.modal', { timeout: 15000 });
    await page.click('.modal-foot .btn');
    for (const [sel, file] of [['#drop-src', 'names_en.docx'], ['#drop-tgt', 'names_es.docx']]) {
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click(sel)]);
      await chooser.setFiles(path.join(FIX, file));
    }
    await page.waitForSelector('#view-mask.on', { timeout: 20000 });
    // Findings as the AI would leave them.
    await page.evaluate(async () => {
      const { state, emit } = await import('/app/js/state.js');
      const s = state.session;
      const at = (n, q) => { const u = s.units.find(x => x.n === n); const t = s.tgt.paras[u.tgtPara].text; const k = t.indexOf(q); return { unit: u.idx, start: k, end: k + q.length }; };
      const f = (id, n, q, sug, extra) => Object.assign({ id, module: 'meaning', source: 'ai', state: 'open', cat: 'MIST', sev: 'MAY', quote: q, suggestion: sug, reason: 'Prueba.', model: 'm' }, at(n, q), extra || {});
      state.findings = [
        f('a1', 1, 'Departamento de Econom\u00eda y Asuntos Sociales', 'Departamento de Asuntos Econ\u00f3micos y Sociales', { module: 'names', cat: 'NOM' }),
        f('a2', 3, 'envi\u00f3', 'mand\u00f3'),
        Object.assign(f('a3', 4, 'Consejo', 'x'), { start: null, end: null, quote: '', cat: 'OMI', suggestion: 'tras \u00abd\u00eda\u00bb: algo' }),
        f('a4', 2, 'zona', 'regi\u00f3n', { state: 'discarded', verified: 'no' })
      ];
      emit('findings');
      emit('goto', 'correct');
    });
    await page.waitForSelector('#view-correct.on');
    await page.click('#tools button:has-text("M\u00e1s")');
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('.menu .mi:has-text("Comparar con la versi\u00f3n final")')]);
    await chooser.setFiles(path.join(FIX, 'names_es_final.docx'));
    await page.waitForSelector('.modal:has-text("Comparaci\u00f3n con la versi\u00f3n final")', { timeout: 15000 });
    const fig = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.modal table.cmp tr')].map(tr => [tr.children[0].textContent.split(' (')[0], tr.children[1].textContent])));
    console.log(JSON.stringify(fig));
    ok(fig['Hallazgos de la IA'] === '3', 'Three live findings (the discarded one apart)');
    ok(fig['Acertados probables'] === '1' && fig['\u2026con la misma correcci\u00f3n que el revisor'] === '1', 'The Department: right, with the same correction as the reviser');
    ok(fig['Espurios probables'] === '2', 'Spurious: a word left as it was, and an omission in a paragraph changed only in form');
    ok(fig['Omitidos probables'] === '1', 'Missed: the change of words no live finding covers (zona -> region)');
    ok(fig['Descartados por el Verificador donde el revisor s\u00ed cambi\u00f3'] === '1', 'The Verifier threw away one where the reviser did change');
    ok(fig['Cambios del revisor solo de forma / solo de cifras'] === '2 / 0', 'The two commas added: form, not missed');
    await page.screenshot({ path: path.join(OUT, '1-dialog.png') });

    const summary = await page.evaluate(async () => {
      const { state } = await import('/app/js/state.js');
      const { parseDocument } = await import('/app/js/formats/parse.js');
      const c = await import('/app/js/review/compare.js');
      const r = await fetch('/tests/fixtures/names_es_final.docx');
      const model = await parseDocument(new File([await r.blob()], 'names_es_final.docx'));
      return c.compareSummary(c.compareWithFinal(state.session, state.findings, model), { project: 'x', unitN: (i) => state.session.units[i].n });
    });
    ok(/ESPURIOS PROBABLES/.test(summary) && /\u00ab envi\u00f3|\u00abenvi\u00f3\u00bb/.test(summary) && /OMITIDOS PROBABLES[\s\S]*\u00abzona\u00bb \u2192 \u00abregi\u00f3n\u00bb/.test(summary), 'The summary lists the spurious and the missed');

    const [xl] = await Promise.all([page.waitForEvent('download'), page.click('.modal-foot .btn:has-text("Descargar Excel")')]);
    ok(/_COMPARACION\.xlsx$/.test(xl.suggestedFilename()), 'The Excel downloads (' + xl.suggestedFilename() + ')');
    const [zipDl] = await Promise.all([page.waitForEvent('download'), page.click('.modal-foot .btn:has-text("Crear banco")')]);
    const zipPath = path.join(OUT, zipDl.suggestedFilename());
    await zipDl.saveAs(zipPath);
    const bench = await page.evaluate(async (b64) => {
      const { readBenchZip } = await import('/app/js/review/bench.js');
      const { parseDocument } = await import('/app/js/formats/parse.js');
      const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      const f = await readBenchZip(new File([bytes], 'b.zip'));
      const es = await parseDocument(f.tgt);
      return { n: f.spec.paragraphs.length, expected: f.spec.paragraphs.filter(p => p.expect.length).map(p => p.expect.map(e => e.keys.join('->')).join(';')),
        clean: f.spec.paragraphs.filter(p => !p.expect.length).length, paras: es.paras.filter(p => p.text.trim()).length };
    }, fs.readFileSync(zipPath).toString('base64'));
    console.log(JSON.stringify(bench));
    ok(bench.n === 3 && bench.clean === 1 && bench.paras === 3, 'The bench: the paragraphs changed in words and the untouched one (the one changed only in form left out)');
    ok(bench.expected.some(x => /Econom\u00eda y Asuntos->Asuntos Econ\u00f3micos y/.test(x)) && bench.expected.some(x => /zona->regi\u00f3n/.test(x)), 'Its expected errors are the reviser\'s changes');
    ok(errors.length === 0, 'No console errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  } finally {
    await browser.close();
    await srv.close();
  }
  console.log(failures ? '\nCOMPARE: ' + failures + ' FAILED' : '\nCOMPARE: ALL PASSED');
  process.exit(failures ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
