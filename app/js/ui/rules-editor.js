/**
 * rules-editor.js - Settings > Reglas: built-in and user rules in one table, filters, editor form,
 * "Probar en el documento", profiles, restore, import/export (JSON and Xbench .xbckl).
 */

import { el, clear, toast, modal, download, pickFiles, confirmDialog, promptDialog } from '../util/dom.js';
import { state } from '../state.js';
import { getEffectiveRules, upsertRule, deleteRule, restoreDefault, loadRulesStore, saveProfiles, loadDefaultRules,
  KINDS, KIND_LABELS, SEVERITIES, SEV_LABELS, evalRuleLocal, ruleMatchesSource, alwaysRulesTokens, normalizeRule, saveRulesStore } from '../rules/rules.js';
import { AI_MODULES, moduleById } from '../review/module-list.js';
import { reviewableUnits, unitSrc, unitTgt } from '../review/session.js';
import { parseXBCKL } from '../rules/xbckl.js';

let host, filt = { module: 'all', kind: 'all', origin: 'all', q: '' };

export async function mountRulesEditor(h) {
  host = h;
  await render();
}

async function render() {
  clear(host);
  const rules = await getEffectiveRules();
  const store = await loadRulesStore();
  const profile = state.project ? state.project.profile : '';
  // Header card: counters per module (tokens that always travel)
  const tok = AI_MODULES.filter(m => m.id !== 'verifier').map(m => {
    const n = alwaysRulesTokens(rules, m.id, profile);
    return n ? m.short + ' ~' + n : null;
  }).filter(Boolean);
  host.appendChild(el('div.note', 'Las reglas de serie se editan como las suyas (marca \u00abDe serie \u00b7 modificada\u00bb) y se pueden restaurar. Las de tipo Prohibido, Patr\u00f3n e Ignorar se comprueban sin IA; las de Estilo y Estructura viajan siempre en el prompt; las de Expresi\u00f3n solo cuando su expresi\u00f3n aparece en el original.' +
    (tok.length ? ' Tokens que a\u00f1aden las reglas que viajan siempre: ' + tok.join(', ') + ' por lote.' : '')));
  const q = el('input.inp', { placeholder: 'Buscar\u2026', value: filt.q, oninput: (e) => { filt.q = e.target.value; renderTable(rules, tbody); } });
  const modSel = el('select', { onchange: (e) => { filt.module = e.target.value; renderTable(rules, tbody); } }, el('option', { value: 'all' }, 'Todos los m\u00f3dulos'),
    AI_MODULES.filter(m => m.id !== 'verifier').map(m => el('option', { value: m.id }, m.label)));
  modSel.value = filt.module;
  const kindSel = el('select', { onchange: (e) => { filt.kind = e.target.value; renderTable(rules, tbody); } }, el('option', { value: 'all' }, 'Todos los tipos'),
    KINDS.map(k => el('option', { value: k }, KIND_LABELS[k])));
  kindSel.value = filt.kind;
  const orSel = el('select', { onchange: (e) => { filt.origin = e.target.value; renderTable(rules, tbody); } },
    el('option', { value: 'all' }, 'De serie y m\u00edas'), el('option', { value: 'serie' }, 'De serie'), el('option', { value: 'mod' }, 'De serie modificadas'), el('option', { value: 'usuario' }, 'M\u00edas'));
  orSel.value = filt.origin;
  const tbody = el('tbody');
  const card = el('div.card', el('h3', 'Reglas (' + rules.length + ')'), el('div.body',
    el('div.row', { style: { marginBottom: '8px' } }, q, modSel, kindSel, orSel, el('span.grow'),
      el('button.btn.primary', { onclick: () => editRule(null) }, '+ Nueva regla'),
      el('button.btn', { onclick: (e) => moreMenu(e.currentTarget) }, 'M\u00e1s \u25be')),
    el('table.grid.rules', el('thead', el('tr', el('th', ''), el('th', 'Tipo'), el('th', 'Si el original dice / patr\u00f3n'), el('th', 'Escribir'), el('th', 'No escribir'),
      el('th', 'M\u00f3dulos'), el('th', 'Grav.'), el('th', 'Origen'), el('th', ''))), tbody)));
  host.appendChild(card);
  renderTable(rules, tbody);
  // Profiles
  const profBox = el('div.row');
  for (const p of store.profiles) profBox.appendChild(el('span.pill.gray', p, ' ', el('button.btn.link', { title: 'Quitar', onclick: async () => {
    await saveProfiles(store.profiles.filter(x => x !== p)); render();
  } }, '\u00d7')));
  profBox.appendChild(el('button.btn.sm', { onclick: async () => {
    const n = await promptDialog('Nuevo perfil', 'Nombre del perfil (por ejemplo, \u00abInformes del SG\u00bb)', '');
    if (n && n.trim()) { await saveProfiles(store.profiles.concat([n.trim()])); render(); }
  } }, '+ Perfil'));
  host.appendChild(el('div.card', el('h3', 'Perfiles'), el('div.body',
    el('p.info', 'Un perfil es un juego de reglas por tipo de documento. Una regla sin perfiles se aplica siempre; con perfiles, solo cuando el proyecto usa uno de ellos (se elige en Revisar).'), profBox)));
}

function renderTable(rules, tbody) {
  clear(tbody);
  const q = filt.q.trim().toLowerCase();
  const list = rules.filter(r =>
    (filt.module === 'all' || r.modules.includes(filt.module)) &&
    (filt.kind === 'all' || r.kind === filt.kind) &&
    (filt.origin === 'all' || r.status === filt.origin) &&
    (!q || [r.src, r.es, r.avoid, r.note, r.regex].join(' ').toLowerCase().includes(q)));
  for (const r of list.slice(0, 500)) {
    const org = r.status === 'serie' ? el('span.org.serie', 'De serie') : r.status === 'mod' ? el('span.org.mod', 'De serie \u00b7 modificada') : el('span.org.usuario', 'M\u00eda');
    tbody.appendChild(el('tr', { style: { opacity: r.on ? 1 : 0.5 } },
      el('td', el('input', { type: 'checkbox', checked: r.on, title: r.on ? 'Activa' : 'Desactivada', onchange: async (e) => { await upsertRule(Object.assign({}, r, { on: e.target.checked })); } })),
      el('td', el('span.kind', KIND_LABELS[r.kind])),
      el('td', r.kind === 'pattern' ? el('code', r.regex || '') : (r.src || (r.kind === 'style' || r.kind === 'structure' ? el('span.muted', r.note) : '\u2014'))),
      el('td', r.es || '\u2014'),
      el('td', r.avoid || '\u2014'),
      el('td', r.modules.map(m => (moduleById(m) || { short: m }).short).join(', ')),
      el('td', r.severity),
      el('td', org, r.newVersion ? el('div.newv', { title: 'La versi\u00f3n de serie ha cambiado desde que usted la modific\u00f3' }, '\u25cf nueva') : null),
      el('td', { style: { whiteSpace: 'nowrap' } },
        el('button.btn.sm', { onclick: () => editRule(r) }, 'Editar'), ' ',
        r.status === 'mod' ? el('button.btn.sm', { onclick: async () => { await restoreDefault(r.id); toast('Restaurada.', 'ok'); render(); } }, 'Restaurar') : null, ' ',
        el('button.btn.sm.danger', { onclick: async () => {
          if (!(await confirmDialog('Borrar regla', r.status === 'usuario' ? 'Se borrar\u00e1 la regla.' : 'Se quitar\u00e1 esta regla de serie (puede recuperarla con \u00abRestaurar todas las de serie\u00bb).', 'Borrar'))) return;
          await deleteRule(r.id); render();
        } }, '\u00d7'))));
  }
  if (!list.length) tbody.appendChild(el('tr', el('td', { colspan: 9 }, el('div.empty', 'Ninguna regla con estos filtros.'))));
}

async function moreMenu(anchor) {
  const { openMenu } = await import('./menu.js');
  openMenu(anchor, [
    { label: 'Restaurar todas las reglas de serie', onClick: async () => {
      if (!(await confirmDialog('Restaurar', 'Las reglas de serie volver\u00e1n a su versi\u00f3n original (sus reglas propias no se tocan).', 'Restaurar'))) return;
      await restoreDefault(null); toast('Restauradas.', 'ok'); render();
    } },
    { label: 'Exportar reglas (JSON)', onClick: async () => {
      const rules = await getEffectiveRules();
      download(new Blob([JSON.stringify({ kind: 'umbra-rules', v: 1, rules: rules.map(r => { const c = Object.assign({}, r); delete c.defaultRule; return c; }) }, null, 1)], { type: 'application/json' }), 'umbra-reglas.json');
    } },
    { label: 'Importar reglas (JSON)', onClick: () => importJson() },
    { label: 'Importar lista de comprobaci\u00f3n de Xbench (.xbckl)', onClick: () => importXbckl() }
  ]);
}

async function importJson() {
  const files = await pickFiles('.json', false);
  if (!files[0]) return;
  try {
    const j = JSON.parse(await files[0].text());
    const list = (j.rules || []);
    const defaults = await loadDefaultRules();
    let n = 0;
    for (const r of list) {
      const isDefault = defaults.some(d => d.id === r.id);
      await upsertRule(isDefault ? r : Object.assign({}, r, { origin: 'usuario', id: r.id && r.id.startsWith('def:') ? undefined : r.id }));
      n++;
    }
    toast(n + ' reglas importadas.', 'ok');
    render();
  } catch (e) { toast('No se pudo importar: ' + e.message, 'err'); }
}

async function importXbckl() {
  const files = await pickFiles('.xbckl,.xml', false);
  if (!files[0]) return;
  try {
    const parsed = parseXBCKL(await files[0].text(), files[0].name);
    const store = await loadRulesStore();
    for (const r of parsed) store.user.push(normalizeRule(r, 'usuario'));
    await saveRulesStore(store);
    toast(parsed.length + ' reglas importadas de Xbench (tipo Patr\u00f3n).', 'ok');
    render();
  } catch (e) { toast('No se pudo importar: ' + e.message, 'err'); }
}

async function editRule(r) {
  const isNew = !r;
  const rule = Object.assign({ kind: 'forbid', modules: ['style'], severity: 'MEN', on: true, profiles: [], src: '', es: '', avoid: '', note: '', regex: '', srcRegex: '' }, r || {});
  const store = await loadRulesStore();
  const f = {
    kind: el('select.inp', KINDS.map(k => el('option', { value: k }, KIND_LABELS[k]))),
    src: el('input.inp', { value: rule.src || '', placeholder: 'stakeholder*|partie* prenante*' }),
    es: el('input.inp', { value: rule.es || '', placeholder: 'partes interesadas' }),
    avoid: el('input.inp', { value: rule.avoid || '', placeholder: 'actores' }),
    regex: el('input.inp.mono', { value: rule.regex || '', placeholder: '\\b(\\w+) \\1\\b' }),
    srcRegex: el('input.inp.mono', { value: rule.srcRegex || '' }),
    note: el('textarea.inp', { rows: 3 }),
    severity: el('select.inp', SEVERITIES.map(s => el('option', { value: s }, SEV_LABELS[s])))
  };
  f.kind.value = rule.kind; f.severity.value = rule.severity; f.note.value = rule.note || '';
  const mods = AI_MODULES.filter(m => m.id !== 'verifier').map(m => el('label', { style: { marginRight: '10px', whiteSpace: 'nowrap' } },
    el('input', { type: 'checkbox', value: m.id, checked: rule.modules.includes(m.id) }), ' ' + m.short));
  const profs = store.profiles.map(p => el('label', { style: { marginRight: '10px' } }, el('input', { type: 'checkbox', value: p, checked: (rule.profiles || []).includes(p) }), ' ' + p));
  const help = el('p.info');
  const rows = {
    src: el('div.field', el('label.lbl', 'Si el original dice (formas con |, * = cualquier final)'), f.src),
    es: el('div.field', el('label.lbl', 'Escribir (forma correcta)'), f.es),
    avoid: el('div.field', el('label.lbl', 'No escribir (formas con |, * = cualquier final)'), f.avoid),
    regex: el('div.field', el('label.lbl', 'Patr\u00f3n en la traducci\u00f3n (expresi\u00f3n regular)'), f.regex),
    srcRegex: el('div.field', el('label.lbl', 'Solo si el original cumple este patr\u00f3n (opcional)'), f.srcRegex)
  };
  const HELP = {
    expr: 'Cuando el ORIGINAL contiene la expresi\u00f3n, la traducci\u00f3n debe usar la forma indicada. Se comprueba sin IA; si no se encuentra la forma correcta, la regla viaja a la IA para que juzgue.',
    forbid: 'La traducci\u00f3n no debe contener la forma indicada. Se comprueba sin IA.',
    pattern: 'Expresi\u00f3n regular sobre la traducci\u00f3n (sin IA). Para usuarios avanzados.',
    style: 'Instrucci\u00f3n libre para la IA. Viaja en cada llamada del m\u00f3dulo: conviene que sea breve.',
    structure: 'Instrucci\u00f3n sobre la estructura (listas, t\u00edtulos, partes de una resoluci\u00f3n) para los m\u00f3dulos de Coherencia y Convenciones.',
    ignore: 'Silencia los hallazgos cuya cita contenga la forma indicada en \u00abNo escribir\u00bb.'
  };
  const sync = () => {
    const k = f.kind.value;
    rows.src.style.display = k === 'expr' ? '' : 'none';
    rows.es.style.display = (k === 'expr' || k === 'forbid' || k === 'pattern' || k === 'style') ? '' : 'none';
    rows.avoid.style.display = (k === 'expr' || k === 'forbid' || k === 'ignore' || k === 'style') ? '' : 'none';
    rows.regex.style.display = k === 'pattern' ? '' : 'none';
    rows.srcRegex.style.display = k === 'pattern' ? '' : 'none';
    help.textContent = HELP[k];
  };
  f.kind.addEventListener('change', sync);
  sync();
  const testOut = el('div.info');
  const body = el('div',
    r && r.status === 'mod' && r.newVersion ? el('div.note.warn', 'La versi\u00f3n de serie de esta regla ha cambiado: ', el('b', (r.defaultRule.note || r.defaultRule.es || r.defaultRule.avoid || '')), '. Puede adoptarla con \u00abRestaurar\u00bb.') : null,
    el('div.form-grid', el('div.field', el('label.lbl', 'Tipo'), f.kind), el('div.field', el('label.lbl', 'Gravedad'), f.severity)),
    help, rows.src, rows.es, rows.avoid, rows.regex, rows.srcRegex,
    el('div.field', el('label.lbl', 'Nota o instrucci\u00f3n (explica la regla; en Estilo y Estructura es lo que se env\u00eda a la IA)'), f.note),
    el('label.lbl', 'M\u00f3dulos'), el('div', mods),
    store.profiles.length ? el('label.lbl', 'Perfiles (ninguno = siempre)') : null, el('div', profs),
    el('div', { style: { marginTop: '10px' } }, el('button.btn.sm', { onclick: () => test() }, 'Probar en el documento'), testOut));
  const collect = () => Object.assign({}, rule, {
    kind: f.kind.value, src: f.src.value, es: f.es.value, avoid: f.avoid.value, regex: f.regex.value || null, srcRegex: f.srcRegex.value || null,
    note: f.note.value, severity: f.severity.value,
    modules: mods.map(x => x.querySelector('input')).filter(i => i.checked).map(i => i.value),
    profiles: profs.map(x => x.querySelector('input')).filter(i => i.checked).map(i => i.value)
  });
  const test = () => {
    clear(testOut);
    if (!state.session) { testOut.textContent = 'Abra un proyecto para probar la regla.'; return; }
    const cand = normalizeRule(collect(), 'usuario');
    let hits = 0, srcHits = 0;
    const ex = [];
    for (const u of reviewableUnits(state.session)) {
      const s = unitSrc(state.session, u), t = unitTgt(state.session, u);
      if ((cand.kind === 'expr' || cand.srcRegex) && ruleMatchesSource(cand, s)) srcHits++;
      for (const h of evalRuleLocal(cand, s, t)) {
        if (h.soft) continue;
        hits++;
        if (ex.length < 12) ex.push('\u00a7' + u.n + ': \u00ab' + h.quote + '\u00bb' + (h.suggestion ? ' \u2192 \u00ab' + h.suggestion + '\u00bb' : ''));
      }
    }
    testOut.appendChild(el('p', hits + ' coincidencias en la traducci\u00f3n' + (cand.kind === 'expr' ? ' (la expresi\u00f3n aparece en ' + srcHits + ' p\u00e1rrafos del original)' : '') + '.'));
    if (ex.length) testOut.appendChild(el('ul', ex.map(x => el('li', x))));
    if (cand.kind === 'style' || cand.kind === 'structure') testOut.appendChild(el('p', 'Esta regla la aplica la IA: no se puede probar sin ejecutar el m\u00f3dulo.'));
  };
  const res = await modal({ title: isNew ? 'Nueva regla' : 'Editar regla', body, width: '720px', buttons: [
    { label: 'Cancelar', value: null },
    { label: 'Guardar', kind: 'primary', value: 'ok', onClick: () => {
      const c = collect();
      if (!c.modules.length) { toast('Elija al menos un m\u00f3dulo.', 'warn'); return false; }
      if (c.kind === 'expr' && (!c.src || !c.es)) { toast('Indique la expresi\u00f3n del original y la forma correcta.', 'warn'); return false; }
      if ((c.kind === 'forbid' || c.kind === 'ignore') && !c.avoid) { toast('Indique la forma que no se debe escribir.', 'warn'); return false; }
      if (c.kind === 'pattern') { try { new RegExp(c.regex, 'u'); } catch (e) { toast('Patr\u00f3n no v\u00e1lido: ' + e.message, 'warn'); return false; } }
      if ((c.kind === 'style' || c.kind === 'structure') && !c.note) { toast('Escriba la instrucci\u00f3n en la nota.', 'warn'); return false; }
      return true;
    } }] });
  if (res !== 'ok') return;
  const c = collect();
  if (isNew) { delete c.id; c.origin = 'usuario'; }
  await upsertRule(c);
  toast('Regla guardada.', 'ok');
  render();
}
