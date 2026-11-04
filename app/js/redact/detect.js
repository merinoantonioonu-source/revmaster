/**
 * detect.js - Finds the entities to mask in one paragraph of text, in English, French or Spanish.
 *
 * detectSpans(text, lang, ctx) -> [{ start, end, cat, key, surface, art, src }]
 *   cat  : NUM FECHA ORG ORGANO PAIS LUGAR PER CARGO SIMB URL X
 *   key  : the SAME string for the same entity in the three languages, so a source span and a
 *          target span can share one tag: 'num:1250', 'date:2024-03-12', 'g:<gazetteer id>',
 *          'sym:A/RES/78/1', 'url:www.un.org', 'per:smith', 'acr:UNAMA', 't:<project term id>'.
 *   art  : Spanish article of the entity ('el'|'la'|'los'|'las'|'') - only meaningful in Spanish.
 *   src  : which detector produced it ('gaz', 'num', 'date', 'sym', 'url', 'per', 'acr', 'term').
 *
 * Everything here is deterministic and runs in the browser: no text leaves the computer.
 * ctx = { gaz: compiled gazetteer (compileGazetteer), cats: Set of enabled categories,
 *         acronymsBoth: Set of unknown acronyms seen on both sides (or null = allow all),
 *         spelled: bool (numbers written in words) }
 */

// ------------------------------------------------------------------ helpers

const L = 'A-Za-z\u00c0-\u024f';
const UPPER = 'A-Z\u00c0-\u00de';

function _norm(s) {
  return String(s || '').replace(/[\u2018\u2019\u02bc]/g, "'").replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u00a0\u202f]/g, ' ');
}

function _fold(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// ------------------------------------------------------------------ gazetteer

/**
 * entries: [{ id, cat, art, artByForm, en:[], fr:[], es:[] }] (gazetteer + user dictionary + project
 * terms). keyOf(entry) gives the entity key ('g:<id>' by default).
 * Returns { byLang: { en: Map(firstToken -> [form]), fr, es } } where form = { text, entry, art }.
 */
export function compileGazetteer(entries, keyOf) {
  const byLang = { en: new Map(), fr: new Map(), es: new Map() };
  for (const e of entries || []) {
    if (!e || !e.cat) continue;
    const key = keyOf ? keyOf(e) : ('g:' + e.id);
    for (const lang of ['en', 'fr', 'es']) {
      for (const raw of (e[lang] || [])) {
        const text = _norm(raw).trim();
        if (text.length < 2) continue;
        const first = _firstToken(text);
        if (!first) continue;
        const k = first.toLowerCase();
        if (!byLang[lang].has(k)) byLang[lang].set(k, []);
        const art = (lang === 'es') ? ((e.artByForm && e.artByForm[raw]) || e.art || '') : '';
        byLang[lang].get(k).push({ text, key, cat: e.cat, art, isAcr: /^[A-Z0-9\-]{2,10}$/.test(text) });
      }
    }
  }
  for (const lang of Object.keys(byLang)) {
    for (const list of byLang[lang].values()) list.sort((a, b) => b.text.length - a.text.length);
  }
  return { byLang };
}

function _firstToken(s) {
  const m = /[\p{L}\p{N}]+/u.exec(s);
  return m ? m[0] : '';
}

function _gazSpans(text, lang, gaz) {
  const out = [];
  if (!gaz) return out;
  const table = gaz.byLang[lang] || gaz.byLang.en;
  const t = _norm(text);
  const lower = t.toLowerCase();
  const allCaps = /[A-Z]/.test(t) && t === t.toUpperCase();
  const re = /[\p{L}\p{N}]+/gu;
  let m;
  let skipUntil = 0;
  while ((m = re.exec(t)) !== null) {
    if (m.index < skipUntil) continue;
    // A token must start a word (not in the middle of "pre-General").
    const cands = table.get(m[0].toLowerCase());
    if (!cands) continue;
    for (const c of cands) {
      const end = m.index + c.text.length;
      if (end > t.length) continue;
      let hit;
      if (c.isAcr) hit = t.startsWith(c.text, m.index);
      else hit = t.startsWith(c.text, m.index) || ((allCaps || _looseCase(c.text)) && lower.startsWith(c.text.toLowerCase(), m.index));
      if (!hit) continue;
      const after = t.charAt(end);
      if (after && /[\p{L}\p{N}]/u.test(after)) continue;
      out.push({ start: m.index, end, cat: c.cat, key: c.key, art: c.art, src: 'gaz' });
      skipUntil = end;
      break;
    }
  }
  return out;
}

// Forms written in lower case in the list (French "Assembl\u00e9e g\u00e9n\u00e9rale" keeps a capital A, but a
// user term may be all lower case): match those whatever the case in the text.
function _looseCase(form) {
  return form === form.toLowerCase();
}

// ------------------------------------------------------------------ numbers

const NUM_RE = /(?<![\d.,\p{L}\/])(\d{1,3}(?:[ \u00a0\u202f.,]\d{3})+(?:[.,]\d+)?|\d+[.,]\d+|\d+)(?![\d\p{L}\/])/gu;

const MAGNITUDES = {
  en: [{ re: /^[ \u00a0]+(million|millions)\b/i, mult: 1e6 }, { re: /^[ \u00a0]+(billion|billions)\b/i, mult: 1e9 },
       { re: /^[ \u00a0]+(trillion|trillions)\b/i, mult: 1e12 }],
  fr: [{ re: /^[ \u00a0]+(million|millions)\b/i, mult: 1e6 }, { re: /^[ \u00a0]+(milliard|milliards)\b/i, mult: 1e9 },
       { re: /^[ \u00a0]+(billion|billions)\b/i, mult: 1e12 }],
  es: [{ re: /^[ \u00a0]+(mil[ \u00a0]+millones)\b/i, mult: 1e9 }, { re: /^[ \u00a0]+(millones|mill\u00f3n)\b/i, mult: 1e6 },
       { re: /^[ \u00a0]+(billones|bill\u00f3n)\b/i, mult: 1e12 }]
};

/** Numeric value of a digit token in the conventions of the language. */
export function numberValue(raw, lang) {
  let t = String(raw).replace(/[\u00a0\u202f ]/g, '');
  if (lang === 'en') return parseFloat(t.replace(/,/g, ''));
  // FR / ES: '.' or space for thousands, ',' for decimals.
  if (t.indexOf(',') > -1) return parseFloat(t.replace(/\./g, '').replace(',', '.'));
  const lastDot = t.lastIndexOf('.');
  if (lastDot > -1) {
    const after = t.length - lastDot - 1;
    if (after === 3) return parseFloat(t.replace(/\./g, ''));
    return parseFloat(t);
  }
  return parseFloat(t);
}

function _numKey(v) {
  if (!isFinite(v)) return null;
  const r = Math.round(v * 1e6) / 1e6;
  return 'num:' + String(r);
}

// A list label at the start of a paragraph ("1.", "12)", "(3)") is structure, not a figure.
const LIST_LABEL_RE = /^[\s\t]*\(?(\d{1,3})[.)](?=[\s\t])/;

function _numberSpans(text, lang) {
  const out = [];
  if (!/\d/.test(text)) return out;
  const t = _norm(text);
  const lab = LIST_LABEL_RE.exec(t);
  const labelEnd = lab ? lab.index + lab[0].length : -1;
  NUM_RE.lastIndex = 0;
  let m;
  while ((m = NUM_RE.exec(t)) !== null) {
    const start = m.index;
    let end = start + m[0].length;
    if (lab && start < labelEnd) continue;
    let value = numberValue(m[0], lang);
    // Magnitude word right after ("1.2 million", "1,2 millones", "3 milliards").
    const rest = t.slice(end, end + 24);
    for (const mg of (MAGNITUDES[lang] || MAGNITUDES.en)) {
      const mm = mg.re.exec(rest);
      if (mm) { value *= mg.mult; end += mm[0].length; break; }
    }
    const key = _numKey(value);
    if (!key) continue;
    out.push({ start, end, cat: 'NUM', key, art: '', src: 'num' });
  }
  return out;
}

// Numbers in words (cardinals from 2 up; never "one/un/una", never ordinals).
const WORDS = {
  en: { small: { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
    thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30,
    forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 }, hundred: ['hundred'], thousand: ['thousand'] },
  fr: { small: { deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, dix: 10, onze: 11, douze: 12,
    treize: 13, quatorze: 14, quinze: 15, seize: 16, vingt: 20, trente: 30, quarante: 40, cinquante: 50, soixante: 60 },
    hundred: ['cent', 'cents'], thousand: ['mille'] },
  es: { small: { dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, doce: 12,
    trece: 13, catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19, veinte: 20,
    treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80, noventa: 90,
    doscientos: 200, doscientas: 200, trescientos: 300, trescientas: 300, cuatrocientos: 400, quinientos: 500,
    seiscientos: 600, setecientos: 700, ochocientos: 800, novecientos: 900, cien: 100, ciento: 100 },
    hundred: [], thousand: ['mil'] }
};

function _spelledSpans(text, lang) {
  const out = [];
  const W = WORDS[lang];
  if (!W) return out;
  const re = new RegExp('[' + L + ']+', 'g');
  const toks = [];
  let m;
  while ((m = re.exec(text)) !== null) toks.push({ w: _fold(m[0]), start: m.index, end: m.index + m[0].length });
  const isNum = (w) => Object.prototype.hasOwnProperty.call(W.small, w) || W.hundred.includes(w) || W.thousand.includes(w);
  const CONNECT = { en: 'and', fr: 'et', es: 'y' };
  for (let i = 0; i < toks.length; i++) {
    if (!Object.prototype.hasOwnProperty.call(W.small, toks[i].w)) continue;
    let total = 0, cur = 0, j = i, last = null;
    while (j < toks.length) {
      const w = toks[j].w;
      if (last) {
        const gap = text.slice(last.end, toks[j].start);
        if (w === CONNECT[lang] && /^ $/.test(gap) && j + 1 < toks.length && isNum(toks[j + 1].w) &&
            /^ $/.test(text.slice(toks[j].end, toks[j + 1].start))) { j++; continue; }
        const gap2 = text.slice(last.end, toks[j].start);
        if (!/^(?:[ \u00a0-]| (?:and|et|y) )$/.test(gap2)) break;
      }
      if (!isNum(w)) break;
      if (Object.prototype.hasOwnProperty.call(W.small, w)) cur += W.small[w];
      else if (W.hundred.includes(w)) cur = (cur || 1) * 100;
      else { total += (cur || 1) * 1000; cur = 0; }
      last = toks[j];
      j++;
    }
    const value = total + cur;
    // Part of an ordinal or a compound word ("seventy-ninth", "vingt-deuxi\u00e8me"): not a cardinal.
    const glued = last && /^-[\p{L}]/u.test(text.slice(last.end, last.end + 2)) || (toks[i].start > 0 && /[\p{L}]-$/u.test(text.slice(Math.max(0, toks[i].start - 2), toks[i].start)));
    if (last && value >= 2 && !glued) out.push({ start: toks[i].start, end: last.end, cat: 'NUM', key: _numKey(value), art: '', src: 'num' });
    i = Math.max(i, j - 1);
  }
  return out;
}

// ------------------------------------------------------------------ dates

const MONTHS = {
  en: ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'],
  fr: ['janvier', 'f\u00e9vrier', 'mars', 'avril', 'mai', 'juin', 'juillet', 'ao\u00fbt', 'septembre', 'octobre', 'novembre', 'd\u00e9cembre'],
  es: ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre']
};

function _monthIdx(word, lang) {
  const w = String(word || '').toLowerCase();
  let i = MONTHS[lang].indexOf(w);
  if (i < 0 && lang === 'es' && w === 'setiembre') i = 8;
  if (i < 0 && lang === 'fr') i = MONTHS.fr.map(_fold).indexOf(_fold(w));
  return i;
}

function _dateKey(y, mo, d) {
  const p = (n) => String(n).padStart(2, '0');
  return 'date:' + (y ? y : '????') + '-' + (mo >= 0 ? p(mo + 1) : '??') + (d ? '-' + p(d) : '');
}

function _dateSpans(text, lang) {
  const out = [];
  const t = text;
  const mon = '(' + MONTHS[lang].join('|') + (lang === 'es' ? '|setiembre' : '') + ')';
  const res = [];
  if (lang === 'en') {
    res.push({ re: new RegExp('\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+' + mon + '(?:,?\\s+(\\d{4}))?\\b', 'gi'), d: 1, m: 2, y: 3 });
    res.push({ re: new RegExp('\\b' + mon + '\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,\\s*(\\d{4}))?\\b', 'gi'), m: 1, d: 2, y: 3 });
    res.push({ re: new RegExp('\\b' + mon + '\\s+(\\d{4})\\b', 'gi'), m: 1, y: 2 });
  } else if (lang === 'fr') {
    res.push({ re: new RegExp('\\b(\\d{1,2})(?:er)?\\s+' + mon + '(?:\\s+(\\d{4}))?(?![\\p{L}])', 'giu'), d: 1, m: 2, y: 3 });
    res.push({ re: new RegExp('(?<![\\p{L}])' + mon + '\\s+(\\d{4})\\b', 'giu'), m: 1, y: 2 });
  } else {
    res.push({ re: new RegExp('\\b(\\d{1,2})(?:\\.?\u00ba)?\\s+de\\s+' + mon + '(?:\\s+de(?:l)?\\s+(\\d{4}))?\\b', 'gi'), d: 1, m: 2, y: 3 });
    res.push({ re: new RegExp('\\b' + mon + '\\s+de(?:l)?\\s+(\\d{4})\\b', 'gi'), m: 1, y: 2 });
  }
  for (const r of res) {
    let m;
    r.re.lastIndex = 0;
    while ((m = r.re.exec(t)) !== null) {
      const mi = _monthIdx(m[r.m], lang);
      if (mi < 0) continue;
      // "May" in English is also a verb: only when a day or a year goes with it.
      if (lang === 'en' && mi === 4 && !(r.d && m[r.d]) && !(r.y && m[r.y])) continue;
      const d = r.d ? parseInt(m[r.d], 10) : 0;
      const y = r.y && m[r.y] ? parseInt(m[r.y], 10) : 0;
      if (d && (d < 1 || d > 31)) continue;
      out.push({ start: m.index, end: m.index + m[0].length, cat: 'FECHA', key: _dateKey(y, mi, d), art: '', src: 'date' });
    }
  }
  return out;
}

// ------------------------------------------------------------------ symbols, URLs, e-mails

const SYMBOL_RE = /\b[A-Z][A-Za-z]*(?:\.\d+)?(?:\/[A-Za-z0-9.\-]+)+/g;
const RESNUM_RE = /\b(?:resolutions?|decisions?|r\u00e9solutions?|d\u00e9cisions?|resoluci(?:\u00f3n|ones)|decisi(?:\u00f3n|ones))\s+((?:\d{1,3}\/\d{1,4}[A-Z]?)(?:(?:,\s*|\s+(?:and|et|y)\s+)\d{1,3}\/\d{1,4}[A-Z]?)*)/gi;
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'\u00ab\u00bb)\]]+/gi;
const MAIL_RE = /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g;

function _symbolSpans(text) {
  const out = [];
  let m;
  SYMBOL_RE.lastIndex = 0;
  while ((m = SYMBOL_RE.exec(text)) !== null) {
    let s = m[0].replace(/[.,;:]+$/, '');
    // "A/RES" alone or "and/or" are not document symbols: need a digit.
    if (!/\d/.test(s) || /^[A-Za-z]+\/[A-Za-z]+$/.test(s)) continue;
    out.push({ start: m.index, end: m.index + s.length, cat: 'SIMB', key: 'sym:' + s, art: '', src: 'sym' });
  }
  RESNUM_RE.lastIndex = 0;
  while ((m = RESNUM_RE.exec(text)) !== null) {
    const listStart = m.index + m[0].length - m[1].length;
    const re = /\d{1,3}\/\d{1,4}[A-Z]?/g;
    let k;
    while ((k = re.exec(m[1])) !== null) {
      out.push({ start: listStart + k.index, end: listStart + k.index + k[0].length, cat: 'SIMB', key: 'sym:' + k[0], art: '', src: 'sym' });
    }
  }
  return out;
}

function _urlSpans(text) {
  const out = [];
  let m;
  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(text)) !== null) {
    const s = m[0].replace(/[.,;:]+$/, '');
    out.push({ start: m.index, end: m.index + s.length, cat: 'URL', key: 'url:' + s.toLowerCase().replace(/^https?:\/\//, ''), art: '', src: 'url' });
  }
  MAIL_RE.lastIndex = 0;
  while ((m = MAIL_RE.exec(text)) !== null) {
    out.push({ start: m.index, end: m.index + m[0].length, cat: 'URL', key: 'url:' + m[0].toLowerCase(), art: '', src: 'url' });
  }
  return out;
}

// ------------------------------------------------------------------ persons

const HONORIFICS = {
  en: [['H.E. Mr.', 'el'], ['H.E. Ms.', 'la'], ['H.E. Mrs.', 'la'], ['Mr.', 'el'], ['Mrs.', 'la'], ['Ms.', 'la'], ['Miss', 'la'],
       ['Dr.', ''], ['Prof.', ''], ['Sir', 'el'], ['Dame', 'la'], ['Ambassador', ''], ['Judge', ''], ['Justice', '']],
  fr: [['S. E. M.', 'el'], ['S.E. M.', 'el'], ['S. E. Mme', 'la'], ['S.E. Mme', 'la'], ['M.', 'el'], ['Mme', 'la'], ['Mlle', 'la'],
       ['Dr', ''], ['Pr', ''], ['Me', '']],
  es: [['Excmo. Sr.', 'el'], ['Excma. Sra.', 'la'], ['Sr.', 'el'], ['Sra.', 'la'], ['Srta.', 'la'], ['Dr.', 'el'], ['Dra.', 'la']]
};

const NAME_PART = '[' + UPPER + "][" + L + "'\\-]+\\.?";
const NAME_RE_SRC = '(' + NAME_PART + '(?:\\s+(?:(?:de|del|da|van|von|der|di|al|el|bin|ben|la|le)\\s+)?' + NAME_PART + '){0,3})';

const TITLE_WORDS = new Set(['president', 'chair', 'chairman', 'chairperson', 'chairwoman', 'secretary-general', 'secretary',
  'minister', 'prime', 'ambassador', 'rapporteur', 'vice-president', 'vice-chair', 'speaker', 'director', 'director-general',
  'president', 'presidente', 'presidenta', 'secretario', 'secretaria', 'ministro', 'ministra', 'embajador', 'embajadora',
  'relator', 'relatora', 'vicepresidente', 'vicepresidenta', 'le', 'la', 'el', 'presidente', 'secretaire', 'ministre',
  'ambassadeur', 'ambassadrice', 'rapporteur', 'rapporteuse', 'directeur', 'directrice']);

let _honRe = null;
function _honorificRe(lang) {
  _honRe = _honRe || {};
  if (_honRe[lang]) return _honRe[lang];
  const list = (HONORIFICS[lang] || []).slice().sort((a, b) => b[0].length - a[0].length);
  const alt = list.map(h => h[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+')).join('|');
  _honRe[lang] = { re: new RegExp('(?<![' + L + '])(' + alt + ')\\s+' + NAME_RE_SRC, 'g'), list };
  return _honRe[lang];
}

function _personSpans(text, lang) {
  const out = [];
  const { re, list } = _honorificRe(lang);
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    let name = m[2].replace(/[.,;:]+$/, '');
    const words = name.split(/\s+/);
    // "Mr. President", "Madame la Pr\u00e9sidente", "Sr. Presidente": a title, not a name.
    if (TITLE_WORDS.has(_fold(words[0]))) continue;
    const surname = _fold(words[words.length - 1].replace(/\.$/, ''));
    if (!surname || surname.length < 2) continue;
    const start = m.index + m[0].length - m[2].length;
    const hon = list.find(h => h[0].replace(/\s+/g, ' ') === m[1].replace(/\s+/g, ' '));
    out.push({ start, end: start + name.length, cat: 'PER', key: 'per:' + surname, art: hon ? hon[1] : '', src: 'per' });
  }
  return out;
}

// ------------------------------------------------------------------ acronyms

const ACR_STOP = new Set(['AIDS', 'HIV', 'COVID', 'SIDA', 'VIH', 'PIB', 'GDP', 'CO2', 'ODS', 'SDG', 'SDGS', 'MDG', 'ODM', 'USD',
  'EUR', 'ISBN', 'ISSN', 'PDF', 'ICT', 'TIC', 'NGO', 'NGOS', 'ONG', 'OK', 'TV', 'ID', 'IT', 'AI', 'IA', 'NB', 'II', 'III',
  'IV', 'VI', 'VII', 'VIII', 'IX', 'XI', 'XII', 'XX', 'XXI', 'LGBTI', 'LGBTIQ', 'SMS', 'GPS', 'DNA', 'ADN', 'PCR', 'HTML',
  'URL', 'FAQ', 'CEO', 'UTC', 'GMT', 'COP', 'MOU']);

const ACR_RE = /(?<![\p{L}\p{N}\-])([A-Z]{2,8})(?![\p{L}\p{N}])/gu;

export function acronymsIn(text) {
  const out = [];
  const t = String(text || '');
  if (/[A-Z]/.test(t) && t === t.toUpperCase() && t.length > 12) return out; // all-caps heading
  ACR_RE.lastIndex = 0;
  let m;
  while ((m = ACR_RE.exec(t)) !== null) {
    if (ACR_STOP.has(m[1]) || /^[IVXLCDM]+$/.test(m[1])) continue;
    out.push({ start: m.index, end: m.index + m[1].length, text: m[1] });
  }
  return out;
}

// ------------------------------------------------------------------ main

// Lower number = wins an overlap.
const PRIORITY = { url: 0, sym: 1, term: 2, date: 3, gaz: 4, per: 5, num: 6, acr: 7 };

export function detectSpans(text, lang, ctx) {
  const c = ctx || {};
  const lg = (lang === 'fr' || lang === 'es') ? lang : 'en';
  const cats = c.cats || null;
  const on = (cat) => !cats || cats.has(cat);
  if (!text || !text.trim()) return [];
  let all = [];
  if (on('URL')) all = all.concat(_urlSpans(text));
  if (on('SIMB')) all = all.concat(_symbolSpans(text));
  if (c.terms) all = all.concat(_gazSpans(text, lg, c.terms).map(s => Object.assign(s, { src: 'term' })));
  if (on('FECHA')) all = all.concat(_dateSpans(text, lg));
  if (c.gaz) all = all.concat(_gazSpans(text, lg, c.gaz));
  if (on('PER')) all = all.concat(_personSpans(text, lg));
  if (on('NUM')) {
    all = all.concat(_numberSpans(text, lg));
    if (c.spelled !== false) all = all.concat(_spelledSpans(text, lg));
  }
  if (on('ORG') && c.acronyms !== false) {
    for (const a of acronymsIn(text)) {
      if (c.acronymsBoth && !c.acronymsBoth.has(a.text)) continue;
      all.push({ start: a.start, end: a.end, cat: 'ORG', key: 'acr:' + a.text, art: '', src: 'acr' });
    }
  }
  // Categories switched off (gazetteer and terms carry any category).
  all = all.filter(s => s.src === 'term' || on(s.cat));
  // Resolve overlaps: by priority, then longer first.
  all.sort((a, b) => (PRIORITY[a.src] - PRIORITY[b.src]) || ((b.end - b.start) - (a.end - a.start)) || (a.start - b.start));
  const chosen = [];
  for (const s of all) {
    if (s.end <= s.start) continue;
    if (chosen.some(x => s.start < x.end && s.end > x.start)) continue;
    chosen.push(s);
  }
  chosen.sort((a, b) => a.start - b.start);
  for (const s of chosen) s.surface = text.slice(s.start, s.end);
  return chosen;
}

/** The language code of a document side: source 'en'|'fr' (guessed), target always 'es'. */
export function guessLang(text) {
  const t = ' ' + _fold(String(text || '').slice(0, 20000)) + ' ';
  const count = (words) => words.reduce((n, w) => n + (t.split(' ' + w + ' ').length - 1), 0);
  const en = count(['the', 'and', 'of', 'to', 'that', 'is', 'for', 'with']);
  const fr = count(['le', 'la', 'les', 'et', 'des', 'du', 'que', 'pour', 'dans', 'est']);
  const es = count(['el', 'los', 'las', 'y', 'del', 'que', 'para', 'con', 'por', 'una']);
  if (es > en && es > fr) return 'es';
  return fr > en ? 'fr' : 'en';
}
