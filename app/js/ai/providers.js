/**
 * providers.js - The AI provider adapters. Every adapter builds a client with the same face:
 *   createClient(profile, modelId, apiKey) -> { name, model, adapter, providerId, complete(prompt, system, opts) }
 *   complete(...) -> Promise<string>   (opts: { temperature, maxTokens, thinking, onUsage, signal })
 * and onUsage receives { input, cached, output, thoughts } as COMeT records it: `input` counts EVERY
 * token sent (`cached` of them served from the provider's cache), `output` the answer WITHOUT the
 * reasoning, `thoughts` the reasoning (billed as output).
 *
 * Origin: COMeT services/ai-providers/gemini-provider.js @ 04540f5 (adapted)
 * Origin: COMeT services/ai-providers/mistral-provider.js @ 04540f5 (adapted)
 * Origin: COMeT services/ai-providers/azure-openai-provider.js @ 04540f5 (adapted)
 * Origin: COMeT services/ai-providers/custom-openai-provider.js @ 04540f5 (adapted)
 *
 * What changed from COMeT:
 * - Errors carry err.code: NO_KEY, NO_URL, NETWORK, TIMEOUT, ABORTED, HTTP_401 (also 403 and a
 *   Gemini 400 about the key), HTTP_404, HTTP_429, HTTP_5XX, HTTP_<n>, EMPTY, TRUNCATED, REFUSED.
 *   TRUNCATED (the model hit maxTokens) carries err.partial = the text it wrote; usage is reported
 *   before the error is thrown, so the call is still recorded.
 * - NETWORK: a web page gets a bare TypeError both when the provider refuses calls from web pages
 *   (CORS) and when there is no connection. testConnection() tells the two apart with a no-cors probe.
 * - A NEW adapter for Anthropic (Messages API, direct browser access header).
 * - 'openai-compatible' (COMeT's custom provider) takes an optional profile.relayUrl: a user-owned
 *   relay/proxy that replaces the base URL, for providers that refuse calls from web pages. Any
 *   adapter takes it (and profile.baseUrl overrides the default address of the built-in ones).
 * - Every call takes an AbortSignal (opts.signal).
 * This is the ONLY module that may fetch a provider (ARQUITECTURA: rules).
 */

export const ADAPTERS = [
  { id: 'gemini', label: 'Google Gemini' },
  { id: 'mistral', label: 'Mistral' },
  { id: 'azure-openai', label: 'Azure OpenAI' },
  { id: 'anthropic', label: 'Anthropic (Claude)' },
  { id: 'openai-compatible', label: 'Compatible con OpenAI' }
];

export function adapterLabel(id) {
  const a = ADAPTERS.find(x => x.id === id);
  return a ? a.label : String(id || '');
}

const DEFAULT_MAX_TOKENS = 8192;
const DEFAULT_BASE = {
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
  mistral: 'https://api.mistral.ai/v1',
  anthropic: 'https://api.anthropic.com/v1'
};
const AZURE_API_VERSION = '2024-06-01';

// ------------------------------------------------------------------ shared helpers

function _err(code, message, extra) {
  const e = new Error(message);
  e.code = code;
  if (extra) Object.assign(e, extra);
  return e;
}

function _trimUrl(u) { return String(u || '').trim().replace(/\/+$/, ''); }

/** The address a profile is called at: its relay, else its base URL, else the adapter's default. */
export function baseUrlOf(profile) {
  const p = profile || {};
  return _trimUrl(p.relayUrl) || _trimUrl(p.baseUrl) || DEFAULT_BASE[p.adapter] || '';
}

const NETWORK_MSG = (name) => 'No se ha podido llamar a ' + name + '. Puede que este proveedor no acepte llamadas ' +
  'desde una p\u00e1gina web (CORS) o que no haya conexi\u00f3n. Pulsa "Probar conexi\u00f3n" en Ajustes > Proveedores ' +
  'para saberlo, o usa otro proveedor.';

async function _send(url, init, name) {
  try {
    return await fetch(url, init);
  } catch (e) {
    if (e && e.name === 'AbortError') throw _err('ABORTED', 'Llamada cancelada.');
    if (e && e.name === 'TimeoutError') throw _err('TIMEOUT', name + ' no ha respondido a tiempo.');
    throw _err('NETWORK', NETWORK_MSG(name), { url });
  }
}

async function _readError(res) {
  let detail = '';
  let body = null;
  try {
    const text = await res.text();
    try { body = JSON.parse(text); } catch (_) { body = null; }
    if (body) {
      const e = Array.isArray(body) ? body[0] && body[0].error : body.error;
      detail = (e && (e.message || (typeof e === 'string' ? e : ''))) || body.message || body.detail || '';
      if (typeof detail !== 'string') detail = JSON.stringify(detail);
    } else {
      detail = String(text || '').slice(0, 300);
    }
  } catch (_) {}
  return { detail: String(detail || res.statusText || '').trim(), body };
}

function _httpError(status, name, detail) {
  let code, msg;
  if (status === 401 || status === 403) {
    code = 'HTTP_401';
    msg = name + ' rechaza la clave de API (' + status + '). Comprueba que la clave es correcta, est\u00e1 activa y no tiene restricciones de origen.';
  } else if (status === 404) {
    code = 'HTTP_404';
    msg = name + ' no encuentra la ruta o el modelo (404). Revisa la direcci\u00f3n y el nombre del modelo.';
  } else if (status === 429) {
    code = 'HTTP_429';
    msg = name + ' indica demasiadas solicitudes o cuota agotada (429). Espera un poco o revisa tu plan.';
  } else if (status >= 500) {
    code = 'HTTP_5XX';
    msg = name + ' tiene un error en su servidor (' + status + '). Vuelve a intentarlo m\u00e1s tarde.';
  } else {
    code = 'HTTP_' + status;
    msg = 'Error de ' + name + ' (' + status + ').';
  }
  if (detail) msg += ' Detalle: ' + String(detail).slice(0, 300);
  return _err(code, msg, { status, detail });
}

function _report(options, u) {
  if (typeof options.onUsage !== 'function') return;
  try { options.onUsage(u); } catch (_) {}
}

// OpenAI-style usage: completion_tokens INCLUDES the reasoning (Gemini reports it apart), so it is
// taken out and output + thoughts never counts the reasoning twice. (As COMeT.)
function _openaiUsage(data) {
  const u = (data && data.usage) || {};
  const thoughts = (u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens) || 0;
  return {
    input: u.prompt_tokens || 0,
    cached: (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0,
    output: Math.max(0, (u.completion_tokens || 0) - thoughts),
    thoughts
  };
}

function _truncated(name, partial) {
  return _err('TRUNCATED', 'La respuesta de ' + name + ' se ha cortado: el modelo ha agotado el l\u00edmite de tokens ' +
    '(suele pasar con los modelos que razonan antes de contestar o con lotes demasiado grandes).', { partial: partial || '' });
}

function _empty(name, why) {
  return _err('EMPTY', 'Respuesta vac\u00eda de ' + name + (why ? ' (' + why + ')' : '') + '.');
}

function _refused(name, why) {
  return _err('REFUSED', name + ' no ha querido responder' + (why ? ' (' + why + ')' : '') + '.');
}

// ------------------------------------------------------------------ Gemini (from COMeT)

// Models Google has RETIRED, and the one it now sends their requests to. Called directly by the new
// name, as Google asks, so a saved choice of the old model keeps working when the redirection ends.
const RETIRED_MODELS = { 'gemini-3.5-flash': 'gemini-3.6-flash' };

// Only Gemini 1.x and 2.x take a TEMPERATURE. Since Gemini 3.6 Flash the sampling parameters have no
// effect, and Google has announced that its upcoming models will answer 400 INVALID_ARGUMENT to a
// request that carries them.
function _geminiTakesTemperature(model) {
  return /^gemini-[12](?:[.-]|$)/i.test(String(model || '').replace(/^models\//, '').trim());
}

// HOW MUCH THE MODEL REASONS before it answers ('minimal' | 'low' | 'high'). Gemini 3 and later take
// a level (thinkingLevel), Gemini 2.5 a budget of tokens (thinkingBudget: 0 turns it off on Flash; a
// Pro model takes no less than 128; -1 = dynamic). Null: nothing is sent, the model keeps its default.
function _geminiThinking(model, level) {
  if (!level) return null;
  const id = String(model || '').replace(/^models\//, '').trim().toLowerCase();
  const m = /^gemini-(\d+)(?:\.(\d+))?/.exec(id);
  if (!m) return null;
  const major = parseInt(m[1], 10), minor = parseInt(m[2] || '0', 10);
  if (major >= 3) return { thinkingLevel: level };
  if (major === 2 && minor >= 5) {
    if (level === 'minimal') return { thinkingBudget: /pro/.test(id) ? 128 : 0 };
    return { thinkingBudget: level === 'low' ? 1024 : -1 };
  }
  return null;
}
// What to try when a model answers 400 to a level: 'minimal' falls back to 'low' (never straight to
// the model's own default, which reasons the most), 'low' to no setting at all.
const _THINKING_FALLBACK = { minimal: 'low', low: null, high: null };
// The levels a model refused (model + '|' + level): not sent to it again (this page's life).
const _REFUSED = new Set();

class GeminiClient {
  constructor(profile, model, apiKey) {
    this.apiKey = apiKey ? String(apiKey).trim() : '';
    const id = String(model || 'gemini-2.5-flash').replace(/^models\//, '').trim();
    this.model = RETIRED_MODELS[id] || id;
    this.name = profile.name || 'Google Gemini';
    this.url = baseUrlOf(profile) + '/models/' + encodeURIComponent(this.model) + ':generateContent';
  }

  async complete(prompt, systemPrompt, options = {}) {
    if (!this.apiKey) throw _err('NO_KEY', 'Falta la clave de API de ' + this.name + '.');
    const payload = {
      contents: [{ role: 'user', parts: [{ text: String(prompt || '') }] }],
      generationConfig: { maxOutputTokens: options.maxTokens || DEFAULT_MAX_TOKENS }
    };
    // Temperature only where the model takes it. 0 is a valid value.
    if (_geminiTakesTemperature(this.model)) {
      payload.generationConfig.temperature = options.temperature !== undefined ? options.temperature : 0.7;
    }
    if (systemPrompt) payload.systemInstruction = { parts: [{ text: String(systemPrompt) }] };

    let level = options.thinking || null;
    while (level && _REFUSED.has(this.model + '|' + level)) level = _THINKING_FALLBACK[level] || null;
    const thinking = _geminiThinking(this.model, level);
    if (thinking) payload.generationConfig.thinkingConfig = thinking;

    const send = () => _send(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
      body: JSON.stringify(payload),
      signal: options.signal
    }, this.name);
    let res = await send();

    // A 400 to a request that carried a thinking setting: once more with the next level down, as long
    // as there is one. A level refused this way is not sent to this model again.
    while (res.status === 400 && level && payload.generationConfig.thinkingConfig) {
      _REFUSED.add(this.model + '|' + level);
      level = _THINKING_FALLBACK[level] || null;
      const next = _geminiThinking(this.model, level);
      if (next) payload.generationConfig.thinkingConfig = next;
      else delete payload.generationConfig.thinkingConfig;
      res = await send();
    }

    if (!res.ok) {
      const { detail } = await _readError(res);
      if (res.status === 400 && /api[ _-]?key/i.test(detail)) throw _httpError(401, this.name, detail);
      throw _httpError(res.status, this.name, detail);
    }
    const data = await res.json();
    // Google bills the reasoning (thoughtsTokenCount) as output too.
    const u = data.usageMetadata || {};
    _report(options, {
      input: u.promptTokenCount || 0,
      cached: u.cachedContentTokenCount || 0,
      output: u.candidatesTokenCount || 0,
      thoughts: u.thoughtsTokenCount || 0
    });
    const cand = data.candidates && data.candidates[0];
    const parts = (cand && cand.content && Array.isArray(cand.content.parts)) ? cand.content.parts : [];
    const text = parts.filter(p => p && typeof p.text === 'string' && !p.thought).map(p => p.text).join('');
    const reason = (cand && cand.finishReason) || '';
    if (data.promptFeedback && data.promptFeedback.blockReason) throw _refused(this.name, data.promptFeedback.blockReason);
    if (/^(SAFETY|PROHIBITED_CONTENT|BLOCKLIST|SPII|RECITATION)$/.test(reason)) throw _refused(this.name, reason);
    if (reason === 'MAX_TOKENS') throw _truncated(this.name, text);
    if (!text) throw _empty(this.name, reason);
    return text;
  }
}

// ------------------------------------------------------------------ OpenAI style (Mistral, compatible)

// Parameters a model refused with a 400 (model + '|' + what): not sent to it again. OpenAI's
// reasoning models want max_completion_tokens instead of max_tokens and take no temperature.
const _OAI_REFUSED = new Set();

class OpenAIStyleClient {
  constructor(profile, model, apiKey, kind) {
    this.kind = kind;                        // 'mistral' | 'openai-compatible'
    this.apiKey = apiKey ? String(apiKey).trim() : '';
    this.model = String(model || '').trim();
    this.name = profile.name || (kind === 'mistral' ? 'Mistral' : 'Proveedor compatible con OpenAI');
    this.base = baseUrlOf(profile);
    // A local provider (Ollama, llama.cpp...) may need no key at all.
    this.keyOptional = kind === 'openai-compatible' && profile.trust === 'local';
  }

  // Tolerant endpoint: a pasted full path (.../chat/completions) is kept, otherwise it is added.
  _endpoint() {
    if (/\/chat\/completions\/?$/.test(this.base)) return this.base.replace(/\/+$/, '');
    return this.base + '/chat/completions';
  }

  async complete(prompt, systemPrompt, options = {}) {
    if (!this.apiKey && !this.keyOptional) throw _err('NO_KEY', 'Falta la clave de API de ' + this.name + '.');
    if (!this.base) throw _err('NO_URL', 'Falta la direcci\u00f3n base de ' + this.name + '.');
    if (!this.model) throw _err('NO_MODEL', 'Falta el nombre del modelo de ' + this.name + '.');

    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: String(systemPrompt) });
    messages.push({ role: 'user', content: String(prompt || '') });
    const payload = { model: this.model, messages };
    const maxT = options.maxTokens || DEFAULT_MAX_TOKENS;
    const temp = options.temperature !== undefined ? options.temperature : 0.7;
    const tag = (what) => this.base + '|' + this.model + '|' + what;
    const build = () => {
      delete payload.max_tokens; delete payload.max_completion_tokens; delete payload.temperature;
      if (_OAI_REFUSED.has(tag('max_tokens'))) payload.max_completion_tokens = maxT;
      else payload.max_tokens = maxT;
      if (!_OAI_REFUSED.has(tag('temperature'))) payload.temperature = temp;
    };
    build();

    const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
    if (this.apiKey) headers.Authorization = 'Bearer ' + this.apiKey;
    const send = () => _send(this._endpoint(), {
      method: 'POST', headers, body: JSON.stringify(payload), signal: options.signal
    }, this.name);

    let res = await send();
    // A 400 that names one of the two parameters some models refuse: once more without it.
    for (let i = 0; i < 2 && res.status === 400; i++) {
      const { detail } = await _readError(res.clone());
      let changed = false;
      if (/max_tokens/.test(detail) && !_OAI_REFUSED.has(tag('max_tokens'))) { _OAI_REFUSED.add(tag('max_tokens')); changed = true; }
      else if (/temperature/i.test(detail) && !_OAI_REFUSED.has(tag('temperature'))) { _OAI_REFUSED.add(tag('temperature')); changed = true; }
      if (!changed) break;
      build();
      res = await send();
    }

    if (!res.ok) {
      const { detail } = await _readError(res);
      throw _httpError(res.status, this.name, detail);
    }
    const data = await res.json();
    _report(options, _openaiUsage(data));
    const choice = data.choices && data.choices[0];
    const content = choice && choice.message && choice.message.content;
    const text = Array.isArray(content)
      ? content.map(c => (c && typeof c.text === 'string') ? c.text : '').join('')
      : (typeof content === 'string' ? content : '');
    const reason = (choice && choice.finish_reason) || '';
    // Some providers (OpenRouter among them) answer 200 with an error inside.
    const inner = (data.error && data.error.message) || (choice && choice.error && choice.error.message);
    if (!text && inner) throw _err('HTTP_200_ERROR', 'Error de ' + this.name + ': ' + inner);
    if (reason === 'content_filter') throw _refused(this.name, 'filtro de contenido');
    if (reason === 'length') throw _truncated(this.name, text);
    if (!text) throw _empty(this.name, reason);
    return text;
  }
}

// ------------------------------------------------------------------ Azure OpenAI (from COMeT)

class AzureClient {
  constructor(profile, model, apiKey) {
    this.apiKey = apiKey ? String(apiKey).trim() : '';
    this.endpoint = baseUrlOf(profile);
    // The model of an Azure profile IS its deployment (the profile's deployment by default).
    this.deployment = String(model || profile.deployment || '').trim();
    this.model = this.deployment;
    this.apiVersion = String(profile.apiVersion || AZURE_API_VERSION).trim();
    this.name = profile.name || 'Azure OpenAI';
  }

  async complete(prompt, systemPrompt, options = {}) {
    if (!this.apiKey) throw _err('NO_KEY', 'Falta la clave de API de ' + this.name + '.');
    if (!this.endpoint) throw _err('NO_URL', 'Falta el endpoint de ' + this.name + '.');
    if (!this.deployment) throw _err('NO_MODEL', 'Falta el nombre del deployment de ' + this.name + '.');
    const url = this.endpoint + '/openai/deployments/' + encodeURIComponent(this.deployment) +
      '/chat/completions?api-version=' + encodeURIComponent(this.apiVersion);
    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: String(systemPrompt) });
    messages.push({ role: 'user', content: String(prompt || '') });
    // As COMeT: only the messages (a reasoning deployment refuses temperature and max_tokens).
    const res = await _send(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': this.apiKey },
      body: JSON.stringify({ messages }),
      signal: options.signal
    }, this.name);
    if (!res.ok) {
      const { detail } = await _readError(res);
      if (res.status === 404) {
        throw _err('HTTP_404', 'Deployment "' + this.deployment + '" no encontrado (404). Revisa el nombre y el endpoint.', { status: 404, detail });
      }
      throw _httpError(res.status, this.name, detail);
    }
    const data = await res.json();
    _report(options, _openaiUsage(data));
    const choice = data.choices && data.choices[0];
    const text = choice && choice.message && typeof choice.message.content === 'string' ? choice.message.content : '';
    const reason = (choice && choice.finish_reason) || '';
    if (reason === 'content_filter') throw _refused(this.name, 'filtro de contenido de Azure');
    if (reason === 'length') throw _truncated(this.name, text);
    if (!text) throw _empty(this.name, reason);
    return text;
  }
}

// ------------------------------------------------------------------ Anthropic (new)

// Version of a Claude model id: 'claude-sonnet-5-5' -> [5, 5]; 'claude-3-5-sonnet-...' -> [3, 5].
function _claudeVersion(model) {
  const id = String(model || '').toLowerCase();
  let m = /^claude-(?:[a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-|$)/.exec(id);
  if (!m) m = /^claude-(\d+)(?:-(\d{1,2}))?(?:-|$)/.exec(id);
  if (!m) return null;
  return [parseInt(m[1], 10), parseInt(m[2] || '0', 10)];
}

// Sampling parameters were removed on the Claude 4.7+ and 5.x models (a 400 if sent).
function _claudeTakesTemperature(model) {
  const v = _claudeVersion(model);
  if (!v) return false;
  return v[0] < 4 || (v[0] === 4 && v[1] <= 6);
}

// Effort (output_config.effort) controls how much the model thinks on the current models: Opus 4.5+,
// the 4.6+ family and every 5.x model. UMBRA's 'minimal' is the lowest effort there is.
function _claudeEffort(model, level) {
  if (!level) return null;
  const v = _claudeVersion(model);
  if (!v) return null;
  const opus45 = /opus/.test(String(model)) && v[0] === 4 && v[1] === 5;
  if (!(v[0] >= 5 || (v[0] === 4 && v[1] >= 6) || opus45)) return null;
  return level === 'high' ? 'high' : 'low';
}

const _CLAUDE_REFUSED = new Set();

class AnthropicClient {
  constructor(profile, model, apiKey) {
    this.apiKey = apiKey ? String(apiKey).trim() : '';
    this.model = String(model || '').trim();
    this.name = profile.name || 'Anthropic';
    this.url = baseUrlOf(profile) + '/messages';
  }

  async complete(prompt, systemPrompt, options = {}) {
    if (!this.apiKey) throw _err('NO_KEY', 'Falta la clave de API de ' + this.name + '.');
    if (!this.model) throw _err('NO_MODEL', 'Falta el nombre del modelo de ' + this.name + '.');
    const payload = {
      model: this.model,
      max_tokens: options.maxTokens || DEFAULT_MAX_TOKENS,
      messages: [{ role: 'user', content: String(prompt || '') }]
    };
    if (systemPrompt) payload.system = String(systemPrompt);
    if (_claudeTakesTemperature(this.model) && options.temperature !== undefined) payload.temperature = options.temperature;
    const effort = _CLAUDE_REFUSED.has(this.model + '|effort') ? null : _claudeEffort(this.model, options.thinking || null);
    if (effort) payload.output_config = { effort };

    const send = () => _send(this.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify(payload),
      signal: options.signal
    }, this.name);
    let res = await send();
    // A model that refuses the effort setting: once more without it (and not again this page's life).
    if (res.status === 400 && payload.output_config) {
      const { detail } = await _readError(res.clone());
      if (/effort|output_config/i.test(detail)) {
        _CLAUDE_REFUSED.add(this.model + '|effort');
        delete payload.output_config;
        res = await send();
      }
    }
    if (!res.ok) {
      const { detail } = await _readError(res);
      throw _httpError(res.status, this.name, detail);
    }
    const data = await res.json();
    // input_tokens counts only the uncached part: every token sent = uncached + cache reads + cache
    // writes. output_tokens includes the thinking, which Anthropic does not report apart.
    const u = data.usage || {};
    const cachedRead = u.cache_read_input_tokens || 0;
    _report(options, {
      input: (u.input_tokens || 0) + cachedRead + (u.cache_creation_input_tokens || 0),
      cached: cachedRead,
      output: u.output_tokens || 0,
      thoughts: 0
    });
    const blocks = Array.isArray(data.content) ? data.content : [];
    const text = blocks.filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('');
    const reason = data.stop_reason || '';
    if (reason === 'refusal') {
      const cat = data.stop_details && data.stop_details.category;
      throw _refused(this.name, cat ? 'categor\u00eda ' + cat : 'negativa del modelo');
    }
    if (reason === 'max_tokens') throw _truncated(this.name, text);
    if (!text) throw _empty(this.name, reason);
    return text;
  }
}

// ------------------------------------------------------------------ public API

/**
 * A client for one profile and model. apiKey may be '' for a local OpenAI-compatible provider.
 * Throws err.code 'BAD_ADAPTER' for an unknown adapter.
 */
export function createClient(profile, modelId, apiKey) {
  const p = profile || {};
  let impl;
  switch (p.adapter) {
    case 'gemini': impl = new GeminiClient(p, modelId, apiKey); break;
    case 'mistral': impl = new OpenAIStyleClient(Object.assign({}, p, { baseUrl: p.baseUrl || DEFAULT_BASE.mistral }), modelId || 'mistral-large-latest', apiKey, 'mistral'); break;
    case 'azure-openai': impl = new AzureClient(p, modelId, apiKey); break;
    case 'anthropic': impl = new AnthropicClient(p, modelId, apiKey); break;
    case 'openai-compatible': impl = new OpenAIStyleClient(p, modelId, apiKey, 'openai-compatible'); break;
    default: throw _err('BAD_ADAPTER', 'Tipo de proveedor desconocido: ' + String(p.adapter || '(vac\u00edo)') + '.');
  }
  return {
    name: impl.name,
    model: impl.model,
    adapter: p.adapter,
    providerId: p.id || '',
    complete: (prompt, system, opts) => impl.complete(prompt, system, opts || {})
  };
}

/** Is the origin of `url` reachable at all (a no-cors probe: an opaque answer still means "it is there")? */
async function _reachable(url) {
  let origin = '';
  try { origin = new URL(url).origin + '/'; } catch (_) { return false; }
  try {
    const opts = { mode: 'no-cors', cache: 'no-store' };
    if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) opts.signal = AbortSignal.timeout(8000);
    await fetch(origin, opts);
    return true;
  } catch (_) {
    return false;
  }
}

function _probeUrl(profile, modelId) {
  const p = profile || {};
  if (p.adapter === 'gemini') return baseUrlOf(p) + '/models/' + encodeURIComponent(modelId || '') + ':generateContent';
  if (p.adapter === 'anthropic') return baseUrlOf(p) + '/messages';
  return baseUrlOf(p) || DEFAULT_BASE.mistral;
}

/**
 * Sends a tiny request ("answer OK"). -> { ok, message, code?, cors? } with a Spanish message.
 * opts: { onUsage, timeoutMs }. On a network failure it probes the address to tell apart "the
 * provider does not accept calls from web pages (CORS)" (cors: true) from "no connection".
 */
export async function testConnection(profile, modelId, apiKey, opts) {
  const o = opts || {};
  const p = profile || {};
  const model = String(modelId || (p.models && p.models[0] && p.models[0].id) || p.deployment || '').trim();
  const label = (p.name || adapterLabel(p.adapter)) + (model ? ' (' + model + ')' : '');
  const keyOptional = p.adapter === 'openai-compatible' && p.trust === 'local';
  if (!apiKey && !keyOptional) return { ok: false, code: 'NO_KEY', message: 'Falta la clave de API de ' + (p.name || 'este proveedor') + '.' };
  let signal;
  try { if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) signal = AbortSignal.timeout(o.timeoutMs || 60000); } catch (_) {}
  try {
    const client = createClient(p, model, apiKey);
    // Room to answer: a model that reasons first spends tokens thinking before it writes anything.
    const text = await client.complete('Responde solo con la palabra OK.', null, {
      maxTokens: p.adapter === 'anthropic' ? 1024 : 256, temperature: 0, thinking: 'minimal',
      onUsage: o.onUsage, signal
    });
    return { ok: true, message: 'Conexi\u00f3n correcta con ' + label + '. Ha respondido: "' + String(text).trim().slice(0, 40) + '".' };
  } catch (e) {
    const code = (e && e.code) || 'ERROR';
    if (code === 'TRUNCATED') {
      return { ok: true, message: 'Conexi\u00f3n correcta con ' + label + ' (la respuesta de prueba se cort\u00f3 por el l\u00edmite de tokens, pero el proveedor responde).' };
    }
    if (code === 'NETWORK') {
      const reach = await _reachable(_probeUrl(p, model));
      if (reach) {
        return { ok: false, code, cors: true, message: 'No acepta llamadas desde la web: ' + label + ' responde, pero rechaza las llamadas ' +
          'que hace una p\u00e1gina web (CORS). Usa ese modelo a trav\u00e9s de otro proveedor o pon una "URL de puente" propia en el perfil.' };
      }
      return { ok: false, code, cors: false, message: 'No se ha podido conectar con ' + label + ': no hay conexi\u00f3n, la direcci\u00f3n es incorrecta ' +
        'o el servidor no responde. Si la direcci\u00f3n es correcta, puede que el proveedor no acepte llamadas desde una p\u00e1gina web (CORS).' };
    }
    return { ok: false, code, message: (e && e.message) || String(e) };
  }
}

// For tests: the pure rules.
export const _internals = { _geminiTakesTemperature, _geminiThinking, _claudeVersion, _claudeTakesTemperature, _claudeEffort };

// Shared low-level helpers for the batch (ai/batch.js) and embeddings (ai/embeddings.js) modules,
// so they speak to each provider exactly like the clients above.
export const _http = {
  send: _send, readError: _readError, httpError: _httpError, err: _err, base: baseUrlOf,
  DEFAULT_BASE, DEFAULT_MAX_TOKENS, RETIRED_MODELS,
  geminiThinking: _geminiThinking, geminiTakesTemperature: _geminiTakesTemperature,
  claudeEffort: _claudeEffort, claudeTakesTemperature: _claudeTakesTemperature, openaiUsage: _openaiUsage
};
