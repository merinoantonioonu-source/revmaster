/**
 * runner.js - Executes a plan (planner.js): triage batches, cascade to the deep model, skeleton
 * calls, the Verifier, the results cache and the budget.
 *
 * runPlan(plan, ctx, hooks) -> { findings:[...], spent, calls, errors:[{module, message}], stopped }
 * ctx   = { session, project: { id, name, file }, prompts, cfg, rules }
 * hooks = { onProgress({ done, total, label, module }), onFindings(list), signal, budget (US$, 0 = none) }
 */

import { callAI } from '../ai/gateway.js';
import { idbPut } from '../store/idb.js';
import { parseFindings, parseVerdicts } from './parse.js';
import { anchorItem, sameFinding } from './findings.js';
import { cacheKey, buildBatchUser } from './planner.js';
import { CAT_MODULE, verifierPrompt } from './prompts.js';
import { unitSrcMasked, unitTgtMasked } from './session.js';
import { rehydrate } from '../redact/entities.js';

const DEEP_CATS = { fidelity: ['MIST', 'UNTR'], integrity: ['OMI', 'ADD'] };

export async function runPlan(plan, ctx, hooks) {
  const h = hooks || {};
  const session = ctx.session;
  const unitByN = new Map(session.units.map(u => [u.n, u]));
  const out = { findings: [], spent: 0, calls: 0, errors: [], stopped: false };
  const total = plan.totals.calls || 1;
  let done = 0;
  const progress = (label, module) => { if (h.onProgress) h.onProgress({ done, total, label, module }); };
  const budget = h.budget || 0;

  const call = async (args, est) => {
    if (h.signal && h.signal.aborted) { out.stopped = true; throw Object.assign(new Error('Detenido.'), { code: 'ABORT' }); }
    if (budget && out.spent + (est || 0) > budget) {
      out.stopped = true;
      throw Object.assign(new Error('Se ha alcanzado el presupuesto m\u00e1ximo de esta ejecuci\u00f3n.'), { code: 'BUDGET' });
    }
    const r = await callAI(Object.assign({ masked: true, project: ctx.project && ctx.project.name, file: ctx.project && ctx.project.file,
      signal: h.signal }, args));
    out.spent += r.cost || 0;
    out.calls++;
    done++;
    return r;
  };

  const push = (list) => {
    const fresh = [];
    for (const f of list) {
      if (!f) continue;
      if (out.findings.some(x => sameFinding(x, f))) continue;
      out.findings.push(f);
      fresh.push(f);
    }
    if (fresh.length && h.onFindings) h.onFindings(fresh);
  };

  // Cached results and duplicates first (free).
  for (const g of plan.groups) {
    for (const c of g.cachedHits) {
      const u = session.units[c.unit];
      for (const m of Object.keys(c.hits)) {
        push((c.hits[m].items || []).map(it => anchorItem(Object.assign({}, it, { unit: u.n }),
          { session, unitByN, module: m, source: 'ai', model: c.hits[m].model || '', role: 'cache' })));
      }
    }
  }

  // ---- triage (and deep) per group
  for (const g of plan.groups) {
    if (out.stopped) break;
    const flagged = new Set();
    const groupFindings = [];
    for (const b of g.batches) {
      if (out.stopped) break;
      progress('Lote ' + (g.batches.indexOf(b) + 1) + '/' + g.batches.length, g.modules.join('+'));
      let res;
      try {
        res = await _runBatch(b.items.map(x => x.u), g, g.tri, 'triage', b.user, b.inTok, call, ctx);
      } catch (e) {
        if (e.code === 'BUDGET' || e.code === 'ABORT') break;
        out.errors.push({ module: g.modules.join('+'), message: e.message, code: e.code });
        break;
      }
      for (const [n, items] of res) {
        const u = unitByN.get(n);
        if (!u) continue;
        for (const it of items) {
          const module = g.modules.length === 1 ? g.modules[0] : (CAT_MODULE[it.cat] && g.modules.includes(CAT_MODULE[it.cat]) ? CAT_MODULE[it.cat] : g.modules[0]);
          const f = anchorItem(it, { session, unitByN, module, source: 'ai', model: g.tri.modelId, role: 'triage' });
          if (f) groupFindings.push(f);
          if (g.deep && DEEP_CATS[module] && DEEP_CATS[module].includes(it.cat)) flagged.add(n);
        }
      }
      // Cache per module (an empty list is a result too).
      await _store(g, b.items, res, g.tri.modelId);
    }
    // Cascade: the deep model re-reviews flagged units; its answer replaces the triage findings there.
    if (g.deep && flagged.size && !out.stopped) {
      const unitsDeep = Array.from(flagged).map(n => unitByN.get(n)).filter(Boolean);
      for (let i = 0; i < unitsDeep.length && !out.stopped; i += 20) {
        const chunk = unitsDeep.slice(i, i + 20);
        progress('A fondo ' + (Math.floor(i / 20) + 1), g.modules.join('+'));
        try {
          const user = buildBatchUser(session, chunk, g.input, g.rules);
          const res = await _runBatch(chunk, g, g.deep, 'deep', user, 0, call, ctx);
          const ns = new Set(chunk.map(u => u.n));
          for (let k = groupFindings.length - 1; k >= 0; k--) {
            const f = groupFindings[k];
            if (ns.has(session.units[f.unit].n) && DEEP_CATS[f.module] && DEEP_CATS[f.module].includes(f.cat)) groupFindings.splice(k, 1);
          }
          for (const [n, items] of res) for (const it of items) {
            const module = g.modules.length === 1 ? g.modules[0] : (CAT_MODULE[it.cat] && g.modules.includes(CAT_MODULE[it.cat]) ? CAT_MODULE[it.cat] : g.modules[0]);
            const f = anchorItem(it, { session, unitByN, module, source: 'ai', model: g.deep.modelId, role: 'deep' });
            if (f) groupFindings.push(f);
          }
        } catch (e) {
          if (e.code === 'BUDGET' || e.code === 'ABORT') break;
          out.errors.push({ module: g.modules.join('+'), message: 'A fondo: ' + e.message, code: e.code });
          break;
        }
      }
    }
    // Duplicates receive a copy of their representative's findings.
    for (const [dupIdx, repIdx] of g.dupOf) {
      for (const f of groupFindings.filter(x => x.unit === repIdx)) {
        const copy = anchorItem({ unit: session.units[dupIdx].n, cat: f.cat, sev: f.sev, quote: f.quoteMasked, suggestion: f.suggestionMasked, reason: f.reason },
          { session, unitByN, module: f.module, source: 'ai', model: f.model, role: f.role });
        if (copy) groupFindings.push(copy);
      }
    }
    push(groupFindings);
  }

  // ---- skeleton modules
  for (const s of plan.skeleton) {
    if (out.stopped) break;
    progress('Esqueleto', s.module);
    try {
      const r = await call({ module: s.module, role: 'triage', prompt: s.user, system: s.system, words: 0,
        thinking: _thinking(ctx.cfg, s.module), maxTokens: 4096 }, s.est.cost);
      const parsed = parseFindings(r.text, s.units);
      push(parsed.items.map(it => anchorItem(it, { session, unitByN, module: s.module, source: 'ai', model: r.modelId, role: 'triage' })));
    } catch (e) {
      if (e.code === 'BUDGET' || e.code === 'ABORT') break;
      out.errors.push({ module: s.module, message: e.message, code: e.code });
    }
  }

  // ---- Verifier
  if (plan.verify && !out.stopped) {
    const toVerify = out.findings.filter(f => f.source === 'ai' && plan.verify.modules.includes(f.module) && f.state === 'open' && f.role !== 'cache');
    try {
      await verifyFindings(toVerify, ctx, call, progress);
    } catch (e) {
      if (e.code !== 'BUDGET' && e.code !== 'ABORT') out.errors.push({ module: 'verifier', message: e.message, code: e.code });
    }
  }
  if (h.onProgress) h.onProgress({ done: total, total, label: out.stopped ? 'Detenido' : 'Terminado' });
  return out;
}

function _thinking(cfg, moduleId) {
  const t = cfg && cfg[moduleId] && cfg[moduleId].thinking;
  return t || null;
}

/** One batch: call, parse, re-ask the second half when the answer was cut (no FIN). */
async function _runBatch(units, g, client, role, user, est, call, ctx) {
  const session = ctx.session;
  const valid = new Set(units.map(u => u.n));
  const moduleId = g.modules[0];
  const words = units.reduce((n, u) => n + (unitTgtMasked(session, u).match(/\S+/g) || []).length, 0);
  const r = await call({ module: moduleId, usageModule: g.modules.join('+'), role, prompt: user, system: g.system, words,
    thinking: _thinking(ctx.cfg, moduleId), maxTokens: 8192 }, est ? _estCost(est) : 0);
  const parsed = parseFindings(r.text, valid);
  const res = new Map();
  for (const n of valid) res.set(n, []);
  for (const it of parsed.items) res.get(it.unit).push(it);
  if (parsed.fin === null && units.length > 2) {
    // Cut answer: re-ask the units after the last one mentioned (or the second half).
    const lastMentioned = parsed.items.length ? Math.max(...parsed.items.map(i => i.unit)) : null;
    const rest = units.filter(u => lastMentioned === null ? u.n >= units[Math.floor(units.length / 2)].n : u.n > lastMentioned);
    if (rest.length && rest.length < units.length) {
      const user2 = buildBatchUser(session, rest, g.input, g.rules);
      const r2 = await call({ module: moduleId, usageModule: g.modules.join('+'), role, prompt: user2, system: g.system, words: 0, thinking: _thinking(ctx.cfg, moduleId), maxTokens: 8192 }, 0);
      const p2 = parseFindings(r2.text, new Set(rest.map(u => u.n)));
      for (const u of rest) res.set(u.n, []);
      for (const it of p2.items) res.get(it.unit).push(it);
    }
  }
  return res;
}

function _estCost() { return 0; }

async function _store(g, items, res, modelId) {
  for (const it of items) {
    const list = res.get(it.u.n) || [];
    for (const m of g.modules) {
      const mine = list.filter(x => g.modules.length === 1 || CAT_MODULE[x.cat] === m || (!g.modules.includes(CAT_MODULE[x.cat]) && m === g.modules[0]));
      try {
        await idbPut('cache', cacheKey(m, g.pv[m], g.rh, modelId, it.uk),
          { at: Date.now(), model: modelId, items: mine.map(x => ({ cat: x.cat, sev: x.sev, quote: x.quote, suggestion: x.suggestion, reason: x.reason })) });
      } catch (_) { /* cache is best effort */ }
    }
  }
}

/**
 * Verifier: confirms, edits or discards findings (mutates them: verified 'ok'|'edit'|'no').
 * Also usable on its own (re-verify the open findings).
 */
export async function verifyFindings(findings, ctx, call, progress) {
  const session = ctx.session;
  const list = findings.filter(f => f.unit !== undefined);
  for (let i = 0; i < list.length; i += 25) {
    const chunk = list.slice(i, i + 25);
    if (progress) progress('Verificando ' + (i + 1) + '-' + (i + chunk.length), 'verifier');
    const unitsSeen = new Set();
    let ctxText = 'P\u00c1RRAFOS:\n';
    for (const f of chunk) {
      const u = session.units[f.unit];
      if (unitsSeen.has(u.n)) continue;
      unitsSeen.add(u.n);
      ctxText += '[' + u.n + ']\nO: ' + unitSrcMasked(session, u).replace(/\s+/g, ' ') + '\nT: ' + unitTgtMasked(session, u).replace(/\s+/g, ' ') + '\n';
    }
    const ids = new Map();
    let lines = 'HALLAZGOS A VERIFICAR:\n';
    chunk.forEach((f, k) => {
      const id = 'H' + (k + 1);
      ids.set(id, f);
      lines += id + ' | ' + session.units[f.unit].n + ' | ' + f.cat + ' | ' + (f.quoteMasked || '') + ' | ' + (f.suggestionMasked || '') + ' | ' +
        String(f.reason || '').replace(/\|/g, '/') + '\n';
    });
    const r = await call({ module: 'verifier', role: 'deep', prompt: ctxText + '\n' + lines + '\nRecuerda: una l\u00ednea por hallazgo y, al final, FIN ' + chunk.length + '.',
      system: verifierPrompt(ctx.prompts, session.srcLang), words: 0, thinking: _thinking(ctx.cfg, 'verifier'), maxTokens: 4096 }, 0);
    const { verdicts } = parseVerdicts(r.text);
    for (const [id, v] of verdicts) {
      const f = ids.get(id);
      if (!f) continue;
      f.verified = v.verdict;
      f.verifierModel = r.modelId;
      if (v.verdict === 'no') { f.state = 'discarded'; f.verifierReason = v.reason; }
      if (v.verdict === 'edit' && v.suggestion) {
        f.suggestionMasked = v.suggestion;
        f.suggestion = rehydrate(v.suggestion, session.byTag, 'tgt');
        f.verifierReason = v.reason;
      }
    }
  }
}
