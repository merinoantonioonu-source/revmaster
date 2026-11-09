/**
 * settings-view.js - "Ajustes" (at the foot of the side bar): a left navigation with the sections and
 * a body where each section is mounted on demand. Exporting is step 5 (ui/export-view.js).
 */

import { helpBtn, helpItem } from './help.js';
import { el, clear, toast, confirmDialog } from '../util/dom.js';
import { state, on, emit } from '../state.js';
import { MODULES } from '../review/module-list.js';
import { loadModuleConfig, saveModuleConfig, THINKING_LABELS } from '../review/module-config.js';
import { loadPrompts, savePrompt, defaultPrompt, promptOf, STRICTNESS, strictnessOf } from '../review/prompts.js';
import { idbClear } from '../store/idb.js';
import { storage } from '../store/storage.js';
import { mountListsEditor } from './lists-editor.js';

const SECTIONS = [
  { id: 'providers', label: 'Proveedores y modelos' },
  { id: 'modules', label: 'M\u00f3dulos' },
  { id: 'lists', label: 'Listas de entidades' },
  { id: 'sync', label: 'Sincronizaci\u00f3n' },
  { id: 'usage', label: 'Uso de IA' },
  { id: 'privacy', label: 'Privacidad y datos' }
];

let nav, body, current = 'providers';

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
    if (id === 'providers') (await import('./settings-providers.js')).mount(host);
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
    // One model per module (Sentido and the Verifier: the strongest one).
    const modelCell = el('div.modsel', await moduleModelSelect(m.id, m.roles[0], saved));
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
    el('p.info', { style: { marginBottom: '8px' } }, el('b', 'Sentido'), ' es la revisi\u00f3n de fondo: elija para \u00e9l el modelo m\u00e1s fuerte, que lee todo el texto. ',
      el('b', 'Redacci\u00f3n'), ' y ', el('b', 'Nombres oficiales'), ' pueden ir con uno econ\u00f3mico. ', el('b', 'Exigencia'), ': solo lo importante, tambi\u00e9n lo menor o todo. ', el('b', 'General'), ': el proveedor general de ',
      el('a', { href: '#', onclick: (e) => { e.preventDefault(); showSettingsSection('providers'); } }, 'Proveedores y modelos'), '.'),
    t)));

  // 3) Advanced: thinking, batch size, fusion, budget.
  const adv = el('table.grid', el('tr', el('th', 'M\u00f3dulo'), el('th', 'Razonamiento'), el('th', 'Palabras por lote'), el('th', 'Presupuesto (US$)')));
  for (const m of MODULES.filter(x => x.ai)) {
    const c = cfg[m.id];
    const save = (patch) => saveModuleConfig(m.id, patch).then(saved);
    const thinking = el('select', { onchange: (e) => save({ thinking: e.target.value }) },
      Object.keys(THINKING_LABELS).map(k => el('option', { value: k }, THINKING_LABELS[k])));
    thinking.value = c.thinking || '';
    adv.appendChild(el('tr',
      el('td', el('b', m.label)),
      el('td', thinking),
      el('td', m.id === 'verifier' || m.input === 'names' ? '\u2014' : el('input.inp', { type: 'number', min: 0, step: 100, value: c.batchWords || '', placeholder: 'Auto', style: { width: '80px' },
        onchange: (e) => save({ batchWords: parseInt(e.target.value, 10) || 0 }) })),
      el('td', el('input.inp', { type: 'number', min: 0, step: 0.05, value: c.budget || '', placeholder: 'Sin l\u00edmite', style: { width: '90px' },
        onchange: (e) => save({ budget: parseFloat(e.target.value) || 0 }) }))));
  }
  host.appendChild(el('div.card', el('h3', 'Opciones avanzadas', helpBtn('module-advanced')), el('div.body',
    el('details', el('summary', { style: { cursor: 'pointer', color: 'var(--primary)', fontWeight: 600 } }, 'Mostrar (no hace falta tocarlas)'),
      el('p.info', { style: { margin: '8px 0' } }, 'Razonamiento: cu\u00e1nto piensa el modelo antes de responder (se cobra como salida). Palabras por lote: tama\u00f1o de cada env\u00edo. Presupuesto: tope de gasto por ejecuci\u00f3n.'),
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
