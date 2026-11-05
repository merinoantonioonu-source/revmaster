#!/usr/bin/env node
/**
 * help.e2e.mjs - The contextual help ("?" buttons, menu items and F1):
 *   - every topic named in the code exists, and every topic is used somewhere;
 *   - every "?" of every screen and settings section opens its explanation, inside the window;
 *   - the "?" of a drop zone does not open the file chooser;
 *   - inside a dialog, the help shows above it and Escape closes only the help;
 *   - menus offer "Que hace cada opcion"; F1 opens the help of the current screen.
 * Screenshots go to tests/out/help/. Exit code 1 on failure.
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { startServer } from '../tools/serve.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const OUT = path.join(HERE, 'out', 'help');
const FIX = path.join(HERE, 'fixtures');
fs.mkdirSync(OUT, { recursive: true });

let failures = 0;
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) failures++; };

// ------------------------------------------------------------------ static: topics used vs defined
function jsFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...jsFiles(p)); else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}
const used = new Set();
for (const f of jsFiles(path.join(ROOT, 'app', 'js'))) {
  const src = fs.readFileSync(f, 'utf-8');
  for (const m of src.matchAll(/help(?:Btn|Item)\('([a-z0-9-]+)'\s*[,)]/g)) used.add(m[1]);
  for (const m of src.matchAll(/showHelp\(\s*'([a-z0-9-]+)'/g)) used.add(m[1]);
}

async function main() {
  const srv = await startServer({ port: 0 });
  const base = 'http://localhost:' + srv.port;
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 860 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    await page.goto(base + '/app/index.html');
    await page.waitForSelector('.modal', { timeout: 15000 });   // the guide on first run
    await page.click('.modal-foot .btn');
    await page.evaluate(async () => { const mc = await import('/app/js/review/module-config.js'); await mc.saveModuleConfig('local', { semantic: 'off' }); });

    const topics = await page.evaluate(async () => {
      const h = await import('/app/js/ui/help.js');
      return { all: Object.keys(h.HELP_TOPICS), empty: Object.keys(h.HELP_TOPICS).filter(k => !h.HELP_TOPICS[k].t || !h.HELP_TOPICS[k].b.length) };
    });
    const defined = new Set(topics.all);
    const missing = [...used].filter(t => !defined.has(t));
    ok(!missing.length, 'Every topic used in the code exists (' + (missing.join(', ') || used.size + ' topics') + ')');
    const orphans = topics.all.filter(t => !used.has(t));
    ok(!orphans.length, 'Every topic is reachable from the app (' + (orphans.join(', ') || 'none left over') + ')');
    ok(!topics.empty.length, 'No topic is empty (' + topics.empty.join(', ') + ')');

    // Checks the popover that a click opened.
    const checkPop = async (label, topic) => {
      const pop = page.locator('.help-pop');
      await pop.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
      const info = await page.evaluate(() => {
        const p = document.querySelector('.help-pop');
        if (!p) return null;
        const r = p.getBoundingClientRect();
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + 20);
        return { topic: p.dataset.topic, title: p.querySelector('.hh').textContent, len: p.querySelector('.hb').textContent.length,
          inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, onTop: !!(top && p.contains(top)) };
      });
      ok(!!info && (!topic || info.topic === topic) && info.len > 40 && info.inside && info.onTop,
        label + ' -> ' + (info ? info.topic + ' "' + info.title.replace(/\s+/g, ' ').trim() + '", ' + info.len + ' car.' + (info.inside ? '' : ', FUERA DE LA VENTANA') + (info.onTop ? '' : ', TAPADA') : 'sin ayuda'));
      return info;
    };
    const closePop = async () => { await page.keyboard.press('Escape'); await page.waitForTimeout(80); };
    // Clicks every "?" inside `scope` and checks each explanation.
    const sweep = async (scope, label) => {
      const btns = page.locator(scope + ' .help-btn:visible');
      const n = await btns.count();
      const seen = [];
      for (let i = 0; i < n; i++) {
        const b = btns.nth(i);
        const topic = await b.getAttribute('data-help');
        await b.scrollIntoViewIfNeeded();
        await b.click();
        await checkPop(label + ' ? ' + topic, topic);
        seen.push(topic);
        await closePop();
      }
      return seen;
    };

    // Welcome: the "?" of a drop zone explains, without opening the file chooser.
    let chooser = false;
    page.on('filechooser', () => { chooser = true; });
    await page.click('#drop-src .help-btn');
    await checkPop('Drop zone', 'files');
    await page.screenshot({ path: path.join(OUT, '1-drop.png') });
    ok(!chooser, 'The "?" of a drop zone does not open the file chooser');
    await closePop();
    ok(await page.locator('.help-pop').count() === 0, 'Escape closes the help');
    await page.keyboard.press('F1');
    await checkPop('F1 on the welcome screen', 'files');
    await closePop();

    // Load a document pair.
    page.removeAllListeners('filechooser');
    for (const [sel, file] of [['#drop-src', 'doc_en.docx'], ['#drop-tgt', 'doc_es.docx']]) {
      const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click(sel + ' .fn')]);
      await fc.setFiles(path.join(FIX, file));
    }
    await page.waitForSelector('#view-mask.on .ent', { timeout: 20000 });

    // Step 1
    const maskSeen = await sweep('#topbar', 'Mask bar');
    maskSeen.push(...await sweep('#view-mask', 'Mask view'));
    ok(['mask-tools', 'entities', 'sheets'].every(t => maskSeen.includes(t)), 'Step 1 has its "?" (' + maskSeen.join(', ') + ')');
    await page.click('#tools button:has-text("Exportar enmascarado")');
    await page.click('.menu .mi.help');
    await checkPop('Menu "Exportar enmascarado"', 'mask-export');
    await page.screenshot({ path: path.join(OUT, '2-menu.png') });
    await closePop();
    await page.keyboard.press('F1');
    await checkPop('F1 in step 1', 'mask-tools');
    await closePop();
    // Help inside a dialog: above it, and Escape closes only the help.
    await page.evaluate(() => {
      const p = document.querySelector('#mask-tgt .p');
      const w = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = w.nextNode())) if (node.textContent.trim().length > 6) {
        const i = node.textContent.search(/\S/);
        const r = document.createRange(); r.setStart(node, i); r.setEnd(node, i + 5);
        const s = getSelection(); s.removeAllRanges(); s.addRange(r); return;
      }
    });
    await page.keyboard.press('Alt+e');
    await page.waitForSelector('.modal:has-text("Enmascarar selecci")');
    await page.click('.modal-head .help-btn');
    await checkPop('Dialog "Enmascarar seleccion"', 'mask-selection');
    await page.screenshot({ path: path.join(OUT, '3-dialog.png') });
    await closePop();
    ok(await page.locator('.help-pop').count() === 0 && await page.locator('.modal').count() === 1, 'Escape closes the help but not the dialog');
    await page.keyboard.press('F1');
    await checkPop('F1 inside a dialog', 'mask-selection');
    await closePop();
    await page.click('.modal-foot .btn:has-text("Cancelar")');

    // Step 2
    await page.click('.step[data-view="review"]');
    await page.waitForSelector('#rv-modules .mchip');
    await page.waitForTimeout(400);
    const revSeen = await sweep('#topbar', 'Review bar');
    revSeen.push(...await sweep('#view-review', 'Review view'));
    ok(['review-tools', 'findings', 'review-sheets', 'modules'].every(t => revSeen.includes(t)), 'Step 2 has its "?" (' + revSeen.join(', ') + ')');
    await page.locator('#rv-modules .help-btn[data-help="modules"]').click();
    await page.screenshot({ path: path.join(OUT, '4-module.png') });
    await closePop();
    for (const [btn, topic] of [['M\u00e1s', 'review-more'], ['Exportar', 'review-export']]) {
      await page.click('#tools button:has-text("' + btn + '")');
      await page.click('.menu .mi.help');
      await checkPop('Menu "' + btn + '"', topic);
      await closePop();
    }

    // Step 3: every section
    await page.click('.step[data-view="settings"]');
    const secs = await page.$$eval('.settings-nav button', bs => bs.map(b => b.dataset.sec));
    for (const sec of secs) {
      await page.click('.settings-nav button[data-sec="' + sec + '"]');
      await page.waitForTimeout(500);
      const seen = await sweep('#view-settings .settings-body', 'Settings ' + sec);
      ok(seen.length > 0, 'Settings section "' + sec + '" has help (' + seen.join(', ') + ')');
      if (sec === 'modules') { await page.locator('#view-settings .help-btn[data-help="module-settings"]').click(); await page.screenshot({ path: path.join(OUT, '5-settings.png') }); await closePop(); }
    }
    await page.click('.settings-nav button[data-sec="providers"]');
    await page.waitForTimeout(400);
    await page.click('.pcard.add');
    await page.waitForSelector('.modal');
    await page.click('.modal-head .help-btn');
    await checkPop('Dialog "Anadir proveedor"', 'provider-edit');
    await closePop();
    await page.keyboard.press('Escape');
    await page.keyboard.press('F1');
    await checkPop('F1 in settings', null);
    await closePop();

    ok(!errors.length, 'No console errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
    await ctx.close();
  } finally {
    await browser.close();
    await srv.close();
  }
  console.log(failures ? '\nHELP: ' + failures + ' FAILED' : '\nHELP: ALL PASSED');
  process.exit(failures ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
