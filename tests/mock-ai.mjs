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
