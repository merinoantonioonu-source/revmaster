#!/usr/bin/env node
/**
 * phase6.e2e.mjs - Deferred batches (-50 %), in Chromium with the mock provider (tests/mock-ai.mjs
 * imitates the four batch APIs).
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
const OUT = path.join(HERE, 'out', 'phase6');
const FIX = path.join(HERE, 'fixtures');
fs.mkdirSync(OUT, { recursive: true });

let failures = 0;
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) failures++; };

async function newApp(ctx, base) {
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(base + '/app/index.html');
  const guide = await page.waitForSelector('.modal', { timeout: 8000 }).catch(() => null);
  if (guide) await page.click('.modal-foot .btn');
  return { page, errors };
}

async function load(page, src, tgt) {
  for (const [sel, file] of [['#drop-src', src], ['#drop-tgt', tgt]]) {
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click(sel)]);
    await chooser.setFiles(path.join(FIX, file));
  }
  await page.waitForSelector('#view-mask.on .ent', { timeout: 20000 });
}

async function main() {
  const srv = await startServer({ port: 0 });
  const mock = await startMockAI(8790);
  const base = 'http://localhost:' + srv.port;
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } });
    let { page, errors } = await newApp(ctx, base);

    // ---- 1. The four batch adapters against the mock
    const adapters = await page.evaluate(async () => {
      const B = await import('/app/js/ai/batch.js');
      const profiles = [
        { id: 'pg', name: 'G', adapter: 'gemini', relayUrl: 'http://localhost:8790/v1beta', model: 'gemini-2.5-flash' },
        { id: 'pa', name: 'A', adapter: 'anthropic', relayUrl: 'http://localhost:8790/v1', model: 'claude-haiku-5-5' },
        { id: 'pm', name: 'M', adapter: 'mistral', baseUrl: 'http://localhost:8790/v1', model: 'mistral-small-latest' },
        { id: 'po', name: 'O', adapter: 'openai-compatible', baseUrl: 'http://localhost:8790/v1', batch: true, model: 'gpt-x' }
      ];
      const out = {};
      for (const p of profiles) {
        try {
          const job = await B.submitBatch(p, 'k', p.model, [{ key: 'g0b0', prompt: 'hola uno', system: 'S' }, { key: 's0', prompt: 'hola dos', system: 'S' }]);
          const first = await B.pollBatch(job, p, 'k');
          const second = await B.pollBatch(job, p, 'k');
          const res = await B.batchResults(job, p, 'k', second);
          out[p.adapter] = { kind: job.kind, first: first.state, second: second.state, keys: Array.from(res.keys()).sort().join(','),
            text: (res.get('g0b0') || {}).text, usage: !!(res.get('g0b0') || {}).usage };
        } catch (e) { out[p.adapter] = { error: e.message }; }
      }
      out.noBatch = B.batchKind({ adapter: 'openai-compatible', baseUrl: 'http://x' });
      return out;
    });
    for (const a of ['gemini', 'anthropic', 'mistral', 'openai-compatible']) {
      const r = adapters[a] || {};
      ok(!r.error && r.first === 'running' && r.second === 'done' && r.keys === 'g0b0,s0' && r.text === 'FIN 0' && r.usage,
        'Batch adapter ' + a + ': submit, poll, results (' + JSON.stringify(r) + ')');
    }
    ok(adapters.noBatch === null, 'An OpenAI-compatible profile without the flag has no batch mode');
    const claudeCreate = mock.state.log.find(l => l.kind === 'batch-create' && /messages\/batches/.test(l.path));
    ok(claudeCreate && claudeCreate.headers && claudeCreate.headers['anthropic-dangerous-direct-browser-access'] === 'true', 'Anthropic batch sends the browser access header');

    // ---- 2. A provider with the batch API (the mock) as the general model
    const emb = await page.evaluate(async () => {
      const reg = await import('/app/js/ai/registry.js');
      const p = await reg.saveProvider({ name: 'Simulador', adapter: 'openai-compatible', baseUrl: 'http://localhost:8790/v1', trust: 'external', batch: true,
        models: [{ id: 'mock-small', label: 'Simulado', price: { in: 1, cached: 0.5, out: 2 } }] });
      await reg.setApiKey(p.id, 'k');
      await reg.setGeneralModel({ provider: p.id, model: 'mock-small' });
      return { pid: p.id };
    });
    await load(page, 'e2e_en.docx', 'e2e_es.docx');
    await page.click('.step[data-view="review"]');
    await page.waitForSelector('#rv-modules .mchip');

    // ---- 4. Deferred mode through the UI, with a reload while the batch is running
    Object.assign(mock.state, { rules: [
      { match: 'P\u00c1RRAFOS DE LA TRADUCCI\u00d3N', response: '11 | GRA | MEN | y y | y | Palabra repetida.\nFIN 12' },
      { match: 'HALLAZGOS A VERIFICAR', response: 'H1 | OK |  | Correcto.\nFIN 1' }
    ], def: 'FIN 0' });
    // Only Redaccion, to keep it short.
    await page.evaluate(() => { document.querySelectorAll('#rv-modules .mchip input[type=checkbox]').forEach(c => { if (c.checked) c.click(); }); });
    await page.click('#rv-modules .mchip[data-mod="writing"] input[type=checkbox]');
    await page.click('#rv-run');
    await page.waitForSelector('.modal:has-text("Plan de ejecuci")', { timeout: 15000 });
    const defText = await page.textContent('.modal');
    ok(/Modo diferido/.test(defText) && !(await page.$('.modal input[type=checkbox][disabled]')), 'Plan offers the deferred mode');
    await page.screenshot({ path: path.join(OUT, '1-plan-deferred.png') });
    await page.click('.modal input[type=checkbox]');
    await page.click('.modal-foot .btn.amber');
    await page.waitForSelector('.toast:has-text("modo diferido")', { timeout: 15000 });
    const rec1 = await page.evaluate(async () => { const { state } = await import('/app/js/state.js'); return (state.project.deferred || []).map(r => ({ status: r.status, jobs: r.jobs.length })); });
    ok(rec1.length === 1 && rec1[0].status === 'running', 'Deferred job recorded in the project (' + JSON.stringify(rec1) + ')');
    await page.waitForTimeout(2500);   // the first automatic poll
    // Reload: the job must survive and finish.
    await page.reload();
    await page.waitForSelector('#view-mask.on .ent', { timeout: 20000 });
    await page.click('.step[data-view="review"]');
    await page.waitForSelector('#rv-modules .mcard:has-text("Lotes diferidos")', { timeout: 15000 });
    await page.screenshot({ path: path.join(OUT, '2-deferred-card.png') });
    for (let i = 0; i < 3; i++) {
      const btn = await page.$('#rv-modules .mcard:has-text("Lotes diferidos") button:has-text("Comprobar")');
      if (!btn) break;
      await btn.click();
      await page.waitForTimeout(1500);
    }
    const doneWin = await page.waitForSelector('.modal:has-text("Revisi\u00f3n diferida terminada")', { timeout: 20000 }).catch(() => null);
    ok(!!doneWin, 'The end of the deferred review is said in a window');
    if (doneWin) await page.click('.modal-foot .btn:has-text("Cerrar")');
    const fin = await page.evaluate(async () => {
      const { state } = await import('/app/js/state.js');
      const u = await import('/app/js/ai/usage.js');
      const rows = await u.readUsageRows();
      const batchRow = rows.find(r => /#batch$/.test(r.model));
      const price = batchRow ? await u.priceFor(batchRow.provider, batchRow.model) : null;
      return { status: (state.project.deferred || [])[0].status, findings: state.findings.filter(f => f.module === 'writing' && /y y/.test(f.quote || '')).length,
        batchRow: !!batchRow, price };
    });
    ok(fin.status === 'done' && fin.findings === 1, 'Deferred job finished after a reload and produced the finding (' + JSON.stringify(fin) + ')');
    ok(fin.batchRow && fin.price && fin.price.in === 0.5 && fin.price.out === 1, 'Batch usage recorded at half price');
    await page.screenshot({ path: path.join(OUT, '3-deferred-done.png') });
    ok(!errors.length, 'No console errors' + (errors.length ? ': ' + errors.slice(0, 4).join(' || ') : ''));
    await ctx.close();
  } catch (e) {
    console.error(e);
    failures++;
  } finally {
    await browser.close();
    await mock.close();
    await srv.close();
  }
  console.log(failures ? '\nPHASE6: ' + failures + ' FAILED' : '\nPHASE6: ALL PASSED');
  process.exit(failures ? 1 : 0);
}

main();
