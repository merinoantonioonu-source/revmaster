/**
 * xbckl.js - Imports an Xbench checklist (.xbckl) as UMBRA rules of kind 'pattern'.
 * Origin: COMeT modules/qa-checker/qa-parsers.js parseXBCKL @ 04540f5 (adapted: returns UMBRA rules).
 */

import { posixToJs, escapeRegex } from './powersearch.js';

function decodeEntities(str) {
  if (!str) return '';
  const ta = document.createElement('textarea');
  ta.innerHTML = str;
  return ta.value;
}

function _toRegex(term) {
  if (!term || !term.raw) return null;
  let src;
  if (term.searchmode === 'regexp') src = posixToJs(term.raw);
  else if (term.powersearch) {
    // Boolean syntax: positive terms in any order (AND), negatives and OR are not translated.
    const words = term.raw.split(/\s+/).filter(w => w && !w.startsWith('-') && w !== 'OR').map(w => escapeRegex(w.replace(/^"|"$/g, '')));
    src = words.length > 1 ? words.map(w => '(?=[\\s\\S]*' + w + ')').join('') + '[\\s\\S]*?' + words[0] : (words[0] || '');
  } else src = escapeRegex(term.raw);
  if (!src) return null;
  if (term.wholeword && term.searchmode !== 'regexp') src = '(?<![\\p{L}\\p{N}])' + src + '(?![\\p{L}\\p{N}])';
  return src;
}

export function parseXBCKL(xmlString, filename) {
  if (!xmlString || !xmlString.trim()) throw new Error('El archivo est\u00e1 vac\u00edo.');
  const doc = new DOMParser().parseFromString(xmlString, 'text/xml');
  if (doc.querySelector('parsererror')) throw new Error('XML no v\u00e1lido o da\u00f1ado.');
  const checks = doc.querySelectorAll('check');
  if (!checks.length) throw new Error('No hay reglas <check> en el archivo.');
  const base = filename ? filename.replace(/\.[^.]+$/, '') : 'Xbench';
  const out = [];
  checks.forEach((chk, idx) => {
    const srcTerm = chk.querySelector('term[type="source"]');
    const tgtTerm = chk.querySelector('term[type="target"]');
    const mk = (t) => t ? {
      raw: decodeEntities((t.textContent || '').trim()), wholeword: t.getAttribute('wholeword') === 'yes',
      powersearch: t.getAttribute('powersearch') === 'yes', searchmode: t.getAttribute('searchmode') || 'simple'
    } : null;
    const tgt = _toRegex(mk(tgtTerm));
    if (!tgt) return;
    const name = chk.getAttribute('name') || ('Regla ' + (idx + 1));
    const desc = decodeEntities((chk.querySelector('description') || {}).textContent || '').trim();
    out.push({ kind: 'pattern', origin: 'usuario', on: true, modules: ['style'], regex: tgt, srcRegex: _toRegex(mk(srcTerm)),
      note: (base + ': ' + name + (desc ? ' \u2014 ' + desc : '')).slice(0, 400), severity: 'MEN', profiles: [] });
  });
  return out;
}
