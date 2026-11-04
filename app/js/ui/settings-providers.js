/**
 * settings-providers.js - Settings > Proveedores: provider profiles (cards), the add/edit form, the
 * connection test, the general provider and the model of each review module.
 *
 * Origin: COMeT settings/tabs/ai-tab.js @ 04540f5 (adapted)  (model lists, "add a model", test,
 *         "Model per function" with the general fallback)
 *
 * Exports:
 *   mount(container) -> { refresh, destroy }
 *   openModelMenu(anchorEl, { moduleId, role, onPick })  the dropdown of the module cards
 *   openProviderModal(profile|null) -> saved profile | null
 *   openAddModelModal({ providerId }) -> { provider, model } | null
 */

import { helpBtn, helpItem } from './help.js';
import { el, clear, modal, toast, confirmDialog, debounce } from '../util/dom.js';
import { AI_MODULES, ROLE_LABELS, moduleById } from '../review/module-list.js';
import { ADAPTERS, adapterLabel, testConnection } from '../ai/providers.js';
import * as reg from '../ai/registry.js';
import { recordUsage, OTHER_MODULE } from '../ai/usage.js';

const TRUST_LABEL = { external: 'Externo', local: 'Local' };
const ADD_MODEL = '__add_model';
const ADD_PROVIDER = '__add_provider';

// Quick starts for an OpenAI-compatible profile (the user adds the models).
const PRESETS = [
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', trust: 'external' },
  { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', trust: 'external' },
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', trust: 'external' },
  { id: 'groq', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', trust: 'external' },
  { id: 'ollama', name: 'Ollama (local)', baseUrl: 'http://localhost:11434/v1', trust: 'local' }
];

const TRUST_HELP = 'Externo: un servicio en Internet; solo recibe texto enmascarado. Local: un modelo que funciona en tu ' +
  'propio equipo o red (Ollama, LM Studio...); es el \u00fanico que puede recibir texto sin enmascarar, si un m\u00f3dulo lo permite.';

function _encode(choice) { return choice ? choice.provider + '|' + (choice.model || '') : ''; }
function _decode(v) {
  if (!v || v === ADD_MODEL || v === ADD_PROVIDER) return null;
  const i = v.indexOf('|');
  return i < 0 ? { provider: v, model: '' } : { provider: v.slice(0, i), model: v.slice(i + 1) };
}

function _choiceLabel(status, choice) {
  if (!choice) return 'General';
  const s = status.find(x => x.profile.id === choice.provider);
  if (!s) return 'Proveedor borrado \u00b7 ' + (choice.model || '?');
  return s.profile.name + ' \u00b7 ' + reg.modelLabel(s.profile, choice.model);
}

function _isOffered(status, choice) {
  if (!choice) return true;
  const s = status.find(x => x.profile.id === choice.provider);
  return !!(s && s.usable && reg.modelsOf(s.profile).some(m => m.id === choice.model));
}

// ------------------------------------------------------------------ model select / menu

/**
 * A <select> of models: first "General" (or `firstLabel`), then the models of every provider with a
 * key grouped by provider, the current choice flagged when it cannot be used, and at the end
 * "+ Anadir modelo..." / "+ Anadir proveedor...". onChoose(choice|null) after a real choice.
 */
function _modelSelect(status, current, onChoose, opts) {
  const o = opts || {};
  const sel = el('select.inp', { style: { minWidth: '200px', maxWidth: '100%' } });
  sel.appendChild(el('option', { value: '' }, o.firstLabel || 'General'));
  if (current && !_isOffered(status, current)) {
    sel.appendChild(el('option', { value: _encode(current) }, _choiceLabel(status, current) + ' (sin clave: se usa el general)'));
  }
  for (const s of status) {
    if (!s.usable) continue;
    const models = reg.modelsOf(s.profile);
    if (!models.length) continue;
    const g = el('optgroup', { label: s.profile.name });
    for (const m of models) g.appendChild(el('option', { value: s.profile.id + '|' + m.id }, m.label || m.id));
    sel.appendChild(g);
  }
  sel.appendChild(el('optgroup', { label: 'A\u00f1adir' },
    el('option', { value: ADD_MODEL }, '+ A\u00f1adir modelo\u2026'),
    el('option', { value: ADD_PROVIDER }, '+ A\u00f1adir proveedor\u2026')));
  sel.value = _encode(current);
  let prev = sel.value;
  sel.addEventListener('change', async () => {
    const v = sel.value;
    if (v === ADD_MODEL || v === ADD_PROVIDER) {
      sel.value = prev;
      const choice = v === ADD_MODEL ? await openAddModelModal({}) : await _addProviderAndPick();
      if (choice) await onChoose(choice);
      return;
    }
    prev = v;
    await onChoose(_decode(v));
  });
  return sel;
}

async function _addProviderAndPick() {
  const p = await openProviderModal(null);
  if (!p) return null;
  const key = await reg.getApiKey(p.id);
  const models = reg.modelsOf(p);
  if (!reg.isUsable(p, key) || !models.length) {
    toast('Proveedor guardado. Para elegirlo necesita una clave y al menos un modelo.', 'warn', 6000);
    return null;
  }
  return { provider: p.id, model: models[0].id };
}

let _menu = null;
function _closeMenu() {
  if (_menu) { _menu.remove(); _menu = null; }
  document.removeEventListener('mousedown', _onDocDown, true);
  document.removeEventListener('keydown', _onDocKey, true);
}
function _onDocDown(e) { if (_menu && !_menu.contains(e.target)) _closeMenu(); }
function _onDocKey(e) { if (e.key === 'Escape') _closeMenu(); }

/**
 * The model dropdown of a module card: the same options as the settings table. Picking an option
 * saves it (setModuleModel; without moduleId, the general choice) and calls onPick(choice|null).
 */
export async function openModelMenu(anchorEl, opts) {
  const o = opts || {};
  _closeMenu();
  const role = o.role === 'deep' ? 'deep' : 'triage';
  const [status, mm] = await Promise.all([reg.providersWithStatus(), reg.getModuleModels()]);
  const current = o.moduleId ? ((mm.map[o.moduleId] || {})[role] || null) : mm.general;
  const pick = async (choice) => {
    _closeMenu();
    if (o.moduleId) await reg.setModuleModel(o.moduleId, role, choice);
    else await reg.setGeneralModel(choice);
    if (typeof o.onPick === 'function') { try { o.onPick(choice); } catch (e) { console.error(e); } }
  };
  const menu = el('div.menu#umbra-model-menu');
  const mod = o.moduleId ? moduleById(o.moduleId) : null;
  if (mod) menu.appendChild(el('div.mh', mod.short + (mod.roles.length > 1 ? ' \u00b7 ' + (ROLE_LABELS[role] || role) : '')));
  menu.appendChild(el('div.mi' + (!current ? '.sel' : ''), { onclick: () => pick(null) }, o.moduleId ? 'General' : 'El primero con clave'));
  if (current && !_isOffered(status, current)) {
    menu.appendChild(el('div.mi.sel.disabled', _choiceLabel(status, current) + ' (sin clave: se usa el general)'));
  }
  for (const s of status) {
    if (!s.usable) continue;
    const models = reg.modelsOf(s.profile);
    if (!models.length) continue;
    menu.appendChild(el('div.sep'));
    menu.appendChild(el('div.mh', s.profile.name));
    for (const m of models) {
      const isSel = current && current.provider === s.profile.id && current.model === m.id;
      menu.appendChild(el('div.mi' + (isSel ? '.sel' : ''), { onclick: () => pick({ provider: s.profile.id, model: m.id }) }, m.label || m.id));
    }
  }
  menu.appendChild(el('div.sep'));
  menu.appendChild(el('div.mi.add', { onclick: async () => { _closeMenu(); const c = await openAddModelModal({}); if (c) await pick(c); } }, '+ A\u00f1adir modelo\u2026'));
  menu.appendChild(el('div.mi.add', { onclick: async () => { _closeMenu(); const c = await _addProviderAndPick(); if (c) await pick(c); } }, '+ A\u00f1adir proveedor\u2026'));
  document.body.appendChild(menu);
  _menu = menu;
  const r = anchorEl && anchorEl.getBoundingClientRect ? anchorEl.getBoundingClientRect() : { left: 20, bottom: 20, top: 20 };
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  let left = Math.min(r.left, window.innerWidth - mw - 8);
  let top = r.bottom + 4;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 4);
  menu.style.left = Math.max(8, left) + 'px';
  menu.style.top = top + 'px';
  setTimeout(() => {
    document.addEventListener('mousedown', _onDocDown, true);
    document.addEventListener('keydown', _onDocKey, true);
  }, 0);
  return menu;
}

// ------------------------------------------------------------------ add-model modal

/** "+ Anadir modelo...": a model on an existing provider. -> { provider, model } | null */
export async function openAddModelModal(opts) {
  const o = opts || {};
  const status = await reg.providersWithStatus();
  if (!status.length) { toast('Primero a\u00f1ade un proveedor.', 'warn'); return null; }
  const firstUsable = status.find(s => s.usable) || status[0];
  const provSel = el('select.inp');
  for (const s of status) {
    provSel.appendChild(el('option', { value: s.profile.id, selected: s.profile.id === (o.providerId || firstUsable.profile.id) },
      s.profile.name + (s.usable ? '' : ' (sin clave)')));
  }
  const idInp = el('input.inp', { type: 'text', placeholder: 'Por ejemplo: gemini-2.5-flash' });
  const labelInp = el('input.inp', { type: 'text', placeholder: 'Mi modelo' });
  const pIn = el('input.inp', { type: 'number', min: '0', step: '0.0001', placeholder: '?' });
  const pCached = el('input.inp', { type: 'number', min: '0', step: '0.0001', placeholder: '?' });
  const pOut = el('input.inp', { type: 'number', min: '0', step: '0.0001', placeholder: '?' });
  const msg = el('div');
  const body = el('div',
    el('p.info', 'Escribe el nombre de API exacto del modelo, tal como lo da la documentaci\u00f3n del proveedor. El nombre visible y los precios son opcionales.'),
    el('div.field', el('label.lbl', 'Proveedor'), provSel),
    el('div.form-grid',
      el('div.field', el('label.lbl', 'Nombre de API del modelo'), idInp),
      el('div.field', el('label.lbl', 'Nombre visible (opcional)'), labelInp)),
    el('label.lbl', 'Precio en US$ por mill\u00f3n de tokens (opcional): entrada / en cach\u00e9 / salida'),
    el('div.row', pIn, pCached, pOut),
    msg);
  let result = null;
  await modal({
    title: 'A\u00f1adir un modelo', help: helpBtn('model-add'), body,
    buttons: [
      { label: 'Cancelar', value: null },
      { label: 'A\u00f1adir y elegir', kind: 'primary', value: 'ok', onClick: async () => {
        const id = idInp.value.trim();
        if (!reg.MODEL_ID_RE.test(id)) {
          msg.className = 'note err';
          msg.textContent = 'Nombre de API no v\u00e1lido: solo letras, cifras y . _ - : / @';
          return false;
        }
        try {
          const price = (pIn.value || pOut.value || pCached.value) ? { in: pIn.value, cached: pCached.value, out: pOut.value } : undefined;
          await reg.addModel(provSel.value, { id, label: labelInp.value.trim(), price });
          result = { provider: provSel.value, model: id };
        } catch (e) {
          msg.className = 'note err';
          msg.textContent = (e && e.message) || String(e);
          return false;
        }
        return true;
      } }
    ]
  });
  if (result) {
    const s = status.find(x => x.profile.id === result.provider);
    if (s && !s.usable) toast('Modelo a\u00f1adido. Ese proveedor no tiene clave: hasta que la tenga se usa el general.', 'warn', 6000);
  }
  return result;
}

// ------------------------------------------------------------------ provider modal

function _priceInput(v) {
  return el('input.inp', { type: 'number', min: '0', step: '0.0001', placeholder: '?', value: (typeof v === 'number') ? String(v) : null, style: { width: '72px' } });
}

/** Add (profile null) or edit a provider. -> the saved profile, or null when cancelled. */
export async function openProviderModal(profile) {
  const isNew = !profile;
  const p = profile ? JSON.parse(JSON.stringify(profile)) : {
    id: '', name: '', adapter: 'openai-compatible', baseUrl: '', deployment: '', apiVersion: '', relayUrl: '',
    models: [], trust: 'external', builtIn: false
  };
  const hadKey = p.id ? await reg.hasApiKey(p.id) : false;
  let removeKey = false;

  const nameInp = el('input.inp', { type: 'text', value: p.name, placeholder: 'Por ejemplo: OpenRouter' });
  const adapterSel = el('select.inp', { disabled: p.builtIn ? true : null });
  for (const a of ADAPTERS) adapterSel.appendChild(el('option', { value: a.id, selected: a.id === p.adapter }, a.label));
  const presetSel = el('select.inp');
  presetSel.appendChild(el('option', { value: '' }, 'Elige una plantilla (opcional)'));
  for (const pr of PRESETS) presetSel.appendChild(el('option', { value: pr.id }, pr.name));
  const baseInp = el('input.inp', { type: 'text', value: p.baseUrl, placeholder: 'https://api.openai.com/v1' });
  const endpointInp = el('input.inp', { type: 'text', value: p.baseUrl, placeholder: 'https://recurso.openai.azure.com' });
  const deployInp = el('input.inp', { type: 'text', value: p.deployment, placeholder: 'gpt-4o-mini' });
  const apiVerInp = el('input.inp', { type: 'text', value: p.apiVersion || '2024-06-01' });
  const relayInp = el('input.inp', { type: 'text', value: p.relayUrl, placeholder: 'https://mi-puente.workers.dev/v1' });
  const keyInp = el('input.inp', { type: 'password', autocomplete: 'off',
    placeholder: hadKey ? 'Clave guardada (escribe otra para cambiarla)' : 'Pega aqu\u00ed la clave de API' });
  const keyState = el('span.pill.' + (hadKey ? 'ok' : 'gray'), hadKey ? 'Clave guardada' : 'Sin clave');
  const removeKeyBtn = hadKey ? el('button.btn.sm.danger', { type: 'button' }, 'Quitar clave') : null;
  if (removeKeyBtn) {
    removeKeyBtn.addEventListener('click', () => {
      removeKey = !removeKey;
      keyState.className = 'pill ' + (removeKey ? 'warn' : 'ok');
      keyState.textContent = removeKey ? 'Se quitar\u00e1 al guardar' : 'Clave guardada';
      removeKeyBtn.textContent = removeKey ? 'No quitar' : 'Quitar clave';
    });
  }
  const trustName = 'trust_' + Math.random().toString(36).slice(2, 7);
  const trustExt = el('input', { type: 'radio', name: trustName, value: 'external', checked: p.trust !== 'local' ? true : null });
  const trustLoc = el('input', { type: 'radio', name: trustName, value: 'local', checked: p.trust === 'local' ? true : null });

  // Models
  const models = (p.models || []).map(m => Object.assign({}, m));
  const modelsBox = el('div');
  const newId = el('input.inp', { type: 'text', placeholder: 'Nombre de API del modelo' });
  const newLabel = el('input.inp', { type: 'text', placeholder: 'Nombre visible (opcional)' });
  const testSel = el('select.inp');
  const msg = el('div');

  function renderModels() {
    clear(modelsBox);
    clear(testSel);
    if (!models.length) {
      modelsBox.appendChild(el('p.info', adapterSel.value === 'azure-openai'
        ? 'Sin lista: se usa el deployment. Puedes a\u00f1adir otros deployments como modelos.'
        : 'Todav\u00eda no hay modelos. A\u00f1ade al menos uno.'));
    } else {
      const tbl = el('table.grid', el('tr', el('th', 'Modelo'), el('th', 'Nombre visible'), el('th', 'Entrada'), el('th', 'Cach\u00e9'), el('th', 'Salida'), el('th', '')));
      models.forEach((m, i) => {
        const pi = _priceInput(m.price && m.price.in), pc = _priceInput(m.price && m.price.cached), po = _priceInput(m.price && m.price.out);
        const sync = () => {
          const pr = { in: pi.value === '' ? null : Number(pi.value), cached: pc.value === '' ? null : Number(pc.value), out: po.value === '' ? null : Number(po.value) };
          if (pr.in === null && pr.out === null && pr.cached === null) delete m.price; else m.price = pr;
        };
        [pi, pc, po].forEach(x => x.addEventListener('change', sync));
        const lab = el('input.inp', { type: 'text', value: m.label || '', style: { width: '100%' } });
        lab.addEventListener('change', () => { m.label = lab.value.trim() || m.id; });
        tbl.appendChild(el('tr',
          el('td.mono', m.id), el('td', lab), el('td', pi), el('td', pc), el('td', po),
          el('td', el('button.btn.sm.danger', { type: 'button', title: 'Quitar de la lista', onclick: () => { models.splice(i, 1); renderModels(); } }, '\u00d7'))));
      });
      modelsBox.appendChild(tbl);
      modelsBox.appendChild(el('p.info', 'Precios en US$ por mill\u00f3n de tokens (opcionales): si los pones aqu\u00ed, mandan sobre la lista de precios.'));
    }
    const opts = models.length ? models : (deployInp.value.trim() ? [{ id: deployInp.value.trim(), label: deployInp.value.trim() }] : []);
    for (const m of opts) testSel.appendChild(el('option', { value: m.id }, m.label || m.id));
  }

  const addModelBtn = el('button.btn.sm', { type: 'button' }, '+ A\u00f1adir a la lista');
  addModelBtn.addEventListener('click', () => {
    const id = newId.value.trim();
    if (!reg.MODEL_ID_RE.test(id)) { msg.className = 'note err'; msg.textContent = 'Nombre de API no v\u00e1lido: solo letras, cifras y . _ - : / @'; return; }
    if (!models.some(m => m.id === id)) models.push({ id, label: newLabel.value.trim() || id });
    newId.value = ''; newLabel.value = '';
    msg.className = ''; msg.textContent = '';
    renderModels();
  });

  const fBase = el('div.field', el('label.lbl', 'URL base'), baseInp);
  const batchChk = el('input', { type: 'checkbox', checked: p.batch === true ? true : null });
  const fBatch = el('div.field', el('label', batchChk, ' Admite la API de lotes de OpenAI (Batch API: /files y /batches)'),
    el('p.info', 'Permite el modo diferido (lotes as\u00edncronos, unos 50 % m\u00e1s baratos) con este proveedor. OpenAI la admite; ' +
      'otros compatibles, solo si su documentaci\u00f3n lo dice. Gemini, Anthropic y Mistral ya la tienen sin marcar nada.'));
  const fPreset = el('div.field', el('label.lbl', 'Plantilla'), presetSel);
  const fAzure = el('div', el('div.field', el('label.lbl', 'Endpoint de Azure'), endpointInp),
    el('div.form-grid', el('div.field', el('label.lbl', 'Deployment'), deployInp), el('div.field', el('label.lbl', 'Versi\u00f3n de la API'), apiVerInp)));
  const fRelay = el('div.field', el('label.lbl', 'URL de puente (opcional)'), relayInp,
    el('p.info', 'Un puente propio (por ejemplo, un Cloudflare Worker) para un proveedor que no acepta llamadas desde una p\u00e1gina web. ' +
      'Si la pones, se llama al puente en lugar de a la URL base. Solo le llega texto enmascarado.'));

  function applyAdapter() {
    const a = adapterSel.value;
    fBase.classList.toggle('hidden', a !== 'openai-compatible');
    fBatch.classList.toggle('hidden', a !== 'openai-compatible');
    fPreset.classList.toggle('hidden', !(isNew && a === 'openai-compatible'));
    fAzure.classList.toggle('hidden', a !== 'azure-openai');
    renderModels();
  }
  adapterSel.addEventListener('change', applyAdapter);
  deployInp.addEventListener('change', renderModels);
  presetSel.addEventListener('change', () => {
    const pr = PRESETS.find(x => x.id === presetSel.value);
    if (!pr) return;
    if (!nameInp.value.trim()) nameInp.value = pr.name;
    baseInp.value = pr.baseUrl;
    (pr.trust === 'local' ? trustLoc : trustExt).checked = true;
  });

  const testBtn = el('button.btn', { type: 'button' }, 'Probar conexi\u00f3n');

  function collect() {
    const a = adapterSel.value;
    return Object.assign({}, p, {
      name: nameInp.value.trim() || adapterLabel(a),
      adapter: a,
      baseUrl: a === 'openai-compatible' ? baseInp.value.trim() : (a === 'azure-openai' ? endpointInp.value.trim() : (p.adapter === a ? p.baseUrl : '')),
      deployment: a === 'azure-openai' ? deployInp.value.trim() : '',
      apiVersion: a === 'azure-openai' ? (apiVerInp.value.trim() || '2024-06-01') : '',
      relayUrl: relayInp.value.trim(),
      batch: a === 'openai-compatible' ? !!batchChk.checked : undefined,
      trust: trustLoc.checked ? 'local' : 'external',
      models: models.map(m => Object.assign({}, m))
    });
  }

  testBtn.addEventListener('click', async () => {
    const cand = collect();
    const key = keyInp.value.trim() || (removeKey ? '' : (p.id ? await reg.getApiKey(p.id) : ''));
    testBtn.disabled = true; testBtn.textContent = 'Probando\u2026';
    msg.className = 'note'; msg.textContent = 'Probando la conexi\u00f3n\u2026';
    const r = await testConnection(cand, testSel.value, key, { onUsage: (u) => recordUsage({ module: OTHER_MODULE, provider: cand.id || 'nuevo', model: testSel.value, usage: u }) });
    msg.className = r.ok ? 'note' : 'note err';
    msg.textContent = (r.ok ? '\u2713 ' : '\u2717 ') + r.message;
    testBtn.disabled = false; testBtn.textContent = 'Probar conexi\u00f3n';
  });

  const body = el('div',
    el('div.form-grid',
      el('div.field', el('label.lbl', 'Nombre'), nameInp),
      el('div.field', el('label.lbl', 'Tipo'), adapterSel)),
    fPreset, fBase, fBatch, fAzure,
    el('div.field', el('label.lbl', 'Clave de API'), el('div.row', el('div.grow', keyInp), keyState, removeKeyBtn),
      el('p.info', 'La clave se guarda solo en este navegador. No viaja en el archivo de sincronizaci\u00f3n, salvo cifrada si lo activas en Ajustes > Sincronizaci\u00f3n.')),
    el('div.field', el('label.lbl', 'Confianza'),
      el('div.row', el('label.row', trustExt, 'Externo'), el('label.row', trustLoc, 'Local')),
      el('p.info', TRUST_HELP)),
    el('label.lbl', 'Modelos'), modelsBox,
    el('div.row', el('div.grow', newId), el('div.grow', newLabel), addModelBtn),
    el('details', { style: { margin: '10px 0' } }, el('summary', { style: { cursor: 'pointer', color: 'var(--primary)', fontSize: '12px' } }, 'Avanzado'), fRelay),
    el('div.row', { style: { marginTop: '8px' } }, el('span.lbl', { style: { margin: '0' } }, 'Probar con'), testSel, testBtn),
    msg);
  applyAdapter();

  let saved = null;
  await modal({
    title: isNew ? 'A\u00f1adir proveedor' : 'Editar ' + (p.name || 'proveedor'), help: helpBtn('provider-edit'),
    body, width: '680px',
    buttons: [
      { label: 'Cancelar', value: null },
      { label: 'Guardar', kind: 'primary', value: 'ok', onClick: async () => {
        const cand = collect();
        if (cand.adapter === 'openai-compatible' && !(cand.baseUrl || cand.relayUrl)) {
          msg.className = 'note err'; msg.textContent = 'Falta la URL base (por ejemplo, https://api.openai.com/v1).'; return false;
        }
        if (cand.adapter === 'azure-openai' && (!cand.baseUrl || !(cand.deployment || cand.models.length))) {
          msg.className = 'note err'; msg.textContent = 'Azure necesita el endpoint y el nombre del deployment.'; return false;
        }
        try {
          saved = await reg.saveProvider(cand);
          if (keyInp.value.trim()) await reg.setApiKey(saved.id, keyInp.value.trim());
          else if (removeKey) await reg.setApiKey(saved.id, '');
        } catch (e) {
          msg.className = 'note err'; msg.textContent = (e && e.message) || String(e); return false;
        }
        return true;
      } }
    ]
  });
  if (saved) toast('Proveedor guardado: ' + saved.name + '.', 'ok');
  return saved;
}

// ------------------------------------------------------------------ the screen

function _card(title, ...children) {
  return el('div.card', el('h3', title), el('div.body', ...children));
}

function _providerCard(s, rerender) {
  const p = s.profile;
  const models = reg.modelsOf(p);
  const keyPill = s.key
    ? el('span.pill.ok', 'Clave guardada')
    : (p.adapter === 'openai-compatible' && p.trust === 'local' ? el('span.pill.info', 'Sin clave (local)') : el('span.pill.gray', 'Sin clave'));
  const testSel = el('select.inp', { style: { maxWidth: '170px' } });
  for (const m of models) testSel.appendChild(el('option', { value: m.id }, m.label || m.id));
  const out = el('div');
  const testBtn = el('button.btn.sm', { disabled: models.length ? null : true }, 'Probar conexi\u00f3n');
  testBtn.addEventListener('click', async () => {
    testBtn.disabled = true; testBtn.textContent = 'Probando\u2026';
    out.className = 'info'; out.textContent = 'Probando la conexi\u00f3n\u2026';
    const r = await testConnection(p, testSel.value, s.key, { onUsage: (u) => recordUsage({ module: OTHER_MODULE, provider: p.id, model: testSel.value, usage: u }) });
    out.className = r.ok ? 'ok-t' : 'err-t';
    out.style.fontSize = '11px';
    out.style.marginTop = '6px';
    out.textContent = (r.ok ? '\u2713 ' : '\u2717 ') + r.message;
    testBtn.disabled = false; testBtn.textContent = 'Probar conexi\u00f3n';
  });
  const editBtn = el('button.btn.sm', { onclick: async () => { if (await openProviderModal(p)) rerender(); } }, 'Editar');
  const delBtn = p.builtIn
    ? el('button.btn.sm', { title: 'Ocultarlo (se puede volver a mostrar)', onclick: async () => { await reg.removeProvider(p.id); rerender(); } }, 'Ocultar')
    : el('button.btn.sm.danger', { onclick: async () => {
      if (await confirmDialog('Eliminar proveedor', 'Se borrar\u00e1n el perfil "' + p.name + '" y su clave de este navegador. Los m\u00f3dulos que lo usaban pasar\u00e1n al general.', 'Eliminar')) {
        await reg.removeProvider(p.id); rerender();
      }
    } }, 'Eliminar');
  const resetBtn = p.builtIn ? el('button.btn.sm.link', { title: 'Volver a la lista de modelos de serie', onclick: async () => {
    if (await confirmDialog('Restaurar proveedor', 'El perfil "' + p.name + '" vuelve a sus valores de serie (la clave se conserva).', 'Restaurar')) {
      await reg.resetProvider(p.id); rerender();
    }
  } }, 'Restaurar') : null;
  return el('div.pcard', { dataset: { provider: p.id } },
    el('div.row', el('b', p.name), el('span.trust.' + p.trust, TRUST_LABEL[p.trust] || p.trust)),
    el('div.row', { style: { marginTop: '4px' } }, el('span.kind', adapterLabel(p.adapter)), keyPill),
    el('div.muted', { style: { margin: '6px 0', fontSize: '11px', maxWidth: '280px' } },
      models.length ? models.map(m => m.label || m.id).join(' \u00b7 ') : 'Sin modelos'),
    el('div.row', models.length > 1 ? testSel : null, testBtn),
    el('div.row', { style: { marginTop: '6px' } }, editBtn, delBtn, resetBtn),
    out);
}

/** Builds Settings > Proveedores inside `container`. -> { refresh, destroy } */
export async function mount(container) {
  const root = el('div.umbra-settings-providers');
  clear(container).appendChild(root);
  let off = null;

  async function render() {
    if (!root.isConnected && off) { off(); off = null; return; }
    const [status, mm, hidden] = await Promise.all([
      reg.providersWithStatus(), reg.getModuleModels(), reg.listProviders({ includeHidden: true }).then(l => l.filter(p => p.hidden))
    ]);
    const frag = el('div');

    // Providers
    const cards = el('div.prov');
    for (const s of status) cards.appendChild(_providerCard(s, render));
    cards.appendChild(el('div.pcard.add', { onclick: async () => { if (await openProviderModal(null)) render(); } }, '+ A\u00f1adir proveedor'));
    const hiddenLine = hidden.length ? el('p.info', { style: { marginTop: '8px' } }, 'Ocultos: ',
      hidden.map(p => el('button.btn.link', { onclick: async () => { await reg.unhideProvider(p.id); render(); } }, 'Mostrar ' + p.name))) : null;
    frag.appendChild(_card(['Proveedores de IA', helpBtn('providers')],
      el('div.note', 'Cada proveedor es un perfil con sus modelos. Las claves se guardan solo en este navegador. ',
        'Algunos proveedores no aceptan llamadas desde una p\u00e1gina web (CORS): "Probar conexi\u00f3n" lo dice. Gemini y Anthropic s\u00ed las aceptan.'),
      cards, hiddenLine));

    // General provider
    const genSel = _modelSelect(status, mm.general, async (c) => { await reg.setGeneralModel(c); render(); },
      { firstLabel: 'El primero con clave' });
    frag.appendChild(_card(['Proveedor general', helpBtn('general-provider')],
      el('p.info', 'Lo usa todo m\u00f3dulo que no tenga un modelo propio, y el que tenga uno sin clave. Si no eliges ninguno, se usa el primer proveedor con clave.'),
      genSel));

    // Model per module
    const tbl = el('table.grid', el('tr', el('th', 'M\u00f3dulo'), el('th', ROLE_LABELS.triage), el('th', ROLE_LABELS.deep)));
    for (const m of AI_MODULES) {
      const slot = mm.map[m.id] || {};
      const cell = (role) => {
        if (!m.roles.includes(role)) return el('td.muted', '\u2014');
        const sel = _modelSelect(status, slot[role] || null, async (c) => { await reg.setModuleModel(m.id, role, c); render(); });
        sel.dataset.module = m.id;
        sel.dataset.role = role;
        return el('td', sel);
      };
      tbl.appendChild(el('tr',
        el('td', el('b', m.label), el('div.muted', { style: { fontSize: '11px' } }, m.desc)),
        cell('triage'), cell('deep')));
    }
    frag.appendChild(_card(['Modelo por m\u00f3dulo', helpBtn('module-models')],
      el('p.info', ROLE_LABELS.triage + ': pasada econ\u00f3mica por todo el texto. ' + ROLE_LABELS.deep +
        ': modelo fuerte sobre lo que se\u00f1alan el cribado o la capa local. "General" = el proveedor general. ' +
        'Si el proveedor elegido no tiene clave, el m\u00f3dulo usa el general y lo dice.'),
      tbl));

    clear(root).appendChild(frag);
  }

  off = reg.onRegistryChanged(debounce(() => render(), 80));
  await render();
  return { refresh: render, destroy: () => { if (off) off(); off = null; } };
}
