#!/usr/bin/env node
/**
 * mock-ai.mjs - A dependency-free stand-in for an OpenAI-compatible provider, for the tests.
 *
 *   node tests/mock-ai.mjs [port]          (default port 8790)
 *   import { startMockAI } from './mock-ai.mjs'; const srv = await startMockAI(8790); ... await srv.close();
 *
 * Endpoints (all with CORS: Access-Control-Allow-Origin *, preflight OPTIONS answered):
 *   POST .../chat/completions   -> { choices:[{ message:{ content } , finish_reason:'stop' }], usage:{...} }
 *        The answer is the `response` of the first rule whose `match` is a substring of the user
 *        prompt, else the default ('FIN 0'). A rule may also set finish_reason or status (an HTTP error).
 *   POST .../models/<model>:generateContent  -> a Gemini answer (to test that adapter through relayUrl)
 *   POST .../messages                         -> an Anthropic Messages answer (idem)
 *   POST /__script  { rules:[{ match, response, finish_reason?, status? }], default }  -> { ok:true }
 *   GET  /__log     -> [{ at, kind, path, model, system, prompt, auth, headers, body }] (every AI request)
 *   POST /__reset   -> clears the log and the script
 *   GET  /          -> 'mock-ai' (lets a no-cors probe see that the server is there)
 */

import http from 'node:http';
import { fileURLToPath } from 'node:url';

function _cors(res, req) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', (req && req.headers['access-control-request-headers']) || '*');
  res.setHeader('Access-Control-Max-Age', '600');
}

function _json(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}

function _readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try { resolve(text ? JSON.parse(text) : {}); } catch (_) { resolve({ _raw: text }); }
    });
  });
}

function _tokens(s) { return Math.max(1, Math.ceil(String(s || '').length / 4)); }


// ---- embeddings: words of the same "concept" (EN/FR/ES) share a dimension, so a sentence and its
// translation are close and a sentence with no counterpart is not (test data, not a real model).
const CONCEPTS = [
  ['recalling', 'recordando', 'rappelant'], ['resolution', 'resolucion', 'resolution'], ['requests', 'solicita', 'prie'],
  ['submit', 'presente', 'presenter'], ['report', 'informe', 'rapport'], ['session', 'sesiones', 'periodo'], ['implementation', 'aplicacion'],
  ['notes', 'observa'], ['staff', 'funcionarios'], ['deployed', 'desplegaron', 'desplego'], ['encourages', 'alienta'], ['member', 'miembros'],
  ['states', 'estados'], ['strengthen', 'fortalecer'], ['national', 'nacional'], ['preparedness', 'preparacion'], ['capacities', 'capacidad'],
  ['promote', 'promover'], ['cooperation', 'cooperacion'], ['develop', 'desarrollo', 'desarrollar'], ['early', 'temprana'], ['warning', 'alerta'],
  ['systems', 'sistemas'], ['support', 'apoyar'], ['communities', 'comunidades'], ['committee', 'comision'], ['met', 'reunio'],
  ['twice', 'dos', 'veces'], ['adopted', 'aprobo'], ['elected', 'eligio'], ['officers', 'mesa'], ['meeting', 'sesion'], ['attended', 'asistieron'],
  ['representatives', 'representantes'], ['including', 'entre'], ['strengthening', 'fortalecimiento'], ['coordination', 'coordinacion'],
  ['emergency', 'emergencia'], ['humanitarian', 'humanitaria'], ['assistance', 'asistencia'], ['eightieth', 'octogesimo'], ['present', 'presente'],
  ['annex', 'anexo'], ['data', 'datos'], ['also', 'tambien']
];
const STOP = new Set(['the', 'of', 'to', 'a', 'an', 'and', 'its', 'it', 'in', 'on', 'that', 'was', 'were', 'by', 'at', 'for', 'la', 'el', 'los',
  'las', 'de', 'del', 'que', 'y', 'en', 'su', 'sus', 'a', 'se', 'un', 'una', 'al', 'con', 'por', 'le', 'les', 'des', 'du', 'et']);
const CMAP = new Map();
CONCEPTS.forEach((ws, i) => ws.forEach(w => CMAP.set(w, i)));
function _fold(w) { return w.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }
function _vector(text) {
  const dim = CONCEPTS.length + 64;
  const v = new Array(dim).fill(0);
  for (const raw of (String(text || '').match(/[\p{L}\p{N}]+/gu) || [])) {
    const w = _fold(raw);
    if (STOP.has(w)) continue;
    if (CMAP.has(w)) { v[CMAP.get(w)] += 1; continue; }
    let h = 0;
    for (let i = 0; i < w.length; i++) h = (h * 31 + w.charCodeAt(i)) >>> 0;
    v[CONCEPTS.length + (h % 64)] += 1;
  }
  return v;
}

export function startMockAI(port) {
  const state = { rules: [], def: 'FIN 0', log: [] };
  const server = http.createServer(async (req, res) => {
    _cors(res, req);
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
    if (req.method === 'GET' && url.pathname === '/__log') { _json(res, 200, state.log); return; }
    if (req.method === 'POST' && url.pathname === '/__reset') { state.rules = []; state.def = 'FIN 0'; state.log = []; _json(res, 200, { ok: true }); return; }
    if (req.method === 'POST' && url.pathname === '/__script') {
      const b = await _readBody(req);
      state.rules = Array.isArray(b.rules) ? b.rules : [];
      if (typeof b.default === 'string') state.def = b.default;
      _json(res, 200, { ok: true, rules: state.rules.length });
      return;
    }

    // ---------------- embeddings (OpenAI style and Gemini batchEmbedContents)
    if (req.method === 'POST' && /\/embeddings$/.test(url.pathname)) {
      const b = await _readBody(req);
      const input = Array.isArray(b.input) ? b.input : [b.input];
      state.log.push({ at: Date.now(), kind: 'embeddings', path: url.pathname, model: b.model || '', system: '', prompt: input.join('\n'), body: b });
      _json(res, 200, { object: 'list', model: b.model, data: input.map((t, i) => ({ object: 'embedding', index: i, embedding: _vector(t) })),
        usage: { prompt_tokens: input.reduce((n, t) => n + _tokens(t), 0), total_tokens: 0 } });
      return;
    }
    if (req.method === 'POST' && /:batchEmbedContents$/.test(url.pathname)) {
      const b = await _readBody(req);
      const texts = (b.requests || []).map(r => ((r.content && r.content.parts) || []).map(p => p.text).join(' '));
      state.log.push({ at: Date.now(), kind: 'embeddings', path: url.pathname, model: '', system: '', prompt: texts.join('\n'), body: b });
      _json(res, 200, { embeddings: texts.map(t => ({ values: _vector(t) })) });
      return;
    }
    // ---------------- batch APIs (answered on the second status check)
    state.batches = state.batches || new Map();
    state.files = state.files || new Map();
    const answer = (system, prompt) => {
      const rule = state.rules.find(r => r && typeof r.match === 'string' && prompt.indexOf(r.match) >= 0);
      const content = rule ? String(rule.response) : state.def;
      state.log.push({ at: Date.now(), kind: 'batch-item', path: url.pathname, model: '', system, prompt, body: null });
      return { content, pt: _tokens(system) + _tokens(prompt), ct: _tokens(content) };
    };
    const tick = (bt) => { bt.polls = (bt.polls || 0) + 1; return bt.polls >= 2; };
    // OpenAI: files + batches
    if (req.method === 'POST' && /\/files$/.test(url.pathname)) {
      const b = await _readBody(req);
      const raw = b._raw || '';
      const lines = raw.split(/\r?\n/).filter(l => l.startsWith('{"custom_id"'));
      const id = 'file-' + (state.files.size + 1);
      state.files.set(id, lines.join('\n'));
      _json(res, 200, { id, object: 'file', purpose: 'batch', bytes: raw.length });
      return;
    }
    let m = /\/files\/([^/]+)\/content$/.exec(url.pathname);
    if (req.method === 'GET' && m) { res.statusCode = 200; res.setHeader('Content-Type', 'application/jsonl'); res.end(state.files.get(m[1]) || ''); return; }
    if (req.method === 'POST' && /\/v1\/batches$/.test(url.pathname)) {
      const b = await _readBody(req);
      const id = 'batch_' + (state.batches.size + 1);
      state.batches.set(id, { kind: 'openai', input: state.files.get(b.input_file_id) || '', body: b });
      state.log.push({ at: Date.now(), kind: 'batch-create', path: url.pathname, model: '', system: '', prompt: '', body: b });
      _json(res, 200, { id, object: 'batch', status: 'validating', request_counts: { total: 0, completed: 0, failed: 0 } });
      return;
    }
    m = /\/v1\/batches\/([^/]+)(\/cancel)?$/.exec(url.pathname);
    if (m && state.batches.has(m[1])) {
      const bt = state.batches.get(m[1]);
      if (m[2]) { bt.cancelled = true; _json(res, 200, { id: m[1], status: 'cancelling' }); return; }
      const reqs = bt.input.split('\n').filter(Boolean).map(l => JSON.parse(l));
      if (bt.cancelled) { _json(res, 200, { id: m[1], status: 'cancelled', request_counts: { total: reqs.length, completed: 0, failed: 0 } }); return; }
      if (!tick(bt)) { _json(res, 200, { id: m[1], status: 'in_progress', request_counts: { total: reqs.length, completed: 0, failed: 0 } }); return; }
      if (!bt.output) {
        const out = reqs.map(r => {
          const msgs = r.body.messages || [];
          const a = answer(msgs.filter(x => x.role === 'system').map(x => x.content).join('\n'), msgs.filter(x => x.role === 'user').map(x => x.content).join('\n'));
          return JSON.stringify({ id: 'r', custom_id: r.custom_id, response: { status_code: 200, body: { choices: [{ message: { role: 'assistant', content: a.content }, finish_reason: 'stop' }],
            usage: { prompt_tokens: a.pt, completion_tokens: a.ct } } }, error: null });
        });
        const fid = 'file-out-' + m[1];
        state.files.set(fid, out.join('\n'));
        bt.output = fid;
      }
      _json(res, 200, { id: m[1], status: 'completed', output_file_id: bt.output, request_counts: { total: reqs.length, completed: reqs.length, failed: 0 } });
      return;
    }
    // Anthropic Message Batches
    if (req.method === 'POST' && /\/messages\/batches$/.test(url.pathname)) {
      const b = await _readBody(req);
      const id = 'msgbatch_' + (state.batches.size + 1);
      state.batches.set(id, { kind: 'anthropic', reqs: b.requests || [] });
      state.log.push({ at: Date.now(), kind: 'batch-create', path: url.pathname, model: '', system: '', prompt: '', body: b,
        headers: { 'anthropic-dangerous-direct-browser-access': req.headers['anthropic-dangerous-direct-browser-access'] } });
      _json(res, 200, { id, type: 'message_batch', processing_status: 'in_progress', request_counts: { processing: (b.requests || []).length, succeeded: 0, errored: 0, canceled: 0, expired: 0 } });
      return;
    }
    m = /\/messages\/batches\/([^/]+)(\/results|\/cancel)?$/.exec(url.pathname);
    if (m && state.batches.has(m[1])) {
      const bt = state.batches.get(m[1]);
      if (m[2] === '/results') {
        const lines = bt.reqs.map(r => {
          const a = answer(r.params.system || '', (r.params.messages || []).map(x => x.content).join('\n'));
          return JSON.stringify({ custom_id: r.custom_id, result: { type: 'succeeded', message: { content: [{ type: 'text', text: a.content }], stop_reason: 'end_turn',
            usage: { input_tokens: a.pt, output_tokens: a.ct } } } });
        });
        res.statusCode = 200; res.setHeader('Content-Type', 'application/jsonl'); res.end(lines.join('\n')); return;
      }
      if (m[2] === '/cancel') { bt.cancelled = true; _json(res, 200, { id: m[1], processing_status: 'canceling' }); return; }
      const ended = tick(bt);
      const n = bt.reqs.length;
      _json(res, 200, { id: m[1], processing_status: ended ? 'ended' : 'in_progress',
        request_counts: ended ? { processing: 0, succeeded: n, errored: 0, canceled: 0, expired: 0 } : { processing: n, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
        results_url: 'http://localhost:' + server.address().port + url.pathname + '/results' });
      return;
    }
    // Gemini batch mode (inline requests)
    m = /\/models\/([^/:]+):batchGenerateContent$/.exec(url.pathname);
    if (req.method === 'POST' && m) {
      const b = await _readBody(req);
      const id = 'batches/gem' + (state.batches.size + 1);
      state.batches.set(id, { kind: 'gemini', reqs: (((b.batch || {}).inputConfig || {}).requests || {}).requests || [] });
      state.log.push({ at: Date.now(), kind: 'batch-create', path: url.pathname, model: m[1], system: '', prompt: '', body: b });
      _json(res, 200, { name: id, metadata: { state: 'BATCH_STATE_PENDING' } });
      return;
    }
    m = /\/(batches\/[^/:]+)(:cancel)?$/.exec(url.pathname);
    if (m && state.batches.has(m[1])) {
      const bt = state.batches.get(m[1]);
      if (m[2]) { bt.cancelled = true; _json(res, 200, {}); return; }
      if (!tick(bt)) { _json(res, 200, { name: m[1], metadata: { state: 'BATCH_STATE_RUNNING' } }); return; }
      const inl = bt.reqs.map(r => {
        const sys = ((r.request.systemInstruction || {}).parts || []).map(p => p.text).join('\n');
        const a = answer(sys, (r.request.contents || []).flatMap(c => c.parts || []).map(p => p.text).join('\n'));
        return { response: { candidates: [{ content: { parts: [{ text: a.content }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: a.pt, candidatesTokenCount: a.ct } },
          metadata: r.metadata };
      });
      _json(res, 200, { name: m[1], metadata: { state: 'BATCH_STATE_SUCCEEDED', output: { inlinedResponses: { inlinedResponses: inl } } }, done: true });
      return;
    }
    // Mistral batch jobs (inline requests and inline outputs)
    if (req.method === 'POST' && /\/batch\/jobs$/.test(url.pathname)) {
      const b = await _readBody(req);
      const id = 'mjob_' + (state.batches.size + 1);
      state.batches.set(id, { kind: 'mistral', reqs: b.requests || [] });
      state.log.push({ at: Date.now(), kind: 'batch-create', path: url.pathname, model: b.model || '', system: '', prompt: '', body: b });
      _json(res, 200, { id, object: 'batch', status: 'QUEUED', total_requests: (b.requests || []).length });
      return;
    }
    m = /\/batch\/jobs\/([^/]+)(\/cancel)?$/.exec(url.pathname);
    if (m && state.batches.has(m[1])) {
      const bt = state.batches.get(m[1]);
      if (m[2]) { bt.cancelled = true; _json(res, 200, { id: m[1], status: 'CANCELLATION_REQUESTED' }); return; }
      const n = bt.reqs.length;
      if (!tick(bt)) { _json(res, 200, { id: m[1], status: 'RUNNING', total_requests: n, completed_requests: 0 }); return; }
      const outputs = bt.reqs.map(r => {
        const msgs = r.body.messages || [];
        const a = answer(msgs.filter(x => x.role === 'system').map(x => x.content).join('\n'), msgs.filter(x => x.role === 'user').map(x => x.content).join('\n'));
        return { custom_id: r.custom_id, response: { status_code: 200, body: { choices: [{ message: { content: a.content }, finish_reason: 'stop' }], usage: { prompt_tokens: a.pt, completion_tokens: a.ct } } } };
      });
      _json(res, 200, { id: m[1], status: 'SUCCESS', total_requests: n, completed_requests: n, outputs });
      return;
    }
    const gem = /\/models\/([^/:]+):generateContent$/.exec(url.pathname);
    if (req.method === 'POST' && (gem || /\/messages\/?$/.test(url.pathname))) {
      const b = await _readBody(req);
      const H = req.headers;
      const headers = { 'x-goog-api-key': H['x-goog-api-key'], 'x-api-key': H['x-api-key'], 'anthropic-version': H['anthropic-version'],
        'anthropic-dangerous-direct-browser-access': H['anthropic-dangerous-direct-browser-access'] };
      let system, prompt, model;
      if (gem) {
        model = decodeURIComponent(gem[1]);
        system = (b.systemInstruction && b.systemInstruction.parts || []).map(p => p.text).join('\n');
        prompt = (b.contents || []).flatMap(c => c.parts || []).map(p => p.text).join('\n');
      } else {
        model = b.model || '';
        system = typeof b.system === 'string' ? b.system : '';
        prompt = (b.messages || []).filter(m => m.role === 'user').map(m => typeof m.content === 'string' ? m.content : '').join('\n');
      }
      state.log.push({ at: Date.now(), kind: gem ? 'gemini' : 'anthropic', path: url.pathname, model, system, prompt, auth: H.authorization || '', headers, body: b });
      const rule = state.rules.find(r => r && typeof r.match === 'string' && prompt.indexOf(r.match) >= 0);
      if (rule && rule.status) { _json(res, rule.status, { error: { message: rule.error || 'Mock error ' + rule.status } }); return; }
      const content = rule ? String(rule.response) : state.def;
      const pt = _tokens(system) + _tokens(prompt), ct = _tokens(content);
      const cut = rule && rule.finish_reason === 'length';
      if (gem) {
        _json(res, 200, { candidates: [{ content: { role: 'model', parts: [{ text: content }] }, finishReason: cut ? 'MAX_TOKENS' : 'STOP' }],
          usageMetadata: { promptTokenCount: pt, candidatesTokenCount: ct, thoughtsTokenCount: 3, totalTokenCount: pt + ct + 3 } });
      } else {
        _json(res, 200, { id: 'msg_mock', type: 'message', role: 'assistant', model, content: [{ type: 'text', text: content }],
          stop_reason: cut ? 'max_tokens' : 'end_turn', usage: { input_tokens: pt, cache_read_input_tokens: 2, cache_creation_input_tokens: 0, output_tokens: ct } });
      }
      return;
    }
    if (req.method === 'POST' && /\/chat\/completions\/?$/.test(url.pathname)) {
      const b = await _readBody(req);
      const msgs = Array.isArray(b.messages) ? b.messages : [];
      const system = msgs.filter(m => m && m.role === 'system').map(m => m.content).join('\n');
      const prompt = msgs.filter(m => m && m.role === 'user').map(m => m.content).join('\n');
      state.log.push({ at: Date.now(), kind: 'openai', path: url.pathname + url.search, model: b.model || '', system, prompt,
        auth: req.headers.authorization || '', headers: { 'api-key': req.headers['api-key'] }, body: b });
      const rule = state.rules.find(r => r && typeof r.match === 'string' && prompt.indexOf(r.match) >= 0);
      if (rule && rule.status) { _json(res, rule.status, { error: { message: rule.error || 'Mock error ' + rule.status } }); return; }
      const content = rule ? String(rule.response) : state.def;
      const pt = _tokens(system) + _tokens(prompt);
      const ct = _tokens(content);
      _json(res, 200, {
        id: 'mock-' + state.log.length, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: b.model || 'mock',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: (rule && rule.finish_reason) || 'stop' }],
        usage: { prompt_tokens: pt, completion_tokens: ct, total_tokens: pt + ct, prompt_tokens_details: { cached_tokens: 0 } }
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/') {
      res.statusCode = 200; res.setHeader('Content-Type', 'text/plain'); res.end('mock-ai'); return;
    }
    _json(res, 404, { error: { message: 'Not found: ' + req.method + ' ' + url.pathname } });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port || 8790, () => {
      resolve({
        port: server.address().port,
        state,
        close: () => new Promise((r) => server.close(() => r()))
      });
    });
  });
}

// Run as a program.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = parseInt(process.argv[2] || '8790', 10);
  startMockAI(port).then((s) => console.log('mock-ai listening on http://localhost:' + s.port + '/v1'));
}
