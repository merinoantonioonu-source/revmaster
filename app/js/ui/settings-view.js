/**
 * settings-view.js - Step 3 "Exportar y ajustes": a left navigation with the sections and a body
 * where each section is mounted on demand.
 */

import { helpBtn, helpItem } from './help.js';
import { el, $, clear, toast, modal, pickFiles, promptDialog, confirmDialog } from '../util/dom.js';
import { state, on, emit } from '../state.js';
import { MODULES, moduleById, INPUT_LABELS, ROLE_LABELS } from '../review/module-list.js';
import { loadModuleConfig, saveModuleConfig, THINKING_LABELS } from '../review/module-config.js';
import { loadPrompts, savePrompt, defaultPrompt, promptOf, STRICTNESS, strictnessOf } from '../review/prompts.js';
import { idbClear } from '../store/idb.js';
import { storage } from '../store/storage.js';
import { exportCorrected, exportReportHtml, exportReportXlsx, exportFindingsJson, exportProject, importProjectFile,
  exportMasked, exportBilingualXlsx } from '../export/exports.js';
import { mountListsEditor } from './lists-editor.js';

const SECTIONS = [
  { id: 'export', label: 'Exportar' },
  { id: 'providers', label: 'Proveedores y modelos' },
  { id: 'modules', label: 'M\u00f3dulos' },
  { id: 'lists', label: 'Listas de entidades' },
  { id: 'sync', label: 'Sincronizaci\u00f3n' },
  { id: 'usage', label: 'Uso de IA' },
  { id: 'privacy', label: 'Privacidad y datos' }
];

let nav, body, current = 'export';

/** The section to show the next time Settings opens (so it is mounted once, not twice). */
export function preselectSettingsSection(id) { current = id; }

export function mountSettingsView(host, tools) {
  nav = el('div.settings-nav');
  body = el('div.settings-body');
  host.appendChild(el('div.settings', nav, body));
  for (const s of SECTIONS) nav.appendChild(el('button', { 'data-sec': s.id, onclick: () => showSettingsSection(s.id) }, s.label));
  on('view', (v) => { if (v === 'settings') { clear(tools); showSettingsSection(current); } });
}

let _secGen = 0;
export async function showSettingsSection(id) {
  current = id;
  const gen = ++_secGen;
  for (const b of nav.querySelectorAll('button')) b.classList.toggle('on', b.dataset.sec === id);
  clear(body);
  const host = el('div');
  body.appendChild(host);
  try {
    if (id === 'export') mountExport(host);
    else if (id === 'providers') (await import('./settings-providers.js')).mount(host);
    else if (id === 'modules') await mountModules(host);
    else if (id === 'lists') await mountListsEditor(host);
    else if (id === 'sync') (await import('./settings-sync.js')).mount(host);
    else if (id === 'usage') (await import('./settings-usage.js')).mount(host);
    else if (id === 'privacy') mountPrivacy(host);
  } catch (e) {
    console.error(e);
    host.appendChild(el('div.note.err', 'No se pudo abrir esta secci\u00f3n: ' + e.message));
  }
  // Another section was chosen while this one was loading: keep only the newest.
  if (gen !== _secGen && host.parentNode) host.remove();
}

// ------------------------------------------------------------------ export

function mountExport(host) {
  const has = !!state.project;
  const kind = state.tgt ? state.tgt.kind : 'docx';
  const act = (label, fn, cls) => el('button.btn' + (cls ? '.' + cls : ''), { disabled: !has, onclick: async () => {
    try { const r = await fn(); if (r && r.applied !== undefined) toast(r.applied + ' correcciones aplicadas, ' + r.comments + ' comentarios.', 'ok'); else toast('Exportado.', 'ok'); }
    catch (e) { console.error(e); toast('No se pudo exportar: ' + e.message, 'err', 8000); }
  } }, label);
  host.appendChild(el('div.card', el('h3', 'Traducci\u00f3n revisada', helpBtn('export-corrected')), el('div.body',
    el('p.info', 'Aplica los hallazgos ACEPTADOS. En DOCX van como control de cambios, y los pendientes (o los que no se pueden aplicar) como comentarios de Word. PPTX y XLSX no tienen control de cambios: se aplican directamente.'),
    el('div.row',
      kind === 'docx' ? act('DOCX con control de cambios y comentarios', () => exportCorrected({ tracked: true, comments: true }), 'violet') : null,
      kind === 'docx' ? act('DOCX con control de cambios', () => exportCorrected({ tracked: true, comments: false })) : null,
      act((kind || 'docx').toUpperCase() + ' con los cambios aplicados', () => exportCorrected({ tracked: false, comments: false }))))));
  host.appendChild(el('div.card', el('h3', 'Informes', helpBtn('export-reports')), el('div.body', el('div.row',
    act('Informe HTML', () => exportReportHtml(f => f.state !== 'discarded')),
    act('Informe Excel', () => exportReportXlsx(f => f.state !== 'discarded')),
    act('Hallazgos en JSON', exportFindingsJson)))));
  host.appendChild(el('div.card', el('h3', 'Enmascarado', helpBtn('export-masked')), el('div.body', el('div.row',
    act('Original enmascarado', () => exportMasked('src')),
    act('Traducci\u00f3n enmascarada', () => exportMasked('tgt')),
    act('Tabla biling\u00fce enmascarada (XLSX)', exportBilingualXlsx)))));
  host.appendChild(el('div.card', el('h3', 'Proyecto', helpBtn('project-file')), el('div.body',
    el('p.info', 'Un archivo .umbra guarda los dos documentos, las entidades y los hallazgos para seguir otro d\u00eda o en otro equipo. Contiene el texto REAL: c\u00edfrelo si va a salir de su ordenador.'),
    el('div.row',
      act('Guardar proyecto (.umbra)', () => exportProject(null)),
      act('Guardar proyecto cifrado', async () => {
        const p = await promptDialog('Cifrar proyecto', 'Contrase\u00f1a (no se puede recuperar si la olvida)', '', { type: 'password' });
        if (!p) return null;
        return exportProject(p);
      }),
      el('button.btn', { onclick: async () => {
        const files = await pickFiles('.umbra', false);
        if (!files[0]) return;
        try {
          const p = await importProjectFile(files[0], () => promptDialog('Proyecto cifrado', 'Contrase\u00f1a', '', { type: 'password' }));
          if (p) { toast('Proyecto abierto.', 'ok'); emit('goto', 'mask'); }
        } catch (e) { toast('No se pudo abrir: ' + e.message, 'err', 8000); }
      } }, 'Abrir proyecto (.umbra)')))));
}

// ------------------------------------------------------------------ modules

async function mountModules(host) {
  const cfg = await loadModuleConfig();
  const prompts = await loadPrompts();
  const { moduleModelSelect } = await import('./settings-providers.js');
  const saved = () => toast('Guardado.', 'ok', 1500);

  // 1) What runs and with which model: the only table most people need.
  const t = el('table.grid.modtable', el('tr', el('th', 'M\u00f3dulo'), el('th', 'Activo'), el('th', 'Modelo'),
    el('th', { title: 'Qu\u00e9 se le pide que se\u00f1ale: solo lo importante, tambi\u00e9n lo menor, o todo' }, 'Exigencia'),
    el('th', { title: 'Sus hallazgos pasan por el Verificador, que descarta los falsos positivos' }, 'Verificar')));
  for (const m of MODULES) {
    const c = cfg[m.id] || {};
    const save = (patch) => saveModuleConfig(m.id, patch).then(saved);
    const modelCell = el('div.modsel');
    for (const role of m.roles) {
      const sel = await moduleModelSelect(m.id, role, saved);
      modelCell.appendChild(m.roles.length > 1 || role === 'deep'
        ? el('label.row', el('span.muted', { style: { minWidth: '60px', fontSize: '11px' } }, ROLE_LABELS[role]), sel)
        : sel);
    }
    t.appendChild(el('tr',
      el('td', el('b', m.label), el('div.muted', { style: { fontSize: '11px' } }, m.desc)),
      el('td', el('input', { type: 'checkbox', checked: c.enabled !== false, onchange: (e) => save({ enabled: e.target.checked }) })),
      el('td', modelCell),
      el('td', m.id === 'verifier' ? '\u2014' : (() => {
        const sel = el('select', { 'data-strict': m.id, onchange: (e) => save({ strictness: e.target.value }) },
          Object.keys(STRICTNESS).map(k => el('option', { value: k }, STRICTNESS[k])));
        sel.value = strictnessOf(cfg, m.id);
        return sel;
      })()),
      el('td', m.id === 'verifier' ? '\u2014' : el('input', { type: 'checkbox', checked: !!c.verify, onchange: (e) => save({ verify: e.target.checked }) }))));
  }
  host.appendChild(el('div.card', el('h3', 'M\u00f3dulos de revisi\u00f3n', helpBtn('module-settings')), el('div.body',
    el('p.info', { style: { marginBottom: '8px' } }, el('b', 'Cribado'), ': repasa todo el texto con un modelo econ\u00f3mico. ', el('b', 'A fondo'),
      ' (Fidelidad e Integridad): un modelo m\u00e1s fuerte revisa solo lo que se\u00f1al\u00f3 el cribado. ', el('b', 'Exigencia'), ': solo lo importante, tambi\u00e9n lo menor o todo. ', el('b', 'General'), ': el proveedor general de ',
      el('a', { href: '#', onclick: (e) => { e.preventDefault(); showSettingsSection('providers'); } }, 'Proveedores y modelos'), '.'),
    t)));

  // 3) Advanced: thinking, batch size, fusion, budget.
  const adv = el('table.grid', el('tr', el('th', 'M\u00f3dulo'), el('th', 'Razonamiento'), el('th', 'Palabras por lote'), el('th', 'Fusionar'), el('th', 'Presupuesto (US$)')));
  for (const m of MODULES.filter(x => x.ai)) {
    const c = cfg[m.id];
    const save = (patch) => saveModuleConfig(m.id, patch).then(saved);
    const thinking = el('select', { onchange: (e) => save({ thinking: e.target.value }) },
      Object.keys(THINKING_LABELS).map(k => el('option', { value: k }, THINKING_LABELS[k])));
    thinking.value = c.thinking || '';
    adv.appendChild(el('tr',
      el('td', el('b', m.label)),
      el('td', thinking),
      el('td', m.id === 'verifier' || m.input === 'skeleton' ? '\u2014' : el('input.inp', { type: 'number', min: 0, step: 100, value: c.batchWords || '', placeholder: 'Auto', style: { width: '80px' },
        onchange: (e) => save({ batchWords: parseInt(e.target.value, 10) || 0 }) })),
      el('td', ['fidelity', 'integrity', 'grammar', 'style'].includes(m.id) ? el('input', { type: 'checkbox', checked: c.merge !== false, onchange: (e) => save({ merge: e.target.checked }) }) : '\u2014'),
      el('td', el('input.inp', { type: 'number', min: 0, step: 0.05, value: c.budget || '', placeholder: 'Sin l\u00edmite', style: { width: '90px' },
        onchange: (e) => save({ budget: parseFloat(e.target.value) || 0 }) }))));
  }
  host.appendChild(el('div.card', el('h3', 'Opciones avanzadas', helpBtn('module-advanced')), el('div.body',
    el('details', el('summary', { style: { cursor: 'pointer', color: 'var(--primary)', fontWeight: 600 } }, 'Mostrar (no hace falta tocarlas)'),
      el('p.info', { style: { margin: '8px 0' } }, 'Razonamiento: cu\u00e1nto piensa el modelo antes de responder (se cobra como salida). Palabras por lote: tama\u00f1o de cada env\u00edo. Fusionar: Fidelidad con Integridad, y Gram\u00e1tica con Estilo, comparten llamada si usan el mismo modelo. Presupuesto: tope de gasto por ejecuci\u00f3n.'),
      adv))));
  // Prompts (built-in, editable)
  const box = el('div.body');
  for (const m of MODULES.filter(x => x.ai)) {
    const custom = !!(prompts.map && prompts.map[m.id]);
    const ta = el('textarea.inp', { rows: 6 });
    ta.value = promptOf(prompts, m.id);
    box.appendChild(el('details', { style: { marginBottom: '8px' } },
      el('summary', { style: { cursor: 'pointer', fontWeight: 600 } }, m.label + (custom ? ' \u00b7 modificadas' : ' \u00b7 de serie')),
      el('div', { style: { margin: '6px 0' } }, ta),
      el('div.row',
        el('button.btn.sm.primary', { onclick: async () => { await savePrompt(m.id, ta.value); toast('Instrucciones guardadas.', 'ok'); showSettingsSection('modules'); } }, 'Guardar'),
        el('button.btn.sm', { onclick: async () => { await savePrompt(m.id, ''); toast('Restauradas las de serie.', 'ok'); showSettingsSection('modules'); } }, 'Restaurar las de serie'))));
  }
  host.appendChild(el('div.card', el('h3', 'Instrucciones de cada m\u00f3dulo (avanzado)', helpBtn('module-prompts')),
    el('div.body', el('p.info', 'Lo que se le pide a la IA en cada m\u00f3dulo. Las de serie se pueden editar y restaurar. El formato de respuesta y la explicaci\u00f3n de las etiquetas se a\u00f1aden siempre: no los quite de aqu\u00ed.')), box));
}

// ------------------------------------------------------------------ privacy

function mountPrivacy(host) {
  host.appendChild(el('div.card', el('h3', 'C\u00f3mo protege UMBRA sus documentos', helpBtn('privacy')), el('div.body',
    el('ul', { style: { marginLeft: '18px', lineHeight: '1.6' } },
      el('li', 'Los documentos se leen y se procesan en este navegador. GitHub Pages solo sirve el programa: no recibe nada.'),
      el('li', 'A una IA solo se env\u00eda texto ENMASCARADO. La puerta de salida (gateway) rechaza cualquier texto sin enmascarar, salvo hacia un proveedor marcado como local.'),
      el('li', '\u00danica excepci\u00f3n, elegida por usted: el m\u00f3dulo Nombres oficiales env\u00eda la lista de nombres de organismos, \u00f3rganos, cargos, pa\u00edses y lugares (nunca personas, cifras, fechas, s\u00edmbolos ni el texto del documento). Se puede desactivar en Ajustes \u203a M\u00f3dulos.'),
      el('li', 'Enmascarar reduce el riesgo, pero no lo elimina: el contexto puede delatar de qu\u00e9 se habla.'),
      el('li', 'Las claves de API se guardan en este navegador y no viajan en el archivo de sincronizaci\u00f3n, salvo cifradas si usted lo activa.'),
      el('li', 'Todas las webs de GitHub Pages de una misma cuenta comparten el almacenamiento del navegador: UMBRA usa claves con el prefijo umbra.')))));
  host.appendChild(el('div.card', el('h3', 'Datos de este navegador', helpBtn('browser-data')), el('div.body', el('div.row',
    el('button.btn', { onclick: async () => { await idbClear('cache'); toast('Cach\u00e9 de resultados vaciada.', 'ok'); } }, 'Vaciar la cach\u00e9 de resultados'),
    el('button.btn.danger', { onclick: async () => {
      if (!(await confirmDialog('Borrar proyectos', 'Se borrar\u00e1n todos los proyectos guardados en este navegador.', 'Borrar'))) return;
      await idbClear('projects'); toast('Proyectos borrados.', 'ok'); location.reload();
    } }, 'Borrar todos los proyectos'),
    el('button.btn.danger', { onclick: async () => {
      if (!(await confirmDialog('Borrar todo', 'Se borrar\u00e1n proyectos, ajustes, reglas, claves y registro de gasto de UMBRA en este navegador. Si tiene archivo de sincronizaci\u00f3n, podr\u00e1 traerlos de nuevo.', 'Borrar todo'))) return;
      for (const s of ['projects', 'cache', 'handles', 'misc']) { try { await idbClear(s); } catch (_) {} }
      const keys = await storage.keys();
      await storage.remove(keys);
      location.reload();
    } }, 'Borrar todos los datos de UMBRA')))));
}
