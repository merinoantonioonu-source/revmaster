/**
 * findings-window.js - The findings as a table in a window of their own, emulating the
 * "Transformations" window of COMeT Final Check (behaviour copied, code new):
 *   - a same-origin window opened with window.open('', name, 'width=1400,height=820,...'); its DOM is
 *     built from here (nodes are adopted by the new document) and its rows call the main window
 *     directly: clicking a text cell shows that finding in the main sheets (the window keeps focus);
 *   - sticky header: title, counter, column switch, bulk buttons, Excel export; then the filters;
 *   - one row per finding: the decision cell on the left (severity, module, buttons), then
 *     Original / Traduccion / Propuesta / Motivo at sentence level, what changes in bold
 *     (red = what is wrong, green = the proposal);
 *   - double-click on the proposal edits it in a row underneath (Ctrl+Enter saves, Esc cancels);
 *   - J/K or the arrows move between rows, A accepts, R rejects, E edits; Ctrl+wheel zooms the text.
 * The window keeps no data of its own: the main window redraws it whenever a finding changes.
 */

import { el } from '../util/dom.js';
import { state } from '../state.js';
import { MODULES, moduleById } from '../review/module-list.js';
import { CAT_LABELS } from '../review/prompts.js';
import { SEV_LABELS } from '../rules/rules.js';
import { STATE_LABELS } from '../review/findings.js';
import { LOCAL_SUBS } from '../review/local-checks.js';
import { findingPlace } from './nav.js';

const NAME = 'umbra-findings';
const COLS_KEY = 'umbra_tbl_cols';
const ZOOM_KEY = 'umbra_tbl_zoom';
const COLS = [['src', 'Original'], ['tgt', 'Traducci\u00f3n'], ['fix', 'Propuesta'], ['why', 'Motivo']];

let W = null;
let api = null;
const ws = { filt: { state: 'open', module: 'all', sev: 'all' }, q: '', sel: null, editing: null, pending: false, cols: null, searchFocus: false };

const CSS = `
html.umbra-dark { filter: invert(0.9) hue-rotate(180deg); background: #fff; }
body { margin: 0; font: 12px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; color: #1f2937; background: #f4f5f7; }
header { position: sticky; top: 0; z-index: 5; background: #fff; box-shadow: 0 1px 3px rgba(15,23,42,.08); padding: 9px 18px 10px; }
.hrow { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; }
.hrow + .hrow { margin-top: 8px; }
h1 { font-size: 14px; font-weight: 700; margin: 0; color: #111827; }
.count { font-size: 11px; font-weight: 600; color: #6b7280; background: #f3f4f6; border-radius: 999px; padding: 2px 9px; }
.count.on { color: #166534; background: #dcfce7; }
.grow { flex: 1; }
button { font: inherit; font-size: 11px; font-weight: 600; border: 1px solid #d1d5db; background: #fff; color: #374151; border-radius: 6px; padding: 3px 10px; cursor: pointer; }
button:hover:not([disabled]) { background: #f9fafb; }
button[disabled] { opacity: .45; cursor: default; }
button.ok { color: #15803d; border-color: #86efac; }
button.no { color: #b91c1c; border-color: #fca5a5; }
button.edit { color: #6d28d9; border-color: #c4b5fd; }
button.xl { color: #6d28d9; border-color: #c4b5fd; }
.switch { display: inline-flex; }
.switch button { border-radius: 0; margin-left: -1px; }
.switch button:first-child { border-radius: 6px 0 0 6px; margin-left: 0; }
.switch button:last-child { border-radius: 0 6px 6px 0; }
.switch button.on { background: #e0f2fe; color: #075985; border-color: #7dd3fc; position: relative; }
label.f { display: inline-flex; gap: 5px; align-items: center; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: #6b7280; }
select, input[type=search] { font: inherit; font-size: 12px; border: 1px solid #d1d5db; border-radius: 6px; padding: 3px 6px; background: #fff; color: #1f2937; text-transform: none; letter-spacing: 0; font-weight: 400; }
input[type=search] { width: 220px; }
.hint { font-size: 10px; color: #6b7280; }
kbd { border: 1px solid #d1d5db; border-bottom-width: 2px; border-radius: 4px; padding: 0 4px; font: 600 10px Consolas, monospace; background: #f9fafb; }
main { padding: 14px 18px 40px; zoom: var(--tf-text, 1); }
.group { background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; box-shadow: 0 1px 2px rgba(15,23,42,.04); overflow: hidden; }
table { width: 100%; border-collapse: collapse; }
th { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: #9ca3af; text-align: left; padding: 6px 12px 4px; background: #f9fafb; }
td { padding: 8px 12px; border-top: 1px solid #eef0f3; vertical-align: top; font-size: 12px; line-height: 1.65; }
td.chk { width: 200px; }
td.n { width: 46px; color: #6b7280; font-weight: 700; white-space: nowrap; cursor: pointer; }
td.txt { cursor: pointer; word-break: break-word; color: #1f2937; }
td.txt.src { color: #4b5563; background: #fafbfc; }
td.why { color: #4b5563; font-size: 11px; line-height: 1.5; cursor: pointer; }
tr.cur td { background: #fffbeb; }
tr.cur td.txt.src { background: #fef6d8; }
tr.cur td.chk { box-shadow: inset 3px 0 0 #f59e0b; }
tr.done td.chk { box-shadow: inset 3px 0 0 #16a34a; }
tr.off td.txt, tr.off td.why { opacity: .55; }
.del { color: #dc2626; font-weight: 800; }
.ins { color: #16a34a; font-weight: 800; }
.gap { color: #16a34a; font-weight: 800; }
.sev { display: inline-block; color: #fff; border-radius: 5px; padding: 0 6px; font-size: 10px; font-weight: 800; }
.sev.CRI { background: #dc2626; } .sev.MAY { background: #d97706; } .sev.MEN { background: #2563eb; } .sev.SUG { background: #6b7280; }
.tag { display: inline-block; background: #eef2f7; border-radius: 5px; padding: 0 6px; font-size: 10px; font-weight: 700; color: #374151; margin-left: 4px; }
.cat { font-size: 11px; color: #6b7280; margin-top: 3px; }
.stl { display: inline-block; margin-top: 4px; font-size: 10px; font-weight: 800; color: #166534; background: #dcfce7; border-radius: 5px; padding: 0 6px; }
.stl.off { color: #4b5563; background: #f3f4f6; }
.btns { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.origin { font-size: 10px; color: #9ca3af; margin-top: 4px; }
.verif { font-size: 11px; color: #166534; margin-top: 3px; }
.empty { padding: 40px; text-align: center; color: #6b7280; }
tr.editrow td { background: #f5f3ff; border-top: 0; }
tr.editrow textarea { width: 100%; box-sizing: border-box; font: inherit; font-size: 13px; border: 1px solid #c4b5fd; border-radius: 6px; padding: 6px 8px; min-height: 64px; }
`;

function _load(key, def) { try { const v = W.localStorage.getItem(key); return v ? JSON.parse(v) : def; } catch (_) { return def; } }
function _save(key, v) { try { W.localStorage.setItem(key, JSON.stringify(v)); } catch (_) {} }

/** Opens (or brings forward) the window. a = { filt, select(id), setState(f, state), edit(f, text),
 *  exportFeedback(), selected() }. -> false when the browser blocked the window. */
export function openFindingsWindow(a) {
  api = a;
  if (a.filt) Object.assign(ws.filt, a.filt);
  ws.sel = a.selected ? a.selected() : null;
  if (!W || W.closed || !W.__umbra) {
    W = window.open('', NAME, 'width=1400,height=820,resizable=yes,scrollbars=yes');
    if (!W) return false;
    const d = W.document;
    d.open();
    d.write('<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>UMBRA \u2014 Hallazgos</title><style>' + CSS + '</style></head><body></body></html>');
    d.close();
    W.__umbra = true;
    ws.cols = _load(COLS_KEY, { src: true, tgt: true, fix: true, why: true });
    const z = _load(ZOOM_KEY, 1);
    d.documentElement.style.setProperty('--tf-text', z);
    W.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const cur = parseFloat(d.documentElement.style.getPropertyValue('--tf-text')) || 1;
      const nz = Math.max(0.7, Math.min(2.5, Math.round((cur + (e.deltaY < 0 ? 0.1 : -0.1)) * 10) / 10));
      d.documentElement.style.setProperty('--tf-text', nz);
      _save(ZOOM_KEY, nz);
    }, { passive: false });
    W.addEventListener('keydown', _onKey);
    W.addEventListener('beforeunload', () => { W = null; });
    window.addEventListener('beforeunload', () => { try { if (W && !W.closed) W.close(); } catch (_) {} });
  }
  W.document.documentElement.classList.toggle('umbra-dark', document.documentElement.classList.contains('umbra-dark'));
  _render();
  try { W.focus(); } catch (_) {}
  return true;
}

export function syncFindingsWindow() { if (W && !W.closed) _render(); }

/** The main window selected a finding: mark its row. */
export function findingsWindowSelect(id) {
  if (!W || W.closed) return;
  ws.sel = id;
  for (const tr of W.document.querySelectorAll('tr[data-id]')) tr.classList.toggle('cur', tr.dataset.id === id);
  const tr = W.document.querySelector('tr[data-id="' + id + '"]');
  if (tr) tr.scrollIntoView({ block: 'nearest' });
}

// ------------------------------------------------------------------ data

function _inState(f) {
  const s = ws.filt.state;
  return s === 'all' ? true : (s === 'rejected' ? (f.state === 'rejected' || f.state === 'ignored') : f.state === s);
}

function _visible() {
  const q = ws.q.trim().toLowerCase();
  return state.findings.filter(f => _inState(f) &&
    (ws.filt.module === 'all' || f.module === ws.filt.module) &&
    (ws.filt.sev === 'all' || f.sev === ws.filt.sev) &&
    (!q || [f.quote, f.suggestion, f.edited, f.reason].join(' ').toLowerCase().includes(q)))
    .sort((a, b) => (a.unit - b.unit) || ((a.start == null ? 1e9 : a.start) - (b.start == null ? 1e9 : b.start)));
}

function _sug(f) { return (f.edited !== undefined && f.edited !== null) ? f.edited : f.suggestion; }

function _origin(f) {
  if (f.source === 'local') return 'Sin IA';
  if (f.source === 'rule') return 'Regla';
  if (f.source === 'external') return 'IA externa';
  return (f.model || 'IA') + (f.role === 'deep' ? ' \u00b7 a fondo' : f.role === 'cache' ? ' \u00b7 cach\u00e9' : '');
}

/** The sentence with the quoted part in red (or the proposal in green). */
function _textCell(text, off, f, repl) {
  const has = f.start !== null && f.start !== undefined && f.end >= f.start && f.start >= off && f.end <= off + text.length;
  if (!has) {
    if (repl === undefined) return [text];
    return repl ? [text + ' ', el('span.gap', repl)] : [text];
  }
  const a = f.start - off, b = f.end - off;
  const mid = repl === undefined ? el('span.del', text.slice(a, b)) : (repl ? el('span.ins', repl) : null);
  return [text.slice(0, a), mid, text.slice(b)];
}

// ------------------------------------------------------------------ drawing

function _render() {
  if (!W || W.closed) return;
  const d = W.document;
  if (ws.editing && d.activeElement && d.activeElement.closest && d.activeElement.closest('tr.editrow')) { ws.pending = true; return; }
  ws.pending = false;
  const y = W.scrollY;
  const body = d.body;
  body.textContent = '';
  const s = state.session;
  if (!s) { body.appendChild(el('div.empty', 'No hay ning\u00fan proyecto abierto.')); return; }
  const all = state.findings;
  const list = _visible();
  const open = all.filter(f => f.state === 'open').length;
  const openVisible = list.filter(f => f.state === 'open');

  const sel = (key, label, options) => {
    const x = el('select', { onchange: (e) => { ws.filt[key] = e.target.value; _render(); } }, options.map(([v, t]) => el('option', { value: v }, t)));
    x.value = ws.filt[key];
    if (x.value !== ws.filt[key]) { ws.filt[key] = 'all'; x.value = 'all'; }
    return el('label.f', label, x);
  };
  const base = all.filter(_inState);
  const colSwitch = el('div.switch', { title: 'Columnas que se ven' }, COLS.map(([k, t]) => el('button' + (ws.cols[k] ? '.on' : ''), {
    onclick: () => {
      if (ws.cols[k] && Object.values(ws.cols).filter(Boolean).length === 1) return;   // at least one stays
      ws.cols[k] = !ws.cols[k]; _save(COLS_KEY, ws.cols); _render();
    } }, t)));
  const search = el('input', { type: 'search', placeholder: 'Buscar en citas, propuestas y motivos\u2026', value: ws.q });
  let tmr = null;
  search.addEventListener('input', () => { clearTimeout(tmr); tmr = setTimeout(() => { ws.q = search.value; ws.searchFocus = true; _render(); }, 250); });
  const header = el('header',
    el('div.hrow',
      el('h1', 'Hallazgos'),
      el('span.count' + (open ? '' : '.on'), list.length + ' de ' + all.length + ' \u00b7 ' + open + ' pendientes'),
      colSwitch,
      el('span.grow'),
      el('button.ok', { disabled: openVisible.some(f => _sug(f)) ? null : true, title: 'Acepta los hallazgos visibles que traen propuesta',
        onclick: () => { const xs = openVisible.filter(f => _sug(f)); if (xs.length && W.confirm('\u00bfAceptar ' + xs.length + ' hallazgos con propuesta?')) for (const f of xs) api.setState(f, 'accepted'); } },
        '\u2713 Aceptar visibles (' + openVisible.filter(f => _sug(f)).length + ')'),
      el('button.no', { disabled: openVisible.length ? null : true, title: 'Rechaza todos los hallazgos visibles pendientes',
        onclick: () => { if (openVisible.length && W.confirm('\u00bfRechazar ' + openVisible.length + ' hallazgos?')) for (const f of openVisible) api.setState(f, 'rejected'); } },
        '\u2715 Rechazar visibles (' + openVisible.length + ')'),
      el('button.xl', { title: 'Excel con una fila por hallazgo y columnas para su valoraci\u00f3n', onclick: () => { try { window.focus(); } catch (_) {} api.exportFeedback(); } }, '\u2b07 Excel para valorar')),
    el('div.hrow',
      sel('state', 'Estado', [['open', 'Pendientes (' + open + ')'], ['accepted', 'Aceptados (' + all.filter(f => f.state === 'accepted').length + ')'],
        ['rejected', 'Rechazados o ignorados (' + all.filter(f => f.state === 'rejected' || f.state === 'ignored').length + ')'],
        ['discarded', 'Descartados por el Verificador (' + all.filter(f => f.state === 'discarded').length + ')'], ['all', 'Todos (' + all.length + ')']]),
      sel('module', 'M\u00f3dulo', [['all', 'Todos']].concat(MODULES.filter(m => base.some(f => f.module === m.id)).map(m => [m.id, m.label + ' (' + base.filter(f => f.module === m.id).length + ')']))),
      sel('sev', 'Gravedad', [['all', 'Todas']].concat(['CRI', 'MAY', 'MEN', 'SUG'].filter(v => base.some(f => f.sev === v)).map(v => [v, SEV_LABELS[v] + ' (' + base.filter(f => f.sev === v).length + ')']))),
      search,
      el('span.grow'),
      el('span.hint', 'Clic en una fila: la muestra en UMBRA \u00b7 doble clic en la propuesta: editarla \u00b7 ', el('kbd', 'J'), '/', el('kbd', 'K'), ' moverse \u00b7 ',
        el('kbd', 'A'), ' aceptar \u00b7 ', el('kbd', 'R'), ' rechazar \u00b7 ', el('kbd', 'E'), ' editar')));
  body.appendChild(header);

  const main = el('main');
  if (!list.length) {
    main.appendChild(el('div.group', el('div.empty', all.length ? 'No hay hallazgos con estos filtros.' : 'Todav\u00eda no hay hallazgos: ejecute los m\u00f3dulos en UMBRA.')));
  } else {
    const cols = COLS.filter(([k]) => ws.cols[k]);
    const w = Math.round(84 / cols.length) + '%';
    const head = el('tr', el('th', 'Decisi\u00f3n'), el('th', { title: 'P\u00e1rrafo.oraci\u00f3n' }, '\u00a7'), cols.map(([k, t]) => el('th', { style: { width: k === 'why' ? '' : w } }, t)));
    const table = el('table', el('thead', head), el('tbody', list.slice(0, 1500).map(f => _row(f, s))));
    main.appendChild(el('div.group', table));
    if (list.length > 1500) main.appendChild(el('div.empty', 'Se muestran 1500 de ' + list.length + ': use los filtros.'));
  }
  body.appendChild(main);
  W.scrollTo(0, y);
  if (ws.searchFocus) {
    ws.searchFocus = false;
    search.focus();
    try { search.setSelectionRange(search.value.length, search.value.length); } catch (_) {}
  }
}

function _row(f, s) {
  const pl = findingPlace(s, f) || { label: '', src: '', tgt: '', tgtOff: 0, srcOff: 0 };
  const mod = moduleById(f.module);
  const sug = _sug(f);
  const off = f.state === 'rejected' || f.state === 'ignored' || f.state === 'discarded';
  const tr = el('tr' + (f.id === ws.sel ? '.cur' : '') + (f.state === 'accepted' ? '.done' : '') + (off ? '.off' : ''), { 'data-id': f.id });
  const btns = el('div.btns');
  if (f.state === 'open') {
    btns.appendChild(el('button.ok', { disabled: sug ? null : true, title: sug ? 'Aceptar (A)' : 'Sin propuesta: use Editar', onclick: (e) => { e.stopPropagation(); api.setState(f, 'accepted'); } }, '\u2713 Aceptar'));
    btns.appendChild(el('button.edit', { title: 'Editar la propuesta (E)', onclick: (e) => { e.stopPropagation(); _openEditor(f, tr); } }, '\u270e Editar'));
    btns.appendChild(el('button.no', { title: 'Rechazar (R)', onclick: (e) => { e.stopPropagation(); api.setState(f, 'rejected'); } }, '\u2715 Rechazar'));
    btns.appendChild(el('button', { onclick: (e) => { e.stopPropagation(); api.setState(f, 'ignored'); } }, 'Ignorar'));
  } else {
    btns.appendChild(el('button', { title: 'Volver a pendiente', onclick: (e) => { e.stopPropagation(); api.setState(f, 'open'); } }, '\u21ba Deshacer'));
  }
  const left = el('td.chk',
    el('span.sev.' + f.sev, { title: SEV_LABELS[f.sev] || f.sev }, f.sev), el('span.tag', mod ? mod.short : f.module), f.sub ? el('span.tag', LOCAL_SUBS[f.sub] || f.sub) : null,
    el('div.cat', CAT_LABELS[f.cat] || f.cat),
    f.state !== 'open' ? el('div.stl' + (off ? '.off' : ''), STATE_LABELS[f.state] || f.state) : null,
    btns);
  tr.appendChild(left);
  const go = () => {
    ws.sel = f.id;
    for (const x of W.document.querySelectorAll('tr[data-id]')) x.classList.toggle('cur', x.dataset.id === f.id);
    try { api.select(f.id); } catch (e) { console.warn(e); }
  };
  const n = el('td.n', { title: 'Mostrarlo en UMBRA' }, pl.label);
  n.addEventListener('click', go);
  tr.appendChild(n);
  const cells = {
    src: el('td.txt.src', pl.src || el('span.hint', 'Sin p\u00e1rrafo en el original.')),
    tgt: el('td.txt', pl.tgt ? _textCell(pl.tgt, pl.tgtOff, f) : el('span.hint', 'Sin p\u00e1rrafo en la traducci\u00f3n.')),
    fix: el('td.txt', { title: f.state === 'open' ? 'Doble clic para editar la propuesta' : '' },
      sug ? _textCell(pl.tgt || '', pl.tgtOff, f, sug) : el('span.hint', f.cat === 'OMI' ? 'Falta algo: v\u00e9ase el motivo.' : 'Sin propuesta.')),
    why: el('td.why', f.reason || '', f.verifierReason ? el('div.verif', 'Verificador: ' + f.verifierReason) : null, el('div.origin', _origin(f)))
  };
  for (const [k] of COLS) {
    if (!ws.cols[k]) continue;
    cells[k].addEventListener('click', go);
    cells[k].title = cells[k].title || 'Mostrarlo en UMBRA';
    tr.appendChild(cells[k]);
  }
  if (f.state === 'open') cells.fix.addEventListener('dblclick', () => _openEditor(f, tr));
  return tr;
}

function _openEditor(f, tr) {
  const d = W.document;
  const old = d.querySelector('tr.editrow');
  if (old) old.remove();
  ws.editing = f.id;
  const ta = el('textarea');
  ta.value = _sug(f) || f.quote || '';
  const close = () => { ws.editing = null; row.remove(); if (ws.pending) _render(); };
  const save = () => { const v = ta.value; ws.editing = null; row.remove(); api.edit(f, v); };
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
  });
  const span = tr.children.length;
  const row = el('tr.editrow', el('td', { colSpan: span },
    el('div.hint', 'Texto que sustituir\u00e1 a ', el('b', '\u00ab' + (f.quote || '') + '\u00bb'), ' (quedar\u00e1 aceptado):'),
    ta,
    el('div.btns', el('button.ok', { onclick: save }, 'Guardar (Ctrl+Intro)'), el('button', { onclick: close }, 'Cancelar (Esc)'))));
  tr.after(row);
  ta.focus();
  ta.select();
}

function _onKey(e) {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target.closest && e.target.closest('input, textarea, select')) return;
  const rows = Array.from(W.document.querySelectorAll('tr[data-id]'));
  if (!rows.length) return;
  const i = rows.findIndex(r => r.dataset.id === ws.sel);
  const k = e.key.toLowerCase();
  const f = i >= 0 ? state.findings.find(x => x.id === rows[i].dataset.id) : null;
  const move = (dir) => {
    const r = rows[i < 0 ? 0 : (i + dir + rows.length) % rows.length];
    ws.sel = r.dataset.id;
    for (const x of rows) x.classList.toggle('cur', x === r);
    r.scrollIntoView({ block: 'nearest' });
    try { api.select(r.dataset.id); } catch (_) {}
  };
  if (k === 'j' || e.key === 'ArrowDown') { e.preventDefault(); move(1); }
  else if (k === 'k' || e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
  else if (f && f.state === 'open' && k === 'a' && _sug(f)) { e.preventDefault(); api.setState(f, 'accepted'); }
  else if (f && f.state === 'open' && k === 'r') { e.preventDefault(); api.setState(f, 'rejected'); }
  else if (f && f.state === 'open' && k === 'e') { e.preventDefault(); _openEditor(f, rows[i]); }
}
