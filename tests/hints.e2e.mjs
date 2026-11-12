#!/usr/bin/env node
/**
 * hints.e2e.mjs - Redaccion's local hints (app/js/review/hints.js), off by default:
 *   - the detector: a word repeated close by (the English not repeating it) and nouns piled up in -cion
 *     (more than the English has in -tion); silent when the English does the same, on short sentences
 *     and without an original;
 *   - the request: with the hints on, only the paragraphs that have a suspicion come with a line under
 *     SOSPECHAS, the instructions say what it is, and the results cache tells the two apart; off, nothing
 *     is added anywhere;
 *   - Revisar: the "Pistas" switch is on Redaccion's card only, off by default, and it is saved.
 * Exit code 1 on failure.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { startServer } from '../tools/serve.mjs';
import { paragraphHints, sentencesOf } from '../app/js/review/hints.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const HERE = path.dirname(fileURLToPath(import.meta.url));
void HERE;

let failures = 0;
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) failures++; };

// 1. The detector.
const EN_CION = 'The Committee approved the report of the evaluation.';
const ES_CION = 'El Comit\u00e9 aprob\u00f3 la aprobaci\u00f3n del informe de la evaluaci\u00f3n de la aplicaci\u00f3n de las medidas de ejecuci\u00f3n del programa.';
ok(paragraphHints(EN_CION, ES_CION).length === 1 && /nombres en -ci\u00f3n/.test(paragraphHints(EN_CION, ES_CION)[0]), 'Four nouns in -cion against one in -tion: a hint');
ok(paragraphHints('The Council stressed that human rights and human rights defenders must be protected in all situations.',
  'El Consejo subray\u00f3 que los derechos humanos y los defensores de los derechos humanos deben ser protegidos en todas las situaciones.').length === 0,
  'A repetition the English has too ("human rights ... human rights"): silent');
const rep = paragraphHints('Participants discussed progress in the work and the way forward for the group in the coming years.',
  'Los participantes examinaron los progresos realizados en los trabajos y la evoluci\u00f3n de los trabajos futuros del grupo en los pr\u00f3ximos a\u00f1os.');
ok(rep.length === 1 && /repite \u00abtrabajos\u00bb a 6 palabras/.test(rep[0]), 'A word repeated within six words, the English not repeating it: a hint');
ok(paragraphHints('Short one here.', 'Una frase corta con trabajos y trabajos.').length === 0, 'Short sentences (under 10 words): silent');
ok(paragraphHints('', ES_CION).length === 0, 'Without an original nothing is flagged by comparison');
ok(paragraphHints('A b. C d.', '{ORG3} {ORG3} {ORG3} {ORG3}.').length === 0, 'Tags are not words');
ok(sentencesOf('Primera frase. Segunda frase. 3 de marzo.').length === 3, 'Sentences: the full stop plus a capital or a figure');
ok(paragraphHints(EN_CION + ' ' + EN_CION, ES_CION + ' ' + ES_CION).length === 1, 'At most one hint of each kind per paragraph');

// 2. The request and Revisar's card.
async function main() {
  const srv = await startServer({ port: 0 });
  const base = 'http://localhost:' + srv.port;
  const browser = await chromium.launch();
  try {
    const page = await (await browser.newContext({ viewport: { width: 1500, height: 900 } })).newPage();
    const errors = [];
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    await page.goto(base + '/app/index.html');
    await page.waitForSelector('.modal', { timeout: 15000 });
    await page.click('.modal-foot .btn');
    const r = await page.evaluate(async ([EN, ES]) => {
      const { buildBatchUser } = await import('/app/js/review/planner.js');
      const { systemPrompt, promptVersion, HINTS_LINE } = await import('/app/js/review/prompts.js');
      const { DEFAULTS } = await import('/app/js/review/module-config.js');
      const mk = (m) => ({ masked: { src: new Map([[0, { masked: EN }], [1, { masked: 'Fine.' }]]), tgt: new Map([[0, { masked: ES }], [1, { masked: 'Bien.' }]]) }, m });
      const s = mk();
      const units = [{ n: 1, srcPara: 0, tgtPara: 0 }, { n: 2, srcPara: 1, tgtPara: 1 }];
      const store = { map: {} };
      const cfg = {};
      return {
        off: buildBatchUser(s, units, 'target', false), on: buildBatchUser(s, units, 'target', true),
        sysOff: systemPrompt(store, ['writing'], 'en', cfg, {}), sysOn: systemPrompt(store, ['writing'], 'en', cfg, { hints: true }),
        sysMeaning: systemPrompt(store, ['meaning'], 'en', cfg, { hints: true }),
        pvOff: promptVersion(store, ['writing'], cfg, {}), pvOn: promptVersion(store, ['writing'], cfg, { hints: true }),
        line: HINTS_LINE, defHints: DEFAULTS.writing.hints
      };
    }, [EN_CION, ES_CION]);
    ok(!/SOSPECHAS/.test(r.off) && /\(FIN 2\)$/.test(r.off), 'Off: the batch is just the paragraphs');
    ok(/\nSOSPECHAS:\n\[1\] 4 nombres en -ci\u00f3n/.test(r.on) && !/\[2\] [0-9a-z]/.test(r.on.split('SOSPECHAS:')[1]) && /\(FIN 2\)$/.test(r.on), 'On: a line only for the paragraph that has a suspicion (paragraph 1, not 2)');
    ok(!/SOSPECHA/.test(r.sysOff) && r.sysOn.includes(r.line), 'The instructions say what a suspicion is only when the hints are on');
    ok(!r.sysMeaning.includes(r.line), 'Sentido never gets that line');
    ok(r.pvOff !== r.pvOn, 'The results cache tells with and without hints apart');
    ok(r.defHints === false, 'Off by default');

    await page.evaluate(async () => {
      const { benchFiles } = await import('/app/js/review/bench.js');
      const { openFiles, emit } = await import('/app/js/state.js');
      const f = await benchFiles();
      await openFiles(f.src, f.tgt);
      emit('goto', 'review');
    });
    await page.waitForSelector('#rv-modules .mchip');
    ok(await page.evaluate(() => [...document.querySelectorAll('#rv-modules .mchip input[data-hints]')].map(x => x.closest('.mchip').dataset.mod).join(',')) === 'writing', 'The "Pistas" switch is on Redaccion\'s card only');
    ok(await page.evaluate(() => document.querySelector('#rv-modules .mchip[data-mod="writing"] input[data-hints]').checked) === false, 'It starts off');
    await page.click('#rv-modules .mchip[data-mod="writing"] input[data-hints]');
    await page.waitForTimeout(400);
    ok(await page.evaluate(async () => (await (await import('/app/js/review/module-config.js')).loadModuleConfig()).writing.hints) === true, 'Switched on: saved in the module settings');
    ok(errors.length === 0, 'No page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  } finally {
    await browser.close();
    srv.close && srv.close();
  }
}

main().then(() => { console.log(failures ? failures + ' FAILED' : 'ALL OK'); process.exit(failures ? 1 : 0); }, e => { console.error(e); process.exit(1); });
