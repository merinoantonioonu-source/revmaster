/**
 * main.js - Boot and shell of UMBRA: header (steps, sync chip, cost meter), drop zones, rail, views,
 * projects dialog, dark mode, guide and Ctrl+wheel zoom.
 */

import { el, $, $$, toast, modal, pickFiles, confirmDialog, fmtInt, fmtMoney } from './util/dom.js';
import { getValue, setValue } from './store/storage.js';
import { state, on, emit, loadData, openFiles, replaceFile, restoreLastProject, listProjects, openProject,
  deleteProject, closeProject, refreshLists, remaskNow } from './state.js';
import { mountMaskView } from './ui/mask-view.js';
import { mountReviewView } from './ui/review-view.js';
import { mountSettingsView, showSettingsSection, preselectSettingsSection } from './ui/settings-view.js';
import { showGuide } from './ui/guide.js';
import { helpBtn, showHelp } from './ui/help.js';

const VIEWS = ['welcome', 'mask', 'review', 'settings'];
let pending = { src: null, tgt: null };

/** Opens Settings at a section, mounting it once (not the previous section first). */
function goSettings(sec) {
  if (state.view === 'settings') { showSettingsSection(sec); return; }
  preselectSettingsSection(sec);
  setView('settings');
}

function setView(v) {
  if (!state.project && (v === 'mask' || v === 'review')) v = 'welcome';
  state.view = v;
  for (const id of VIEWS) $('#view-' + id).classList.toggle('on', id === v);
  for (const b of $$('.step')) b.classList.toggle('on', b.dataset.view === v || (v === 'welcome' && b.dataset.view === 'mask'));
  emit('view', v);
  renderRail();
}

// ------------------------------------------------------------------ rail

function renderRail() {
  const rail = $('#rail');
  rail.innerHTML = '';
  const open = state.findings.filter(f => f.state === 'open').length;
  const items = [
    { id: 'mask', icon: '\u29c9', label: 'Entid.', title: 'Entidades', go: () => setView('mask') },
    { id: 'review', icon: '\u2691', label: 'Hallaz.', title: 'Hallazgos', go: () => setView('review'), badge: open },
    { id: 'modules', icon: '\u25a6', label: 'M\u00f3dul.', title: 'M\u00f3dulos y modelos', go: () => goSettings('modules') },
    { id: 'usage', icon: '$', label: 'Uso IA', title: 'Uso de IA', go: () => goSettings('usage') }
  ];
  for (const it of items) {
    const on = (it.id === state.view);
    rail.appendChild(el('button' + (on ? '.on' : ''), { title: it.title, onclick: it.go },
      it.icon, it.badge ? el('span.badge', String(it.badge)) : null, el('small', it.label)));
  }
}

// ------------------------------------------------------------------ drop zones

function setupDrop(side) {
  const box = $('#drop-' + side);
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
      await openFiles(s, t);
      setView('mask');
      toast('Documentos cargados. Revise las entidades enmascaradas.', 'ok');
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
    let name = '', meta = '\u00a0';
    if (state.project) {
      const model = side === 'src' ? state.src : state.tgt;
      name = side === 'src' ? state.project.srcName : state.project.tgtName;
      if (model) {
        const n = model.paras.filter(p => p.text.trim() && !p.isSlideSep).length;
        const words = model.paras.reduce((k, p) => k + (p.text.match(/\S+/g) || []).length, 0);
        meta = model.kind.toUpperCase() + ' \u00b7 ' + fmtInt(n) + ' p\u00e1rrafos \u00b7 ' + fmtInt(words) + ' palabras' +
          (side === 'src' ? ' \u00b7 ' + (state.project.srcLang === 'fr' ? 'franc\u00e9s' : 'ingl\u00e9s') : '');
      }
    } else if (pending[side]) {
      name = pending[side].name;
      meta = 'Falta ' + (side === 'src' ? 'la traducci\u00f3n' : 'el original');
    }
    box.classList.toggle('loaded', !!name);
    box.querySelector('.fn').textContent = name || 'Pulse o arrastre el archivo';
    box.querySelector('.mt').textContent = meta;
  }
}

// ------------------------------------------------------------------ welcome and projects

async function renderWelcome() {
  const host = $('#view-welcome');
  host.innerHTML = '';
  const recent = await listProjects();
  const box = el('div.box',
    el('h2', 'UMBRA \u00b7 Enmascaramiento y revisi\u00f3n de traducciones'),
    el('p.muted', 'Todo se procesa en este navegador: los documentos no se suben a ning\u00fan servidor. Solo el texto enmascarado puede ir a una IA.'),
    el('ol',
      el('li', 'Cargue arriba el ', el('b', 'original'), ' (ingl\u00e9s o franc\u00e9s) y la ', el('b', 'traducci\u00f3n'), ' (espa\u00f1ol): DOCX, PPTX o XLSX exportados de eLUNa.'),
      el('li', 'Paso 1: revise las ', el('b', 'entidades enmascaradas'), ' y exporte el documento censurado si quiere usarlo en una IA externa.'),
      el('li', 'Paso 2: ejecute los ', el('b', 'm\u00f3dulos de revisi\u00f3n'), ' y acepte o rechace los hallazgos.'),
      el('li', 'Paso 3: exporte la traducci\u00f3n con control de cambios y comentarios, o un informe.')),
    el('p.info', 'Junto a cada funci\u00f3n hay un bot\u00f3n ', el('b', '?'), ' que explica al momento c\u00f3mo se usa; F1 abre la ayuda de la pantalla en la que est\u00e9.'),
    el('p.info', 'Antes de usar la IA, configure al menos un proveedor con su clave en ', el('a', { href: '#', onclick: (e) => { e.preventDefault(); goSettings('providers'); } }, 'Exportar y ajustes \u203a Proveedores'), '.'));
  if (recent.length) {
    box.appendChild(el('h3', { style: { margin: '14px 0 6px', fontSize: '13px' } }, 'Proyectos recientes'));
    const t = el('table.grid');
    for (const p of recent.slice(0, 8)) {
      t.appendChild(el('tr', el('td', el('b', p.name)), el('td.muted', new Date(p.updatedAt).toLocaleString('es')),
        el('td', p.findings + ' hallazgos'),
        el('td', { style: { textAlign: 'right' } }, el('button.btn.sm.primary', { onclick: () => doOpen(p.id) }, 'Abrir'))));
    }
    box.appendChild(t);
  }
  host.appendChild(el('div.welcome', box));
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
          await deleteProject(p.id); e.target.closest('tr').remove(); if (!state.project) { setView('welcome'); renderWelcome(); }
        } }, 'Borrar'))));
  }
  body.appendChild(t);
  await modal({ title: 'Proyectos', body, width: '720px', buttons: [
    { label: 'Nuevo proyecto', kind: 'primary', value: 'new', onClick: () => { closeProject(); pending = { src: null, tgt: null }; updateDrops(); setView('welcome'); renderWelcome(); } },
    { label: 'Cerrar', value: null }] });
}

// ------------------------------------------------------------------ header chips

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
    // After bringing data from the file (or undoing it), the lists, rules and models may have changed.
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
  // Two areas, as COMeT: the controls (header, bars, lists) and the document sheets.
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
    if (e.target.closest && e.target.closest('.pane-body')) {
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
    showHelp(state.view === 'mask' ? 'mask-tools' : state.view === 'review' ? 'review-tools' : 'files', null);
  });
}

// ------------------------------------------------------------------ boot

async function boot() {
  for (const b of $$('.step')) b.addEventListener('click', () => setView(b.dataset.view));
  setupDrop('src');
  setupDrop('tgt');
  $('#btn-projects').addEventListener('click', projectsDialog);
  $('#btn-help').addEventListener('click', showGuide);
  $('#btn-help').title = 'Gu\u00eda r\u00e1pida (F1: ayuda de la pantalla en la que est\u00e1)';
  for (const side of ['src', 'tgt']) $('#drop-' + side + ' .lbl').appendChild(helpBtn('files'));
  initF1();
  initDark();
  initZoom();
  let busyToast = null;
  on('busy', (msg) => { if (busyToast) { busyToast.remove(); busyToast = null; } if (msg) busyToast = toast(msg, '', 60000); });
  on('project', () => { updateDrops(); renderRail(); if (!state.project) renderWelcome(); });
  on('findings', renderRail);
  on('finding', renderRail);
  on('goto', (v) => setView(v));
  on('goto-settings', (sec) => goSettings(sec));
  await loadData();
  mountMaskView($('#view-mask'), $('#tools'));
  mountReviewView($('#view-review'), $('#tools'));
  mountSettingsView($('#view-settings'), $('#tools'));
  initServices();
  let restored = false;
  try { restored = await restoreLastProject(); } catch (e) { console.warn('restore', e); toast('No se pudo reabrir el \u00faltimo proyecto: ' + e.message, 'warn'); }
  updateDrops();
  if (restored) setView('mask'); else { await renderWelcome(); setView('welcome'); }
  if (!(await getValue('guide_seen', false))) { setValue('guide_seen', true); showGuide(); }
}

window.addEventListener('error', (e) => console.error('UMBRA error', e.error || e.message));
boot().catch(e => { console.error(e); toast('Error al iniciar UMBRA: ' + e.message, 'err', 10000); });

export { setView };
