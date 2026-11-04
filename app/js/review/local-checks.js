/**
 * local-checks.js - Layer 0: everything that can be checked without any AI, for free.
 *
 * runLocalChecks(session, { rules, conventions, profile }) -> [finding]
 *
 * A finding (shared with the AI modules):
 *   { id, module, sub, cat, sev, unit, side:'tgt', start, end, quote, suggestion, reason, source, state }
 * start/end are offsets in the ORIGINAL target paragraph text (null when the finding is about a
 * missing piece, e.g. an omission).
 */

import { SrxSegmenter } from '../core/srx-segmenter.js';
import { unitSrc, unitTgt, reviewableUnits, listLabelOf } from './session.js';
import { patternOf, outliers, PATTERN_LABELS, setOperativeVerbs } from './parallel.js';
import { mainForm } from '../redact/entities.js';
import { evalRuleLocal, isIgnored } from '../rules/rules.js';

let _seq = 0;
function _id() { return 'L' + Date.now().toString(36) + (_seq++).toString(36); }

function F(unit, o) {
  return Object.assign({ id: _id(), module: 'local', source: 'local', state: 'open', side: 'tgt', unit: unit.idx,
    start: null, end: null, quote: '', suggestion: '', reason: '' }, o);
}

/** UN Spanish number format: '.' thousands (not in years 1800-2199), ',' decimals. */
export function esNumber(value) {
  if (!isFinite(value)) return '';
  const fmt = (v) => {
    const neg = v < 0;
    const abs = Math.abs(v);
    let [i, d] = String(Math.round(abs * 1e6) / 1e6).split('.');
    if (!(i.length === 4 && +i >= 1800 && +i <= 2199 && !d)) i = i.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return (neg ? '-' : '') + i + (d ? ',' + d : '');
  };
  if (value >= 1e9 && value % 1e7 === 0) return fmt(value / 1e9) + ' mil millones';
  if (value >= 1e6 && value % 1e4 === 0) {
    const v = value / 1e6;
    return fmt(v) + (v === 1 ? ' mill\u00f3n' : ' millones');
  }
  return fmt(value);
}

function _numValue(key) { return parseFloat(String(key).slice(4)); }

export function runLocalChecks(session, opts) {
  const o = opts || {};
  const out = [];
  const units = reviewableUnits(session);
  const ent = session.ent;
  if (o.conventions && o.conventions.operative) setOperativeVerbs(o.conventions.operative.map(v => v.es));

  // ---- 1. Entities and figures, unit by unit
  for (const u of units) {
    if (u.srcPara === null || u.tgtPara === null) continue;
    const so = ent.occ.src.get(u.srcPara) || [];
    const to = ent.occ.tgt.get(u.tgtPara) || [];
    const sKeys = new Map(), tKeys = new Map();
    // Numbers written in words ("twice" / "dos veces") vary legitimately: only figures in digits count.
    const counted = (x) => !x.key.startsWith('num:') || /\d/.test(x.surface);
    for (const x of so) if (counted(x)) sKeys.set(x.key, (sKeys.get(x.key) || 0) + 1);
    for (const x of to) if (counted(x)) tKeys.set(x.key, (tKeys.get(x.key) || 0) + 1);
    const missing = [...sKeys.keys()].filter(k => !tKeys.has(k));
    const extra = [...tKeys.keys()].filter(k => !sKeys.has(k));
    const missNum = missing.filter(k => k.startsWith('num:'));
    const extraNum = extra.filter(k => k.startsWith('num:'));
    // Figures: pair a missing one with an extra one -> "different figure".
    const usedExtra = new Set();
    for (const k of missNum) {
      const e = ent.byKey.get(k);
      const ex = extraNum.find(x => !usedExtra.has(x));
      if (ex) {
        usedExtra.add(ex);
        const occ = to.find(x => x.key === ex);
        out.push(F(u, { sub: 'numbers', cat: 'MIST', sev: 'CRI', start: occ.start, end: occ.end, quote: occ.surface,
          suggestion: esNumber(_numValue(k)),
          reason: 'Cifra distinta: el original dice ' + mainForm(e.srcForms) + ' (' + e.tagSrc + ').' }));
      } else {
        out.push(F(u, { sub: 'numbers', cat: 'OMI', sev: 'CRI',
          reason: 'Falta una cifra del original: ' + mainForm(e.srcForms) + ' (' + e.tagSrc + ').' }));
      }
    }
    for (const k of extraNum) {
      if (usedExtra.has(k)) continue;
      const occ = to.find(x => x.key === k);
      out.push(F(u, { sub: 'numbers', cat: 'ADD', sev: 'MAY', start: occ.start, end: occ.end, quote: occ.surface,
        reason: 'Cifra que no est\u00e1 en el original (' + ent.byKey.get(k).tagTgt + ').' }));
    }
    for (const k of missing.filter(k => !k.startsWith('num:'))) {
      if (tKeys.has(k)) continue;
      const e = ent.byKey.get(k);
      if (!e) continue;
      out.push(F(u, { sub: 'tags', cat: 'OMI', sev: e.cat === 'FECHA' || e.cat === 'SIMB' ? 'CRI' : 'MAY',
        reason: 'Falta ' + e.tagSrc + ' (' + mainForm(e.srcForms) + ') en la traducci\u00f3n de este p\u00e1rrafo.' }));
    }
    for (const k of extra.filter(k => !k.startsWith('num:'))) {
      const e = ent.byKey.get(k);
      if (!e) continue;
      const occ = to.find(x => x.key === k);
      out.push(F(u, { sub: 'tags', cat: 'ADD', sev: 'MEN', start: occ.start, end: occ.end, quote: occ.surface,
        reason: e.tagTgt + ' (' + occ.surface + ') no aparece en el original de este p\u00e1rrafo.' }));
    }
  }

  // ---- 2. Entities translated in several ways across the document
  for (const e of ent.entities) {
    if (e.status !== 'forms') continue;
    const forms = Object.keys(e.tgtForms);
    const main = mainForm(e.tgtForms);
    for (const u of units) {
      if (u.tgtPara === null) continue;
      for (const x of (ent.occ.tgt.get(u.tgtPara) || [])) {
        if (x.key !== e.key || x.surface === main) continue;
        out.push(F(u, { sub: 'tags', cat: 'COH', sev: 'MEN', start: x.start, end: x.end, quote: x.surface, suggestion: main,
          reason: e.tagTgt + ' aparece con ' + forms.length + ' formas distintas; la m\u00e1s frecuente es \u00ab' + main + '\u00bb.' }));
      }
    }
  }

  // ---- 3. Paragraph level: missing, untranslated, length, sentences
  const segSrc = new SrxSegmenter(session.srcLang === 'fr' ? 'FR' : 'EN');
  const segTgt = new SrxSegmenter('ES');
  const ratios = [];
  for (const u of units) {
    const s = unitSrc(session, u), t = unitTgt(session, u);
    if (s.length >= 60 && t.length) ratios.push(t.length / s.length);
  }
  ratios.sort((a, b) => a - b);
  const median = ratios.length ? ratios[Math.floor(ratios.length / 2)] : 1.15;
  for (const u of units) {
    const s = unitSrc(session, u).trim(), t = unitTgt(session, u).trim();
    const letters = (x) => (x.match(/\p{L}/gu) || []).length;
    if (s && u.tgtPara === null && letters(s) > 3) {
      out.push(F(u, { sub: 'paragraphs', cat: 'OMI', sev: 'CRI', side: 'src',
        reason: 'P\u00e1rrafo del original sin pareja en la traducci\u00f3n: \u00ab' + s.slice(0, 90) + (s.length > 90 ? '\u2026' : '') + '\u00bb' }));
      continue;
    }
    if (t && u.srcPara === null && letters(t) > 3) {
      out.push(F(u, { sub: 'paragraphs', cat: 'ADD', sev: 'MEN',
        reason: 'P\u00e1rrafo de la traducci\u00f3n sin pareja en el original.' }));
      continue;
    }
    if (!s || !t) {
      if (s && !t && letters(s) > 3) out.push(F(u, { sub: 'paragraphs', cat: 'OMI', sev: 'CRI', reason: 'P\u00e1rrafo vac\u00edo en la traducci\u00f3n.' }));
      continue;
    }
    if (s === t && letters(s) > 12 && !/^[\p{Lu}\d\s\W]+$/u.test(s)) {
      out.push(F(u, { sub: 'untranslated', cat: 'UNTR', sev: 'MAY', start: 0, end: unitTgt(session, u).length,
        quote: t.slice(0, 120), reason: 'El p\u00e1rrafo es id\u00e9ntico al original: \u00bfsin traducir?' }));
      continue;
    }
    const ns = segSrc.segment(s).length, nt = segTgt.segment(t).length;
    const fewerSentences = ns >= 2 && nt / ns < 0.75;
    if (s.length >= 60) {
      const r = t.length / s.length;
      if (r < median * 0.62 && !fewerSentences) {
        out.push(F(u, { sub: 'length', cat: 'OMI', sev: 'MAY',
          reason: 'La traducci\u00f3n es mucho m\u00e1s corta de lo normal en este documento (' + Math.round(r * 100) + ' % del original): posible omisi\u00f3n.' }));
      } else if (r > median * 1.6) {
        out.push(F(u, { sub: 'length', cat: 'ADD', sev: 'MEN',
          reason: 'La traducci\u00f3n es mucho m\u00e1s larga de lo normal en este documento (' + Math.round(r * 100) + ' % del original): posible adici\u00f3n.' }));
      }
    }
    if (fewerSentences) {
      out.push(F(u, { sub: 'sentences', cat: 'OMI', sev: 'MAY',
        reason: 'El original tiene ' + ns + ' oraciones y la traducci\u00f3n ' + nt + ': compruebe que no falte ninguna.' }));
    }
  }

  // ---- 4. Hygiene: doubled words, spacing, punctuation pairs
  for (const u of units) {
    if (u.tgtPara === null) continue;
    const t = unitTgt(session, u);
    let m;
    const dbl = /(?<![\p{L}\p{N}])([\p{L}]+)\s+\1(?![\p{L}\p{N}])/giu;
    while ((m = dbl.exec(t)) !== null) {
      if (/^(nos|que|se)$/i.test(m[1])) continue;
      out.push(F(u, { sub: 'hygiene', cat: 'ORT', sev: 'MEN', start: m.index, end: m.index + m[0].length, quote: m[0],
        suggestion: m[1], reason: 'Palabra repetida.' }));
    }
    const sp = / +([,.;:])(?!\d)/g;
    while ((m = sp.exec(t)) !== null) {
      out.push(F(u, { sub: 'hygiene', cat: 'PUNT', sev: 'MEN', start: m.index, end: m.index + m[0].length, quote: m[0],
        suggestion: m[1], reason: 'Espacio antes de un signo de puntuaci\u00f3n.' }));
    }
    const dsp = /(?<=\S) {2,}(?=\S)/g;
    while ((m = dsp.exec(t)) !== null) {
      out.push(F(u, { sub: 'hygiene', cat: 'PUNT', sev: 'SUG', start: m.index, end: m.index + m[0].length, quote: m[0],
        suggestion: ' ', reason: 'Espacio doble.' }));
    }
    const pairs = [['\u00bf', '?', 'Falta el signo de apertura o de cierre de interrogaci\u00f3n.'], ['\u00a1', '!', 'Falta el signo de apertura o de cierre de exclamaci\u00f3n.'],
      ['(', ')', 'Par\u00e9ntesis sin cerrar o sin abrir.'], ['\u00ab', '\u00bb', 'Comillas angulares sin cerrar.'], ['\u201c', '\u201d', 'Comillas sin cerrar.']];
    const body = t.slice(listLabelOf(t).length);
    for (const [a, b, why] of pairs) {
      const na = body.split(a).length - 1, nb = body.split(b).length - 1;
      if (na !== nb && (na || nb)) out.push(F(u, { sub: 'hygiene', cat: 'PUNT', sev: 'MEN', reason: why }));
    }
  }

  // ---- 5. Same source, different translation (consistency)
  const bySrc = new Map();
  for (const u of units) {
    if (u.srcPara === null || u.tgtPara === null) continue;
    const s = unitSrc(session, u).trim();
    if (s.length < 25) continue;
    if (!bySrc.has(s)) bySrc.set(s, []);
    bySrc.get(s).push(u);
  }
  for (const list of bySrc.values()) {
    if (list.length < 2) continue;
    const variants = new Map();
    for (const u of list) {
      const t = unitTgt(session, u).trim();
      if (!variants.has(t)) variants.set(t, []);
      variants.get(t).push(u);
    }
    if (variants.size < 2) continue;
    const major = [...variants.entries()].sort((a, b) => b[1].length - a[1].length)[0];
    for (const [t, us] of variants) {
      if (t === major[0]) continue;
      for (const u of us) {
        out.push(F(u, { sub: 'consistency', cat: 'COH', sev: 'MEN', start: 0, end: unitTgt(session, u).length,
          quote: t.slice(0, 160), suggestion: major[0],
          reason: 'El mismo original aparece ' + list.length + ' veces y se ha traducido de ' + variants.size + ' formas (p\u00e1rrafo ' + major[1][0].n + ').' }));
      }
    }
  }

  // ---- 6. Parallelism of siblings
  const groups = new Map();
  for (const u of units) if (u.group && u.tgtPara !== null) {
    if (!groups.has(u.group)) groups.set(u.group, []);
    groups.get(u.group).push(u);
  }
  for (const [g, list] of groups) {
    const pt = list.map(u => patternOf(unitTgt(session, u), 'es'));
    const ps = list.map(u => u.srcPara !== null ? patternOf(unitSrc(session, u), session.srcLang) : 'OTRO');
    const outs = outliers(pt);
    for (const x of outs) {
      const u = list[x.i];
      const srcAlsoDiffers = ps[x.i] !== 'OTRO' && outliers(ps).some(y => y.i === x.i);
      const t = unitTgt(session, u);
      const label = (t.match(/^[\s\t]*(?:\(?[a-z0-9ivx]{1,3}[.)]|[\u2022\u2013\-*])?[\s\t]*/i) || [''])[0];
      const word = (t.slice(label.length).match(/^[\p{L}'-]+/u) || [''])[0];
      out.push(F(u, { sub: 'parallel', cat: 'COH', sev: srcAlsoDiffers ? 'SUG' : 'MAY', group: g,
        start: label.length, end: label.length + word.length, quote: word,
        reason: 'Paralelismo: este elemento empieza por ' + PATTERN_LABELS[x.pattern] + ' y sus ' + (list.length - 1) +
          ' hermanos, en su mayor\u00eda, por ' + PATTERN_LABELS[x.majority] + '.' + (srcAlsoDiffers ? ' (En el original tambi\u00e9n difiere.)' : '') }));
    }
  }

  // ---- 7. UN conventions (resolutions)
  const conv = o.conventions || {};
  const pre = new Set((conv.preambular || []).map(x => _fold(x.es)));
  const preMasc = new Set((conv.preambular || []).filter(x => x.esMasc).map(x => _fold(x.esMasc)));
  const op = new Set((conv.operative || []).map(x => _fold(x.es)));
  for (const u of units) {
    if (!u.part || u.tgtPara === null) continue;
    const p = session.tgt.paras[u.tgtPara];
    const t = p.text;
    const label = (t.match(/^[\s\t]*(?:\d{1,3}\.)?[\s\t]*/) || [''])[0];
    const body = t.slice(label.length);
    const startsWith = (set) => { const f = _fold(body); for (const x of set) if (f.startsWith(x + ' ') || f.startsWith(x + ',') || f === x) return x; return null; };
    const firstWord = (body.match(/^[\p{L}'-]+/u) || [''])[0];
    if (u.part === 'pre' && pre.size) {
      const hit = startsWith(pre) || startsWith(preMasc);
      if (!hit) out.push(F(u, { sub: 'conventions', cat: 'CONV', sev: 'SUG', start: label.length, end: label.length + firstWord.length, quote: firstWord,
        reason: 'P\u00e1rrafo del pre\u00e1mbulo: no empieza por una de las f\u00f3rmulas habituales (Recordando, Reafirmando...). Compruebe la forma.' }));
    }
    if (u.part === 'op' && op.size) {
      const hit = startsWith(op);
      if (!hit) out.push(F(u, { sub: 'conventions', cat: 'CONV', sev: 'MEN', start: label.length, end: label.length + firstWord.length, quote: firstWord,
        reason: 'P\u00e1rrafo dispositivo: deber\u00eda empezar por un verbo en presente (Decide, Solicita, Exhorta...).' }));
    }
    // Italics of the opening word(s).
    const runs = p.runs || [];
    let pos = 0, italicOk = null;
    for (const r of runs) {
      const len = (r.t || '').length;
      if (pos + len > label.length && /\p{L}/u.test((r.t || '').slice(Math.max(0, label.length - pos)))) { italicOk = !!r.i; break; }
      pos += len;
    }
    if (italicOk === false) {
      out.push(F(u, { sub: 'conventions', cat: 'CONV', sev: 'MEN', start: label.length, end: label.length + firstWord.length, quote: firstWord,
        reason: (u.part === 'pre' ? 'Pre\u00e1mbulo' : 'Parte dispositiva') + ': la primera palabra va en cursiva.' }));
    }
  }

  // Fixed UN Spanish usage (conventions.json fixedPhrases): avoided forms -> the right one.
  const fixed = (conv.fixedPhrases || []).filter(x => x && x.es && Array.isArray(x.avoidEs) && x.avoidEs.length);
  if (fixed.length) {
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    const compiled = fixed.map(x => ({ x, re: new RegExp('(?<![\\p{L}\\p{N}])(?:' + x.avoidEs.map(esc).join('|') + ')(?![\\p{L}\\p{N}])', x.case ? 'gu' : 'giu') }));
    for (const u of units) {
      if (u.tgtPara === null) continue;
      const t = unitTgt(session, u);
      for (const { x, re } of compiled) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(t)) !== null) {
          if (m[0] === x.es) continue;
          out.push(F(u, { sub: 'conventions', cat: 'CONV', sev: 'MEN', start: m.index, end: m.index + m[0].length, quote: m[0], suggestion: x.es,
            reason: x.note || ('Uso de las Naciones Unidas: \u00ab' + x.es + '\u00bb.') }));
        }
      }
    }
  }

  // Figures: thousands separator in Spanish (4+ digits, not a year, not a reference).
  for (const u of units) {
    if (u.tgtPara === null) continue;
    const t = unitTgt(session, u);
    const re = /(?<![\d.,\/\p{L}])(\d{5,}|\d{4})(?![\d\p{L}\/])/gu;
    let m;
    while ((m = re.exec(t)) !== null) {
      const v = +m[1];
      if (m[1].length === 4 && v >= 1800 && v <= 2199) continue;
      // Postal codes and similar identifiers right after a place name ("New York 10017").
      if (m[1].length <= 5 && /\p{Lu}\p{Ll}+\s$/u.test(t.slice(Math.max(0, m.index - 20), m.index))) continue;
      const pr = session.tgt.paras[u.tgtPara];
      if (pr && pr.numeric) continue;
      if (/(?:p\u00e1rrafo|p\u00e1g\.|p\.|art\u00edculo|resoluci\u00f3n|n\u00fam\.|n\.\u00ba)\s*$/i.test(t.slice(Math.max(0, m.index - 14), m.index))) continue;
      out.push(F(u, { sub: 'numformat', cat: 'CONV', sev: 'SUG', start: m.index, end: m.index + m[1].length, quote: m[1],
        suggestion: esNumber(v), reason: 'En espa\u00f1ol de las Naciones Unidas, los millares se separan con punto (salvo a\u00f1os y referencias).' }));
    }
  }

  // ---- 8. Translator's rules that can be checked without AI
  const rules = (o.rules || []).filter(r => r.on && (r.kind === 'forbid' || r.kind === 'pattern' || r.kind === 'expr'));
  for (const u of units) {
    if (u.tgtPara === null) continue;
    const s = unitSrc(session, u), t = unitTgt(session, u);
    for (const r of rules) {
      for (const hit of evalRuleLocal(r, s, t)) {
        if (hit.soft) continue; // expr rule without a known wrong form: the AI decides
        out.push(F(u, { sub: 'rules', source: 'rule', rule: r.id, module: 'local', ruleModule: r.modules[0],
          cat: r.modules.includes('style') ? 'EST' : (r.modules.includes('conventions') ? 'CONV' : (r.modules.includes('grammar') ? 'GRA' : 'MIST')),
          sev: r.severity, start: hit.start, end: hit.end, quote: hit.quote, suggestion: hit.suggestion, reason: hit.reason }));
      }
    }
  }

  return out.filter(f => !isIgnored(o.rules, f));
}

function _fold(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }

export const LOCAL_SUBS = {
  numbers: 'Cifras', tags: 'Etiquetas', paragraphs: 'P\u00e1rrafos', untranslated: 'Sin traducir', length: 'Longitud',
  sentences: 'Oraciones', hygiene: 'Limpieza', consistency: 'Coherencia', parallel: 'Paralelismo',
  conventions: 'Convenciones', numformat: 'Formato de cifras', rules: 'Reglas'
};
