/**
 * review-view.js - Step 2 "Revisar": module cards (run one or several), the plan with its estimated
 * cost, progress, the findings list (filters, accept/reject/edit, keyboard) and the two sheets.
 */

import { el, $, clear, toast, modal, fmtInt, fmtMoney, promptDialog, confirmDialog } from '../util/dom.js';
import { state, on, emit, addFindings, updateFinding, saveProjectSoon, setProfile } from '../state.js';
import { renderDoc } from './preview.js';
import { MODULES, moduleById, INPUT_ICONS, INPUT_LABELS, ROLE_LABELS } from '../review/module-list.js';
import { runLocalChecks, LOCAL_SUBS } from '../review/local-checks.js';
import { makePlan } from '../review/planner.js';
import { runPlan, verifyFindings } from '../review/runner.js';
import { loadModuleConfig } from '../review/module-config.js';
import { loadPrompts, CAT_LABELS } from '../review/prompts.js';
import { getEffectiveRules, loadRulesStore, upsertRule, SEV_LABELS } from '../rules/rules.js';
import { STATE_LABELS } from '../review/findings.js';
import { externalDialog, importDialog } from './mask-view.js';
import { exportCorrected, exportReportHtml, exportReportXlsx, exportFindingsJson } from '../export/exports.js';
import { openMenu } from './menu.js';

let root, toolsHost, panes = {};
let filt = { module: 'all', sev: 'all', state: 'open' };
let selected = null;
let running = null;           // { abort: AbortController, modules:[] }
let progress = {};            // moduleId -> { done, total, label, state:'run'|'done'|'err', msg }
let estimates = {};           // moduleId -> { tok, cost } | { error }
let selectedModules = new Set(['local', 'grammar', 'fidelity', 'integrity', 'style', 'coherence', 'conventions']);
let estTimer = null;

export function mountReviewView(host, tools) {
  root = host;
  toolsHost = tools;
  root.appendChild(el('div.list',
    el('h4', 'Hallazgos', el('span.grow'), el('button.btn.sm', { title: 'Opciones de la lista', onclick: (e) => listMenu(e.currentTarget) }, '\u22ef')),
    el('div.bubbles#rv-bubbles'),
    el('div.scroll#rv-findings')));
  root.appendChild(el('div.work',
    el('div.modstrip#rv-modules'),
    el('div.panes',
      el('div.pane', el('div.pane-head', el('span#rv-src-title', 'ORIGINAL')), el('div.pane-body#rv-src')),
      el('div.pane', el('div.pane-head', el('span', 'TRADUCCI\u00d3N \u00b7 ES'), el('span.grow'), el('span.muted#rv-unit-info')), el('div.pane-body#rv-tgt')))));
  panes = { src: $('#rv-src'), tgt: $('#rv-tgt') };
  on('view', (v) => { if (v === 'review') { renderAll(); scheduleEstimates(); } });
  on('findings', () => { if (state.view === 'review') { renderTools(); renderFindings(); renderPanes(); } });
  on('finding', () => { if (state.view === 'review') { renderTools(); renderFindings(); renderPanes(); } });
  on('masked', () => { estimates = {}; if (state.view === 'review') { renderPanes(); scheduleEstimates(); } });
  on('project', () => { progress = {}; estimates = {}; selected = null; });
  document.addEventListener('keydown', onKey);
}

function renderAll() {
  if (!state.session) return;
  renderTools();
  renderModules();
  renderFindings();
  renderPanes();
}

// ------------------------------------------------------------------ tools

let _toolsGen = 0;
async function renderTools() {
  if (state.view !== 'review') return;
  const gen = ++_toolsGen;
  const store = await loadRulesStore();
  if (gen !== _toolsGen || state.view !== 'review') return;   // a newer call is drawing the bar
  clear(toolsHost);
  if (!state.project) return;
  const open = state.findings.filter(f => f.state === 'open');
  const n = (s) => open.filter(f => f.sev === s).length;
  toolsHost.appendChild(el('div.summary',
    n('CRI') ? el('span.pill.err', n('CRI') + ' cr\u00edticos') : null,
    n('MAY') ? el('span.pill.warn', n('MAY') + ' mayores') : null,
    n('MEN') ? el('span.pill.info', n('MEN') + ' menores') : null,
    n('SUG') ? el('span.pill.gray', n('SUG') + ' sugerencias') : null,
    !open.length ? el('span.pill.ok', 'Sin hallazgos pendientes') : null));
  toolsHost.appendChild(el('div.grow'));
  const prof = el('select', { title: 'Perfil de reglas', onchange: (e) => { setProfile(e.target.value); estimates = {}; scheduleEstimates(); } },
    el('option', { value: '' }, 'Todas las reglas'), store.profiles.map(p => el('option', { value: p }, 'Perfil: ' + p)));
  prof.value = state.project.profile || '';
  toolsHost.appendChild(prof);
  if (running) toolsHost.appendChild(el('button.btn.danger', { onclick: () => running.abort.abort() }, '\u25a0 Detener'));
  else toolsHost.appendChild(el('button.btn.amber', { onclick: () => runModules(Array.from(selectedModules)) }, '\u25b6 Ejecutar seleccionados'));
  toolsHost.appendChild(el('button.btn', { onclick: (e) => moreMenu(e.currentTarget) }, 'M\u00e1s \u25be'));
  toolsHost.appendChild(el('button.btn.violet', { onclick: (e) => exportMenu(e.currentTarget) }, 'Exportar \u25be'));
}

function moreMenu(anchor) {
  openMenu(anchor, [
    { label: 'Copiar para IA externa\u2026', onClick: externalDialog },
    { label: 'Importar respuesta de IA externa\u2026', onClick: importDialog },
    { sep: true },
    { label: 'Verificar los hallazgos pendientes de la IA', onClick: reverify },
    { label: 'Configurar m\u00f3dulos y modelos', onClick: () => emit('goto-settings', 'modules') },
    { label: 'Editar reglas', onClick: () => emit('goto-settings', 'rules') }
  ]);
}

function exportMenu(anchor) {
  const kind = state.tgt ? state.tgt.kind : 'docx';
  openMenu(anchor, [
    { header: 'Traducci\u00f3n corregida' },
    kind === 'docx' ? { label: 'DOCX con control de cambios y comentarios', onClick: () => doExport({ tracked: true, comments: true }) } : null,
    kind === 'docx' ? { label: 'DOCX con control de cambios, sin comentarios', onClick: () => doExport({ tracked: true, comments: false }) } : null,
    { label: (kind === 'docx' ? 'DOCX' : kind.toUpperCase()) + ' con los cambios aplicados (sin control de cambios)', onClick: () => doExport({ tracked: false, comments: false }) },
    { sep: true },
    { header: 'Informes' },
    { label: 'Informe HTML', onClick: () => exportReportHtml(f => f.state !== 'discarded') },
    { label: 'Informe Excel', onClick: () => exportReportXlsx(f => f.state !== 'discarded') },
    { label: 'Hallazgos en JSON', onClick: exportFindingsJson }
  ]);
}

async function doExport(opts) {
  try {
    const r = await exportCorrected(opts);
    toast('Exportado: ' + r.applied + ' correcciones aplicadas' + (r.comments ? ', ' + r.comments + ' comentarios' : '') +
      (r.skipped.length ? '; ' + r.skipped.length + ' sin aplicar' : '') + '.', 'ok', 6000);
    for (const w of r.warnings || []) toast(String(w), 'warn', 7000);
  } catch (e) { console.error(e); toast('No se pudo exportar: ' + e.message, 'err', 8000); }
}

function listMenu(anchor) {
  openMenu(anchor, [
    { label: 'Aceptar todos los visibles con sugerencia', onClick: () => bulk('accepted') },
    { label: 'Rechazar todos los visibles', onClick: () => bulk('rejected') },
    { label: 'Volver a poner como pendientes los visibles', onClick: () => bulk('open') },
    { sep: true },
    { label: 'Borrar los hallazgos pendientes de la IA', onClick: async () => {
      if (!(await confirmDialog('Borrar hallazgos', 'Se borrar\u00e1n los hallazgos pendientes de la IA y de la IA externa (los aceptados y rechazados se conservan).', 'Borrar'))) return;
      state.findings = state.findings.filter(f => f.state !== 'open' || f.source === 'local' || f.source === 'rule');
      emit('findings'); saveProjectSoon();
    } }
  ]);
}

function bulk(newState) {
  for (const f of visibleFindings()) {
    if (newState === 'accepted' && !(f.suggestion || f.edited)) continue;
    f.state = newState;
  }
  emit('findings');
  saveProjectSoon();
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
async function renderModules() {
  const host = $('#rv-modules');
  if (!host) return;
  const gen = ++_modsGen;
  const cfg = await loadModuleConfig();
  if (gen !== _modsGen) return;   // a newer call is drawing the cards
  clear(host);
  for (const m of MODULES) {
    const p = progress[m.id];
    const cls = p ? (p.state === 'run' ? '.run' : (p.state === 'err' ? '.err' : '.done')) : '';
    const count = state.findings.filter(f => f.module === m.id && f.state === 'open').length;
    const chk = el('input', { type: 'checkbox', checked: selectedModules.has(m.id), onchange: (e) => {
      if (e.target.checked) selectedModules.add(m.id); else selectedModules.delete(m.id);
    } });
    const card = el('div.mcard' + cls, { title: m.desc },
      el('div.nm', chk, m.label),
      el('span.in', INPUT_ICONS[m.input] + ' ' + INPUT_LABELS[m.input]));
    if (m.ai) {
      for (const role of m.roles) {
        const pill = el('button.mpill', { title: ROLE_LABELS[role] + ': pulse para cambiar el modelo', onclick: (e) => pickModel(e.currentTarget, m.id, role) }, '\u2026');
        modelLabel(m.id, role).then(t => { pill.textContent = (m.roles.length > 1 ? ROLE_LABELS[role] + ': ' : '') + t + ' \u25be'; });
        card.appendChild(pill);
      }
      const est = estimates[m.id];
      card.appendChild(el('div.est', est ? (est.error ? est.error : '~' + fmtInt(est.tok) + ' tokens \u00b7 ' + fmtMoney(est.cost) + (est.cached ? ' \u00b7 ' + est.cached + ' en cach\u00e9' : '')) : (m.id === 'verifier' ? 'Tras los dem\u00e1s m\u00f3dulos' : 'Estimando\u2026')));
      if (cfg[m.id] && cfg[m.id].enabled === false) card.appendChild(el('div.est.warn-t', 'Desactivado en Ajustes'));
    } else {
      card.appendChild(el('div.est', 'Sin IA \u00b7 gratis'));
    }
    if (p && p.state === 'run') card.appendChild(el('div.bar', el('i', { style: { width: Math.round(100 * (p.done || 0) / Math.max(1, p.total || 1)) + '%' } })));
    if (p && p.msg) card.appendChild(el('div.est' + (p.state === 'err' ? '.err-t' : ''), p.msg));
    const runBtn = m.id === 'verifier'
      ? el('button.btn.sm', { disabled: !!running, onclick: reverify }, 'Verificar')
      : el('button.btn.sm', { disabled: !!running, onclick: () => runModules([m.id]) }, 'Ejecutar');
    card.appendChild(el('div.ft', el('span', count ? '\u2691 ' + count : (p && p.state === 'done' ? '\u2713 0' : '')), runBtn));
    host.appendChild(card);
  }
}

async function pickModel(anchor, moduleId, role) {
  try {
    const sp = await import('./settings-providers.js');
    sp.openModelMenu(anchor, { moduleId, role, onPick: () => { estimates = {}; renderModules(); scheduleEstimates(); } });
  } catch (e) { emit('goto-settings', 'providers'); }
}

function scheduleEstimates() {
  clearTimeout(estTimer);
  estTimer = setTimeout(computeEstimates, 400);
}

async function _ctx() {
  return { rules: await getEffectiveRules(), prompts: await loadPrompts(), cfg: await loadModuleConfig(), profile: state.project ? state.project.profile : '' };
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

async function runModules(ids) {
  if (!state.session || running) return;
  const ctx = await _ctx();
  const wantLocal = ids.includes('local');
  const ai = ids.filter(id => id !== 'local' && id !== 'verifier' && moduleById(id) && moduleById(id).ai && ctx.cfg[id].enabled !== false);
  if (wantLocal) {
    let list = runLocalChecks(state.session, { rules: ctx.rules, conventions: state.data.conventions, profile: ctx.profile });
    if (!ctx.cfg.local || ctx.cfg.local.spell !== false) {
      progress.local = { state: 'run', msg: 'Corrector ortogr\u00e1fico\u2026' };
      renderModules();
      try {
        const { spellFindings } = await import('../review/spell.js');
        list = list.concat(await spellFindings(state.session, { rules: ctx.rules }));
      } catch (e) { console.warn('spell', e); toast('No se pudo cargar el corrector ortogr\u00e1fico local: ' + e.message, 'warn'); }
    }
    addFindings(list, ['local']);
    progress.local = { state: 'done', msg: list.length + ' hallazgos' };
    if (!ai.length) { toast('Capa 0: ' + list.length + ' hallazgos.', 'ok'); renderModules(); return; }
  }
  if (!ai.length) { renderModules(); return; }
  const plan = await makePlan(state.session, ctx, { modules: ai });
  if (plan.errors.length && !plan.groups.length && !plan.skeleton.length) {
    toast('No hay ning\u00fan proveedor de IA con clave. Config\u00farelo en Ajustes \u203a Proveedores.', 'err', 8000);
    emit('goto-settings', 'providers');
    return;
  }
  const budgetDefault = Math.min(...ai.map(id => ctx.cfg[id].budget || Infinity));
  const ok = await planDialog(plan, isFinite(budgetDefault) ? budgetDefault : 0);
  if (!ok) return;
  running = { abort: new AbortController(), modules: ai };
  for (const id of ai) progress[id] = { state: 'run', done: 0, total: 1, msg: 'En cola' };
  // A new run replaces the open findings of these modules.
  state.findings = state.findings.filter(f => !(ai.includes(f.module) && f.state === 'open' && f.source === 'ai'));
  emit('findings');
  renderTools();
  renderModules();
  let res;
  try {
    res = await runPlan(plan, { session: state.session, project: { name: state.project.name, file: state.project.tgtName },
      prompts: ctx.prompts, cfg: ctx.cfg, rules: ctx.rules }, {
      signal: running.abort.signal, budget: ok.budget,
      onProgress: (p) => {
        const mods = p.module ? String(p.module).split('+') : ai;
        for (const id of mods) if (progress[id]) Object.assign(progress[id], { done: p.done, total: p.total, msg: p.label });
        renderModules();
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
  renderAll();
  scheduleEstimates();
  const discarded = (res.findings || []).filter(f => f.state === 'discarded').length;
  toast('Revisi\u00f3n terminada: ' + (res.findings || []).filter(f => f.state !== 'discarded').length + ' hallazgos' +
    (discarded ? ' (' + discarded + ' descartados por el verificador)' : '') + ' \u00b7 ' + fmtMoney(res.spent || 0) +
    (res.stopped ? ' \u00b7 detenida' : '') + '.', (res.errors || []).length ? 'warn' : 'ok', 7000);
  for (const e of res.errors || []) toast((moduleById(String(e.module).split('+')[0]) || { label: e.module }).label + ': ' + e.message, 'err', 9000);
}

function planDialog(plan, budget) {
  const rows = [];
  for (const g of plan.groups) {
    rows.push(el('li', g.modules.map(id => moduleById(id).label).join(' + ') + (g.modules.length > 1 ? ' (fusionados)' : '') + ': ' +
      g.batches.length + ' lotes con ' + (g.tri.profile ? g.tri.profile.name + ' \u00b7 ' : '') + g.tri.modelId +
      (g.deep ? '; a fondo lo se\u00f1alado con ' + g.deep.modelId : '') +
      (g.cachedHits.length ? '; ' + g.cachedHits.length + ' p\u00e1rrafos ya revisados (cach\u00e9)' : '') +
      (g.dupOf.size ? '; ' + g.dupOf.size + ' repetidos se revisan una vez' : '')));
  }
  for (const s of plan.skeleton) rows.push(el('li', moduleById(s.module).label + ': 1 llamada con el esqueleto (' + s.units.size + ' elementos)'));
  if (plan.verify) rows.push(el('li', 'Verificador: ' + plan.verify.est.calls + ' llamada(s) con ' + plan.verify.client.modelId));
  for (const e of plan.errors) rows.push(el('li.err-t', moduleById(e.module).label + ': ' + e.message));
  const budgetIn = el('input.inp', { type: 'number', min: 0, step: 0.05, value: budget || '', placeholder: 'Sin l\u00edmite', style: { width: '110px' } });
  const nothing = !plan.groups.some(g => g.batches.length) && !plan.skeleton.length;
  const body = el('div',
    el('ul', rows),
    el('p', el('b', fmtInt(plan.totals.calls) + ' llamadas \u00b7 ~' + fmtInt(plan.totals.inTok + plan.totals.outTok) + ' tokens \u00b7 ~' + fmtMoney(plan.totals.cost))),
    el('p.info', 'Estimaci\u00f3n orientativa: el gasto real se registra en Uso de IA. Solo se env\u00eda texto enmascarado.' +
      (nothing ? ' No hay nada nuevo que enviar: todo est\u00e1 en la cach\u00e9.' : '')),
    el('label.lbl', 'Presupuesto m\u00e1ximo de esta ejecuci\u00f3n (US$)'), budgetIn);
  return modal({ title: 'Plan de ejecuci\u00f3n', body, width: '640px', buttons: [
    { label: 'Cancelar', value: null },
    { label: 'Ejecutar', kind: 'amber', value: 'go' }] }).then(r => r === 'go' ? { budget: parseFloat(budgetIn.value) || 0 } : null);
}

async function reverify() {
  const list = state.findings.filter(f => f.state === 'open' && (f.source === 'ai' || f.source === 'external') && !f.verified);
  if (!list.length) { toast('No hay hallazgos de IA pendientes sin verificar.', 'warn'); return; }
  if (!(await confirmDialog('Verificar', 'Se enviar\u00e1n ' + list.length + ' hallazgos al Verificador (texto enmascarado).', 'Verificar'))) return;
  const ctx = await _ctx();
  const { callAI } = await import('../ai/gateway.js');
  const call = (args) => callAI(Object.assign({ masked: true, project: state.project.name, file: state.project.tgtName }, args));
  progress.verifier = { state: 'run', done: 0, total: 1, msg: 'Verificando' };
  renderModules();
  try {
    await verifyFindings(list, { session: state.session, prompts: ctx.prompts, cfg: ctx.cfg }, call, (label) => { progress.verifier.msg = label; renderModules(); });
    const no = list.filter(f => f.verified === 'no').length;
    progress.verifier = { state: 'done', msg: no + ' descartados' };
    toast('Verificaci\u00f3n terminada: ' + no + ' descartados.', 'ok');
  } catch (e) {
    progress.verifier = { state: 'err', msg: e.message };
    toast(e.message, 'err', 8000);
  }
  emit('findings');
  saveProjectSoon();
  renderModules();
}

// ------------------------------------------------------------------ findings list

function visibleFindings() {
  return state.findings.filter(f =>
    (filt.module === 'all' || f.module === filt.module) &&
    (filt.sev === 'all' || f.sev === filt.sev) &&
    (filt.state === 'all' ? true : (filt.state === 'open' ? f.state === 'open' : f.state === filt.state))
  ).sort((a, b) => (a.unit - b.unit) || ((a.start == null ? 1e9 : a.start) - (b.start == null ? 1e9 : b.start)));
}

function renderFindings() {
  const bub = $('#rv-bubbles');
  if (!bub) return;
  clear(bub);
  const base = state.findings.filter(f => filt.state === 'all' ? true : f.state === filt.state);
  const mk = (key, val, label, n) => el('span.bub' + (filt[key] === val ? '.on' : ''), { onclick: () => { filt[key] = val; renderFindings(); renderPanes(); } }, label + (n !== undefined ? ' ' + n : ''));
  bub.appendChild(mk('state', 'open', 'Pendientes', state.findings.filter(f => f.state === 'open').length));
  bub.appendChild(mk('state', 'accepted', 'Aceptados', state.findings.filter(f => f.state === 'accepted').length));
  bub.appendChild(mk('state', 'rejected', 'Rechazados', state.findings.filter(f => f.state === 'rejected' || f.state === 'ignored').length));
  bub.appendChild(mk('state', 'discarded', 'Descartados', state.findings.filter(f => f.state === 'discarded').length));
  bub.appendChild(mk('state', 'all', 'Todos'));
  bub.appendChild(el('span', { style: { flexBasis: '100%', height: '0' } }));
  bub.appendChild(mk('module', 'all', 'Todos los m\u00f3dulos'));
  for (const m of MODULES) {
    const n = base.filter(f => f.module === m.id).length;
    if (n) bub.appendChild(mk('module', m.id, m.short, n));
  }
  bub.appendChild(el('span', { style: { flexBasis: '100%', height: '0' } }));
  bub.appendChild(mk('sev', 'all', 'Toda gravedad'));
  for (const s of ['CRI', 'MAY', 'MEN', 'SUG']) {
    const n = base.filter(f => f.sev === s && (filt.module === 'all' || f.module === filt.module)).length;
    if (n) bub.appendChild(mk('sev', s, SEV_LABELS[s], n));
  }
  const host = $('#rv-findings');
  clear(host);
  const list = visibleFindings();
  if (!list.length) {
    host.appendChild(el('div.empty', state.findings.length ? 'No hay hallazgos con estos filtros.' :
      'Todav\u00eda no hay hallazgos. Elija los m\u00f3dulos arriba y pulse \u00abEjecutar seleccionados\u00bb, o empiece por la Capa 0 (gratis).'));
    return;
  }
  for (const f of list.slice(0, 600)) host.appendChild(findingCard(f));
  if (list.length > 600) host.appendChild(el('div.empty', 'Se muestran 600 de ' + list.length + ': use los filtros.'));
}

function findingCard(f) {
  const u = state.session.units[f.unit];
  const mod = moduleById(f.module);
  const sel = selected === f.id;
  const sug = (f.edited !== undefined && f.edited !== null) ? f.edited : f.suggestion;
  const body = el('div.t');
  if (f.quote) body.appendChild(el('del', f.quote));
  if (f.quote && sug) body.appendChild(document.createTextNode(' \u2192 '));
  if (sug) body.appendChild(el('ins', sug));
  if (!f.quote && !sug) body.appendChild(el('span.muted', CAT_LABELS[f.cat] || f.cat));
  const card = el('div.iss.' + f.sev + (sel ? '.sel' : '') + (f.state !== 'open' ? '.done' : ''), { 'data-id': f.id, onclick: (e) => { if (e.target.closest('button')) return; select(f.id); } },
    el('div.h', el('span.sev.' + f.sev, f.sev), el('span.mod', mod ? mod.short : f.module),
      f.sub ? el('span.mod', LOCAL_SUBS[f.sub] || f.sub) : null,
      f.verified === 'ok' ? el('span.state.accepted', '\u2713 verificado') : null,
      f.verified === 'edit' ? el('span.state.accepted', '\u270e verificado') : null,
      f.state !== 'open' ? el('span.state.' + f.state, STATE_LABELS[f.state]) : null,
      el('span.seg', u ? '\u00a7' + u.n : '')),
    body,
    el('div.why', f.reason || ''),
    f.verifierReason ? el('div.why', 'Verificador: ' + f.verifierReason) : null,
    el('div.src', (f.source === 'local' ? 'Sin IA \u00b7 0 tokens' : f.source === 'rule' ? 'Regla \u00b7 sin IA' : f.source === 'external' ? 'IA externa' : (f.model || 'IA') + (f.role === 'deep' ? ' \u00b7 a fondo' : f.role === 'cache' ? ' \u00b7 cach\u00e9' : '')) +
      (f.unanchored ? ' \u00b7 cita no localizada' : '')));
  const acts = el('div.acts');
  if (f.state === 'open') {
    acts.appendChild(el('button.btn.sm.primary', { disabled: !sug || (f.start == null && !(!f.quote && sug)), title: 'A', onclick: () => setState(f, 'accepted') }, 'Aceptar'));
    acts.appendChild(el('button.btn.sm', { title: 'E', onclick: () => edit(f) }, 'Editar'));
    acts.appendChild(el('button.btn.sm', { title: 'R', onclick: () => reject(f) }, 'Rechazar'));
    acts.appendChild(el('button.btn.sm', { onclick: () => setState(f, 'ignored') }, 'Ignorar'));
  } else {
    acts.appendChild(el('button.btn.sm', { onclick: () => setState(f, 'open') }, 'Deshacer'));
  }
  card.appendChild(acts);
  return card;
}

function setState(f, s) {
  updateFinding(f.id, { state: s });
  if (s !== 'open') moveNext(f.id);
}

async function edit(f) {
  const v = await promptDialog('Editar la correcci\u00f3n', 'Texto que sustituir\u00e1 a \u00ab' + (f.quote || '') + '\u00bb', (f.edited != null ? f.edited : f.suggestion) || '');
  if (v === null) return;
  updateFinding(f.id, { edited: v, state: 'accepted' });
  if (f.quote && v !== f.suggestion) {
    const r = await modal({ title: 'Crear una regla', body: el('p', '\u00bfQuiere crear una regla para que, en adelante, \u00ab' + f.quote + '\u00bb se se\u00f1ale y se proponga \u00ab' + v + '\u00bb?'),
      buttons: [{ label: 'No', value: null }, { label: 'Crear regla', kind: 'primary', value: 'ok' }] });
    if (r === 'ok') {
      await upsertRule({ origin: 'usuario', kind: 'forbid', modules: [f.module === 'local' ? 'style' : f.module], avoid: f.quote, es: v,
        note: 'Creada al corregir un hallazgo.', severity: f.sev, on: true });
      toast('Regla creada (Ajustes \u203a Reglas).', 'ok');
    }
  }
  moveNext(f.id);
}

async function reject(f) {
  updateFinding(f.id, { state: 'rejected' });
  moveNext(f.id);
  if (!f.quote || f.source === 'local') return;
  const t = toast('Rechazado. ', '', 6000);
  t.appendChild(el('button.btn.sm', { style: { marginLeft: '6px' }, onclick: async () => {
    await upsertRule({ origin: 'usuario', kind: 'ignore', modules: [f.module], avoid: f.quote, note: 'No se\u00f1alar: ' + (f.reason || '').slice(0, 120), severity: 'SUG', on: true });
    t.remove();
    toast('Regla \u00abignorar\u00bb creada: no se volver\u00e1 a se\u00f1alar.', 'ok');
  } }, 'No volver a se\u00f1alarlo'));
}

function moveNext(id) {
  const list = visibleFindings();
  const i = list.findIndex(f => f.id === id);
  const next = list[i + 1] || list[i - 1] || list.find(f => f.id !== id);
  if (next) select(next.id); else { selected = null; renderPanes(); }
}

function select(id) {
  selected = id;
  for (const c of document.querySelectorAll('#rv-findings .iss')) c.classList.toggle('sel', c.dataset.id === id);
  const card = document.querySelector('#rv-findings .iss[data-id="' + id + '"]');
  if (card) card.scrollIntoView({ block: 'nearest' });
  renderPanes(true);
}

function onKey(e) {
  if (state.view !== 'review' || e.ctrlKey || e.altKey || e.metaKey) return;
  if (e.target.closest && e.target.closest('input, textarea, select, .modal')) return;
  const list = visibleFindings();
  if (!list.length) return;
  const i = list.findIndex(f => f.id === selected);
  const f = list[i];
  const k = e.key.toLowerCase();
  if (k === 'j') { e.preventDefault(); select((list[i + 1] || list[0]).id); }
  else if (k === 'k') { e.preventDefault(); select((list[i - 1] || list[list.length - 1]).id); }
  else if (f && k === 'a' && f.state === 'open' && (f.edited || f.suggestion)) { e.preventDefault(); setState(f, 'accepted'); }
  else if (f && k === 'r' && f.state === 'open') { e.preventDefault(); reject(f); }
  else if (f && k === 'e' && f.state === 'open') { e.preventDefault(); edit(f); }
}

// ------------------------------------------------------------------ sheets

function renderPanes(scroll) {
  if (!state.session || state.view !== 'review') return;
  const s = state.session;
  $('#rv-src-title').textContent = 'ORIGINAL \u00b7 ' + (s.srcLang === 'fr' ? 'FR' : 'EN');
  const shown = visibleFindings();
  const byPara = new Map();
  const gaps = new Map();
  for (const f of shown) {
    const u = s.units[f.unit];
    if (!u || u.tgtPara === null) continue;
    if (f.start !== null && f.start !== undefined && f.end > f.start) {
      if (!byPara.has(u.tgtPara)) byPara.set(u.tgtPara, []);
      byPara.get(u.tgtPara).push(f);
    } else if (f.cat === 'OMI' || !f.quote) {
      if (!gaps.has(u.tgtPara)) gaps.set(u.tgtPara, []);
      gaps.get(u.tgtPara).push(f);
    }
  }
  const sel = state.findings.find(f => f.id === selected);
  const selUnit = sel ? s.units[sel.unit] : null;
  const keep = { src: panes.src.scrollTop, tgt: panes.tgt.scrollTop };
  renderDoc(panes.tgt, s.tgt, {
    decorate: (p) => _flatten(byPara.get(p.id) || [], selected),
    gaps: (p) => (gaps.get(p.id) || []).map(f => ({ at: p.text.length, label: '+ ' + (CAT_LABELS[f.cat] || f.cat).toLowerCase(), title: f.reason })),
    onParaClick: (p, ev) => {
      const m = ev.target.closest('mark[data-fids]');
      if (m) select(m.dataset.fids.split(',')[0]);
    }
  });
  renderDoc(panes.src, s.src, {});
  panes.src.scrollTop = keep.src;
  panes.tgt.scrollTop = keep.tgt;
  if (selUnit) {
    const a = selUnit.tgtPara !== null ? panes.tgt.querySelector('.p[data-pid="' + selUnit.tgtPara + '"]') : null;
    const b = selUnit.srcPara !== null ? panes.src.querySelector('.p[data-pid="' + selUnit.srcPara + '"]') : null;
    if (a) a.classList.add('hit');
    if (b) b.classList.add('hit');
    if (scroll) {
      const cur = panes.tgt.querySelector('mark.cur');
      (cur || a || b) && (cur || a || b).scrollIntoView({ block: 'center' });
      if (b) b.scrollIntoView({ block: 'center' });
    }
    $('#rv-unit-info').textContent = 'P\u00e1rrafo ' + selUnit.n;
  }
}

/** Overlapping findings -> non-overlapping marks (classes of the most severe finding). */
function _flatten(list, selectedId) {
  if (!list.length) return [];
  const cuts = new Set();
  for (const f of list) { cuts.add(f.start); cuts.add(f.end); }
  const pts = Array.from(cuts).sort((a, b) => a - b);
  const order = { CRI: 0, MAY: 1, MEN: 2, SUG: 3 };
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const cover = list.filter(f => f.start <= a && f.end >= b);
    if (!cover.length) continue;
    cover.sort((x, y) => order[x.sev] - order[y.sev]);
    const cur = cover.some(f => f.id === selectedId);
    out.push({ start: a, end: b, cls: 'f ' + cover[0].sev + (cur ? ' cur' : ''),
      attrs: { 'data-fids': cover.map(f => f.id).join(','), title: cover.map(f => (f.reason || '')).join(' \u2022 ') } });
  }
  return out;
}
