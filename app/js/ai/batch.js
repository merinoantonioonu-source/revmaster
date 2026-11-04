/**
 * batch.js - Deferred (asynchronous) batch jobs: the providers answer within minutes or hours
 * (up to 24 h) and charge about HALF the normal price.
 *
 * Shapes taken from the providers' official SDKs (no web access to the docs from where this was
 * written): @google/genai 2.32 (batches), Anthropic Message Batches, openai 7.50 (files + batches),
 * @mistralai/mistralai 3.5 (batch jobs with inline requests).
 *
 *   batchKind(profile) -> 'gemini' | 'anthropic' | 'openai' | 'mistral' | null
 *   submitBatch(profile, apiKey, model, requests)  requests = [{ key, prompt, system, maxTokens, thinking, temperature }]
 *       -> { kind, id, model, submittedAt, total }
 *   pollBatch(job, profile, apiKey)    -> { state:'running'|'done'|'failed'|'cancelled'|'expired', done, total, message }
 *   batchResults(job, profile, apiKey) -> Map(key -> { text, usage:{ input, cached, output, thoughts }, error, truncated })
 *   cancelBatch(job, profile, apiKey)
 *
 * Use them through ai/gateway.js (submitDeferred...), which refuses unmasked text.
 */

import { _http } from './providers.js';

const H = _http;

export function batchKind(profile) {
  const p = profile || {};
  if (p.adapter === 'gemini') return 'gemini';
  if (p.adapter === 'anthropic') return 'anthropic';
  if (p.adapter === 'mistral') return 'mistral';
  if (p.adapter === 'openai-compatible' && (p.batch === true || /(^|\/\/)api\.openai\.com/.test(p.baseUrl || ''))) return 'openai';
  return null;
}

export const BATCH_LABELS = { gemini: 'Gemini Batch', anthropic: 'Anthropic Message Batches', openai: 'OpenAI Batch API', mistral: 'Mistral Batch' };

function _name(p) { return p.name || p.adapter || 'proveedor'; }

async function _json(res, name) {
  if (!res.ok) { const { detail } = await H.readError(res); throw H.httpError(res.status, name, detail); }
  return res.json();
}

function _jsonl(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch (_) { /* a broken line is skipped */ }
  }
  return out;
}

// ------------------------------------------------------------------ Gemini

function _geminiHeaders(apiKey) { return { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey }; }

function _geminiRequest(model, r) {
  const req = { contents: [{ role: 'user', parts: [{ text: String(r.prompt || '') }] }],
    generationConfig: { maxOutputTokens: r.maxTokens || H.DEFAULT_MAX_TOKENS } };
  if (r.system) req.systemInstruction = { parts: [{ text: String(r.system) }] };
  if (H.geminiTakesTemperature(model)) req.generationConfig.temperature = r.temperature !== undefined ? r.temperature : 0.2;
  const th = H.geminiThinking(model, r.thinking || null);
  if (th) req.generationConfig.thinkingConfig = th;
  return req;
}

function _geminiText(resp) {
  const cand = resp && resp.candidates && resp.candidates[0];
  const parts = (cand && cand.content && Array.isArray(cand.content.parts)) ? cand.content.parts : [];
  const u = (resp && resp.usageMetadata) || {};
  return {
    text: parts.filter(p => p && typeof p.text === 'string' && !p.thought).map(p => p.text).join(''),
    truncated: !!(cand && cand.finishReason === 'MAX_TOKENS'),
    usage: { input: u.promptTokenCount || 0, cached: u.cachedContentTokenCount || 0, output: u.candidatesTokenCount || 0, thoughts: u.thoughtsTokenCount || 0 }
  };
}

const GEMINI_STATE = {
  BATCH_STATE_PENDING: 'running', BATCH_STATE_RUNNING: 'running', BATCH_STATE_SUCCEEDED: 'done', BATCH_STATE_FAILED: 'failed',
  BATCH_STATE_CANCELLED: 'cancelled', BATCH_STATE_EXPIRED: 'expired',
  JOB_STATE_QUEUED: 'running', JOB_STATE_PENDING: 'running', JOB_STATE_RUNNING: 'running', JOB_STATE_SUCCEEDED: 'done',
  JOB_STATE_PARTIALLY_SUCCEEDED: 'done', JOB_STATE_FAILED: 'failed', JOB_STATE_CANCELLED: 'cancelled', JOB_STATE_CANCELLING: 'running',
  JOB_STATE_EXPIRED: 'expired'
};

async function _geminiGet(job, profile, apiKey) {
  const url = H.base(profile) + '/' + String(job.id).replace(/^\/+/, '');
  return _json(await H.send(url, { method: 'GET', headers: _geminiHeaders(apiKey) }, _name(profile)), _name(profile));
}

// ------------------------------------------------------------------ Anthropic

function _claudeHeaders(apiKey) {
  return { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true' };
}

function _claudeParams(model, r) {
  const params = { model, max_tokens: r.maxTokens || H.DEFAULT_MAX_TOKENS, messages: [{ role: 'user', content: String(r.prompt || '') }] };
  if (r.system) params.system = String(r.system);
  if (H.claudeTakesTemperature(model) && r.temperature !== undefined) params.temperature = r.temperature;
  const effort = H.claudeEffort(model, r.thinking || null);
  if (effort) params.output_config = { effort };
  return params;
}

function _claudeText(message) {
  const blocks = (message && Array.isArray(message.content)) ? message.content : [];
  const u = (message && message.usage) || {};
  const cached = u.cache_read_input_tokens || 0;
  return {
    text: blocks.filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => b.text).join(''),
    truncated: !!(message && message.stop_reason === 'max_tokens'),
    refused: !!(message && message.stop_reason === 'refusal'),
    usage: { input: (u.input_tokens || 0) + cached + (u.cache_creation_input_tokens || 0), cached, output: u.output_tokens || 0, thoughts: 0 }
  };
}

// ------------------------------------------------------------------ OpenAI style (OpenAI, Mistral)

function _oaiHeaders(apiKey, json) {
  const h = { 'Accept': 'application/json' };
  if (json) h['Content-Type'] = 'application/json';
  if (apiKey) h.Authorization = 'Bearer ' + apiKey;
  return h;
}

function _oaiBase(profile) {
  let b = H.base(profile);
  if (!b && profile.adapter === 'mistral') b = H.DEFAULT_BASE.mistral;
  return b.replace(/\/chat\/completions\/?$/, '');
}

function _oaiMessages(r) {
  const messages = [];
  if (r.system) messages.push({ role: 'system', content: String(r.system) });
  messages.push({ role: 'user', content: String(r.prompt || '') });
  return messages;
}

function _oaiText(body) {
  const choice = body && body.choices && body.choices[0];
  const content = choice && choice.message && choice.message.content;
  const text = Array.isArray(content) ? content.map(c => (c && typeof c.text === 'string') ? c.text : '').join('') : (typeof content === 'string' ? content : '');
  return { text, truncated: !!(choice && choice.finish_reason === 'length'), usage: H.openaiUsage(body || {}) };
}

/** One result line of OpenAI / Mistral batch output -> { key, value } */
function _oaiLine(line) {
  const key = line.custom_id || line.customId || (line.metadata && line.metadata.key) || '';
  if (line.error && !line.response) return { key, value: { text: '', error: (line.error.message || JSON.stringify(line.error)), usage: null } };
  const resp = line.response || {};
  const status = resp.status_code || resp.statusCode || 200;
  const body = resp.body || line.body || resp;
  if (status >= 400) return { key, value: { text: '', error: 'HTTP ' + status + ': ' + ((body && body.error && body.error.message) || ''), usage: null } };
  return { key, value: _oaiText(body) };
}

const OAI_STATE = { validating: 'running', in_progress: 'running', finalizing: 'running', cancelling: 'running', completed: 'done',
  failed: 'failed', expired: 'expired', cancelled: 'cancelled' };
const MISTRAL_STATE = { QUEUED: 'running', RUNNING: 'running', CANCELLATION_REQUESTED: 'running', SUCCESS: 'done', FAILED: 'failed',
  TIMEOUT_EXCEEDED: 'expired', CANCELLED: 'cancelled' };

// ------------------------------------------------------------------ public API

export async function submitBatch(profile, apiKey, model, requests) {
  const kind = batchKind(profile);
  const name = _name(profile);
  if (!kind) throw H.err('NO_BATCH', name + ' no admite el modo diferido (lotes) en UMBRA.');
  if (!apiKey) throw H.err('NO_KEY', 'Falta la clave de API de ' + name + '.');
  if (!requests || !requests.length) throw H.err('EMPTY', 'No hay nada que enviar en el lote.');
  const now = Date.now();
  let id;
  if (kind === 'gemini') {
    const m = String(model || '').replace(/^models\//, '');
    const url = H.base(profile) + '/models/' + encodeURIComponent(m) + ':batchGenerateContent';
    const body = { batch: { displayName: 'UMBRA ' + new Date(now).toISOString().slice(0, 16),
      inputConfig: { requests: { requests: requests.map(r => ({ request: _geminiRequest(m, r), metadata: { key: r.key } })) } } } };
    const data = await _json(await H.send(url, { method: 'POST', headers: _geminiHeaders(apiKey), body: JSON.stringify(body) }, name), name);
    id = data.name;
  } else if (kind === 'anthropic') {
    const body = { requests: requests.map(r => ({ custom_id: r.key, params: _claudeParams(model, r) })) };
    const data = await _json(await H.send(H.base(profile) + '/messages/batches', { method: 'POST', headers: _claudeHeaders(apiKey), body: JSON.stringify(body) }, name), name);
    id = data.id;
  } else if (kind === 'openai') {
    const base = _oaiBase(profile);
    const lines = requests.map(r => JSON.stringify({ custom_id: r.key, method: 'POST', url: '/v1/chat/completions',
      body: { model, messages: _oaiMessages(r), max_completion_tokens: r.maxTokens || H.DEFAULT_MAX_TOKENS } })).join('\n') + '\n';
    const form = new FormData();
    form.append('purpose', 'batch');
    form.append('file', new Blob([lines], { type: 'application/jsonl' }), 'umbra-batch.jsonl');
    const file = await _json(await H.send(base + '/files', { method: 'POST', headers: _oaiHeaders(apiKey, false), body: form }, name), name);
    const data = await _json(await H.send(base + '/batches', { method: 'POST', headers: _oaiHeaders(apiKey, true),
      body: JSON.stringify({ input_file_id: file.id, endpoint: '/v1/chat/completions', completion_window: '24h', metadata: { source: 'umbra' } }) }, name), name);
    id = data.id;
  } else if (kind === 'mistral') {
    const base = _oaiBase(profile);
    const body = { requests: requests.map(r => ({ custom_id: r.key, body: { messages: _oaiMessages(r), max_tokens: r.maxTokens || H.DEFAULT_MAX_TOKENS,
      temperature: r.temperature !== undefined ? r.temperature : 0.2 } })), endpoint: '/v1/chat/completions', model, metadata: { source: 'umbra' }, timeout_hours: 24 };
    const data = await _json(await H.send(base + '/batch/jobs', { method: 'POST', headers: _oaiHeaders(apiKey, true), body: JSON.stringify(body) }, name), name);
    id = data.id;
  }
  if (!id) throw H.err('EMPTY', name + ' no ha devuelto el identificador del lote.');
  return { kind, id, model, submittedAt: now, total: requests.length };
}

export async function pollBatch(job, profile, apiKey) {
  const name = _name(profile);
  if (job.kind === 'gemini') {
    const data = await _geminiGet(job, profile, apiKey);
    const st = (data.metadata && data.metadata.state) || data.state || '';
    let state = GEMINI_STATE[st] || (data.done ? 'done' : 'running');
    if (data.error) state = 'failed';
    const stats = (data.metadata && data.metadata.batchStats) || {};
    const done = parseInt(stats.successfulRequestCount || 0, 10) + parseInt(stats.failedRequestCount || 0, 10);
    return { state, done, total: parseInt(stats.requestCount || job.total || 0, 10), message: (data.error && data.error.message) || st, raw: data };
  }
  if (job.kind === 'anthropic') {
    const data = await _json(await H.send(H.base(profile) + '/messages/batches/' + encodeURIComponent(job.id), { method: 'GET', headers: _claudeHeaders(apiKey) }, name), name);
    const c = data.request_counts || {};
    const done = (c.succeeded || 0) + (c.errored || 0) + (c.canceled || 0) + (c.expired || 0);
    const state = data.processing_status === 'ended' ? ((c.succeeded || c.errored) ? 'done' : (c.canceled ? 'cancelled' : 'expired')) : 'running';
    return { state, done, total: done + (c.processing || 0), message: data.processing_status, raw: data };
  }
  if (job.kind === 'openai') {
    const data = await _json(await H.send(_oaiBase(profile) + '/batches/' + encodeURIComponent(job.id), { method: 'GET', headers: _oaiHeaders(apiKey, false) }, name), name);
    const c = data.request_counts || {};
    return { state: OAI_STATE[data.status] || 'running', done: (c.completed || 0) + (c.failed || 0), total: c.total || job.total || 0,
      message: data.status + ((data.errors && data.errors.data && data.errors.data[0]) ? ': ' + data.errors.data[0].message : ''), raw: data };
  }
  if (job.kind === 'mistral') {
    const data = await _json(await H.send(_oaiBase(profile) + '/batch/jobs/' + encodeURIComponent(job.id) + '?inline=true', { method: 'GET', headers: _oaiHeaders(apiKey, false) }, name), name);
    return { state: MISTRAL_STATE[data.status] || 'running', done: data.completed_requests || 0, total: data.total_requests || job.total || 0, message: data.status, raw: data };
  }
  throw H.err('NO_BATCH', 'Tipo de lote desconocido.');
}

export async function batchResults(job, profile, apiKey, last) {
  const name = _name(profile);
  const out = new Map();
  if (job.kind === 'gemini') {
    const data = (last && last.raw) || await _geminiGet(job, profile, apiKey);
    const output = (data.metadata && data.metadata.output) || data.response || data.output || {};
    let items = (output.inlinedResponses && (output.inlinedResponses.inlinedResponses || output.inlinedResponses)) || [];
    if ((!Array.isArray(items) || !items.length) && output.responsesFile) {
      const root = H.base(profile).replace(/\/v1beta$/, '');
      const res = await H.send(root + '/download/v1beta/' + output.responsesFile + ':download?alt=media', { method: 'GET', headers: _geminiHeaders(apiKey) }, name);
      if (!res.ok) { const { detail } = await H.readError(res); throw H.httpError(res.status, name, detail); }
      items = _jsonl(await res.text());
    }
    for (const it of (Array.isArray(items) ? items : [])) {
      const key = (it.metadata && it.metadata.key) || it.key || '';
      if (it.error) out.set(key, { text: '', error: it.error.message || JSON.stringify(it.error), usage: null });
      else out.set(key, _geminiText(it.response || {}));
    }
    return out;
  }
  if (job.kind === 'anthropic') {
    const info = (last && last.raw) || (await pollBatch(job, profile, apiKey)).raw;
    const url = info.results_url || (H.base(profile) + '/messages/batches/' + encodeURIComponent(job.id) + '/results');
    const res = await H.send(url, { method: 'GET', headers: _claudeHeaders(apiKey) }, name);
    if (!res.ok) { const { detail } = await H.readError(res); throw H.httpError(res.status, name, detail); }
    for (const line of _jsonl(await res.text())) {
      const r = line.result || {};
      if (r.type === 'succeeded') {
        const v = _claudeText(r.message);
        if (v.refused) v.error = 'El modelo se neg\u00f3 a responder.';
        out.set(line.custom_id, v);
      } else out.set(line.custom_id, { text: '', error: r.type + (r.error ? ': ' + (r.error.message || r.error.type || '') : ''), usage: null });
    }
    return out;
  }
  if (job.kind === 'openai' || job.kind === 'mistral') {
    const info = (last && last.raw) || (await pollBatch(job, profile, apiKey)).raw;
    const base = _oaiBase(profile);
    let lines = [];
    if (job.kind === 'mistral' && Array.isArray(info.outputs) && info.outputs.length) lines = info.outputs;
    else {
      for (const fid of [info.output_file_id || info.output_file, info.error_file_id || info.error_file].filter(Boolean)) {
        const res = await H.send(base + '/files/' + encodeURIComponent(fid) + '/content', { method: 'GET', headers: _oaiHeaders(apiKey, false) }, name);
        if (!res.ok) { const { detail } = await H.readError(res); throw H.httpError(res.status, name, detail); }
        lines = lines.concat(_jsonl(await res.text()));
      }
    }
    for (const line of lines) {
      const { key, value } = _oaiLine(line);
      if (key && !(out.has(key) && !value.text)) out.set(key, value);
    }
    return out;
  }
  throw H.err('NO_BATCH', 'Tipo de lote desconocido.');
}

export async function cancelBatch(job, profile, apiKey) {
  const name = _name(profile);
  let url, headers;
  if (job.kind === 'gemini') { url = H.base(profile) + '/' + String(job.id).replace(/^\/+/, '') + ':cancel'; headers = _geminiHeaders(apiKey); }
  else if (job.kind === 'anthropic') { url = H.base(profile) + '/messages/batches/' + encodeURIComponent(job.id) + '/cancel'; headers = _claudeHeaders(apiKey); }
  else if (job.kind === 'openai') { url = _oaiBase(profile) + '/batches/' + encodeURIComponent(job.id) + '/cancel'; headers = _oaiHeaders(apiKey, true); }
  else if (job.kind === 'mistral') { url = _oaiBase(profile) + '/batch/jobs/' + encodeURIComponent(job.id) + '/cancel'; headers = _oaiHeaders(apiKey, true); }
  else throw H.err('NO_BATCH', 'Tipo de lote desconocido.');
  const res = await H.send(url, { method: 'POST', headers, body: job.kind === 'gemini' ? '{}' : undefined }, name);
  if (!res.ok) { const { detail } = await H.readError(res); throw H.httpError(res.status, name, detail); }
  return true;
}
