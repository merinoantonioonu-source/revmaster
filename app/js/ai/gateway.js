/**
 * gateway.js - The one door every AI call of UMBRA goes through.
 *
 * Origin: COMeT services/ai-service.js @ 04540f5 (adapted)  (complete() + usage record)
 *
 * callAI() resolves the module's provider and model (registry.js: the module's role, its other role,
 * the general choice, the first provider with a key), REFUSES text that has not been masked unless
 * the caller allows it AND the provider is local (trust 'local'), calls the provider and records what
 * the call used (usage.js) - also when the provider cut the answer short (TRUNCATED), because those
 * tokens were spent too.
 */

import { resolveClient, getProvider, getApiKey } from './registry.js';
import { recordUsage, costOf, priceFor, BATCH_SUFFIX } from './usage.js';
import { batchKind, submitBatch, pollBatch, batchResults, cancelBatch } from './batch.js';

export const DEFAULT_TEMPERATURE = 0.2;

function _err(code, message, extra) {
  const e = new Error(message);
  e.code = code;
  if (extra) Object.assign(e, extra);
  return e;
}

const UNMASKED_MSG = 'El texto no est\u00e1 enmascarado: solo un proveedor local (de confianza "Local") puede recibirlo. ' +
  'Enmascara el documento o elige un proveedor local para este m\u00f3dulo.';

/** Rough token count of a text (characters / 3.8, as COMeT estimates). */
export function estimateTokens(text) {
  const s = String(text || '');
  return s ? Math.ceil(s.length / 3.8) : 0;
}

/**
 * callAI({ module, role, prompt, system, masked, allowUnmasked, project, file, words, thinking,
 *          maxTokens, temperature, signal })
 *   -> { text, usage, providerId, modelId, cost, fallback, source, wanted }
 * role: 'triage' (default) | 'deep'. masked must be true unless allowUnmasked === true and the
 * provider is local. Errors carry err.code: 'UNMASKED', 'NO_PROVIDER', and the providers' codes
 * (NETWORK, HTTP_401, HTTP_429, TRUNCATED with err.partial...), plus err.providerId / err.modelId.
 */
export async function callAI(opts) {
  const o = opts || {};
  // Refused before anything else when the caller did not even ask for a local provider.
  if (o.masked !== true && o.allowUnmasked !== true) throw _err('UNMASKED', UNMASKED_MSG);
  const r = await resolveClient(o.module || '', o.role || 'triage');
  if (o.masked !== true && !(o.allowUnmasked === true && r.trust === 'local')) {
    throw _err('UNMASKED', UNMASKED_MSG, { providerId: r.providerId, modelId: r.modelId });
  }

  let usage = null;
  const onUsage = (u) => { usage = u; };
  const record = () => recordUsage({
    module: o.usageModule || o.module || '', provider: r.providerId, model: r.modelId,
    usage: usage || { input: 0, cached: 0, output: 0, thoughts: 0 },
    project: o.project || '', file: o.file || '', words: o.words || 0
  });

  let text;
  try {
    text = await r.client.complete(String(o.prompt || ''), o.system || '', {
      temperature: o.temperature !== undefined ? o.temperature : DEFAULT_TEMPERATURE,
      maxTokens: o.maxTokens,
      thinking: o.thinking || null,
      onUsage,
      signal: o.signal
    });
  } catch (e) {
    // Tokens the provider reported are spent even when the answer is unusable.
    if (usage) { try { await record(); } catch (_) {} }
    if (e && typeof e === 'object') { e.providerId = r.providerId; e.modelId = r.modelId; }
    throw e;
  }

  let cost = await record();
  if (cost === undefined) {
    try { cost = costOf(usage || {}, await priceFor(r.providerId, r.modelId)); } catch (_) { cost = null; }
  }
  return {
    text,
    usage: usage || { input: 0, cached: 0, output: 0, thoughts: 0 },
    providerId: r.providerId,
    modelId: r.modelId,
    cost: (typeof cost === 'number') ? cost : null,
    fallback: !!r.fallback,
    source: r.source,
    wanted: r.wanted || null
  };
}

// ------------------------------------------------------------------ deferred batches (-50 %)

/** Can this module role run as a deferred batch? -> { ok, kind, providerId, modelId, profileName } */
export async function deferredSupport(module, role) {
  const r = await resolveClient(module || '', role || 'triage');
  const kind = batchKind(r.profile);
  return { ok: !!kind, kind, providerId: r.providerId, modelId: r.modelId, profileName: (r.profile && r.profile.name) || r.providerId };
}

/**
 * submitDeferred({ module, role, requests:[{ key, prompt, system, maxTokens, thinking }], masked })
 *   -> job { kind, id, model, providerId, submittedAt, total }
 * Same masking rule as callAI: only masked text leaves, unless the provider is local and allowed.
 */
export async function submitDeferred(o) {
  if (o.masked !== true && o.allowUnmasked !== true) throw _err('UNMASKED', UNMASKED_MSG);
  const r = await resolveClient(o.module || '', o.role || 'triage');
  if (o.masked !== true && !(o.allowUnmasked === true && r.trust === 'local')) throw _err('UNMASKED', UNMASKED_MSG);
  const key = await getApiKey(r.providerId);
  const reqs = (o.requests || []).map(q => Object.assign({ temperature: DEFAULT_TEMPERATURE }, q));
  const job = await submitBatch(r.profile, key, r.modelId, reqs);
  return Object.assign(job, { providerId: r.providerId });
}

async function _jobCtx(job) {
  const profile = await getProvider(job.providerId);
  if (!profile) throw _err('NO_PROVIDER', 'El proveedor de este lote ya no existe en Ajustes.');
  return { profile, key: await getApiKey(job.providerId) };
}

export async function pollDeferred(job) {
  const { profile, key } = await _jobCtx(job);
  return pollBatch(job, profile, key);
}

/**
 * The answers of a finished job: Map(key -> { text, usage, error, truncated }). Records the usage
 * of every answer at the batch price (model '<id>#batch'), attributed to the module of its request.
 * usageOf(key) -> { module, project, file, words } tells where each answer belongs.
 */
export async function fetchDeferred(job, last, usageOf) {
  const { profile, key } = await _jobCtx(job);
  const res = await batchResults(job, profile, key, last);
  let cost = 0;
  for (const [k, v] of res) {
    if (!v || !v.usage) continue;
    const where = (usageOf && usageOf(k)) || {};
    try {
      await recordUsage({ module: where.module || 'other', provider: job.providerId, model: job.model + BATCH_SUFFIX,
        usage: v.usage, project: where.project || '', file: where.file || '', words: where.words || 0 });
      const c = costOf(v.usage, await priceFor(job.providerId, job.model + BATCH_SUFFIX));
      if (typeof c === 'number') cost += c;
    } catch (_) {}
  }
  res.cost = cost;
  return res;
}

export async function cancelDeferred(job) {
  const { profile, key } = await _jobCtx(job);
  return cancelBatch(job, profile, key);
}

