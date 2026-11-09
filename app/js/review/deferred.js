/**
 * deferred.js - Deferred mode: the first pass of a review (the batches of each module) goes to the
 * providers' batch APIs, which answer within minutes or hours (up to 24 h) at about
 * half the price. When the answers arrive, the run is finished here exactly as an immediate one:
 * parsing, anchoring, cache, cascade to the deep model and Verifier (those last two, being small,
 * run at once at the normal price).
 *
 * Kept in the project (IndexedDB), so it survives closing the browser:
 *   project.deferred = [{ id, createdAt, status:'running'|'done'|'failed'|'cancelled', modules, maskSig,
 *     plan (serialized), jobs:[{ kind, id, providerId, model, total, keys, state, done, message, answers? }],
 *     findings, spent, error }]
 */

import { submitDeferred, pollDeferred, fetchDeferred, cancelDeferred, deferredSupport } from '../ai/gateway.js';
import { serializePlan, restorePlan, deferredKeys } from './planner.js';
import { runPlan } from './runner.js';
import { unitSrcMasked, unitTgtMasked } from './session.js';
import { fnv1a } from '../util/crypto.js';
import { uid } from '../util/dom.js';
import { moduleById } from './module-list.js';

export function maskSignature(session) {
  return fnv1a(session.units.map(u => unitSrcMasked(session, u) + '\u0001' + unitTgtMasked(session, u)).join('\u0002'));
}

/**
 * Can this plan go deferred? Every group of batches needs a provider with a batch API.
 * -> { ok, parts:[{ label, ok, kind, provider }], missing:[labels] }
 */
export async function deferredCapability(plan) {
  const parts = [];
  for (const g of plan.groups) {
    if (!g.batches.length) continue;
    const s = await deferredSupport(g.modules[0], 'triage').catch(() => ({ ok: false }));
    parts.push({ label: g.modules.map(id => (moduleById(id) || { label: id }).label).join(' + '), ok: !!s.ok, kind: s.kind, provider: s.profileName });
  }
  return { ok: parts.length > 0 && parts.every(p => p.ok), parts, missing: parts.filter(p => !p.ok).map(p => p.label + ' (' + (p.provider || '?') + ')') };
}

/** Sends the deferrable part of a plan. -> the record added to project.deferred */
export async function startDeferred(plan, ctx) {
  const keys = deferredKeys(plan);
  // One batch job per (module whose model answers): calls are grouped by the module used to resolve
  // the client, so every request of a job goes to the same provider and model.
  const byModule = new Map();
  for (const k of keys) {
    const g = plan.groups[k.gi], b = g.batches[k.bi];
    const module = g.modules[0];
    const req = { key: k.key, prompt: b.user, system: g.system, maxTokens: 8192, thinking: _thinking(ctx.cfg, module) };
    if (!byModule.has(module)) byModule.set(module, []);
    byModule.get(module).push(req);
  }
  const rec = { id: uid('d'), createdAt: Date.now(), status: 'running', modules: Array.from(new Set(plan.groups.flatMap(g => g.modules))),
    maskSig: maskSignature(ctx.session), plan: serializePlan(plan), jobs: [], findings: 0, spent: 0, error: '' };
  const done = [];
  try {
    for (const [module, requests] of byModule) {
      const job = await submitDeferred({ module, role: 'triage', requests, masked: true });
      done.push(job);
      rec.jobs.push({ kind: job.kind, id: job.id, providerId: job.providerId, model: job.model, total: job.total,
        keys: requests.map(r => r.key), module, state: 'running', done: 0, message: 'Enviado' });
    }
  } catch (e) {
    // Do not leave half a review running and billed: cancel what was already sent.
    for (const job of done) { try { await cancelDeferred(job); } catch (_) {} }
    throw e;
  }
  return rec;
}

function _thinking(cfg, moduleId) {
  const t = cfg && cfg[moduleId] && cfg[moduleId].thinking;
  return t || null;
}

/**
 * Polls the jobs of one record; when all of them have answered, finishes the review.
 * hooks = { onProgress, onFindings, localFlags, project:{ name, file } }
 * -> { changed, finished, result? }  (the caller saves the project when changed)
 */
export async function checkDeferred(rec, ctx, hooks) {
  if (rec.status !== 'running') return { changed: false, finished: false };
  let changed = false;
  for (const j of rec.jobs) {
    if (j.state === 'done' && j.answers) continue;
    if (j.state === 'failed' || j.state === 'cancelled' || j.state === 'expired') continue;
    let st;
    try { st = await pollDeferred(j); } catch (e) { j.message = 'No se pudo consultar: ' + e.message; changed = true; continue; }
    if (st.state !== j.state || st.done !== j.done) changed = true;
    j.state = st.state; j.done = st.done || 0;
    j.message = ({ running: 'En proceso en el proveedor', done: 'Respuestas recibidas', failed: 'Fallido', cancelled: 'Cancelado', expired: 'Caducado (24 h)' }[st.state] || '') +
      (st.message ? ' (' + st.message + ')' : '');
    if (st.total) j.total = st.total;
    if (st.state === 'done' && !j.answers) {
      const res = await fetchDeferred(j, st, (key) => ({ module: _moduleOfKey(rec, key), project: hooks.project && hooks.project.name, file: hooks.project && hooks.project.file }));
      j.answers = {};
      for (const [k, v] of res) j.answers[k] = { text: v.text || '', error: v.error || '', truncated: !!v.truncated };
      rec.spent += res.cost || 0;
      changed = true;
    }
  }
  const allEnded = rec.jobs.every(j => ['done', 'failed', 'cancelled', 'expired'].includes(j.state) && (j.state !== 'done' || j.answers));
  if (!allEnded) return { changed, finished: false };
  if (rec.jobs.every(j => j.state !== 'done')) {
    rec.status = rec.jobs.some(j => j.state === 'cancelled') ? 'cancelled' : 'failed';
    rec.error = rec.jobs.map(j => j.message).filter(Boolean).join(' \u00b7 ');
    return { changed: true, finished: true };
  }
  // Finish the review with the answers (the cascade and the Verifier run now).
  const prefetched = new Map();
  for (const j of rec.jobs) for (const k of Object.keys(j.answers || {})) prefetched.set(k, j.answers[k]);
  const plan = restorePlan(rec.plan, ctx.session);
  const result = await runPlan(plan, Object.assign({}, ctx, { project: hooks.project }), {
    prefetched, localFlags: hooks.localFlags, onProgress: hooks.onProgress, onFindings: hooks.onFindings
  });
  rec.status = 'done';
  rec.findings = (result.findings || []).filter(f => f.state !== 'discarded').length;
  rec.spent += result.spent || 0;
  rec.stale = rec.maskSig !== maskSignature(ctx.session);
  rec.finishedAt = Date.now();
  return { changed: true, finished: true, result };
}

function _moduleOfKey(rec, key) {
  const m = /^g(\d+)b\d+$/.exec(key);
  if (m) { const g = rec.plan.groups[+m[1]]; return g ? g.modules.join('+') : 'other'; }
  return 'other';
}

export async function cancelDeferredRecord(rec) {
  for (const j of rec.jobs) {
    if (j.state !== 'running') continue;
    try { await cancelDeferred(j); j.state = 'cancelled'; j.message = 'Cancelado'; } catch (e) { j.message = 'No se pudo cancelar: ' + e.message; }
  }
  rec.status = 'cancelled';
}

export const DEFERRED_STATUS = { running: 'En curso', done: 'Terminado', failed: 'Fallido', cancelled: 'Cancelado' };
