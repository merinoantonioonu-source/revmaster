#!/usr/bin/env node
/**
 * safety.e2e.mjs - Three protections of the masking (2026-11-20, ideas taken from Wordscope):
 *   - a person recognised once by a courtesy title is masked wherever the name appears alone (the full
 *     name and the surname), with the same tag on both sides; a surname that is also an ordinary word
 *     of the text (Long / long-term) is left alone;
 *   - the gateway's safety net: a real form of an entity left in a masked text is masked before it
 *     leaves (and the user is warned); not in the names table, not in a project "Sin enmascarar", not
 *     for an occurrence the translator chose to leave visible; also in the text for an external AI;
 *   - "Lo enviado a la IA": the record of every call, the paragraph of a finding as it was sent; and a
 *     quote that carries a tag the masked paragraph does not have is still anchored on the real text.
 * Builds its own DOCX pair; uses the mock OpenAI-compatible provider. Exit code 1 on failure.
 */

import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { startServer } from '../tools/serve.mjs';
import { startMockAI } from './mock-ai.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'out', 'safety');
fs.mkdirSync(OUT, { recursive: true });

let failures = 0;
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) failures++; };
const py = (code, ...args) => execFileSync('python3', ['-I', '-c', code, ...args], { encoding: 'utf-8' });

const EN = [
  'Report of the meeting',
  'Ms. Maria Ivanova presented the report of the Committee.',
  'Ivanova then answered the questions of the members.',
  'Maria Ivanova thanked the Committee.',
  'Mr. Long welcomed the long-term plan.',
  'Long negotiations followed.',
  'Droughts hit southern Africa and southern Mozambique.'
];
const ES = [
  'Informe de la reuni\u00f3n',
  'La Sra. Maria Ivanova present\u00f3 el informe del Comit\u00e9.',
  'Ivanova respondi\u00f3 despu\u00e9s a las preguntas de los miembros.',
  'Maria Ivanova dio las gracias al Comit\u00e9.',
  'El Sr. Long acogi\u00f3 con benepl\u00e1cito el plan a largo plazo.',
  'Siguieron largas negociaciones.',
  'Las sequ\u00edas azotaron \u00c1frica Meridional y el sur de Mozambique.'
];
const mk = (file, paras) => py('import docx,sys,json\nd=docx.Document()\nfor t in json.loads(sys.argv[2]): d.add_paragraph(t)\nd.save(sys.argv[1])', path.join(OUT, file), JSON.stringify(paras));
mk('safety_en.docx', EN);
mk('safety_es.docx', ES);

async function main() {
  const srv = await startServer({ port: 0 });
  const mock = await startMockAI(8790);
  const base = 'http://localhost:' + srv.port;
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
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
    });
    Object.assign(mock.state, { log: [], rules: [], def: 'FIN 0' });

    for (const [sel, file] of [['#drop-src', 'safety_en.docx'], ['#drop-tgt', 'safety_es.docx']]) {
      const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click(sel + ' .fn')]);
      await fc.setFiles(path.join(OUT, file));
    }
    await page.waitForSelector('#view-mask.on .ent', { timeout: 20000 });

    // 1) A person recognised once is masked wherever the name appears alone.
    const per = await page.evaluate(async () => {
      const { state } = await import('/app/js/state.js');
      const s = state.session;
      const e = s.ent.byKey.get('per:ivanova');
      const m = (side, i) => (side === 'src' ? s.masked.src : s.masked.tgt).get(i).masked;
      const long = s.ent.byKey.get('per:long');
      return { tag: e && e.tagSrc, src: e && e.srcCount, tgt: e && e.tgtCount, status: e && e.status,
        s2: m('src', 2), t2: m('tgt', 2), s3: m('src', 3), t3: m('tgt', 3), s5: m('src', 5), longSrc: long && long.srcCount };
    });
    ok(per.tag && per.src === 3 && per.tgt === 3 && per.status === 'ok', 'Ivanova: one person, three times on each side, no problem (' + JSON.stringify(per) + ')');
    ok(per.s2.startsWith(per.tag + ' then') && per.t2.startsWith(per.tag + ' respondi'), 'The surname alone is masked with the same tag in both languages (' + per.s2 + ' | ' + per.t2 + ')');
    ok(per.s3.startsWith(per.tag + ' thanked') && per.t3.startsWith(per.tag + ' dio') && !/Maria/.test(per.s3 + per.t3), 'The full name without a title is masked whole (' + per.s3 + ')');
    ok(per.s5 === 'Long negotiations followed.' && per.longSrc === 1, 'A surname that is also an ordinary word of the text (long-term) is not spread (' + per.s5 + ')');

    // A name of the lists written with a lowercase word ("southern Africa") is still that name, and pairs.
    const sa = await page.evaluate(async () => {
      const { state } = await import('/app/js/state.js');
      const e = state.session.ent.entities.find(x => Object.keys(x.srcForms).includes('southern Africa'));
      return e ? e.status + ':' + Object.keys(e.tgtForms).join('/') : 'none';
    });
    ok(sa === 'ok:\u00c1frica Meridional', '"southern Africa" is recognised as Southern Africa and pairs with \u00c1frica Meridional (' + sa + ')');
    // Right click on a tag > "Ampliar con <word before>": the dialog of a new entity with the wider text.
    await page.locator('#mask-src .tk', { hasText: /^PAIS/ }).last().click({ button: 'right' });
    await page.click('.menu .mi:has-text("Ampliar con \u00absouthern\u00bb")');
    await page.waitForSelector('.modal:has-text("Enmascarar selecci")');
    ok(/southern Mozambique/.test(await page.textContent('.modal')) && await page.$eval('.modal select.inp', x => x.value) === 'PAIS', 'Ampliar opens the dialog with the wider text and the same category');
    await page.click('.modal-foot .btn.primary');
    await page.waitForTimeout(400);
    const wide = await page.evaluate(async () => (await import('/app/js/state.js')).state.session.masked.src.get(6).masked);
    ok(/^Droughts hit \{LUGAR\d+\} and \{PAIS\d+\}\.$/.test(wide), 'After Ampliar, "southern Mozambique" is one tag (' + wide + ')');

    // 2) The safety net in the gateway.
    const net = await page.evaluate(async (tag) => {
      const g = await import('/app/js/ai/gateway.js');
      const lg = await import('/app/js/ai/leak-guard.js');
      const out = {};
      await g.callAI({ module: 'meaning', masked: true, prompt: '[2]\nO: Ivanova said it in 2024.\nT: ' + tag + ' lo dijo en 2024.\n(FIN 1)', system: 'S' });
      const last = lg.sentLog().slice(-1)[0];
      out.leaks = last.leaks;
      out.loggedPrompt = last.prompt;
      await g.callAI({ module: 'meaning', unmaskedProject: true, prompt: 'Ivanova (proyecto sin enmascarar)', system: 'S' });
      await g.callAINames({ module: 'names', rows: [{ n: 1, cat: 'ORG', src: 'Ivanova Foundation', tgt: 'Fundaci\u00f3n Ivanova' }], system: 'S' });
      return out;
    }, per.tag);
    const log = mock.state.log.filter(l => l.kind === 'openai');
    ok(log[0] && !/Ivanova/.test(log[0].prompt) && log[0].prompt.includes(per.tag + ' said it in 2024') && log[0].prompt.startsWith('[2]'),
      'A real name left in a masked text is masked before it leaves; numbers stay (' + (log[0] ? log[0].prompt.replace(/\n/g, ' / ') : '-') + ')');
    ok(net.leaks.length === 1 && net.leaks[0].form === 'Ivanova' && net.loggedPrompt === log[0].prompt, 'The record keeps what really left and what the net masked');
    await page.waitForSelector('.toast:has-text("Red de seguridad")', { timeout: 5000 });
    ok(true, 'The user is warned on screen');
    ok(log[1] && /Ivanova \(proyecto sin enmascarar\)/.test(log[1].prompt), 'Not in a project "Sin enmascarar"');
    ok(log[2] && /Ivanova Foundation/.test(log[2].prompt), 'Not in the names table (the owner\'s exception)');

    // An occurrence the translator chose to leave visible is respected; a quote with a tag the masked
    // paragraph lacks is anchored on the real text.
    const keep = await page.evaluate(async (tag) => {
      const { state, setMask } = await import('/app/js/state.js');
      const { guardText } = await import('/app/js/ai/leak-guard.js');
      const { anchorItem } = await import('/app/js/review/findings.js');
      const s = state.session;
      const o = s.ent.occ.tgt.get(3).find(x => x.key === 'per:ivanova');
      setMask({ removedOcc: ['tgt:3:' + o.start] });
      const masked = state.session.masked.tgt.get(3).masked;
      const g = guardText('Ivanova');
      const unitByN = new Map(state.session.units.map(u => [u.n, u]));
      const u = state.session.units.find(x => x.tgtPara === 3);
      const f = anchorItem({ unit: u.n, cat: 'MIST', sev: 'MAY', quote: tag + ' dio las gracias', suggestion: tag + ' agradeci\u00f3', reason: 'Prueba.' },
        { session: state.session, unitByN, module: 'meaning', source: 'ai', model: 'm' });
      const out = { masked, guarded: g.text, start: f.start, quote: f.quote, unanchored: !!f.unanchored };
      setMask({ removedOcc: [] });
      return out;
    }, per.tag);
    ok(/^Maria Ivanova dio/.test(keep.masked) && keep.guarded === 'Ivanova', 'An occurrence left visible on purpose is not masked by the net (' + keep.masked + ')');
    ok(keep.start === 0 && keep.quote === 'Maria Ivanova dio las gracias' && !keep.unanchored, 'A quote with a tag the paragraph lacks is found on the real text (' + JSON.stringify(keep) + ')');

    // The text for an external AI goes through the net too.
    await page.evaluate(async () => {
      const lg = await import('/app/js/ai/leak-guard.js');
      lg.setLeakGuard(lg.buildLeakGuard([{ key: 'x', cat: 'X', n: 9, tagSrc: '{X9}', srcForms: { negotiations: 1 }, tgtForms: {} }], { texts: [] }));
    });
    await page.click('#tools button:has-text("Exportar enmascarado")');
    await page.click('.menu .mi:has-text("Copiar para IA externa")');
    await page.waitForSelector('.modal:has-text("Copiar para IA externa")');
    const ext = await page.evaluate(() => ({ text: document.querySelector('.modal textarea').value, note: document.querySelector('.modal .note.warn:not(.hidden)') ? document.querySelector('.modal .note.warn').textContent : '' }));
    ok(!/negotiations/.test(ext.text) && /\{X9\}/.test(ext.text) && /Red de seguridad/.test(ext.note), 'The text for an external AI is masked by the net and says so (' + ext.note + ')');
    await page.keyboard.press('Escape');
    await page.evaluate(async () => (await import('/app/js/state.js')).remaskNow());

    // 3) "Lo enviado a la IA": a finding's paragraph as it was sent, and every call.
    const fid = await page.evaluate(async () => {
      const { state, addFindings } = await import('/app/js/state.js');
      const { buildBatchUser } = await import('/app/js/review/planner.js');
      const { callAI } = await import('/app/js/ai/gateway.js');
      const { anchorItem } = await import('/app/js/review/findings.js');
      const s = state.session;
      const u = s.units.find(x => x.tgtPara === 2);
      await callAI({ module: 'meaning', masked: true, prompt: buildBatchUser(s, [u], 'bilingual'), system: 'S' });
      const unitByN = new Map(s.units.map(x => [x.n, x]));
      const f = anchorItem({ unit: u.n, cat: 'MIST', sev: 'MAY', quote: 'respondi\u00f3 despu\u00e9s', suggestion: 'respondi\u00f3 luego', reason: 'Prueba.' },
        { session: s, unitByN, module: 'meaning', source: 'ai', model: 'mock-small' });
      addFindings([f]);
      return f.id;
    });
    await page.click('.step[data-view="correct"]');
    await page.waitForSelector('#rv-findings .cx-badge[data-id="' + fid + '"]');
    await page.click('#rv-findings .cx-badge[data-id="' + fid + '"]');
    await page.click('#cx-sent');
    await page.waitForSelector('.modal:has-text("Lo enviado a la IA")');
    const sent = await page.textContent('.modal');
    ok(/tal como sali/.test(sent) && sent.includes(per.tag.replace(/[{}]/g, '') + ' then answered') && !/Ivanova/.test(sent),
      'Ver lo enviado shows the paragraph exactly as it left, with its tags (' + sent.replace(/\s+/g, ' ').slice(0, 160) + ')');
    await page.screenshot({ path: path.join(OUT, '1-sent-finding.png') });
    await page.click('.modal-foot .btn:has-text("Todas las llamadas")');
    await page.waitForSelector('.modal .sentlist');
    const calls = await page.locator('.modal .sentlist > details').count();
    ok(calls >= 4 && await page.locator('.modal .sentlist .pill.warn:has-text("Red de seguridad")').count() >= 1,
      'Every call is listed, and the one the net acted on is marked (' + calls + ' calls)');
    await page.locator('.modal .sentlist > details').first().locator('summary').click();
    await page.waitForSelector('.modal .sentlist > details[open] .sentbox', { timeout: 3000 }).catch(() => null);
    ok(await page.locator('.modal .sentlist > details[open] .sentbox .tk').count() >= 1, 'A call opens to its text, with the tags in colour');
    await page.screenshot({ path: path.join(OUT, '2-sent-all.png') });
    await page.keyboard.press('Escape');

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
  console.log(failures ? '\nSAFETY: ' + failures + ' FAILED' : '\nSAFETY: ALL PASSED');
  process.exit(failures ? 1 : 0);
}

main();
