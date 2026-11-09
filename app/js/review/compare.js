/**
 * compare.js - "Comparar con la versi\u00f3n final" (Corregir > Mas): the AI's review set against what the
 * reviser really changed. The final, reviewed translation (the same document, as delivered) is read
 * here, its paragraphs paired with the project's translation, and each stretch the reviser changed is
 * found (word by word, as the corrected copy is written). Then:
 *   - a finding where the reviser changed something: PROBABLY RIGHT ("acertado");
 *   - a finding where nothing was changed: PROBABLY SPURIOUS ("espurio");
 *   - a finding with no place (an omission) in a paragraph the reviser changed: POSSIBLE ("posible");
 *   - a change of the reviser no finding covers: PROBABLY MISSED ("omitido"), unless it is only form
 *     (spaces, punctuation, quotes, capitals) or only figures, which are not this app's task (Word, the
 *     QA Checker) and are counted apart;
 *   - a finding the Verifier threw away where the reviser did change something: worth a look.
 * Probable, not certain: a reviser also changes by preference. Nothing goes to any AI; it is all done
 * in this browser. The result can be copied as a summary, saved as an Excel, and turned into a bench
 * of one's own (banco.json + the two documents) to measure UMBRA on real work.
 */

import { textDiffReplacements } from '../formats/doc-writer.js';

const _norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const _fold = (s) => _norm(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
// What is left of a stretch once form is taken away: letters and digits only.
const _core = (s) => _fold(s).replace(/[^\p{L}\p{N}]+/gu, '');
const _letters = (s) => _fold(s).replace(/[^\p{L}]+/gu, '');

/**
 * Pairs the paragraphs of two versions of the same translation: -> array, for each paragraph of `a`,
 * the index of its paragraph in `b` (or -1). Identical texts anchor (longest common sequence); between
 * two anchors, the paragraphs left are paired in order.
 */
export function pairVersions(aTexts, bTexts) {
  const n = aTexts.length, m = bTexts.length;
  const out = new Array(n).fill(-1);
  if (n === m) { for (let i = 0; i < n; i++) out[i] = i; return out; }
  const A = aTexts.map(_norm), B = bTexts.map(_norm);
  const anchors = [];
  if (n * m <= 25e6) {
    const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] && A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (A[i] && A[i] === B[j]) { anchors.push([i, j]); i++; j++; }
      else if (L[i + 1][j] >= L[i][j + 1]) i++;
      else j++;
    }
  }
  anchors.push([n, m]);
  let pi = 0, pj = 0;
  for (const [ai, aj] of anchors) {
    for (let k = 0; pi + k < ai && pj + k < aj; k++) out[pi + k] = pj + k;
    if (ai < n) out[ai] = aj;
    pi = ai + 1; pj = aj + 1;
  }
  return out;
}

/**
 * The reviser's changes in a paragraph, as stretches of it: word by word, and two stretches with one or
 * two words between them as one (a name rewritten is one correction, not a deletion and an insertion).
 */
export function changedStretches(before, after) {
  const raw = textDiffReplacements(before, after);
  const out = [];
  for (const r of raw) {
    const prev = out[out.length - 1];
    const gap = prev ? before.slice(prev.end, r.start) : '';
    if (prev && gap.length <= 20 && (gap.match(/\S+/g) || []).length <= 2) {
      prev.text = prev.text + gap + r.text;
      prev.end = r.end;
    } else out.push({ start: r.start, end: r.end, text: r.text });
  }
  return out;
}

/** The kind of a change: 'texto' (words), 'cifras' (only figures), 'forma' (spaces, punctuation, case). */
export function changeKind(oldText, newText) {
  if (_core(oldText) === _core(newText)) return 'forma';
  if (_letters(oldText) === _letters(newText)) return 'cifras';
  return 'texto';
}

/**
 * compareWithFinal(session, findings, finalModel) -> {
 *   units: [{ unit, before, after, regions:[{ start, end, old, text, kind }] }],
 *   items: [{ f, verdict: 'acertado'|'espurio'|'posible'|'sinfinal', same (the suggestion is what the
 *            reviser wrote), lost (discarded by the Verifier) }],
 *   misses: [{ unit, old, text, kind, after }],
 *   stats }
 */
export function compareWithFinal(session, findings, finalModel) {
  const tgtParas = session.tgt.paras, finParas = finalModel.paras;
  const pairOf = pairVersions(tgtParas.map(p => p.text), finParas.map(p => p.text));
  const units = new Map();
  for (const u of session.units) {
    if (u.tgtPara === null || u.tgtPara === undefined) continue;
    const j = pairOf[u.tgtPara];
    if (j < 0) { units.set(u.idx, { unit: u.idx, before: tgtParas[u.tgtPara].text, after: null, regions: [] }); continue; }
    const before = tgtParas[u.tgtPara].text, after = finParas[j].text;
    const regions = changedStretches(before, after).map(r => {
      const old = before.slice(r.start, r.end);
      return { start: r.start, end: r.end, old, text: r.text, kind: changeKind(old, r.text) };
    });
    units.set(u.idx, { unit: u.idx, before, after, regions });
  }
  const touches = (r, f) => {
    const a = f.start - 2, b = (f.end != null ? f.end : f.start) + 2;
    return r.end >= r.start ? (r.start <= b && r.end >= a) : false;
  };
  const items = [];
  const covered = new Set();
  const reviewed = findings.filter(f => f && f.unit !== undefined && (f.source === 'ai' || f.source === 'external'));
  for (const f of reviewed) {
    const U = units.get(f.unit);
    let verdict, hit = [];
    if (!U || U.after === null) verdict = 'sinfinal';
    else if (f.start !== null && f.start !== undefined) {
      hit = U.regions.filter(r => touches(r, f));
      verdict = hit.length ? 'acertado' : 'espurio';
    } else {
      hit = U.regions.filter(r => r.kind === 'texto');
      verdict = hit.length ? 'posible' : 'espurio';
    }
    const sug = _fold(f.edited != null ? f.edited : f.suggestion);
    const same = !!(sug && U && U.after && _fold(U.after).includes(sug) && !_fold(U.before).includes(sug));
    const lost = f.state === 'discarded';
    if (!lost) for (const r of hit) covered.add(U.unit + ':' + r.start + ':' + r.end);
    items.push({ f, verdict, same, lost });
  }
  const misses = [];
  const counts = { texto: 0, cifras: 0, forma: 0 };
  for (const U of units.values()) {
    for (const r of U.regions) {
      counts[r.kind]++;
      if (r.kind !== 'texto' || covered.has(U.unit + ':' + r.start + ':' + r.end)) continue;
      misses.push({ unit: U.unit, old: r.old, text: r.text, kind: r.kind, after: U.after });
    }
  }
  const live = items.filter(x => !x.lost);
  const stats = {
    findings: live.length,
    acertado: live.filter(x => x.verdict === 'acertado').length,
    posible: live.filter(x => x.verdict === 'posible').length,
    espurio: live.filter(x => x.verdict === 'espurio').length,
    same: live.filter(x => x.same).length,
    lostButChanged: items.filter(x => x.lost && (x.verdict === 'acertado' || x.verdict === 'posible')).length,
    discarded: items.filter(x => x.lost).length,
    misses: misses.length,
    changes: counts,
    unitsChanged: [...units.values()].filter(U => U.regions.length).length,
    unitsUnpaired: [...units.values()].filter(U => U.after === null).length,
    units: units.size
  };
  const byModule = {};
  for (const x of live) {
    const b = byModule[x.f.module] || (byModule[x.f.module] = { findings: 0, acertado: 0, posible: 0, espurio: 0 });
    b.findings++; b[x.verdict] = (b[x.verdict] || 0) + 1;
  }
  stats.byModule = byModule;
  return { units: [...units.values()], items, misses, stats };
}

const _clip = (s, n) => { const t = _norm(s); return t.length > n ? t.slice(0, n - 1) + '\u2026' : t; };

/** A plain-text summary to paste in the chat (the owner's way of asking for adjustments). */
export function compareSummary(res, info) {
  const s = res.stats, o = info || {};
  const n = (u) => (o.unitN ? o.unitN(u) : u + 1);
  const L = [];
  L.push('UMBRA \u00b7 Comparaci\u00f3n con la versi\u00f3n final' + (o.project ? ' \u00b7 ' + o.project : '') + (o.finalName ? ' (' + o.finalName + ')' : ''));
  if (o.models) L.push('Modelos: ' + o.models);
  L.push('Hallazgos: ' + s.findings + ' \u00b7 acertados probables ' + s.acertado + ' \u00b7 posibles ' + s.posible + ' \u00b7 espurios probables ' + s.espurio +
    ' \u00b7 con la misma correcci\u00f3n que el revisor ' + s.same);
  for (const [m, b] of Object.entries(s.byModule)) L.push('  ' + (o.moduleLabel ? o.moduleLabel(m) : m) + ': ' + b.findings + ' (acertados ' + (b.acertado || 0) + ', posibles ' + (b.posible || 0) + ', espurios ' + (b.espurio || 0) + ')');
  L.push('Descartados por el Verificador: ' + s.discarded + ' (en ' + s.lostButChanged + ' el revisor s\u00ed cambi\u00f3 algo)');
  L.push('Cambios del revisor: ' + s.changes.texto + ' de texto, ' + s.changes.cifras + ' solo de cifras, ' + s.changes.forma + ' solo de forma \u00b7 omitidos probables por UMBRA: ' + s.misses);
  L.push('P\u00e1rrafos: ' + s.units + ' \u00b7 cambiados por el revisor ' + s.unitsChanged + (s.unitsUnpaired ? ' \u00b7 sin pareja en la versi\u00f3n final ' + s.unitsUnpaired : ''));
  const sp = res.items.filter(x => !x.lost && x.verdict === 'espurio');
  if (sp.length) {
    L.push('', 'ESPURIOS PROBABLES (el revisor no cambi\u00f3 nada ah\u00ed):');
    for (const x of sp.slice(0, 40)) L.push('\u00a7' + n(x.f.unit) + ' \u00b7 ' + (o.moduleLabel ? o.moduleLabel(x.f.module) : x.f.module) + ' \u00b7 ' + x.f.sev + ' \u00b7 \u00ab' + _clip(x.f.quote, 80) + '\u00bb \u2192 \u00ab' + _clip(x.f.suggestion, 80) + '\u00bb \u00b7 ' + _clip(x.f.reason, 120));
  }
  if (res.misses.length) {
    L.push('', 'OMITIDOS PROBABLES (cambios del revisor que UMBRA no se\u00f1al\u00f3):');
    for (const x of res.misses.slice(0, 60)) L.push('\u00a7' + n(x.unit) + ' \u00b7 \u00ab' + _clip(x.old, 90) + '\u00bb \u2192 \u00ab' + _clip(x.text, 90) + '\u00bb');
  }
  const lost = res.items.filter(x => x.lost && x.verdict !== 'espurio' && x.verdict !== 'sinfinal');
  if (lost.length) {
    L.push('', 'DESCARTADOS POR EL VERIFICADOR DONDE EL REVISOR S\u00cd CAMBI\u00d3:');
    for (const x of lost.slice(0, 30)) L.push('\u00a7' + n(x.f.unit) + ' \u00b7 \u00ab' + _clip(x.f.quote, 80) + '\u00bb \u2192 \u00ab' + _clip(x.f.suggestion, 80) + '\u00bb');
  }
  return L.join('\n');
}

/**
 * A bench of one's own from the comparison (Archivos > Banco de pruebas > Cargar un banco propio):
 * the paragraphs the reviser left as they were (clean) and those where they changed words (the
 * changes, expected); paragraphs changed only in form or figures are left out. -> { spec, paras }.
 */
export function compareBench(session, res, name, docType) {
  const key = (s) => { const t = _norm(s); return t.length > 60 ? t.slice(0, 60) : t; };
  const moduleOf = new Map();
  for (const x of res.items) if (!x.lost && x.verdict === 'acertado') moduleOf.set(x.f.unit, x.f.module);
  const paragraphs = [];
  for (const U of res.units) {
    if (U.after === null) continue;
    const u = session.units[U.unit];
    const en = u.srcPara !== null && u.srcPara !== undefined ? session.src.paras[u.srcPara].text : '';
    if (!_norm(U.before) || !_norm(en)) continue;
    const words = U.regions.filter(r => r.kind === 'texto');
    if (U.regions.length && !words.length) continue;
    const expect = words.map(r => ({ module: moduleOf.get(U.unit) || 'meaning', keys: [key(r.old), key(r.text)].filter(Boolean),
      what: 'Correcci\u00f3n final: \u00ab' + _clip(r.old, 80) + '\u00bb \u2192 \u00ab' + _clip(r.text, 80) + '\u00bb' }));
    paragraphs.push({ n: paragraphs.length + 1, en, es: U.before, expect });
  }
  const errs = paragraphs.reduce((k, p) => k + p.expect.length, 0);
  const spec = { kind: 'umbra-bench', version: 1, name: name || 'Banco de un trabajo real', docType: docType || '',
    source: paragraphs.length + ' p\u00e1rrafos de un trabajo real: ' + paragraphs.filter(p => p.expect.length).length + ' con ' + errs +
      ' cambios del revisor final (esperados) y ' + paragraphs.filter(p => !p.expect.length).length + ' que el revisor dej\u00f3 como estaban (todo lo que se se\u00f1ale en ellos es ruido).',
    paragraphs };
  return spec;
}

function _xmlEsc(s) { return String(s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c])); }

/** A minimal DOCX with one paragraph per text (enough for UMBRA's reader). -> Blob */
export async function simpleDocx(texts) {
  const JSZip = globalThis.JSZip;
  const z = new JSZip();
  z.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  z.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  z.file('word/document.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    texts.map(t => '<w:p><w:r><w:t xml:space="preserve">' + _xmlEsc(t) + '</w:t></w:r></w:p>').join('') + '</w:body></w:document>');
  return z.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
}

/** The bench as a .zip: banco.json, banco_<en|fr>.docx and banco_es.docx. -> Blob */
export async function compareBenchZip(spec, srcLang) {
  const JSZip = globalThis.JSZip;
  const z = new JSZip();
  z.file('banco.json', JSON.stringify(spec, null, 1));
  z.file('banco_' + (srcLang === 'fr' ? 'fr' : 'en') + '.docx', await simpleDocx(spec.paragraphs.map(p => p.en)));
  z.file('banco_es.docx', await simpleDocx(spec.paragraphs.map(p => p.es)));
  return z.generateAsync({ type: 'blob', mimeType: 'application/zip' });
}
