/**
 * mask-view.js - Step 1 "Enmascarar": entities panel, the two sheets with the tags (or the real text),
 * category switches, manual masking (Alt+E), per-entity actions and the export menu.
 */

import { helpBtn, helpItem } from './help.js';
import { el, $, clear, toast, modal, copyText, download, pickFiles, promptDialog, uid } from '../util/dom.js';
import { state, on, emit, setMask, remaskNow, saveDictItem, addFindings } from '../state.js';
import { renderDoc } from './preview.js';
import { CATS, CAT_LABELS, CAT_SINGULAR, STATUS_LABELS, mainForm } from '../redact/entities.js';
import { exportMasked, exportBilingualXlsx, exportBilingualHtml, exportKeyMap } from '../export/exports.js';
import { buildExternalText, importExternal } from '../review/external.js';
import { openMenu } from './menu.js';
import { icon } from './icons.js';
import { createNav, sentencesOf, sentenceAt, sentencePeers, unitOf, peerPid, offsetAt, paraText } from './nav.js';

let root, toolsHost;
let showOriginal = false;
let showBad = null;      // entity list: true = only the ones with a problem (default when there are any)
let catFilter = 'all';
let placeIdx = {};       // entity key -> index of the problem place shown last ('Ver donde')
let selectedKey = null;
let panes = {};
let nav = null;
let revealed = null;      // { src:{pid,start,end}, tgt:{...} }: a sentence pair shown unmasked for a moment

export function mountMaskView(host, tools) {
  root = host;
  toolsHost = tools;
  root.appendChild(el('div.list#mask-list',
    el('h4', 'Entidades del documento', helpBtn('entities')),
    el('div.bubbles#mask-bubbles'),
    el('div.scroll#mask-entities')));
  const work = el('div.work',
    el('div.panes',
      el('div.pane', el('div.pane-head', el('span#mask-src-title', 'ORIGINAL'), helpBtn('sheets'), el('input', { placeholder: 'Buscar\u2026', 'data-side': 'src', oninput: onSearch })),
        el('div.pane-body#mask-src')),
      el('div.pane', el('div.pane-head', el('span', 'TRADUCCI\u00d3N \u00b7 ES'), el('input', { placeholder: 'Buscar\u2026', 'data-side': 'tgt', oninput: onSearch })),
        el('div.pane-body#mask-tgt'))));
  root.appendChild(work);
  panes = { src: $('#mask-src'), tgt: $('#mask-tgt') };
  nav = createNav({ panes, session: () => state.session });
  nav.attachHover();
  attachTagHover();
  on('masked', render);
  on('view', (v) => { if (v === 'mask') { renderTools(); render(); } });
  document.addEventListener('keydown', (e) => {
    if (state.view !== 'mask') return;
    if (e.altKey && (e.key === 'e' || e.key === 'E')) { e.preventDefault(); maskSelection(); return; }
    // Left/Right arrows: next/previous sentence (as in Final Check).
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.ctrlKey && !e.metaKey && !e.shiftKey &&
        !(e.target.closest && e.target.closest('input, textarea, select, [contenteditable], .modal'))) {
      e.preventDefault();
      nav.step(e.key === 'ArrowRight' ? 1 : -1);
    }
  });
}

// ------------------------------------------------------------------ top bar

function renderTools() {
  if (state.view !== 'mask') return;
  clear(toolsHost);
  if (!state.project) return;
  if (state.project.unmasked) toolsHost.appendChild(el('span.pill.warn', { title: 'Este proyecto se revisa sin enmascarar (Archivos): a la IA llega el texto real y este paso no es necesario' }, 'Sin enmascarar: no hace falta este paso'));
  const ents = state.session ? state.session.ent.entities : [];
  const numBad = ents.filter(e => e.cat === 'NUM' && e.status === 'nopair').length;
  if (numBad) toolsHost.appendChild(el('span.pill.err', { title: 'Cifras que no est\u00e1n igual en las dos lenguas: posible error' }, numBad + (numBad === 1 ? ' cifra sin pareja' : ' cifras sin pareja')));
  toolsHost.appendChild(el('div.grow'));
  toolsHost.appendChild(el('button.btn', { 'data-cats': '1', title: 'Qu\u00e9 categor\u00edas se enmascaran', onclick: (e) => catsMenu(e.currentTarget) }, 'Qu\u00e9 enmascarar', icon('down', 14)));
  toolsHost.appendChild(el('button.btn', { onclick: (e) => optionsMenu(e.currentTarget) }, 'Opciones', icon('down', 14)));
  toolsHost.appendChild(el('button.btn', { title: 'Alternar entre etiquetas y texto real', onclick: () => { showOriginal = !showOriginal; renderTools(); renderPanes(); } },
    icon('mask', 16), showOriginal ? 'Ver etiquetas' : 'Ver original'));
  toolsHost.appendChild(el('button.btn', { title: 'Enmascarar el texto seleccionado (Alt+E)', onclick: maskSelection }, icon('plus', 16), 'Enmascarar selecci\u00f3n'));
  toolsHost.appendChild(el('button.btn', { onclick: (e) => exportMenu(e.currentTarget) }, 'Exportar enmascarado', icon('down', 14)));
  toolsHost.appendChild(el('button.btn.primary', { title: 'Paso 3: elegir qu\u00e9 revisa la IA', onclick: () => emit('goto', 'review') }, 'Siguiente: revisar', icon('arrow', 16)));
  toolsHost.appendChild(helpBtn('mask-tools'));
}

/** The categories to mask, as a menu that stays open while they are switched on and off. */
function catsMenu(anchor) {
  const mask = state.project.mask;
  openMenu(anchor, CATS.map(c => {
    const onCat = mask.cats.includes(c) || (c === 'X' && (mask.terms || []).some(t => (t.cat || 'X') === 'X'));
    return { label: (onCat ? '\u2713 ' : '\u2003 ') + CAT_LABELS[c], onClick: () => {
      const cats = mask.cats.includes(c) ? mask.cats.filter(x => x !== c) : mask.cats.concat([c]);
      setMask({ cats });
      renderTools();
      setTimeout(() => { const b = toolsHost.querySelector('[data-cats]'); if (b) catsMenu(b); }, 0);
    } };
  }).concat([{ sep: true }, helpItem('mask-tools', anchor)]));
}

function optionsMenu(anchor) {
  const mask = state.project.mask;
  const fr = state.project.srcLang === 'fr';
  const setLang = (l) => { state.project.srcLang = l; state.session.srcLang = l; remaskNow(); };
  openMenu(anchor, [
    { header: 'Lengua del original' },
    { label: (!fr ? '\u2713 ' : '\u2003 ') + 'Ingl\u00e9s', onClick: () => { if (fr) setLang('en'); } },
    { label: (fr ? '\u2713 ' : '\u2003 ') + 'Franc\u00e9s', onClick: () => { if (!fr) setLang('fr'); } },
    { sep: true },
    { label: (mask.spelled !== false ? '\u2713 ' : '') + 'Enmascarar n\u00fameros escritos en letra', onClick: () => { setMask({ spelled: mask.spelled === false }); renderTools(); } },
    { label: (mask.acronyms !== false ? '\u2713 ' : '') + 'Enmascarar siglas desconocidas presentes en ambos textos', onClick: () => { setMask({ acronyms: mask.acronyms === false }); renderTools(); } },
    { sep: true },
    { label: 'Volver a enmascarar todo lo que se quit\u00f3 a mano', onClick: () => { setMask({ removedKeys: [], removedOcc: [] }); toast('Restablecido.', 'ok'); } },
    { label: 'Deshacer todos los emparejamientos', onClick: () => setMask({ merges: {} }) },
    { label: 'Quitar los t\u00e9rminos a\u00f1adidos a mano en este proyecto', onClick: () => setMask({ terms: [] }) },
    { sep: true },
    helpItem('mask-options', anchor)
  ]);
}

function exportMenu(anchor) {
  const kind = state.tgt ? state.tgt.kind.toUpperCase() : 'DOCX';
  openMenu(anchor, [
    { header: 'Documentos enmascarados' },
    { label: 'Original enmascarado (' + kind + ')', onClick: () => run(() => exportMasked('src')) },
    { label: 'Traducci\u00f3n enmascarada (' + kind + ')', onClick: () => run(() => exportMasked('tgt')) },
    { label: 'Tabla biling\u00fce enmascarada (XLSX)', onClick: () => run(exportBilingualXlsx) },
    { label: 'Tabla biling\u00fce enmascarada (HTML)', onClick: () => run(exportBilingualHtml) },
    { sep: true },
    { header: 'IA externa' },
    { label: 'Copiar para IA externa\u2026', onClick: externalDialog },
    { label: 'Importar respuesta de IA externa\u2026', onClick: importDialog },
    { sep: true },
    { label: 'Mapa de claves (etiqueta \u2192 texto real)\u2026', onClick: async () => {
      const pwd = await promptDialog('Mapa de claves', 'Contrase\u00f1a para cifrarlo (vac\u00edo = sin cifrar). Gu\u00e1rdelo aparte: contiene los datos reales.', '', { type: 'password' });
      if (pwd === null) return;
      run(() => exportKeyMap(pwd || null));
    } },
    { sep: true },
    helpItem('mask-export', anchor)
  ]);
}

async function run(fn) {
  try { await fn(); toast('Exportado.', 'ok'); } catch (e) { console.error(e); toast('No se pudo exportar: ' + e.message, 'err', 7000); }
}

export async function externalDialog() {
  const mods = [['meaning', 'Sentido'], ['writing', 'Redacci\u00f3n']];
  const checks = mods.map(([id, label]) => el('label', { style: { marginRight: '12px' } },
    el('input', { type: 'checkbox', value: id, checked: true }), ' ' + label));
  const bil = el('input', { type: 'checkbox', checked: true });
  const ta = el('textarea.inp', { rows: 14, readonly: true });
  const refresh = () => {
    const chosen = checks.map(c => c.querySelector('input')).filter(i => i.checked).map(i => i.value);
    ta.value = buildExternalText(state.session, { modules: chosen, bilingual: bil.checked });
  };
  checks.forEach(c => c.querySelector('input').addEventListener('change', refresh));
  bil.addEventListener('change', refresh);
  refresh();
  const body = el('div',
    el('p.info', 'Texto enmascarado con las instrucciones para pegarlo en una IA externa (ChatGPT, Gemini, Claude...). Su respuesta se puede importar despu\u00e9s con \u00abImportar respuesta de IA externa\u00bb y aparecer\u00e1 en la lista de hallazgos.'),
    el('div', { style: { marginBottom: '6px' } }, checks), el('label', bil, ' Incluir el original (revisi\u00f3n biling\u00fce)'),
    el('div', { style: { marginTop: '8px' } }, ta));
  await modal({ title: 'Copiar para IA externa', help: helpBtn('external-copy'), body, width: '860px', buttons: [
    { label: 'Descargar .txt', onClick: () => { download(new Blob([ta.value], { type: 'text/plain' }), state.project.name + '_PARA_IA.txt'); return false; } },
    { label: 'Copiar', kind: 'primary', onClick: async () => { await copyText(ta.value); toast('Copiado al portapapeles.', 'ok'); } }] });
}

export async function importDialog() {
  const ta = el('textarea.inp', { rows: 14, placeholder: '12 | OMI | MAY | cita | sugerencia | motivo' });
  const body = el('div', el('p.info', 'Pegue la respuesta de la IA externa (una l\u00ednea por problema, con el formato que se le pidi\u00f3). Las etiquetas se convierten en el texto real.'), ta);
  const r = await modal({ title: 'Importar respuesta de IA externa', help: helpBtn('external-import'), body, width: '760px', buttons: [
    { label: 'Cancelar', value: null }, { label: 'Importar', kind: 'primary', value: 'ok' }] });
  if (r !== 'ok' || !ta.value.trim()) return;
  const res = importExternal(ta.value, state.session);
  if (!res.findings.length) { toast('No se reconoci\u00f3 ning\u00fan hallazgo en el texto pegado.', 'warn', 6000); return; }
  addFindings(res.findings);
  toast(res.findings.length + ' hallazgos importados' + (res.ignored ? ' (' + res.ignored + ' l\u00edneas no reconocidas)' : '') + '.', 'ok');
  emit('goto', 'correct');
}

// ------------------------------------------------------------------ entities list

function render() {
  if (state.view !== 'mask' || !state.session) return;
  renderTools();
  renderList();
  renderPanes();
}

const STATUS_ORDER = { nopair: 0, count: 1, forms: 2, ok: 3 };

function renderList() {
  const ents = state.session.ent.entities;
  const bad = ents.filter(e => e.status !== 'ok');
  if (showBad === null || (showBad && !bad.length)) showBad = bad.length > 0;
  const head = $('#mask-bubbles');
  clear(head);
  const pool = showBad ? bad : ents;
  const catSel = el('select.fsel', { title: 'Categor\u00eda', onchange: (e) => { catFilter = e.target.value; renderList(); } },
    el('option', { value: 'all' }, 'Todas las categor\u00edas'),
    CATS.filter(c => pool.some(e => e.cat === c)).map(c => el('option', { value: c }, CAT_LABELS[c] + ' (' + pool.filter(e => e.cat === c).length + ')')));
  if (catFilter !== 'all' && !pool.some(e => e.cat === catFilter)) catFilter = 'all';
  catSel.value = catFilter;
  head.appendChild(el('div.seg2',
    el('button' + (showBad ? '.on' : ''), { title: 'Sin pareja, recuento distinto o formas distintas', onclick: () => { showBad = true; renderList(); } },
      'Con problemas', el('span.n', String(bad.length))),
    el('button' + (!showBad ? '.on' : ''), { onclick: () => { showBad = false; renderList(); } }, 'Todas', el('span.n', String(ents.length)))));
  head.appendChild(catSel);
  const list = $('#mask-entities');
  clear(list);
  const shown = pool.filter(e => catFilter === 'all' || e.cat === catFilter)
    .sort((x, y) => showBad ? (STATUS_ORDER[x.status] - STATUS_ORDER[y.status]) || ((x.firstUnit || 0) - (y.firstUnit || 0)) : 0);
  if (!shown.length) list.appendChild(el('div.empty', showBad ? 'Ninguna entidad tiene problemas.' : 'No hay entidades en esta vista.'));
  for (const e of shown) list.appendChild(entityCard(e));
  list.appendChild(el('p.info', { style: { marginTop: '8px' } }, 'Seleccione texto en una hoja y pulse Alt+E (o clic derecho) para enmascararlo. Pulse una etiqueta para ver la entidad.'));
}

function _forms(forms) {
  return Object.keys(forms).map(f => f + (forms[f] > 1 ? ' (\u00d7' + forms[f] + ')' : '')).join(' \u00b7 ') || '\u2014';
}

/** Where an entity does not add up: the paragraph pairs with a different count on each side (or, for
 *  'forms', those using a less frequent translation). -> [{ unit, src, tgt }] */
function problemPlaces(e) {
  const s = state.session;
  const occs = (side, pid) => (pid === null || pid === undefined) ? [] : (s.ent.occ[side].get(pid) || []).filter(o => o.key === e.key);
  const out = [];
  if (e.status === 'forms') {
    const main = mainForm(e.tgtForms);
    for (const u of s.units) {
      const t = occs('tgt', u.tgtPara);
      if (t.some(o => o.surface !== main)) out.push({ unit: u.idx, src: occs('src', u.srcPara).length, tgt: t.length, form: t.find(o => o.surface !== main).surface });
    }
    return out;
  }
  for (const u of s.units) {
    const a = occs('src', u.srcPara).length, b = occs('tgt', u.tgtPara).length;
    if (a !== b) out.push({ unit: u.idx, src: a, tgt: b });
  }
  return out;
}

function _problemText(e) {
  if (e.status === 'nopair') return e.srcCount ? 'Solo est\u00e1 en el original (' + e.srcCount + ' ' + (e.srcCount > 1 ? 'veces' : 'vez') + '): \u00bffalta en la traducci\u00f3n o se tradujo de otra forma? Si es otra entidad, use \u00abEmparejar\u00bb.'
    : 'Solo est\u00e1 en la traducci\u00f3n (' + e.tgtCount + ' ' + (e.tgtCount > 1 ? 'veces' : 'vez') + '): \u00bfsobra, o en el original tiene otra forma (una sigla, por ejemplo)? Si es otra entidad, use \u00abEmparejar\u00bb.';
  if (e.status === 'count') return 'Aparece ' + e.srcCount + ' ' + (e.srcCount > 1 ? 'veces' : 'vez') + ' en el original y ' + e.tgtCount + ' en la traducci\u00f3n.';
  if (e.status === 'forms') return 'Se traduce de ' + Object.keys(e.tgtForms).length + ' formas distintas.';
  return '';
}

function entityCard(e) {
  const sel = selectedKey === e.key;
  const stCls = e.status === 'ok' ? 'ok' : (e.status === 'nopair' ? 'bad' : 'mid');
  const card = el('div.ent' + (sel ? '.sel' : ''), { 'data-key': e.key, title: 'Pulse para ir a la entidad (otra vez: la siguiente aparici\u00f3n)',
    onclick: (ev) => { if (ev.target.closest('.acts, .where')) return; gotoEntity(e); } },
    el('div.row', el('span.tk.' + e.cat, e.cat + e.n), el('span.st.' + stCls, STATUS_LABELS[e.status])),
    el('div.forms', 'O: ' + _forms(e.srcForms)),
    el('div.forms', 'T: ' + _forms(e.tgtForms)));
  const places = placesOf(e);
  const i = placeIdx[e.key];
  const at = (i !== undefined && places[i]) ? places[i] : null;
  if (e.status !== 'ok') card.appendChild(el('div.why', _problemText(e)));
  if (places.length && (e.status !== 'ok' || sel)) {
    card.appendChild(el('div.where',
      el('button.btn.sm' + (e.status !== 'ok' ? '.primary' : ''), { title: e.status !== 'ok' ? 'Lleva a cada p\u00e1rrafo en el que no cuadra y resalta los dos lados' : 'Siguiente aparici\u00f3n',
        onclick: () => gotoPlace(e, places, +1) }, at ? 'Siguiente \u203a' : (e.status !== 'ok' ? 'Ver d\u00f3nde no cuadra \u203a' : 'Ir \u203a')),
      places.length > 1 && at ? el('button.btn.sm', { title: 'Anterior', onclick: () => gotoPlace(e, places, -1) }, '\u2039') : null,
      el('span.muted', at ? ' \u00a7' + state.session.units[at.unit].n + (e.status !== 'ok' ? ' \u00b7 ' + (at.form ? '\u00ab' + at.form + '\u00bb' : at.src + ' en el original, ' + at.tgt + ' en la traducci\u00f3n') : '') + ' \u00b7 ' + (i + 1) + '/' + places.length
        : ' ' + places.length + (places.length > 1 ? ' lugares' : ' lugar'))));
  }
  const acts = el('div.acts',
    el('button.btn.sm', { onclick: () => changeCat(e) }, 'Categor\u00eda'),
    el('button.btn.sm', { title: 'Es la misma entidad que otra etiqueta (por ejemplo, la sigla del original y el nombre completo de la traducci\u00f3n)', onclick: () => mergeDialog(e) }, 'Emparejar\u2026'),
    el('button.btn.sm', { onclick: () => saveToDict(e) }, 'A mi diccionario'),
    el('button.btn.sm.danger', { onclick: () => { setMask({ removedKeys: (state.project.mask.removedKeys || []).concat([e.key]) }); toast('Ya no se enmascara ' + e.cat + e.n + '.', 'ok'); } }, 'No enmascarar'));
  card.appendChild(acts);
  return card;
}

/** Units where an entity occurs on either side, in document order. */
function occurrenceUnits(key) {
  const s = state.session;
  const set = new Set();
  for (const side of ['src', 'tgt']) {
    for (const [pid, occs] of s.ent.occ[side]) {
      if (!occs.some(o => o.key === key)) continue;
      const u = unitOf(s, side, pid);
      if (u) set.add(u.idx);
    }
  }
  return Array.from(set).sort((a, b) => a - b);
}

/** Where a click on the card goes: the places where it does not add up, or else every occurrence. */
function placesOf(e) {
  const prob = e.status !== 'ok' ? problemPlaces(e) : [];
  if (prob.length) return prob;
  return occurrenceUnits(e.key).map(unit => ({ unit }));
}

/** Click on a card: first place (again: the next one), the sentences in yellow, the entity in red. */
function gotoEntity(e) {
  const places = placesOf(e);
  if (selectedKey !== e.key) delete placeIdx[e.key];
  if (!places.length) { selectedKey = e.key; renderList(); renderPanes(); return; }
  gotoPlace(e, places, +1);
}

function gotoPlace(e, places, step) {
  const cur = placeIdx[e.key];
  const i = cur === undefined ? (step > 0 ? 0 : places.length - 1) : (cur + step + places.length) % places.length;
  placeIdx[e.key] = i;
  selectedKey = e.key;
  renderList();
  renderPanes();
  focusUnit(places[i].unit, { key: e.key });
  const card = document.querySelector('#mask-entities .ent.sel');
  if (card) card.scrollIntoView({ block: 'nearest' });
}

function selectEntity(key, scroll) {
  const e = key ? state.session.ent.byKey.get(key) : null;
  if (e && scroll) { gotoEntity(e); return; }
  selectedKey = key;
  renderList();
  renderPanes();
}

async function changeCat(e) {
  const sel = el('select.inp', CATS.map(c => el('option', { value: c }, CAT_SINGULAR[c])));
  sel.value = e.cat;
  const r = await modal({ title: 'Categor\u00eda de ' + e.cat + e.n, body: el('div', el('label.lbl', 'Categor\u00eda'), sel),
    buttons: [{ label: 'Cancelar', value: null }, { label: 'Guardar', kind: 'primary', value: 'ok' }] });
  if (r !== 'ok') return;
  setMask({ catOverride: Object.assign({}, state.project.mask.catOverride, { [e.key]: sel.value }) });
}

// ------------------------------------------------------------------ pairing suggestions

const _STOP = new Set(['of', 'the', 'and', 'for', 'on', 'in', 'to', 'de', 'la', 'las', 'los', 'del', 'el', 'y', 'para', 'en', 'et', 'des', 'du', 'le', 'les', 'pour', 'sur', 'a', 'al']);
const _fold = (x) => String(x || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const _words = (x) => _fold(x).split(/[^a-z0-9]+/).filter(w => w && !_STOP.has(w));
const _isAcr = (x) => /^[A-Z\u00c0-\u00de]{2,8}$/.test(String(x || '').trim());
const _letters = (x) => _fold(x).replace(/[^a-z]/g, '').split('').sort().join('');
const _initials = (x) => _words(x).map(w => w[0]).join('');

/** key -> Set(unit idx) where it occurs on `side`. */
function _unitsByKey(side) {
  const s = state.session;
  const map = new Map();
  for (const [pid, occs] of s.ent.occ[side]) {
    const u = unitOf(s, side, pid);
    if (!u) continue;
    for (const o of occs) { if (!map.has(o.key)) map.set(o.key, new Set()); map.get(o.key).add(u.idx); }
  }
  return map;
}

/** How alike two forms are (0-5): same text, the same acronym in another order (UNDP / PNUD), an
 *  acronym and its full name, the same figure, a short form, words with the same stem. */
function _formSim(a, b) {
  const fa = _fold(a), fb = _fold(b);
  if (!fa || !fb) return 0;
  if (fa === fb) return 5;
  if (_isAcr(a) && _isAcr(b) && _letters(a) === _letters(b)) return 4;
  if (_isAcr(a) && !_isAcr(b) && _letters(_initials(b)) === _letters(a)) return 4;
  if (_isAcr(b) && !_isAcr(a) && _letters(_initials(a)) === _letters(b)) return 4;
  const na = String(a).replace(/[^\d]/g, ''), nb = String(b).replace(/[^\d]/g, '');
  if (na && nb && na === nb && na.length >= 2) return 4;
  if (fa.length > 3 && fb.length > 3 && (fa.includes(fb) || fb.includes(fa))) return 3;
  let st = 0;
  for (const p of _words(a)) for (const q of _words(b)) if (p.length >= 4 && q.length >= 4 && p.slice(0, 4) === q.slice(0, 4)) st++;
  return st ? Math.min(3, st + 1) : 0;
}

/**
 * The entities of the OTHER language that may be the same as the subject, best first.
 * subj = { side, forms:[text], units:Set(unit idx), cat, excludeKey }
 * -> [{ x (entity), score, why:[text] }]
 */
function rankCandidates(subj) {
  const s = state.session;
  const other = subj.side === 'src' ? 'tgt' : 'src';
  const byKey = _unitsByKey(other);
  const out = [];
  for (const x of s.ent.entities) {
    if (x.key === subj.excludeKey) continue;
    const xForms = Object.keys(other === 'src' ? x.srcForms : x.tgtForms);
    if (!xForms.length) continue;
    const xUnits = byKey.get(x.key) || new Set();
    let score = 0;
    const why = [];
    const co = [...subj.units].some(u => xUnits.has(u));
    const fits = !(subj.side === 'src' ? x.srcCount : x.tgtCount);
    const sameCat = !subj.cat || x.cat === subj.cat;
    if (co) { score += 6; why.push('mismo p\u00e1rrafo'); }
    if (fits) { score += 3; why.push('sin pareja'); }
    if (subj.cat && x.cat === subj.cat) score += 2;
    let sim = 0;
    for (const a of subj.forms) for (const b of xForms) sim = Math.max(sim, _formSim(a, b));
    if (sim) { score += sim; why.push(sim >= 4 ? 'misma sigla o cifra' : 'forma parecida'); }
    let d = 999;
    for (const u of xUnits) for (const v of subj.units) d = Math.min(d, Math.abs(u - v));
    score += 2 / (1 + d);
    // Strong enough to be chosen in advance: a similar form, or an unpaired one of the same kind in
    // the same paragraph.
    const strong = sim >= 3 || (co && fits && sameCat);
    out.push({ x, score, why, strong });
  }
  return out.sort((a, b) => b.score - a.score);
}

/**
 * A list of candidates with a search box; the best one is chosen in advance when it is a likely match.
 * -> { node, get value(), setSubject(subj), choose(key) }   opts = { allowNone, onChoose(x|null) }
 */
function pairPicker(subj, opts) {
  const o = opts || {};
  let ranked = rankCandidates(subj);
  let chosen = null, best = null;
  const pick = () => { const top = ranked.find(r => r.strong); best = top && top.score >= 6 ? top.x.key : null; };
  pick();
  chosen = best;
  const q = el('input.inp', { type: 'search', placeholder: 'Buscar por etiqueta (ORG25) o por texto\u2026', style: { width: '100%' } });
  const list = el('div.pairlist');
  const draw = () => {
    clear(list);
    const fq = _fold(q.value.trim());
    const rows = ranked.filter(r => !fq || _fold(r.x.cat + r.x.n).includes(fq) ||
      Object.keys(r.x.srcForms).concat(Object.keys(r.x.tgtForms)).some(f => _fold(f).includes(fq)));
    if (o.allowNone) {
      list.appendChild(el('label.pairrow' + (chosen === null ? '.on' : ''), el('input', { type: 'radio', name: 'pairpick', checked: chosen === null ? true : null,
        onchange: () => { chosen = null; draw(); if (o.onChoose) o.onChoose(null); } }), el('span', 'No: es una entidad nueva')));
    }
    if (!rows.length) list.appendChild(el('div.empty', q.value ? 'Nada coincide con la b\u00fasqueda.' : 'No hay ninguna entidad en la otra lengua.'));
    for (const r of rows.slice(0, 150)) {
      const x = r.x;
      list.appendChild(el('label.pairrow' + (chosen === x.key ? '.on' : ''), { 'data-key': x.key },
        el('input', { type: 'radio', name: 'pairpick', checked: chosen === x.key ? true : null, onchange: () => { chosen = x.key; draw(); if (o.onChoose) o.onChoose(x); } }),
        el('span.tk.' + x.cat, x.cat + x.n),
        el('span.pairforms', x.srcCount ? 'O: ' + Object.keys(x.srcForms).join(' \u00b7 ') : '', x.srcCount && x.tgtCount ? '  ' : '', x.tgtCount ? 'T: ' + Object.keys(x.tgtForms).join(' \u00b7 ') : ''),
        x.key === best ? el('span.pill.ok', 'Sugerida') : (r.why.length ? el('span.pill.gray', r.why[0]) : null)));
    }
  };
  q.addEventListener('input', draw);
  draw();
  return {
    node: el('div', q, list),
    get value() { return chosen; },
    get best() { return best; },
    setSubject(next) { ranked = rankCandidates(next); const was = chosen === best; pick(); if (was) chosen = best; draw(); },
    choose(key) { chosen = key; draw(); }
  };
}

async function mergeDialog(e) {
  // The usual case: an entity found on one side only whose counterpart got a tag of its own
  // (UNDP in the original, PNUD in the translation).
  const side = e.srcCount && !e.tgtCount ? 'src' : (e.tgtCount && !e.srcCount ? 'tgt' : 'tgt');
  const forms = Object.keys(side === 'src' ? e.srcForms : e.tgtForms);
  const units = _unitsByKey(side).get(e.key) || new Set();
  const picker = pairPicker({ side, forms, units, cat: e.cat, excludeKey: e.key });
  const where = e.srcCount && !e.tgtCount ? 'solo en el original' : (e.tgtCount && !e.srcCount ? 'solo en la traducci\u00f3n' : 'en las dos lenguas');
  const r = await modal({ title: 'Emparejar ' + e.cat + e.n, help: helpBtn('merge'), width: '680px', body: el('div',
    el('p', el('span.tk.' + e.cat, e.cat + e.n), ' ', el('b', forms.join(' \u00b7 ')), ' est\u00e1 ', where, '.'),
    el('p.info', 'Elija la etiqueta de la otra lengua que es la MISMA entidad (por ejemplo, \u00abUNDP\u00bb y \u00abPNUD\u00bb). ' +
      'Primero van las m\u00e1s probables: las que est\u00e1n en el mismo p\u00e1rrafo, sin pareja o con una forma parecida; la mejor viene marcada. Las dos pasar\u00e1n a ser la misma etiqueta.'),
    picker.node),
    buttons: [{ label: 'Cancelar', value: null }, { label: 'Emparejar', kind: 'primary', value: 'ok', onClick: () => { if (!picker.value) { toast('Elija una entidad de la lista.', 'warn'); return false; } } }] });
  if (r !== 'ok' || !picker.value) return;
  // The entity that is paired keeps the tag of the one chosen.
  setMask({ merges: Object.assign({}, state.project.mask.merges, { [e.key]: picker.value }) });
  toast('Emparejadas: ahora son la misma etiqueta.', 'ok');
}

async function saveToDict(e) {
  const item = { cat: e.cat, art: '', en: state.project.srcLang === 'fr' ? [] : Object.keys(e.srcForms),
    fr: state.project.srcLang === 'fr' ? Object.keys(e.srcForms) : [], es: Object.keys(e.tgtForms) };
  if (e.cat === 'NUM' || e.cat === 'FECHA') { toast('Las cifras y fechas se detectan solas: no hace falta guardarlas.', 'warn'); return; }
  await saveDictItem(item);
  toast('Guardado en su diccionario personal: se enmascarar\u00e1 en todos los documentos.', 'ok');
}

// ------------------------------------------------------------------ sheets

function _inReveal(side, pid, o) {
  const r = revealed && revealed[side];
  return !!r && r.pid === pid && o.start >= r.start && o.end <= r.end;
}

function renderPanes() {
  if (!state.session) return;
  const s = state.session;
  $('#mask-src-title').textContent = 'ORIGINAL \u00b7 ' + (s.srcLang === 'fr' ? 'FR' : 'EN');
  for (const side of ['src', 'tgt']) {
    const model = side === 'src' ? s.src : s.tgt;
    const occMap = s.ent.occ[side];
    const keep = panes[side].scrollTop;
    renderDoc(panes[side], model, {
      decorate: (p) => (occMap.get(p.id) || []).map(o => {
        const e = s.ent.byKey.get(o.key);
        if (!e) return null;
        const bad = e.status === 'nopair';
        const sel = selectedKey === o.key;
        const occ = side + ':' + p.id + ':' + o.start;
        const shown = _inReveal(side, p.id, o);
        if (showOriginal || shown) {
          return { start: o.start, end: o.end, cls: 'ent-orig ' + e.cat + (bad ? ' bad' : '') + (sel ? ' sel' : '') + (shown ? ' revealed' : ''),
            attrs: { title: e.cat + e.n, 'data-key': o.key, 'data-occ': occ } };
        }
        // The tooltip shows only what the tag hides.
        const pill = el('span.tk.' + e.cat + (bad ? '.bad' : '') + (sel ? '.sel' : ''), { title: o.surface, 'data-key': o.key, 'data-occ': occ }, e.cat + e.n);
        return { start: o.start, end: o.end, replace: pill };
      }).filter(Boolean),
      onParaClick: (p, ev) => onSheetClick(side, p, ev)
    });
    panes[side].scrollTop = keep;
    panes[side].oncontextmenu = (ev) => onSheetMenu(side, ev);
  }
  nav.refresh();
}

function onSheetClick(side, p, ev) {
  const t = ev.target.closest('[data-key]');
  const r = nav.clickAt(side, ev);
  // A click elsewhere puts back the tags of a sentence shown unmasked.
  if (revealed) {
    const rv = revealed[side];
    const inside = rv && r && r.offset !== null && rv.pid === r.pid && r.offset >= rv.start && r.offset <= rv.end;
    if (!inside) { revealed = null; renderPanes(); }
  }
  if (t) {
    // A tag: its entity is selected, glowing in red in both sentences; the other sheet follows.
    selectedKey = t.dataset.key;
    renderList();
    renderPanes();
    const u = unitOf(state.session, side, p.id);
    if (u) nav.focusUnit(u.idx, { key: t.dataset.key, quiet: true });
    const card = document.querySelector('#mask-entities .ent.sel');
    if (card) card.scrollIntoView({ block: 'nearest' });
  }
}

/** Right click: on selected text, mask it; on a tag, its own menu; on a sentence, "Desenmascarar". */
function onSheetMenu(side, ev) {
  const t = ev.target.closest('[data-occ]');
  const sel = window.getSelection();
  const txt = sel ? sel.toString().replace(/\s+/g, ' ').trim() : '';
  if (!t && txt.length >= 2 && sel.anchorNode && panes[side].contains(sel.anchorNode)) {
    ev.preventDefault();
    openMenu({ x: ev.clientX, y: ev.clientY }, [
      { header: '\u00ab' + (txt.length > 40 ? txt.slice(0, 37) + '\u2026' : txt) + '\u00bb' },
      { label: 'Enmascarar la selecci\u00f3n\u2026 (Alt+E)', onClick: () => maskSelection({ text: txt, side }) },
      { label: 'Copiar', onClick: () => copyText(txt) }
    ]);
    return;
  }
  const pe = ev.target.closest('.p[data-pid]');
  if (!pe) return;
  ev.preventDefault();
  const pid = +pe.dataset.pid;
  const off = offsetAt(ev, pe);
  const index = off === null ? null : sentenceAt(sentencesOf(state.session, side, pid), off);
  const items = [];
  if (t) {
    const e = state.session.ent.byKey.get(t.dataset.key);
    items.push({ header: e ? e.cat + e.n : t.dataset.key });
  } else items.push({ header: 'Frase' });
  if (index !== null && index >= 0) items.push({ label: 'Desenmascarar', onClick: () => revealSentence(side, pid, index) });
  if (t) {
    const key = t.dataset.key, occ = t.dataset.occ;
    items.push({ sep: true },
      { label: 'No enmascarar esta aparici\u00f3n', onClick: () => setMask({ removedOcc: (state.project.mask.removedOcc || []).concat([occ]) }) },
      { label: 'No enmascarar esta entidad en todo el documento', onClick: () => setMask({ removedKeys: (state.project.mask.removedKeys || []).concat([key]) }) },
      { label: 'Ver la entidad en la lista', onClick: () => selectEntity(key, true) });
  }
  openMenu({ x: ev.clientX, y: ev.clientY }, items);
}

/** Shows a sentence and its counterpart with the real text, until another sentence is clicked. */
function revealSentence(side, pid, index) {
  const s = state.session;
  const other = side === 'src' ? 'tgt' : 'src';
  const sp = sentencesOf(s, side, pid)[index];
  if (!sp) return;
  revealed = { [side]: { pid, start: sp.start, end: sp.end } };
  const peer = sentencePeers(s, side, pid, index);
  if (peer) {
    const spans = sentencesOf(s, other, peer.pid);
    const pick = peer.list.map(i => spans[i]).filter(Boolean);
    revealed[other] = pick.length ? { pid: peer.pid, start: Math.min(...pick.map(x => x.start)), end: Math.max(...pick.map(x => x.end)) }
      : { pid: peer.pid, start: 0, end: paraText(s, other, peer.pid).length };
  }
  renderPanes();
  nav.markSentence(side, pid, index, null);
}

/** Hovering a tag: its counterpart in the other sheet glows (in the paired sentence when known). */
function attachTagHover() {
  for (const side of ['src', 'tgt']) {
    let cur = null;
    const drop = () => {
      for (const x of document.querySelectorAll('#mask-src .glow, #mask-tgt .glow')) x.classList.remove('glow');
      cur = null;
    };
    panes[side].addEventListener('mouseover', (ev) => {
      const t = ev.target.closest && ev.target.closest('[data-key]');
      if (t === cur) return;
      drop();
      if (!t || !state.session) return;
      cur = t;
      const s = state.session;
      const other = side === 'src' ? 'tgt' : 'src';
      const pe = t.closest('.p[data-pid]');
      if (!pe) return;
      const pid = +pe.dataset.pid;
      const opid = peerPid(s, side, pid);
      const ope = opid === null ? null : panes[other].querySelector('.p[data-pid="' + opid + '"]');
      if (!ope) return;
      const key = t.dataset.key;
      const all = Array.from(ope.querySelectorAll('[data-key]')).filter(x => x.dataset.key === key);
      if (!all.length) return;
      // Prefer the ones inside the sentence paired with the hovered one.
      const start = +String(t.dataset.occ || '').split(':')[2];
      const idx = sentenceAt(sentencesOf(s, side, pid), start);
      const peer = sentencePeers(s, side, pid, idx);
      const spans = sentencesOf(s, other, opid);
      const inPeer = peer && peer.list.length ? all.filter(x => {
        const o = +String(x.dataset.occ || '').split(':')[2];
        return peer.list.some(i => spans[i] && o >= spans[i].start && o < spans[i].end);
      }) : [];
      for (const x of (inPeer.length ? inPeer : all)) x.classList.add('glow');
    });
    panes[side].addEventListener('mouseleave', drop);
  }
}

function onSearch(e) {
  const side = e.target.dataset.side;
  const q = e.target.value.trim().toLowerCase();
  if (q.length < 2) return;
  const model = side === 'src' ? state.session.src : state.session.tgt;
  const p = model.paras.find(x => x.text.toLowerCase().includes(q));
  if (!p) return;
  const at = p.text.toLowerCase().indexOf(q);
  nav.focusSpan(side, p.id, at, at + q.length);
}

/** Goes to a paragraph pair and marks the sentences where the entity occurs (or should). */
function focusUnit(unitIdx, opt) { nav.focusUnit(unitIdx, opt); }

// ------------------------------------------------------------------ manual masking

async function maskSelection(preset) {
  if (!state.session) return;
  let text, side;
  if (preset && preset.text) { text = preset.text; side = preset.side; }
  else {
    const sel = window.getSelection();
    text = sel ? sel.toString().replace(/\s+/g, ' ').trim() : '';
    if (!text || text.length < 2) { toast('Seleccione primero el texto que quiere enmascarar.', 'warn'); return; }
    const node = sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement);
    const pane = node && node.closest('.pane-body');
    side = pane === panes.src ? 'src' : (pane === panes.tgt ? 'tgt' : null);
  }
  if (!side) { toast('Seleccione el texto dentro de una de las dos hojas.', 'warn'); return; }
  if (/\{|\}/.test(text)) { toast('La selecci\u00f3n incluye una etiqueta: use \u00abVer original\u00bb para seleccionar el texto real.', 'warn', 6000); return; }
  const catSel = el('select.inp', CATS.map(c => el('option', { value: c }, CAT_SINGULAR[c])));
  catSel.value = 'X';
  const other = el('input.inp', { placeholder: side === 'src' ? 'Forma en la traducci\u00f3n (opcional)' : 'Forma en el original (opcional)' });
  // Where the selection is (to suggest the entity of the other language in the same paragraphs).
  const units = new Set();
  const model = side === 'src' ? state.session.src : state.session.tgt;
  const ft = _fold(text);
  for (const p of model.paras) if (_fold(p.text).includes(ft)) { const u = unitOf(state.session, side, p.id); if (u) units.add(u.idx); }
  let catTouched = false, pairTouched = false;
  const subj = () => ({ side, forms: [text].concat(other.value.trim() ? [] : []), units, cat: catTouched ? catSel.value : null, excludeKey: null });
  const picker = pairPicker(subj(), { allowNone: true, onChoose: (x) => { pairTouched = true; if (x && !catTouched) catSel.value = x.cat; } });
  if (picker.best && !catTouched) catSel.value = state.session.ent.byKey.get(picker.best).cat;
  catSel.addEventListener('change', () => { catTouched = true; if (!pairTouched) picker.setSubject(subj()); });
  // Typing the other-language form of an entity that is already masked pairs the two automatically
  // (until the user picks something in the list by hand).
  other.addEventListener('input', () => {
    if (pairTouched) return;
    const v = other.value.trim();
    const hit = v && state.session.ent.entities.find(x => Object.keys(side === 'src' ? x.tgtForms : x.srcForms).includes(v));
    picker.choose(hit ? hit.key : picker.best);
  });
  const dict = el('input', { type: 'checkbox' });
  const body = el('div',
    el('p', 'Enmascarar \u00ab', el('b', text), '\u00bb en ', side === 'src' ? 'el original' : 'la traducci\u00f3n', ' (todas sus apariciones).'),
    el('div.field', el('label.lbl', 'Categor\u00eda'), catSel),
    el('div.field', el('label.lbl', 'Es la misma entidad que (en la otra lengua)'), picker.node),
    el('div.field', el('label.lbl', side === 'src' ? 'Forma en la traducci\u00f3n' : 'Forma en el original'), other),
    el('label', dict, ' Guardar tambi\u00e9n en mi diccionario personal (para todos los documentos)'));
  const r = await modal({ title: 'Enmascarar selecci\u00f3n', help: helpBtn('mask-selection'), width: '680px', body, buttons: [{ label: 'Cancelar', value: null }, { label: 'Enmascarar', kind: 'primary', value: 'ok' }] });
  if (r !== 'ok') return;
  const term = { id: uid('t'), cat: catSel.value, art: '', src: [], tgt: [] };
  if (side === 'src') { term.src.push(text); if (other.value.trim()) term.tgt.push(other.value.trim()); }
  else { term.tgt.push(text); if (other.value.trim()) term.src.push(other.value.trim()); }
  const mask = state.project.mask;
  const patch = { terms: (mask.terms || []).concat([term]) };
  if (!mask.cats.includes(term.cat)) patch.cats = mask.cats.concat([term.cat]);
  if (picker.value) patch.merges = Object.assign({}, mask.merges, { ['t:' + term.id]: picker.value });
  setMask(patch);
  if (dict.checked) {
    await saveDictItem({ cat: term.cat, art: term.art, en: state.project.srcLang === 'fr' ? [] : term.src, fr: state.project.srcLang === 'fr' ? term.src : [], es: term.tgt });
  }
  toast('Enmascarado.', 'ok');
}
