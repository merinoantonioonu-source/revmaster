/**
 * embeddings.js - Sentence vectors for the semantic-similarity check (layer 0, review/semantic.js).
 *
 * Two engines:
 *  - LOCAL: a multilingual sentence-embedding model that runs IN THE BROWSER (transformers.js,
 *    vendored in app/libs/transformers/). Nothing leaves the computer, so it may read the real
 *    text. First use downloads the inference engine (~22 MB, cdn.jsdelivr.net) and the model
 *    (~120 MB, huggingface.co); the browser keeps both in its cache afterwards.
 *  - API: the embeddings endpoint of a configured provider (Gemini batchEmbedContents, Mistral and
 *    OpenAI-compatible /embeddings). Called through ai/gateway.js, so only MASKED text goes out.
 *
 * All vectors come back L2-normalised (cosine = dot product).
 */

import { _http } from './providers.js';

export const DEFAULT_LOCAL_MODEL = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
export const DEFAULT_API_MODELS = { gemini: 'gemini-embedding-001', mistral: 'mistral-embed', 'openai-compatible': 'text-embedding-3-small' };

export function embeddingsSupported(profile) {
  return !!profile && ['gemini', 'mistral', 'openai-compatible'].includes(profile.adapter);
}

function _normalize(v) {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map(x => x / n);
}

export function cosine(a, b) {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

// ------------------------------------------------------------------ local (transformers.js)

let _localFactory = null;     // tests can replace the model: setLocalEmbedderFactory(async (model) => fn(texts))
const _local = new Map();     // model id -> Promise<fn(texts) -> vectors>

export function setLocalEmbedderFactory(fn) { _localFactory = fn; _local.clear(); }

async function _localEmbedder(model, onStatus) {
  if (_localFactory) return _localFactory(model);
  const mod = await import('../../libs/transformers/transformers.min.js');
  const { pipeline, env } = mod;
  env.allowLocalModels = false;           // models come from the Hugging Face hub (then the browser cache)
  env.useBrowserCache = true;
  let device = 'wasm';
  try { if (navigator.gpu && await navigator.gpu.requestAdapter()) device = 'webgpu'; } catch (_) { device = 'wasm'; }
  const progress = (p) => {
    if (!onStatus || !p) return;
    if (p.status === 'progress' && p.total) onStatus('Descargando el modelo: ' + Math.round(100 * p.loaded / p.total) + ' %');
    else if (p.status === 'ready') onStatus('Modelo listo');
  };
  let extractor;
  try {
    extractor = await pipeline('feature-extraction', model, { dtype: 'q8', device, progress_callback: progress });
  } catch (e) {
    if (device !== 'wasm') extractor = await pipeline('feature-extraction', model, { dtype: 'q8', device: 'wasm', progress_callback: progress });
    else throw e;
  }
  return async (texts) => {
    const out = await extractor(texts, { pooling: 'mean', normalize: true });
    return out.tolist();
  };
}

/** Local vectors, in chunks (keeps memory low and lets the caller show progress). */
export async function embedLocal(texts, opts) {
  const o = opts || {};
  const model = o.model || DEFAULT_LOCAL_MODEL;
  if (!_local.has(model)) {
    const p = _localEmbedder(model, o.onStatus);
    _local.set(model, p);
    p.catch(() => _local.delete(model));
  }
  let fn;
  try { fn = await _local.get(model); } catch (e) {
    throw _http.err('LOCAL_MODEL', 'No se pudo cargar el modelo local de similitud (' + model + '): ' + (e && e.message ? e.message : e) +
      '. Hace falta conexi\u00f3n con cdn.jsdelivr.net y huggingface.co la primera vez; tambi\u00e9n puede usar el modo API.');
  }
  const out = [];
  const size = o.chunk || 24;
  for (let i = 0; i < texts.length; i += size) {
    if (o.signal && o.signal.aborted) throw _http.err('ABORTED', 'Detenido.');
    const vecs = await fn(texts.slice(i, i + size));
    for (const v of vecs) out.push(_normalize(Array.from(v)));
    if (o.onProgress) o.onProgress(Math.min(texts.length, i + size), texts.length);
  }
  return out;
}

// ------------------------------------------------------------------ API (one provider)

/**
 * Vectors from a provider's embeddings endpoint. -> { vectors, usage:{ input } }
 * Use it through gateway.embedTexts (which enforces masking and records the usage).
 */
export async function embedApi(profile, apiKey, model, texts, opts) {
  const o = opts || {};
  const name = profile.name || profile.adapter;
  const m = String(model || DEFAULT_API_MODELS[profile.adapter] || '').trim();
  if (!apiKey && profile.trust !== 'local') throw _http.err('NO_KEY', 'Falta la clave de API de ' + name + '.');
  const vectors = [];
  let input = 0;
  const size = profile.adapter === 'gemini' ? 100 : 64;
  for (let i = 0; i < texts.length; i += size) {
    const chunk = texts.slice(i, i + size);
    if (profile.adapter === 'gemini') {
      const id = m.replace(/^models\//, '');
      const url = _http.base(profile) + '/models/' + encodeURIComponent(id) + ':batchEmbedContents';
      const body = { requests: chunk.map(t => ({ model: 'models/' + id, content: { parts: [{ text: t }] }, taskType: 'SEMANTIC_SIMILARITY' })) };
      const res = await _http.send(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey }, body: JSON.stringify(body), signal: o.signal }, name);
      if (!res.ok) { const { detail } = await _http.readError(res); throw _http.httpError(res.status, name, detail); }
      const data = await res.json();
      for (const e of (data.embeddings || [])) vectors.push(_normalize(e.values || []));
      input += chunk.reduce((n, t) => n + Math.ceil(t.length / 3.8), 0);   // Gemini reports no usage here
    } else {
      let base = _http.base(profile);
      if (profile.adapter === 'mistral' && !base) base = _http.DEFAULT_BASE.mistral;
      base = base.replace(/\/chat\/completions\/?$/, '');
      const headers = { 'Content-Type': 'application/json' };
      if (apiKey) headers.Authorization = 'Bearer ' + apiKey;
      const res = await _http.send(base + '/embeddings', { method: 'POST', headers, body: JSON.stringify({ model: m, input: chunk }), signal: o.signal }, name);
      if (!res.ok) { const { detail } = await _http.readError(res); throw _http.httpError(res.status, name, detail); }
      const data = await res.json();
      const rows = (data.data || []).slice().sort((a, b) => (a.index || 0) - (b.index || 0));
      for (const r of rows) vectors.push(_normalize(r.embedding || []));
      input += (data.usage && (data.usage.prompt_tokens || data.usage.total_tokens)) || chunk.reduce((n, t) => n + Math.ceil(t.length / 3.8), 0);
    }
    if (o.onProgress) o.onProgress(Math.min(texts.length, i + size), texts.length);
  }
  if (vectors.length !== texts.length) throw _http.err('EMPTY', name + ' no ha devuelto un vector por texto (' + vectors.length + '/' + texts.length + ').');
  return { vectors, usage: { input, cached: 0, output: 0, thoughts: 0 }, model: m };
}
