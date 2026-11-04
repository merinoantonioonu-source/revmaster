/**
 * spell.js - Local Spanish spell check (Hunspell dictionary + nspell), part of layer 0: free, no AI.
 *
 * The dictionary (app/data/hunspell/es.aff + es.dic, ~900 KB) is downloaded the first time it is
 * used and kept by the browser cache. Conservative on purpose: it only reports lower-case words of 3+
 * letters (capitalised words are names or sentence starts, which it checks in lower case), never
 * inside a masked entity, never words a rule says to ignore.
 */

import { reviewableUnits, unitTgt } from './session.js';
import { isIgnored } from '../rules/rules.js';

let _checker = null;
let _loading = null;

async function _load() {
  if (_checker) return _checker;
  if (_loading) return _loading;
  _loading = (async () => {
    const mod = await import('../../libs/nspell.esm.js');
    const nspell = mod.default;
    const base = new URL('../../data/hunspell/', import.meta.url);
    const [aff, dic] = await Promise.all([
      fetch(new URL('es.aff', base)).then(r => { if (!r.ok) throw new Error('es.aff'); return r.text(); }),
      fetch(new URL('es.dic', base)).then(r => { if (!r.ok) throw new Error('es.dic'); return r.text(); })
    ]);
    _checker = nspell(aff, dic);
    return _checker;
  })();
  try { return await _loading; } finally { _loading = null; }
}

const WORD_RE = /[a-z\u00e1\u00e9\u00ed\u00f3\u00fa\u00fc\u00f1A-Z\u00c1\u00c9\u00cd\u00d3\u00da\u00dc\u00d1]+(?:['\u2019-][a-z\u00e1\u00e9\u00ed\u00f3\u00fa\u00fc\u00f1]+)*/g;

/**
 * -> [finding] (module 'local', sub 'spelling'). extraWords: words to accept (personal list).
 */
export async function spellFindings(session, opts) {
  const o = opts || {};
  const sp = await _load();
  const accept = new Set((o.extraWords || []).map(w => w.toLowerCase()));
  const out = [];
  const seen = new Map();
  let suggested = 0;
  for (const u of reviewableUnits(session)) {
    if (u.tgtPara === null) continue;
    const text = unitTgt(session, u);
    const occ = session.ent.occ.tgt.get(u.tgtPara) || [];
    let m;
    WORD_RE.lastIndex = 0;
    while ((m = WORD_RE.exec(text)) !== null) {
      const w = m[0];
      const start = m.index, end = start + w.length;
      if (w.length < 3) continue;
      if (occ.some(x => start < x.end && end > x.start)) continue;
      if (/[A-Z\u00c1\u00c9\u00cd\u00d3\u00da\u00dc\u00d1]/.test(w.slice(1))) continue;      // acronyms, CamelCase
      const capital = /^[A-Z\u00c1\u00c9\u00cd\u00d3\u00da\u00dc\u00d1]/.test(w);
      const lw = w.toLowerCase();
      if (accept.has(lw)) continue;
      let okWord = seen.get(lw);
      if (okWord === undefined) {
        okWord = sp.correct(w) || sp.correct(lw) || (w.includes('-') && w.split('-').every(p => sp.correct(p) || sp.correct(p.toLowerCase())));
        seen.set(lw, okWord);
      }
      if (okWord) continue;
      // Abbreviations ("p\u00e1rr.", "art.", "prov."): a short unknown word followed by a full stop.
      if (w.length <= 6 && text.charAt(end) === '.') continue;
      // A capitalised unknown word is probably a name: only report it when it is not at the start of
      // a sentence (names are masked anyway) - i.e. never.
      if (capital) continue;
      let sug = '';
      if (suggested < 150) { suggested++; sug = (sp.suggest(w)[0]) || ''; }
      const f = { id: 'S' + Date.now().toString(36) + out.length.toString(36), module: 'local', sub: 'spelling', source: 'local', state: 'open',
        side: 'tgt', unit: u.idx, cat: 'ORT', sev: 'MEN', start, end, quote: w, suggestion: sug,
        reason: 'Palabra que no est\u00e1 en el diccionario espa\u00f1ol' + (sug ? '.' : ' (sin sugerencia).') };
      if (!isIgnored(o.rules, f)) out.push(f);
    }
  }
  return out;
}

export function spellReady() { return !!_checker; }
