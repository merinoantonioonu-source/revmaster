/**
 * correct-view.js - Step 4 "Corregir": the findings as aligned rows (N.o | original | translation |
 * finding), as in a CAT tool, with filters by module, state and severity and a search box; on the
 * right an inspector with the chosen finding (what it says, an editable proposal, why, Aceptar /
 * Rechazar). Keys: J and K next and previous, A accept, R reject, E edit the proposal.
 *
 * "Documento" shows instead the two sheets with the sentence navigation of COMeT Final Check
 * (ui/nav.js): a click on a sentence marks its pair, a finding centres both sheets on its sentence.
 * In the rows the same marks are painted inside the row (::highlight(um-seg) and um-focus).
 */

import { helpBtn, helpItem } from './help.js';
import { el, $, clear, toast, modal, confirmDialog, debounce } from '../util/dom.js';
import { state, on, emit, updateFinding, saveProjectSoon } from '../state.js';
import { renderDoc, renderPara } from './preview.js';
import { MODULES, moduleById } from '../review/module-list.js';
import { CAT_LABELS } from '../review/prompts.js';
import { STATE_LABELS, SEV_LABELS } from '../review/findings.js';
import { externalDialog, importDialog } from './mask-view.js';
import { exportFeedbackXlsx } from '../export/exports.js';
import { createNav, findingPlace, peerSentence, sentencePeers, sentencesOf, sentenceAt, rangeOf, offsetAt, paint, clearPaint } from './nav.js';
import { openFindingsWindow, syncFindingsWindow, findingsWindowSelect } from './findings-window.js';
import { openMenu } from './menu.js';
import { reverify, benchDialog, resetReviewState } from './review-view.js';
import { icon } from './icons.js';

let root, toolsHost, panes = {};
let filt = { module: 'all', sev: 'all', state: 'open', q: '' };
let selected = null;
let mode = 'rows';            // 'rows' (aligned segments) | 'doc' (the two sheets)
let nav = null;
const MAX_ROWS = 400;

export function mountCorrectView(host, tools) {
  root = host;
  toolsHost = tools;
  const q = el('input#cx-q', { type: 'search', placeholder: 'Buscar en el texto', 'aria-label': 'Buscar en el texto',
    oninput: debounce((e) => { filt.q = e.target.value; renderFilters(); renderBody(); renderInspector(); }, 200) });
  const modeSw = el('div.seg2#cx-mode', { role: 'group', 'aria-label': 'Vista' },
    el('button', { 'data-mode': 'rows', title: 'Una fila por segmento con hallazgos', onclick: () => setMode('rows') }, icon('rows', 15), 'Segmentos'),
    el('button', { 'data-mode': 'doc', title: 'Las dos hojas completas, como en Final Check', onclick: () => setMode('doc') }, icon('columns', 15), 'Documento'));
  root.appendChild(el('div.cx-main',
    el('div.cx-filters#rv-bubbles',
      el('div.cx-fl'),
      el('label.cx-search', icon('search', 16), q),
      modeSw,
      helpBtn('findings')),
    el('div.cx-body',
      el('div.cx-list#cx-list',
        el('div.cx-head', el('span', 'N.\u00ba'), el('span#cx-src-title', 'ORIGINAL'), el('span', 'TRADUCCI\u00d3N \u00b7 ES'), el('span.r', 'HALLAZGO')),
        el('div.cx-rows#rv-findings', { onclick: onRowsClick })),
      el('div.panes.cx-doc#cx-doc',
        el('div.pane', el('div.pane-head', el('span#rv-src-title', 'ORIGINAL')), el('div.pane-body#rv-src')),
        el('div.pane', el('div.pane-head', el('span', 'TRADUCCI\u00d3N \u00b7 ES'), helpBtn('review-sheets'), el('span.grow'), el('span.muted#rv-unit-info')), el('div.pane-body#rv-tgt')))),
    el('div.cx-keys#cx-keys')));
  root.appendChild(el('aside.cx-insp#cx-insp', { 'aria-label': 'Hallazgo elegido' }));
  panes = { src: $('#rv-src'), tgt: $('#rv-tgt') };
  nav = createNav({ panes, session: () => state.session });
  nav.attachHover();
  on('view', (v) => {
    if (v !== 'correct') { if (mode === 'rows') clearPaint(); return; }
    renderAll();
    // Ready to work with the keys: the first finding is chosen when nothing is.
    const list = visibleFindings();
    if (list.length && !list.some(f => f.id === selected)) select(list[0].id, { fromRow: true });
  });
  on('findings', () => { syncFindingsWindow(); if (state.view === 'correct') renderAll(); });
  on('review-status', () => { if (state.view === 'correct') renderTools(); });
  on('finding', () => { syncFindingsWindow(); if (state.view === 'correct') renderAll(); });
  on('masked', () => { if (state.view === 'correct') renderBody(); });
  on('project', () => { selected = null; filt.q = ''; const qi = $('#cx-q'); if (qi) qi.value = ''; });
  document.addEventListener('keydown', onKey);
}

function renderAll() {
  if (!state.session) return;
  renderTools();
  renderFilters();
  renderBody();
  renderInspector();
}

function setMode(m) {
  if (mode === m) return;
  mode = m;
  clearPaint();
  nav.clear();
  renderFilters();
  renderBody();
  const f = state.findings.find(x => x.id === selected);
  if (f) select(f.id, { quiet: false });
}

// ------------------------------------------------------------------ tools

function _deferredRunning() { return ((state.project && state.project.deferred) || []).some(r => r.status === 'running'); }

function renderTools() {
  if (state.view !== 'correct') return;
  clear(toolsHost);
  if (!state.project) return;
  const open = state.findings.filter(f => f.state === 'open');
  const n = (s) => open.filter(f => f.sev === s).length;
  toolsHost.appendChild(el('div.summary',
    n('CRI') ? el('span.pill.err', n('CRI') + (n('CRI') === 1 ? ' cr\u00edtico' : ' cr\u00edticos')) : null,
    n('MAY') ? el('span.pill.warn', n('MAY') + (n('MAY') === 1 ? ' mayor' : ' mayores')) : null,
    n('MEN') ? el('span.pill.info', n('MEN') + (n('MEN') === 1 ? ' menor' : ' menores')) : null,
    n('SUG') ? el('span.pill.gray', n('SUG') + (n('SUG') === 1 ? ' sugerencia' : ' sugerencias')) : null,
    !open.length ? el('span.pill.ok', 'Sin hallazgos pendientes') : null,
    // A deferred review still on: its findings (and the Verifier's verdicts) are still to come.
    _deferredRunning() ? el('span.pill.warn', { title: 'Faltan respuestas de la revisi\u00f3n diferida: los hallazgos y lo que descarte el Verificador llegar\u00e1n solos. Espere a que termine antes de exportar.' }, 'Revisi\u00f3n diferida en curso') : null));
  toolsHost.appendChild(el('div.grow'));
  toolsHost.appendChild(el('button.btn', { title: 'Abrir los hallazgos en una ventana aparte, en forma de tabla', onclick: openTable }, icon('table', 16), 'Tabla'));
  toolsHost.appendChild(el('button.btn', { title: 'Borrar los hallazgos para empezar de cero', onclick: resetFindings }, icon('trash', 16), 'Vaciar'));
  toolsHost.appendChild(el('button.btn', { onclick: (e) => moreMenu(e.currentTarget) }, 'M\u00e1s', icon('down', 14)));
  toolsHost.appendChild(el('button.btn.primary', { title: 'Paso 5: la traducci\u00f3n con control de cambios y los informes', onclick: () => emit('goto', 'export') }, 'Exportar', icon('arrow', 16)));
  toolsHost.appendChild(helpBtn('review-tools'));
}

/** "Mas" of Corregir: the Verifier, decisions on all the visible findings, the external AI and the bench. */
function moreMenu(anchor) {
  openMenu(anchor, [
    { label: 'Verificar los hallazgos pendientes de la IA', onClick: reverify },
    { sep: true },
    { header: 'Los hallazgos que se ven' },
    { label: 'Aceptar todos los que tienen propuesta', onClick: () => bulk('accepted') },
    { label: 'Rechazar todos', onClick: () => bulk('rejected') },
    { label: 'Volver a ponerlos como pendientes', onClick: () => bulk('open') },
    { label: 'Borrar los hallazgos pendientes de la IA', onClick: async () => {
      if (!(await confirmDialog('Borrar hallazgos', 'Se borrar\u00e1n los hallazgos pendientes de la IA y de la IA externa (los aceptados y rechazados se conservan).', 'Borrar'))) return;
      state.findings = state.findings.filter(f => f.state !== 'open' || f.source === 'local' || f.source === 'rule');
      emit('findings'); saveProjectSoon();
    } },
    { sep: true },
    { label: 'Copiar para IA externa\u2026', onClick: externalDialog },
    { label: 'Importar respuesta de IA externa\u2026', onClick: importDialog },
    { sep: true },
    { label: state.project && state.project.bench ? 'Resultado del banco de pruebas\u2026' : 'Banco de pruebas\u2026', onClick: benchDialog },
    { sep: true },
    helpItem('review-more', anchor)
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

// ------------------------------------------------------------------ filters

const _fold = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

function _inState(f) {
  return filt.state === 'all' ? true : (filt.state === 'rejected' ? (f.state === 'rejected' || f.state === 'ignored') : f.state === filt.state);
}

function _matches(f) {
  if (!filt.q.trim()) return true;
  const q = _fold(filt.q.trim());
  const s = state.session, u = s && s.units[f.unit];
  const texts = [f.quote, f.suggestion, f.edited, f.reason];
  if (u && u.tgtPara !== null && u.tgtPara !== undefined) texts.push(s.tgt.paras[u.tgtPara].text);
  if (u && u.srcPara !== null && u.srcPara !== undefined) texts.push(s.src.paras[u.srcPara].text);
  return texts.some(t => _fold(t).includes(q));
}

export function visibleFindings() {
  return state.findings.filter(f =>
    (filt.module === 'all' || f.module === filt.module) &&
    (filt.sev === 'all' || f.sev === filt.sev) && _inState(f) && _matches(f)
  ).sort((a, b) => (a.unit - b.unit) || ((a.start == null ? 1e9 : a.start) - (b.start == null ? 1e9 : b.start)));
}

/** Module as a row of buttons with counts; state and severity as two labelled lists. */
function renderFilters() {
  const box = $('#rv-bubbles .cx-fl');
  if (!box) return;
  clear(box);
  const all = state.findings;
  const base = all.filter(f => _inState(f) && _matches(f));
  if (filt.module !== 'all' && !base.some(f => f.module === filt.module)) filt.module = 'all';
  const baseMod = base.filter(f => filt.module === 'all' || f.module === filt.module);
  if (filt.sev !== 'all' && !baseMod.some(f => f.sev === filt.sev)) filt.sev = 'all';
  const n = (pred) => all.filter(pred).length;
  const mods = el('div.seg2#cx-mods', { role: 'group', 'aria-label': 'M\u00f3dulo' },
    el('button' + (filt.module === 'all' ? '.on' : ''), { 'data-mod': 'all', onclick: () => { filt.module = 'all'; renderAll(); } }, 'Todos', el('span.n', String(base.length))),
    MODULES.filter(m => base.some(f => f.module === m.id)).map(m =>
      el('button' + (filt.module === m.id ? '.on' : ''), { 'data-mod': m.id, title: m.label, onclick: () => { filt.module = m.id; renderAll(); } },
        m.short, el('span.n', String(base.filter(f => f.module === m.id).length)))));
  const sel = (key, label, options, title) => {
    const s = el('select.fsel', { 'data-filter': key, title, onchange: (e) => { filt[key] = e.target.value; renderAll(); } },
      options.map(([v, t]) => el('option', { value: v }, t)));
    s.value = filt[key];
    return el('label.ffield', el('span', label), s);
  };
  box.appendChild(mods);
  box.appendChild(sel('state', 'Estado', [
    ['open', 'Por revisar (' + n(f => f.state === 'open') + ')'],
    ['accepted', 'Aceptados (' + n(f => f.state === 'accepted') + ')'],
    ['rejected', 'Rechazados o ignorados (' + n(f => f.state === 'rejected' || f.state === 'ignored') + ')'],
    ['discarded', 'Descartados por el Verificador (' + n(f => f.state === 'discarded') + ')'],
    ['all', 'Todos (' + all.length + ')']], 'Qu\u00e9 hallazgos ver seg\u00fan lo que usted ya decidi\u00f3'));
  box.appendChild(sel('sev', 'Gravedad', [['all', 'Todas (' + baseMod.length + ')']].concat(
    ['CRI', 'MAY', 'MEN', 'SUG'].filter(s => baseMod.some(f => f.sev === s)).map(s => [s, SEV_LABELS[s] + ' (' + baseMod.filter(f => f.sev === s).length + ')'])),
    'Cr\u00edtica: cambia el sentido. Mayor: error claro. Menor: detalle. Sugerencia: mejora opcional.'));
  for (const b of document.querySelectorAll('#cx-mode button')) b.classList.toggle('on', b.dataset.mode === mode);
}

// ------------------------------------------------------------------ body: rows or sheets

function renderBody() {
  if (!state.session || state.view !== 'correct') return;
  $('#cx-list').classList.toggle('hidden', mode !== 'rows');
  $('#cx-doc').classList.toggle('hidden', mode !== 'doc');
  if (mode === 'rows') renderRows(); else renderPanes();
  renderKeys();
}

function renderKeys() {
  const box = $('#cx-keys');
  if (!box) return;
  const k = (key, text) => el('span', el('kbd', key), ' ' + text);
  const acc = state.findings.filter(f => f.state === 'accepted').length;
  const open = state.findings.filter(f => f.state === 'open').length;
  box.replaceChildren(...[k('J', 'siguiente'), k('K', 'anterior'), k('A', 'aceptar'), k('R', 'rechazar'), k('E', 'editar'),
    mode === 'doc' ? k('\u2190 \u2192', 'oraciones') : null,
    el('span.grow'), el('span', acc + (acc === 1 ? ' aceptado' : ' aceptados') + ' \u00b7 ' + open + ' por revisar')].filter(Boolean));
}

function _unitParas(u) {
  const s = state.session;
  return {
    src: u.srcPara !== null && u.srcPara !== undefined ? s.src.paras[u.srcPara] : null,
    tgt: u.tgtPara !== null && u.tgtPara !== undefined ? s.tgt.paras[u.tgtPara] : null
  };
}

function _gapsOf(list) {
  return list.filter(f => !(f.start !== null && f.start !== undefined && f.end > f.start) && (f.cat === 'OMI' || !f.quote));
}

function renderRows() {
  const host = $('#rv-findings');
  const s = state.session;
  $('#cx-src-title').textContent = 'ORIGINAL \u00b7 ' + (s.srcLang === 'fr' ? 'FR' : 'EN');
  const keep = host.scrollTop;
  clear(host);
  const list = visibleFindings();
  if (!list.length) {
    host.appendChild(el('div.empty',
      state.findings.length ? 'No hay hallazgos con estos filtros.' : 'Todav\u00eda no hay hallazgos.',
      state.findings.length ? null : el('div', { style: { marginTop: '10px' } }, el('button.btn.primary', { onclick: () => emit('goto', 'review') }, 'Ir a Revisar'))));
    clearPaint();
    return;
  }
  const byUnit = new Map();
  for (const f of list) {
    if (!byUnit.has(f.unit)) byUnit.set(f.unit, []);
    byUnit.get(f.unit).push(f);
  }
  let shown = 0;
  for (const [ui, fs] of byUnit) {
    if (shown++ >= MAX_ROWS) break;
    const u = s.units[ui];
    if (!u) continue;
    const ps = _unitParas(u);
    const anchored = fs.filter(f => f.start !== null && f.start !== undefined && f.end > f.start);
    const gaps = _gapsOf(fs);
    const has = fs.some(f => f.id === selected);
    const srcCell = el('div.cx-src', ps.src ? renderPara(ps.src, {}) : el('span.muted', 'Sin texto en el original'));
    const tgtCell = el('div.cx-tgt', ps.tgt
      ? renderPara(ps.tgt, { decorate: () => _flatten(anchored, selected), gaps: (p) => gaps.map(f => ({ at: p.text.length, label: '+ ' + (CAT_LABELS[f.cat] || f.cat).toLowerCase(), title: f.reason })) })
      : el('span.muted', 'Sin texto en la traducci\u00f3n'));
    const badges = el('div.cx-badges', fs.map(f => el('button.cx-badge.' + f.sev + (f.id === selected ? '.cur' : '') + (f.state !== 'open' ? '.done' : ''),
      { 'data-id': f.id, title: (moduleById(f.module) || { label: f.module }).label + ': ' + (f.reason || '') },
      el('b', SEV_LABELS[f.sev] || f.sev), el('span', (moduleById(f.module) || { short: f.module }).short))));
    host.appendChild(el('div.cx-row' + (has ? '.sel' : ''), { 'data-unit': u.idx },
      el('span.cx-n', String(u.n)), srcCell, tgtCell, badges));
  }
  if (byUnit.size > MAX_ROWS) host.appendChild(el('div.empty', 'Se muestran ' + MAX_ROWS + ' de ' + byUnit.size + ' segmentos: use los filtros, la b\u00fasqueda o la tabla.'));
  host.scrollTop = keep;
  const f = state.findings.find(x => x.id === selected);
  if (f) _paintRow(f, false); else clearPaint();
}

/** Marks inside a row: the sentence of the finding and its pair (soft yellow) and the exact text. */
function _paintRow(f, scroll) {
  const s = state.session;
  const row = document.querySelector('#rv-findings .cx-row[data-unit="' + f.unit + '"]');
  clearPaint();
  if (!row) return;
  const pl = findingPlace(s, f);
  const tEl = row.querySelector('.cx-tgt .p'), sEl = row.querySelector('.cx-src .p');
  const seg = [];
  const add = (side, elx, pid, idxs) => {
    if (!elx || pid === null || pid === undefined) return;
    const spans = sentencesOf(s, side, pid);
    for (const i of idxs) if (spans[i]) seg.push(rangeOf(elx, spans[i].start, spans[i].end));
  };
  if (pl) {
    if (pl.tgtIndex !== null && pl.tgtIndex >= 0) {
      add('tgt', tEl, pl.tgtPid, [pl.tgtIndex]);
      const peer = sentencePeers(s, 'tgt', pl.tgtPid, pl.tgtIndex);
      if (peer) add('src', sEl, peer.pid, peer.list);
    } else if (pl.srcIndex !== null && pl.srcIndex >= 0) {
      add('src', sEl, pl.srcPid, [pl.srcIndex]);
      const peer = sentencePeers(s, 'src', pl.srcPid, pl.srcIndex);
      if (peer) add('tgt', tEl, peer.pid, peer.list);
    }
  }
  paint('um-seg', seg);
  if (tEl && f.start !== null && f.start !== undefined && f.end > f.start) paint('um-focus', [rangeOf(tEl, f.start, f.end)], 1);
  if (scroll) row.scrollIntoView({ block: 'nearest' });
}

/** A click in the rows: a badge or a mark chooses that finding; elsewhere in a row, a finding of the
 *  clicked sentence (repeated clicks go through them) or the first of the row. */
function onRowsClick(ev) {
  const badge = ev.target.closest('button.cx-badge');
  if (badge) { select(badge.dataset.id, { fromRow: true }); return; }
  const row = ev.target.closest('.cx-row');
  if (!row) return;
  const s = state.session;
  const unit = +row.dataset.unit;
  const inRow = visibleFindings().filter(f => f.unit === unit);
  let ids = [];
  const m = ev.target.closest('mark[data-fids]');
  if (m) ids = m.dataset.fids.split(',');
  else {
    const tEl = ev.target.closest('.cx-tgt .p');
    const u = s.units[unit];
    if (tEl && u && u.tgtPara !== null && u.tgtPara !== undefined) {
      const off = offsetAt(ev, tEl);
      if (off !== null) {
        const spans = sentencesOf(s, 'tgt', u.tgtPara);
        const sp = spans[sentenceAt(spans, off)];
        if (sp) ids = inRow.filter(f => f.start !== null && f.start !== undefined && f.start < sp.end && (f.end || f.start) >= sp.start).map(f => f.id);
      }
    }
    if (!ids.length) ids = inRow.map(f => f.id);
  }
  if (!ids.length) return;
  const i = ids.indexOf(selected);
  select(ids[(i + 1) % ids.length], { fromRow: true });
}

function renderPanes() {
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

/** Findings of one sentence of the translation (to reveal them when it is clicked in a sheet). */
function _findingsInSentence(pid, index) {
  const s = state.session;
  const sp = sentencesOf(s, 'tgt', pid)[index];
  const list = visibleFindings().filter(f => { const u = s.units[f.unit]; return u && u.tgtPara === pid; });
  if (!sp) return list;
  return list.filter(f => f.start === null || f.start === undefined ? false : (f.start < sp.end && (f.end || f.start) >= sp.start));
}

/** A click in a sheet: the sentence and its pair are marked (the other sheet follows) and, as in
 *  Final Check, a finding of that sentence is chosen (repeated clicks go through them). */
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

// ------------------------------------------------------------------ selection and inspector

/** Chooses a finding: its row (or both sheets) and the inspector. */
export function select(id, opts) {
  const o = opts || {};
  selected = id;
  const f = state.findings.find(x => x.id === id);
  if (mode === 'rows') {
    for (const r of document.querySelectorAll('#rv-findings .cx-row')) r.classList.toggle('sel', !!f && +r.dataset.unit === f.unit);
    for (const b of document.querySelectorAll('#rv-findings .cx-badge')) b.classList.toggle('cur', b.dataset.id === id);
    for (const m of document.querySelectorAll('#rv-findings mark[data-fids]')) m.classList.toggle('cur', m.dataset.fids.split(',').includes(id));
    if (f) _paintRow(f, !o.fromRow);
  } else {
    for (const m of panes.tgt.querySelectorAll('mark.cur')) m.classList.remove('cur');
    for (const m of panes.tgt.querySelectorAll('mark[data-fids]')) if (m.dataset.fids.split(',').includes(id)) m.classList.add('cur');
    if (f) focusFinding(f, !!o.fromPane);
  }
  renderInspector();
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

function _placeLabel(f) {
  const pl = state.session ? findingPlace(state.session, f) : null;
  return pl ? pl.label : '';
}

function _proposal(f) { return (f.edited !== undefined && f.edited !== null) ? f.edited : (f.suggestion || ''); }

/** Whether "Aceptar" can apply this text: a replacement needs the quote located in the text; an empty
 *  proposal only removes an addition. */
function _canAccept(f, text) {
  if (f.state !== 'open') return false;
  if (!text && !(f.cat === 'ADD' && f.quote)) return false;
  return (f.start !== null && f.start !== undefined) || !f.quote;
}

function renderInspector() {
  const box = $('#cx-insp');
  if (!box || !state.session) return;
  clear(box);
  const list = visibleFindings();
  const f = state.findings.find(x => x.id === selected);
  if (!f) {
    box.appendChild(el('div.ci-empty',
      el('h3', list.length ? 'Elija un hallazgo' : 'Nada que corregir aqu\u00ed', helpBtn('inspector')),
      el('p.muted', list.length ? 'Pulse una fila, o use J y K para pasar de un hallazgo a otro.' : 'Cambie los filtros o vuelva a Revisar.'),
      list.length ? el('button.btn.primary', { onclick: () => select(list[0].id) }, 'Empezar por el primero', icon('arrow', 16)) : null));
    return;
  }
  const i = list.findIndex(x => x.id === f.id);
  const mod = moduleById(f.module);
  const ta = el('textarea.inp.ci-sug#cx-sug', { rows: 3, disabled: f.state !== 'open' ? true : null, 'aria-label': 'Propuesta',
    onkeydown: (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); accept(f); }
      else if (e.key === 'Escape') { e.preventDefault(); ta.blur(); }
    } });
  ta.value = _proposal(f);
  const acc = el('button.btn.primary.big#cx-accept', { onclick: () => accept(f) });
  const paintAcc = () => {
    const v = ta.value;
    acc.disabled = !_canAccept(f, v);
    acc.replaceChildren(icon('check', 16), (!v && f.cat === 'ADD' && f.quote) ? 'Suprimir' : 'Aceptar', el('kbd', 'A'));
    acc.title = acc.disabled ? (f.start == null && f.quote ? 'La cita no se encontr\u00f3 en el texto: corr\u00edjalo en Word' : 'Escriba la correcci\u00f3n') : 'Aceptar (Ctrl+Intro desde la propuesta)';
  };
  ta.addEventListener('input', paintAcc);
  paintAcc();
  box.appendChild(el('div.ci-head',
    el('span.ci-count', i >= 0 ? 'HALLAZGO ' + (i + 1) + ' DE ' + list.length : 'HALLAZGO'),
    el('span.grow'),
    el('button.btn.icon', { 'aria-label': 'Anterior (K)', title: 'Anterior (K)', onclick: () => step(-1) }, icon('left', 16)),
    el('button.btn.icon', { 'aria-label': 'Siguiente (J)', title: 'Siguiente (J)', onclick: () => step(1) }, icon('right', 16)),
    helpBtn('inspector')));
  box.appendChild(el('div.ci-meta',
    el('span.sev.' + f.sev, SEV_LABELS[f.sev] || f.sev),
    el('b', mod ? mod.label : f.module),
    el('span.muted', '\u00b7 \u00a7' + _placeLabel(f)),
    f.state !== 'open' ? el('span.state.' + f.state, STATE_LABELS[f.state]) : null,
    f.verified === 'ok' || f.verified === 'edit' ? el('span.state.accepted', 'Verificado') : null));
  box.appendChild(el('div.ci-lbl', f.quote ? 'Dice' : (CAT_LABELS[f.cat] || 'Hallazgo')));
  box.appendChild(el('div.ci-quote' + (f.quote ? '' : '.miss'), f.quote || 'Falta algo en la traducci\u00f3n'));
  box.appendChild(el('label.ci-lbl', { for: 'cx-sug' }, f.state === 'open' ? 'Propuesta (puede editarla)' : 'Propuesta'));
  box.appendChild(ta);
  if (f.reason) box.appendChild(el('p.ci-why', f.reason));
  if (f.verifierReason) box.appendChild(el('p.ci-why.muted', 'Verificador: ' + f.verifierReason));
  if (f.state === 'open') {
    box.appendChild(el('div.ci-acts', acc,
      el('button.btn.big#cx-reject', { onclick: () => decide(f, 'rejected') }, icon('x', 16), 'Rechazar', el('kbd', 'R'))));
    box.appendChild(el('div.ci-acts2',
      el('button.btn.link', { title: 'No es un error, pero no quiero que vuelva a salir como rechazado', onclick: () => decide(f, 'ignored') }, 'Ignorar'),
      el('button.btn.link', { onclick: () => { ta.focus(); ta.select(); } }, 'Editar la propuesta (E)')));
  } else {
    box.appendChild(el('div.ci-acts', el('button.btn', { onclick: () => updateFinding(f.id, { state: 'open' }) }, 'Deshacer: volver a pendiente')));
  }
  box.appendChild(el('div.ci-src',
    (f.source === 'local' || f.source === 'rule' ? 'Sin IA' : f.source === 'external' ? 'IA externa' : 'Modelo: ' + (f.model || 'IA') + (f.role === 'deep' ? ' (a fondo)' : f.role === 'cache' ? ' (cach\u00e9)' : '')) +
      (f.unanchored ? ' \u00b7 cita no localizada en el texto' : '')));
}

function step(dir) {
  const list = visibleFindings();
  if (!list.length) return;
  const i = list.findIndex(f => f.id === selected);
  const next = dir > 0 ? (list[i + 1] || list[0]) : (list[i - 1] || list[list.length - 1]);
  select(next.id);
}

function accept(f) {
  const ta = $('#cx-sug');
  const v = ta ? ta.value : _proposal(f);
  if (!_canAccept(f, v)) return;
  const patch = { state: 'accepted' };
  if (v !== (f.suggestion || '')) patch.edited = v;
  decide(f, 'accepted', patch);
}

/** Records a decision and moves to the next finding of the list as it was before the decision. */
function decide(f, newState, patch) {
  const before = visibleFindings();
  const i = before.findIndex(x => x.id === f.id);
  updateFinding(f.id, patch || { state: newState });
  const after = new Set(visibleFindings().map(x => x.id));
  const next = before.slice(i + 1).find(x => after.has(x.id)) || before.slice(0, Math.max(0, i)).reverse().find(x => after.has(x.id)) ||
    (after.has(f.id) ? f : null);
  if (next) select(next.id); else { selected = null; renderAll(); }
}

function onKey(e) {
  if (state.view !== 'correct' || e.ctrlKey || e.altKey || e.metaKey) return;
  if (e.target.closest && e.target.closest('input, textarea, select, .modal')) return;
  const list = visibleFindings();
  if (mode === 'doc' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.shiftKey) { e.preventDefault(); nav.step(e.key === 'ArrowRight' ? 1 : -1); return; }
  if (!list.length) return;
  const f = state.findings.find(x => x.id === selected);
  const k = e.key.toLowerCase();
  if (k === 'j') { e.preventDefault(); step(1); }
  else if (k === 'k') { e.preventDefault(); step(-1); }
  else if (f && k === 'a' && f.state === 'open') { e.preventDefault(); accept(f); }
  else if (f && k === 'r' && f.state === 'open') { e.preventDefault(); decide(f, 'rejected'); }
  else if (f && k === 'e' && f.state === 'open') { e.preventDefault(); const ta = $('#cx-sug'); if (ta) { ta.focus(); ta.select(); } }
}

// ------------------------------------------------------------------ table window, feedback, reset

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

/** "Hallazgos para valorar (Excel)": real or masked text, all findings or the ones shown in Corregir. */
export async function feedbackDialog() {
  if (!state.session) return;
  const masked = el('input', { type: 'radio', name: 'fbtext', value: 'masked', checked: true });
  const real = el('input', { type: 'radio', name: 'fbtext', value: 'real' });
  const allF = el('input', { type: 'radio', name: 'fbwhich', value: 'all', checked: true });
  const vis = el('input', { type: 'radio', name: 'fbwhich', value: 'visible' });
  const r = await modal({ title: 'Hallazgos para valorar (Excel)', help: helpBtn('feedback'), width: '600px', body: el('div',
    el('p', 'Un Excel con una fila por hallazgo, su contexto y tres columnas vac\u00edas para usted: ', el('b', 'Su valoraci\u00f3n'), ' (lista desplegable), ',
      el('b', 'Gravedad correcta'), ' y ', el('b', 'Comentario'), '. Rell\u00e9nelo y env\u00edelo para ajustar los m\u00f3dulos.'),
    el('label.lbl', 'Texto'),
    el('div', el('label.row', masked, ' Enmascarado (recomendado si va a compartir el archivo: sin datos reales)')),
    el('div', el('label.row', real, ' Real')),
    el('label.lbl', 'Hallazgos'),
    el('div', el('label.row', allF, ' Todos (' + state.findings.length + ')')),
    el('div', el('label.row', vis, ' Solo los que se ven en Corregir con los filtros actuales (' + visibleFindings().length + ')'))),
    buttons: [{ label: 'Cancelar', value: null }, { label: 'Descargar Excel', kind: 'primary', value: 'ok' }] });
  if (r !== 'ok') return;
  const ids = vis.checked ? new Set(visibleFindings().map(f => f.id)) : null;
  try {
    const n = await exportFeedbackXlsx({ masked: masked.checked, filter: ids ? (f) => ids.has(f.id) : null,
      segText: (f, isMasked) => {
        if (isMasked) return null;   // the masked texts are whole paragraphs (tags keep their positions there)
        const pl = findingPlace(state.session, f);
        return pl ? { label: pl.label, src: pl.src, tgt: pl.tgt } : null;
      } });
    toast(n + ' hallazgos exportados para valorar.', 'ok');
  } catch (e) { console.error(e); toast('No se pudo exportar: ' + e.message, 'err', 8000); }
}

/** "Vaciar": delete findings (all or the pending ones) and, if wanted, the stored AI answers too, so
 *  the next run really reviews again instead of repeating what is in the cache. */
async function resetFindings() {
  if (!state.project) return;
  const all = el('input', { type: 'radio', name: 'rsWhich', value: 'all', checked: true });
  const open = el('input', { type: 'radio', name: 'rsWhich', value: 'open' });
  const nOpen = state.findings.filter(f => f.state === 'open').length;
  const r = await modal({ title: 'Vaciar los hallazgos', help: helpBtn('findings-reset'), width: '560px', body: el('div',
    el('div', el('label.row', all, ' Todos (' + state.findings.length + '), tambi\u00e9n los aceptados y rechazados')),
    el('div', el('label.row', open, ' Solo los pendientes (' + nOpen + ')')),
    el('p.info', { style: { marginTop: '8px' } }, 'Solo los hallazgos de este proyecto: los documentos y las entidades no se tocan. Las respuestas guardadas de la IA tampoco: al revisar de nuevo, el plan dice cu\u00e1ntos p\u00e1rrafos ya estaban revisados y deja pedir que la IA los lea otra vez.')),
    buttons: [{ label: 'Cancelar', value: null }, { label: 'Vaciar', kind: 'danger', value: 'ok' }] });
  if (r !== 'ok') return;
  state.findings = open.checked ? state.findings.filter(f => f.state !== 'open') : [];
  selected = null;
  resetReviewState();
  emit('findings');
  saveProjectSoon();
  nav.clear();
  clearPaint();
  toast('Hallazgos borrados.', 'ok');
}
