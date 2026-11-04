/**
 * lists-editor.js - Settings > Listas de entidades: the personal dictionary (synced) and the built-in
 * trilingual lists (countries, organs, organizations, titles, places), which are editable too.
 */

import { el, clear, toast, modal, download, pickFiles, confirmDialog } from '../util/dom.js';
import { state, saveDictItem, saveGazetteerEdit, refreshLists } from '../state.js';
import { getValue } from '../store/storage.js';
import { CATS, CAT_SINGULAR, CAT_LABELS, ARTICLES } from '../redact/entities.js';

let host, filt = { cat: 'all', q: '', src: 'dict' };

export async function mountListsEditor(h) {
  host = h;
  await refreshLists();
  render();
}

function render() {
  clear(host);
  host.appendChild(el('div.note', 'Las listas deciden qu\u00e9 se enmascara y con qu\u00e9 art\u00edculo. Su diccionario personal viaja en el archivo de sincronizaci\u00f3n; las listas de serie tambi\u00e9n se pueden editar (y restaurar).'));
  const tabs = el('div.row', { style: { marginBottom: '8px' } },
    el('button.btn' + (filt.src === 'dict' ? '.primary' : ''), { onclick: () => { filt.src = 'dict'; render(); } }, 'Mi diccionario (' + state.dict.length + ')'),
    el('button.btn' + (filt.src === 'gaz' ? '.primary' : ''), { onclick: () => { filt.src = 'gaz'; render(); } }, 'Listas de serie (' + state.data.gazetteer.length + ')'));
  host.appendChild(tabs);
  const q = el('input.inp', { placeholder: 'Buscar\u2026', value: filt.q, oninput: (e) => { filt.q = e.target.value; renderTable(tbody); } });
  const cat = el('select', { onchange: (e) => { filt.cat = e.target.value; renderTable(tbody); } }, el('option', { value: 'all' }, 'Todas las categor\u00edas'),
    CATS.filter(c => c !== 'NUM' && c !== 'FECHA').map(c => el('option', { value: c }, CAT_LABELS[c])));
  cat.value = filt.cat;
  const tbody = el('tbody');
  host.appendChild(el('div.card', el('h3', filt.src === 'dict' ? 'Mi diccionario' : 'Listas de serie'), el('div.body',
    el('div.row', { style: { marginBottom: '8px' } }, q, cat, el('span.grow'),
      el('button.btn.primary', { onclick: () => editEntry(null) }, '+ A\u00f1adir'),
      filt.src === 'dict' ? el('button.btn', { onclick: exportDict }, 'Exportar') : null,
      filt.src === 'dict' ? el('button.btn', { onclick: importDict }, 'Importar') : null),
    el('table.grid', el('thead', el('tr', el('th', 'Categor\u00eda'), el('th', 'Art.'), el('th', 'Ingl\u00e9s'), el('th', 'Franc\u00e9s'), el('th', 'Espa\u00f1ol'), el('th', ''))), tbody))));
  renderTable(tbody);
}

function _list() {
  return filt.src === 'dict' ? state.dict : state.data.gazetteer;
}

function renderTable(tbody) {
  clear(tbody);
  const q = filt.q.trim().toLowerCase();
  const list = _list().filter(e => (filt.cat === 'all' || e.cat === filt.cat) &&
    (!q || [].concat(e.en || [], e.fr || [], e.es || []).join(' ').toLowerCase().includes(q)));
  for (const e of list.slice(0, 400)) {
    tbody.appendChild(el('tr',
      el('td', CAT_SINGULAR[e.cat] || e.cat), el('td', e.art || '\u2014'),
      el('td', (e.en || []).join(' \u00b7 ')), el('td', (e.fr || []).join(' \u00b7 ')), el('td', (e.es || []).join(' \u00b7 ')),
      el('td', { style: { whiteSpace: 'nowrap' } },
        el('button.btn.sm', { onclick: () => editEntry(e) }, 'Editar'), ' ',
        filt.src === 'gaz' ? el('button.btn.sm', { title: 'Volver a la versi\u00f3n de serie', onclick: async () => { await saveGazetteerEdit(e.id, null); await refreshLists(); render(); } }, 'Restaurar') : null, ' ',
        el('button.btn.sm.danger', { onclick: async () => {
          if (!(await confirmDialog('Quitar', 'Se dejar\u00e1 de enmascarar esta entidad.', 'Quitar'))) return;
          if (filt.src === 'dict') await saveDictItem(e, true); else await saveGazetteerEdit(e.id, null, true);
          await refreshLists(); render();
        } }, '\u00d7'))));
  }
  if (list.length > 400) tbody.appendChild(el('tr', el('td', { colspan: 6 }, el('div.empty', 'Se muestran 400 de ' + list.length + ': use la b\u00fasqueda.'))));
  if (!list.length) tbody.appendChild(el('tr', el('td', { colspan: 6 }, el('div.empty', filt.src === 'dict' ? 'Su diccionario est\u00e1 vac\u00edo. A\u00f1ada entidades aqu\u00ed o desde Enmascarar (\u00abA mi diccionario\u00bb).' : 'Ninguna entrada.'))));
}

async function editEntry(e) {
  const isNew = !e;
  const v = Object.assign({ cat: 'ORG', art: '', en: [], fr: [], es: [] }, e || {});
  const cat = el('select.inp', CATS.filter(c => c !== 'NUM' && c !== 'FECHA').map(c => el('option', { value: c }, CAT_SINGULAR[c])));
  cat.value = v.cat;
  const art = el('select.inp', ARTICLES.map(a => el('option', { value: a }, a || 'Sin art\u00edculo')));
  art.value = v.art || '';
  const ta = (arr) => { const t = el('textarea.inp', { rows: 3 }); t.value = (arr || []).join('\n'); return t; };
  const en = ta(v.en), fr = ta(v.fr), es = ta(v.es);
  const body = el('div',
    el('div.form-grid', el('div.field', el('label.lbl', 'Categor\u00eda'), cat), el('div.field', el('label.lbl', 'Art\u00edculo en espa\u00f1ol (g\u00e9nero y n\u00famero)'), art)),
    el('p.info', 'Una forma por l\u00ednea: nombre completo, forma corta y siglas.'),
    el('label.lbl', 'Ingl\u00e9s'), en, el('label.lbl', 'Franc\u00e9s'), fr, el('label.lbl', 'Espa\u00f1ol'), es);
  const r = await modal({ title: isNew ? 'Nueva entidad' : 'Editar entidad', body, width: '640px',
    buttons: [{ label: 'Cancelar', value: null }, { label: 'Guardar', kind: 'primary', value: 'ok' }] });
  if (r !== 'ok') return;
  const lines = (t) => t.value.split('\n').map(s => s.trim()).filter(Boolean);
  const entry = Object.assign({}, e || {}, { cat: cat.value, art: art.value, en: lines(en), fr: lines(fr), es: lines(es) });
  if (!entry.en.length && !entry.fr.length && !entry.es.length) { toast('Escriba al menos una forma.', 'warn'); return; }
  delete entry.key;
  if (filt.src === 'dict' || isNew) await saveDictItem(entry);
  else await saveGazetteerEdit(e.id, entry);
  await refreshLists();
  toast('Guardado.', 'ok');
  render();
}

async function exportDict() {
  const dict = await getValue('entity_dict', { items: [] });
  download(new Blob([JSON.stringify({ kind: 'umbra-dictionary', v: 1, items: dict.items || [] }, null, 1)], { type: 'application/json' }), 'umbra-diccionario.json');
}

async function importDict() {
  const files = await pickFiles('.json', false);
  if (!files[0]) return;
  try {
    const j = JSON.parse(await files[0].text());
    let n = 0;
    for (const it of (j.items || [])) { await saveDictItem(Object.assign({}, it, { id: undefined })); n++; }
    await refreshLists();
    toast(n + ' entidades importadas.', 'ok');
    render();
  } catch (e) { toast('No se pudo importar: ' + e.message, 'err'); }
}
