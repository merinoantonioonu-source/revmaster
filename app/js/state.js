/**
 * state.js - The open project and everything derived from it, plus a tiny event bus.
 *
 * A project lives in IndexedDB ('projects' store) as:
 *   { id, name, createdAt, updatedAt, srcName, tgtName, srcBytes, tgtBytes, srcLang, profile,
 *     mask (entities.defaultMaskSettings shape), findings:[...], runs:[...] }
 * The documents are parsed again when a project is reopened (models are not stored).
 *
 * Events: 'project' (opened/closed), 'masked' (entities recomputed), 'findings' (list changed),
 *         'finding' (one changed), 'view', 'busy'.
 */

import { idbGet, idbPut, idbDel, idbAll } from './store/idb.js';
import { getValue, setValue, storage } from './store/storage.js';
import { parseDocument } from './formats/parse.js';
import { alignDocs } from './formats/align-docs.js';
import { buildSession, remask } from './review/session.js';
import { defaultMaskSettings } from './redact/entities.js';
import { guessLang } from './redact/detect.js';
import { uid } from './util/dom.js';

export const state = {
  project: null, src: null, tgt: null, session: null, findings: [],
  data: { gazetteer: [], conventions: {}, gazBase: [] },
  dict: [],
  view: 'files'
};

const _listeners = {};
export function on(evt, fn) { (_listeners[evt] = _listeners[evt] || []).push(fn); return () => { _listeners[evt] = _listeners[evt].filter(f => f !== fn); }; }
export function emit(evt, payload) { for (const fn of (_listeners[evt] || []).slice()) { try { fn(payload); } catch (e) { console.error(evt, e); } } }

// ------------------------------------------------------------------ reference data

export const DICT_KEY = 'entity_dict';
export const LISTS_KEY = 'lists';

export async function loadData() {
  const get = async (name, def) => {
    try { const r = await fetch(new URL('../data/' + name, import.meta.url)); return await r.json(); } catch (e) { console.warn(name, e); return def; }
  };
  const [gaz, conv] = await Promise.all([get('gazetteer.json', { entries: [] }), get('conventions.json', {})]);
  state.data.gazBase = (gaz && gaz.entries) || [];
  state.data.conventions = conv || {};
  await refreshLists();
  storage.onChanged(async (ch) => {
    if (ch[DICT_KEY] || ch[LISTS_KEY]) {
      await refreshLists();
      if (state.session) { remaskNow(); }
    }
  });
}

/** Built-in gazetteer with the translator's edits applied, and the personal dictionary. */
export async function refreshLists() {
  const lists = await getValue(LISTS_KEY, null);
  const ov = (lists && lists.gazetteer && lists.gazetteer.overrides) || {};
  const tomb = (lists && lists.gazetteer && lists.gazetteer.tombstones) || {};
  state.data.gazetteer = state.data.gazBase.filter(e => !tomb[e.id]).map(e => ov[e.id] ? Object.assign({}, e, ov[e.id], { id: e.id }) : e);
  const dict = await getValue(DICT_KEY, null);
  const dtomb = (dict && dict.tombstones) || {};
  state.dict = ((dict && dict.items) || []).filter(i => !dtomb[i.id]).map(i => Object.assign({ key: 'd:' + i.id }, i));
}

export async function saveGazetteerEdit(id, entry, remove) {
  const lists = (await getValue(LISTS_KEY, null)) || {};
  lists.gazetteer = lists.gazetteer || { overrides: {}, tombstones: {} };
  lists.gazetteer.overrides = lists.gazetteer.overrides || {};
  lists.gazetteer.tombstones = lists.gazetteer.tombstones || {};
  if (remove) { lists.gazetteer.tombstones[id] = Date.now(); delete lists.gazetteer.overrides[id]; }
  else if (entry === null) { delete lists.gazetteer.overrides[id]; delete lists.gazetteer.tombstones[id]; }
  else { lists.gazetteer.overrides[id] = entry; delete lists.gazetteer.tombstones[id]; }
  lists.updatedAt = Date.now();
  await setValue(LISTS_KEY, lists);
}

export async function saveDictItem(item, remove) {
  const dict = (await getValue(DICT_KEY, null)) || { items: [], tombstones: {} };
  dict.items = dict.items || [];
  dict.tombstones = dict.tombstones || {};
  if (remove) {
    dict.items = dict.items.filter(i => i.id !== item.id);
    dict.tombstones[item.id] = Date.now();
  } else {
    const it = Object.assign({}, item, { updatedAt: Date.now() });
    if (!it.id) it.id = uid('d');
    const i = dict.items.findIndex(x => x.id === it.id);
    if (i >= 0) dict.items[i] = it; else dict.items.push(it);
    delete dict.tombstones[it.id];
  }
  dict.updatedAt = Date.now();
  await setValue(DICT_KEY, dict);
}

// ------------------------------------------------------------------ projects

function _file(name, bytes) {
  return { name, arrayBuffer: async () => bytes.slice(0) };
}

/** Opens a new project from the two files (File objects). */
export async function openFiles(srcFile, tgtFile) {
  const srcBytes = await srcFile.arrayBuffer();
  const tgtBytes = await tgtFile.arrayBuffer();
  const project = {
    id: uid('p'), name: tgtFile.name.replace(/\.[^.]+$/, ''), createdAt: Date.now(), updatedAt: Date.now(),
    srcName: srcFile.name, tgtName: tgtFile.name, srcBytes, tgtBytes, srcLang: null,
    profile: (await getValue('last_profile', '')) || '', mask: defaultMaskSettings(), findings: [], runs: []
  };
  await _load(project);
  await saveProject();
  return project;
}

async function _load(project) {
  emit('busy', 'Leyendo los documentos\u2026');
  try {
    const src = await parseDocument(_file(project.srcName, project.srcBytes));
    const tgt = await parseDocument(_file(project.tgtName, project.tgtBytes));
    if (src.kind !== tgt.kind) throw new Error('Los dos archivos deben tener el mismo formato (' + src.kind.toUpperCase() + ' y ' + tgt.kind.toUpperCase() + ').');
    if (!project.srcLang) project.srcLang = guessLang(src.paras.map(p => p.text).join(' '));
    const alignment = alignDocs(src, tgt);
    state.project = project;
    state.src = src;
    state.tgt = tgt;
    state.session = buildSession({ src, tgt, alignment, srcLang: project.srcLang, mask: project.mask,
      gazetteer: state.data.gazetteer, dict: state.dict });
    state.findings = project.findings || [];
    await setValue('last_project', project.id);
    emit('project', project);
    emit('masked');
    emit('findings');
  } finally {
    emit('busy', null);
  }
}

export async function replaceFile(side, file) {
  if (!state.project) return;
  const bytes = await file.arrayBuffer();
  if (side === 'src') { state.project.srcName = file.name; state.project.srcBytes = bytes; state.project.srcLang = null; }
  else { state.project.tgtName = file.name; state.project.tgtBytes = bytes; }
  state.project.findings = [];
  await _load(state.project);
  await saveProject();
}

export async function saveProject() {
  const p = state.project;
  if (!p) return;
  p.findings = state.findings;
  p.updatedAt = Date.now();
  await idbPut('projects', p.id, p);
}

let _saveTimer = null;
export function saveProjectSoon() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => { saveProject().catch(e => console.error('save project', e)); }, 600);
}

export async function restoreLastProject() {
  const id = await getValue('last_project', null);
  if (!id) return false;
  const p = await idbGet('projects', id).catch(() => null);
  if (!p) return false;
  await _load(p);
  return true;
}

export async function openProject(id) {
  const p = await idbGet('projects', id);
  if (!p) throw new Error('No se encontr\u00f3 el proyecto.');
  await _load(p);
}

export async function listProjects() {
  const all = await idbAll('projects').catch(() => ({}));
  return Object.values(all).map(p => ({ id: p.id, name: p.name, srcName: p.srcName, tgtName: p.tgtName, updatedAt: p.updatedAt,
    findings: (p.findings || []).length })).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteProject(id) {
  await idbDel('projects', id);
  if (state.project && state.project.id === id) closeProject();
}

export function closeProject() {
  state.project = null; state.src = null; state.tgt = null; state.session = null; state.findings = [];
  setValue('last_project', null);
  emit('project', null);
}

/** Imports a project object (from a .umbra file) and opens it. */
export async function importProjectObject(p) {
  p.id = p.id || uid('p');
  await idbPut('projects', p.id, p);
  await _load(p);
}

// ------------------------------------------------------------------ masking and findings

export function remaskNow() {
  if (!state.session) return;
  remask(state.session, { mask: state.project.mask, gazetteer: state.data.gazetteer, dict: state.dict });
  emit('masked');
  saveProjectSoon();
}

export function setMask(patch) {
  Object.assign(state.project.mask, patch);
  remaskNow();
}

export function addFindings(list, replaceModules) {
  if (replaceModules && replaceModules.length) {
    // A new run of a module replaces its OPEN findings (decisions already taken are kept).
    state.findings = state.findings.filter(f => !(replaceModules.includes(f.module) && f.state === 'open'));
  }
  state.findings = state.findings.concat(list);
  emit('findings');
  saveProjectSoon();
}

export function updateFinding(id, patch) {
  const f = state.findings.find(x => x.id === id);
  if (!f) return;
  Object.assign(f, patch);
  emit('finding', f);
  saveProjectSoon();
}

export function setProfile(profile) {
  if (!state.project) return;
  state.project.profile = profile;
  setValue('last_profile', profile);
  saveProjectSoon();
}
