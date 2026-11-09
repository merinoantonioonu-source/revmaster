/**
 * runner.js - Executes a plan (planner.js): the batches of each module (and the cascade to a strong
 * model, idle since the simplification: see planner.js), the official names, the Verifier, the results
 * cache and the budget.
 *
 * runPlan(plan, ctx, hooks) -> { findings:[...], spent, calls, errors:[{module, message}], stopped }
 * ctx   = { session, project: { id, name, file }, prompts, cfg }
 * hooks = { onProgress({ done, total, label, module }), onFindings(list), signal, budget (US$, 0 = none) }
 */

import { callAI, callAINames } from '../ai/gateway.js';
import { namesFindings } from './names.js';
import { idbPut } from '../store/idb.js';
import { parseFindings, parseVerdicts } from './parse.js';
import { anchorItem, sameFinding } from './findings.js';
import { cacheKey, buildBatchUser } from './planner.js';
import { CAT_MODULE, verifierPrompt, strictnessOf, STRICT_ALLOWED } from './prompts.js';
import { moduleById } from './module-list.js';
import { unitSrcMasked, unitTgtMasked } from './session.js';
import { rehydrate } from '../redact/entities.js';

const DEEP_CATS = { meaning: ['MIST', 'UNTR', 'OMI', 'ADD'] };

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
    const base = { project: ctx.project && ctx.project.name, file: ctx.project && ctx.project.file, signal: h.signal };
    // The names table is the only call that is not masked text; the gateway checks it row by row.
    const r = args.rows ? await callAINames(Object.assign(base, args)) : await callAI(Object.assign({ masked: true }, base, args));
    out.spent += r.cost || 0;
    out.calls++;
    done++;
    return r;
  };

  // "Exigencia": findings of a severity the module was not asked for are dropped.
  const wanted = (f) => !f.module || !moduleById(f.module) || STRICT_ALLOWED[strictnessOf(ctx.cfg, f.module)].includes(f.sev);
  const push = (list) => {
    const fresh = [];
    for (const f of list) {
      if (!f || !wanted(f)) continue;
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
  for (let gi = 0; gi < plan.groups.length; gi++) {
    const g = plan.groups[gi];
    if (out.stopped) break;
    const flagged = new Set();
    const groupFindings = [];
    for (let bi = 0; bi < g.batches.length; bi++) {
      const b = g.batches[bi];
      if (out.stopped) break;
      progress('Lote ' + (bi + 1) + '/' + g.batches.length, g.modules.join('+'));
      const pre = h.prefetched ? h.prefetched.get('g' + gi + 'b' + bi) : null;
      if (h.prefetched && !pre) continue;   // deferred run: this batch had no answer
      if (pre && pre.error) { out.errors.push({ module: g.modules.join('+'), message: 'Lote diferido: ' + pre.error }); continue; }
      let res;
      try {
        res = await _runBatch(b.items.map(x => x.u), g, g.tri, 'triage', b.user, b.inTok, call, ctx, pre ? pre.text : null);
      } catch (e) {
        if (e.code === 'BUDGET' || e.code === 'ABORT') break;
        out.errors.push({ module: g.modules.join('+'), message: e.message, code: e.code });
        if (e.code === 'TRUNCATED') continue;   // one paragraph too long: the other batches still run
        break;
      }
      for (const [n, items] of res) {
        const u = unitByN.get(n);
        if (!u) continue;
        for (const it of items) {
          const module = g.modules.length === 1 ? g.modules[0] : (CAT_MODULE[it.cat] && g.modules.includes(CAT_MODULE[it.cat]) ? CAT_MODULE[it.cat] : g.modules[0]);
          const f = anchorItem(it, { session, unitByN, module, source: 'ai', model: g.tri.modelId, role: 'triage' });
          if (f) groupFindings.push(f);
          if (g.deep && DEEP_CATS[module] && DEEP_CATS[module].includes(it.cat) && (it.sev === 'CRI' || it.sev === 'MAY' || strictnessOf(ctx.cfg, module) !== 'grave')) flagged.add(n);
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
          const user = buildBatchUser(session, chunk, g.input);
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

  // ---- Official names (the table of names only)
  if (plan.names && !out.stopped) {
    progress('Nombres oficiales', 'names');
    try {
      const r = await call({ module: 'names', role: 'triage', rows: plan.names.rows, system: plan.names.system, words: 0,
        thinking: _thinking(ctx.cfg, 'names'), maxTokens: 8192 }, plan.names.est.cost);
      const parsed = parseFindings(r.text, new Set(plan.names.rows.map(x => x.n)));
      push(namesFindings(session, plan.names.rows, parsed.items, { model: r.modelId }));
    } catch (e) {
      if (e.code !== 'BUDGET' && e.code !== 'ABORT') out.errors.push({ module: 'names', message: e.message, code: e.code });
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

/**
 * One batch: call and parse. When the answer was cut (the provider stopped at its output limit, or no
 * "FIN n"), what arrived is kept and the units not answered are asked again, split in halves when
 * needed, so a long batch never loses its tail.
 */
async function _runBatch(units, g, client, role, user, est, call, ctx, preText, depth) {
  const session = ctx.session;
  const lvl = depth || 0;
  const valid = new Set(units.map(u => u.n));
  const moduleId = g.modules[0];
  const words = units.reduce((n, u) => n + (unitTgtMasked(session, u).match(/\S+/g) || []).length, 0);
  let text, cut = false;
  if (preText !== null && preText !== undefined) text = preText;
  else {
    try {
      const r = await call({ module: moduleId, usageModule: g.modules.join('+'), role, prompt: user || buildBatchUser(session, units, g.input), system: g.system,
        words, thinking: _thinking(ctx.cfg, moduleId), maxTokens: 8192 }, est ? _estCost(est) : 0);
      text = r.text;
    } catch (e) {
      if (e.code !== 'TRUNCATED') throw e;
      // Keep the complete lines of what was written; the last one may be cut.
      text = String(e.partial || '').replace(/[^\n]*$/, '');
      cut = true;
      // A single paragraph that does not fit: nothing smaller to ask.
      if (units.length === 1 && !parseFindings(text, valid).items.length) throw e;
    }
  }
  const parsed = parseFindings(text, valid);
  const res = new Map();
  for (const n of valid) res.set(n, []);
  for (const it of parsed.items) res.get(it.unit).push(it);
  // Incomplete: cut by the provider, or items without the closing "FIN n" (an empty answer without
  // FIN is taken as "nothing to report": asking again would only spend).
  if ((cut || (parsed.fin === null && parsed.items.length > 0)) && lvl < 4) {
    const lastMentioned = parsed.items.length ? Math.max(...parsed.items.map(i => i.unit)) : null;
    let rest = units.filter(u => lastMentioned === null || u.n > lastMentioned);
    if (lastMentioned !== null) for (const it of parsed.items) if (it.unit === lastMentioned && cut) { rest = units.filter(u => u.n >= lastMentioned); break; }
    if (rest.length) {
      // Same size as before: halve it; otherwise ask the rest as it is.
      const parts = rest.length === units.length ? (rest.length > 1 ? [rest.slice(0, Math.ceil(rest.length / 2)), rest.slice(Math.ceil(rest.length / 2))] : []) : [rest];
      for (const part of parts) {
        const sub = await _runBatch(part, g, client, role, null, 0, call, ctx, null, lvl + 1);
        for (const [n, items] of sub) res.set(n, items);
      }
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
      lines += id + ' | ' + session.units[f.unit].n + ' | ' + ((moduleById(f.module) || { label: f.module }).label.toUpperCase()) + ' | ' + f.cat + ' | ' + (f.quoteMasked || '') + ' | ' + (f.suggestionMasked || '') + ' | ' +
        String(f.reason || '').replace(/\|/g, '/') + '\n';
    });
    const r = await call({ module: 'verifier', role: 'deep', prompt: ctxText + '\n' + lines + '(FIN ' + chunk.length + ')',
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
