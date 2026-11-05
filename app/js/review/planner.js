/**
 * planner.js - Turns "run these modules" into a PLAN of AI calls, with its estimated cost, before
 * anything is spent:
 *   - only units that need it (no separators, no units with nothing but tags or figures);
 *   - identical pairs reviewed once (duplicates get a copy of the results);
 *   - results cache: a unit already reviewed with the same text, prompt and model is skipped;
 *   - fusion: modules with the same input and the same model share ONE call per batch;
 *   - batches cut by words and, when possible, at section boundaries;
 *   - cascade: the strong ("deep") model only sees what the economical one flagged (estimated here at
 *     25 % of the units, decided at run time).
 */

import { AI_MODULES, moduleById } from './module-list.js';
import { unitSrcMasked, unitTgtMasked, reviewableUnits } from './session.js';
import { systemPrompt, promptVersion, TASKS } from './prompts.js';
import { fnv1a } from '../util/crypto.js';
import { idbGet } from '../store/idb.js';
import { resolveClient } from '../ai/registry.js';
import { estimateCost } from '../ai/usage.js';
import { buildSkeleton } from './skeleton.js';
import { namesRows, namesTableText } from './names.js';

const TOK = (s) => Math.ceil(String(s || '').length / 3.8);
const WORDS = (s) => (String(s || '').match(/\S+/g) || []).length;
const FUSABLE = [['fidelity', 'integrity'], ['grammar', 'style']];

export function unitKey(session, u, input) {
  const s = input === 'bilingual' ? unitSrcMasked(session, u) : '';
  return fnv1a(s + '\u0001' + unitTgtMasked(session, u));
}

export function cacheKey(moduleId, pv, rh, modelId, uKey) {
  return 'c:' + moduleId + ':' + pv + ':' + rh + ':' + modelId + ':' + uKey;
}

function _reviewText(session, u, input) {
  const t = unitTgtMasked(session, u);
  if (!t.trim()) return null;
  // Nothing but tags, figures and punctuation: nothing for an AI to review.
  if (!/\p{L}{2,}/u.test(t.replace(/\{[^}]*\}/g, ''))) return null;
  return t;
}

/**
 * makePlan(session, ctx, opts) -> plan
 * ctx = { prompts (store), cfg (module config) }
 * opts = { modules:[ids], unitFilter:Set(idx)|null, changedOnly:bool }
 */
export async function makePlan(session, ctx, opts) {
  const wanted = (opts.modules || []).filter(id => moduleById(id) && moduleById(id).ai && id !== 'verifier');
  const plan = { groups: [], skeleton: [], names: null, verify: null, totals: { calls: 0, inTok: 0, outTok: 0, cost: 0, cached: 0, dups: 0, units: 0 },
    errors: [], session };
  const units = reviewableUnits(session).filter(u => !opts.unitFilter || opts.unitFilter.has(u.idx));

  // Resolve models first: fusion only between modules that use the same triage model.
  const models = {};
  for (const id of wanted) {
    try {
      const tri = await resolveClient(id, moduleById(id).roles.includes('triage') ? 'triage' : 'deep');
      let deep = null;
      if (moduleById(id).roles.includes('deep')) {
        try {
          const d = await resolveClient(id, 'deep');
          if (d && !d.fallback && (d.providerId !== tri.providerId || d.modelId !== tri.modelId)) deep = d;
        } catch (_) { deep = null; }
      }
      models[id] = { tri, deep };
    } catch (e) {
      plan.errors.push({ module: id, message: e.message, code: e.code });
    }
  }

  const done = new Set();
  const groupsSpec = [];
  for (const id of wanted) {
    if (done.has(id) || !models[id]) continue;
    const input = moduleById(id).input;
    if (input === 'skeleton') { done.add(id); plan.skeleton.push(id); continue; }
    if (input === 'names') { done.add(id); continue; }
    let mates = [id];
    const fuse = FUSABLE.find(f => f.includes(id));
    if (fuse && ctx.cfg[id] && ctx.cfg[id].merge !== false) {
      for (const other of fuse) {
        if (other === id || done.has(other) || !wanted.includes(other) || !models[other]) continue;
        if (ctx.cfg[other] && ctx.cfg[other].merge === false) continue;
        const a = models[id].tri, b = models[other].tri;
        const sameDeep = (models[id].deep ? models[id].deep.modelId : '') === (models[other].deep ? models[other].deep.modelId : '');
        if (a.providerId === b.providerId && a.modelId === b.modelId && sameDeep) mates.push(other);
      }
    }
    mates.forEach(m => done.add(m));
    groupsSpec.push(mates);
  }

  for (const mates of groupsSpec) {
    const input = moduleById(mates[0]).input;
    const tri = models[mates[0]].tri;
    const deep = models[mates[0]].deep;
    const system = systemPrompt(ctx.prompts, mates, session.srcLang, ctx.cfg);
    const rh = 'v2';
    const pv = {};
    for (const m of mates) pv[m] = promptVersion(ctx.prompts, [m], ctx.cfg);

    // Units to send: skip cached (for every module of the group) and duplicates.
    const seen = new Map();
    const items = [];
    const dupOf = new Map();
    const cachedHits = [];
    for (const u of units) {
      if (input === 'bilingual' && u.srcPara === null) continue;
      if (u.tgtPara === null) continue;
      const text = _reviewText(session, u, input);
      if (!text) continue;
      const uk = unitKey(session, u, input);
      if (seen.has(uk)) { dupOf.set(u.idx, seen.get(uk)); plan.totals.dups++; continue; }
      seen.set(uk, u.idx);
      let allCached = true;
      const hits = {};
      for (const m of mates) {
        const ck = cacheKey(m, pv[m], rh, tri.modelId, uk);
        let hit = null;
        try { hit = await idbGet('cache', ck); } catch (_) { hit = null; }
        if (hit) hits[m] = hit; else allCached = false;
      }
      if (allCached) { cachedHits.push({ unit: u.idx, hits }); plan.totals.cached++; continue; }
      items.push({ u, uk, words: WORDS(text) + (input === 'bilingual' ? WORDS(unitSrcMasked(session, u)) : 0) });
    }

    // Batches by words, cut preferably at section boundaries.
    const cfgWords = Math.max(...mates.map(m => (ctx.cfg[m] && ctx.cfg[m].batchWords) || 0));
    // Moderate batches: the answer (and the reasoning of models that think first) must fit in the
    // output limit, and a model reviews a short batch more carefully than a long one.
    const limit = cfgWords || (input === 'bilingual' ? 1100 : 1800);
    const maxUnits = 30;
    const batches = [];
    let cur = [], words = 0;
    for (const it of items) {
      const newSection = cur.length && it.u.section !== cur[cur.length - 1].u.section && words > limit * 0.5;
      if (cur.length && (words + it.words > limit || cur.length >= maxUnits || newSection)) { batches.push(cur); cur = []; words = 0; }
      cur.push(it);
      words += it.words;
    }
    if (cur.length) batches.push(cur);

    const group = { modules: mates, input, tri, deep, system, rh, pv, batches: [], dupOf, cachedHits,
      est: { inTok: 0, outTok: 0, cost: 0, calls: 0 } };
    for (const b of batches) {
      const user = buildBatchUser(session, b.map(x => x.u), input);
      const inTok = TOK(system) + TOK(user);
      const outTok = 25 + Math.ceil(b.length * 0.35) * 45 * mates.length;
      group.batches.push({ items: b, user, inTok, outTok });
      group.est.inTok += inTok;
      group.est.outTok += outTok;
      group.est.calls++;
    }
    // Prefix cache: the system part is paid in full once, discounted afterwards (rough: 25 %).
    const sysTok = TOK(system);
    const cachedTok = Math.max(0, group.est.calls - 1) * sysTok;
    group.est.cost = await _cost(tri, group.est.inTok, group.est.outTok, cachedTok);
    if (deep) {
      const dIn = Math.ceil(group.est.inTok * 0.25) + sysTok, dOut = Math.ceil(group.est.outTok * 0.4);
      group.est.deep = { inTok: dIn, outTok: dOut, cost: await _cost(deep, dIn, dOut, 0) };
      group.est.cost += group.est.deep.cost;
      group.est.inTok += dIn;
      group.est.outTok += dOut;
      group.est.calls += Math.max(1, Math.ceil(group.batches.length * 0.25));
    }
    plan.groups.push(group);
    plan.totals.calls += group.est.calls;
    plan.totals.inTok += group.est.inTok;
    plan.totals.outTok += group.est.outTok;
    plan.totals.cost += group.est.cost;
    plan.totals.units += items.length;
  }

  // Skeleton modules: one call each (or nothing when there is nothing to look at).
  const skel = [];
  for (const id of plan.skeleton) {
    const sk = buildSkeleton(session, id);
    if (!sk.text) continue;
    const system = systemPrompt(ctx.prompts, [id], session.srcLang, ctx.cfg);
    const inTok = TOK(system) + TOK(sk.text), outTok = 30 + sk.count * 8;
    const tri = models[id].tri;
    const cost = await _cost(tri, inTok, outTok, 0);
    skel.push({ module: id, tri, system, user: sk.text, units: sk.units, est: { inTok, outTok, cost, calls: 1 } });
    plan.totals.calls++; plan.totals.inTok += inTok; plan.totals.outTok += outTok; plan.totals.cost += cost;
  }
  plan.skeleton = skel;

  // Official names: one call with the table of names only (no text of the document).
  if (wanted.includes('names') && models.names) {
    const rows = namesRows(session);
    if (rows.length) {
      const system = systemPrompt(ctx.prompts, ['names'], session.srcLang, ctx.cfg);
      const inTok = TOK(system) + TOK(namesTableText(rows)), outTok = 30 + Math.ceil(rows.length * 0.3) * 40;
      const tri = models.names.tri;
      const cost = await _cost(tri, inTok, outTok, 0);
      plan.names = { module: 'names', tri, system, rows, est: { inTok, outTok, cost, calls: 1 } };
      plan.totals.calls++; plan.totals.inTok += inTok; plan.totals.outTok += outTok; plan.totals.cost += cost;
    }
  }

  // Verifier: estimated on the expected number of findings (one every four units).
  const verifyMods = wanted.filter(id => ctx.cfg[id] && ctx.cfg[id].verify);
  if (verifyMods.length && ctx.cfg.verifier && ctx.cfg.verifier.enabled !== false) {
    try {
      const v = await resolveClient('verifier', 'deep');
      const expected = Math.ceil(plan.totals.units * 0.25 * verifyMods.length / Math.max(1, wanted.length));
      const inTok = 600 + expected * 160, outTok = 20 + expected * 25;
      const cost = await _cost(v, inTok, outTok, 0);
      plan.verify = { modules: verifyMods, client: v, est: { inTok, outTok, cost, calls: Math.max(1, Math.ceil(expected / 25)) } };
      plan.totals.calls += plan.verify.est.calls; plan.totals.inTok += inTok; plan.totals.outTok += outTok; plan.totals.cost += cost;
    } catch (_) { plan.verify = null; }
  }
  return plan;
}

async function _cost(client, inTok, outTok, cachedTok) {
  try {
    const c = await estimateCost(client.providerId, client.modelId, inTok, outTok, cachedTok || 0);
    return (typeof c === 'number' && isFinite(c)) ? c : 0;
  } catch (_) { return 0; }
}

/** The user part of a batch call: the units, nothing else (the instructions are in the system part). */
export function buildBatchUser(session, units, input) {
  let body = '';
  if (input === 'bilingual') {
    body = 'P\u00c1RRAFOS (O = original, T = traducci\u00f3n):\n' + units.map(u =>
      '[' + u.n + ']\nO: ' + _flat(unitSrcMasked(session, u)) + '\nT: ' + _flat(unitTgtMasked(session, u))).join('\n');
  } else {
    body = 'P\u00c1RRAFOS DE LA TRADUCCI\u00d3N:\n' + units.map(u => '[' + u.n + '] ' + _flat(unitTgtMasked(session, u))).join('\n');
  }
  return body + '\n(FIN ' + units.length + ')';
}

function _flat(s) { return String(s || '').replace(/[\t\r\n]+/g, ' ').replace(/ {2,}/g, ' ').trim(); }

export function moduleCats(moduleId) { return TASKS[moduleId] ? TASKS[moduleId].cats : []; }

export { AI_MODULES };

// ------------------------------------------------------------------ deferred mode (plan kept for later)

/** A plan as plain data (for project.deferred): enough to finish it when the batch answers arrive. */
export function serializePlan(plan) {
  const ref = (c) => c ? { providerId: c.providerId, modelId: c.modelId, name: c.profile ? c.profile.name : '' } : null;
  return {
    v: 1,
    groups: plan.groups.map(g => ({
      modules: g.modules, input: g.input, tri: ref(g.tri), deep: ref(g.deep), system: g.system, rh: g.rh, pv: g.pv,
      batches: g.batches.map(b => ({ units: b.items.map(x => x.u.idx), uks: b.items.map(x => x.uk), words: b.items.map(x => x.words),
        user: b.user, inTok: b.inTok, outTok: b.outTok })),
      dupOf: Array.from(g.dupOf.entries()), est: g.est
    })),
    skeleton: plan.skeleton.map(s => ({ module: s.module, tri: ref(s.tri), system: s.system, user: s.user, units: Array.from(s.units), est: s.est })),
    names: plan.names ? { module: 'names', tri: ref(plan.names.tri), system: plan.names.system, rows: plan.names.rows, est: plan.names.est } : null,
    verify: plan.verify ? { modules: plan.verify.modules, client: ref(plan.verify.client), est: plan.verify.est } : null,
    totals: plan.totals
  };
}

/** The serialized plan, back as a plan runPlan() accepts (cached hits are not replayed). */
export function restorePlan(data, session) {
  const unit = (idx) => session.units[idx];
  return {
    groups: (data.groups || []).map(g => ({
      modules: g.modules, input: g.input, tri: g.tri, deep: g.deep, system: g.system, rh: g.rh, pv: g.pv || {},
      batches: g.batches.map(b => ({ items: b.units.map((idx, k) => ({ u: unit(idx), uk: b.uks[k], words: b.words[k] })).filter(x => x.u),
        user: b.user, inTok: b.inTok, outTok: b.outTok })),
      dupOf: new Map(g.dupOf || []), cachedHits: [], est: g.est || {}
    })),
    skeleton: (data.skeleton || []).map(s => Object.assign({}, s, { units: new Set(s.units) })),
    names: data.names || null,
    verify: data.verify || null,
    totals: data.totals || { calls: 0 },
    errors: []
  };
}

/** Keys of the deferrable calls of a plan, in the order runPlan() makes them. */
export function deferredKeys(plan) {
  const out = [];
  plan.groups.forEach((g, gi) => g.batches.forEach((b, bi) => out.push({ key: 'g' + gi + 'b' + bi, gi, bi, kind: 'batch' })));
  plan.skeleton.forEach((s, si) => out.push({ key: 's' + si, si, kind: 'skel' }));
  return out;
}
