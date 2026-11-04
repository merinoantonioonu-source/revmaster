/**
 * settings-view.js - Step 3 "Exportar y ajustes": a left navigation with the sections and a body
 * where each section is mounted on demand.
 */

import { helpBtn, helpItem } from './help.js';
import { el, $, clear, toast, modal, pickFiles, promptDialog, confirmDialog } from '../util/dom.js';
import { state, on, emit } from '../state.js';
import { MODULES, moduleById, INPUT_LABELS } from '../review/module-list.js';
import { loadModuleConfig, saveModuleConfig, THINKING_LABELS } from '../review/module-config.js';
import { loadPrompts, savePrompt, defaultPrompt, promptOf } from '../review/prompts.js';
import { idbClear } from '../store/idb.js';
import { storage } from '../store/storage.js';
import { exportCorrected, exportReportHtml, exportReportXlsx, exportFindingsJson, exportProject, importProjectFile,
  exportMasked, exportBilingualXlsx } from '../export/exports.js';
import { mountRulesEditor } from './rules-editor.js';
import { mountListsEditor } from './lists-editor.js';

const SECTIONS = [
  { id: 'export', label: 'Exportar' },
  { id: 'providers', label: 'Proveedores y modelos' },
  { id: 'modules', label: 'M\u00f3dulos' },
  { id: 'rules', label: 'Reglas' },
  { id: 'lists', label: 'Listas de entidades' },
  { id: 'sync', label: 'Sincronizaci\u00f3n' },
  { id: 'usage', label: 'Uso de IA' },
  { id: 'privacy', label: 'Privacidad y datos' }
];

let nav, body, current = 'export';

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
    else if (id === 'rules') await mountRulesEditor(host);
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
  host.appendChild(el('div.note', 'El proveedor y el modelo de cada m\u00f3dulo se eligen en ', el('a', { href: '#', onclick: (e) => { e.preventDefault(); showSettingsSection('providers'); } }, 'Proveedores y modelos'),
    ' (o pulsando la pastilla del modelo en la tarjeta del m\u00f3dulo, en Revisar).'));
  const t = el('table.grid', el('tr', el('th', 'M\u00f3dulo'), el('th', 'Entrada'), el('th', 'Activo'), el('th', 'Razonamiento'), el('th', 'Palabras por lote'),
    el('th', 'Fusionar'), el('th', 'Verificar'), el('th', 'Presupuesto (US$)')));
  for (const m of MODULES.filter(x => x.ai)) {
    const c = cfg[m.id];
    const save = (patch) => saveModuleConfig(m.id, patch).then(() => toast('Guardado.', 'ok', 1500));
    const thinking = el('select', { onchange: (e) => save({ thinking: e.target.value }) },
      Object.keys(THINKING_LABELS).map(k => el('option', { value: k }, THINKING_LABELS[k])));
    thinking.value = c.thinking || '';
    t.appendChild(el('tr',
      el('td', el('b', m.label), el('div.muted', m.desc)),
      el('td', INPUT_LABELS[m.input]),
      el('td', el('input', { type: 'checkbox', checked: c.enabled !== false, onchange: (e) => save({ enabled: e.target.checked }) })),
      el('td', thinking),
      el('td', m.id === 'verifier' || m.input === 'skeleton' ? '\u2014' : el('input.inp', { type: 'number', min: 0, step: 100, value: c.batchWords || '', placeholder: 'Auto', style: { width: '80px' },
        onchange: (e) => save({ batchWords: parseInt(e.target.value, 10) || 0 }) })),
      el('td', ['fidelity', 'integrity', 'grammar', 'style'].includes(m.id) ? el('input', { type: 'checkbox', checked: c.merge !== false, onchange: (e) => save({ merge: e.target.checked }) }) : '\u2014'),
      el('td', m.id === 'verifier' ? '\u2014' : el('input', { type: 'checkbox', checked: !!c.verify, onchange: (e) => save({ verify: e.target.checked }) })),
      el('td', el('input.inp', { type: 'number', min: 0, step: 0.05, value: c.budget || '', placeholder: 'Sin l\u00edmite', style: { width: '90px' },
        onchange: (e) => save({ budget: parseFloat(e.target.value) || 0 }) }))));
  }
  host.appendChild(el('div.card', el('h3', 'Capa 0 (sin IA)', helpBtn('layer0')), el('div.body',
    el('label', el('input', { type: 'checkbox', checked: cfg.local.spell !== false, onchange: (e) => saveModuleConfig('local', { spell: e.target.checked }).then(() => toast('Guardado.', 'ok', 1500)) }),
      ' Corrector ortogr\u00e1fico local (diccionario espa\u00f1ol de Hunspell; se descarga una vez, unos 900 KB)'),
    el('p.info', { style: { marginTop: '6px' } }, 'Si se\u00f1ala una palabra correcta, rech\u00e1cela y elija \u00abNo volver a se\u00f1alarlo\u00bb: se crea una regla para ignorarla.'),
    await _semanticSettings(cfg.local))));
  host.appendChild(el('div.card', el('h3', 'Ajustes de los m\u00f3dulos', helpBtn('module-settings')), el('div.body',
    el('p.info', 'Fusionar: Fidelidad con Integridad, y Gram\u00e1tica con Estilo, comparten una sola llamada por lote cuando usan el mismo modelo (la entrada se paga una vez). Verificar: sus hallazgos pasan por el Verificador. Razonamiento: cu\u00e1nto piensa el modelo antes de responder (se cobra como salida).'),
    t)));
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

// Semantic similarity (layer 0): engine, model, provider, sensitivity.
async function _semanticSettings(c) {
  const { listProviders, hasApiKey } = await import('../ai/registry.js');
  const { embeddingsSupported, DEFAULT_LOCAL_MODEL, DEFAULT_API_MODELS } = await import('../ai/embeddings.js');
  const save = (patch) => saveModuleConfig('local', patch).then(() => toast('Guardado.', 'ok', 1500));
  const mode = el('select.inp', el('option', { value: 'ask' }, 'Preguntar la primera vez'), el('option', { value: 'off' }, 'Desactivada'),
    el('option', { value: 'local' }, 'En este navegador (modelo local)'), el('option', { value: 'api' }, 'Con un proveedor (embeddings)'));
  mode.value = c.semantic || 'ask';
  const localModel = el('input.inp', { value: c.semModel || DEFAULT_LOCAL_MODEL, onchange: (e) => save({ semModel: e.target.value.trim() || DEFAULT_LOCAL_MODEL }) });
  const provs = [];
  for (const p of await listProviders()) if (embeddingsSupported(p) && (await hasApiKey(p.id) || p.trust === 'local')) provs.push(p);
  const provSel = el('select.inp', el('option', { value: '' }, provs.length ? 'Elija un proveedor' : 'Ning\u00fan proveedor con clave admite embeddings'),
    provs.map(p => el('option', { value: p.id }, p.name)));
  provSel.value = c.semProvider || '';
  const apiModel = el('input.inp', { value: c.semApiModel || '', placeholder: 'Por defecto: gemini-embedding-001, mistral-embed o text-embedding-3-small',
    onchange: (e) => save({ semApiModel: e.target.value.trim() }) });
  provSel.addEventListener('change', () => {
    const p = provs.find(x => x.id === provSel.value);
    save({ semProvider: provSel.value, semApiModel: p ? (DEFAULT_API_MODELS[p.adapter] || '') : '' });
    if (p) apiModel.value = DEFAULT_API_MODELS[p.adapter] || '';
  });
  const sens = el('select.inp', el('option', { value: 'normal' }, 'Normal (menos avisos)'), el('option', { value: 'high' }, 'Alta (m\u00e1s avisos)'));
  sens.value = c.semSensitivity || 'normal';
  sens.addEventListener('change', () => save({ semSensitivity: sens.value }));
  const localBox = el('div.field', el('label.lbl', 'Modelo local (Hugging Face)'), localModel,
    el('p.info', 'La primera vez se descargan el motor (unos 22 MB, de cdn.jsdelivr.net) y el modelo (unos 120 MB, de huggingface.co); despu\u00e9s quedan en el navegador. Lee el texto real, pero no sale del ordenador.'));
  const apiBox = el('div', el('div.form-grid', el('div.field', el('label.lbl', 'Proveedor'), provSel), el('div.field', el('label.lbl', 'Modelo de embeddings'), apiModel)),
    el('p.info', 'Solo se env\u00eda el texto enmascarado. Cuesta muy poco (los embeddings son mucho m\u00e1s baratos que los modelos de texto) y el gasto se ve en Uso de IA.'));
  const sync = () => { localBox.classList.toggle('hidden', mode.value !== 'local'); apiBox.classList.toggle('hidden', mode.value !== 'api'); };
  mode.addEventListener('change', () => { save({ semantic: mode.value }); sync(); });
  sync();
  return el('div', { style: { marginTop: '12px', borderTop: '1px solid var(--border-soft)', paddingTop: '10px' } },
    el('b', 'Similitud sem\u00e1ntica (omisiones y adiciones)'),
    el('p.info', { style: { margin: '4px 0 8px' } }, 'Compara el sentido de cada oraci\u00f3n del original con las de la traducci\u00f3n: una oraci\u00f3n sin equivalente es una posible omisi\u00f3n (o adici\u00f3n). Los p\u00e1rrafos sospechosos pasan adem\u00e1s al modelo \u00aba fondo\u00bb de Integridad y Fidelidad.'),
    el('div.form-grid', el('div.field', el('label.lbl', 'Funcionamiento'), mode), el('div.field', el('label.lbl', 'Sensibilidad'), sens)),
    localBox, apiBox);
}

// ------------------------------------------------------------------ privacy

function mountPrivacy(host) {
  host.appendChild(el('div.card', el('h3', 'C\u00f3mo protege UMBRA sus documentos', helpBtn('privacy')), el('div.body',
    el('ul', { style: { marginLeft: '18px', lineHeight: '1.6' } },
      el('li', 'Los documentos se leen y se procesan en este navegador. GitHub Pages solo sirve el programa: no recibe nada.'),
      el('li', 'A una IA solo se env\u00eda texto ENMASCARADO. La puerta de salida (gateway) rechaza cualquier texto sin enmascarar, salvo hacia un proveedor marcado como local.'),
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
