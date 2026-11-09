/**
 * main.js - Boot and shell of UMBRA: the side bar of steps (Archivos, Enmascarar, Revisar, Corregir,
 * Exportar) with the state of each, the view bar (title + tools of the screen), the Archivos screen
 * (drop zones, recent projects), projects dialog, sync chip, cost meter, dark mode, guide, F1 and
 * Ctrl+wheel zoom.
 */

import { el, $, $$, toast, modal, pickFiles, confirmDialog, fmtInt, fmtMoney, promptDialog } from './util/dom.js';
import { getValue, setValue } from './store/storage.js';
import { state, on, emit, loadData, openFiles, replaceFile, restoreLastProject, listProjects, openProject,
  deleteProject, closeProject, refreshLists, remaskNow, setUnmasked } from './state.js';
import { mountMaskView } from './ui/mask-view.js';
import { mountReviewView, benchDialog } from './ui/review-view.js';
import { mountCorrectView } from './ui/correct-view.js';
import { mountExportView } from './ui/export-view.js';
import { mountSettingsView, showSettingsSection, preselectSettingsSection } from './ui/settings-view.js';
import { showGuide } from './ui/guide.js';
import { helpBtn, showHelp } from './ui/help.js';
import { icon } from './ui/icons.js';
import { docTypeRow } from './ui/doc-type.js';

const VIEWS = ['files', 'mask', 'review', 'correct', 'export', 'settings'];
const TITLES = { files: 'Documentos', mask: 'Enmascarar', review: 'Revisar', correct: 'Corregir', export: 'Exportar', settings: 'Ajustes' };
const NEEDS_PROJECT = ['mask', 'review', 'correct', 'export'];
const WORK_VIEWS = ['mask', 'correct'];     // the side bar folds there to leave room for the sheets
let pending = { src: null, tgt: null };
// "Sin enmascarar" chosen before the two files are loaded (it never carries over to another project).
let pendingUnmasked = false;
let sidePref = null;                        // null = automatic; 'open' | 'closed' = chosen by the user
let reviewStatus = '';

/** Opens Settings at a section, mounting it once (not the previous section first). */
function goSettings(sec) {
  if (state.view === 'settings') { showSettingsSection(sec); return; }
  preselectSettingsSection(sec);
  setView('settings');
}

function setView(v) {
  if (!VIEWS.includes(v)) v = 'files';
  if (!state.project && NEEDS_PROJECT.includes(v)) v = 'files';
  state.view = v;
  for (const id of VIEWS) $('#view-' + id).classList.toggle('on', id === v);
  $('#vtitle').textContent = TITLES[v] || '';
  if (v === 'files' || v === 'settings') $('#tools').replaceChildren();
  emit('view', v);
  renderSteps();
  applySide();
}

// ------------------------------------------------------------------ side bar

function applySide() {
  const compact = sidePref ? sidePref === 'closed' : WORK_VIEWS.includes(state.view);
  $('#app').classList.toggle('compact', compact);
  const b = $('#btn-side');
  b.replaceChildren(icon(compact ? 'expand' : 'collapse', 16));
  b.title = compact ? 'Desplegar la barra de pasos' : 'Plegar la barra de pasos';
}

function _sub(id, text) { const n = $('#st-' + id); if (n) n.textContent = text; }

/** The steps with what each one has: files loaded, entities, review, pending findings. */
function renderSteps() {
  const p = state.project, s = state.session;
  const open = state.findings.filter(f => f.state === 'open').length;
  const done = {
    files: !!p,
    mask: !!(p && p.unmasked),
    review: !!p && state.findings.length > 0,
    correct: !!p && state.findings.length > 0 && !open,
    export: false
  };
  _sub('files', p ? (p.srcName + ' \u00b7 ' + p.tgtName) : 'Cargue los dos documentos');
  if (p && p.unmasked) _sub('mask', 'No necesario: sin enmascarar');
  else if (s) {
    const ents = s.ent.entities;
    const bad = ents.filter(e => e.status !== 'ok').length;
    _sub('mask', fmtInt(ents.length) + ' entidades' + (bad ? ' \u00b7 ' + bad + ' por revisar' : ''));
  } else _sub('mask', 'Proteger los datos');
  _sub('review', reviewStatus || (state.findings.length ? 'Hecho: puede repetirlo' : 'Elegir qu\u00e9 buscar'));
  _sub('correct', !p ? 'Aceptar o descartar' : (open ? open + ' por revisar' : (state.findings.length ? 'Todo decidido' : 'Sin hallazgos todav\u00eda')));
  // A project "Sin enmascarar" says so on every screen.
  $('#side-proj').textContent = p ? p.name : 'Sin proyecto';
  let badge = $('#side-unmask');
  if (!badge) {
    badge = el('span.unmask-badge#side-unmask', { title: 'Este proyecto se revisa sin enmascarar: a la IA llega el texto real (se cambia en Archivos)' }, 'Sin enmascarar');
    $('#side-proj').after(badge);
  }
  badge.classList.toggle('hidden', !(p && p.unmasked));
  for (const b of $$('.step')) {
    const v = b.dataset.view;
    b.classList.toggle('on', v === state.view);
    b.classList.toggle('done', !!done[v] && v !== state.view);
    b.disabled = !p && NEEDS_PROJECT.includes(v);
    const tx = b.querySelector('.tx');
    if (tx) b.title = tx.textContent.replace(/\s+/g, ' ').trim();
    const n = b.querySelector('.n');
    if (n) {
      const num = String(['files', 'mask', 'review', 'correct', 'export'].indexOf(v) + 1);
      if (done[v] && v !== state.view) n.replaceChildren(icon('check', 14)); else n.textContent = num;
    }
  }
}

// ------------------------------------------------------------------ Archivos: drop zones

function makeDrop(side) {
  const box = el('div.drop#drop-' + side, { title: 'Pulse o arrastre aqu\u00ed ' + (side === 'src' ? 'el original' : 'la traducci\u00f3n') + ' (DOCX, PPTX o XLSX)' },
    el('div.dic', icon(side === 'src' ? 'file' : 'pencil', 26)),
    el('div.dtx',
      el('div.lbl', side === 'src' ? 'ORIGINAL \u00b7 INGL\u00c9S O FRANC\u00c9S' : 'TRADUCCI\u00d3N \u00b7 ESPA\u00d1OL', helpBtn('files')),
      el('div.fn', 'Pulse o arrastre el archivo'),
      el('div.mt', 'DOCX, PPTX o XLSX exportado de eLUNa')));
  const choose = async () => {
    const files = await pickFiles('.docx,.pptx,.xlsx', false);
    if (files[0]) handleFile(side, files[0]);
  };
  box.addEventListener('click', choose);
  box.addEventListener('dragover', (e) => { e.preventDefault(); box.classList.add('over'); });
  box.addEventListener('dragleave', () => box.classList.remove('over'));
  box.addEventListener('drop', (e) => {
    e.preventDefault();
    box.classList.remove('over');
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) handleFile(side, f);
  });
  return box;
}

async function handleFile(side, file) {
  if (!/\.(docx|pptx|xlsx)$/i.test(file.name)) { toast('Formato no admitido: use DOCX, PPTX o XLSX.', 'err'); return; }
  try {
    if (state.project) {
      const ok = await confirmDialog('Cambiar ' + (side === 'src' ? 'el original' : 'la traducci\u00f3n'),
        'Se cargar\u00e1 \u00ab' + file.name + '\u00bb en este proyecto y se borrar\u00e1n sus hallazgos. \u00bfContinuar? (Para empezar otro documento, use \u00abNuevo proyecto\u00bb.)', 'Cambiar');
      if (!ok) return;
      await replaceFile(side, file);
      return;
    }
    pending[side] = file;
    updateDrops();
    if (pending.src && pending.tgt) {
      const s = pending.src, t = pending.tgt;
      pending = { src: null, tgt: null };
      const unmasked = pendingUnmasked;
      pendingUnmasked = false;
      await openFiles(s, t, { unmasked });
      if (unmasked) { setView('review'); toast('Documentos cargados sin enmascarar: elija los revisores.', 'ok'); }
      else { setView('mask'); toast('Documentos cargados. Revise las entidades enmascaradas.', 'ok'); }
    }
  } catch (e) {
    console.error(e);
    pending[side] = null;
    updateDrops();
    toast('No se pudo abrir: ' + e.message, 'err', 7000);
  }
}

function updateDrops() {
  for (const side of ['src', 'tgt']) {
    const box = $('#drop-' + side);
    if (!box) continue;
    let name = '', meta = 'DOCX, PPTX o XLSX exportado de eLUNa';
    if (state.project) {
      const model = side === 'src' ? state.src : state.tgt;
      name = side === 'src' ? state.project.srcName : state.project.tgtName;
      if (model) {
        const n = model.paras.filter(p => p.text.trim() && !p.isSlideSep).length;
        const words = model.paras.reduce((k, p) => k + (p.text.match(/\S+/g) || []).length, 0);
        meta = model.kind.toUpperCase() + ' \u00b7 ' + fmtInt(n) + ' p\u00e1rrafos \u00b7 ' + fmtInt(words) + ' palabras' +
          (side === 'src' ? ' \u00b7 ' + (state.project.srcLang === 'fr' ? 'franc\u00e9s' : 'ingl\u00e9s') : '') + ' \u00b7 pulse para cambiarlo';
      }
    } else if (pending[side]) {
      name = pending[side].name;
      meta = 'Falta ' + (side === 'src' ? 'la traducci\u00f3n' : 'el original');
    }
    box.classList.toggle('loaded', !!name);
    box.querySelector('.fn').textContent = name || 'Pulse o arrastre el archivo';
    box.querySelector('.mt').textContent = meta;
  }
  const next = $('#files-next');
  if (next) {
    next.classList.toggle('hidden', !state.project);
    const um = !!(state.project && state.project.unmasked);
    next.replaceChildren(um ? 'Siguiente: revisar' : 'Siguiente: enmascarar', icon('arrow', 16));
  }
  const chk = $('#files-unmask-chk');
  if (chk) chk.checked = state.project ? !!state.project.unmasked : pendingUnmasked;
  const box = $('#files-unmask');
  if (box) box.classList.toggle('on', !!(chk && chk.checked));
}

/**
 * "Sin enmascarar": the text is already published, so its real words may go to the AI. Asked every time
 * it is switched on; it belongs to this project only.
 */
async function onUnmaskToggle(chk) {
  if (chk.checked) {
    const ok = await confirmDialog('Sin enmascarar',
      'La IA recibir\u00e1 el texto completo de los dos documentos tal cual: nombres, cargos, cifras, fechas y todo lo dem\u00e1s. ' +
      '\u00daselo solo con textos ya publicados. Vale solo para este proyecto.', 'Revisar sin enmascarar');
    if (!ok) { chk.checked = false; updateDrops(); return; }
  }
  if (state.project) setUnmasked(chk.checked); else pendingUnmasked = chk.checked;
  updateDrops();
  renderSteps();
  toast(chk.checked ? 'Sin enmascarar: a la IA llegar\u00e1 el texto real de este proyecto.' : 'El texto vuelve a salir enmascarado.', chk.checked ? 'warn' : 'ok');
}

// ------------------------------------------------------------------ Archivos: the screen

function mountFiles() {
  const host = $('#view-files');
  const open = el('button.btn', { onclick: openUmbra }, icon('upload', 16), 'Abrir proyecto (.umbra)');
  host.appendChild(el('div.page',
    el('div.page-in',
      el('div.kicker', 'PASO 1 DE 5'),
      el('h2.ptitle', 'Los dos documentos'),
      el('p.lead', 'Todo se procesa en este navegador: los documentos no se suben a ning\u00fan servidor. A la IA solo llega texto enmascarado (salvo que marque \u00abSin enmascarar\u00bb).'),
      el('div.drops', makeDrop('src'), makeDrop('tgt')),
      el('label.unmask#files-unmask',
        el('input#files-unmask-chk', { type: 'checkbox', onchange: (e) => onUnmaskToggle(e.currentTarget) }),
        el('span', el('b', 'Sin enmascarar'), ' \u00b7 para un texto ya publicado: la IA recibe el texto real, sin etiquetas, y no hace falta el paso Enmascarar'),
        helpBtn('unmasked')),
      docTypeRow('files-doctype'),
      el('div.page-acts',
        el('button.btn.primary.big#files-next.hidden', { onclick: () => setView(state.project && state.project.unmasked ? 'review' : 'mask') }, 'Siguiente: enmascarar', icon('arrow', 16)),
        el('span.grow'),
        el('button.btn', { onclick: newProject }, icon('plus', 16), 'Nuevo proyecto'),
        open,
        el('button.btn', { onclick: () => benchDialog() }, icon('bench', 16), 'Banco de pruebas')),
      el('p.info', 'Antes de usar la IA, configure al menos un proveedor con su clave en ',
        el('a', { href: '#', onclick: (e) => { e.preventDefault(); goSettings('providers'); } }, 'Ajustes \u203a Proveedores y modelos'),
        '. Junto a cada funci\u00f3n hay un bot\u00f3n ', el('b', '?'), ' que explica c\u00f3mo se usa; F1 abre la ayuda de la pantalla.'),
      el('div#files-recent'))));
}

async function renderRecent() {
  const host = $('#files-recent');
  if (!host) return;
  const recent = await listProjects();
  host.replaceChildren();
  if (!recent.length) return;
  host.appendChild(el('h3.sec', 'Proyectos recientes'));
  const t = el('table.grid.recent');
  for (const p of recent.slice(0, 8)) {
    const cur = state.project && state.project.id === p.id;
    t.appendChild(el('tr',
      el('td', el('b', p.name), el('div.muted', p.srcName + ' \u2192 ' + p.tgtName)),
      el('td.muted', new Date(p.updatedAt).toLocaleString('es')),
      el('td.muted', p.findings + ' hallazgos'),
      el('td', { style: { textAlign: 'right' } }, cur ? el('span.pill.ok', 'Abierto') : el('button.btn.sm', { onclick: () => doOpen(p.id) }, 'Abrir'))));
  }
  host.appendChild(t);
}

async function openUmbra() {
  const files = await pickFiles('.umbra', false);
  if (!files[0]) return;
  try {
    const { importProjectFile } = await import('./export/exports.js');
    const p = await importProjectFile(files[0], () => promptDialog('Proyecto cifrado', 'Contrase\u00f1a', '', { type: 'password' }));
    if (p) { toast('Proyecto abierto.', 'ok'); setView('mask'); }
  } catch (e) { toast('No se pudo abrir: ' + e.message, 'err', 8000); }
}

function newProject() {
  closeProject();
  pending = { src: null, tgt: null };
  pendingUnmasked = false;
  updateDrops();
  setView('files');
  renderRecent();
}

async function doOpen(id) {
  try { await openProject(id); setView('mask'); } catch (e) { toast(e.message, 'err'); }
}

async function projectsDialog() {
  const list = await listProjects();
  const body = el('div');
  if (!list.length) body.appendChild(el('p.muted', 'No hay proyectos guardados en este navegador.'));
  const t = el('table.grid');
  for (const p of list) {
    t.appendChild(el('tr',
      el('td', el('b', p.name), el('div.muted', p.srcName + ' \u2192 ' + p.tgtName)),
      el('td.muted', new Date(p.updatedAt).toLocaleString('es')),
      el('td', { style: { whiteSpace: 'nowrap', textAlign: 'right' } },
        el('button.btn.sm.primary', { onclick: async () => { document.querySelector('.modal-back').remove(); await doOpen(p.id); } }, 'Abrir'), ' ',
        el('button.btn.sm.danger', { onclick: async (e) => {
          if (!(await confirmDialog('Borrar proyecto', 'Se borrar\u00e1 \u00ab' + p.name + '\u00bb de este navegador (documentos, entidades y hallazgos).', 'Borrar'))) return;
          await deleteProject(p.id); e.target.closest('tr').remove(); if (!state.project) setView('files'); renderRecent();
        } }, 'Borrar'))));
  }
  body.appendChild(t);
  await modal({ title: 'Proyectos', body, width: '720px', buttons: [
    { label: 'Nuevo proyecto', kind: 'primary', value: 'new', onClick: newProject },
    { label: 'Cerrar', value: null }] });
}

// ------------------------------------------------------------------ sync chip and cost meter

async function initServices() {
  // Cost meter (ai/usage.js) and sync chip (sync/*), loaded defensively so a failure there never
  // blocks the masking screens.
  try {
    const usage = await import('./ai/usage.js');
    const paint = () => {
      const t = usage.getSessionTotals ? usage.getSessionTotals() : null;
      if (!t) return;
      const tok = (t.input || 0) + (t.output || 0) + (t.thoughts || 0);
      $('#cost-chip').textContent = 'Sesi\u00f3n: ' + fmtInt(tok) + ' tokens \u00b7 ' + fmtMoney(t.cost || 0);
    };
    if (usage.onUsage) usage.onUsage(paint);
    paint();
  } catch (e) { console.warn('usage', e); }
  try {
    const sync = await import('./sync/sync-fs.js');
    const chip = $('#sync-chip');
    const paint = (s) => {
      s = s || (sync.getSyncState ? sync.getSyncState() : null) || {};
      const dot = chip.querySelector('.dot'), txt = chip.querySelector('.txt');
      chip.classList.remove('warn');
      dot.className = 'dot';
      if (!s.linked) { txt.textContent = 'Sin sincronizar'; }
      else if (s.state === 'needs_gesture') { chip.classList.add('warn'); txt.textContent = 'Guardar'; dot.className = 'dot warn'; }
      else if (s.state === 'error') { dot.className = 'dot err'; txt.textContent = 'Error de sincronizaci\u00f3n'; }
      else if (s.state === 'saving') { dot.className = 'dot warn'; txt.textContent = 'Guardando\u2026'; }
      else { dot.className = 'dot ok'; txt.textContent = 'Sincronizado \u00b7 ' + (s.fileName || '') + (s.at ? ' \u00b7 ' + _ago(s.at) : ''); }
      chip.title = s.message || 'Archivo de sincronizaci\u00f3n';
    };
    if (sync.onSyncState) sync.onSyncState(paint);
    chip.addEventListener('click', async () => {
      const s = sync.getSyncState ? sync.getSyncState() : {};
      if (s.linked && s.state === 'needs_gesture' && sync.saveToSyncFile) {
        try { await sync.saveToSyncFile(); toast('Guardado en el archivo de sincronizaci\u00f3n.', 'ok'); } catch (e) { toast(e.message, 'err'); }
      } else { goSettings('sync'); }
    });
    paint();
    setInterval(() => paint(), 60000);
    // First the question about the sync file (traer / guardar), then the autosave, as COMeT does.
    const auto = await import('./sync/sync-autosave.js').catch(e => { console.warn('autosave', e); return null; });
    setTimeout(async () => {
      try { if (sync.startupSyncCheck) await sync.startupSyncCheck(); } catch (e) { console.warn('sync check', e); }
      try { if (auto && auto.initAutosave) auto.initAutosave(); } catch (e) { console.warn('autosave', e); }
    }, 600);
    // After bringing data from the file (or undoing it), the lists and models may have changed.
    window.addEventListener('umbra:sync-pulled', async () => {
      try { await refreshLists(); if (state.session) remaskNow(); } catch (_) {}
      emit('synced');
      if (state.view === 'settings') emit('goto', 'settings');
    });
  } catch (e) { console.warn('sync', e); }
}

function _ago(at) {
  const s = Math.round((Date.now() - new Date(at).getTime()) / 1000);
  if (s < 60) return 'ahora';
  if (s < 3600) return 'hace ' + Math.round(s / 60) + ' min';
  if (s < 86400) return 'hace ' + Math.round(s / 3600) + ' h';
  return new Date(at).toLocaleDateString('es');
}

// ------------------------------------------------------------------ dark mode and zoom

async function initDark() {
  const apply = (on) => document.documentElement.classList.toggle('umbra-dark', !!on);
  const prefs = await getValue('prefs', { updatedAt: 0 });
  apply(prefs.dark);
  $('#btn-dark').addEventListener('click', async () => {
    const p = await getValue('prefs', { updatedAt: 0 });
    p.dark = !p.dark;
    p.updatedAt = Date.now();
    await setValue('prefs', p);
    apply(p.dark);
  });
}

async function initZoom() {
  // Two areas, as COMeT: the controls (bars, lists, cards) and the document text (sheets and rows).
  let ui = parseFloat(await getValue('zoom_ui', 1)) || 1;
  let sheet = parseFloat(await getValue('zoom_sheet', 1)) || 1;
  const apply = () => {
    document.documentElement.style.setProperty('--ui-z', ui);
    document.documentElement.style.setProperty('--sheet-z', sheet);
  };
  apply();
  window.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const step = e.deltaY < 0 ? 0.1 : -0.1;
    if (e.target.closest && e.target.closest('.pane-body, .cx-rows')) {
      sheet = Math.max(0.5, Math.min(2.5, Math.round((sheet + step) * 10) / 10));
      setValue('zoom_sheet', sheet);
    } else {
      ui = Math.max(0.7, Math.min(1.8, Math.round((ui + step) * 10) / 10));
      setValue('zoom_ui', ui);
    }
    apply();
  }, { passive: false });
}

// ------------------------------------------------------------------ F1: help of the current screen

const F1_TOPIC = { files: 'files', mask: 'mask-tools', review: 'modules', correct: 'review-tools', export: 'review-export' };

function initF1() {
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'F1') return;
    e.preventDefault();
    // An open dialog with its own help comes first.
    const backs = $$('.modal-back');
    const inModal = backs.length ? backs[backs.length - 1].querySelector('.modal-head .help-btn') : null;
    if (inModal) { inModal.click(); return; }
    if (state.view === 'settings') {
      const first = $('#view-settings .settings-body .help-btn');
      if (first) { first.click(); return; }
    }
    showHelp(F1_TOPIC[state.view] || 'files', null);
  });
}

// ------------------------------------------------------------------ boot

async function boot() {
  for (const b of $$('.step')) b.addEventListener('click', () => setView(b.dataset.view));
  for (const s of $$('.sic[data-icon]')) s.replaceWith(icon(s.dataset.icon, 18));
  $('#btn-side').addEventListener('click', () => {
    const compact = $('#app').classList.contains('compact');
    sidePref = compact ? 'open' : 'closed';
    applySide();
  });
  mountFiles();
  $('#btn-projects').addEventListener('click', projectsDialog);
  $('#btn-help').addEventListener('click', showGuide);
  $('#btn-help').title = 'Gu\u00eda r\u00e1pida (F1: ayuda de la pantalla en la que est\u00e1)';
  initF1();
  initDark();
  initZoom();
  let busyToast = null;
  on('busy', (msg) => { if (busyToast) { busyToast.remove(); busyToast = null; } if (msg) busyToast = toast(msg, '', 60000); });
  on('project', () => { updateDrops(); renderSteps(); renderRecent(); if (!state.project && NEEDS_PROJECT.includes(state.view)) setView('files'); });
  on('findings', renderSteps);
  on('finding', renderSteps);
  on('masked', renderSteps);
  on('project-flags', () => { renderSteps(); updateDrops(); });
  on('review-status', (t) => { reviewStatus = t || ''; renderSteps(); });
  on('goto', (v) => setView(v));
  on('goto-settings', (sec) => goSettings(sec));
  on('view', (v) => { if (v === 'files') renderRecent(); });
  await loadData();
  // The models chosen before the simplification of the reviewers, carried over once (registry.js).
  try { await (await import('./ai/registry.js')).migrateModuleModels(); } catch (e) { console.warn('module models', e); }
  mountMaskView($('#view-mask'), $('#tools'));
  mountReviewView($('#view-review'), $('#tools'));
  mountCorrectView($('#view-correct'), $('#tools'));
  mountExportView($('#view-export'), $('#tools'));
  mountSettingsView($('#view-settings'), $('#tools'));
  initServices();
  let restored = false;
  try { restored = await restoreLastProject(); } catch (e) { console.warn('restore', e); toast('No se pudo reabrir el \u00faltimo proyecto: ' + e.message, 'warn'); }
  updateDrops();
  setView(restored ? 'mask' : 'files');
  if (!(await getValue('guide_seen', false))) { setValue('guide_seen', true); showGuide(); }
}

window.addEventListener('error', (e) => console.error('UMBRA error', e.error || e.message));
boot().catch(e => { console.error(e); toast('Error al iniciar UMBRA: ' + e.message, 'err', 10000); });

export { setView };
