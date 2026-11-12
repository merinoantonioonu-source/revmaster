/**
 * hints.js - LOCAL hints for the Redaccion pass: where a paragraph of the Spanish probably repeats a word
 * close by, or piles up nouns in -cion/-sion. NOT a check (the owner's rule: AI-free checks only add noise):
 * it only says WHERE to look, and the AI decides whether it really reads badly. Optional (Revisar >
 * Redaccion > "Pistas"), off by default until the test bench shows it helps.
 *
 * Two rules, measured on 17,561 sentences of UN documents (the translator's final Spanish against DeepL's
 * and the English; sentences of 10 to 60 words):
 *   - REPETITION: a word of 7 letters or more (same word, or same first 6 letters for words of 8 or more)
 *     twice within 6 words, and the ENGLISH sentence does not repeat a word within 10 (the English repeating
 *     it is the reason for the Spanish to: "human rights ... human rights"). Flagged in 3.8 % of DeepL's
 *     sentences and 2.8 % of the translator's final ones: the translator removes about half of them.
 *   - -CION: three or more words in -cion/-sion in one sentence AND at least two more than the English
 *     has in -tion/-sion. 15.5 % of DeepL's sentences, 10.1 % of the translator's: half are removed.
 * So a hint is a suspicion, right about half the time at best. A repetition of the SAME LEMMA in other
 * forms ("sigan trabajando para seguir ampliando") is not seen: that one is left to the AI.
 *
 * Pure: text in, strings out. Tags ({ORG3}, {NUM7}) are dropped before looking.
 */

const STOP = new Set(('durante mediante tambi\u00e9n mientras aunque algunos algunas ning\u00fan ninguna cualquier cuando siempre despu\u00e9s ' +
  'adem\u00e1s dentro entonces seg\u00fan hacia sobre tras ante bajo contra entre hasta desde cuales quienes mismos mismas ' +
  'ellos ellas nosotros estos estas aquellos aquellas todos todas otros otras').split(' '));
const WORD = /\p{L}+/gu;
const CION = /(?:ci\u00f3n|ciones|si\u00f3n|siones)$/u;
const EN_TION = /(?:tion|tions|sion|sions)$/;
const EN_SKIP = new Set(['which', 'their', 'there', 'these', 'those', 'where', 'while', 'other', 'about', 'would', 'could', 'should']);

const strip = (s) => String(s || '').replace(/\{[^}]*\}/g, ' ');
const wordsOf = (s) => (strip(s).match(WORD) || []).map(w => w.toLowerCase());

/** The sentences of a paragraph (the full stop plus a capital, a figure or an opening mark starts another). */
export function sentencesOf(text) {
  return strip(text).split(/(?<=[.?!\u2026])\s+(?=[\p{Lu}\u00bf\u00a1\u00ab"\u201c(\d])/u).map(s => s.trim()).filter(Boolean);
}

/** Pairs of the same content word (7+ letters) within `win` words: [{ word, gap }]. */
function closeRepeats(tk, win) {
  const out = [], pos = new Map();
  tk.forEach((t, i) => {
    if (t.length < 7 || STOP.has(t)) return;
    const key = t.length < 8 ? t : t.slice(0, 6);
    for (const j of pos.get(key) || []) if (i - j <= win) out.push({ word: tk[j], gap: i - j });
    if (!pos.has(key)) pos.set(key, []);
    pos.get(key).push(i);
  });
  return out;
}

/** Does the English repeat a content word (5+ letters) within 10 words? */
function englishRepeats(en) {
  const tk = (String(en || '').match(/[A-Za-z]+/g) || []).map(w => w.toLowerCase());
  const pos = new Map();
  for (let i = 0; i < tk.length; i++) {
    const t = tk[i];
    if (t.length < 5 || EN_SKIP.has(t)) continue;
    for (const j of pos.get(t) || []) if (i - j <= 10) return true;
    if (!pos.has(t)) pos.set(t, []);
    pos.get(t).push(i);
  }
  return false;
}
const tionCount = (en) => (String(en || '').match(/[A-Za-z]+/g) || []).filter(w => w.length >= 7 && EN_TION.test(w.toLowerCase())).length;

/**
 * The hints for one paragraph.
 * @param {string} source  the original paragraph ('' when there is none: then the English is not consulted and nothing is flagged by comparison)
 * @param {string} target  the Spanish paragraph
 * @returns {string[]}  at most two short phrases, in Spanish ("repite \u00abaprobaci\u00f3n\u00bb a 4 palabras")
 */
export function paragraphHints(source, target) {
  const es = sentencesOf(target);
  if (!es.length) return [];
  const en = sentencesOf(source);
  const paired = en.length === es.length;
  const out = [];
  let seenRep = false, seenCion = false;
  es.forEach((s, k) => {
    const tk = wordsOf(s);
    if (tk.length < 10 || tk.length > 80) return;
    const enS = paired ? en[k] : source;
    if (!seenRep && source) {
      const reps = closeRepeats(tk, 6);
      if (reps.length && !englishRepeats(enS)) {
        seenRep = true;
        out.push('repite \u00ab' + reps[0].word + '\u00bb a ' + reps[0].gap + ' palabras');
      }
    }
    if (!seenCion && source) {
      const cion = tk.filter(t => t.length >= 7 && CION.test(t));
      const enN = paired ? tionCount(en[k]) : Math.round(tionCount(source) * Math.min(1, tk.length / Math.max(1, wordsOf(target).length)));
      if (cion.length >= 3 && cion.length - enN >= 2) {
        seenCion = true;
        out.push(cion.length + ' nombres en -ci\u00f3n en una frase (' + cion.slice(0, 3).join(', ') + ')');
      }
    }
  });
  return out.slice(0, 2);
}
