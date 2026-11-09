/**
 * module-config.js - Per-module settings other than the model (the model lives in ai/registry.js):
 * storage key 'module_cfg' = { updatedAt, map:{ <moduleId>: cfg } }, travels in the sync file.
 *
 * cfg = { enabled, thinking:'minimal'|'low'|'high'|'', batchWords (0 = automatic), verify,
 *         budget (US$ per run, 0 = no limit), scope:'all'|'changed', context,
 *         strictness:'grave'|'normal'|'estricta' (how demanding: prompts.js STRICTNESS) }
 * Only the modules of today's list (module-list.js) are read: the settings of the reviewers merged or
 * removed in the simplification (2026-11-09) are left where they are and not used.
 */

import { getValue, setValue, storage } from '../store/storage.js';
import { MODULES } from './module-list.js';

export const CFG_KEY = 'module_cfg';

export const DEFAULTS = {
  meaning: { enabled: true, thinking: 'low', batchWords: 0, verify: true, budget: 0, scope: 'all', strictness: 'grave' },
  writing: { enabled: true, thinking: 'minimal', batchWords: 0, verify: true, budget: 0, scope: 'all', strictness: 'normal' },
  names: { enabled: true, thinking: 'low', batchWords: 0, verify: false, budget: 0, scope: 'all', strictness: 'normal' },
  verifier: { enabled: true, thinking: 'high', batchWords: 0, verify: false, budget: 0, scope: 'all' }
};

export const THINKING_LABELS = { '': 'Del modelo', minimal: 'M\u00ednimo', low: 'Bajo', high: 'Alto' };

export async function loadModuleConfig() {
  const v = await getValue(CFG_KEY, null);
  const map = (v && v.map) ? v.map : {};
  const out = {};
  for (const m of MODULES) out[m.id] = Object.assign({}, DEFAULTS[m.id] || {}, map[m.id] || {});
  return out;
}

export async function saveModuleConfig(moduleId, patch) {
  const v = await getValue(CFG_KEY, null);
  const map = (v && v.map) ? Object.assign({}, v.map) : {};
  map[moduleId] = Object.assign({}, map[moduleId] || {}, patch);
  await setValue(CFG_KEY, { updatedAt: Date.now(), map });
}

export function onModuleConfigChanged(fn) {
  return storage.onChanged((ch) => { if (ch[CFG_KEY]) fn(); });
}
