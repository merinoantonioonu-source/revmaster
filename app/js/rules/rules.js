/**
 * rules.js - One rule system for every module: built-in rules (app/data/rules-default.json, editable
 * and restorable) plus the translator's own rules.
 *
 * Storage key 'rules' = { updatedAt, overrides:{ id: rule }, user:[rule], tombstones:{ id: ts }, profiles:[name] }
 *  - overrides: the translator's edited copy of a built-in rule (carries baseHash = fingerprint of the
 *    built-in version it was edited from, so a newer built-in version can be announced).
 *  - tombstones: built-in or user rules the translator deleted (a deleted built-in rule never comes back).
 *
 * Rule = { id, origin:'serie'|'usuario', on, modules:[], kind:'expr'|'forbid'|'pattern'|'style'|'structure'|'ignore',
 *          src, es, avoid, regex, srcRegex, note, severity, profiles:[], updatedAt }
 *
 * The expression syntax of src / avoid / es is COMeT's (services/ai-rules.js sourcePattern):
 * forms separated by '|', '*' = any ending, whole words, any case, any spacing.
 */

import { storage, getValue, setValue } from '../store/storage.js';
import { fnv1a } from '../util/crypto.js';

export const RULES_KEY = 'rules';
export const KINDS = ['expr', 'forbid', 'pattern', 'style', 'structure', 'ignore'];
export const KIND_LABELS = {
  expr: 'Expresi\u00f3n', forbid: 'Prohibido', pattern: 'Patr\u00f3n', style: 'Estilo', structure: 'Estructura', ignore: 'Ignorar'
};
export const SEVERITIES = ['CRI', 'MAY', 'MEN', 'SUG'];
export const SEV_LABELS = { CRI: 'Cr\u00edtica', MAY: 'Mayor', MEN: 'Menor', SUG: 'Sugerencia' };
export const LIMITS = { src: 200, es: 200, avoid: 200, note: 400, regex: 300 };

let _defaults = null;

export async function loadDefaultRules() {
  if (_defaults) return _defaults;
  try {
    const r = await fetch(new URL('../../data/rules-default.json', import.meta.url));
    const j = await r.json();
    _defaults = normalizeRules((j && j.rules) || [], 'serie');
  } catch (e) {
    console.warn('rules-default.json not available', e);
    _defaults = [];
  }
  return _defaults;
}

function _clip(s, n) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n); }

export function normalizeRule(r, origin) {
  if (!r || typeof r !== 'object') return null;
  const kind = KINDS.includes(r.kind) ? r.kind : 'style';
  const out = {
    id: _clip(r.id, 80) || ('r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
    origin: origin || (r.origin === 'serie' ? 'serie' : 'usuario'),
    on: r.on !== false,
    modules: Array.isArray(r.modules) && r.modules.length ? r.modules.slice() : ['style'],
    kind,
    src: _clip(r.src, LIMITS.src),
    es: _clip(r.es, LIMITS.es),
    avoid: _clip(r.avoid, LIMITS.avoid),
    regex: r.regex ? String(r.regex).slice(0, LIMITS.regex) : null,
    srcRegex: r.srcRegex ? String(r.srcRegex).slice(0, LIMITS.regex) : null,
    note: _clip(r.note, LIMITS.note),
    severity: SEVERITIES.includes(r.severity) ? r.severity : 'MEN',
    profiles: Array.isArray(r.profiles) ? r.profiles.filter(Boolean) : [],
    updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : 0
  };
  if (r.baseHash) out.baseHash = r.baseHash;
  return out;
}

export function normalizeRules(list, origin) {
  const out = [];
  const seen = new Set();
  for (const r of (Array.isArray(list) ? list : [])) {
    const n = normalizeRule(r, origin);
    if (!n || seen.has(n.id)) continue;
    seen.add(n.id);
    out.push(n);
  }
  return out;
}

/** Fingerprint of the CONTENT of a rule (not its on/off state). */
export function ruleHash(r) {
  return fnv1a(JSON.stringify([r.kind, r.modules, r.src, r.es, r.avoid, r.regex, r.srcRegex, r.note, r.severity]));
}

export async function loadRulesStore() {
  const v = await getValue(RULES_KEY, null);
  const s = (v && typeof v === 'object') ? v : {};
  return {
    updatedAt: s.updatedAt || 0,
    overrides: (s.overrides && typeof s.overrides === 'object') ? s.overrides : {},
    user: normalizeRules(s.user || [], 'usuario'),
    tombstones: (s.tombstones && typeof s.tombstones === 'object') ? s.tombstones : {},
    profiles: Array.isArray(s.profiles) && s.profiles.length ? s.profiles : ['General', 'Resoluciones', 'Informes', 'Cartas']
  };
}

export async function saveRulesStore(store) {
  store.updatedAt = Date.now();
  await setValue(RULES_KEY, store);
  return store;
}

/**
 * The rules as the app uses them: built-in rules (with the translator's edits applied) then the
 * translator's own, minus the deleted ones. Each carries `status`:
 *   'serie' (untouched), 'mod' (edited built-in), 'usuario', and `newVersion` when the built-in rule
 *   changed after the translator edited it.
 */
export function effectiveRules(defaults, store) {
  const out = [];
  for (const d of defaults) {
    if (store.tombstones[d.id]) continue;
    const ov = store.overrides[d.id];
    if (ov) {
      const r = normalizeRule(Object.assign({}, ov, { id: d.id }), 'serie');
      r.status = 'mod';
      r.baseHash = ov.baseHash || null;
      r.newVersion = !!(ov.baseHash && ov.baseHash !== ruleHash(d));
      r.defaultRule = d;
      out.push(r);
    } else {
      out.push(Object.assign({}, d, { status: 'serie', newVersion: false }));
    }
  }
  for (const u of store.user) {
    if (store.tombstones[u.id]) continue;
    out.push(Object.assign({}, u, { status: 'usuario', newVersion: false }));
  }
  return out;
}

export async function getEffectiveRules() {
  const [d, s] = await Promise.all([loadDefaultRules(), loadRulesStore()]);
  return effectiveRules(d, s);
}

/** Saves an edited rule (built-in -> override; user -> replace or add). */
export async function upsertRule(rule) {
  const defaults = await loadDefaultRules();
  const store = await loadRulesStore();
  const now = Date.now();
  const def = defaults.find(d => d.id === rule.id);
  const clean = normalizeRule(Object.assign({}, rule, { updatedAt: now }), def ? 'serie' : 'usuario');
  if (def) {
    clean.baseHash = (store.overrides[def.id] && store.overrides[def.id].baseHash && !rule.adoptNew)
      ? store.overrides[def.id].baseHash : ruleHash(def);
    // An "edit" identical to the built-in rule is no edit: drop the override.
    if (ruleHash(clean) === ruleHash(def) && clean.on === def.on && JSON.stringify(clean.profiles) === JSON.stringify(def.profiles)) {
      delete store.overrides[def.id];
    } else {
      store.overrides[def.id] = clean;
    }
  } else {
    const i = store.user.findIndex(u => u.id === clean.id);
    if (i >= 0) store.user[i] = clean; else store.user.push(clean);
  }
  delete store.tombstones[clean.id];
  await saveRulesStore(store);
  return clean;
}

export async function setRuleOn(id, on) {
  const rules = await getEffectiveRules();
  const r = rules.find(x => x.id === id);
  if (!r) return;
  r.on = !!on;
  await upsertRule(r);
}

export async function deleteRule(id) {
  const store = await loadRulesStore();
  store.tombstones[id] = Date.now();
  delete store.overrides[id];
  store.user = store.user.filter(u => u.id !== id);
  await saveRulesStore(store);
}

/** Restores one built-in rule (or all of them when id is null; optionally only those of a module). */
export async function restoreDefault(id, moduleId) {
  const defaults = await loadDefaultRules();
  const store = await loadRulesStore();
  for (const d of defaults) {
    if (id && d.id !== id) continue;
    if (moduleId && !d.modules.includes(moduleId)) continue;
    delete store.overrides[d.id];
    delete store.tombstones[d.id];
  }
  await saveRulesStore(store);
}

export async function saveProfiles(profiles) {
  const store = await loadRulesStore();
  store.profiles = profiles;
  await saveRulesStore(store);
}

export function onRulesChanged(fn) {
  return storage.onChanged((ch) => { if (ch[RULES_KEY]) fn(); });
}

/** Active rules of a module for a profile ('' = all profiles). */
export function rulesFor(rules, moduleId, profile) {
  return (rules || []).filter(r => r.on && r.modules.includes(moduleId) &&
    (!r.profiles.length || !profile || r.profiles.includes(profile)));
}

// ------------------------------------------------------------------ patterns

function _plain(s) {
  return String(s || '').replace(/[\u2018\u2019\u02bc]/g, "'").replace(/[\u201c\u201d]/g, '"');
}
function _escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** COMeT sourcePattern: forms with '|', '*' = any ending; whole words; any case. Global flag. */
export function formsPattern(src) {
  const forms = _plain(src).split('|').map(s => s.trim()).filter(Boolean);
  const parts = [];
  for (const f of forms) {
    const words = f.split(/\s+/).filter(Boolean).map(w => w.split('*').map(_escRe).join('[\\p{L}\\p{N}]*'));
    if (words.length) parts.push(words.join('\\s+'));
  }
  if (!parts.length) return null;
  try {
    return new RegExp('(?<![\\p{L}\\p{N}])(?:' + parts.join('|') + ')(?![\\p{L}\\p{N}])', 'giu');
  } catch (_) { return null; }
}

function _safeRegex(src, flags) {
  if (!src) return null;
  try { return new RegExp(src, flags || 'giu'); } catch (_) { return null; }
}

/** Is the rule's expression present in this source text? (used to choose what travels to the AI) */
export function ruleMatchesSource(rule, srcText) {
  if (rule.kind === 'expr') {
    const re = formsPattern(rule.src);
    return !!re && re.test(_plain(srcText));
  }
  if (rule.srcRegex) {
    const re = _safeRegex(rule.srcRegex, 'iu');
    return !!re && re.test(srcText);
  }
  return true;
}

/**
 * Local (AI-free) evaluation of a rule on one unit. Returns [{ start, end, quote, suggestion, reason }]
 * on the TARGET text (original, unmasked). 'expr' rules report when the source has the expression and
 * the target lacks every accepted form AND (if given) contains the avoided form.
 */
export function evalRuleLocal(rule, srcText, tgtText) {
  const out = [];
  const tgt = _plain(tgtText || '');
  if (!tgt) return out;
  if (rule.kind === 'forbid' && rule.avoid) {
    const re = formsPattern(rule.avoid);
    if (!re) return out;
    let m;
    while ((m = re.exec(tgt)) !== null) {
      out.push({ start: m.index, end: m.index + m[0].length, quote: tgtText.slice(m.index, m.index + m[0].length),
        suggestion: (rule.es || '').split('|')[0].trim(), reason: rule.note || ('Evite \u00ab' + m[0] + '\u00bb.') });
      if (m[0].length === 0) re.lastIndex++;
    }
  } else if (rule.kind === 'pattern' && rule.regex) {
    if (rule.srcRegex && !ruleMatchesSource(rule, srcText || '')) return out;
    const re = _safeRegex(rule.regex, 'giu');
    if (!re) return out;
    let m;
    let guard = 0;
    while ((m = re.exec(tgt)) !== null && guard++ < 200) {
      out.push({ start: m.index, end: m.index + m[0].length, quote: tgtText.slice(m.index, m.index + m[0].length),
        suggestion: rule.es || '', reason: rule.note || 'Patr\u00f3n se\u00f1alado por una regla.' });
      if (m[0].length === 0) re.lastIndex++;
    }
  } else if (rule.kind === 'expr' && rule.src && rule.es) {
    if (!ruleMatchesSource(rule, srcText || '')) return out;
    const want = formsPattern(rule.es);
    if (want && want.test(tgt)) return out;
    const avoid = rule.avoid ? formsPattern(rule.avoid) : null;
    if (avoid) {
      let m;
      while ((m = avoid.exec(tgt)) !== null) {
        out.push({ start: m.index, end: m.index + m[0].length, quote: tgtText.slice(m.index, m.index + m[0].length),
          suggestion: rule.es.split('|')[0].trim(), reason: rule.note || ('Seg\u00fan sus reglas, aqu\u00ed corresponde \u00ab' + rule.es.split('|')[0] + '\u00bb.') });
      }
    } else {
      // Neither the wanted form nor a known wrong one: the AI decides (rule travels in the prompt).
      out.push({ start: null, end: null, quote: '', suggestion: rule.es.split('|')[0].trim(), soft: true,
        reason: rule.note || ('El original dice \u00ab' + rule.src.split('|')[0] + '\u00bb: \u00bfse ha usado \u00ab' + rule.es.split('|')[0] + '\u00bb?') });
    }
  }
  return out;
}

/** Does an 'ignore' rule silence this finding? (matches the quote or the reason) */
export function isIgnored(rules, finding) {
  for (const r of rules || []) {
    if (!r.on || r.kind !== 'ignore') continue;
    if (r.modules.length && finding.module && finding.module !== 'local' && !r.modules.includes(finding.module)) continue;
    const pat = r.avoid || r.src || r.es;
    if (!pat) continue;
    const re = formsPattern(pat);
    if (re && (re.test(_plain(finding.quote || '')) || re.test(_plain(finding.suggestion || '')))) return true;
  }
  return false;
}

// Nothing in a rule may look like the batch markers or the output separator.
function _safe(s) { return String(s || '').replace(/\[\[/g, '[ [').replace(/\]\]/g, '] ]').replace(/\|/g, '/'); }

/**
 * The RULES section of a prompt. style/structure rules always travel; expr rules only when their
 * expression appears in the batch's source texts; forbid/pattern/ignore never (checked locally).
 */
export function rulesBlock(rules, srcTexts) {
  const hay = _plain((srcTexts || []).join('\n'));
  const list = (rules || []).filter(r => {
    if (r.kind === 'style' || r.kind === 'structure') return !!r.note;
    if (r.kind === 'expr') { const re = formsPattern(r.src); return !!re && re.test(hay); }
    return false;
  });
  if (!list.length) return { text: '', count: 0 };
  const q = (s) => '\u00ab' + _safe(s) + '\u00bb';
  const lines = list.map(r => {
    if (r.kind === 'expr') {
      const forms = r.src.split('|').map(s => s.trim()).filter(Boolean).map(q).join(' / ');
      return '- Si el original dice ' + forms + ': escribir ' + q(r.es.split('|')[0]) +
        (r.avoid ? '; nunca ' + q(r.avoid.split('|')[0]) : '') + '.' + (r.note ? ' ' + _safe(r.note) : '');
    }
    return '- ' + _safe(r.note) + (r.es ? ' Escribir ' + q(r.es) + '.' : '') + (r.avoid ? ' Evitar ' + q(r.avoid) + '.' : '');
  });
  return {
    text: '\n\nREGLAS DEL TRADUCTOR (prevalecen sobre tus preferencias; se\u00f1ala su incumplimiento):\n' + lines.join('\n'),
    count: list.length
  };
}

/** Rough token cost of the rules that always travel with a module (for the editor's counter). */
export function alwaysRulesTokens(rules, moduleId, profile) {
  const list = rulesFor(rules, moduleId, profile).filter(r => r.kind === 'style' || r.kind === 'structure');
  const chars = list.reduce((n, r) => n + (r.note || '').length + (r.es || '').length + (r.avoid || '').length + 20, 0);
  return Math.round(chars / 3.8);
}

export function rulesHash(rules) {
  return fnv1a(JSON.stringify((rules || []).map(r => [r.id, r.on, ruleHash(r)])));
}
