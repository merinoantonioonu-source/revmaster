#!/usr/bin/env node
/**
 * bitext.e2e.mjs - A bitext in TXT (as COMeT's Editor exports it: UTF-8 with a BOM, one segment per line,
 * original, tab, translation), opened from either box of Archivos: the two sides at once, a project
 * named after the file, one paragraph per segment on each side and in the same order (a segment left
 * untranslated keeps its place), masked as any document, the type of document guessed from its symbol;
 * a file that is not a bitext is refused. All texts invented.
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
const OUT = path.join(HERE, 'out', 'bitext');
fs.mkdirSync(OUT, { recursive: true });

let failures = 0;
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) failures++; };

const PAIRS = [
  ['The Committee met on 3 March 2024.', 'La Comisi\u00f3n se reuni\u00f3 el 3 de marzo de 2024.'],
  ['The representative of Brazil welcomed the report of the Secretary-General.', 'El representante del Brasil acogi\u00f3 con beneplacito el informe del Secretario General.'],
  ['A segment not yet translated.', ''],
  ['The meeting rose at 1 p.m.', 'Se levanta la sesi\u00f3n a las 13.00 horas.']
];

async function main() {
  const srv = await startServer({ port: 0 });
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

    const txt = path.join(OUT, 'A_C.5_78_SR.12.txt');
    fs.writeFileSync(txt, '\ufeff' + PAIRS.map(p => p[0] + '\t' + p[1]).join('\r\n'));
    const bad = path.join(OUT, 'notas.txt');
    fs.writeFileSync(bad, 'Solo una nota.\nSin tabuladores.\n');

    // A file that is not a bitext: refused, no project.
    let [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#drop-tgt')]);
    await chooser.setFiles(bad);
    await page.waitForTimeout(800);
    ok(await page.evaluate(async () => { const { state } = await import('/app/js/state.js'); return !state.project; }), 'A text with no tabs is not taken for a bitext');

    [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#drop-src')]);
    await chooser.setFiles(txt);
    await page.waitForSelector('#view-mask.on', { timeout: 20000 });
    const s = await page.evaluate(async () => {
      const { state } = await import('/app/js/state.js');
      const t = (m) => m.paras.map(p => p.text);
      return { name: state.project.name, src: state.project.srcName, tgt: state.project.tgtName, from: state.project.fromBitext, docType: state.project.docType,
        srcParas: t(state.src), tgtParas: t(state.tgt), lang: state.project.srcLang, ents: (state.session && state.session.ent && state.session.ent.entities || []).length };
    });
    ok(s.name === 'A_C.5_78_SR.12' && s.from === 'A_C.5_78_SR.12.txt', 'One file, one project, named after it (' + s.name + ')');
    ok(s.src === 'A_C.5_78_SR.12 (original).docx' && s.tgt === 'A_C.5_78_SR.12.docx', 'Its two sides as documents (' + s.src + ' / ' + s.tgt + ')');
    ok(JSON.stringify(s.srcParas) === JSON.stringify(PAIRS.map(p => p[0])), 'The original: one paragraph per segment, in order');
    ok(JSON.stringify(s.tgtParas) === JSON.stringify(PAIRS.map(p => p[1])), 'The translation: the same, the untranslated segment kept in its place (empty)');
    ok(s.docType === 'sr' && s.lang === 'en', 'Type of document from the symbol in the name, language guessed (' + s.docType + ', ' + s.lang + ')');
    ok(s.ents > 0, 'Masked as any document (' + s.ents + ' entities)');
    const chip = await page.textContent('#projchip');
    ok(/A_C\.5_78_SR\.12/.test(chip), 'The header shows the project (' + chip.trim() + ')');
    await page.screenshot({ path: path.join(OUT, '1-mask.png') });
    ok(errors.length === 0, 'No errors in the page' + (errors.length ? ': ' + errors.join(' | ') : ''));
  } finally {
    await browser.close();
    srv.close();
  }
  console.log(failures ? failures + ' failure(s)' : 'All bitext checks passed');
  process.exit(failures ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
