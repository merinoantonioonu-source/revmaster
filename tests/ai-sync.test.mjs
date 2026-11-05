#!/usr/bin/env node
/**
 * ai-sync.test.mjs - Tests of the AI layer (providers, registry, gateway, usage) and of the sync file
 * (merge rules, refusal of a COMeT file, encrypted keys, write/read through a real file handle of
 * the browser's private file system), plus screenshots of the three settings screens.
 *
 *   node tests/ai-sync.test.mjs
 *
 * Starts a static server (tools/serve.mjs when present) and the mock provider (tests/mock-ai.mjs),
 * drives Chromium with Playwright and exits non-zero on any failure. Screenshots go to tests/out/.
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startMockAI } from './mock-ai.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.join(HERE, 'out');

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
  console.log((cond ? 'ok   ' : 'FAIL ') + name + (cond || detail === undefined ? '' : '  -> ' + JSON.stringify(detail).slice(0, 400)));
}

async function loadPlaywright() {
  try { return await import('playwright'); } catch (_) {}
  const require = createRequire(import.meta.url);
  const cands = [];
  try { cands.push(path.join(execSync('npm root -g', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(), 'playwright')); } catch (_) {}
  cands.push('/opt/node22/lib/node_modules/playwright', '/usr/local/lib/node_modules/playwright', '/usr/lib/node_modules/playwright');
  for (const c of cands) { try { return require(c); } catch (_) {} }
  throw new Error('Playwright not found');
}

async function startStatic() {
  const serveFile = path.join(ROOT, 'tools', 'serve.mjs');
  if (fs.existsSync(serveFile)) {
    try {
      const mod = await import(pathToFileURL(serveFile).href);
      if (typeof mod.startServer === 'function') {
        const s = await mod.startServer({ root: ROOT, port: 0 });
        return { port: s.port, host: '127.0.0.1', close: s.close };
      }
    } catch (_) { /* fall back to our own */ }
  }
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = path.resolve(ROOT, '.' + rel);
    if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(data);
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, host: '127.0.0.1', close: () => new Promise(r => server.close(r)) };
}

async function freePort() {
  const s = http.createServer();
  await new Promise(r => s.listen(0, r));
  const p = s.address().port;
  await new Promise(r => s.close(r));
  return p;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const web = await startStatic();
  let mock;
  try { mock = await startMockAI(8790); } catch (_) { mock = await startMockAI(0); }
  const closedPort = await freePort();
  const MOCK = 'http://localhost:' + mock.port + '/v1';
  const CLOSED = 'http://localhost:' + closedPort + '/v1';
  const pw = await loadPlaywright();
  const chromium = pw.chromium || (pw.default && pw.default.chromium);
  // A PERSISTENT profile: in an incognito context Chromium crashes when a file handle is read back
  // from IndexedDB (which is how the sync file is remembered).
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-pw-'));
  const context = await chromium.launchPersistentContext(userDir, { viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, acceptDownloads: true });
  const page = context.pages()[0] || await context.newPage();
  const errors = [];
  const ignore = (t) => /Failed to load resource|net::ERR_|status of 4\d\d|status of 5\d\d/.test(t);
  page.on('console', (m) => { if (m.type() === 'error' && !ignore(m.text())) errors.push('console: ' + m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + (e && e.message)));
  const url = 'http://' + web.host + ':' + web.port + '/tests/ai-harness.html';

  try {
    await page.goto(url);
    await page.waitForFunction(() => window.H_READY === true, null, { timeout: 15000 });
    await page.evaluate(async () => {
      localStorage.clear(); sessionStorage.clear();
      for (const s of window.H.idb.STORES) { try { await window.H.idb.idbClear(s); } catch (_) {} }
    });
    await page.reload();
    await page.waitForFunction(() => window.H_READY === true);

    // ---------------------------------------------------------------- registry
    const seed = await page.evaluate(async () => {
      const list = await H.registry.listProviders();
      const raw = await H.getValue('providers', null);
      return { ids: list.map(p => p.id), adapters: list.map(p => p.adapter), updatedAt: raw && raw.updatedAt,
        anthropic: (list.find(p => p.id === 'anthropic') || {}).models, gemini: (list.find(p => p.id === 'gemini') || {}).models };
    });
    check('registry seeds the four built-in providers', JSON.stringify(seed.ids) === JSON.stringify(['gemini', 'mistral', 'azure', 'anthropic']), seed.ids);
    check('no OpenAI-compatible profile by default', !seed.adapters.includes('openai-compatible'), seed.adapters);
    check('seed is stamped updatedAt 0 (never beats a synced config)', seed.updatedAt === 0, seed.updatedAt);
    check('Anthropic models seeded', (seed.anthropic || []).map(m => m.id).join(',') === 'claude-sonnet-5-5,claude-haiku-5-5,claude-opus-5-5', seed.anthropic);
    check('Gemini list includes gemini-2.5-pro', (seed.gemini || []).some(m => m.id === 'gemini-2.5-pro'), seed.gemini);

    const nop = await page.evaluate(async () => {
      try { await H.registry.resolveClient('grammar', 'triage'); return 'no error'; } catch (e) { return e.code; }
    });
    check('resolveClient without any key throws NO_PROVIDER', nop === 'NO_PROVIDER', nop);

    const prof = await page.evaluate(async (MOCK) => {
      const p = await H.registry.saveProvider({ name: 'Mock', adapter: 'openai-compatible', baseUrl: MOCK, trust: 'external',
        models: [{ id: 'mock-model', label: 'Mock model' }] });
      await H.registry.setApiKey(p.id, 'sk-test-123');
      await H.registry.setModelPrice(p.id, 'mock-model', { in: 1, cached: 0.5, out: 2 });
      await H.registry.setModuleModel('grammar', 'triage', { provider: p.id, model: 'mock-model' });
      const r1 = await H.registry.resolveClient('grammar', 'triage');
      const r2 = await H.registry.resolveClient('fidelity', 'deep');
      const inProfile = JSON.stringify(await H.getValue('providers', null)).includes('sk-test-123');
      return { id: p.id, r1: { pid: r1.providerId, mid: r1.modelId, fb: r1.fallback, src: r1.source, trust: r1.trust },
        r2: { pid: r2.providerId, src: r2.source, fb: r2.fallback }, inProfile };
    }, MOCK);
    check('saveProvider gives a new profile an id', /^p_/.test(prof.id), prof.id);
    check('API key never stored inside the profile', prof.inProfile === false);
    check('resolveClient uses the module choice', prof.r1.pid === prof.id && prof.r1.mid === 'mock-model' && !prof.r1.fb && prof.r1.src === 'module', prof.r1);
    check('resolveClient falls to the first provider with a key', prof.r2.pid === prof.id && prof.r2.src === 'first' && prof.r2.fb === false, prof.r2);

    // ---------------------------------------------------------------- gateway + usage
    await fetch('http://localhost:' + mock.port + '/__reset', { method: 'POST' });
    await fetch('http://localhost:' + mock.port + '/__script', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rules: [{ match: 'HOLA', response: '1 | ORT | MEN | x | y | z\nFIN 1' },
        { match: 'CORTA', response: 'medio', finish_reason: 'length' }, { match: 'LIMITE', response: '', status: 429 }], default: 'FIN 0' }) });
    const call = await page.evaluate(async () => {
      const r = await H.gateway.callAI({ module: 'grammar', role: 'triage', prompt: 'HOLA {la ORGANO1} mundo', system: 'Eres un revisor.',
        masked: true, project: 'A/78/100', file: 'doc.docx', words: 3 });
      const rows = await H.usage.readUsageRows();
      return { text: r.text, usage: r.usage, cost: r.cost, pid: r.providerId, rows, session: H.usage.getSessionTotals() };
    });
    check('callAI returns the mock text', call.text === '1 | ORT | MEN | x | y | z\nFIN 1', call.text);
    check('callAI reports usage', call.usage && call.usage.input > 0 && call.usage.output > 0, call.usage);
    check('callAI computes the cost from the profile price', typeof call.cost === 'number' && call.cost > 0, call.cost);
    check('usage recorded: one row with one call', call.rows.length === 1 && call.rows[0].calls === 1 && call.rows[0].module === 'grammar' &&
      call.rows[0].project === 'A/78/100' && call.rows[0].file === 'doc.docx' && call.rows[0].words === 3, call.rows);
    check('session meter counts the call', call.session.calls === 1 && call.session.tokens > 0, call.session);
    let log = await (await fetch('http://localhost:' + mock.port + '/__log')).json();
    check('mock received model, system, prompt and the key', log.length === 1 && log[0].model === 'mock-model' && log[0].system === 'Eres un revisor.' &&
      log[0].prompt.startsWith('HOLA') && log[0].auth === 'Bearer sk-test-123', log);
    check('default temperature 0.2 is sent', log[0] && log[0].body.temperature === 0.2, log[0] && log[0].body);

    const unm = await page.evaluate(async () => {
      const out = {};
      try { await H.gateway.callAI({ module: 'grammar', prompt: 'HOLA texto sin enmascarar', masked: false }); out.a = 'no error'; } catch (e) { out.a = e.code; out.msg = e.message; }
      try { await H.gateway.callAI({ module: 'grammar', prompt: 'HOLA', masked: false, allowUnmasked: true }); out.b = 'no error'; } catch (e) { out.b = e.code; }
      return out;
    });
    log = await (await fetch('http://localhost:' + mock.port + '/__log')).json();
    check('callAI with masked:false throws UNMASKED', unm.a === 'UNMASKED' && /enmascarado/.test(unm.msg || ''), unm);
    check('allowUnmasked with an EXTERNAL provider still throws UNMASKED', unm.b === 'UNMASKED', unm);
    check('nothing unmasked reached the provider', log.length === 1, log.length);

    const local = await page.evaluate(async (id) => {
      const p = await H.registry.getProvider(id);
      await H.registry.saveProvider(Object.assign({}, p, { trust: 'local' }));
      let out;
      try { const r = await H.gateway.callAI({ module: 'grammar', prompt: 'HOLA local', masked: false, allowUnmasked: true }); out = r.text; } catch (e) { out = e.code; }
      await H.registry.saveProvider(Object.assign({}, p, { trust: 'external' }));
      return out;
    }, prof.id);
    check('allowUnmasked with a LOCAL provider goes through', /FIN 1/.test(local), local);

    const errs = await page.evaluate(async () => {
      const out = {};
      try { await H.gateway.callAI({ module: 'grammar', prompt: 'CORTA', masked: true }); out.trunc = 'no error'; } catch (e) { out.trunc = e.code; out.partial = e.partial; }
      try { await H.gateway.callAI({ module: 'grammar', prompt: 'LIMITE', masked: true }); out.rate = 'no error'; } catch (e) { out.rate = e.code; }
      out.calls = (await H.usage.readUsageRows()).reduce((s, r) => s + r.calls, 0);
      return out;
    });
    check('finish_reason length -> TRUNCATED with the partial text', errs.trunc === 'TRUNCATED' && errs.partial === 'medio', errs);
    check('HTTP 429 -> HTTP_429', errs.rate === 'HTTP_429', errs);
    check('a truncated call is still recorded (3 calls so far)', errs.calls === 3, errs.calls);

    const fb = await page.evaluate(async (id) => {
      await H.registry.setModuleModel('style', 'triage', { provider: 'gemini', model: 'gemini-2.5-flash' });
      const r = await H.registry.resolveClient('style', 'triage');
      return { pid: r.providerId, fb: r.fallback, wanted: r.wanted };
    }, prof.id);
    check('a choice without key falls back (fallback flag + wanted)', fb.pid === prof.id && fb.fb === true && fb.wanted && fb.wanted.provider === 'gemini', fb);

    const tc = await page.evaluate(async ([id, CLOSED]) => {
      const p = await H.registry.getProvider(id);
      const ok = await H.providers.testConnection(p, 'mock-model', 'sk-test-123');
      const bad = await H.providers.testConnection(Object.assign({}, p, { baseUrl: CLOSED }), 'mock-model', 'sk-test-123');
      let direct;
      try { await H.providers.createClient(Object.assign({}, p, { baseUrl: CLOSED }), 'mock-model', 'k').complete('x', ''); direct = 'no error'; }
      catch (e) { direct = e.code + ' | ' + e.message; }
      const nokey = await H.providers.testConnection(p, 'mock-model', '');
      return { ok, bad, direct, nokey };
    }, [prof.id, CLOSED]);
    check('testConnection ok against the mock', tc.ok.ok === true, tc.ok);
    check('testConnection against a closed port -> NETWORK (not CORS)', tc.bad.ok === false && tc.bad.code === 'NETWORK' && tc.bad.cors === false, tc.bad);
    check('a call to a closed port -> NETWORK with the CORS hint', /^NETWORK \| .*CORS.*Probar conexi/.test(tc.direct), tc.direct);
    check('testConnection without key -> NO_KEY', tc.nokey.code === 'NO_KEY', tc.nokey);

    // The other adapters, through relayUrl pointed at the mock: request shape, headers, usage.
    await fetch('http://localhost:' + mock.port + '/__reset', { method: 'POST' });
    const ad = await page.evaluate(async (BASE) => {
      const out = {};
      const run = async (name, profile, model, key) => {
        let usage = null, text;
        try { text = await H.providers.createClient(profile, model, key).complete('HOLA adaptador', 'Sistema', { temperature: 0.2, thinking: 'minimal', onUsage: (u) => { usage = u; } }); }
        catch (e) { text = 'ERR ' + e.code + ' ' + e.message; }
        out[name] = { text, usage };
      };
      await run('gemini', { id: 'gemini', name: 'G', adapter: 'gemini', relayUrl: BASE + '/v1beta' }, 'gemini-2.5-flash', 'g-key');
      await run('gemini3', { id: 'gemini', name: 'G', adapter: 'gemini', relayUrl: BASE + '/v1beta' }, 'gemini-3.6-flash', 'g-key');
      await run('anthropic', { id: 'anthropic', name: 'A', adapter: 'anthropic', relayUrl: BASE + '/v1' }, 'claude-sonnet-5-5', 'a-key');
      await run('mistral', { id: 'mistral', name: 'M', adapter: 'mistral', relayUrl: BASE + '/v1' }, 'mistral-small-latest', 'm-key');
      await run('azure', { id: 'azure', name: 'Az', adapter: 'azure-openai', baseUrl: BASE, deployment: 'dep1', apiVersion: '2024-06-01' }, '', 'az-key');
      await run('relay', { id: 'x', name: 'R', adapter: 'openai-compatible', baseUrl: 'http://localhost:1/v1', relayUrl: BASE + '/v1' }, 'mock-model', 'r-key');
      return out;
    }, 'http://localhost:' + mock.port);
    const alog = await (await fetch('http://localhost:' + mock.port + '/__log')).json();
    const L = (i) => alog[i] || {};
    check('Gemini adapter: answer, usage with thoughts, key header, thinking budget 0 + temperature on 2.5',
      ad.gemini.text === 'FIN 0' && ad.gemini.usage && ad.gemini.usage.thoughts === 3 && L(0).kind === 'gemini' && L(0).headers['x-goog-api-key'] === 'g-key' &&
      L(0).body.generationConfig.thinkingConfig.thinkingBudget === 0 && L(0).body.generationConfig.temperature === 0.2 && L(0).system === 'Sistema', { ad: ad.gemini, log: L(0) });
    check('Gemini 3.6: thinkingLevel and no temperature', L(1).body.generationConfig && L(1).body.generationConfig.thinkingConfig.thinkingLevel === 'minimal' &&
      L(1).body.generationConfig.temperature === undefined, L(1).body);
    check('Anthropic adapter: headers, system, effort, no temperature, usage incl. cache reads',
      ad.anthropic.text === 'FIN 0' && L(2).kind === 'anthropic' && L(2).headers['x-api-key'] === 'a-key' && L(2).headers['anthropic-version'] === '2023-06-01' &&
      L(2).headers['anthropic-dangerous-direct-browser-access'] === 'true' && L(2).body.system === 'Sistema' && L(2).body.temperature === undefined &&
      L(2).body.output_config && L(2).body.output_config.effort === 'low' && L(2).body.max_tokens === 8192 &&
      !!ad.anthropic.usage && ad.anthropic.usage.cached === 2 && ad.anthropic.usage.input > 2,
      { ad: ad.anthropic, log: L(2) });
    check('Mistral adapter: chat completions with Bearer key', ad.mistral.text === 'FIN 0' && L(3).auth === 'Bearer m-key' && L(3).model === 'mistral-small-latest', L(3));
    check('Azure adapter: deployment path, api-version, api-key header', ad.azure.text === 'FIN 0' &&
      /\/openai\/deployments\/dep1\/chat\/completions\?api-version=2024-06-01$/.test(L(4).path || '') && L(4).headers['api-key'] === 'az-key', L(4));
    check('relayUrl replaces the base URL', ad.relay.text === 'FIN 0' && L(5).auth === 'Bearer r-key', { ad: ad.relay, log: L(5) });

    const rules = await page.evaluate(() => {
      const I = H.providers._internals;
      return {
        g36: I._geminiTakesTemperature('gemini-3.6-flash'), g25: I._geminiTakesTemperature('gemini-2.5-flash'),
        th25: I._geminiThinking('gemini-2.5-flash', 'minimal'), th3: I._geminiThinking('gemini-3.6-flash', 'low'),
        c55: I._claudeTakesTemperature('claude-sonnet-5-5'), c46: I._claudeTakesTemperature('claude-sonnet-4-6'),
        e55: I._claudeEffort('claude-opus-5-5', 'minimal'), e45h: I._claudeEffort('claude-haiku-4-5', 'low')
      };
    });
    check('Gemini temperature/thinking rules kept from COMeT', rules.g36 === false && rules.g25 === true &&
      rules.th25 && rules.th25.thinkingBudget === 0 && rules.th3 && rules.th3.thinkingLevel === 'low', rules);
    check('Claude: no temperature on 5.x, effort mapping', rules.c55 === false && rules.c46 === true && rules.e55 === 'low' && rules.e45h === null, rules);

    // ---------------------------------------------------------------- sync: pure merges
    const merges = await page.evaluate(() => {
      const S = H.syncSpec;
      const now = Date.now();
      const newest = S.mergeValue('providers', { updatedAt: 1, v: 'a' }, { updatedAt: 2, v: 'b' }, 'a').v;
      const tie = S.mergeValue('prefs', { updatedAt: 5, v: 'a' }, { updatedAt: 5, v: 'b' }, 'a').v;
      const rules = S.mergeRules(
        { updatedAt: 10, overrides: { r1: { id: 'r1', updatedAt: 5, on: false }, r2: { id: 'r2', updatedAt: 5 } },
          user: [{ id: 'u1', updatedAt: 5, src: 'nuevo' }], tombstones: {} },
        { updatedAt: 20, overrides: { r1: { id: 'r1', updatedAt: 8, on: true } },
          user: [{ id: 'u1', updatedAt: 3, src: 'viejo' }, { id: 'u2', updatedAt: now - 10 }, { id: 'u3', updatedAt: 4 }],
          tombstones: { r2: now, u3: now, u2: now - 1000, old: now - 200 * 86400000 } }, 'a');
      const ents = S.mergeById(
        { updatedAt: 1, items: [{ id: 'e1', updatedAt: 1, n: 'A' }, { id: 'e2', updatedAt: 9 }], tombstones: {} },
        { updatedAt: 2, items: [{ id: 'e1', updatedAt: 2, n: 'B' }, { id: 'e3', updatedAt: 3 }], tombstones: { e2: now } }, 'b');
      const usageM = S.mergeValue('usage:dev1', { updated: 5, days: { a: 1 } }, { updated: 9, days: { b: 1 } }, 'a');
      const local = { meta: { kind: 'umbra-sync', date: '2026-11-04T10:00:00Z', device: { id: 'me' }, devices: { me: { name: 'Casa', at: '2026-11-04T10:00:00Z' } } },
        data: { providers: { updatedAt: 50, list: ['local'] }, 'usage:me': { updated: 3, days: {} } } };
      const file = { meta: { kind: 'umbra-sync', devices: { other: { name: 'Oficina', at: '2026-11-03T09:00:00Z' } } },
        data: { providers: { updatedAt: 100, list: ['file'] }, 'usage:other': { updated: 7, days: {} }, future_key: { x: 1 } } };
      const m = S.mergeSyncData(file, local);
      let refused = null;
      try { S.assertUmbraSync({ meta: { kind: 'comet-sync' } }); } catch (e) { refused = e.code + ' | ' + e.message; }
      return {
        newest, tie,
        rules: { r1on: rules.overrides.r1 && rules.overrides.r1.on, r2: !!rules.overrides.r2, users: rules.user.map(u => u.id + ':' + (u.src || '')),
          tombs: Object.keys(rules.tombstones).sort(), updatedAt: rules.updatedAt },
        ents: ents.items.map(e => e.id + (e.n ? ':' + e.n : '')),
        usage: Object.keys(usageM.days),
        merged: { prov: m.data.providers.list[0], keys: Object.keys(m.data).sort(), devices: Object.keys(m.meta.devices).sort(), dev: m.meta.device.id },
        refused,
        synced: ['providers', 'module_models', 'rules', 'entity_dict', 'usage:abc', 'ai_prices', 'usage_notes', 'secrets', 'key:gemini', 'device', 'usage:'].map(k => S.isSyncedKey(k))
      };
    });
    check('merge newest: the later updatedAt wins', merges.newest === 'b', merges.newest);
    check('merge newest: a tie keeps the preferred side', merges.tie === 'a', merges.tie);
    check('merge rules: newer override wins, tombstones remove, union by id', merges.rules.r1on === true && merges.rules.r2 === false &&
      merges.rules.users.join(',') === 'u1:nuevo,u2:' && merges.rules.updatedAt === 20, merges.rules);
    check('merge rules: tombstones older than 90 days are pruned', !merges.rules.tombs.includes('old') && merges.rules.tombs.includes('r2'), merges.rules.tombs);
    check('merge byId: union, newer wins, tombstone removes', merges.ents.join(',') === 'e1:B,e3', merges.ents);
    check('merge usage: the record written last wins', merges.usage.join(',') === 'b', merges.usage);
    check('mergeSyncData keeps file-only keys and unknown keys, newest providers', merges.merged.prov === 'file' &&
      merges.merged.keys.join(',') === 'future_key,providers,usage:me,usage:other' && merges.merged.devices.join(',') === 'me,other' && merges.merged.dev === 'me', merges.merged);
    check('assertUmbraSync refuses a comet-sync file', /^SYNC_WRONG_KIND \| .*COMeT/.test(merges.refused || ''), merges.refused);
    check('synced keys as declared (API keys, device never in clear)',
      JSON.stringify(merges.synced) === JSON.stringify([true, true, true, true, true, true, true, true, false, false, false]), merges.synced);

    // ---------------------------------------------------------------- sync: through a real file handle (OPFS)
    const fsRes = await page.evaluate(async (id) => {
      const out = {};
      const dir = await navigator.storage.getDirectory();
      const fh = await dir.getFileHandle('umbra-sync.json', { create: true });
      const w0 = await fh.createWritable(); await w0.write(''); await w0.close();
      out.linked = await H.syncFs.linkFileHandle(fh);
      await H.setValue('prefs', { updatedAt: Date.now(), dark: false });
      await H.syncFs.saveToSyncFile();
      let text = await (await fh.getFile()).text();
      const data = JSON.parse(text.replace(/^\ufeff/, ''));
      out.kind = data.meta.kind;
      out.hasProviders = !!data.data.providers;
      out.hasUsage = Object.keys(data.data).some(k => k.indexOf('usage:') === 0);
      out.noKeyInClear = !text.includes('sk-test-123');
      out.noSecretsYet = !data.data.secrets;
      out.state = H.syncFs.getSyncState().state;

      // Encrypted keys
      await H.storage.set({ sync_secrets_pass: 'contrasena-de-prueba', sync_secrets_enabled: true });
      await H.syncFs.saveToSyncFile();
      text = await (await fh.getFile()).text();
      const d2 = JSON.parse(text.replace(/^\ufeff/, ''));
      out.secretsBox = !!(d2.data.secrets && d2.data.secrets.box);
      out.noKeyInClear2 = !text.includes('sk-test-123');
      const dec = await H.crypto.decryptJSON(d2.data.secrets.box, 'contrasena-de-prueba');
      out.roundTrip = dec[id] === 'sk-test-123';
      let bad = null;
      try { await H.crypto.decryptJSON(d2.data.secrets.box, 'otra'); } catch (e) { bad = e.code; }
      out.badPass = bad;

      // Another computer: no key, no password. Bring the data with the password.
      await H.storage.remove(['key:' + id, 'sync_secrets_pass', 'sync_secrets_enabled', 'secrets', '_sync_secrets_fp']);
      const skipped = await H.syncFs.applyImportData(d2, { interactive: false });
      out.skippedNoPass = skipped.secrets.skipped;
      const r = await H.syncFs.loadFromSyncFile({ password: 'contrasena-de-prueba', interactive: false });
      out.applied = r.secrets.applied;
      out.keyBack = (await H.registry.getApiKey(id)) === 'sk-test-123';
      out.lastPull = !!(await H.syncFs.getLastPull());
      // Undo: back to "no key"
      await H.syncFs.undoLastPull();
      out.keyAfterUndo = await H.registry.getApiKey(id);
      await H.registry.setApiKey(id, 'sk-test-123');

      // Manual import of a merge from a File object
      const blob = new File([JSON.stringify({ meta: { kind: 'umbra-sync', date: new Date().toISOString() },
        data: { lists: { updatedAt: Date.now() + 1000, names: ['x'] } } })], 'umbra-sync.json');
      await H.syncFs.loadFromFileObject(blob, { interactive: false });
      out.listsImported = !!(await H.getValue('lists', null));
      await H.syncFs.confirmLastPull();

      // A COMeT file: refused for writing, reading and linking; the file is not touched.
      const comet = JSON.stringify({ meta: { version: '2.0', kind: 'comet-sync', date: new Date().toISOString() }, productividad: {} });
      const w = await fh.createWritable(); await w.write(comet); await w.close();
      try { await H.syncFs.saveToSyncFile(); out.cometWrite = 'no error'; } catch (e) { out.cometWrite = e.code; }
      out.cometUntouched = (await (await fh.getFile()).text()) === comet;
      try { await H.syncFs.loadFromSyncFile({ interactive: false }); out.cometRead = 'no error'; } catch (e) { out.cometRead = e.code; }
      const fh2 = await dir.getFileHandle('comet-sync.json', { create: true });
      const w2 = await fh2.createWritable(); await w2.write(comet); await w2.close();
      try { await H.syncFs.linkFileHandle(fh2); out.cometLink = 'no error'; } catch (e) { out.cometLink = e.code; }
      try { await H.syncFs.loadFromFileObject(new File([comet], 'comet-sync.json')); out.cometFile = 'no error'; } catch (e) { out.cometFile = e.code; }
      const meta = await H.syncFs.peekSyncFileMeta();
      out.peekWrong = meta && meta.wrongKind;

      // Back to a good UMBRA file for the next steps.
      const w3 = await fh.createWritable(); await w3.write(''); await w3.close();
      // 0 bytes where there was content: an ALARM, never written over silently...
      try { await H.syncFs.saveToSyncFileSilent(); out.emptyAlarm = 'no error'; } catch (e) { out.emptyAlarm = e.code; }
      // ...unless the user says so (refilled from the local copy of the last good content).
      out.restored = (await H.syncFs.saveToSyncFile({ allowOverwriteEmpty: true })).restored;
      out.final = JSON.parse((await (await fh.getFile()).text()).replace(/^\ufeff/, '')).meta.kind;
      return out;
    }, prof.id);
    check('linkFileHandle links an empty file', fsRes.linked === 'umbra-sync.json', fsRes);
    check('saveToSyncFile writes an umbra-sync file with providers and usage', fsRes.kind === 'umbra-sync' && fsRes.hasProviders && fsRes.hasUsage, fsRes);
    check('API keys are never written in clear', fsRes.noKeyInClear && fsRes.noKeyInClear2 && fsRes.noSecretsYet, fsRes);
    check('sync state ok after a save', fsRes.state === 'ok', fsRes.state);
    check('secrets box written and decrypts back (round trip)', fsRes.secretsBox && fsRes.roundTrip && fsRes.badPass === 'BAD_PASSWORD', fsRes);
    check('without the password the keys are skipped', fsRes.skippedNoPass === 'no_password', fsRes.skippedNoPass);
    check('bringing data with the password restores the key', fsRes.applied === 1 && fsRes.keyBack && fsRes.lastPull, fsRes);
    check('undoLastPull puts this computer back', fsRes.keyAfterUndo === '', fsRes.keyAfterUndo);
    check('manual "Cargar archivo" merges a File', fsRes.listsImported === true, fsRes.listsImported);
    check('a comet-sync file is refused for writing and left untouched', fsRes.cometWrite === 'SYNC_WRONG_KIND' && fsRes.cometUntouched, fsRes);
    check('a comet-sync file is refused for reading, linking and manual load', fsRes.cometRead === 'SYNC_WRONG_KIND' &&
      fsRes.cometLink === 'SYNC_WRONG_KIND' && fsRes.cometFile === 'SYNC_WRONG_KIND' && fsRes.peekWrong === 'comet-sync', fsRes);
    check('a file found empty after having content is an alarm, not written', fsRes.emptyAlarm === 'SYNC_FILE_UNEXPECTEDLY_EMPTY', fsRes.emptyAlarm);
    check('an explicit overwrite refills it from the last good copy', fsRes.restored === true && fsRes.final === 'umbra-sync', fsRes);

    // Autosave
    const auto = await page.evaluate(async () => {
      H.syncAutosave.setAutosaveTiming({ debounceMs: 300 });
      H.syncAutosave.initAutosave();
      await H.syncFs.confirmLastPull();
      await H.setValue('module_cfg', { updatedAt: Date.now(), grammar: { batch: 'auto' } });
      await new Promise(r => setTimeout(r, 2500));
      const dir = await navigator.storage.getDirectory();
      const fh = await dir.getFileHandle('umbra-sync.json');
      const d = JSON.parse((await (await fh.getFile()).text()).replace(/^\ufeff/, ''));
      return { saved: !!(d.data.module_cfg && d.data.module_cfg.grammar), state: H.syncFs.getSyncState().state };
    });
    check('autosave writes a changed key to the file', auto.saved && auto.state === 'ok', auto);

    // Question at opening: quiet when the file is this computer's last save...
    await page.evaluate(() => { sessionStorage.clear(); });
    await page.reload();
    await page.waitForFunction(() => window.H_READY === true);
    const quiet = await page.evaluate(() => H.syncFs.startupSyncCheck());
    check('startupSyncCheck is quiet when the file is this computer\'s own last save', quiet === 'quiet', quiet);
    // ...and asks when it comes from another computer.
    await page.evaluate(async () => {
      const dir = await navigator.storage.getDirectory();
      const fh = await dir.getFileHandle('umbra-sync.json');
      const d = JSON.parse((await (await fh.getFile()).text()).replace(/^\ufeff/, ''));
      const later = new Date(Date.now() + 60000).toISOString();
      d.meta.date = later;
      d.meta.device = { id: 'otro-equipo', name: 'Oficina' };
      d.meta.devices['otro-equipo'] = { name: 'Oficina', at: later };
      const w = await fh.createWritable(); await w.write(JSON.stringify(d)); await w.close();
      sessionStorage.clear();
    });
    await page.reload();
    await page.waitForFunction(() => window.H_READY === true);
    await page.evaluate(() => { window.__startup = H.syncFs.startupSyncCheck(); });
    await page.waitForSelector('#umbra-sync-decision', { timeout: 5000 });
    const modalText = await page.textContent('#umbra-sync-decision');
    check('the decision dialog names the other computer and offers the three choices',
      /Oficina/.test(modalText) && /Traer lo del archivo/.test(modalText) && /Guardar lo de este equipo/.test(modalText) && /Decidir luego/.test(modalText), modalText.slice(0, 300));
    await page.screenshot({ path: path.join(OUT, 'sync-decision.png') });
    await page.click('#umbra-sync-decision >> text=Decidir luego');
    const action = await page.evaluate(() => window.__startup);
    const st = await page.evaluate(() => H.syncFs.getSyncState());
    check('"Decidir luego" leaves the autosave paused (needs_gesture)', action === 'later' && st.state === 'needs_gesture', { action, st });
    const chips = await page.evaluate(() => {
      const b = document.createElement('button'); b.className = 'meter';
      const m = document.createElement('span'); m.className = 'meter';
      document.body.appendChild(b); document.body.appendChild(m);
      H.ui.sync.mountSyncChip(b, {});
      H.ui.usage.mountSessionMeter(m);
      const out = { chip: b.textContent, warn: b.classList.contains('warn'), meter: m.textContent };
      b.remove(); m.remove();
      return out;
    });
    check('header chip turns amber "Guardar" when the autosave pauses; session meter shows', chips.chip === 'Guardar' && chips.warn && /^Sesi\u00f3n: 0 tokens/.test(chips.meter), chips);

    // ---------------------------------------------------------------- settings screens
    errors.length = 0;
    for (const name of ['providers', 'usage', 'sync']) {
      await page.evaluate(async (name) => {
        const c = document.getElementById('mount');
        c.innerHTML = '';
        await H.ui[name].mount(c);
      }, name);
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(OUT, 'settings-' + name + '.png'), fullPage: true });
      const txt = await page.textContent('#mount');
      if (name === 'providers') {
        check('providers screen: cards, key status and module table', /Google Gemini/.test(txt) && /Clave guardada/.test(txt) && /Sin clave/.test(txt) &&
          /se elige en M/.test(txt) && /Proveedor general/.test(txt), txt.slice(0, 200));
        // The model of each module is chosen in Settings > Modulos with this select.
        const opts = await page.evaluate(async () => {
          const sel = await H.ui.providers.moduleModelSelect('style', 'triage');
          document.getElementById('mount').appendChild(sel);
          return Array.from(document.querySelector('select[data-module="style"]').options).map(o => o.textContent);
        });
        check('module select: General first, flagged choice, add options last', opts[0] === 'General' && opts.some(o => /sin clave: se usa el general/.test(o)) &&
          /A\u00f1adir modelo/.test(opts[opts.length - 2]) && /A\u00f1adir proveedor/.test(opts[opts.length - 1]), opts);
        // The dropdown of the module cards.
        await page.evaluate(() => {
          const b = document.createElement('button'); b.id = 'anchor'; b.textContent = 'Modelo'; b.style.cssText = 'position:fixed;left:40px;top:40px';
          document.body.appendChild(b);
          window.__picked = null;
          H.ui.providers.openModelMenu(b, { moduleId: 'coherence', role: 'triage', onPick: (c) => { window.__picked = c; } });
        });
        await page.waitForSelector('#umbra-model-menu');
        await page.screenshot({ path: path.join(OUT, 'model-menu.png') });
        await page.click('#umbra-model-menu >> text=Mock model');
        await page.waitForFunction(() => window.__picked !== null);
        const picked = await page.evaluate(async () => {
          document.getElementById('anchor').remove();
          return { picked: window.__picked, saved: (await H.registry.getModuleModels()).map.coherence };
        });
        check('openModelMenu picks and saves the module model', picked.saved && picked.saved.triage && picked.saved.triage.model === 'mock-model', picked);
        // The provider form.
        await page.click('.pcard.add');
        await page.waitForSelector('.modal');
        await page.screenshot({ path: path.join(OUT, 'provider-modal.png') });
        await page.click('.modal-foot >> text=Cancelar');
      }
      if (name === 'usage') {
        check('usage screen shows totals, bars and the price table', /Uso de IA y coste/.test(txt) && /Gram\u00e1tica/.test(txt) && /A\/78\/100/.test(txt) &&
          /Mock model/.test(txt) && /Precios/.test(txt), txt.slice(0, 300));
        const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 8000 }), page.click('text=Exportar a Excel')]);
        const p = path.join(OUT, 'usage-export.xlsx');
        await dl.saveAs(p);
        const head = fs.readFileSync(p).slice(0, 2).toString('latin1');
        check('"Exportar a Excel" downloads an .xlsx (zip)', head === 'PK' && /\.xlsx$/.test(dl.suggestedFilename()), dl.suggestedFilename());
      }
      if (name === 'sync') {
        check('sync screen: file, buttons, encrypted keys, what travels, device', /umbra-sync\.json/.test(txt) && /Guardar ahora/.test(txt) && /Traer del archivo/.test(txt) &&
          /Desvincular/.test(txt) && /Incluir claves de API cifradas/.test(txt) && /Viaja en el archivo/.test(txt) && /Este equipo/.test(txt), txt.slice(0, 300));
      }
    }
    check('settings screens render without console errors', errors.length === 0, errors);
  } catch (e) {
    check('test run completed', false, (e && e.stack) || String(e));
  } finally {
    if (errors.length) console.log('Console errors:\n  ' + errors.join('\n  '));
    await context.close();
    try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (_) {}
    await mock.close();
    await web.close();
  }

  const failed = results.filter(r => !r.ok);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed. Screenshots in tests/out/.');
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
