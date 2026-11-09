/**
 * review-view.js - Step 3 "Revisar": what the AI should look for. One large card per reviewer (tick,
 * plain description, Exigencia, model and estimated cost), the privacy note and a fixed footer with
 * "Revisar ahora". Shows the plan with its cost, runs it, follows the progress on the cards and, at
 * the end, moves to step 4 "Corregir". Also the deferred batches and the test bench.
 */

import { helpBtn, helpItem } from './help.js';
import { el, $, clear, toast, modal, fmtInt, fmtMoney, confirmDialog } from '../util/dom.js';
import { state, on, emit, addFindings, saveProjectSoon, openFiles } from '../state.js';
import { MODULES, moduleById } from '../review/module-list.js';
import { makePlan } from '../review/planner.js';
import { deferredCapability, startDeferred, checkDeferred, cancelDeferredRecord, DEFERRED_STATUS } from '../review/deferred.js';
import { runPlan, verifyFindings } from '../review/runner.js';
import { loadModuleConfig, saveModuleConfig } from '../review/module-config.js';
import { loadPrompts, STRICTNESS, strictnessOf } from '../review/prompts.js';
import { externalDialog, importDialog } from './mask-view.js';
import { openMenu } from './menu.js';
import { loadBenchSpec, benchFiles, evaluateBench } from '../review/bench.js';
import { icon } from './icons.js';

let root, toolsHost;
let running = null;           // { abort: AbortController, modules:[] }
let progress = {};            // moduleId -> { done, total, label, state:'run'|'done'|'err', msg }
let estimates = {};           // moduleId -> { tok, cost } | { error }
let selectedModules = new Set(['meaning', 'writing', 'names']);
let estTimer = null;

/** The order of the cards: the meaning first (the master review), then the Spanish, then the names. */
const CARD_ORDER = ['meaning', 'writing', 'names'];

export function mountReviewView(host, tools) {
  root = host;
  toolsHost = tools;
  root.appendChild(el('div.page.prep',
    el('div.page-in',
      el('div.kicker', 'PASO 3 DE 5'),
      el('h2.ptitle', '\u00bfQu\u00e9 quiere que revise la IA?', helpBtn('modules')),
      el('p.lead', 'Sentido es la revisi\u00f3n de fondo: compara cada p\u00e1rrafo con el original y se\u00f1ala lo que la traducci\u00f3n dice distinto, lo que falta y lo que sobra. Redacci\u00f3n lee solo el espa\u00f1ol, y Nombres oficiales comprueba las denominaciones. Despu\u00e9s, el Verificador descarta los falsos positivos.'),
      el('div.mgrid#rv-modules'),
      el('div.privacy', icon('lock', 20),
        el('span', 'El texto sale enmascarado: personas, cifras, fechas y s\u00edmbolos nunca salen de este equipo (Nombres oficiales env\u00eda solo la lista de nombres de organismos, \u00f3rganos, cargos, pa\u00edses y lugares). Antes de enviar ver\u00e1 cu\u00e1ntas llamadas se har\u00e1n y su coste.'))),
    el('div.pfoot', el('div.pfoot-in',
      el('button.btn.big', { onclick: () => emit('goto', 'mask') }, icon('back', 16), 'Atr\u00e1s'),
      el('span.grow'),
      el('span.psum#rv-summary'),
      el('button.btn.primary.big#rv-run', { onclick: onRun })))));
  on('view', (v) => { if (v === 'review') { renderAll(); scheduleEstimates(); } });
  on('findings', () => { if (state.view === 'review') { renderTools(); renderModules(); } });
  on('masked', () => { estimates = {}; if (state.view === 'review') scheduleEstimates(); });
  on('project', () => {
    progress = {}; estimates = {};
    emit('review-status', '');
    if (state.project && (state.project.deferred || []).some(r => r.status === 'running')) startDeferredPolling();
  });
}

function renderAll() {
  if (!state.session) return;
  renderTools();
  renderModules();
}

function onRun() {
  if (running) { running.abort.abort(); return; }
  runModules(Array.from(selectedModules));
}

// ------------------------------------------------------------------ tools

function renderTools() {
  if (state.view !== 'review') return;
  clear(toolsHost);
  if (!state.project) return;
  toolsHost.appendChild(el('div.grow'));
  toolsHost.appendChild(el('button.btn', { onclick: (e) => moreMenu(e.currentTarget) }, 'M\u00e1s', icon('down', 14)));
}

/** "Mas" of Revisar: the test bench, the external AI and the module settings. */
function moreMenu(anchor) {
  openMenu(anchor, [
    { label: state.project && state.project.bench ? 'Resultado del banco de pruebas\u2026' : 'Banco de pruebas\u2026', onClick: benchDialog },
    { sep: true },
    { label: 'Copiar para IA externa\u2026', onClick: externalDialog },
    { label: 'Importar respuesta de IA externa\u2026', onClick: importDialog },
    { sep: true },
    { label: 'Configurar m\u00f3dulos y modelos', onClick: () => emit('goto-settings', 'modules') },
    { sep: true },
    helpItem('review-more', anchor)
  ]);
}

// ------------------------------------------------------------------ module cards

async function modelLabel(moduleId, role) {
  try {
    const reg = await import('../ai/registry.js');
    const r = await reg.resolveClient(moduleId, role);
    const name = (r.profile && r.profile.models && (r.profile.models.find(m => m.id === r.modelId) || {}).label) || r.modelId;
    return (r.fallback ? 'General: ' : '') + name;
  } catch (e) { return 'Sin modelo'; }
}

let _modsGen = 0;
let _modCfg = {};

/** The footer: how many reviewers, how many paragraphs and the estimated cost of what is ticked. */
function _updateTotal() {
  let total = 0, any = false, missing = false, n = 0;
  for (const id of selectedModules) {
    if (_modCfg[id] && _modCfg[id].enabled === false) continue;
    n++;
    const est = estimates[id];
    if (est && !est.error) { total += est.cost || 0; any = true; }
    else if (est && est.error) missing = true;
  }
  const sum = $('#rv-summary');
  if (sum) {
    const units = state.session ? state.session.units.length : 0;
    sum.textContent = n + (n === 1 ? ' revisor' : ' revisores') + ' \u00b7 ' + fmtInt(units) + ' p\u00e1rrafos' +
      (any ? ' \u00b7 ~' + fmtMoney(total) : '') + (missing ? ' \u00b7 falta la clave de alg\u00fan proveedor' : '');
  }
  const run = $('#rv-run');
  if (run) {
    run.replaceChildren(...(running ? [icon('stop', 16), 'Detener'] : ['Revisar ahora', icon('arrow', 16)]));
    run.classList.toggle('danger', !!running);
    run.classList.toggle('primary', !running);
    run.disabled = !running && !n;
  }
}

/** One card per reviewer: tick (it runs with "Revisar ahora"), what it looks for, Exigencia, model,
 *  estimated cost and, while it runs, its progress. */
async function renderModules() {
  const host = $('#rv-modules');
  if (!host) return;
  const gen = ++_modsGen;
  const cfg = await loadModuleConfig();
  if (gen !== _modsGen) return;   // a newer call is drawing the cards
  _modCfg = cfg;
  clear(host);
  const defCard = _deferredCard();
  if (defCard) host.appendChild(defCard);
  for (const id of CARD_ORDER) {
    const m = moduleById(id);
    if (!m || !m.ai) continue;
    host.appendChild(moduleCard(m, cfg));
  }
  _updateTotal();
}

function moduleCard(m, cfg) {
  const off = cfg[m.id] && cfg[m.id].enabled === false;
  const on = selectedModules.has(m.id) && !off;
  const p = progress[m.id];
  const st = p ? (p.state === 'run' ? 'run' : (p.state === 'err' ? 'err' : 'done')) : '';
  const count = state.findings.filter(f => f.module === m.id && f.state === 'open').length;
  const est = estimates[m.id];
  let stat = '';
  if (p && p.state === 'run') stat = p.total ? Math.round(100 * (p.done || 0) / Math.max(1, p.total)) + ' %' : 'En cola';
  else if (p && p.state === 'err') stat = 'Error';
  else if (count) stat = count + ' por corregir';
  else if (p && p.state === 'done') stat = 'Hecho';
  const chk = el('input', { type: 'checkbox', checked: on ? true : null, disabled: off ? true : null, onchange: (e) => {
    if (e.target.checked) selectedModules.add(m.id); else selectedModules.delete(m.id);
    e.target.closest('.mchip').classList.toggle('on', e.target.checked);
    _updateTotal();
  } });
  const strict = el('select.mc-strict', { 'data-strict': m.id, disabled: off ? true : null, title: 'Qu\u00e9 se le pide que se\u00f1ale',
    onchange: async (e) => { await saveModuleConfig(m.id, { strictness: e.target.value }); delete estimates[m.id]; scheduleEstimates(); } },
    Object.keys(STRICTNESS).map(k => el('option', { value: k }, STRICTNESS[k])));
  strict.value = strictnessOf(cfg, m.id);
  const cost = el('span.cost' + (est && est.error ? '.warn-t' : ''), est && !est.error ? '~' + fmtMoney(est.cost) : (est && est.error ? (/clave/.test(est.error) ? 'Sin clave' : 'Sin estimar') : 'Calculando\u2026'));
  const model = el('span.model', '');
  const tip = [m.desc, p && p.msg ? (p.state === 'err' ? 'Error: ' : '') + p.msg : '', off ? 'Desactivado en Ajustes \u203a M\u00f3dulos.' : ''].filter(Boolean).join('\n');
  const card = el('div.mchip' + (on ? '.on' : '') + (off ? '.off' : '') + (st ? '.' + st : ''), { 'data-mod': m.id, title: tip },
    el('label.mc-main', chk,
      el('span.mc-tx',
        el('span.mc-top', el('span.nm', m.label), stat ? el('span.stat', stat) : null),
        el('span.mc-desc', off ? 'Desactivado en Ajustes \u203a M\u00f3dulos.' : (m.plain || m.desc)))),
    el('div.mc-meta',
      el('label.mc-ex', el('span', 'Exigencia'), strict),
      el('span.grow'),
      model, cost));
  if (p && p.state === 'run') card.appendChild(el('i.bar', { style: { width: (p.total ? Math.round(100 * (p.done || 0) / Math.max(1, p.total)) : 15) + '%' } }));
  modelLabel(m.id, m.roles[0]).then(t => { model.textContent = t; });
  return card;
}

function scheduleEstimates() {
  clearTimeout(estTimer);
  estTimer = setTimeout(computeEstimates, 400);
}

async function _ctx() {
  return { prompts: await loadPrompts(), cfg: await loadModuleConfig() };
}

async function computeEstimates() {
  if (!state.session || state.view !== 'review') return;
  const ctx = await _ctx();
  for (const m of MODULES) {
    if (!m.ai || m.id === 'verifier' || estimates[m.id]) continue;
    try {
      const plan = await makePlan(state.session, Object.assign({}, ctx, { cfg: Object.assign({}, ctx.cfg, { [m.id]: Object.assign({}, ctx.cfg[m.id], { verify: false }) }) }), { modules: [m.id] });
      if (plan.errors.length) estimates[m.id] = { error: 'Sin proveedor con clave' };
      else estimates[m.id] = { tok: plan.totals.inTok + plan.totals.outTok, cost: plan.totals.cost, cached: plan.totals.cached };
    } catch (e) { estimates[m.id] = { error: 'Sin estimaci\u00f3n' }; console.warn('estimate', m.id, e); }
  }
  renderModules();
}

// ------------------------------------------------------------------ running

function _status() {
  if (!running) { emit('review-status', ''); return; }
  const ps = running.modules.map(id => progress[id]).filter(Boolean);
  const pct = ps.length ? Math.round(100 * ps.reduce((n, p) => n + (p.state === 'run' ? (p.done || 0) / Math.max(1, p.total || 1) : 1), 0) / ps.length) : 0;
  emit('review-status', 'Revisando\u2026 ' + pct + ' %');
}

async function runModules(ids) {
  if (!state.session || running) return;
  const ctx = await _ctx();
  const ai = ids.filter(id => id !== 'verifier' && moduleById(id) && moduleById(id).ai && ctx.cfg[id].enabled !== false);
  if (!ai.length) { renderModules(); return; }
  const plan = await makePlan(state.session, ctx, { modules: ai });
  if (plan.errors.length && !plan.groups.length && !plan.names) {
    toast('No hay ning\u00fan proveedor de IA con clave. Config\u00farelo en Ajustes \u203a Proveedores.', 'err', 8000);
    emit('goto-settings', 'providers');
    return;
  }
  const budgetDefault = Math.min(...ai.map(id => ctx.cfg[id].budget || Infinity));
  const cap = await deferredCapability(plan).catch(() => ({ ok: false, parts: [], missing: [] }));
  const ok = await planDialog(plan, isFinite(budgetDefault) ? budgetDefault : 0, cap);
  if (!ok) return;
  if (ok.deferred) {
    try {
      const rec = await startDeferred(plan, { session: state.session, cfg: ctx.cfg });
      state.project.deferred = (state.project.deferred || []).concat([rec]);
      saveProjectSoon();
      toast('Enviado en modo diferido (' + rec.jobs.length + ' lote' + (rec.jobs.length > 1 ? 's' : '') + '). UMBRA comprobar\u00e1 cada minuto si ya hay respuesta; puede cerrar la p\u00e1gina y volver despu\u00e9s.', 'ok', 9000);
      startDeferredPolling();
    } catch (e) { console.error(e); toast('No se pudo enviar el lote: ' + e.message, 'err', 9000); }
    renderModules();
    return;
  }
  running = { abort: new AbortController(), modules: ai };
  for (const id of ai) progress[id] = { state: 'run', done: 0, total: 1, msg: 'En cola' };
  // A new run replaces the open findings of these modules.
  state.findings = state.findings.filter(f => !(ai.includes(f.module) && f.state === 'open' && f.source === 'ai'));
  emit('findings');
  renderModules();
  _status();
  let res;
  try {
    res = await runPlan(plan, { session: state.session, project: { name: state.project.name, file: state.project.tgtName },
      prompts: ctx.prompts, cfg: ctx.cfg }, {
      signal: running.abort.signal, budget: ok.budget,
      onProgress: (p) => {
        const mods = p.module ? String(p.module).split('+') : ai;
        for (const id of mods) if (progress[id]) Object.assign(progress[id], { done: p.done, total: p.total, msg: p.label });
        renderModules();
        _status();
      },
      onFindings: (list) => { addFindings(list); }
    });
  } catch (e) {
    console.error(e);
    toast('Error durante la revisi\u00f3n: ' + e.message, 'err', 8000);
    res = { findings: [], errors: [{ message: e.message }], spent: 0 };
  }
  for (const id of ai) {
    const err = (res.errors || []).find(x => String(x.module || '').split('+').includes(id));
    const n = (res.findings || []).filter(f => f.module === id && f.state !== 'discarded').length;
    progress[id] = err ? { state: 'err', msg: err.message } : { state: 'done', msg: n + ' hallazgos' };
  }
  running = null;
  estimates = {};
  emit('findings');
  saveProjectSoon();
  _status();
  renderAll();
  scheduleEstimates();
  const found = (res.findings || []).filter(f => f.state !== 'discarded').length;
  const discarded = (res.findings || []).filter(f => f.state === 'discarded').length;
  toast('Revisi\u00f3n terminada: ' + found + ' hallazgos' +
    (discarded ? ' (' + discarded + ' descartados por el verificador)' : '') + ' \u00b7 ' + fmtMoney(res.spent || 0) +
    (res.stopped ? ' \u00b7 detenida' : '') + '.', (res.errors || []).length ? 'warn' : 'ok', 7000);
  for (const e of res.errors || []) toast((moduleById(String(e.module).split('+')[0]) || { label: e.module }).label + ': ' + e.message, 'err', 9000);
  if (state.project && state.project.bench) {
    try {
      const r = evaluateBench(state.session, state.findings, await loadBenchSpec());
      toast('Banco de pruebas: ' + r.found + ' de ' + r.expected + ' errores detectados, ' + r.noise.length + ' hallazgos de ruido. Detalle en M\u00e1s \u203a Resultado del banco de pruebas.', 'ok', 10000);
    } catch (e) { console.warn('bench', e); }
  }
  if (state.findings.some(f => f.state === 'open') && state.view === 'review') emit('goto', 'correct');
}

function planDialog(plan, budget, cap) {
  const rows = [];
  for (const g of plan.groups) {
    rows.push(el('li', g.modules.map(id => moduleById(id).label).join(' + ') + (g.modules.length > 1 ? ' (fusionados)' : '') + ': ' +
      g.batches.length + ' lotes con ' + (g.tri.profile ? g.tri.profile.name + ' \u00b7 ' : '') + g.tri.modelId +
      (g.deep ? '; a fondo lo se\u00f1alado con ' + g.deep.modelId : '') +
      (g.cachedHits.length ? '; ' + g.cachedHits.length + ' p\u00e1rrafos ya revisados (cach\u00e9)' : '') +
      (g.dupOf.size ? '; ' + g.dupOf.size + ' repetidos se revisan una vez' : '')));
  }
  if (plan.names) rows.push(el('li', 'Nombres oficiales: 1 llamada con ' + plan.names.rows.length + ' nombres (solo la lista de nombres, sin el texto)'));
  if (plan.verify) rows.push(el('li', 'Verificador: ' + plan.verify.est.calls + ' llamada(s) con ' + plan.verify.client.modelId));
  for (const e of plan.errors) rows.push(el('li.err-t', moduleById(e.module).label + ': ' + e.message));
  const budgetIn = el('input.inp', { type: 'number', min: 0, step: 0.05, value: budget || '', placeholder: 'Sin l\u00edmite', style: { width: '110px' } });
  const nothing = !plan.groups.some(g => g.batches.length) && !plan.names;
  // Deferred mode: the first pass at about half the price; the Verifier, which is small, runs when the
  // answers arrive, at the normal price.
  const firstPass = plan.groups.reduce((n, g) => n + (g.est.cost || 0) - ((g.est.deep && g.est.deep.cost) || 0), 0);
  const deferredCost = plan.totals.cost - firstPass * 0.5;
  const c = cap || { ok: false, parts: [], missing: [] };
  const defChk = el('input', { type: 'checkbox', disabled: !c.ok || nothing ? true : null });
  const defBox = el('div.note' + (c.ok ? '' : '.warn'), { style: { marginTop: '10px' } },
    el('label', defChk, ' ', el('b', 'Modo diferido (lotes)'), c.ok ? ' \u00b7 ~' + fmtMoney(deferredCost) + ' en lugar de ~' + fmtMoney(plan.totals.cost) : ''),
    el('div', { style: { marginTop: '4px' } }, c.ok
      ? 'La primera pasada va a la API de lotes del proveedor: cuesta la mitad y responde en minutos u horas (hasta 24 h). Puede cerrar la p\u00e1gina: al volver, UMBRA recoge las respuestas y termina la revisi\u00f3n (la parte a fondo y el verificador, que son peque\u00f1os, se hacen entonces al precio normal).'
      : (nothing ? 'No hay nada que enviar.' : 'No disponible: ' + (c.missing.join(', ') || 'ning\u00fan proveedor') + ' no tiene API de lotes en UMBRA (Gemini, Anthropic, Mistral y OpenAI s\u00ed la tienen; en un proveedor compatible con OpenAI se activa en su perfil).')));
  const body = el('div',
    el('ul', rows),
    el('p', el('b', fmtInt(plan.totals.calls) + ' llamadas \u00b7 ~' + fmtInt(plan.totals.inTok + plan.totals.outTok) + ' tokens \u00b7 ~' + fmtMoney(plan.totals.cost))),
    el('p.info', 'Estimaci\u00f3n orientativa: el gasto real se registra en Uso de IA. Solo se env\u00eda texto enmascarado (y, si est\u00e1 marcado Nombres oficiales, la lista de nombres de organismos, \u00f3rganos, cargos, pa\u00edses y lugares).' +
      (nothing ? ' No hay nada nuevo que enviar: todo est\u00e1 en la cach\u00e9.' : '')),
    el('label.lbl', 'Presupuesto m\u00e1ximo de esta ejecuci\u00f3n (US$)'), budgetIn,
    defBox);
  return modal({ title: 'Plan de ejecuci\u00f3n', help: helpBtn('plan'), body, width: '680px', buttons: [
    { label: 'Cancelar', value: null },
    { label: 'Ejecutar', kind: 'amber', value: 'go' }] }).then(r => r === 'go' ? { budget: parseFloat(budgetIn.value) || 0, deferred: !!defChk.checked } : null);
}

/** Sends the pending AI findings to the Verifier (from Corregir > Mas). */
export async function reverify() {
  const list = state.findings.filter(f => f.state === 'open' && (f.source === 'ai' || f.source === 'external') && !f.verified);
  if (!list.length) { toast('No hay hallazgos de IA pendientes sin verificar.', 'warn'); return; }
  if (!(await confirmDialog('Verificar', 'Se enviar\u00e1n ' + list.length + ' hallazgos al Verificador (texto enmascarado).', 'Verificar'))) return;
  const ctx = await _ctx();
  const { callAI } = await import('../ai/gateway.js');
  const call = (args) => callAI(Object.assign({ masked: true, project: state.project.name, file: state.project.tgtName }, args));
  progress.verifier = { state: 'run', done: 0, total: 1, msg: 'Verificando' };
  emit('review-status', 'Verificando\u2026');
  const t = toast('Verificando ' + list.length + ' hallazgos\u2026', '', 60000);
  try {
    await verifyFindings(list, { session: state.session, prompts: ctx.prompts, cfg: ctx.cfg }, call, (label) => { progress.verifier.msg = label; });
    const no = list.filter(f => f.verified === 'no').length;
    progress.verifier = { state: 'done', msg: no + ' descartados' };
    toast('Verificaci\u00f3n terminada: ' + no + ' descartados.', 'ok');
  } catch (e) {
    progress.verifier = { state: 'err', msg: e.message };
    toast(e.message, 'err', 8000);
  }
  if (t) t.remove();
  emit('review-status', '');
  emit('findings');
  saveProjectSoon();
}

/** Clears what this screen knows of past runs (after "Vaciar" in Corregir). */
export function resetReviewState() {
  progress = {};
  estimates = {};
  emit('review-status', '');
}

// ------------------------------------------------------------------ deferred batches

let _pollTimer = null;
let _polling = false;

function _deferredCard() {
  const recs = (state.project && state.project.deferred) || [];
  const shown = recs.filter(r => r.status === 'running' || (r.finishedAt && Date.now() - r.finishedAt < 7 * 86400000 && !r.dismissed) || (!r.finishedAt && !r.dismissed));
  if (!shown.length) return null;
  const card = el('div.mcard.wide' + (shown.some(r => r.status === 'running') ? '.run' : '.done'),
    el('div.nm', 'Lotes diferidos', helpBtn('deferred')));
  for (const r of shown.slice(-3)) {
    const done = r.jobs.reduce((n, j) => n + (j.done || 0), 0), total = r.jobs.reduce((n, j) => n + (j.total || 0), 0);
    card.appendChild(el('div.est', new Date(r.createdAt).toLocaleString('es', { dateStyle: 'short', timeStyle: 'short' }) + ' \u00b7 ' +
      (DEFERRED_STATUS[r.status] || r.status) + (r.status === 'running' ? ' \u00b7 ' + done + '/' + (total || '?') : (r.status === 'done' ? ' \u00b7 ' + r.findings + ' hallazgos \u00b7 ' + fmtMoney(r.spent || 0) : ''))));
    if (r.status === 'running') {
      const j = r.jobs.find(x => x.message);
      if (j) card.appendChild(el('div.est', j.message));
      card.appendChild(el('div.bar', el('i', { style: { width: Math.round(100 * done / Math.max(1, total)) + '%' } })));
    }
    if (r.stale) card.appendChild(el('div.est.warn-t', 'El documento cambi\u00f3 tras el env\u00edo: revise los hallazgos sin localizar.'));
    if (r.error) card.appendChild(el('div.est.err-t', r.error));
    const acts = el('div.ft');
    if (r.status === 'running') {
      acts.appendChild(el('button.btn.sm', { disabled: _polling ? true : null, onclick: () => pollDeferredNow(true) }, 'Comprobar'));
      acts.appendChild(el('button.btn.sm.danger', { onclick: async () => {
        if (!(await confirmDialog('Cancelar lote', 'Se cancelar\u00e1 el lote en el proveedor. Lo ya procesado puede facturarse igualmente.', 'Cancelar lote'))) return;
        await cancelDeferredRecord(r); saveProjectSoon(); renderModules();
      } }, 'Cancelar'));
    } else {
      acts.appendChild(el('button.btn.sm', { onclick: () => { r.dismissed = true; saveProjectSoon(); renderModules(); } }, 'Quitar'));
    }
    card.appendChild(acts);
  }
  return card;
}

export function startDeferredPolling() {
  if (!_pollTimer) _pollTimer = setInterval(() => pollDeferredNow(false), 60000);
  setTimeout(() => pollDeferredNow(false), 1500);
}

async function pollDeferredNow(manual) {
  if (_polling || !state.project || !state.session) return;
  const recs = (state.project.deferred || []).filter(r => r.status === 'running');
  if (!recs.length) { if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; } return; }
  _polling = true;
  if (state.view === 'review') renderModules();
  try {
    const ctx = await _ctx();
    for (const rec of recs) {
      let cleared = false;
      const r = await checkDeferred(rec, { session: state.session, prompts: ctx.prompts, cfg: ctx.cfg }, {
        project: { name: state.project.name, file: state.project.tgtName },
        onFindings: (list) => {
          if (!cleared) {
            cleared = true;
            state.findings = state.findings.filter(f => !(rec.modules.includes(f.module) && f.state === 'open' && f.source === 'ai'));
          }
          addFindings(list);
        }
      });
      if (r.changed) saveProjectSoon();
      if (r.finished) {
        if (rec.status === 'done') toast('Lote diferido terminado: ' + rec.findings + ' hallazgos \u00b7 ' + fmtMoney(rec.spent || 0) + '.', 'ok', 9000);
        else toast('El lote diferido no se complet\u00f3: ' + (rec.error || rec.status), 'err', 9000);
        estimates = {};
      } else if (manual) {
        const done = rec.jobs.reduce((n, j) => n + (j.done || 0), 0), total = rec.jobs.reduce((n, j) => n + (j.total || 0), 0);
        toast('El lote sigue en curso (' + done + '/' + (total || '?') + ').', '', 4000);
      }
    }
  } catch (e) {
    console.error('deferred', e);
    if (manual) toast('No se pudo comprobar el lote: ' + e.message, 'err', 8000);
  } finally {
    _polling = false;
    emit('findings');
    if (state.view === 'review') renderAll();
  }
}

// ------------------------------------------------------------------ test bench

const _MOD = (id) => (moduleById(id) || { label: id }).label;

/** Loads the test bench (a project of its own) or, when it is open, shows how the modules did. */
export async function benchDialog() {
  if (state.project && state.project.bench) return benchResults();
  let spec;
  try { spec = await loadBenchSpec(); } catch (e) { toast(e.message, 'err', 8000); return; }
  const expected = spec.paragraphs.reduce((n, p) => n + p.expect.length, 0);
  const clean = spec.paragraphs.filter(p => !p.expect.length).length;
  const r = await modal({ title: 'Banco de pruebas', help: helpBtn('bench'), width: '640px', body: el('div',
    el('p', 'Un documento de prueba hecho con su informe de revisi\u00f3n: ', el('b', spec.paragraphs.length + ' p\u00e1rrafos con ' + expected + ' errores conocidos'),
      ' (de sentido, omisiones, adiciones, nombres oficiales y gram\u00e1tica) y ', el('b', clean + ' p\u00e1rrafos correctos'), '.'),
    el('ol',
      el('li', 'Pulse \u00abCargar\u00bb: se abre como un proyecto aparte (el que tiene abierto queda guardado).'),
      el('li', 'En Revisar, marque los revisores que quiera, con los modelos y la exigencia que quiera probar, y pulse \u00abRevisar ahora\u00bb.'),
      el('li', 'Al terminar, M\u00e1s \u203a Resultado del banco de pruebas: cu\u00e1ntos errores detecta cada m\u00f3dulo y cu\u00e1nto ruido mete.')),
    el('p.info', 'Sirve para comparar modelos, exigencias e instrucciones con datos y no a ojo. Antes de repetir una prueba, use Vaciar (en Corregir) con \u00abOlvidar las respuestas guardadas\u00bb.')),
    buttons: [{ label: 'Cancelar', value: null }, { label: 'Cargar el banco de pruebas', kind: 'primary', value: 'ok' }] });
  if (r !== 'ok') return;
  try {
    const f = await benchFiles();
    await openFiles(f.src, f.tgt);
    state.project.bench = true;
    state.project.name = 'Banco de pruebas';
    saveProjectSoon();
    emit('project');
    emit('goto', 'review');
    toast('Banco de pruebas cargado: elija los revisores y pulse \u00abRevisar ahora\u00bb.', 'ok', 6000);
  } catch (e) { console.error(e); toast('No se pudo cargar el banco de pruebas: ' + e.message, 'err', 8000); }
}

async function benchResults() {
  let res;
  try { res = evaluateBench(state.session, state.findings, await loadBenchSpec()); } catch (e) { toast(e.message, 'err', 8000); return; }
  const pct = (a, b) => b ? Math.round(100 * a / b) + ' %' : '\u2014';
  const mods = Object.keys(res.byModule);
  const table = el('table.grid', el('tr', el('th', 'M\u00f3dulo'), el('th', 'Errores esperados'), el('th', 'Detectados'), el('th', 'Ruido')),
    mods.map(m => { const b = res.byModule[m]; return el('tr', el('td', _MOD(m)), el('td', String(b.expected || '\u2014')),
      el('td', b.expected ? b.found + ' (' + pct(b.found, b.expected) + ')' + (b.found !== b.foundOwn ? ' \u00b7 ' + (b.found - b.foundOwn) + ' por otro m\u00f3dulo' : '') : '\u2014'),
      el('td', String(b.noise))); }));
  const items = el('ul.benchlist', res.items.map(it => el('li.' + (it.hit ? 'hit' : 'miss'),
    el('b', (it.hit ? '\u2713 ' : '\u2717 ') + '\u00a7' + it.n + ' \u00b7 ' + _MOD(it.module) + ': '), it.what,
    it.hit ? el('div.muted', 'Encontrado' + (it.other ? ' por ' + _MOD(it.hit.module) : '') + ': \u00ab' + (it.hit.quote || '') + '\u00bb \u2192 \u00ab' + (it.hit.edited || it.hit.suggestion || '') + '\u00bb') : null,
    it.discarded ? el('div.warn-t', 'Lo encontr\u00f3 ' + _MOD(it.discarded.module) + ', pero el Verificador lo descart\u00f3.') : null)));
  const noise = el('ul.benchlist', res.noise.slice(0, 80).map(f => el('li.miss',
    el('b', '\u00a7' + ((state.session.units[f.unit] || {}).n || '') + ' \u00b7 ' + _MOD(f.module) + ' \u00b7 ' + f.sev + ': '),
    '\u00ab' + (f.quote || '') + '\u00bb \u2192 \u00ab' + (f.edited || f.suggestion || '') + '\u00bb', el('div.muted', f.reason || ''))));
  const summary = 'Banco de pruebas: ' + res.found + ' de ' + res.expected + ' errores detectados (' + pct(res.found, res.expected) + '); ruido: ' + res.noise.length +
    ' hallazgos que no corresponden a ning\u00fan error (' + res.noiseClean + ' en p\u00e1rrafos correctos).\n' +
    mods.map(m => { const b = res.byModule[m]; return '- ' + _MOD(m) + ': ' + (b.expected ? b.found + '/' + b.expected : '0 esperados') + ', ruido ' + b.noise; }).join('\n') + '\n' +
    'No detectados:\n' + res.items.filter(i => !i.hit).map(i => '  \u00a7' + i.n + ' ' + _MOD(i.module) + ': ' + i.what).join('\n') + '\n' +
    'Ruido:\n' + res.noise.map(f => '  \u00a7' + ((state.session.units[f.unit] || {}).n || '') + ' ' + _MOD(f.module) + ' ' + f.sev + ': ' + (f.quote || '') + ' -> ' + (f.suggestion || '') + ' (' + (f.reason || '') + ')').join('\n');
  await modal({ title: 'Resultado del banco de pruebas', help: helpBtn('bench'), width: '820px', body: el('div',
    el('p', el('b', res.found + ' de ' + res.expected + ' errores detectados (' + pct(res.found, res.expected) + ')'), ' \u00b7 ruido: ', el('b', String(res.noise.length)),
      ' hallazgos que no corresponden a ning\u00fan error (', String(res.noiseClean), ' en p\u00e1rrafos correctos).'),
    table,
    el('h4', { style: { margin: '12px 0 4px' } }, 'Errores esperados'), items,
    el('h4', { style: { margin: '12px 0 4px' } }, 'Ruido (' + res.noise.length + ')'), res.noise.length ? noise : el('p.muted', 'Ninguno.')),
    buttons: [{ label: 'Copiar el resumen', onClick: async () => { const { copyText } = await import('../util/dom.js'); await copyText(summary); toast('Resumen copiado: p\u00e9guelo en el chat para ajustar los m\u00f3dulos.', 'ok', 6000); return false; } },
      { label: 'Cerrar', kind: 'primary', value: null }] });
}
