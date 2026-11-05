/**
 * semantic.js - Semantic similarity between the sentences of each original paragraph and those of
 * its translation (layer 0). A sentence of the original with no close counterpart in the translation
 * is a likely OMISSION; a sentence of the translation with none in the original, a likely ADDITION.
 *
 * Engines (module_cfg.local.semantic):
 *   'local' - multilingual sentence embeddings computed in the browser (ai/embeddings.js), on the
 *             REAL text (nothing leaves the computer);
 *   'api'   - a provider's embeddings endpoint, on the MASKED text (ai/gateway.js embedTexts).
 *
 * Thresholds adapt to the document: scores are compared with the document's own median (a good
 * translation scores high everywhere; the outliers are what matter), whatever the model's scale.
 */

import { SrxSegmenter } from '../core/srx-segmenter.js';
import { reviewableUnits, unitSrc, unitTgt, unitSrcMasked, unitTgtMasked } from './session.js';
import { embedLocal, cosine, DEFAULT_LOCAL_MODEL, DEFAULT_API_MODELS } from '../ai/embeddings.js';
import { embedTexts } from '../ai/gateway.js';
import { getProvider } from '../ai/registry.js';
import { locate } from './findings.js';
import { maskedToOriginal } from '../redact/entities.js';

let _seq = 0;
const WORDS = (s) => (String(s || '').match(/[\p{L}\p{N}]+/gu) || []).length;

function _median(a) {
  if (!a.length) return 0;
  const s = a.slice().sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function _fmt(x) { return (Math.round(x * 100) / 100).toFixed(2).replace('.', ','); }

/**
 * cfg = { semantic:'local'|'api', semModel, semProvider, semApiModel, semSensitivity:'normal'|'high' }
 * hooks = { onStatus(text), signal, project:{ name, file } }
 * -> { findings, stats:{ sentences, median, threshold, engine } }
 */
export async function semanticFindings(session, cfg, hooks) {
  const h = hooks || {};
  const engine = cfg.semantic === 'api' ? 'api' : 'local';
  const segSrc = new SrxSegmenter(session.srcLang === 'fr' ? 'FR' : 'EN');
  const segTgt = new SrxSegmenter('ES');
  // Sentences per unit (masked text for the API, real text for the local model).
  const rows = [];
  const texts = [];
  const indexOf = new Map();
  const add = (t) => { if (!indexOf.has(t)) { indexOf.set(t, texts.length); texts.push(t); } return indexOf.get(t); };
  const units = reviewableUnits(session).filter(u => u.srcPara !== null && u.tgtPara !== null);
  for (const u of units) {
    const s = engine === 'api' ? unitSrcMasked(session, u) : unitSrc(session, u);
    const t = engine === 'api' ? unitTgtMasked(session, u) : unitTgt(session, u);
    if (WORDS(s) < 3 || WORDS(t) < 3) continue;
    const ss = segSrc.segment(s).filter(x => WORDS(x) >= 1);
    const ts = segTgt.segment(t).filter(x => WORDS(x) >= 1);
    if (!ss.length || !ts.length) continue;
    rows.push({ u, ss: ss.map(x => ({ text: x, i: add(x) })), ts: ts.map(x => ({ text: x, i: add(x) })) });
  }
  if (!rows.length) return { findings: [], stats: { sentences: 0, engine } };

  // Vectors.
  let vectors;
  if (engine === 'api') {
    const profile = await getProvider(cfg.semProvider || '');
    if (!profile) throw Object.assign(new Error('Elija en Ajustes > M\u00f3dulos el proveedor de la similitud sem\u00e1ntica.'), { code: 'NO_PROVIDER' });
    if (h.onStatus) h.onStatus('Similitud sem\u00e1ntica: ' + texts.length + ' oraciones');
    const r = await embedTexts({ provider: profile.id, model: cfg.semApiModel || DEFAULT_API_MODELS[profile.adapter], texts, masked: true,
      module: 'semantic', project: h.project && h.project.name, file: h.project && h.project.file, signal: h.signal,
      onProgress: (d, n) => h.onStatus && h.onStatus('Similitud sem\u00e1ntica: ' + d + '/' + n) });
    vectors = r.vectors;
  } else {
    vectors = await embedLocal(texts, { model: cfg.semModel || DEFAULT_LOCAL_MODEL, signal: h.signal,
      onStatus: (s) => h.onStatus && h.onStatus(s),
      onProgress: (d, n) => h.onStatus && h.onStatus('Similitud sem\u00e1ntica: ' + d + '/' + n + ' oraciones') });
  }

  // Best match of every sentence among the sentences of the other side (same unit + neighbours,
  // so a sentence that moved to the next paragraph is not reported as missing).
  const scored = [];
  rows.forEach((row, k) => {
    const near = (side) => [rows[k - 1], row, rows[k + 1]].filter(Boolean).flatMap(r => r[side]);
    const tNear = near('ts'), sNear = near('ss');
    for (const s of row.ss) {
      let best = -1;
      for (const t of tNear) best = Math.max(best, cosine(vectors[s.i], vectors[t.i]));
      scored.push({ row, side: 'src', sent: s, best, words: WORDS(s.text) });
    }
    for (const t of row.ts) {
      let best = -1;
      for (const s of sNear) best = Math.max(best, cosine(vectors[t.i], vectors[s.i]));
      scored.push({ row, side: 'tgt', sent: t, best, words: WORDS(t.text) });
    }
  });
  const usable = scored.filter(x => x.words >= 4);
  const med = _median(usable.map(x => x.best));
  const mad = _median(usable.map(x => Math.abs(x.best - med))) || 0.03;
  const k = cfg.semSensitivity === 'high' ? 2.5 : 3.5;
  const threshold = usable.length >= 8 ? Math.min(med - k * Math.max(mad, 0.03), med * 0.75) : med * 0.6;

  const findings = [];
  const seenUnit = new Set();
  for (const x of usable) {
    if (x.best >= threshold) continue;
    const u = x.row.u;
    const base = { id: 'M' + Date.now().toString(36) + (_seq++).toString(36), module: 'local', sub: 'semantic', source: 'local', state: 'open',
      side: 'tgt', unit: u.idx, start: null, end: null, quote: '', suggestion: '' };
    const how = ' (similitud ' + _fmt(x.best) + '; lo normal en este documento es ' + _fmt(med) + ').';
    const single = x.row.ss.length === 1 && x.row.ts.length === 1;
    if (single) {
      if (seenUnit.has(u.idx)) continue;
      seenUnit.add(u.idx);
      findings.push(Object.assign(base, { cat: 'MIST', sev: 'MAY', reason: 'El sentido del p\u00e1rrafo no parece coincidir con el original' + how }));
      continue;
    }
    if (x.side === 'src') {
      const shown = x.sent.text.length > 160 ? x.sent.text.slice(0, 157) + '\u2026' : x.sent.text;
      // Where the sentence is in the original, so the sheets can mark it (ui/nav.js).
      let srcStart = null, srcEnd = null;
      if (engine === 'api') {
        const m = session.masked.src.get(u.srcPara);
        const hit = m ? locate(m.masked, x.sent.text) : -1;
        if (hit !== -1) { srcStart = maskedToOriginal(m.map, hit.start, 'start'); srcEnd = maskedToOriginal(m.map, hit.end, 'end'); }
      } else {
        const hit = locate(session.src.paras[u.srcPara].text, x.sent.text);
        if (hit !== -1) { srcStart = hit.start; srcEnd = hit.end; }
      }
      findings.push(Object.assign(base, { cat: 'OMI', sev: 'MAY', srcStart, srcEnd, reason: 'Posible omisi\u00f3n: la traducci\u00f3n no parece recoger \u00ab' + shown + '\u00bb' + how }));
    } else {
      // Anchor the sentence in the real text of the paragraph.
      const para = session.tgt.paras[u.tgtPara];
      let start = null, end = null;
      if (engine === 'api') {
        const m = session.masked.tgt.get(u.tgtPara);
        const hit = locate(m.masked, x.sent.text);
        if (hit !== -1) { start = maskedToOriginal(m.map, hit.start, 'start'); end = maskedToOriginal(m.map, hit.end, 'end'); }
      } else {
        const hit = locate(para.text, x.sent.text);
        if (hit !== -1) { start = hit.start; end = hit.end; }
      }
      findings.push(Object.assign(base, { cat: 'ADD', sev: 'MEN', start, end, quote: start !== null ? para.text.slice(start, end) : '',
        reason: 'Posible adici\u00f3n: esta oraci\u00f3n no parece tener equivalente en el original' + how }));
    }
  }
  return { findings, stats: { sentences: texts.length, median: med, threshold, engine } };
}
