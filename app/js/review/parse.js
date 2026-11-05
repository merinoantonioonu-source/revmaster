/**
 * parse.js - Reads the line format the modules (and external AIs) answer with:
 *   <unit> | <CAT> | <SEV> | <quote> | <suggestion> | <reason>
 *   FIN <n>
 * Tolerant: Markdown table pipes, brackets around the unit ("[12]", "U12", "\u00a712"), Spanish
 * severity words, code fences, extra spaces. Lines that do not fit are ignored (and counted).
 */

const CATS = ['MIST', 'UNTR', 'OMI', 'ADD', 'ORT', 'GRA', 'PUNT', 'EST', 'LEC', 'COH', 'CONV'];
const CAT_ALIASES = {
  TRAD: 'MIST', ERROR: 'MIST', MISTRANSLATION: 'MIST', OMISION: 'OMI', OMISSION: 'OMI', ADICION: 'ADD', ADDITION: 'ADD',
  ORTOGRAFIA: 'ORT', SPELLING: 'ORT', GRAMATICA: 'GRA', GRAMMAR: 'GRA', PUNTUACION: 'PUNT', PUNCTUATION: 'PUNT',
  ESTILO: 'EST', STYLE: 'EST', LECTURA: 'LEC', COHERENCIA: 'COH', CONSISTENCY: 'COH', CONVENCIONES: 'CONV', CONVENTION: 'CONV'
};
const SEV_ALIASES = {
  CRI: 'CRI', CRITICO: 'CRI', CRITICA: 'CRI', CRITICAL: 'CRI', GRAVE: 'CRI',
  MAY: 'MAY', MAYOR: 'MAY', MAJOR: 'MAY',
  MEN: 'MEN', MENOR: 'MEN', MINOR: 'MEN', LEVE: 'MEN',
  SUG: 'SUG', SUGERENCIA: 'SUG', SUGGESTION: 'SUG', PREFERENCIAL: 'SUG'
};

function _fold(s) { return String(s || '').trim().toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }

function _cat(s) {
  const f = _fold(s).replace(/[^A-Z]/g, '');
  if (CATS.includes(f)) return f;
  return CAT_ALIASES[f] || null;
}

function _sev(s) {
  const f = _fold(s).replace(/[^A-Z]/g, '');
  return SEV_ALIASES[f] || null;
}

function _clean(s) {
  let t = String(s == null ? '' : s).trim();
  // Surrounding quotes or guillemets added by the model.
  t = t.replace(/^[\u00ab"\u201c'`]+/, '').replace(/[\u00bb"\u201d'`]+$/, '').trim();
  if (/^(?:-|\u2014|n\/a|ninguna?|vac[i\u00ed]a|\(vac[i\u00ed]a\)|none)$/i.test(t)) return '';
  return t;
}

/**
 * parseFindings(text, validUnits?) -> { items:[{ unit, cat, sev, quote, suggestion, reason }], fin, ignored }
 * validUnits: Set of unit numbers accepted (others are ignored).
 */
export function parseFindings(text, validUnits) {
  const items = [];
  let fin = null;
  let ignored = 0;
  const lines = String(text || '').replace(/```[a-z]*\n?/gi, '').split(/\r?\n/);
  for (let raw of lines) {
    let line = raw.trim();
    if (!line) continue;
    const fm = /^\**\s*FIN\s*[:\-]?\s*(\d+)\s*\**$/i.exec(line);
    if (fm) { fin = parseInt(fm[1], 10); continue; }
    if (line.indexOf('|') < 0) { ignored++; continue; }
    if (/^\|?\s*:?-{3,}/.test(line)) continue; // markdown separator
    line = line.replace(/^\|/, '').replace(/\|$/, '');
    const parts = line.split('|').map(s => s.trim());
    if (parts.length < 4) { ignored++; continue; }
    const um = /(\d+)/.exec(parts[0]);
    if (!um) { ignored++; continue; }
    const unit = parseInt(um[1], 10);
    const cat = _cat(parts[1]);
    const sev = _sev(parts[2]);
    if (!cat || !sev) { ignored++; continue; }
    if (validUnits && !validUnits.has(unit)) { ignored++; continue; }
    // A field may have contained '|' after all: everything past the 5th field is the reason.
    const quote = _clean(parts[3]);
    const suggestion = _clean(parts.length > 4 ? parts[4] : '');
    const reason = _clean(parts.length > 5 ? parts.slice(5).join(' / ') : '');
    // A "correction" identical to the quote proposes nothing: it is noise.
    const same = (a, b) => a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();
    if (quote && suggestion && same(quote, suggestion)) { ignored++; continue; }
    items.push({ unit, cat, sev, quote, suggestion, reason });
  }
  return { items, fin, ignored };
}

/** Verifier answers: <id> | OK|NO|EDITAR | <suggestion> | <reason> */
export function parseVerdicts(text) {
  const out = new Map();
  let fin = null;
  for (let line of String(text || '').replace(/```[a-z]*\n?/gi, '').split(/\r?\n/)) {
    line = line.trim();
    if (!line) continue;
    const fm = /^\**\s*FIN\s*[:\-]?\s*(\d+)/i.exec(line);
    if (fm) { fin = parseInt(fm[1], 10); continue; }
    if (line.indexOf('|') < 0) continue;
    const parts = line.replace(/^\|/, '').replace(/\|$/, '').split('|').map(s => s.trim());
    if (parts.length < 2) continue;
    const id = parts[0].replace(/[\[\]\s]/g, '');
    const v = _fold(parts[1]).replace(/[^A-Z]/g, '');
    const verdict = v.startsWith('OK') || v === 'SI' || v === 'CONFIRMADO' ? 'ok'
      : (v.startsWith('NO') || v === 'DESCARTAR' || v === 'FALSO') ? 'no'
      : (v.startsWith('EDIT') || v === 'CORREGIR') ? 'edit' : null;
    if (!verdict) continue;
    out.set(id, { verdict, suggestion: _clean(parts[2] || ''), reason: _clean(parts.slice(3).join(' / ')) });
  }
  return { verdicts: out, fin };
}
