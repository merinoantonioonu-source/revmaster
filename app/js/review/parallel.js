/**
 * parallel.js - Grammatical PATTERN of the opening of a list item, a table cell or a heading, in
 * Spanish (target) and in English/French (source), so siblings that break the pattern can be flagged
 * without any AI.
 *
 * Patterns: INF (infinitive), GER (gerund), PART (participle/adjective), SUST (noun phrase),
 *           PREP (preposition), PRES (3rd person present, UN operative verbs), SUBJ (subjunctive plural),
 *           OTRO.
 */

import { listLabelOf } from './session.js';

function _fold(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }

const ES_PREP = new Set(['a', 'ante', 'bajo', 'con', 'contra', 'de', 'desde', 'durante', 'en', 'entre', 'hacia', 'hasta',
  'mediante', 'para', 'por', 'segun', 'sin', 'sobre', 'tras']);
const ES_ART = new Set(['el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'lo', 'su', 'sus', 'este', 'esta', 'estos', 'estas']);
// Common nouns that look like infinitives or participles.
const ES_NOT_INF = new Set(['lugar', 'mujer', 'hogar', 'poder', 'deber', 'taller', 'militar', 'par', 'mar', 'nivel', 'sector',
  'factor', 'valor', 'actor', 'autor', 'favor', 'exterior', 'interior', 'mayor', 'menor', 'mejor', 'peor', 'tutor', 'familiar',
  'regular', 'particular', 'similar', 'popular', 'nuclear', 'titular', 'escolar', 'vulnerar', 'alquiler', 'placer', 'ser']);
const ES_NOT_PART = new Set(['estado', 'estados', 'mercado', 'mercados', 'resultado', 'resultados', 'partido', 'partidos',
  'sentido', 'contenido', 'contenidos', 'periodo', 'periodos', 'aliado', 'aliados', 'mandato', 'mandatos', 'legado', 'grado',
  'cuidado', 'cuidados', 'apartado', 'apartados', 'enfoque', 'tratado', 'tratados', 'dictado', 'abogado', 'abogados', 'comunicado',
  'senado', 'consulado', 'delegado', 'delegados', 'empleado', 'empleados', 'diputado', 'diputados', 'agrado', 'pasado', 'ejercito',
  'medida', 'medidas', 'vida', 'partida', 'salida', 'llegada', 'comida', 'bebida', 'seguridad', 'unidad', 'unidades', 'ciudad']);
// Operative verbs (3rd person present) frequent in UN resolutions, plus anything in conventions.json.
let ES_PRES = new Set(['decide', 'pide', 'solicita', 'exhorta', 'insta', 'alienta', 'invita', 'reafirma', 'reconoce', 'acoge',
  'toma', 'observa', 'destaca', 'subraya', 'recomienda', 'condena', 'deplora', 'expresa', 'hace', 'aprueba', 'afirma', 'encomia',
  'pone', 'reitera', 'exige', 'autoriza', 'proclama', 'declara', 'celebra', 'acepta', 'conviene', 'considera', 'recuerda', 'estima']);

export function setOperativeVerbs(list) {
  for (const v of list || []) ES_PRES.add(_fold(String(v).split(/\s+/)[0]));
}

const EN_PREP = new Set(['in', 'on', 'for', 'with', 'by', 'to', 'from', 'at', 'of', 'through', 'within', 'under', 'towards', 'among', 'between', 'without', 'during', 'about']);
const EN_ART = new Set(['the', 'a', 'an', 'its', 'their', 'this', 'these', 'those', 'our', 'his', 'her']);
const FR_PREP = new Set(['a', 'de', 'en', 'pour', 'par', 'avec', 'sur', 'dans', 'sans', 'sous', 'entre', 'vers', 'chez', 'contre', 'selon', 'pendant']);
const FR_ART = new Set(['le', 'la', 'les', 'un', 'une', 'des', 'du', 'l', 'sa', 'son', 'ses', 'leur', 'leurs', 'ce', 'cette', 'ces']);

function _firstWords(text) {
  const t = String(text || '').replace(listLabelOf(text), '').replace(/^[\s\t"'\u00ab\u201c(\[{]+/, '');
  // A masked tag at the start is a noun phrase.
  if (/^\{/.test(t)) return ['__tag__'];
  return (t.match(/[\p{L}'\u2019-]+/gu) || []).slice(0, 3);
}

export function patternEs(text) {
  const ws = _firstWords(text);
  if (!ws.length) return 'OTRO';
  if (ws[0] === '__tag__') return 'SUST';
  const w = _fold(ws[0]);
  if (ES_ART.has(w)) return 'SUST';
  if (ES_PREP.has(w)) return 'PREP';
  if (ES_PRES.has(w)) return 'PRES';
  if (/(ando|iendo|yendo)(se|lo|la|los|las|le|les|nos)?$/.test(w)) return 'GER';
  if (/(ar|er|ir)(se|lo|la|los|las|le|les|nos)?$/.test(w) && !ES_NOT_INF.has(w) && w.length > 3) return 'INF';
  if (/(ado|ada|ados|adas|ido|ida|idos|idas)$/.test(w) && !ES_NOT_PART.has(w)) return 'PART';
  if (/(cion|sion|miento|mientos|dad|dades|tad|encia|ancia|ismo|aje|ura|eza|ia|ciones|siones|cias)$/.test(w)) return 'SUST';
  // "Desarrollo de...", "Apoyo a...": a word that is not a verb form followed by "de/del" is a noun.
  if (ws[1] && /^(de|del)$/.test(_fold(ws[1]))) return 'SUST';
  if (/(en|an)$/.test(w) && w.length > 4 && /^[a-z]/.test(w)) return 'SUBJ';
  return 'OTRO';
}

export function patternEn(text) {
  const ws = _firstWords(text);
  if (!ws.length) return 'OTRO';
  if (ws[0] === '__tag__') return 'SUST';
  const w = ws[0].toLowerCase();
  if (w === 'to' && ws[1]) return 'INF';
  if (EN_ART.has(w)) return 'SUST';
  if (EN_PREP.has(w)) return 'PREP';
  if (/ing$/.test(w) && w.length > 4) return 'GER';
  if (/(tion|sion|ment|ness|ity|ance|ence|ship|ism)s?$/.test(w)) return 'SUST';
  if (ws[1] && ws[1].toLowerCase() === 'of') return 'SUST';
  if (/ed$/.test(w) && w.length > 4) return 'PART';
  if (/s$/.test(w) && !/ss$/.test(w) && w.length > 3 && ws.length > 1) return 'PRES';
  return 'OTRO';
}

export function patternFr(text) {
  const ws = _firstWords(text);
  if (!ws.length) return 'OTRO';
  if (ws[0] === '__tag__') return 'SUST';
  const w = _fold(ws[0]).replace(/^(l|d)['\u2019]/, '');
  if (FR_ART.has(w)) return 'SUST';
  if (FR_PREP.has(w)) return 'PREP';
  if (/ant$/.test(w) && w.length > 4) return 'GER';
  if (/(er|ir|re)$/.test(w) && w.length > 3) return 'INF';
  if (/(tion|sion|ment|ite|ance|ence|isme|age)s?$/.test(w)) return 'SUST';
  if (ws[1] && /^(de|du|des)$/.test(_fold(ws[1]))) return 'SUST';
  if (/(e|ee|es|ees|i|ie|is|ies)$/.test(w) && w.length > 4) return 'PART';
  return 'OTRO';
}

export function patternOf(text, lang) {
  if (lang === 'es') return patternEs(text);
  if (lang === 'fr') return patternFr(text);
  return patternEn(text);
}

export const PATTERN_LABELS = {
  INF: 'infinitivo', GER: 'gerundio', PART: 'participio o adjetivo', SUST: 'sustantivo', PREP: 'preposici\u00f3n',
  PRES: 'verbo en presente', SUBJ: 'subjuntivo', OTRO: 'otro'
};

/**
 * Outliers of a group of sibling texts: [{ i, pattern, majority }] when one pattern holds at least
 * 60 % of the classified items and some items differ ('OTRO' items are never flagged).
 */
export function outliers(patterns) {
  const counts = {};
  for (const p of patterns) if (p !== 'OTRO') counts[p] = (counts[p] || 0) + 1;
  const total = patterns.filter(p => p !== 'OTRO').length;
  const best = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
  if (!best || total < 3 || counts[best] / total < 0.6 || counts[best] === total) return [];
  const out = [];
  patterns.forEach((p, i) => { if (p !== 'OTRO' && p !== best) out.push({ i, pattern: p, majority: best }); });
  return out;
}
