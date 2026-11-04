/**
 * mask-view.js - Step 1 "Enmascarar": entities panel, the two sheets with the tags (or the real text),
 * category switches, manual masking (Alt+E), per-entity actions and the export menu.
 */

import { helpBtn, helpItem } from './help.js';
import { el, $, clear, toast, modal, copyText, download, pickFiles, promptDialog, uid } from '../util/dom.js';
import { state, on, emit, setMask, remaskNow, saveDictItem, addFindings } from '../state.js';
import { renderDoc } from './preview.js';
import { CATS, CAT_LABELS, CAT_SINGULAR, ARTICLES, STATUS_LABELS, mainForm } from '../redact/entities.js';
import { exportMasked, exportBilingualXlsx, exportBilingualHtml, exportKeyMap } from '../export/exports.js';
import { buildExternalText, importExternal } from '../review/external.js';
import { openMenu } from './menu.js';

let root, toolsHost;
let showOriginal = false;
let filter = 'all';
let selectedKey = null;
let panes = {};

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
  on('masked', render);
  on('view', (v) => { if (v === 'mask') { renderTools(); render(); } });
  document.addEventListener('keydown', (e) => {
    if (state.view !== 'mask') return;
    if (e.altKey && (e.key === 'e' || e.key === 'E')) { e.preventDefault(); maskSelection(); }
  });
}

// ------------------------------------------------------------------ top bar

function renderTools() {
  if (state.view !== 'mask') return;
  clear(toolsHost);
  if (!state.project) return;
  const mask = state.project.mask;
  for (const c of CATS) {
    const onCat = mask.cats.includes(c) || (c === 'X' && (mask.terms || []).some(t => (t.cat || 'X') === 'X'));
    toolsHost.appendChild(el('span.cat' + (onCat ? '' : '.off'), {
      title: onCat ? 'Pulse para no enmascarar ' + CAT_LABELS[c].toLowerCase() : 'Pulse para enmascarar ' + CAT_LABELS[c].toLowerCase(),
      onclick: () => {
        const cats = mask.cats.includes(c) ? mask.cats.filter(x => x !== c) : mask.cats.concat([c]);
        setMask({ cats });
        renderTools();
      }
    }, el('i', { style: { background: 'var(--c-' + c.toLowerCase() + ')' } }), CAT_LABELS[c]));
  }
  toolsHost.appendChild(el('div.grow'));
  const ents = state.session ? state.session.ent.entities : [];
  const bad = ents.filter(e => e.status !== 'ok').length;
  const numBad = ents.filter(e => e.cat === 'NUM' && e.status === 'nopair').length;
  toolsHost.appendChild(el('div.summary',
    el('span.pill.ok', ents.length + ' entidades'),
    bad ? el('span.pill.warn', bad + ' por revisar') : null,
    numBad ? el('span.pill.err', numBad + ' cifras sin pareja') : null));
  const lang = el('select', { title: 'Lengua del original', onchange: (e) => { state.project.srcLang = e.target.value; state.session.srcLang = e.target.value; remaskNow(); } },
    el('option', { value: 'en' }, 'Original: ingl\u00e9s'), el('option', { value: 'fr' }, 'Original: franc\u00e9s'));
  lang.value = state.project.srcLang || 'en';
  toolsHost.appendChild(lang);
  toolsHost.appendChild(el('button.btn', { onclick: (e) => optionsMenu(e.currentTarget) }, 'Opciones \u25be'));
  toolsHost.appendChild(el('button.btn', { title: 'Alternar entre etiquetas y texto real', onclick: () => { showOriginal = !showOriginal; renderTools(); renderPanes(); } },
    '\ud83d\udc41 ' + (showOriginal ? 'Ver etiquetas' : 'Ver original')));
  toolsHost.appendChild(el('button.btn', { title: 'Enmascarar el texto seleccionado (Alt+E)', onclick: maskSelection }, '+ Enmascarar selecci\u00f3n'));
  toolsHost.appendChild(el('button.btn.violet', { onclick: (e) => exportMenu(e.currentTarget) }, 'Exportar enmascarado \u25be'));
  toolsHost.appendChild(helpBtn('mask-tools'));
}

function optionsMenu(anchor) {
  const mask = state.project.mask;
  openMenu(anchor, [
    { label: (mask.spelled !== false ? '\u2713 ' : '') + 'Enmascarar n\u00fameros escritos en letra', onClick: () => { setMask({ spelled: mask.spelled === false }); renderTools(); } },
    { label: (mask.acronyms !== false ? '\u2713 ' : '') + 'Enmascarar siglas desconocidas presentes en ambos textos', onClick: () => { setMask({ acronyms: mask.acronyms === false }); renderTools(); } },
    { sep: true },
    { label: 'Volver a enmascarar todo lo que se quit\u00f3 a mano', onClick: () => { setMask({ removedKeys: [], removedOcc: [] }); toast('Restablecido.', 'ok'); } },
    { label: 'Deshacer todas las fusiones', onClick: () => setMask({ merges: {} }) },
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
  const mods = [['grammar', 'Ortograf\u00eda y gram\u00e1tica'], ['fidelity', 'Fidelidad'], ['integrity', 'Omisiones y adiciones'], ['style', 'Estilo'], ['coldread', 'Lectura en fr\u00edo']];
  const checks = mods.map(([id, label]) => el('label', { style: { marginRight: '12px' } },
    el('input', { type: 'checkbox', value: id, checked: id !== 'coldread' }), ' ' + label));
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
  emit('goto', 'review');
}

// ------------------------------------------------------------------ entities list

function render() {
  if (state.view !== 'mask' || !state.session) return;
  renderTools();
  renderList();
  renderPanes();
}

function renderList() {
  const ents = state.session.ent.entities;
  const bubbles = $('#mask-bubbles');
  clear(bubbles);
  const counts = { all: ents.length, bad: ents.filter(e => e.status !== 'ok').length };
  for (const c of CATS) counts[c] = ents.filter(e => e.cat === c).length;
  const mk = (id, label) => el('span.bub' + (filter === id ? '.on' : ''), { onclick: () => { filter = id; renderList(); } }, label + ' ' + counts[id]);
  bubbles.appendChild(mk('all', 'Todas'));
  if (counts.bad) bubbles.appendChild(mk('bad', 'Por revisar'));
  for (const c of CATS) if (counts[c]) bubbles.appendChild(mk(c, CAT_LABELS[c]));
  const list = $('#mask-entities');
  clear(list);
  const shown = ents.filter(e => filter === 'all' || (filter === 'bad' ? e.status !== 'ok' : e.cat === filter));
  if (!shown.length) list.appendChild(el('div.empty', 'No hay entidades en esta vista.'));
  for (const e of shown) list.appendChild(entityCard(e));
  list.appendChild(el('p.info', { style: { marginTop: '8px' } }, 'Seleccione texto en una hoja y pulse Alt+E para enmascararlo. Pulse una etiqueta para ver la entidad.'));
}

function _forms(forms) {
  return Object.keys(forms).map(f => f + (forms[f] > 1 ? ' (\u00d7' + forms[f] + ')' : '')).join(' \u00b7 ') || '\u2014';
}

function entityCard(e) {
  const sel = selectedKey === e.key;
  const stCls = e.status === 'ok' ? 'ok' : (e.status === 'nopair' ? 'bad' : 'mid');
  const card = el('div.ent' + (sel ? '.sel' : ''), { onclick: (ev) => { if (ev.target.closest('.acts')) return; selectEntity(sel ? null : e.key, true); } },
    el('div.row', el('span.tk.' + e.cat, e.art ? el('span.art', e.art) : null, e.cat + e.n), el('span.st.' + stCls, STATUS_LABELS[e.status])),
    el('div.forms', 'O: ' + _forms(e.srcForms)),
    el('div.forms', 'T: ' + _forms(e.tgtForms) + (e.art ? ' \u00b7 ' + e.art : '')));
  const acts = el('div.acts',
    el('button.btn.sm', { onclick: () => changeCat(e) }, 'Categor\u00eda'),
    el('button.btn.sm', { onclick: (ev) => changeArt(e, ev.currentTarget) }, 'Art\u00edculo'),
    el('button.btn.sm', { onclick: () => mergeDialog(e) }, 'Fusionar\u2026'),
    el('button.btn.sm', { onclick: () => saveToDict(e) }, 'A mi diccionario'),
    el('button.btn.sm.danger', { onclick: () => { setMask({ removedKeys: (state.project.mask.removedKeys || []).concat([e.key]) }); toast('Ya no se enmascara ' + e.cat + e.n + '.', 'ok'); } }, 'No enmascarar'));
  card.appendChild(acts);
  return card;
}

function selectEntity(key, scroll) {
  selectedKey = key;
  renderList();
  renderPanes();
  if (key && scroll) {
    for (const side of ['src', 'tgt']) {
      const first = panes[side].querySelector('.sel');
      if (first) first.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }
}

async function changeCat(e) {
  const sel = el('select.inp', CATS.map(c => el('option', { value: c }, CAT_SINGULAR[c])));
  sel.value = e.cat;
  const r = await modal({ title: 'Categor\u00eda de ' + e.cat + e.n, body: el('div', el('label.lbl', 'Categor\u00eda'), sel),
    buttons: [{ label: 'Cancelar', value: null }, { label: 'Guardar', kind: 'primary', value: 'ok' }] });
  if (r !== 'ok') return;
  setMask({ catOverride: Object.assign({}, state.project.mask.catOverride, { [e.key]: sel.value }) });
}

function changeArt(e, anchor) {
  openMenu(anchor, ARTICLES.map(a => ({ label: a ? a + ' (' + { el: 'masculino singular', la: 'femenino singular', los: 'masculino plural', las: 'femenino plural' }[a] + ')' : 'Sin art\u00edculo (desconocido)',
    onClick: () => setMask({ artOverride: Object.assign({}, state.project.mask.artOverride, { [e.key]: a }) }) })));
}

async function mergeDialog(e) {
  const others = state.session.ent.entities.filter(x => x.key !== e.key);
  const sel = el('select.inp', others.map(x => el('option', { value: x.key }, x.cat + x.n + ' \u2014 ' + (mainForm(x.srcForms) || mainForm(x.tgtForms)))));
  const r = await modal({ title: 'Fusionar ' + e.cat + e.n, help: helpBtn('merge'), body: el('div',
    el('p.info', 'Use esto cuando dos etiquetas son en realidad la misma entidad (por ejemplo, una sigla del original y el nombre completo de la traducci\u00f3n). La etiqueta elegida absorbe a ' + e.cat + e.n + '.'),
    el('label.lbl', 'Es la misma entidad que'), sel),
    buttons: [{ label: 'Cancelar', value: null }, { label: 'Fusionar', kind: 'primary', value: 'ok' }] });
  if (r !== 'ok' || !sel.value) return;
  setMask({ merges: Object.assign({}, state.project.mask.merges, { [e.key]: sel.value }) });
}

async function saveToDict(e) {
  const item = { cat: e.cat, art: e.art || '', en: state.project.srcLang === 'fr' ? [] : Object.keys(e.srcForms),
    fr: state.project.srcLang === 'fr' ? Object.keys(e.srcForms) : [], es: Object.keys(e.tgtForms) };
  if (e.cat === 'NUM' || e.cat === 'FECHA') { toast('Las cifras y fechas se detectan solas: no hace falta guardarlas.', 'warn'); return; }
  await saveDictItem(item);
  toast('Guardado en su diccionario personal: se enmascarar\u00e1 en todos los documentos.', 'ok');
}

// ------------------------------------------------------------------ sheets

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
        if (showOriginal) {
          return { start: o.start, end: o.end, cls: 'ent-orig ' + e.cat + (bad ? ' bad' : '') + (sel ? ' sel' : ''),
            attrs: { title: e.cat + e.n + ' \u00b7 ' + STATUS_LABELS[e.status], 'data-key': o.key, 'data-occ': side + ':' + p.id + ':' + o.start } };
        }
        const pill = el('span.tk.' + e.cat + (bad ? '.bad' : '') + (sel ? '.sel' : ''), {
          title: o.surface + ' \u00b7 ' + STATUS_LABELS[e.status], 'data-key': o.key, 'data-occ': side + ':' + p.id + ':' + o.start },
          side === 'tgt' && e.art ? el('span.art', e.art) : null, e.cat + e.n);
        return { start: o.start, end: o.end, replace: pill };
      }).filter(Boolean),
      onParaClick: (p, ev) => {
        const t = ev.target.closest('[data-key]');
        if (t) { selectEntity(t.dataset.key === selectedKey ? null : t.dataset.key, false); return; }
        highlightCounterpart(side, p.id);
      }
    });
    panes[side].scrollTop = keep;
    panes[side].oncontextmenu = (ev) => {
      const t = ev.target.closest('[data-occ]');
      // Right click on selected text: offer to mask it (keep the selection: clicking the menu clears it).
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
      if (!t) return;
      ev.preventDefault();
      occMenu(ev, t.dataset.key, t.dataset.occ);
    };
  }
}

function occMenu(ev, key, occ) {
  const e = state.session.ent.byKey.get(key);
  openMenu({ x: ev.clientX, y: ev.clientY }, [
    { header: e ? e.cat + e.n : key },
    { label: 'No enmascarar esta aparici\u00f3n', onClick: () => setMask({ removedOcc: (state.project.mask.removedOcc || []).concat([occ]) }) },
    { label: 'No enmascarar esta entidad en todo el documento', onClick: () => setMask({ removedKeys: (state.project.mask.removedKeys || []).concat([key]) }) },
    { label: 'Ver la entidad en la lista', onClick: () => selectEntity(key, true) }
  ]);
}

function highlightCounterpart(side, pid) {
  const s = state.session;
  const u = s.units.find(x => (side === 'src' ? x.srcPara : x.tgtPara) === pid);
  for (const pane of Object.values(panes)) pane.querySelectorAll('.p.hit').forEach(n => n.classList.remove('hit'));
  if (!u) return;
  const other = side === 'src' ? 'tgt' : 'src';
  const opid = other === 'src' ? u.srcPara : u.tgtPara;
  const a = panes[side].querySelector('.p[data-pid="' + pid + '"]');
  if (a) a.classList.add('hit');
  if (opid === null) return;
  const b = panes[other].querySelector('.p[data-pid="' + opid + '"]');
  if (b) { b.classList.add('hit'); b.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
}

function onSearch(e) {
  const side = e.target.dataset.side;
  const q = e.target.value.trim().toLowerCase();
  if (q.length < 2) return;
  const model = side === 'src' ? state.session.src : state.session.tgt;
  const p = model.paras.find(x => x.text.toLowerCase().includes(q));
  if (!p) return;
  highlightCounterpart(side, p.id);
  const n = panes[side].querySelector('.p[data-pid="' + p.id + '"]');
  if (n) n.scrollIntoView({ block: 'center' });
}

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
  const artSel = el('select.inp', ARTICLES.map(a => el('option', { value: a }, a || 'Sin art\u00edculo')));
  const other = el('input.inp', { placeholder: side === 'src' ? 'Forma en la traducci\u00f3n (opcional)' : 'Forma en el original (opcional)' });
  const pairSel = el('select.inp', el('option', { value: '' }, 'No: es una entidad nueva'),
    state.session.ent.entities.map(x => el('option', { value: x.key }, x.cat + x.n + ' \u2014 ' + (mainForm(x.srcForms) || mainForm(x.tgtForms)))));
  // Typing the other-language form of an entity that is already masked pairs the two automatically
  // (until the user picks something in the list by hand).
  let pairTouched = false;
  pairSel.addEventListener('change', () => { pairTouched = true; });
  other.addEventListener('input', () => {
    if (pairTouched) return;
    const v = other.value.trim();
    const hit = v && state.session.ent.entities.find(x => Object.keys(side === 'src' ? x.tgtForms : x.srcForms).includes(v));
    pairSel.value = hit ? hit.key : '';
  });
  const dict = el('input', { type: 'checkbox' });
  const body = el('div',
    el('p', 'Enmascarar \u00ab', el('b', text), '\u00bb en ', side === 'src' ? 'el original' : 'la traducci\u00f3n', ' (todas sus apariciones).'),
    el('div.form-grid',
      el('div.field', el('label.lbl', 'Categor\u00eda'), catSel),
      el('div.field', el('label.lbl', 'Art\u00edculo en espa\u00f1ol'), artSel)),
    el('div.field', el('label.lbl', 'Es la misma entidad que'), pairSel),
    el('div.field', el('label.lbl', side === 'src' ? 'Forma en la traducci\u00f3n' : 'Forma en el original'), other),
    el('label', dict, ' Guardar tambi\u00e9n en mi diccionario personal (para todos los documentos)'));
  const r = await modal({ title: 'Enmascarar selecci\u00f3n', help: helpBtn('mask-selection'), body, buttons: [{ label: 'Cancelar', value: null }, { label: 'Enmascarar', kind: 'primary', value: 'ok' }] });
  if (r !== 'ok') return;
  const term = { id: uid('t'), cat: catSel.value, art: artSel.value, src: [], tgt: [] };
  if (side === 'src') { term.src.push(text); if (other.value.trim()) term.tgt.push(other.value.trim()); }
  else { term.tgt.push(text); if (other.value.trim()) term.src.push(other.value.trim()); }
  const mask = state.project.mask;
  const patch = { terms: (mask.terms || []).concat([term]) };
  if (!mask.cats.includes(term.cat)) patch.cats = mask.cats.concat([term.cat]);
  if (pairSel.value) patch.merges = Object.assign({}, mask.merges, { ['t:' + term.id]: pairSel.value });
  setMask(patch);
  if (dict.checked) {
    await saveDictItem({ cat: term.cat, art: term.art, en: state.project.srcLang === 'fr' ? [] : term.src, fr: state.project.srcLang === 'fr' ? term.src : [], es: term.tgt });
  }
  toast('Enmascarado.', 'ok');
}
