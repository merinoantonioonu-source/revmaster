/**
 * review-view.js - Step 2 "Revisar": module cards (run one or several), the plan with its estimated
 * cost, progress, the findings list (filters, accept/reject/edit, keyboard) and the two sheets.
 */

import { helpBtn, helpItem } from './help.js';
import { el, $, clear, toast, modal, fmtInt, fmtMoney, promptDialog, confirmDialog } from '../util/dom.js';
import { state, on, emit, addFindings, updateFinding, saveProjectSoon, setProfile } from '../state.js';
import { renderDoc } from './preview.js';
import { MODULES, moduleById, INPUT_ICONS, INPUT_LABELS, ROLE_LABELS } from '../review/module-list.js';
import { runLocalChecks, LOCAL_SUBS } from '../review/local-checks.js';
import { makePlan } from '../review/planner.js';
import { deferredCapability, startDeferred, checkDeferred, cancelDeferredRecord, DEFERRED_STATUS } from '../review/deferred.js';
import { runPlan, verifyFindings } from '../review/runner.js';
import { loadModuleConfig, saveModuleConfig } from '../review/module-config.js';
import { loadPrompts, CAT_LABELS } from '../review/prompts.js';
import { getEffectiveRules, loadRulesStore, upsertRule, SEV_LABELS } from '../rules/rules.js';
import { STATE_LABELS } from '../review/findings.js';
import { externalDialog, importDialog } from './mask-view.js';
import { exportCorrected, exportReportHtml, exportReportXlsx, exportFindingsJson, exportFeedbackXlsx } from '../export/exports.js';
import { createNav, findingPlace, peerSentence, sentencesOf } from './nav.js';
import { openFindingsWindow, syncFindingsWindow, findingsWindowSelect } from './findings-window.js';
import { openMenu } from './menu.js';

let root, toolsHost, panes = {};
let filt = { module: 'all', sev: 'all', state: 'open' };
let selected = null;
let running = null;           // { abort: AbortController, modules:[] }
let progress = {};            // moduleId -> { done, total, label, state:'run'|'done'|'err', msg }
let estimates = {};           // moduleId -> { tok, cost } | { error }
let selectedModules = new Set(['local', 'grammar', 'fidelity', 'integrity', 'style', 'coherence', 'conventions']);
let estTimer = null;
let nav = null;

export function mountReviewView(host, tools) {
  root = host;
  toolsHost = tools;
  root.appendChild(el('div.list',
    el('h4', 'Hallazgos', helpBtn('findings'), el('span.grow'),
      el('button.btn.sm', { title: 'Abrir los hallazgos en una ventana aparte, en forma de tabla', onclick: openTable }, '\u29c9 Tabla'),
      el('button.btn.sm', { title: 'Opciones de la lista', onclick: (e) => listMenu(e.currentTarget) }, '\u22ef')),
    el('div.filters#rv-bubbles'),
    el('div.scroll#rv-findings')));
  root.appendChild(el('div.work',
    el('div.modstrip#rv-modules'),
    el('div.panes',
      el('div.pane', el('div.pane-head', el('span#rv-src-title', 'ORIGINAL')), el('div.pane-body#rv-src')),
      el('div.pane', el('div.pane-head', el('span', 'TRADUCCI\u00d3N \u00b7 ES'), helpBtn('review-sheets'), el('span.grow'), el('span.muted#rv-unit-info')), el('div.pane-body#rv-tgt')))));
  panes = { src: $('#rv-src'), tgt: $('#rv-tgt') };
  nav = createNav({ panes, session: () => state.session });
  nav.attachHover();
  on('view', (v) => { if (v === 'review') { renderAll(); scheduleEstimates(); } });
  on('findings', () => { syncFindingsWindow(); if (state.view === 'review') { renderTools(); renderModules(); renderFindings(); renderPanes(); } });
  on('finding', () => { syncFindingsWindow(); if (state.view === 'review') { renderTools(); renderFindings(); renderPanes(); } });
  on('masked', () => { estimates = {}; if (state.view === 'review') { renderPanes(); scheduleEstimates(); } });
  on('project', () => {
    progress = {}; estimates = {}; selected = null;
    if (state.project && (state.project.deferred || []).some(r => r.status === 'running')) startDeferredPolling();
  });
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
    n('CRI') ? el('span.pill.err', n('CRI') + (n('CRI') === 1 ? ' cr\u00edtico' : ' cr\u00edticos')) : null,
    n('MAY') ? el('span.pill.warn', n('MAY') + (n('MAY') === 1 ? ' mayor' : ' mayores')) : null,
    n('MEN') ? el('span.pill.info', n('MEN') + (n('MEN') === 1 ? ' menor' : ' menores')) : null,
    n('SUG') ? el('span.pill.gray', n('SUG') + (n('SUG') === 1 ? ' sugerencia' : ' sugerencias')) : null,
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
  toolsHost.appendChild(helpBtn('review-tools'));
}

function moreMenu(anchor) {
  openMenu(anchor, [
    { label: 'Copiar para IA externa\u2026', onClick: externalDialog },
    { label: 'Importar respuesta de IA externa\u2026', onClick: importDialog },
    { sep: true },
    { label: 'Verificar los hallazgos pendientes de la IA', onClick: reverify },
    { label: 'Configurar m\u00f3dulos y modelos', onClick: () => emit('goto-settings', 'modules') },
    { label: 'Editar reglas', onClick: () => emit('goto-settings', 'rules') },
    { sep: true },
    helpItem('review-more', anchor)
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
    { label: 'Hallazgos para valorar (Excel)\u2026', onClick: feedbackDialog },
    { label: 'Hallazgos en JSON', onClick: exportFindingsJson },
    { sep: true },
    helpItem('review-export', anchor)
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
    } },
    { sep: true },
    helpItem('findings', anchor)
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
let _modCfg = {};
/** Estimated cost of the ticked modules (without redrawing the bar). */
function _updateTotal() {
  let total = 0, any = false;
  for (const id of selectedModules) {
    const est = estimates[id];
    if (_modCfg[id] && _modCfg[id].enabled === false) continue;
    if (est && !est.error) { total += est.cost || 0; any = true; }
  }
  const t = document.querySelector('#rv-modules .mtotal');
  if (t) t.textContent = any ? 'Marcados: ~' + fmtMoney(total) : '';
}
/** The module bar: one chip per module (tick = it runs with "Ejecutar seleccionados"; the small
 *  play button runs that module alone), the estimated cost of what is ticked and the Verifier. */
async function renderModules() {
  const host = $('#rv-modules');
  if (!host) return;
  const gen = ++_modsGen;
  const cfg = await loadModuleConfig();
  if (gen !== _modsGen) return;   // a newer call is drawing the bar
  clear(host);
  const defCard = _deferredCard();
  if (defCard) host.appendChild(defCard);
  let total = 0, anyEst = false;
  for (const m of MODULES) {
    if (m.id === 'verifier') continue;
    const off = m.ai && cfg[m.id] && cfg[m.id].enabled === false;
    const on = selectedModules.has(m.id) && !off;
    const p = progress[m.id];
    const st = p ? (p.state === 'run' ? 'run' : (p.state === 'err' ? 'err' : 'done')) : '';
    const count = state.findings.filter(f => f.module === m.id && f.state === 'open').length;
    const est = estimates[m.id];
    if (on && est && !est.error) { total += est.cost || 0; anyEst = true; }
    let stat = '';
    if (p && p.state === 'run') stat = p.total ? Math.round(100 * (p.done || 0) / Math.max(1, p.total)) + ' %' : '\u2026';
    else if (p && p.state === 'err') stat = '\u26a0';
    else if (count) stat = '\u2691 ' + count;
    else if (p && p.state === 'done') stat = '\u2713';
    const tip = [m.desc,
      m.ai ? (est ? (est.error || ('Coste estimado: ~' + fmtMoney(est.cost) + ' (' + fmtInt(est.tok) + ' tokens' + (est.cached ? ', ' + est.cached + ' p\u00e1rrafos en cach\u00e9' : '') + ')')) : 'Calculando el coste\u2026') : 'Sin IA: gratis.',
      off ? 'Desactivado en Ajustes \u203a M\u00f3dulos.' : '',
      p && p.msg ? (p.state === 'err' ? 'Error: ' : '') + p.msg : '',
      count ? count + ' hallazgos pendientes.' : ''].filter(Boolean).join('\n');
    const chk = el('input', { type: 'checkbox', checked: on ? true : null, disabled: off ? true : null, onchange: (e) => {
      if (e.target.checked) selectedModules.add(m.id); else selectedModules.delete(m.id);
      e.target.closest('.mchip').classList.toggle('on', e.target.checked);
      _updateTotal();
    } });
    const chip = el('label.mchip' + (on ? '.on' : '') + (off ? '.off' : '') + (st ? '.' + st : ''), { title: tip, 'data-mod': m.id },
      chk, el('span.nm', m.label),
      el('span.cost' + (est && est.error ? '.warn-t' : ''), m.ai ? (est && !est.error ? fmtMoney(est.cost) : (est && est.error ? (/clave/.test(est.error) ? 'sin clave' : 'sin estimar') : '')) : 'gratis'),
      stat ? el('span.stat', stat) : null,
      el('button.run', { type: 'button', title: 'Ejecutar solo ' + m.label, disabled: running ? true : null,
        onclick: (e) => { e.preventDefault(); e.stopPropagation(); runModules([m.id]); } }, '\u25b6'));
    if (p && p.state === 'run') chip.appendChild(el('i.bar', { style: { width: (p.total ? Math.round(100 * (p.done || 0) / Math.max(1, p.total)) : 30) + '%' } }));
    if (m.ai) modelLabel(m.id, m.roles[0]).then(t => { chip.title = tip + '\nModelo: ' + t + (m.roles.length > 1 ? ' (cribado)' : ''); });
    host.appendChild(chip);
  }
  host.appendChild(el('span.grow'));
  host.appendChild(el('span.mtotal', anyEst ? 'Marcados: ~' + fmtMoney(total) : ''));
  _modCfg = cfg;
  const vp = progress.verifier;
  host.appendChild(el('button.btn.sm' + (vp && vp.state === 'run' ? '.amber' : ''), { title: 'Pasa los hallazgos pendientes de la IA por el Verificador, que descarta los falsos positivos' + (vp && vp.msg ? '\n' + vp.msg : ''),
    disabled: running ? true : null, onclick: reverify }, '\u2713 Verificar hallazgos' + (vp && vp.state === 'run' ? '\u2026' : '')));
  host.appendChild(helpBtn('modules'));
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

// The semantic check needs a choice the first time (the local model is a large download).
function _semanticMode(ctx) {
  // An optional extra, off unless switched on in Ajustes > Modulos (no question, no download by surprise).
  const c = ctx.cfg.local || {};
  if (c.semantic === 'api' && !c.semProvider) { toast('Similitud sem\u00e1ntica: falta elegir el proveedor en Ajustes \u203a M\u00f3dulos.', 'warn', 7000); return null; }
  return c.semantic === 'local' || c.semantic === 'api' ? c.semantic : null;
}

/** Units the local layer suspects of an omission, an addition or a change of meaning. */
function _localFlags() {
  const flags = new Set();
  for (const f of state.findings) {
    if (f.module !== 'local' || f.state !== 'open') continue;
    if (['semantic', 'sentences', 'length', 'numbers', 'tags'].includes(f.sub) && ['OMI', 'ADD', 'MIST'].includes(f.cat)) {
      const u = state.session.units[f.unit];
      if (u) flags.add(u.n);
    }
  }
  return flags;
}

async function runModules(ids) {
  if (!state.session || running) return;
  const ctx = await _ctx();
  const wantLocal = ids.includes('local');
  const ai = ids.filter(id => id !== 'local' && id !== 'verifier' && moduleById(id) && moduleById(id).ai && ctx.cfg[id].enabled !== false);
  if (wantLocal) {
    let list = runLocalChecks(state.session, { rules: ctx.rules, conventions: state.data.conventions, profile: ctx.profile });
    const sem = _semanticMode(ctx);
    if (sem) {
      progress.local = { state: 'run', msg: 'Similitud sem\u00e1ntica\u2026' };
      renderModules();
      try {
        const { semanticFindings } = await import('../review/semantic.js');
        const r = await semanticFindings(state.session, Object.assign({}, ctx.cfg.local, { semantic: sem }), {
          project: { name: state.project.name, file: state.project.tgtName },
          onStatus: (msg) => { progress.local = { state: 'run', msg }; renderModules(); } });
        // The semantic finding names the missing sentence: it replaces the coarser ones of that paragraph.
        const semUnits = new Set(r.findings.filter(f => f.cat === 'OMI' || f.cat === 'MIST').map(f => f.unit));
        list = list.filter(f => !(semUnits.has(f.unit) && f.cat === 'OMI' && (f.sub === 'sentences' || f.sub === 'length'))).concat(r.findings);
      } catch (e) { console.warn('semantic', e); toast('Similitud sem\u00e1ntica: ' + e.message, 'warn', 9000); }
    }
    addFindings(list, ['local']);
    progress.local = { state: 'done', msg: list.length + ' hallazgos' };
    if (!ai.length) { toast('Comprobaciones sin IA: ' + list.length + ' hallazgos.', 'ok'); renderModules(); return; }
  }
  if (!ai.length) { renderModules(); return; }
  const plan = await makePlan(state.session, ctx, { modules: ai });
  if (plan.errors.length && !plan.groups.length && !plan.skeleton.length) {
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
  renderTools();
  renderModules();
  let res;
  try {
    res = await runPlan(plan, { session: state.session, project: { name: state.project.name, file: state.project.tgtName },
      prompts: ctx.prompts, cfg: ctx.cfg, rules: ctx.rules }, {
      signal: running.abort.signal, budget: ok.budget, localFlags: _localFlags(),
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

function planDialog(plan, budget, cap) {
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
  // Deferred mode: the first pass (and the skeleton calls) at about half the price; the deep pass and
  // the Verifier, which are small, run when the answers arrive, at the normal price.
  const firstPass = plan.groups.reduce((n, g) => n + (g.est.cost || 0) - ((g.est.deep && g.est.deep.cost) || 0), 0) +
    plan.skeleton.reduce((n, s) => n + (s.est.cost || 0), 0);
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
    el('p.info', 'Estimaci\u00f3n orientativa: el gasto real se registra en Uso de IA. Solo se env\u00eda texto enmascarado.' +
      (nothing ? ' No hay nada nuevo que enviar: todo est\u00e1 en la cach\u00e9.' : '')),
    el('label.lbl', 'Presupuesto m\u00e1ximo de esta ejecuci\u00f3n (US$)'), budgetIn,
    defBox);
  return modal({ title: 'Plan de ejecuci\u00f3n', help: helpBtn('plan'), body, width: '680px', buttons: [
    { label: 'Cancelar', value: null },
    { label: 'Ejecutar', kind: 'amber', value: 'go' }] }).then(r => r === 'go' ? { budget: parseFloat(budgetIn.value) || 0, deferred: !!defChk.checked } : null);
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
    (filt.state === 'all' ? true : (filt.state === 'rejected' ? (f.state === 'rejected' || f.state === 'ignored') : f.state === filt.state))
  ).sort((a, b) => (a.unit - b.unit) || ((a.start == null ? 1e9 : a.start) - (b.start == null ? 1e9 : b.start)));
}

/** Three labelled lists instead of a cloud of bubbles: state, module and severity. */
function renderFindings() {
  const box = $('#rv-bubbles');
  if (!box) return;
  clear(box);
  const all = state.findings;
  const n = (pred) => all.filter(pred).length;
  const inState = (f) => filt.state === 'all' ? true : (filt.state === 'rejected' ? (f.state === 'rejected' || f.state === 'ignored') : f.state === filt.state);
  const base = all.filter(inState);
  if (filt.module !== 'all' && !base.some(f => f.module === filt.module)) filt.module = 'all';
  const baseMod = base.filter(f => filt.module === 'all' || f.module === filt.module);
  if (filt.sev !== 'all' && !baseMod.some(f => f.sev === filt.sev)) filt.sev = 'all';
  const sel = (key, label, options, title) => {
    const s = el('select.fsel', { 'data-filter': key, title, onchange: (e) => { filt[key] = e.target.value; renderFindings(); renderPanes(); } },
      options.map(([v, t]) => el('option', { value: v }, t)));
    s.value = filt[key];
    return el('label.ffield', el('span', label), s);
  };
  box.appendChild(sel('state', 'Estado', [
    ['open', 'Pendientes (' + n(f => f.state === 'open') + ')'],
    ['accepted', 'Aceptados (' + n(f => f.state === 'accepted') + ')'],
    ['rejected', 'Rechazados o ignorados (' + n(f => f.state === 'rejected' || f.state === 'ignored') + ')'],
    ['discarded', 'Descartados por el Verificador (' + n(f => f.state === 'discarded') + ')'],
    ['all', 'Todos (' + all.length + ')']], 'Qu\u00e9 hallazgos ver seg\u00fan lo que usted ya decidi\u00f3'));
  box.appendChild(sel('module', 'M\u00f3dulo', [['all', 'Todos (' + base.length + ')']].concat(
    MODULES.filter(m => base.some(f => f.module === m.id)).map(m => [m.id, m.label + ' (' + base.filter(f => f.module === m.id).length + ')'])),
    'Qu\u00e9 m\u00f3dulo encontr\u00f3 el hallazgo'));
  box.appendChild(sel('sev', 'Gravedad', [['all', 'Todas (' + baseMod.length + ')']].concat(
    ['CRI', 'MAY', 'MEN', 'SUG'].filter(s => baseMod.some(f => f.sev === s)).map(s => [s, SEV_LABELS[s] + ' (' + baseMod.filter(f => f.sev === s).length + ')'])),
    'Cr\u00edtica: cambia el sentido. Mayor: error claro. Menor: detalle. Sugerencia: mejora opcional.'));
  const host = $('#rv-findings');
  clear(host);
  const list = visibleFindings();
  if (!list.length) {
    host.appendChild(el('div.empty', all.length ? 'No hay hallazgos con estos filtros.' :
      'Todav\u00eda no hay hallazgos. Marque los m\u00f3dulos arriba y pulse \u00abEjecutar seleccionados\u00bb, o empiece por las comprobaciones sin IA (gratis).'));
    return;
  }
  for (const f of list.slice(0, 600)) host.appendChild(findingCard(f));
  if (list.length > 600) host.appendChild(el('div.empty', 'Se muestran 600 de ' + list.length + ': use los filtros o la tabla (\u29c9).'));
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
      el('span.seg', { title: 'P\u00e1rrafo y oraci\u00f3n' }, '\u00a7' + _placeLabel(f))),
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

function _placeLabel(f) {
  const pl = state.session ? findingPlace(state.session, f) : null;
  return pl ? pl.label : '';
}

/** Selects a finding: card, mark and, unless the click came from a sheet, both sheets centred on its
 *  sentence (the exact text in stronger yellow). */
function select(id, opts) {
  const o = opts || {};
  selected = id;
  for (const c of document.querySelectorAll('#rv-findings .iss')) c.classList.toggle('sel', c.dataset.id === id);
  const card = document.querySelector('#rv-findings .iss[data-id="' + id + '"]');
  if (card) card.scrollIntoView({ block: o.fromPane ? 'center' : 'nearest' });
  for (const m of panes.tgt.querySelectorAll('mark.cur')) m.classList.remove('cur');
  for (const m of panes.tgt.querySelectorAll('mark[data-fids]')) if (m.dataset.fids.split(',').includes(id)) m.classList.add('cur');
  const f = state.findings.find(x => x.id === id);
  if (f) focusFinding(f, !!o.fromPane);
  findingsWindowSelect(id);
}

function focusFinding(f, quiet) {
  const s = state.session;
  const u = s && s.units[f.unit];
  if (!u) return;
  if (u.tgtPara !== null && f.start !== null && f.start !== undefined && f.end > f.start) nav.focusSpan('tgt', u.tgtPara, f.start, f.end, { quiet });
  else if (u.srcPara !== null && f.srcStart !== null && f.srcStart !== undefined) nav.focusSpan('src', u.srcPara, f.srcStart, f.srcEnd, { quiet });
  else if (!quiet) nav.focusParas(u.idx);
  const pl = findingPlace(s, f);
  $('#rv-unit-info').textContent = pl ? '\u00a7' + pl.label : '';
}

/** Findings of one sentence of the translation (to reveal them when it is clicked). */
function _findingsInSentence(pid, index) {
  const s = state.session;
  const sp = sentencesOf(s, 'tgt', pid)[index];
  const list = visibleFindings().filter(f => { const u = s.units[f.unit]; return u && u.tgtPara === pid; });
  if (!sp) return list;
  return list.filter(f => f.start === null || f.start === undefined ? false : (f.start < sp.end && (f.end || f.start) >= sp.start));
}

/** A click in a sheet: the sentence and its pair are marked (the other sheet follows) and, as in
 *  Final Check, a finding of that sentence is shown in the list (repeated clicks go through them). */
function onSheetClick(side, p, ev) {
  const m = side === 'tgt' && ev.target.closest('mark[data-fids]');
  const r = nav.clickAt(side, ev);
  let ids = [];
  if (m) ids = m.dataset.fids.split(',');
  else if (r && r.index !== null) {
    let pid = r.pid, index = r.index;
    if (side === 'src') { const peer = peerSentence(state.session, 'src', r.pid, r.index); pid = peer ? peer.pid : null; index = peer ? peer.index : null; }
    if (pid !== null) ids = (index === null ? visibleFindings().filter(f => { const u = state.session.units[f.unit]; return u && u.tgtPara === pid; }) : _findingsInSentence(pid, index)).map(f => f.id);
  }
  if (!ids.length) return;
  const i = ids.indexOf(selected);
  select(ids[(i + 1) % ids.length], { fromPane: true });
}

function onKey(e) {
  if (state.view !== 'review' || e.ctrlKey || e.altKey || e.metaKey) return;
  if (e.target.closest && e.target.closest('input, textarea, select, .modal')) return;
  const list = visibleFindings();
  if (!list.length) return;
  const i = list.findIndex(f => f.id === selected);
  const f = list[i];
  if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.shiftKey) { e.preventDefault(); nav.step(e.key === 'ArrowRight' ? 1 : -1); return; }
  const k = e.key.toLowerCase();
  if (k === 'j') { e.preventDefault(); select((list[i + 1] || list[0]).id); }
  else if (k === 'k') { e.preventDefault(); select((list[i - 1] || list[list.length - 1]).id); }
  else if (f && k === 'a' && f.state === 'open' && (f.edited || f.suggestion)) { e.preventDefault(); setState(f, 'accepted'); }
  else if (f && k === 'r' && f.state === 'open') { e.preventDefault(); reject(f); }
  else if (f && k === 'e' && f.state === 'open') { e.preventDefault(); edit(f); }
}

// ------------------------------------------------------------------ sheets

function renderPanes() {
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
  const keep = { src: panes.src.scrollTop, tgt: panes.tgt.scrollTop };
  renderDoc(panes.tgt, s.tgt, {
    decorate: (p) => _flatten(byPara.get(p.id) || [], selected),
    gaps: (p) => (gaps.get(p.id) || []).map(f => ({ at: p.text.length, label: '+ ' + (CAT_LABELS[f.cat] || f.cat).toLowerCase(), title: f.reason })),
    onParaClick: (p, ev) => onSheetClick('tgt', p, ev)
  });
  renderDoc(panes.src, s.src, { onParaClick: (p, ev) => onSheetClick('src', p, ev) });
  panes.src.scrollTop = keep.src;
  panes.tgt.scrollTop = keep.tgt;
  nav.refresh();
}

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

// ------------------------------------------------------------------ deferred batches

let _pollTimer = null;
let _polling = false;

function _deferredCard() {
  const recs = (state.project && state.project.deferred) || [];
  const shown = recs.filter(r => r.status === 'running' || (r.finishedAt && Date.now() - r.finishedAt < 7 * 86400000 && !r.dismissed) || (!r.finishedAt && !r.dismissed));
  if (!shown.length) return null;
  const card = el('div.mcard' + (shown.some(r => r.status === 'running') ? '.run' : '.done'), { style: { minWidth: '230px', maxWidth: '260px' } },
    el('div.nm', '\u23f3 Lotes diferidos', helpBtn('deferred')));
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
      const r = await checkDeferred(rec, { session: state.session, prompts: ctx.prompts, cfg: ctx.cfg, rules: ctx.rules }, {
        project: { name: state.project.name, file: state.project.tgtName }, localFlags: _localFlags(),
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

// ------------------------------------------------------------------ table window and feedback

/** The findings as a table in a window of their own (as the Transformations window of Final Check). */
function openTable() {
  if (!state.session) return;
  const ok = openFindingsWindow({
    filt: Object.assign({}, filt),
    select: (id) => select(id),
    setState: (f, st) => updateFinding(f.id, { state: st }),
    edit: (f, text) => updateFinding(f.id, { edited: text, state: 'accepted' }),
    exportFeedback: () => feedbackDialog(),
    selected: () => selected
  });
  if (!ok) toast('El navegador ha bloqueado la ventana: permita las ventanas emergentes de esta p\u00e1gina.', 'warn', 8000);
}

/** "Hallazgos para valorar (Excel)": real or masked text, all findings or the ones shown. */
async function feedbackDialog() {
  if (!state.session) return;
  const masked = el('input', { type: 'radio', name: 'fbtext', value: 'masked', checked: true });
  const real = el('input', { type: 'radio', name: 'fbtext', value: 'real' });
  const allF = el('input', { type: 'radio', name: 'fbwhich', value: 'all', checked: true });
  const vis = el('input', { type: 'radio', name: 'fbwhich', value: 'visible' });
  const r = await modal({ title: 'Hallazgos para valorar (Excel)', help: helpBtn('feedback'), width: '600px', body: el('div',
    el('p', 'Un Excel con una fila por hallazgo, su contexto y tres columnas vac\u00edas para usted: ', el('b', 'Su valoraci\u00f3n'), ' (lista desplegable), ',
      el('b', 'Gravedad correcta'), ' y ', el('b', 'Comentario'), '. Rell\u00e9nelo y env\u00edelo para ajustar las reglas y las comprobaciones.'),
    el('label.lbl', 'Texto'),
    el('div', el('label.row', masked, ' Enmascarado (recomendado si va a compartir el archivo: sin datos reales)')),
    el('div', el('label.row', real, ' Real')),
    el('label.lbl', 'Hallazgos'),
    el('div', el('label.row', allF, ' Todos (' + state.findings.length + ')')),
    el('div', el('label.row', vis, ' Solo los que se ven con los filtros actuales (' + visibleFindings().length + ')'))),
    buttons: [{ label: 'Cancelar', value: null }, { label: 'Descargar Excel', kind: 'primary', value: 'ok' }] });
  if (r !== 'ok') return;
  const ids = vis.checked ? new Set(visibleFindings().map(f => f.id)) : null;
  try {
    const n = await exportFeedbackXlsx({ masked: masked.checked, filter: ids ? (f) => ids.has(f.id) : null, subLabels: LOCAL_SUBS,
      segText: (f, isMasked) => {
        if (isMasked) return null;   // the masked texts are whole paragraphs (tags keep their positions there)
        const pl = findingPlace(state.session, f);
        return pl ? { label: pl.label, src: pl.src, tgt: pl.tgt } : null;
      } });
    toast(n + ' hallazgos exportados para valorar.', 'ok');
  } catch (e) { console.error(e); toast('No se pudo exportar: ' + e.message, 'err', 8000); }
}

