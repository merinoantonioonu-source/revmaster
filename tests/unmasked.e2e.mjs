#!/usr/bin/env node
/**
 * unmasked.e2e.mjs - "Sin enmascarar" (a text already published), with the mock OpenAI-compatible
 * provider and the test bench's documents:
 *   - the gateway still refuses unmasked text unless the project says "Sin enmascarar";
 *   - a project starts masked: the review sends tags, never the real names;
 *   - the switch in Archivos asks first (Cancelar leaves it off), then marks the project: badge under
 *     its name, Enmascarar "No necesario", the warning in Revisar and in the plan;
 *   - with it, the review sends the real text, with no tags and no word about hidden data;
 *   - switched off, the text is masked again; a new project starts masked.
 * Screenshots go to tests/out/unmasked/. Exit code 1 on failure.
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
const OUT = path.join(HERE, 'out', 'unmasked');
fs.mkdirSync(OUT, { recursive: true });

let failures = 0;
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) failures++; };
const TAG = /\{[A-Z]+\d+\}/;

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

    // The gateway: unmasked text to an external provider only when the project says so.
    const gate = await page.evaluate(async () => {
      const g = await import('/app/js/ai/gateway.js');
      const out = [];
      for (const o of [{ masked: false }, { allowUnmasked: true }, { unmaskedProject: true }]) {
        try { await g.callAI(Object.assign({ module: 'meaning', prompt: 'Texto real.', system: 's' }, o)); out.push('sent'); } catch (e) { out.push(e.code); }
      }
      return out;
    });
    ok(JSON.stringify(gate) === JSON.stringify(['UNMASKED', 'UNMASKED', 'sent']), 'The gateway lets unmasked text out only for a project "Sin enmascarar" (' + gate.join(', ') + ')');

    // A project starts masked.
    await page.goto(base + '/app/index.html');
    await page.waitForSelector('#view-files.on');
    ok(await page.locator('#files-unmask').count() === 1 && !(await page.isChecked('#files-unmask-chk')), 'Archivos has the switch "Sin enmascarar", off');
    await page.evaluate(async () => {
      const { benchFiles } = await import('/app/js/review/bench.js');
      const { openFiles, emit } = await import('/app/js/state.js');
      const f = await benchFiles();
      await openFiles(f.src, f.tgt);
      emit('goto', 'review');
    });
    await page.waitForSelector('#rv-modules .mchip');
    const pick = async () => {
      await page.evaluate(() => { document.querySelectorAll('#rv-modules .mchip input[type=checkbox]').forEach(c => { if (c.checked) c.click(); }); });
      await page.click('#rv-modules .mchip[data-mod="meaning"] input[type=checkbox]');
    };
    const review = async (expectWarn) => {
      mock.state.log = [];
      await pick();
      await page.click('#rv-run');
      await page.waitForSelector('.modal:has-text("Plan de ejecuci")', { timeout: 15000 });
      const warned = await page.locator('.modal .note.warn:has-text("Sin enmascarar")').count() === 1;
      if (expectWarn) await page.screenshot({ path: path.join(OUT, '2-plan.png') });
      await page.click('.modal-foot .btn.amber');
      await page.waitForSelector('.modal:has-text("Revisi\u00f3n terminada")', { timeout: 60000 });
      await page.click('.modal-foot .btn:has-text("Cerrar")');
      await page.evaluate(() => document.querySelectorAll('.toast').forEach(t => t.remove()));
      return { warned, calls: mock.state.log.filter(l => l.kind === 'openai' && /\nO: /.test(l.prompt)) };
    };
    let r = await review(false);
    ok(r.calls.length > 0 && r.calls.every(c => TAG.test(c.prompt)) && !r.warned && /Datos ocultos/.test(r.calls[0].system),
      'Masked by default: the review sends tags and the instructions explain them (' + r.calls.length + ' calls)');
    const realName = await page.evaluate(async () => {
      const { state } = await import('/app/js/state.js');
      const e = state.session.ent.entities.find(x => x.cat === 'PAIS' && Object.keys(x.tgtForms).length);
      return e ? Object.keys(e.srcForms)[0] : '';
    });
    ok(!!realName && r.calls.every(c => !c.prompt.includes(realName)), 'A masked country (' + realName + ') does not travel');

    // The switch: asked first.
    await page.click('.step[data-view="files"]');
    await page.waitForSelector('#view-files.on');
    await page.click('#files-unmask-chk');
    await page.waitForSelector('.modal:has-text("Sin enmascarar")');
    ok(/textos ya publicados/.test(await page.textContent('.modal')), 'Switching it on asks, and says what goes out');
    await page.click('.modal-foot .btn:has-text("Cancelar")');
    await page.waitForTimeout(200);
    ok(!(await page.isChecked('#files-unmask-chk')) && !(await page.evaluate(async () => (await import('/app/js/state.js')).state.project.unmasked)), 'Cancelar leaves it off');
    await page.click('#files-unmask-chk');
    await page.waitForSelector('.modal:has-text("Sin enmascarar")');
    await page.click('.modal-foot .btn:has-text("Revisar sin enmascarar")');
    await page.waitForTimeout(300);
    ok(await page.isChecked('#files-unmask-chk') && await page.evaluate(async () => (await import('/app/js/state.js')).state.project.unmasked === true), 'Accepted: the project is "Sin enmascarar"');
    ok(await page.locator('#side-unmask:visible:has-text("Sin enmascarar")').count() === 1, 'The side bar says so under the project name');
    ok((await page.textContent('#st-mask')).includes('No necesario'), 'Enmascarar: "No necesario"');
    ok((await page.textContent('#files-next')).includes('revisar'), 'The next step from Archivos is Revisar');
    await page.screenshot({ path: path.join(OUT, '1-files.png') });

    // The review sends the real text.
    await page.click('.step[data-view="review"]');
    await page.waitForSelector('#rv-modules .mchip');
    ok(await page.locator('#rv-privacy.unmasked:has-text("Sin enmascarar")').count() === 1, 'Revisar warns that the text goes out as it is');
    r = await review(true);
    ok(r.warned, 'The plan repeats the warning before sending');
    ok(r.calls.length > 0 && r.calls.every(c => !TAG.test(c.prompt)) && r.calls.some(c => c.prompt.includes(realName)),
      'Sin enmascarar: the real text, no tags (' + realName + ' travels)');
    ok(r.calls.every(c => !/Datos ocultos|etiquetas tal cual/.test(c.system)) && /Prueba: \u00bfun lector/.test(r.calls[0].system), 'The instructions say nothing of hidden data, and keep the task');
    const findingsOk = await page.evaluate(async () => {
      const { state } = await import('/app/js/state.js');
      return state.session.units.every(u => u.tgtPara === null || state.session.masked.tgt.get(u.tgtPara).masked === state.session.tgt.paras[u.tgtPara].text);
    });
    ok(findingsOk, 'The texts the review works on are the real ones');

    // Off again: masked again. A new project starts masked.
    await page.click('.step[data-view="files"]');
    await page.click('#files-unmask-chk');
    await page.waitForTimeout(300);
    const back = await page.evaluate(async () => {
      const { state } = await import('/app/js/state.js');
      return { flag: state.project.unmasked, tags: [...state.session.masked.tgt.values()].some(m => /\{[A-Z]+\d+\}/.test(m.masked)) };
    });
    ok(back.flag === false && back.tags, 'Switched off: the text is masked again, with no question');
    ok(await page.locator('#side-unmask:visible').count() === 0, 'And the badge goes');
    await page.click('#files-unmask-chk');
    await page.click('.modal-foot .btn:has-text("Revisar sin enmascarar")');
    await page.waitForTimeout(200);
    await page.click('#view-files button:has-text("Nuevo proyecto")');
    await page.waitForTimeout(300);
    ok(!(await page.isChecked('#files-unmask-chk')), 'A new project starts masked');
    ok(errors.length === 0, 'No console errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  } finally {
    await browser.close();
    await mock.close();
    await srv.close();
  }
  console.log(failures ? '\nUNMASKED: ' + failures + ' FAILED' : '\nUNMASKED: ALL PASSED');
  process.exit(failures ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
