/**
 * settings-usage.js - Settings > Uso de IA: what the AI has cost, from the running record every AI
 * call adds to (ai/usage.js): totals for a period, bars by module, project, model and day, the price
 * table (editable, "Buscar precios" from LiteLLM's public list), notes on projects and the export to
 * Excel. Also the header's session meter (mountSessionMeter).
 *
 * Origin: COMeT settings/tabs/ai-usage-tab.js @ 04540f5 (adapted)
 *
 * The cost is approximate: tokens times the model's list price, in US dollars. Free tiers,
 * discounts and taxes are not known. The record of every computer travels with the sync file, so the
 * totals are those of all of them (the "Equipo" choice narrows them to one).
 */

import { helpBtn, helpItem } from './help.js';
import { el, clear, toast, download, fmtInt, fmtMoney } from '../util/dom.js';
import { moduleById } from '../review/module-list.js';
import * as reg from '../ai/registry.js';
import {
  readUsageRows, loadPrices, savePrices, lookupPrices, costOf, priceKey, priceFor, loadUsageNotes, saveUsageNote,
  getSessionTotals, onUsage, OTHER_MODULE, PRICE_LIST_PAGE, USAGE_PREFIX, PRICES_KEY, NOTES_KEY
} from '../ai/usage.js';
import { storage } from '../store/storage.js';

const PERIODS = [
  { id: 'today', label: 'Hoy' },
  { id: 'week', label: 'Esta semana' },
  { id: 'month', label: 'Este mes' },
  { id: 'prevmonth', label: 'Mes anterior' },
  { id: 'all', label: 'Todo' }
];

function _day(d) {
  const p = (n) => (n < 10 ? '0' : '') + n;
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
function _parseDay(s) { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, (m || 1) - 1, d || 1); }

/** [from, to] (inclusive 'YYYY-MM-DD'; null = open) of a period. */
export function periodRange(period, now) {
  const t = now || new Date();
  if (period === 'today') return [_day(t), _day(t)];
  if (period === 'week') {
    const mon = new Date(t.getFullYear(), t.getMonth(), t.getDate() - ((t.getDay() + 6) % 7));
    return [_day(mon), _day(t)];
  }
  if (period === 'month') return [_day(new Date(t.getFullYear(), t.getMonth(), 1)), _day(t)];
  if (period === 'prevmonth') {
    return [_day(new Date(t.getFullYear(), t.getMonth() - 1, 1)), _day(new Date(t.getFullYear(), t.getMonth(), 0))];
  }
  return [null, null];
}

// 12345 -> "12,3 k", 1234567 -> "1,23 M" (Spanish decimals).
function _tok(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(2).replace('.', ',') + ' M';
  if (n >= 1e4) return (n / 1e3).toFixed(1).replace('.', ',') + ' k';
  return fmtInt(n);
}
function _money(v) {
  if (v === null || v === undefined) return '\u2014';
  // Fractions of a cent with four decimals, as COMeT (a short test call costs that).
  if (v > 0 && v < 0.01) return v.toFixed(4).replace('.', ',') + ' US$';
  return fmtMoney(v);
}

function _moduleLabel(id) {
  if (id === OTHER_MODULE || id === 'test') return 'Otros (prueba de conexi\u00f3n)';
  if (!id) return 'Sin m\u00f3dulo';
  // Calls of reviewers fused before the simplification were recorded as 'fidelity+integrity': each part by
  // the module that covers it now, named once.
  const names = [];
  for (const part of String(id).split('+')) {
    const m = moduleById(part);
    const n = m ? m.label : part;
    if (!names.includes(n)) names.push(n);
  }
  return names.join(' + ');
}

function _groupBy(list, keyOf) {
  const m = new Map();
  for (const r of list) {
    const k = keyOf(r);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
}

/** Session meter for the header: "Sesion: N tokens . X US$". Returns the unsubscriber. */
export function mountSessionMeter(node) {
  const paint = (t) => {
    node.textContent = 'Sesi\u00f3n: ' + _tok(t.tokens) + ' tokens \u00b7 ' + _money(t.cost) + (t.unpriced ? ' +' : '');
    node.title = t.calls + ' llamada(s) a la IA desde que abriste UMBRA' + (t.unpriced ? ' (' + t.unpriced + ' sin precio, no sumadas)' : '') + '.';
  };
  paint(getSessionTotals());
  return onUsage((t) => paint(t));
}

/** Builds Settings > Uso de IA inside `container`. -> { refresh, destroy } */
export async function mount(container) {
  const root = el('div.umbra-settings-usage');
  clear(container).appendChild(root);
  let period = 'month';
  let device = '';
  let metric = 'cost';
  let rows = [];
  let prices = { models: {} };
  let notes = {};
  let profiles = [];
  const eff = new Map();       // priceKey -> effective price (priceFor)
  const msg = el('div.info');

  const providerName = (id) => { const p = profiles.find(x => x.id === id); return p ? p.name : (id || '?'); };
  const modelName = (r) => {
    const p = profiles.find(x => x.id === r.provider);
    const batch = String(r.model || '').endsWith('#batch');
    const id = batch ? String(r.model).slice(0, -6) : r.model;
    return providerName(r.provider) + ' \u00b7 ' + (p ? reg.modelLabel(p, id) : id) + (batch ? ' (lotes \u221250 %)' : '');
  };
  const projectName = (r) => r.project || 'Sin proyecto';
  const noteOf = (k) => { const n = notes[k]; return (n && n.text) ? String(n.text) : ''; };

  function sum(list) {
    const t = { calls: 0, input: 0, cached: 0, output: 0, thoughts: 0, words: 0, cost: 0, unpriced: 0 };
    for (const r of list) {
      t.calls += r.calls; t.input += r.input; t.cached += r.cached; t.output += r.output; t.thoughts += r.thoughts; t.words += r.words;
      const c = costOf(r, eff.get(priceKey(r.provider, r.model)));
      if (c === null) t.unpriced += r.calls; else t.cost += c;
    }
    t.tokens = t.input + t.output + t.thoughts;
    return t;
  }

  function shown() {
    const [from, to] = periodRange(period);
    return { from, to, list: rows.filter(r => (!from || r.day >= from) && (!to || r.day <= to) && (!device || r.device === device)) };
  }

  async function reload() {
    try { rows = await readUsageRows(); } catch (_) { rows = []; }
    try { prices = await loadPrices(); } catch (_) {}
    try { notes = await loadUsageNotes(); } catch (_) {}
    try { profiles = await reg.listProviders({ includeHidden: true }); } catch (_) { profiles = []; }
    eff.clear();
    for (const k of priceKeys()) eff.set(priceKey(k.provider, k.model), await priceFor(k.provider, k.model));
    render();
  }

  // Every model to price: those in the record and those configured.
  function priceKeys() {
    const seen = new Map();
    for (const r of rows) if (r.model) seen.set(priceKey(r.provider, r.model), { provider: r.provider, model: r.model });
    for (const p of profiles) {
      if (p.hidden) continue;
      for (const m of reg.modelsOf(p)) seen.set(priceKey(p.id, m.id), { provider: p.id, model: m.id });
    }
    return [...seen.values()];
  }

  function bars(groups, labelOf, extra) {
    const items = [...groups.entries()].map(([k, l]) => ({ k, l, t: sum(l) }));
    const val = (t) => metric === 'cost' ? t.cost : t.tokens;
    items.sort((a, b) => val(b.t) - val(a.t) || b.t.tokens - a.t.tokens);
    const max = Math.max(1e-12, ...items.map(x => val(x.t)));
    const box = el('div.usage');
    if (!items.length) { box.appendChild(el('p.empty', 'No hay llamadas a la IA en este periodo.')); return box; }
    for (const x of items) {
      const v = val(x.t);
      const fig = metric === 'cost'
        ? (x.t.unpriced === x.t.calls ? 'Sin precio' : _money(x.t.cost) + (x.t.unpriced ? ' +' : '')) + ' \u00b7 ' + _tok(x.t.tokens) + ' tokens'
        : _tok(x.t.tokens) + ' tokens \u00b7 ' + _money(x.t.unpriced === x.t.calls ? null : x.t.cost);
      box.appendChild(el('div.ur',
        el('span', labelOf(x.k, x.l), extra ? extra(x.k, x.l) : null),
        el('span', el('i', { style: { width: Math.max(0.5, (v / max) * 100) + '%' } })),
        el('b', { title: x.t.calls + ' llamada(s) \u00b7 ' + fmtInt(x.t.input) + ' enviados \u00b7 ' + fmtInt(x.t.output + x.t.thoughts) + ' respondidos' }, fig)));
    }
    return box;
  }

  function noteEditor(key) {
    const wrap = el('span', { style: { marginLeft: '6px' } });
    const paint = () => {
      clear(wrap);
      const n = noteOf(key);
      if (n) wrap.appendChild(el('span.pill.info', { style: { marginRight: '4px' } }, n));
      wrap.appendChild(el('button.btn.link', { title: n ? 'Cambiar o borrar la nota' : 'A\u00f1adir una nota (por ejemplo, "Resoluci\u00f3n")', onclick: (e) => { e.stopPropagation(); edit(); } }, '\u270e'));
    };
    const edit = () => {
      clear(wrap);
      const inp = el('input.inp', { type: 'text', maxlength: '120', value: noteOf(key), placeholder: 'Por ejemplo: Resoluci\u00f3n', style: { width: '160px' } });
      let done = false;
      const finish = async (save) => {
        if (done) return;
        done = true;
        if (save && inp.value.trim() !== noteOf(key)) { try { notes = await saveUsageNote(key, inp.value); } catch (_) {} }
        paint();
      };
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); finish(true); } else if (e.key === 'Escape') { e.preventDefault(); finish(false); } });
      inp.addEventListener('blur', () => finish(true));
      wrap.appendChild(inp);
      inp.focus();
    };
    paint();
    return wrap;
  }

  function priceTable() {
    const keys = priceKeys();
    const byKey = _groupBy(rows, r => priceKey(r.provider, r.model));
    const tbl = el('table.grid', el('tr', el('th', 'Modelo'), el('th', 'Llamadas'), el('th', 'Entrada'), el('th', 'En cach\u00e9'), el('th', 'Salida'), el('th', 'Origen')));
    keys.sort((a, b) => ((byKey.get(priceKey(b.provider, b.model)) || []).length - (byKey.get(priceKey(a.provider, a.model)) || []).length)
      || modelName(a).localeCompare(modelName(b)));
    for (const k of keys) {
      const pk = priceKey(k.provider, k.model);
      const p = eff.get(pk) || {};
      const used = (byKey.get(pk) || []).reduce((s, r) => s + r.calls, 0);
      const inp = (field) => {
        const i = el('input.inp', { type: 'number', min: '0', step: '0.0001', placeholder: '?', style: { width: '90px' },
          value: (typeof p[field] === 'number') ? String(p[field]) : null, title: 'US$ por mill\u00f3n de tokens' });
        i.dataset.key = pk;
        i.dataset.field = field;
        i.addEventListener('change', () => setPrice(k, field, i.value));
        return i;
      };
      tbl.appendChild(el('tr', el('td', modelName(k)), el('td', String(used)), el('td', inp('in')), el('td', inp('cached')), el('td', inp('out')),
        el('td.muted', { style: { fontSize: '11px' } }, p.src || (typeof p.in === 'number' ? '' : 'Sin precio'))));
    }
    return tbl;
  }

  async function setPrice(k, field, value) {
    const v = value === '' ? null : Number(value);
    const val = (v === null || !isFinite(v) || v < 0) ? null : v;
    const cur = eff.get(priceKey(k.provider, k.model));
    try {
      if (cur && cur.src === 'Perfil del proveedor') {
        const np = { in: cur.in, cached: cur.cached, out: cur.out };
        np[field] = val;
        await reg.setModelPrice(k.provider, k.model, np);
      } else {
        const pr = await loadPrices();
        const key = priceKey(k.provider, k.model);
        const base = Object.assign({}, pr.models[key] || {});
        if (!pr.models[key] && cur) { base.in = cur.in; base.cached = cur.cached; base.out = cur.out; }
        base[field] = val;
        base.src = 'Puesto a mano';
        base.at = Date.now();
        pr.models[key] = base;
        await savePrices(pr);
      }
    } catch (e) { toast('No se ha podido guardar el precio: ' + ((e && e.message) || e), 'err'); }
    await reload();
  }

  async function lookUp(btn) {
    const keys = priceKeys();
    if (!keys.length) { msg.textContent = 'No hay modelos que buscar.'; return; }
    btn.disabled = true;
    msg.textContent = 'Leyendo la lista de precios\u2026';
    try {
      const { found, missing } = await lookupPrices(keys);
      const pr = await loadPrices();
      // A price typed by hand is never replaced by the list.
      let n = 0;
      for (const k of Object.keys(found)) {
        const cur = pr.models[k];
        if (cur && cur.src === 'Puesto a mano') continue;
        pr.models[k] = found[k];
        n++;
      }
      await savePrices(pr);
      msg.textContent = n + ' modelo(s) con precio de la lista p\u00fablica de LiteLLM.' +
        (missing.length ? ' No est\u00e1n en la lista: ' + missing.map(k => modelName(k)).join(', ') + '. Escribe su precio a mano.' : '');
      await reload();
    } catch (e) {
      msg.textContent = 'No se ha podido leer la lista de precios (' + ((e && e.message) || e) + '). Escribe los precios a mano.';
    } finally { btn.disabled = false; }
  }

  function exportXlsx() {
    const { from, to, list } = shown();
    if (!list.length) { msg.textContent = 'No hay llamadas en este periodo: no hay nada que exportar.'; return; }
    const X = window.XLSX;
    if (!X || !X.utils) { msg.textContent = 'No se ha cargado la biblioteca de Excel (xlsx.mini.min.js).'; return; }
    const sorted = list.slice().sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0) || String(a.module).localeCompare(String(b.module)));
    const money = (v) => (v === null || v === undefined) ? '' : Math.round(v * 1e6) / 1e6;
    const pnum = (v) => (typeof v === 'number' && isFinite(v)) ? v : '';
    const data = [['Fecha', 'Mes', 'Equipo', 'Proyecto', 'Nota del proyecto', 'Archivo', 'M\u00f3dulo', 'Proveedor', 'Modelo', 'Llamadas',
      'Palabras', 'Tokens enviados', 'De ellos en cach\u00e9', 'Tokens respondidos (sin razonamiento)', 'Tokens de razonamiento',
      'Precio entrada (US$/1M)', 'Precio cach\u00e9 (US$/1M)', 'Precio salida (US$/1M)', 'Coste (US$)']];
    for (const r of sorted) {
      const p = eff.get(priceKey(r.provider, r.model)) || {};
      data.push([_parseDay(r.day), r.day.slice(0, 7), r.device, projectName(r), noteOf(r.project), r.file, _moduleLabel(r.module),
        providerName(r.provider), r.model, r.calls, r.words, r.input, r.cached, r.output, r.thoughts,
        pnum(p.in), pnum(p.cached), pnum(p.out), money(costOf(r, p))]);
    }
    const head = ['Llamadas', 'Palabras', 'Tokens enviados', 'Tokens respondidos', 'Coste (US$)'];
    const table = (first, groups, label) => {
      const out = [[first].concat(head)];
      for (const [k, l] of groups.entries()) {
        const t = sum(l);
        out.push([label(k, l), t.calls, t.words, t.input, t.output + t.thoughts, money(t.unpriced === t.calls ? null : t.cost)]);
      }
      const t = sum(list);
      out.push(['Total', t.calls, t.words, t.input, t.output + t.thoughts, money(t.cost)]);
      return out;
    };
    const sheets = {
      Datos: data,
      'Por m\u00f3dulo': table('M\u00f3dulo', _groupBy(list, r => r.module), k => _moduleLabel(k)),
      'Por proyecto': table('Proyecto', _groupBy(list, r => r.project), (k, l) => projectName(l[0]) + (noteOf(k) ? ' \u00b7 ' + noteOf(k) : '')),
      'Por modelo': table('Modelo', _groupBy(list, r => priceKey(r.provider, r.model)), (k, l) => modelName(l[0])),
      'Acerca de': [
        ['UMBRA - Uso de IA y coste'],
        ['Exportado', new Date().toLocaleString('es-ES')],
        ['Periodo', (from || 'primer registro') + ' a ' + (to || '\u00faltimo registro')],
        ['Equipos', device || 'Todos'],
        [],
        ['Una fila por d\u00eda, equipo, proyecto, archivo, m\u00f3dulo y modelo: el registro guarda totales diarios, no cada llamada.'],
        ['Los costes son aproximados: tokens por el precio de lista (US$ por mill\u00f3n de tokens). No se conocen niveles gratuitos, descuentos ni impuestos.']
      ]
    };
    const wb = X.utils.book_new();
    for (const name of Object.keys(sheets)) {
      const ws = X.utils.aoa_to_sheet(sheets[name], { cellDates: true, dateNF: 'yyyy-mm-dd' });
      X.utils.book_append_sheet(wb, ws, name);
    }
    const buf = X.write(wb, { bookType: 'xlsx', type: 'array' });
    download(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
      'UMBRA_uso_IA_' + (from || 'inicio') + '_a_' + (to || _day(new Date())) + '.xlsx');
    msg.textContent = 'Exportado: ' + (data.length - 1) + ' fila(s) en la hoja Datos.';
  }

  function render() {
    if (!root.isConnected) return;
    const { list } = shown();
    const t = sum(list);
    const frag = el('div');

    const periodSel = el('select.inp', { onchange: (e) => { period = e.target.value; render(); } });
    for (const p of PERIODS) periodSel.appendChild(el('option', { value: p.id, selected: p.id === period }, p.label));
    const devs = [...new Set(rows.map(r => r.device))].sort();
    const devSel = devs.length > 1 ? el('select.inp', { onchange: (e) => { device = e.target.value; render(); } },
      el('option', { value: '' }, 'Todos los equipos'),
      devs.map(d => el('option', { value: d, selected: d === device }, d))) : null;
    const metricBtn = (id, label) => el('button.btn.sm' + (metric === id ? '.primary' : ''), { onclick: () => { metric = id; render(); } }, label);
    const lookBtn = el('button.btn.sm', 'Buscar precios');
    lookBtn.addEventListener('click', () => lookUp(lookBtn));
    const tile = (label, value, sub) => el('div.pcard', { style: { minWidth: '150px' } },
      el('div.lbl', { style: { margin: '0 0 4px' } }, label), el('div', { style: { fontSize: '18px', fontWeight: '700' } }, value),
      sub ? el('div.muted', { style: { fontSize: '11px' } }, sub) : null);
    frag.appendChild(el('div.card', el('h3', 'Uso de IA y coste', helpBtn('usage')), el('div.body',
      el('div.row', el('span.lbl', { style: { margin: 0 } }, 'Periodo'), periodSel, devSel, el('span.grow'),
        metricBtn('cost', 'Coste'), metricBtn('tokens', 'Tokens'), lookBtn,
        el('button.btn.sm', { onclick: exportXlsx }, 'Exportar a Excel')),
      el('div.prov', { style: { margin: '12px 0 6px' } },
        tile('Llamadas a la IA', fmtInt(t.calls)),
        tile('Palabras revisadas', fmtInt(t.words), 'De tu texto'),
        tile('Tokens enviados', _tok(t.input), t.cached ? _tok(t.cached) + ' en cach\u00e9' : ''),
        tile('Tokens respondidos', _tok(t.output + t.thoughts), t.thoughts ? _tok(t.thoughts) + ' de razonamiento' : ''),
        tile('Coste aproximado', _money(t.calls ? t.cost : 0), t.unpriced ? t.unpriced + ' llamada(s) sin precio' : 'D\u00f3lares (US$)')),
      msg,
      el('p.info', 'Coste: precios de lista de ', el('a', { href: PRICE_LIST_PAGE, target: '_blank', rel: 'noopener noreferrer' }, 'la lista p\u00fablica de LiteLLM'),
        ', del perfil del proveedor o puestos a mano abajo. No se cuentan niveles gratuitos, descuentos ni impuestos.'))));

    frag.appendChild(el('div.card', el('h3', 'Por m\u00f3dulo'), el('div.body', bars(_groupBy(list, r => r.module), k => _moduleLabel(k)))));
    frag.appendChild(el('div.card', el('h3', 'Por proyecto'), el('div.body',
      bars(_groupBy(list, r => r.project), (k, l) => projectName(l[0]), (k) => k ? noteEditor(k) : null))));
    frag.appendChild(el('div.card', el('h3', 'Por modelo'), el('div.body', bars(_groupBy(list, r => priceKey(r.provider, r.model)), (k, l) => modelName(l[0])))));
    frag.appendChild(el('div.card', el('h3', 'Por d\u00eda'), el('div.body', bars(_groupBy(list, r => r.day), k => k))));
    frag.appendChild(el('div.card', el('h3', 'Precios', helpBtn('prices')), el('div.body',
      el('p.info', 'US$ por mill\u00f3n de tokens. "En cach\u00e9" es el precio de los tokens que el proveedor sirve de su cach\u00e9 (vac\u00edo: el de entrada). ' +
        'El razonamiento se paga al precio de salida. "Buscar precios" no cambia los puestos a mano.'),
      priceTable())));
    clear(root).appendChild(frag);
  }

  let _t = null;
  const off = storage.onChanged((changes) => {
    const keys = Object.keys(changes || {});
    if (keys.some(k => k.indexOf(USAGE_PREFIX) === 0 || k === PRICES_KEY || k === NOTES_KEY || k === reg.PROVIDERS_KEY)) {
      if (!root.isConnected) { off(); return; }
      clearTimeout(_t);
      _t = setTimeout(reload, 150);
    }
  });
  await reload();
  return { refresh: reload, destroy: off };
}
